import { create } from 'zustand';
import type {
  AppInfo,
  Chat,
  ChatMeta,
  DownloadProgress,
  EngineStatus,
  HardwareInfo,
  LocalModelState,
  Message,
  ModelInfo,
  Project,
  ProviderPublicState,
  Settings,
  Todo,
  ToolchainItem,
  UsageSummary
} from '@shared/types';
import { api } from '../lib/api';
import { setLang, tx } from '../lib/i18n';

export type Modal = null | 'settings' | 'usage' | 'palette' | 'quickopen' | 'newproject' | 'about';

export interface Toast {
  id: number;
  text: string;
  level: 'info' | 'success' | 'warn' | 'error';
  out?: boolean;
}

interface AppState {
  ready: boolean;
  info: AppInfo | null;
  settings: Settings | null;
  providers: ProviderPublicState[];
  models: ModelInfo[];
  projects: Project[];
  projectId: string | null;
  chatMetas: ChatMeta[];
  activeChatId: string | null;
  engine: EngineStatus;
  localModels: LocalModelState[];
  downloads: Record<string, DownloadProgress>;
  usage: UsageSummary | null;
  hardware: HardwareInfo | null;
  toolchain: ToolchainItem[];
  modal: Modal;
  settingsTab: string;
  chill: boolean;
  toasts: Toast[];
  status: Record<string, string>;
  queue: Record<string, string[]>;
  todos: Record<string, Todo[]>;
  lightbox: string | null;
  maximized: boolean;
  composerFill: { text: string; nonce: number } | null;

  init(): Promise<void>;
  patchSettings(p: Partial<Settings>): Promise<void>;
  patchUi(p: Partial<Settings['ui']>): void;
  refreshProviders(): Promise<void>;
  refreshModels(): Promise<void>;
  selectProject(id: string): Promise<void>;
  ensureProject(): Promise<Project>;
  openChat(id: string | null): Promise<void>;
  newChat(projectId?: string): Promise<Chat>;
  toast(text: string, level?: Toast['level']): void;
  setModal(m: Modal, tab?: string): void;
  project(): Project | undefined;
  fillComposer(text: string): void;
}

let toastId = 0;
let uiTimer: any = null;

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  info: null,
  settings: null,
  providers: [],
  models: [],
  projects: [],
  projectId: null,
  chatMetas: [],
  activeChatId: null,
  engine: { state: 'stopped' },
  localModels: [],
  downloads: {},
  usage: null,
  hardware: null,
  toolchain: [],
  modal: null,
  settingsTab: 'general',
  chill: false,
  toasts: [],
  status: {},
  queue: {},
  todos: {},
  lightbox: null,
  maximized: false,
  composerFill: null,

  async init() {
    const [info, settings, providers, projects, chatMetas, engine, localModels, usage] = await Promise.all([
      api.appInfo(),
      api.getSettings(),
      api.getProviders(),
      api.listProjects(),
      api.listChats(),
      api.engineStatus(),
      api.localModels(),
      api.usage()
    ]);
    setLang(settings.language);
    document.documentElement.dataset.theme = settings.theme;
    set({ info, settings, providers, projects, chatMetas, engine, localModels, usage });
    await get().refreshModels();
    if (settings.onboarded) {
      const proj = projects[0] || (await api.getDefaultProject());
      if (!projects.length) set({ projects: await api.listProjects() });
      await get().selectProject(proj.id);
    }
    set({ ready: true });
    api.toolchain().then((toolchain) => set({ toolchain })).catch(() => {});
  },

  async patchSettings(p) {
    const cur = get().settings;
    if (cur) set({ settings: { ...cur, ...p, ui: { ...cur.ui, ...(p.ui || {}) }, agent: { ...cur.agent, ...(p.agent || {}) }, local: { ...cur.local, ...(p.local || {}) }, editor: { ...cur.editor, ...(p.editor || {}) }, profile: { ...cur.profile, ...(p.profile || {}) } } as Settings });
    const s = await api.updateSettings(p);
    if (p.language) setLang(p.language);
    if (p.theme) {
      document.documentElement.dataset.theme = p.theme;
      window.lunarix.titlebarTheme();
    }
    set({ settings: s });
  },

  patchUi(p) {
    const cur = get().settings;
    if (!cur) return;
    const ui = { ...cur.ui, ...p };
    set({ settings: { ...cur, ui } });
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => api.updateSettings({ ui } as any), 400);
  },

  async refreshProviders() {
    set({ providers: await api.getProviders() });
    await get().refreshModels();
  },

  async refreshModels() {
    set({ models: await api.listAllModels() });
  },

  async selectProject(id) {
    set({ projectId: id });
    api.touchProject(id);
    const p = get().projects.find((x) => x.id === id);
    if (p) api.watchRoot(p.path);
    const chats = get().chatMetas.filter((c) => c.projectId === id).sort((a, b) => b.updatedAt - a.updatedAt);
    const cur = get().activeChatId;
    const curMeta = get().chatMetas.find((c) => c.id === cur);
    if (!curMeta || curMeta.projectId !== id) set({ activeChatId: chats[0]?.id || null });
  },

  async ensureProject() {
    const id = get().projectId;
    const p = get().projects.find((x) => x.id === id);
    if (p) return p;
    const def = await api.getDefaultProject();
    set({ projects: await api.listProjects() });
    await get().selectProject(def.id);
    return def;
  },

  async openChat(id) {
    if (!id) {
      set({ activeChatId: null });
      return;
    }
    const meta = get().chatMetas.find((c) => c.id === id);
    if (meta && meta.projectId !== get().projectId) await get().selectProject(meta.projectId);
    set({ activeChatId: id });
    const s = get().settings;
    if (s && !s.ui.chatVisible) get().patchUi({ chatVisible: true });
  },

  async newChat(projectId) {
    const proj = projectId ? get().projects.find((p) => p.id === projectId) : await get().ensureProject();
    const pid = proj?.id || (await get().ensureProject()).id;
    const chat = await api.createChat(pid);
    set((st) => ({ chatMetas: [chat as ChatMeta, ...st.chatMetas.filter((c) => c.id !== chat.id)], activeChatId: chat.id }));
    const s = get().settings;
    if (s && !s.ui.chatVisible) get().patchUi({ chatVisible: true });
    return chat;
  },

  toast(text, level = 'info') {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, text, level }] }));
    const ttl = level === 'error' ? 7000 : 3800;
    setTimeout(() => set((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, out: true } : t)) })), ttl);
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ttl + 300);
  },

  setModal(m, tab) {
    set({ modal: m, ...(tab ? { settingsTab: tab } : {}) });
  },

  project() {
    const id = get().projectId;
    return get().projects.find((p) => p.id === id);
  },

  fillComposer(text) {
    set({ composerFill: { text, nonce: Date.now() } });
  }
}));

