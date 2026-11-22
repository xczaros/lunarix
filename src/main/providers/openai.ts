import type { ProviderId } from '@shared/types';
import { getApiKey, providerConfig, settings } from '../settings';
import { parseJsonLoose, sleep } from '../util';
import { log } from '../events';
import { readSSE, ThinkSplitter } from './sse';
import { longFetch } from './http';
import { ProviderError, type ChatRequest, type ChatResponse, type ConvMessage, type ToolCall } from './types';

interface Endpoint {
  baseUrl: string;
  headers: Record<string, string>;
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  streamUsage: boolean;
  extra: Record<string, any>;
}

export function endpointFor(provider: ProviderId, baseUrlOverride?: string): Endpoint {
  const key = getApiKey(provider);
  const cfg = providerConfig(provider);
  const auth: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  switch (provider) {
    case 'openai':
      return { baseUrl: 'https://api.openai.com/v1', headers: auth, maxTokensParam: 'max_completion_tokens', streamUsage: true, extra: {} };
    case 'xai':
      return { baseUrl: 'https://api.x.ai/v1', headers: auth, maxTokensParam: 'max_tokens', streamUsage: true, extra: {} };
    case 'groq':
      return { baseUrl: 'https://api.groq.com/openai/v1', headers: auth, maxTokensParam: 'max_tokens', streamUsage: true, extra: {} };
    case 'openrouter':
      return { baseUrl: 'https://openrouter.ai/api/v1', headers: { ...auth, 'X-Title': 'Lunarix' }, maxTokensParam: 'max_tokens', streamUsage: true, extra: { usage: { include: true } } };
    case 'google':
      return { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', headers: auth, maxTokensParam: 'max_tokens', streamUsage: true, extra: {} };
    case 'cloudflare': {
      if (!cfg.accountId) throw new ProviderError('Cloudflare: brak Account ID w ustawieniach / missing Account ID', 400);
      return { baseUrl: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/ai/v1`, headers: auth, maxTokensParam: 'max_tokens', streamUsage: false, extra: {} };
    }
    case 'ollama':
    case 'lmstudio':
    case 'custom':
      return { baseUrl: (baseUrlOverride || cfg.baseUrl || 'http://127.0.0.1:8080/v1').replace(/\/+$/, ''), headers: auth, maxTokensParam: 'max_tokens', streamUsage: true, extra: {} };
    case 'local':
      return { baseUrl: (baseUrlOverride || 'http://127.0.0.1:8080/v1').replace(/\/+$/, ''), headers: {}, maxTokensParam: 'max_tokens', streamUsage: true, extra: { cache_prompt: true } };
    default:
      throw new ProviderError(`Provider ${provider} is not OpenAI-compatible`);
  }
}

function toOpenAIMessages(system: string, msgs: ConvMessage[], vision: boolean) {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });
  let pendingImages: { name: string; parts: any[] }[] = [];
  const flushImages = () => {
    if (!pendingImages.length) return;
    const content: any[] = [];
    for (const p of pendingImages) {
      content.push({ type: 'text', text: `[Obrazy zwrócone przez narzędzie ${p.name} / images returned by tool ${p.name}]` });
      content.push(...p.parts);
    }
    out.push({ role: 'user', content });
    pendingImages = [];
  };
  for (const m of msgs) {
    if (m.role !== 'tool') flushImages();
    if (m.role === 'user') {
      const hasImg = m.content.some((c) => c.type === 'image');
      if (!hasImg) {
        out.push({ role: 'user', content: m.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n\n') || '...' });
      } else {
        out.push({
          role: 'user',
          content: m.content.map((c) =>
            c.type === 'text'
              ? { type: 'text', text: c.text }
              : vision
                ? { type: 'image_url', image_url: { url: `data:${c.mime};base64,${c.data}` } }
                : { type: 'text', text: '[obraz pominięty — model nie obsługuje obrazów / image omitted: model has no vision]' }
          )
        });
      }
    } else if (m.role === 'assistant') {
      const msg: any = { role: 'assistant', content: m.text || (m.toolCalls.length ? null : '') };
      if (m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) } }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      const text = m.content
        .filter((c) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: (m.isError ? '[ERROR] ' : '') + (text || '(no output)') });
      const imgs = m.content.filter((c) => c.type === 'image') as { type: 'image'; mime: string; data: string }[];
      if (imgs.length) {
        pendingImages.push({
          name: m.name,
          parts: imgs.map((i) => (vision ? { type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } } : { type: 'text', text: '[obraz pominięty / image omitted]' }))
        });
      }
    }
  }
  flushImages();
  return out;
}

function localSampling(thinking: boolean) {
  return thinking
    ? { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0 }
    : { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5 };
}

export async function streamOpenAI(req: ChatRequest): Promise<ChatResponse> {
  const ep = endpointFor(req.provider, req.baseUrlOverride);
  const body: any = {
    model: req.model,
    messages: toOpenAIMessages(req.system, req.messages, req.vision),
    stream: true,
    ...ep.extra
  };
  body[ep.maxTokensParam] = req.maxTokens;
  if (ep.streamUsage) body.stream_options = { include_usage: true };
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }
  if (req.provider === 'local') {
    Object.assign(body, localSampling(req.thinking !== false));
    body.chat_template_kwargs = { enable_thinking: req.thinking !== false };
    // llama-server streams prompt-processing progress (ignored by builds that do not know it)
    body.return_progress = true;
  }
  if (req.provider === 'openai' && req.effort && req.effort !== 'auto' && /^(o\d|gpt-5)/.test(req.model)) {
    body.reasoning_effort = req.effort === 'xhigh' || req.effort === 'max' ? 'high' : req.effort;
  }

  let attempt = 0;
  let droppedParams: string[] = [];
  for (;;) {
    attempt++;
    let res: Response;
    try {
      res = await longFetch(`${ep.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...ep.headers },
        body: JSON.stringify(body),
        signal: req.signal
      });
    } catch (e: any) {
      if (req.signal.aborted) throw e;
      if (attempt < 3) {
        req.cb.onStatus?.(`Błąd sieci, ponawiam (${attempt})…`);
        await sleep(1500 * attempt);
        continue;
      }
      throw new ProviderError(`Nie można połączyć się z ${ep.baseUrl}: ${e?.message || e}`, 0, true, 'network');
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      let msg = txt;
      try {
        const j = JSON.parse(txt);
        msg = j?.error?.message || j?.message || j?.errors?.[0]?.message || (typeof j?.error === 'string' ? j.error : '') || txt;
      } catch {
        /* raw text */
      }
      // retry without params the server does not understand
      const lower = (msg || '').toLowerCase();
      if (res.status === 400 && attempt < 4) {
        if (body.stream_options && lower.includes('stream_options')) {
          delete body.stream_options;
          droppedParams.push('stream_options');
          continue;
        }
        if (body.reasoning_effort && lower.includes('reasoning')) {
          delete body.reasoning_effort;
          continue;
        }
        if (body.usage && lower.includes('usage')) {
          delete body.usage;
          continue;
        }
        if (body.chat_template_kwargs && lower.includes('chat_template')) {
          delete body.chat_template_kwargs;
          continue;
        }
        if (body.return_progress && lower.includes('progress')) {
          delete body.return_progress;
          continue;
        }
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < 4) {
        const ra = Number(res.headers.get('retry-after')) || 0;
        const wait = ra ? Math.min(60, ra) * 1000 : 2000 * attempt * attempt;
        req.cb.onStatus?.(res.status === 429 ? `Limit zapytań — czekam ${Math.round(wait / 1000)}s…` : `Serwer zajęty (${res.status}) — ponawiam…`);
        await sleep(wait);
        continue;
      }
      throw new ProviderError(`${res.status}: ${String(msg).slice(0, 800)}`, res.status, retryable, res.status === 401 || res.status === 403 ? 'auth' : undefined);
    }
    if (droppedParams.length) log('provider dropped params', req.provider, droppedParams);
    return await consume(res, req);
  }
}

