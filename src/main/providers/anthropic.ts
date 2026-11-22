import Anthropic from '@anthropic-ai/sdk';
import type { ModelInfo } from '@shared/types';
import { getApiKey } from '../settings';
import { log } from '../events';
import { ProviderError, type ChatRequest, type ChatResponse, type ConvMessage, type ConvPart, type ToolCall } from './types';

let client: Anthropic | null = null;
let clientKey = '';

function getClient(): Anthropic {
  const key = getApiKey('anthropic');
  if (!key) throw new ProviderError('Brak klucza API Anthropic — dodaj go w Ustawieniach / Missing Anthropic API key', 401, false, 'auth');
  if (!client || clientKey !== key) {
    const testBase = process.env.LUNARIX_TEST ? process.env.LUNARIX_ANTHROPIC_BASE_URL : undefined;
    client = new Anthropic({ apiKey: key, maxRetries: 3, timeout: 15 * 60_000, ...(testBase ? { baseURL: testBase } : {}) });
    clientKey = key;
  }
  return client;
}

export function anthropicCaps(id: string, info?: ModelInfo) {
  const fam = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(id);
  const major = fam ? Number(fam[2]) : 0;
  const minor = fam && fam[3] ? Number(fam[3]) : 0;
  const ver = major + minor / 10;
  const kind = fam?.[1] || '';
  const heuristicAdaptive = ver >= 4.6 && !(kind === 'haiku' && ver < 5);
  const heuristicEffort = heuristicAdaptive || (kind === 'opus' && ver >= 4.5);
  return {
    adaptive: info?.adaptiveThinking ?? heuristicAdaptive,
    effort: info?.effort ?? heuristicEffort,
    fallback: /^claude-(opus-5|sonnet-5-5|fable-5)/.test(id)
  };
}

const sanitizeId = (id: string) => (id || 'tool').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

function partToAnthropic(p: ConvPart, vision: boolean): any {
  if (p.type === 'text') return { type: 'text', text: p.text || ' ' };
  if (!vision) return { type: 'text', text: '[obraz pominięty / image omitted]' };
  const mt = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(p.mime) ? p.mime : 'image/png';
  return { type: 'image', source: { type: 'base64', media_type: mt, data: p.data } };
}

function echoRaw(raw: any[], stripThinking?: boolean) {
  let lastFallback = -1;
  raw.forEach((b, i) => {
    if (b?.type === 'fallback') lastFallback = i;
  });
  return raw.filter((b, i) => {
    if (!b) return false;
    const isThinking = b.type === 'thinking' || b.type === 'redacted_thinking';
    if (stripThinking && isThinking) return false;
    if (lastFallback >= 0 && i < lastFallback && (isThinking || b.type === 'tool_use')) return false;
    if (b.type === 'text' && !b.text) return false;
    return true;
  });
}

export function toAnthropicMessages(msgs: ConvMessage[], vision: boolean): any[] {
  const out: any[] = [];
  const pushUser = (blocks: any[]) => {
    const last = out[out.length - 1];
    if (last && last.role === 'user') last.content.push(...blocks);
    else out.push({ role: 'user', content: blocks });
  };
  for (const m of msgs) {
    if (m.role === 'user') {
      pushUser(m.content.length ? m.content.map((p) => partToAnthropic(p, vision)) : [{ type: 'text', text: '...' }]);
    } else if (m.role === 'tool') {
      const content = m.content.length ? m.content.map((p) => partToAnthropic(p, vision)) : [{ type: 'text', text: '(no output)' }];
      pushUser([{ type: 'tool_result', tool_use_id: sanitizeId(m.toolCallId), content, ...(m.isError ? { is_error: true } : {}) }]);
    } else {
      let content: any[];
      if (m.raw && m.raw.length) {
        content = echoRaw(m.raw, m.stripThinking);
      } else {
        content = [];
        if (m.text.trim()) content.push({ type: 'text', text: m.text });
        for (const tc of m.toolCalls) content.push({ type: 'tool_use', id: sanitizeId(tc.id), name: tc.name, input: tc.input ?? {} });
      }
      if (!content.length) content = [{ type: 'text', text: '…' }];
      out.push({ role: 'assistant', content });
    }
  }
  return out;
}

function classifyError(e: any): ProviderError {
  const status = e?.status ?? 0;
  const msg = String(e?.error?.error?.message || e?.message || e);
  let code: string | undefined;
  const low = msg.toLowerCase();
  if (status === 401 || status === 403) code = 'auth';
  else if (status === 400 && low.includes('signature') && (low.includes('thinking') || low.includes('different conversation'))) code = 'thinking_signature';
  const retryable = status === 429 || status >= 500 || status === 0;
  return new ProviderError(`Anthropic ${status || ''}: ${msg.slice(0, 800)}`.trim(), status, retryable, code);
}

