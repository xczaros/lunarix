import type { LocalTierId, ModelInfo, ProviderId } from './types';

export interface LocalTier {
  id: LocalTierId;
  name: string;
  model: string;
  params: string;
  repo: string;
  file: string;
  mmproj: string;
  sizeGB: number;
  mmprojGB: number;
  layers: number;
  kvBytesPerToken: number; // f16 KV cache bytes per token (full-attention layers only)
  moe: boolean;
  activeParamsB: number;
  minRamGB: number;
  defaultContext: number;
  family: string;
}

// Five local tiers. All models are Apache-2.0 Qwen models with built-in vision (mmproj).
export const LOCAL_TIERS: LocalTier[] = [
  {
    id: 'low',
    name: 'Low',
    model: 'Qwen3.5 2B',
    params: '2B',
    repo: 'unsloth/Qwen3.5-2B-GGUF',
    file: 'Qwen3.5-2B-Q4_K_M.gguf',
    mmproj: 'mmproj-F16.gguf',
    sizeGB: 1.19,
    mmprojGB: 0.62,
    layers: 24,
    kvBytesPerToken: 6 * 2 * 256 * 2 * 2,
    moe: false,
    activeParamsB: 2,
    minRamGB: 4,
    defaultContext: 32768,
    family: 'qwen3.5'
  },
  {
    id: 'medium',
    name: 'Medium',
    model: 'Qwen3.5 4B',
    params: '4B',
    repo: 'unsloth/Qwen3.5-4B-GGUF',
    file: 'Qwen3.5-4B-Q4_K_M.gguf',
    mmproj: 'mmproj-F16.gguf',
    sizeGB: 2.55,
    mmprojGB: 0.63,
    layers: 32,
    kvBytesPerToken: 8 * 4 * 256 * 2 * 2,
    moe: false,
    activeParamsB: 4,
    minRamGB: 8,
    defaultContext: 32768,
    family: 'qwen3.5'
  },
  {
    id: 'high',
    name: 'High',
    model: 'Qwen3.5 9B',
    params: '9B',
    repo: 'unsloth/Qwen3.5-9B-GGUF',
    file: 'Qwen3.5-9B-Q4_K_M.gguf',
    mmproj: 'mmproj-F16.gguf',
    sizeGB: 5.29,
    mmprojGB: 0.86,
    layers: 32,
    kvBytesPerToken: 8 * 4 * 256 * 2 * 2,
    moe: false,
    activeParamsB: 9,
    minRamGB: 12,
    defaultContext: 32768,
    family: 'qwen3.5'
  },
  {
    id: 'extra',
    name: 'Extra',
    model: 'Qwen3.6 35B-A3B (MoE)',
    params: '35B / 3B aktywnych',
    repo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
    file: 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf',
    mmproj: 'mmproj-F16.gguf',
    sizeGB: 20.61,
    mmprojGB: 0.84,
    layers: 40,
    kvBytesPerToken: 10 * 2 * 256 * 2 * 2,
    moe: true,
    activeParamsB: 3,
    minRamGB: 28,
    defaultContext: 65536,
    family: 'qwen3.6'
  },
  {
    id: 'max',
    name: 'Max',
    model: 'Qwen3.8 27B',
    params: '27B',
    repo: 'unsloth/Qwen3.8-27B-GGUF',
    file: 'Qwen3.8-27B-UD-Q4_K_M.gguf',
    mmproj: 'mmproj-F16.gguf',
    sizeGB: 15.43,
    mmprojGB: 0.86,
    layers: 64,
    kvBytesPerToken: 16 * 4 * 256 * 2 * 2,
    moe: false,
    activeParamsB: 27,
    minRamGB: 24,
    defaultContext: 49152,
    family: 'qwen3.8'
  }
];

export const tierById = (id: LocalTierId) => LOCAL_TIERS.find((t) => t.id === id) || LOCAL_TIERS[2];

export interface ProviderMeta {
  id: ProviderId;
  name: string;
  short: string;
  keyUrl?: string;
  needsKey: boolean;
  needsAccountId?: boolean;
  needsBaseUrl?: boolean;
  defaultBaseUrl?: string;
  description: { pl: string; en: string };
  defaults: ModelInfo[];
}

