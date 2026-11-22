import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { LunarixApi } from '@shared/api';
import type { LocalTierId, ModelInfo, ModelRef, ProviderId, Settings } from '@shared/types';
import { LOCAL_TIERS } from '@shared/catalog';
import { paths } from './paths';
import { settings, updateSettings, publicProviders, setProviderConfig, getApiKey } from './settings';
import { emit, log, toast } from './events';
import * as store from './store';
import * as fsx from './fsService';
import { previewUrl } from './preview';
import * as term from './terminal';
import * as agent from './agent/agent';
import { restoreFrom, changesFor } from './agent/checkpoints';
import { fetchProviderModels } from './providers/models';
import * as engine from './engine/llama';
import { detectHardware } from './engine/hardware';
import { cancelDownload, listDownloads } from './download';
import { usageSummary, resetUsage } from './usage';
import { detectToolchain, safeInstall } from './toolchain';
import * as git from './git';
import * as updater from './updater';
import { showNotification } from './brand';
import { errMsg } from './util';

function senderWindow(e: Electron.IpcMainInvokeEvent) {
  return BrowserWindow.fromWebContents(e.sender);
}

let currentEvent: Electron.IpcMainInvokeEvent | null = null;

function pushRecent(ref: ModelRef) {
  const s = settings();
  const list = [ref, ...s.recentModels.filter((r) => !(r.provider === ref.provider && r.model === ref.model))].slice(0, 8);
  updateSettings({ recentModels: list } as Partial<Settings>);
}

