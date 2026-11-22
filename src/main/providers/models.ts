import type { ModelInfo, ProviderId } from '@shared/types';
import { getApiKey, providerConfig, setProviderModels } from '../settings';
import { listAnthropicModels, ANTHROPIC_PRICES } from './anthropic';
import { endpointFor } from './openai';
import { ProviderError } from './types';
import { errMsg } from '../util';

async function getJson(url: string, headers: Record<string, string> = {}, timeout = 25000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: ctrl.signal });
    const txt = await res.text();
    if (!res.ok) {
      let msg = txt;
      try {
        const j = JSON.parse(txt);
        msg = j?.error?.message || j?.errors?.[0]?.message || j?.message || txt;
      } catch {
        /* raw */
      }
      throw new ProviderError(`${res.status}: ${String(msg).slice(0, 300)}`, res.status);
    }
    return JSON.parse(txt);
  } finally {
    clearTimeout(t);
  }
}

const prettify = (id: string) =>
  id
    .replace(/^models\//, '')
    .replace(/^@(cf|hf)\//, '')
    .split('/')
    .pop()!
    .replace(/[-_]/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());

function openaiChatModel(id: string) {
  const l = id.toLowerCase();
  if (!/^(gpt-|o\d|chatgpt|codex)/.test(l)) return false;
  return !/(audio|realtime|tts|transcribe|image|embedding|moderation|search-preview|instruct|dall-e|whisper|davinci|babbage|-deep-research)/.test(l);
}

export async function fetchProviderModels(id: ProviderId): Promise<ModelInfo[]> {
  let models: ModelInfo[] = [];
  try {
    models = await fetchRaw(id);
    models.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    setProviderModels(id, models);
    return models;
  } catch (e) {
    setProviderModels(id, [], errMsg(e));
    throw e;
  }
}

async function fetchRaw(id: ProviderId): Promise<ModelInfo[]> {
  const key = getApiKey(id);
  const auth: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  switch (id) {
    case 'anthropic':
      return await listAnthropicModels();
    case 'openai': {
      if (!key) throw new ProviderError('Brak klucza API / missing API key', 401);
      const j = await getJson('https://api.openai.com/v1/models', auth);
      return (j.data || [])
        .filter((m: any) => openaiChatModel(m.id))
        .map((m: any) => ({ id: m.id, name: m.id.toUpperCase().startsWith('GPT') ? m.id.replace(/^gpt/i, 'GPT') : m.id, provider: 'openai', tools: true, vision: /gpt-4o|gpt-4\.1|gpt-5|o3|o4/.test(m.id), reasoning: /^o\d|gpt-5/.test(m.id) }) as ModelInfo);
    }
    case 'xai': {
      if (!key) throw new ProviderError('Brak klucza API / missing API key', 401);
      try {
        const j = await getJson('https://api.x.ai/v1/language-models', auth);
        const list = j.models || j.data || [];
        if (list.length)
          return list.map((m: any) => ({
            id: m.id,
            name: prettify(m.id),
            provider: 'xai',
            tools: true,
            vision: Array.isArray(m.input_modalities) ? m.input_modalities.includes('image') : /vision|grok-4/.test(m.id),
            pricing: m.prompt_text_token_price ? { input: m.prompt_text_token_price / 10000, output: m.completion_text_token_price / 10000 } : undefined
          }));
      } catch {
        /* fall back to /models */
      }
      const j = await getJson('https://api.x.ai/v1/models', auth);
      return (j.data || []).filter((m: any) => !/image|imagine|video/.test(m.id)).map((m: any) => ({ id: m.id, name: prettify(m.id), provider: 'xai', tools: true, vision: /vision|grok-4/.test(m.id) }));
    }
    case 'groq': {
      if (!key) throw new ProviderError('Brak klucza API / missing API key', 401);
      const j = await getJson('https://api.groq.com/openai/v1/models', auth);
      return (j.data || [])
        .filter((m: any) => m.active !== false && !/whisper|tts|guard|playai|orpheus|distil/i.test(m.id))
        .map((m: any) => ({ id: m.id, name: prettify(m.id), provider: 'groq', tools: true, contextWindow: m.context_window, maxOutput: m.max_completion_tokens, vision: /scout|maverick|vision|llama-4/i.test(m.id) }));
    }
    case 'google': {
      if (!key) throw new ProviderError('Brak klucza API / missing API key', 401);
      const j = await getJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key)}`);
      return (j.models || [])
        .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini|gemma/i.test(m.name) && !/embedding|aqa|imagen|veo|tts|image-generation|live|native-audio/i.test(m.name))
        .map((m: any) => ({
          id: String(m.name).replace(/^models\//, ''),
          name: m.displayName || prettify(m.name),
          provider: 'google',
          tools: !/gemma/i.test(m.name),
          vision: true,
          contextWindow: m.inputTokenLimit,
          maxOutput: m.outputTokenLimit,
          description: m.description
        }));
    }
    case 'openrouter': {
      const j = await getJson('https://openrouter.ai/api/v1/models', auth);
      return (j.data || [])
        .filter((m: any) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes('text'))
        .map((m: any) => {
          const pIn = Number(m.pricing?.prompt || 0) * 1e6;
          const pOut = Number(m.pricing?.completion || 0) * 1e6;
          return {
            id: m.id,
            name: m.name || m.id,
            provider: 'openrouter',
            contextWindow: m.context_length,
            maxOutput: m.top_provider?.max_completion_tokens || undefined,
            vision: (m.architecture?.input_modalities || []).includes('image'),
            tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : true,
            free: String(m.id).endsWith(':free') || (pIn === 0 && pOut === 0),
            pricing: { input: Math.round(pIn * 1000) / 1000, output: Math.round(pOut * 1000) / 1000 },
            description: m.description ? String(m.description).slice(0, 300) : undefined
          } as ModelInfo;
        });
    }
    case 'cloudflare': {
      const cfg = providerConfig('cloudflare');
      if (!key) throw new ProviderError('Brak tokenu API / missing API token', 401);
      if (!cfg.accountId) throw new ProviderError('Brak Account ID / missing Account ID', 400);
      const j = await getJson(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/ai/models/search?task=Text%20Generation&per_page=200`, auth);
      return (j.result || []).map((m: any) => {
        const props: Record<string, any> = {};
        for (const p of m.properties || []) props[p.property_id] = p.value;
        return {
          id: m.name,
          name: prettify(m.name),
          provider: 'cloudflare',
          tools: String(props.function_calling) === 'true',
          contextWindow: Number(props.context_window || props.max_input_tokens) || undefined,
          vision: /vision|llava|llama-3\.2-11b|gemma-3|llama-4/i.test(m.name),
          description: m.description
        } as ModelInfo;
      });
    }
    case 'ollama': {
      const base = endpointFor('ollama').baseUrl.replace(/\/v1$/, '');
      const j = await getJson(`${base}/api/tags`, {}, 5000);
      return (j.models || []).map((m: any) => ({ id: m.name, name: m.name, provider: 'ollama', tools: true, vision: /llava|vision|vl|gemma3|qwen3\.5|qwen2\.5vl|minicpm-v|moondream/i.test(m.name) }));
    }
    case 'lmstudio':
    case 'custom': {
      const ep = endpointFor(id);
      const j = await getJson(`${ep.baseUrl}/models`, ep.headers, 8000);
      return (j.data || []).filter((m: any) => !/embed/i.test(m.id)).map((m: any) => ({ id: m.id, name: m.id, provider: id, tools: true, vision: /vl|vision|llava|qwen3\.5|gemma-3/i.test(m.id) }));
    }
    default:
      return [];
  }
}

export function priceFor(provider: ProviderId, model: string, info?: ModelInfo) {
  if (provider === 'anthropic') return ANTHROPIC_PRICES[model] || (info?.pricing as any);
  if (info?.pricing && (info.pricing.input || info.pricing.output)) return info.pricing;
  return undefined;
}
