// Shared types between the Electron main process and the renderer.

export type ProviderId =
  | 'local'
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'xai'
  | 'groq'
  | 'openrouter'
  | 'cloudflare'
  | 'ollama'
  | 'lmstudio'
  | 'custom'
  | 'mock';

export type LocalTierId = 'low' | 'medium' | 'high' | 'extra' | 'max';
export type AgentMode = 'agent' | 'plan' | 'ask';
export type ApprovalMode = 'ask' | 'auto-edits' | 'chill';
export type Effort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Lang = 'pl' | 'en';

export interface ModelRef {
  provider: ProviderId;
  model: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderId;
  contextWindow?: number;
  maxOutput?: number;
  vision?: boolean;
  tools?: boolean;
  reasoning?: boolean;
  free?: boolean;
  pricing?: { input: number; output: number }; // USD per 1M tokens
  description?: string;
  adaptiveThinking?: boolean;
  effort?: boolean;
}

export interface ProviderPublicState {
  id: ProviderId;
  enabled: boolean;
  hasKey: boolean;
  keyPreview?: string;
  accountId?: string;
  baseUrl?: string;
  models: ModelInfo[];
  modelsFetchedAt?: number;
  lastError?: string;
  available?: boolean; // for local servers (ollama / lmstudio)
}

export interface Settings {
  version: number;
  language: Lang;
  theme: 'dark' | 'light';
  onboarded: boolean;
  profile: {
    useCases: string[];
    experience: 'beginner' | 'intermediate' | 'pro';
  };
  activeModel: ModelRef;
  recentModels: ModelRef[];
  local: {
    tier: LocalTierId;
    backend: 'auto' | 'cuda' | 'vulkan' | 'cpu';
    contextSize: number; // 0 = auto
    gpuLayers: number; // -1 = auto
    threads: number; // 0 = auto
    thinking: boolean;
    vision: boolean;
    modelsDir: string;
    idleUnloadMinutes: number; // 0 = never
    /** real generation speed measured while the agent worked (per tier, per hardware) */
    measured?: Partial<Record<LocalTierId, MeasuredSpeed>>;
  };
  agent: {
    approval: ApprovalMode;
    defaultMode: AgentMode;
    maxSteps: number;
    autoCompact: boolean;
    effort: Effort;
    followAgent: boolean;
    showBrowser: boolean;
    allowDesktop: boolean;
    notifyOnDone: boolean;
    sound: boolean;
    commandTimeoutSec: number;
    anthropicFallback: boolean;
    autoTitle: boolean;
  };
  editor: {
    fontSize: number;
    wordWrap: boolean;
    minimap: boolean;
    tabSize: number;
    autoSave: boolean;
    ligatures: boolean;
  };
  customInstructions: string;
  ui: {
    sidebarWidth: number;
    chatWidth: number;
    panelHeight: number;
    sidebarVisible: boolean;
    panelVisible: boolean;
    chatVisible: boolean;
    sidebarView: SidebarView;
    /** hints the user closed (e.g. model advisor "high>medium") */
    dismissed?: string[];
  };
  projectsRoot: string;
}

export interface MeasuredSpeed {
  tps: number; // moving average of tokens/s while generating
  samples: number;
  at: number;
  hw: string; // hardware fingerprint the measurement belongs to
}

export type SidebarView = 'explorer' | 'search' | 'chats' | 'git';

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number;
  isDefault?: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  estimated?: boolean;
  cost?: number;
}

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface DiffLine {
  t: '+' | '-' | ' ' | '~';
  s: string;
}

export interface ToolMeta {
  kind?:
    | 'write'
    | 'edit'
    | 'delete'
    | 'move'
    | 'command'
    | 'read'
    | 'list'
    | 'search'
    | 'browser'
    | 'screenshot'
    | 'desktop'
    | 'todo'
    | 'web'
    | 'question'
    | 'install'
    | 'archive'
    | 'preview'
    | 'other';
  path?: string;
  added?: number;
  removed?: number;
  diff?: DiffLine[];
  created?: boolean;
  exitCode?: number | null;
  durationMs?: number;
  lines?: number;
  url?: string;
  processId?: string;
  background?: boolean;
  count?: number;
  outsideProject?: boolean;
}

export interface ToolResult {
  text: string;
  images?: { blobId: string; mime: string }[];
  isError?: boolean;
  meta?: ToolMeta;
}

export type ToolStatus =
  | 'streaming'
  | 'pending'
  | 'awaiting-approval'
  | 'awaiting-answer'
  | 'running'
  | 'done'
  | 'error'
  | 'denied'
  | 'cancelled';

export type AttachmentKind = 'text' | 'image' | 'archive' | 'document' | 'binary';