const api: LunarixApi = {
  // ------------------------------------------------------------------ app
  async appInfo() {
    return {
      version: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      locale: app.getLocale(),
      userData: paths.userData,
      homeDir: app.getPath('home'),
      documentsDir: paths.documents,
      electron: process.versions.electron,
      testMode: !!process.env.LUNARIX_TEST
    };
  },
  async updateState() {
    return updater.updateState();
  },
  async checkUpdate() {
    return updater.checkForUpdate();
  },
  async installUpdate() {
    await updater.installUpdate();
  },
  async quitApp() {
    setTimeout(() => app.quit(), 50);
  },
  async windowControl(action) {
    const w = currentEvent ? senderWindow(currentEvent) : BrowserWindow.getFocusedWindow();
    if (!w) return false;
    if (action === 'minimize') w.minimize();
    else if (action === 'maximize') {
      if (w.isMaximized()) w.unmaximize();
      else w.maximize();
    } else if (action === 'close') w.close();
    else if (action === 'devtools') w.webContents.toggleDevTools();
    else if (action === 'reload') w.webContents.reload();
    return w.isMaximized();
  },
  async isMaximized() {
    const w = currentEvent ? senderWindow(currentEvent) : null;
    return !!w?.isMaximized();
  },
  async openExternal(url) {
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) await shell.openExternal(url);
  },
  async showInFolder(p) {
    shell.showItemInFolder(p);
  },
  async openPath(p) {
    return shell.openPath(p);
  },
  async selectFolder(title) {
    const w = currentEvent ? senderWindow(currentEvent) : undefined;
    const r = await dialog.showOpenDialog(w!, { title: title || 'Lunarix', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0] || null;
  },
  async selectFiles() {
    const w = currentEvent ? senderWindow(currentEvent) : undefined;
    const r = await dialog.showOpenDialog(w!, { title: 'Lunarix', properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  },
  async notify(title, body) {
    showNotification({ title, body });
  },
  async hardware(force) {
    return detectHardware(!!force);
  },
  async clipboardWrite(text) {
    clipboard.writeText(text);
  },

  // ------------------------------------------------------------- settings
  async getSettings() {
    return settings();
  },
  async updateSettings(patch) {
    const before = settings().activeModel;
    const s = updateSettings(patch);
    if (patch.activeModel && (before.provider !== s.activeModel.provider || before.model !== s.activeModel.model)) pushRecent(s.activeModel);
    if (patch.theme) {
      for (const w of BrowserWindow.getAllWindows()) if ((w as any).__lunarixMain) w.setBackgroundColor(s.theme === 'light' ? '#ffffff' : '#0a0a0a');
    }
    return settings();
  },
  async resetApp() {
    updateSettings({ onboarded: false });
  },

  // ------------------------------------------------------------ providers
  async getProviders() {
    return publicProviders();
  },
  async setProvider(id, patch) {
    setProviderConfig(id, patch);
    if ((patch.apiKey && patch.apiKey.trim()) || patch.accountId || patch.baseUrl) {
      fetchProviderModels(id)
        .then((models) => {
          emit('providers', publicProviders());
          toast(settings().language === 'pl' ? `${id}: pobrano ${models.length} modeli` : `${id}: fetched ${models.length} models`, 'success');
        })
        .catch((e) => {
          emit('providers', publicProviders());
          toast(`${id}: ${errMsg(e)}`, 'error');
        });
    }
    return publicProviders();
  },
  async fetchModels(id) {
    try {
      return await fetchProviderModels(id);
    } finally {
      emit('providers', publicProviders());
    }
  },
  async listAllModels() {
    const out: ModelInfo[] = LOCAL_TIERS.map((t) => ({ id: t.id, name: `Lunarix ${t.name}`, provider: 'local', description: `${t.model} · ${t.params}`, vision: true, tools: true, contextWindow: t.defaultContext, free: true }));
    for (const p of publicProviders()) {
      if (!p.enabled) continue;
      const usable = p.hasKey || p.id === 'ollama' || p.id === 'lmstudio' || p.id === 'custom' || p.id === 'openrouter';
      if (!usable) continue;
      if ((p.id === 'ollama' || p.id === 'lmstudio' || p.id === 'custom') && !p.modelsFetchedAt) continue;
      if (p.id === 'openrouter' && !p.hasKey) continue;
      out.push(...p.models);
    }
    if (process.env.LUNARIX_MOCK) out.push({ id: 'mock', name: 'Lunarix Test (mock)', provider: 'mock', vision: true, tools: true });
    return out;
  },

  // ------------------------------------------------------------- projects
  async listProjects() {
    return store.listProjects();
  },
  async createProject(name, parentDir) {
    return store.createProject(name, parentDir);
  },
  async openFolderAsProject(p) {
    return store.openFolderAsProject(p);
  },
  async getDefaultProject() {
    return store.getDefaultProject();
  },
  async renameProject(id, name) {
    return store.renameProject(id, name);
  },
  async removeProject(id) {
    store.removeProject(id);
  },
  async touchProject(id) {
    store.touchProject(id);
  },

  // ---------------------------------------------------------------- chats
  async listChats(projectId) {
    return store.listChats(projectId);
  },
  async getChat(id) {
    return store.getChat(id);
  },
  async createChat(projectId, opts) {
    const s = settings();
    const model = opts?.model || s.activeModel;
    const mode = (opts?.mode as any) || s.agent.defaultMode;
    return store.createChat(projectId, model, mode, s.language === 'pl' ? 'Nowy czat' : 'New chat');
  },
  async renameChat(id, title) {
    return store.renameChat(id, title, true);
  },
  async deleteChat(id) {
    agent.stopChat(id);
    store.deleteChat(id);
  },
  async setChatMode(id, mode) {
    const c = store.getChat(id);
    if (!c) throw new Error('Chat not found');
    c.mode = mode as any;
    store.saveChat(c, { touch: false });
    return store.metaOf(c);
  },
  async setChatModel(id, model) {
    const c = store.getChat(id);
    if (!c) throw new Error('Chat not found');
    c.model = model;
    store.saveChat(c, { touch: false });
    updateSettings({ activeModel: model });
    pushRecent(model);
    return store.metaOf(c);
  },
  async sendMessage(chatId, input) {
    await agent.sendMessage(chatId, input);
  },
  async stopChat(chatId) {
    agent.stopChat(chatId);
  },
  async approveTool(chatId, toolId, decision, feedback) {
    agent.approveTool(chatId, toolId, decision, feedback);
  },
  async answerTool(chatId, toolId, answer) {
    agent.answerTool(chatId, toolId, answer);
  },
  async restoreCheckpoint(chatId, messageId) {
    const chat = store.getChat(chatId);
    if (!chat) throw new Error('Chat not found');
    if (agent.isRunning(chatId)) throw new Error(settings().language === 'pl' ? 'Zatrzymaj agenta przed przywróceniem.' : 'Stop the agent before restoring.');
    const restored = await restoreFrom(chat, messageId);
    const idx = chat.messages.findIndex((m) => m.id === messageId);
    let text = '';
    if (idx >= 0) {
      const m = chat.messages[idx];
      text = m.blocks
        .filter((b) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n');
      chat.messages = chat.messages.slice(0, idx);
      if (chat.compactAt !== undefined && chat.compactAt > chat.messages.length) {
        chat.compactAt = undefined;
        chat.summary = undefined;
      }
      if (chat.stripThinkingBefore !== undefined && chat.stripThinkingBefore > chat.messages.length) chat.stripThinkingBefore = chat.messages.length;
      chat.todos = undefined;
      store.saveChat(chat);
      emit('chat:reload', { chatId });
    }
    return { restored, text };
  },
  async retryChat(chatId) {
    agent.retryChat(chatId);
  },
  async turnChanges(chatId, messageId) {
    return changesFor(chatId, messageId);
  },
  async compactChat(chatId) {
    await agent.compactChat(chatId);
  },
  async enhancePrompt(text) {
    return agent.enhancePrompt(text);
  },
  async inlineEdit(req) {
    return agent.inlineEdit(req);
  },
  async readBlob(id) {
    const d = store.readBlobBase64(id);
    return d ? `data:${store.mimeOfBlob(id)};base64,${d}` : null;
  },

  // ----------------------------------------------------------- filesystem
  async listDir(p) {
    return fsx.listDir(p);
  },
  async readFile(p) {
    return fsx.readFileContent(p);
  },
  async writeFile(p, content) {
    await fsx.writeFileContent(p, content);
  },
  async createFile(p) {
    await fsx.createFile(p);
  },
  async createDir(p) {
    await fsx.createDir(p);
  },
  async renamePath(from, to) {
    await fsx.renamePath(from, to);
  },
  async deletePath(p) {
    await fsx.deletePath(p);
  },
  async copyPath(from, to) {
    await fsx.copyPath(from, to);
  },
  async exists(p) {
    return fs.existsSync(p);
  },
  async search(root, query, opts) {
    return fsx.searchFiles(root, query, opts || {});
  },
  async findFiles(root, query) {
    return fsx.findFiles(root, query);
  },
  async watchRoot(root) {
    fsx.watchRoot(root);
  },
  async previewUrl(root, file) {
    return previewUrl(root, file);
  },

  // ------------------------------------------------------------- terminal
  async terminalCreate(cwd, cols, rows) {
    return term.createTerminal(cwd, cols, rows);
  },
  async terminalWrite(id, data) {
    term.writeTerminal(id, data);
  },
  async terminalResize(id, cols, rows) {
    term.resizeTerminal(id, cols, rows);
  },
  async terminalKill(id) {
    term.killTerminal(id);
  },

  // ---------------------------------------------------------------- engine
  async engineStatus() {
    return engine.engineStatus();
  },
  async localModels() {
    return engine.localModels();
  },
  async downloadTier(tier) {
    engine
      .downloadTier(tier as LocalTierId)
      .then(() => toast(settings().language === 'pl' ? `Model Lunarix ${tier} pobrany ✓` : `Lunarix ${tier} downloaded ✓`, 'success'))
      .catch((e) => {
        if (!/cancel/i.test(errMsg(e))) toast(errMsg(e), 'error');
        emit('local:models', engine.localModels());
      });
    setTimeout(() => emit('local:models', engine.localModels()), 300);
  },
  async switchTier(tier, chatId) {
    return engine.switchTier(tier as LocalTierId, chatId);
  },
  async cancelDownload(id) {
    cancelDownload(id);
  },
  async deleteTier(tier) {
    await engine.deleteTier(tier as LocalTierId);
  },
  async startEngine(tier) {
    try {
      await engine.ensureEngine(tier as LocalTierId | undefined);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
    return engine.engineStatus();
  },
  async stopEngine() {
    await engine.stopEngine();
  },
  async engineLogs() {
    return engine.engineLogs();
  },
  async downloads() {
    return listDownloads();
  },

  // ----------------------------------------------------------------- usage
  async usage() {
    return usageSummary();
  },
  async resetUsage() {
    resetUsage();
  },

  // ------------------------------------------------------------- toolchain
  async toolchain(force) {
    return detectToolchain(!!force);
  },
  async installTool(id) {
    const r = await safeInstall(id, (s) => emit('toolchain:log', { id, text: s }));
    emit('toolchain', await detectToolchain(true));
    return r;
  },

  // ---------------------------------------------------------------------- git
  async gitStatus(root) {
    return git.gitStatus(root);
  },
  async gitDiff(root, p) {
    return git.gitDiff(root, p);
  },
  async gitCommit(root, message) {
    return git.gitCommit(root, message);
  },
  async gitInit(root) {
    return git.gitInit(root);
  },
  async gitCommitMessage(root) {
    return git.gitCommitMessage(root);
  }
};

export function registerIpc() {
  ipcMain.handle('lx', async (e, method: string, ...args: any[]) => {
    const fn = (api as any)[method];
    if (typeof fn !== 'function') throw new Error(`Unknown API method: ${method}`);
    currentEvent = e;
    try {
      return await fn(...args);
    } catch (err) {
      log('ipc error', method, err);
      throw new Error(errMsg(err));
    } finally {
      currentEvent = null;
    }
  });
}

export { getApiKey };
export type { ProviderId };