const m = (provider: ProviderId, id: string, name: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  name,
  provider,
  tools: true,
  ...extra
});

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    short: 'Anthropic',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    needsKey: true,
    description: { pl: 'Modele Claude — najlepsze do kodowania agentowego.', en: 'Claude models — excellent for agentic coding.' },
    defaults: [
      m('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', { contextWindow: 1_000_000, maxOutput: 128_000, vision: true, adaptiveThinking: true, effort: true, reasoning: true, pricing: { input: 4, output: 20 } }),
      m('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', { contextWindow: 1_000_000, maxOutput: 128_000, vision: true, adaptiveThinking: true, effort: true, reasoning: true, pricing: { input: 2, output: 10 } }),
      m('anthropic', 'claude-haiku-5-5', 'Claude Haiku 5.5', { contextWindow: 1_000_000, maxOutput: 128_000, vision: true, adaptiveThinking: true, effort: true, reasoning: true, pricing: { input: 0.1, output: 0.5 } }),
      m('anthropic', 'claude-fable-5-2', 'Claude Fable 5.2', { contextWindow: 1_000_000, maxOutput: 128_000, vision: true, adaptiveThinking: true, effort: true, reasoning: true, pricing: { input: 8, output: 40 } })
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    short: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    needsKey: true,
    description: { pl: 'Modele GPT od OpenAI.', en: 'GPT models from OpenAI.' },
    defaults: [m('openai', 'gpt-5', 'GPT-5', { vision: true, contextWindow: 400_000 }), m('openai', 'gpt-5-mini', 'GPT-5 mini', { vision: true, contextWindow: 400_000 })]
  },
  {
    id: 'google',
    name: 'Google (Gemini)',
    short: 'Google',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    needsKey: true,
    description: { pl: 'Modele Gemini — ogromny kontekst, darmowy limit.', en: 'Gemini models — huge context, free tier.' },
    defaults: [m('google', 'gemini-2.5-pro', 'Gemini 2.5 Pro', { vision: true, contextWindow: 1_048_576 }), m('google', 'gemini-2.5-flash', 'Gemini 2.5 Flash', { vision: true, contextWindow: 1_048_576 })]
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    short: 'Grok',
    keyUrl: 'https://console.x.ai',
    needsKey: true,
    description: { pl: 'Modele Grok od xAI.', en: 'Grok models from xAI.' },
    defaults: [m('xai', 'grok-code-fast-1', 'Grok Code Fast 1', { contextWindow: 256_000 }), m('xai', 'grok-4', 'Grok 4', { vision: true, contextWindow: 256_000 })]
  },
  {
    id: 'groq',
    name: 'Groq',
    short: 'Groq',
    keyUrl: 'https://console.groq.com/keys',
    needsKey: true,
    description: { pl: 'Błyskawiczna inferencja modeli open-source.', en: 'Lightning-fast inference of open models.' },
    defaults: [m('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B', { contextWindow: 131_072 }), m('groq', 'moonshotai/kimi-k2-instruct-0905', 'Kimi K2', { contextWindow: 262_144 })]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    short: 'OpenRouter',
    keyUrl: 'https://openrouter.ai/keys',
    needsKey: true,
    description: { pl: 'Setki modeli w jednym kluczu, także darmowe.', en: 'Hundreds of models with one key, incl. free ones.' },
    defaults: []
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    short: 'Cloudflare',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    needsKey: true,
    needsAccountId: true,
    description: { pl: 'Modele na sieci Cloudflare (wymaga Account ID).', en: 'Models on the Cloudflare network (needs Account ID).' },
    defaults: [m('cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Llama 3.3 70B', { contextWindow: 24_000 })]
  },
  {
    id: 'ollama',
    name: 'Ollama',
    short: 'Ollama',
    needsKey: false,
    needsBaseUrl: true,
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    description: { pl: 'Twoje modele z Ollama (jeśli masz zainstalowane).', en: 'Your Ollama models (if installed).' },
    defaults: []
  },
  {
    id: 'lmstudio',
    name: 'LM Studio',
    short: 'LM Studio',
    needsKey: false,
    needsBaseUrl: true,
    defaultBaseUrl: 'http://127.0.0.1:1234/v1',
    description: { pl: 'Serwer lokalny LM Studio.', en: 'LM Studio local server.' },
    defaults: []
  },
  {
    id: 'custom',
    name: 'OpenAI-compatible',
    short: 'Custom',
    needsKey: false,
    needsBaseUrl: true,
    defaultBaseUrl: 'http://127.0.0.1:8080/v1',
    description: { pl: 'Dowolny serwer zgodny z API OpenAI.', en: 'Any OpenAI-compatible server.' },
    defaults: []
  }
];

export const providerMeta = (id: ProviderId) => PROVIDERS.find((p) => p.id === id);

export const USE_CASES = ['web', 'fullstack', 'desktop', 'games', 'python', 'automation', 'mobile', 'learning'] as const;