export type Block =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; done?: boolean }
  | { type: 'image'; blobId: string; mime: string; name?: string }
  | {
      type: 'attachment';
      name: string;
      size: number;
      kind: AttachmentKind;
      summary: string;
      savedPath?: string;
      modelText: string;
      images?: { blobId: string; mime: string }[];
    }
  | {
      type: 'tool';
      id: string;
      name: string;
      input: any;
      inputText?: string;
      status: ToolStatus;
      result?: ToolResult;
      live?: string;
      startedAt?: number;
      endedAt?: number;
      question?: { question: string; options?: string[] };
    }
  | { type: 'error'; text: string; code?: string }
  | { type: 'notice'; text: string; level?: 'info' | 'warn' | 'compact' };

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  blocks: Block[];
  createdAt: number;
  model?: ModelRef;
  usage?: TokenUsage;
  durationMs?: number;
  tokensPerSec?: number;
  mode?: AgentMode;
  hidden?: string; // extra text sent to the model only (mode reminders etc.)
  autoContinue?: boolean; // reply had no answer/tool call; Lunarix nudged the model to continue
  raw?: { provider: 'anthropic' | 'text'; content: any[] };
  status?: 'streaming' | 'done' | 'error' | 'stopped';
  turnId?: string; // user message id this assistant message belongs to
}

export interface ChatMeta {
  id: string;
  projectId: string;
  title: string;
  titleLocked: boolean;
  createdAt: number;
  updatedAt: number;
  model: ModelRef;
  mode: AgentMode;
  usage: TokenUsage;
  messageCount: number;
  running?: boolean;
  contextTokens?: number;
}

export interface Chat extends ChatMeta {
  messages: Message[];
  systemPrompt?: string;
  todos?: Todo[];
  compactAt?: number; // index of first message kept after compaction
  summary?: string;
  stripThinkingBefore?: number;
  compat?: boolean; // use the text tool protocol for this chat
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export interface FileContent {
  path: string;
  content: string;
  size: number;
  binary: boolean;
  image: boolean;
  tooLarge: boolean;
  eol: 'lf' | 'crlf';
  mtime: number;
}

export interface SearchMatch {
  path: string;
  line: number;
  col: number;
  text: string;
}

export interface GpuInfo {
  name: string;
  vendor: 'nvidia' | 'amd' | 'intel' | 'other';
  vramGB: number;
  dedicated: boolean;
  driver?: string;
}

export interface HardwareInfo {
  cpu: { model: string; cores: number; threads: number };
  ramGB: number;
  freeRamGB: number;
  gpus: GpuInfo[];
  bestGpu?: GpuInfo;
  cudaVersion?: string;
  diskFreeGB: number;
  os: string;
  recommended: LocalTierId;
  ratings: Record<LocalTierId, TierRating>;
  fingerprint?: string;
}

export interface TierRating {
  rating: 'great' | 'good' | 'slow' | 'unsupported';
  gpuOffload: 'full' | 'partial' | 'none';
  speed: string; // e.g. "~30 tok/s" (estimate) or "4.6 tok/s · zmierzone" (measured)
  tps?: number;
  measured?: boolean;
}

export interface EngineStatus {
  state: 'not-installed' | 'installing' | 'stopped' | 'starting' | 'ready' | 'error';
  backend?: 'cuda' | 'vulkan' | 'cpu';
  version?: string;
  tier?: LocalTierId;
  port?: number;
  message?: string;
  error?: string;
  contextSize?: number;
  vision?: boolean;
}

export interface LocalModelState {
  tier: LocalTierId;
  downloaded: boolean;
  visionDownloaded: boolean;
  sizeBytes: number;
  path?: string;
  downloading?: boolean;
}

export interface DownloadProgress {
  id: string;
  label: string;
  received: number;
  total: number;
  speed: number; // bytes/s
  eta: number; // seconds
  state: 'running' | 'done' | 'error' | 'cancelled';
  error?: string;
  verifying?: boolean; // checking the SHA-256 of the finished file
}

export interface UsageDay {
  date: string;
  models: Record<string, UsageCell>;
}

export interface UsageCell {
  provider: ProviderId;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  cost: number;
  estimated: boolean;
}

export interface UsageSummary {
  days: UsageDay[];
  today: { input: number; output: number; cost: number; requests: number };
  week: { input: number; output: number; cost: number; requests: number };
  month: { input: number; output: number; cost: number; requests: number };
  allTime: { input: number; output: number; cost: number; requests: number };
}

export interface ToolchainItem {
  id: string;
  name: string;
  installed: boolean;
  version?: string;
  source?: 'system' | 'lunarix';
  path?: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  isPackaged: boolean;
  locale: string;
  userData: string;
  homeDir: string;
  documentsDir: string;
  electron: string;
  testMode: boolean;
}

/** Forced app update, driven by the latest GitHub release (see src/main/updater.ts). */
export interface UpdateInfo {
  state: 'none' | 'required' | 'downloading' | 'installing' | 'error';
  current: string;
  latest?: string;
  title?: string;
  notes?: string;
  pageUrl?: string;
  size?: number;
  publishedAt?: string;
  received?: number;
  speed?: number;
  verifying?: boolean;
  error?: string;
}

export interface SendMessageInput {
  text: string;
  attachments?: AttachmentInput[];
  mode?: AgentMode;
  model?: ModelRef;
}

export type AttachmentInput =
  | { kind: 'path'; path: string }
  | { kind: 'data'; name: string; mime: string; data: string };

export interface TurnChange {
  path: string;
  before: string | null;
  after: string | null;
  binary?: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  gitAvailable: boolean;
  branch?: string;
  files: { path: string; status: string }[];
  ahead?: number;
  behind?: number;
}

export interface AppEvent {
  type: string;
  payload: any;
}

export interface InlineEditRequest {
  filePath: string;
  language: string;
  code: string;
  before: string;
  after: string;
  instruction: string;
}
