import { app, safeStorage } from 'electron';
import path from 'node:path';
import type { ModelInfo, ProviderId, ProviderPublicState, Settings } from '@shared/types';
import { PROVIDERS, providerMeta } from '@shared/catalog';
import { paths } from './paths';
import { JsonStore, deepMerge } from './util';
import { emit } from './events';

export function defaultSettings(): Settings {
  let locale = 'en';
  try {
    locale = app.getLocale() || app.getSystemLocale?.() || 'en';
  } catch {
    /* ignore */
  }
  const lang = locale.toLowerCase().startsWith('pl') ? 'pl' : 'en';
  return {
    version: 1,
    language: lang,
    theme: 'dark',
    onboarded: false,
    profile: { useCases: [], experience: 'intermediate' },
    activeModel: { provider: 'local', model: 'high' },
    recentModels: [],
    local: {
      tier: 'high',
      backend: 'auto',
      contextSize: 0,
      gpuLayers: -1,
      threads: 0,
      thinking: true,
      vision: true,
      modelsDir: paths.defaultModels,
      idleUnloadMinutes: 20
    },
    agent: {
      approval: 'auto-edits',
      defaultMode: 'agent',
      maxSteps: 150,
      autoCompact: true,
      effort: 'auto',
      followAgent: true,
      showBrowser: true,
      allowDesktop: true,
      notifyOnDone: true,
      sound: true,
      commandTimeoutSec: 120,
      anthropicFallback: true,
      autoTitle: true
    },
    editor: { fontSize: 13.5, wordWrap: false, minimap: true, tabSize: 2, autoSave: false, ligatures: true },
    customInstructions: '',
    ui: {
      sidebarWidth: 264,
      chatWidth: 460,
      panelHeight: 250,
      sidebarVisible: true,
      panelVisible: false,
      chatVisible: true,
      sidebarView: 'explorer'
    },
    projectsRoot: paths.defaultProjectsRoot
  };
}

let settingsStore: JsonStore<Settings>;
export function settings(): Settings {
  if (!settingsStore) settingsStore = new JsonStore<Settings>(path.join(paths.data, 'settings.json'), defaultSettings());
  return settingsStore.data;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  settings();
  settingsStore.data = deepMerge(settingsStore.data, patch);
  if (patch.recentModels) settingsStore.data.recentModels = patch.recentModels;
  if (patch.profile?.useCases) settingsStore.data.profile.useCases = patch.profile.useCases;
  settingsStore.save();
  emit('settings', settingsStore.data);
  return settingsStore.data;
}

export function flushSettings() {
  settingsStore?.flush();
  providerStore?.flush();
  secretStore?.flush();
}

// ---------------------------------------------------------------- providers

interface ProviderConfig {
  enabled: boolean;
  accountId?: string;
  baseUrl?: string;
  models: ModelInfo[];
  modelsFetchedAt?: number;
  lastError?: string;
}

let providerStore: JsonStore<Record<string, ProviderConfig>>;
let secretStore: JsonStore<Record<string, string>>;

function providersData() {
  if (!providerStore) providerStore = new JsonStore<Record<string, ProviderConfig>>(path.join(paths.data, 'providers.json'), {});
  return providerStore.data;
}
function secrets() {
  if (!secretStore) secretStore = new JsonStore<Record<string, string>>(path.join(paths.data, 'secrets.json'), {});
  return secretStore.data;
}

// Decrypted keys live only in memory; on disk they are encrypted with the OS keystore (DPAPI on Windows).
const keyCache = new Map<string, string>();

async function encAsync(v: string): Promise<string> {
  try {
    if (await safeStorage.isAsyncEncryptionAvailable()) return 'enc2:' + (await safeStorage.encryptStringAsync(v)).toString('base64');
  } catch {
    /* fallthrough */
  }
  return 'plain:' + Buffer.from(v, 'utf8').toString('base64');
}