async function consume(res: Response, req: ChatRequest): Promise<ChatResponse> {
  let text = '';
  let thinking = '';
  const calls: { id: string; name: string; args: string }[] = [];
  let usage: any = null;
  let stopReason = '';
  let tps: number | undefined;
  let progressShown = false;
  const P = settings().language === 'pl';
  const clearProgress = () => {
    if (progressShown) {
      progressShown = false;
      req.cb.onStatus?.('');
    }
  };
  const splitter = new ThinkSplitter(
    (s) => {
      text += s;
      req.cb.onText?.(s);
    },
    (s) => {
      thinking += s;
      req.cb.onThinking?.(s);
    }
  );
  if (!res.body) throw new ProviderError('Empty response body');
  for await (const ev of readSSE(res.body, req.signal)) {
    const data = ev.data.trim();
    if (!data || data === '[DONE]') continue;
    let j: any;
    try {
      j = JSON.parse(data);
    } catch {
      continue;
    }
    if (j.error) throw new ProviderError(typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error), j.error.code === 429 ? 429 : 500, false);
    if (j.usage) usage = j.usage;
    if (j.x_groq?.usage) usage = j.x_groq.usage;
    if (j.timings?.predicted_per_second) tps = j.timings.predicted_per_second;
    const pp = j.prompt_progress;
    if (pp && typeof pp.total === 'number' && pp.total > 0) {
      const cache = Number(pp.cache) || 0;
      const total = Math.max(1, pp.total - cache);
      const pct = Math.max(0, Math.min(100, Math.round(((Number(pp.processed) || 0) - cache) / total * 100)));
      if (pct < 100) {
        progressShown = true;
        req.cb.onStatus?.(P ? `Model czyta kontekst… ${pct}% (${total.toLocaleString('pl-PL')} tokenów)` : `Reading the context… ${pct}% (${total.toLocaleString('en-US')} tokens)`);
      } else clearProgress();
    }
    const choice = j.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) stopReason = choice.finish_reason;
    const d = choice.delta || choice.message || {};
    if (progressShown && (d.content || d.reasoning_content || d.reasoning || d.tool_calls)) clearProgress();
    const reasoning = d.reasoning_content ?? d.reasoning ?? d.thinking;
    if (typeof reasoning === 'string' && reasoning) {
      thinking += reasoning;
      req.cb.onThinking?.(reasoning);
    }
    if (typeof d.content === 'string' && d.content) splitter.push(d.content);
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        let idx: number = typeof tc.index === 'number' ? tc.index : -1;
        if (idx < 0) {
          idx = tc.id ? calls.findIndex((c) => c.id === tc.id) : -1;
          if (idx < 0) idx = calls.length;
        }
        if (!calls[idx]) {
          calls[idx] = { id: tc.id || `call_${idx}_${Date.now().toString(36)}`, name: '', args: '' };
        }
        const c = calls[idx];
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) {
          const isNew = !c.name;
          if (!c.name || tc.function.name.startsWith(c.name)) c.name = tc.function.name;
          if (isNew) req.cb.onToolStart?.(idx, c.id, c.name);
        }
        if (tc.function?.arguments) {
          const a = typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
          c.args += a;
          req.cb.onToolDelta?.(idx, a);
        }
      }
    }
  }
  splitter.flush();
  clearProgress();
  const toolCalls: ToolCall[] = calls
    .filter((c) => c && c.name)
    .map((c) => {
      const input = c.args.trim() ? parseJsonLoose(c.args) : {};
      return { id: c.id, name: c.name, input: input ?? {}, invalid: input === undefined ? c.args.slice(0, 2000) : undefined };
    });
  const u = usage || {};
  const cached = u.prompt_tokens_details?.cached_tokens || u.cache_read_input_tokens || 0;
  return {
    text,
    thinking,
    toolCalls,
    usage: {
      input: u.prompt_tokens ?? u.input_tokens ?? 0,
      output: u.completion_tokens ?? u.output_tokens ?? 0,
      cacheRead: cached,
      estimated: !usage,
      cost: typeof u.cost === 'number' ? u.cost : undefined
    },
    stopReason,
    tokensPerSec: tps
  };
}

/** Non-streaming single completion helper (titles, prompt enhancer, inline edit). */
export async function completeOpenAI(provider: ProviderId, model: string, system: string, user: string, maxTokens: number, baseUrlOverride?: string, signal?: AbortSignal): Promise<{ text: string; usage: any }> {
  const ctrl = new AbortController();
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  const r = await streamOpenAI({
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens,
    signal: ctrl.signal,
    cb: {},
    vision: false,
    thinking: false,
    baseUrlOverride
  });
  return { text: r.text.trim(), usage: r.usage };
}