// ------------------------------------------------------------------ chats

interface ChatsState {
  chats: Record<string, Chat>;
  load(id: string, force?: boolean): Promise<Chat | null>;
  upsertMessage(chatId: string, m: Message): void;
  removeMessage(chatId: string, id: string): void;
  setMeta(meta: ChatMeta): void;
  drop(id: string): void;
}

export const useChats = create<ChatsState>((set, get) => ({
  chats: {},
  async load(id, force) {
    if (!force && get().chats[id]) return get().chats[id];
    const c = await api.getChat(id);
    if (c) set((s) => ({ chats: { ...s.chats, [id]: c } }));
    if (c?.todos) useApp.setState((s) => ({ todos: { ...s.todos, [id]: c.todos! } }));
    return c;
  },
  upsertMessage(chatId, m) {
    const c = get().chats[chatId];
    if (!c) return;
    const idx = c.messages.findIndex((x) => x.id === m.id);
    const messages = idx >= 0 ? c.messages.map((x, i) => (i === idx ? m : x)) : [...c.messages, m];
    set((s) => ({ chats: { ...s.chats, [chatId]: { ...c, messages } } }));
  },
  removeMessage(chatId, id) {
    const c = get().chats[chatId];
    if (!c) return;
    set((s) => ({ chats: { ...s.chats, [chatId]: { ...c, messages: c.messages.filter((m) => m.id !== id) } } }));
  },
  setMeta(meta) {
    const c = get().chats[meta.id];
    if (!c) return;
    set((s) => ({ chats: { ...s.chats, [meta.id]: { ...c, ...meta, messages: c.messages } } }));
  },
  drop(id) {
    set((s) => {
      const chats = { ...s.chats };
      delete chats[id];
      return { chats };
    });
  }
}));

export function upsertMeta(meta: ChatMeta) {
  useApp.setState((s) => {
    const i = s.chatMetas.findIndex((c) => c.id === meta.id);
    const list = i >= 0 ? s.chatMetas.map((c, j) => (j === i ? meta : c)) : [meta, ...s.chatMetas];
    return { chatMetas: list };
  });
  useChats.getState().setMeta(meta);
}

export const runningCount = () => useApp.getState().chatMetas.filter((c) => c.running).length;
export const t = tx;