async function decAsync(v?: string): Promise<{ value?: string; reencrypt: boolean }> {
  if (!v) return { reencrypt: false };
  try {
    if (v.startsWith('enc2:')) {
      const r: any = await safeStorage.decryptStringAsync(Buffer.from(v.slice(5), 'base64'));
      return { value: typeof r === 'string' ? r : r?.result, reencrypt: !!r?.shouldReEncrypt };
    }
    if (v.startsWith('enc:')) {
      // legacy format written by the synchronous API
      return { value: (safeStorage as any).decryptString(Buffer.from(v.slice(4), 'base64')), reencrypt: true };
    }
    if (v.startsWith('plain:')) return { value: Buffer.from(v.slice(6), 'base64').toString('utf8'), reencrypt: true };
  } catch {
    return { reencrypt: false };
  }
  return { reencrypt: false };
}

/** Decrypt stored API keys into memory. Call once after app ready, before any provider use. */
export async function initSecrets() {
  const all = secrets();
  for (const [id, stored] of Object.entries(all)) {
    const { value, reencrypt } = await decAsync(stored);
    if (!value) continue;
    keyCache.set(id, value);
    if (reencrypt) {
      const fresh = await encAsync(value);
      if (fresh.startsWith('enc2:')) {
        all[id] = fresh;
        secretStore.save();
      }
    }
  }
}

export function providerConfig(id: ProviderId): ProviderConfig {
  const all = providersData();
  if (!all[id]) {
    const meta = providerMeta(id);
    all[id] = { enabled: true, models: [], baseUrl: meta?.defaultBaseUrl };
  }
  return all[id];
}

export function getApiKey(id: ProviderId): string | undefined {
  const envMap: Partial<Record<ProviderId, string>> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GEMINI_API_KEY',
    xai: 'XAI_API_KEY',
    groq: 'GROQ_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    cloudflare: 'CLOUDFLARE_API_TOKEN'
  };
  const stored = keyCache.get(id);
  if (stored) return stored;
  const env = envMap[id];
  return env && process.env.LUNARIX_USE_ENV_KEYS ? process.env[env] : undefined;
}

export function setProviderConfig(id: ProviderId, patch: { apiKey?: string; accountId?: string; baseUrl?: string; enabled?: boolean }) {
  const cfg = providerConfig(id);
  if (patch.apiKey !== undefined) {
    const k = patch.apiKey.trim();
    if (k) {
      keyCache.set(id, k);
      encAsync(k).then((v) => {
        if (keyCache.get(id) !== k) return; // replaced meanwhile
        secrets()[id] = v;
        secretStore.save();
      });
    } else {
      keyCache.delete(id);
      delete secrets()[id];
      secretStore.save();
    }
    cfg.lastError = undefined;
  }
  if (patch.accountId !== undefined) cfg.accountId = patch.accountId.trim();
  if (patch.baseUrl !== undefined) cfg.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '');
  if (patch.enabled !== undefined) cfg.enabled = patch.enabled;
  providerStore.save();
}

export function setProviderModels(id: ProviderId, models: ModelInfo[], error?: string) {
  const cfg = providerConfig(id);
  if (error) {
    cfg.lastError = error;
  } else {
    cfg.models = models;
    cfg.modelsFetchedAt = Date.now();
    cfg.lastError = undefined;
  }
  providerStore.save();
}

function preview(key?: string) {
  if (!key) return undefined;
  if (key.length <= 10) return '•'.repeat(key.length);
  return key.slice(0, 5) + '…' + key.slice(-4);
}

export function publicProviders(): ProviderPublicState[] {
  return PROVIDERS.map((meta) => {
    const cfg = providerConfig(meta.id);
    const key = getApiKey(meta.id);
    const models = cfg.models?.length ? cfg.models : meta.defaults;
    return {
      id: meta.id,
      enabled: cfg.enabled !== false,
      hasKey: !!key,
      keyPreview: preview(key),
      accountId: cfg.accountId,
      baseUrl: cfg.baseUrl || meta.defaultBaseUrl,
      models,
      modelsFetchedAt: cfg.modelsFetchedAt,
      lastError: cfg.lastError
    };
  });
}

export function findModelInfo(provider: ProviderId, model: string): ModelInfo | undefined {
  const cfg = providerConfig(provider);
  const list = cfg.models?.length ? cfg.models : providerMeta(provider)?.defaults || [];
  return list.find((m) => m.id === model) || providerMeta(provider)?.defaults.find((m) => m.id === model);
}
