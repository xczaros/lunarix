import type {
  AppInfo,
  Chat,
  ChatMeta,
  DownloadProgress,
  EngineStatus,
  FileContent,
  FsEntry,
  GitStatus,
  HardwareInfo,
  InlineEditRequest,
  LocalModelState,
  LocalTierId,
  ModelInfo,
  ModelRef,
  Project,
  ProviderId,
  ProviderPublicState,
  SearchMatch,
  SendMessageInput,
  Settings,
  ToolchainItem,
  TurnChange,
  UpdateInfo,
  UsageSummary
} from './types';

// Every method here is implemented in the main process (src/main/ipc.ts)
// and called from the renderer through a typed proxy.
export interface LunarixApi {
  // app
  appInfo(): Promise<AppInfo>;
  updateState(): Promise<UpdateInfo>;
  checkUpdate(): Promise<UpdateInfo>;
  installUpdate(): Promise<void>;
  quitApp(): Promise<void>;
  windowControl(action: 'minimize' | 'maximize' | 'close' | 'devtools' | 'reload'): Promise<boolean>;
  isMaximized(): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  openPath(path: string): Promise<string>;
  selectFolder(title?: string): Promise<string | null>;
  selectFiles(): Promise<string[]>;
  notify(title: string, body: string): Promise<void>;
  hardware(force?: boolean): Promise<HardwareInfo>;
  clipboardWrite(text: string): Promise<void>;

  // settings
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  resetApp(): Promise<void>;

  // providers
  getProviders(): Promise<ProviderPublicState[]>;
  setProvider(id: ProviderId, patch: { apiKey?: string; accountId?: string; baseUrl?: string; enabled?: boolean }): Promise<ProviderPublicState[]>;
  fetchModels(id: ProviderId): Promise<ModelInfo[]>;
  listAllModels(): Promise<ModelInfo[]>;

  // projects
  listProjects(): Promise<Project[]>;
  createProject(name: string, parentDir?: string): Promise<Project>;
  openFolderAsProject(path: string): Promise<Project>;
  getDefaultProject(): Promise<Project>;
  renameProject(id: string, name: string): Promise<Project>;
  removeProject(id: string): Promise<void>;
  touchProject(id: string): Promise<void>;

  // chats
  listChats(projectId?: string): Promise<ChatMeta[]>;
  getChat(id: string): Promise<Chat | null>;
  createChat(projectId: string, opts?: { mode?: string; model?: ModelRef }): Promise<Chat>;
  renameChat(id: string, title: string): Promise<ChatMeta>;
  deleteChat(id: string): Promise<void>;
  setChatMode(id: string, mode: string): Promise<ChatMeta>;
  setChatModel(id: string, model: ModelRef): Promise<ChatMeta>;
  sendMessage(chatId: string, input: SendMessageInput): Promise<void>;
  stopChat(chatId: string): Promise<void>;
  approveTool(chatId: string, toolId: string, decision: 'allow' | 'always' | 'deny', feedback?: string): Promise<void>;
  answerTool(chatId: string, toolId: string, answer: string): Promise<void>;
  restoreCheckpoint(chatId: string, messageId: string): Promise<{ restored: number; text: string }>;
  retryChat(chatId: string): Promise<void>;
  turnChanges(chatId: string, messageId: string): Promise<TurnChange[]>;
  compactChat(chatId: string): Promise<void>;
  enhancePrompt(text: string, projectId?: string): Promise<string>;
  inlineEdit(req: InlineEditRequest): Promise<string>;
  readBlob(id: string): Promise<string | null>;

  // filesystem
  listDir(path: string): Promise<FsEntry[]>;
  readFile(path: string): Promise<FileContent>;
  writeFile(path: string, content: string): Promise<void>;
  createFile(path: string): Promise<void>;
  createDir(path: string): Promise<void>;
  renamePath(from: string, to: string): Promise<void>;
  deletePath(path: string): Promise<void>;
  copyPath(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  search(root: string, query: string, opts?: { regex?: boolean; caseSensitive?: boolean; include?: string }): Promise<SearchMatch[]>;
  findFiles(root: string, query: string): Promise<string[]>;
  watchRoot(root: string): Promise<void>;
  previewUrl(root: string, file?: string): Promise<string>;

  // terminal
  terminalCreate(cwd: string, cols: number, rows: number): Promise<{ id: string; pty: boolean; shell: string }>;
  terminalWrite(id: string, data: string): Promise<void>;
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  terminalKill(id: string): Promise<void>;

  // local engine
  engineStatus(): Promise<EngineStatus>;
  localModels(): Promise<LocalModelState[]>;
  downloadTier(tier: LocalTierId): Promise<void>;
  /** use a tier now (downloading it first if needed; the switch happens when the download is done) */
  switchTier(tier: LocalTierId, chatId?: string): Promise<{ switched: boolean }>;
  cancelDownload(id: string): Promise<void>;
  deleteTier(tier: LocalTierId): Promise<void>;
  startEngine(tier?: LocalTierId): Promise<EngineStatus>;
  stopEngine(): Promise<void>;
  engineLogs(): Promise<string>;
  downloads(): Promise<DownloadProgress[]>;

  // usage
  usage(): Promise<UsageSummary>;
  resetUsage(): Promise<void>;

  // toolchain
  toolchain(force?: boolean): Promise<ToolchainItem[]>;
  installTool(id: string): Promise<string>;

  // git
  gitStatus(root: string): Promise<GitStatus>;
  gitDiff(root: string, path: string): Promise<{ before: string; after: string }>;
  gitCommit(root: string, message: string): Promise<string>;
  gitInit(root: string): Promise<string>;
  gitCommitMessage(root: string): Promise<string>;
}

export type ApiMethod = keyof LunarixApi;