export async function streamAnthropic(req: ChatRequest): Promise<ChatResponse> {
  const c = getClient();
  const caps = anthropicCaps(req.model, req.info);
  const params: any = {
    model: req.model,
    max_tokens: req.maxTokens,
    system: [{ type: 'text', text: req.system }],
    messages: toAnthropicMessages(req.messages, req.vision),
    cache_control: { type: 'ephemeral' }
  };
  if (req.tools?.length) {
    params.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, eager_input_streaming: true }));
  }
  if (caps.adaptive) params.thinking = { type: 'adaptive', display: 'summarized' };
  if (caps.effort) params.output_config = { effort: req.effort && req.effort !== 'auto' ? req.effort : 'high' };
  if (caps.fallback && req.fallback !== false) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }

  let attempt = 0;
  for (;;) {
    attempt++;
    let text = '';
    let thinking = '';
    let gotOutput = false;
    const toolIndex = new Map<number, number>();
    let toolCount = 0;
    try {
      const stream: any = c.beta.messages.stream(params, { signal: req.signal });
      for await (const ev of stream as AsyncIterable<any>) {
        if (ev.type === 'content_block_start') {
          const b = ev.content_block;
          if (b?.type === 'tool_use') {
            gotOutput = true;
            toolIndex.set(ev.index, toolCount);
            req.cb.onToolStart?.(toolCount, b.id, b.name);
            toolCount++;
          } else if (b?.type === 'fallback') {
            req.cb.onStatus?.(`Fallback: ${b.from?.model || '?'} → ${b.to?.model || '?'}`);
          }
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta;
          if (d?.type === 'text_delta') {
            gotOutput = true;
            text += d.text;
            req.cb.onText?.(d.text);
          } else if (d?.type === 'thinking_delta') {
            gotOutput = true;
            thinking += d.thinking;
            req.cb.onThinking?.(d.thinking);
          } else if (d?.type === 'input_json_delta') {
            const i = toolIndex.get(ev.index);
            if (i !== undefined) req.cb.onToolDelta?.(i, d.partial_json || '');
          }
        }
      }
      const final: any = await stream.finalMessage();
      const content: any[] = final.content || [];
      let lastFallback = -1;
      content.forEach((b, i) => {
        if (b?.type === 'fallback') lastFallback = i;
      });
      const toolCalls: ToolCall[] = content
        .filter((b, i) => b?.type === 'tool_use' && i > lastFallback)
        .map((b) => {
          const input = b.input && typeof b.input === 'object' ? b.input : undefined;
          return { id: b.id, name: b.name, input: input ?? {}, invalid: input === undefined ? 'Tool input was not a JSON object' : undefined };
        });
      const u = final.usage || {};
      const finalText = content
        .filter((b, i) => b?.type === 'text' && i > lastFallback)
        .map((b) => b.text)
        .join('');
      return {
        text: lastFallback >= 0 ? finalText : text || finalText,
        thinking,
        toolCalls,
        usage: {
          input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
          output: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0
        },
        stopReason: final.stop_reason || '',
        raw: content,
        servedModel: final.model,
        refusal: final.stop_reason === 'refusal' ? final.stop_details?.category || 'policy' : undefined
      };
    } catch (e: any) {
      if (req.signal.aborted) throw e;
      const err = classifyError(e);
      const low = err.message.toLowerCase();
      if (err.status === 400 && !gotOutput && attempt < 5) {
        if (params.fallbacks && (low.includes('fallback') || low.includes('server-side-fallback') || low.includes('beta'))) {
          delete params.fallbacks;
          delete params.betas;
          log('anthropic: retry without fallbacks');
          continue;
        }
        if (params.output_config && (low.includes('effort') || low.includes('output_config'))) {
          delete params.output_config;
          continue;
        }
        if (params.thinking && low.includes('thinking') && !low.includes('signature')) {
          delete params.thinking;
          continue;
        }
        if (params.tools && low.includes('eager_input_streaming')) {
          params.tools = params.tools.map(({ eager_input_streaming, ...t }: any) => t);
          continue;
        }
        if (params.cache_control && low.includes('cache_control')) {
          delete params.cache_control;
          continue;
        }
      }
      throw err;
    }
  }
}

export async function completeAnthropic(model: string, system: string, user: string, maxTokens: number, signal?: AbortSignal): Promise<{ text: string; usage: any }> {
  const c = getClient();
  const caps = anthropicCaps(model);
  const params: any = {
    model,
    max_tokens: Math.max(maxTokens, caps.adaptive ? 4000 : maxTokens),
    system,
    messages: [{ role: 'user', content: user }]
  };
  if (caps.effort) params.output_config = { effort: 'low' };
  try {
    const stream: any = c.beta.messages.stream(params, signal ? { signal } : undefined);
    const final: any = await stream.finalMessage();
    const text = (final.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('')
      .trim();
    return { text, usage: { input: (final.usage?.input_tokens || 0) + (final.usage?.cache_read_input_tokens || 0), output: final.usage?.output_tokens || 0 } };
  } catch (e) {
    throw classifyError(e);
  }
}

export async function listAnthropicModels(): Promise<ModelInfo[]> {
  const c = getClient();
  const out: ModelInfo[] = [];
  try {
    for await (const m of c.models.list({ limit: 100 } as any) as any) {
      const caps = (m as any).capabilities || {};
      const leaf = (o: any) => !!o?.supported;
      out.push({
        id: m.id,
        name: m.display_name || m.id,
        provider: 'anthropic',
        contextWindow: (m as any).max_input_tokens || 200_000,
        maxOutput: (m as any).max_tokens || 32_000,
        vision: caps.image_input ? leaf(caps.image_input) : true,
        tools: true,
        reasoning: caps.thinking ? leaf(caps.thinking) : undefined,
        adaptiveThinking: caps.thinking?.types?.adaptive ? leaf(caps.thinking.types.adaptive) : undefined,
        effort: caps.effort ? leaf(caps.effort) : undefined,
        pricing: ANTHROPIC_PRICES[m.id]
      });
    }
  } catch (e) {
    throw classifyError(e);
  }
  return out;
}

// USD per 1M tokens (Anthropic first-party list prices, cached 2026-11).
export const ANTHROPIC_PRICES: Record<string, { input: number; output: number; cacheRead?: number }> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1, output: 5 }
};
