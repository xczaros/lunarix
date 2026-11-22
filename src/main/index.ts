import { app, BrowserWindow, ipcMain, Menu, net, protocol, screen, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Test / portable data directory must be set before anything touches app paths.
if (process.env.LUNARIX_DATA_DIR) {
  app.setPath('userData', path.join(process.env.LUNARIX_DATA_DIR, 'userdata'));
}

import { paths } from './paths';
import { initLog, log, emit } from './events';
import { settings, flushSettings, initSecrets } from './settings';
import { flushProjects, blobPath, mimeOfBlob } from './store';
import { registerIpc } from './ipc';
import { killAllTerminals } from './terminal';
import { killAllProcesses } from './processes';
import { stopEngine } from './engine/llama';
import { stopPreviewServers } from './preview';
import { unwatchAll } from './fsService';
import { stopAll } from './agent/agent';
import { stopDesktopHelper } from './agent/desktop';
import { flushUsage } from './usage';
import { readJson, writeJsonAtomic } from './util';
import { AUMID, appIconImage, brandWindow, registerNotificationIdentity } from './brand';
import { startUpdateChecks } from './updater';

app.setAppUserModelId(AUMID);
// The agent test browser loads arbitrary local dev pages; Electron's dev-only CSP warnings would pollute its console logs.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }
]);

let mainWindow: BrowserWindow | null = null;

if (!app.requestSingleInstanceLock() && !process.env.LUNARIX_TEST) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

const CSP = [
  "default-src 'self' app:",
  "script-src 'self' app: 'wasm-unsafe-eval'",
  "style-src 'self' app: 'unsafe-inline'",
  "img-src 'self' app: data: blob:",
  "font-src 'self' app: data:",
  "connect-src 'self' app:",
  "media-src 'self' app: data: blob:",
  'frame-src http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*',
  "worker-src 'self' app: blob:",
  "object-src 'none'",
  "base-uri 'self'"
].join('; ');

function registerProtocol() {
  protocol.handle('app', async (req) => {
    try {
      return await serveApp(req);
    } catch (e) {
      log('protocol error', req.url, String(e));
      return new Response('Not found', { status: 404 });
    }
  });
}

async function serveApp(req: Request): Promise<Response> {
  {
    const url = new URL(req.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith('/blob/')) {
      const id = path.basename(pathname.slice(6));
      const file = blobPath(id);
      if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
      const res = await net.fetch(pathToFileURL(file).toString());
      return new Response(res.body, { headers: { 'Content-Type': mimeOfBlob(id), 'Cache-Control': 'max-age=31536000' } });
    }
    if (pathname.startsWith('/local/')) {
      // local image preview for the editor (images only)
      const file = pathname.slice(7);
      const ext = path.extname(file).toLowerCase();
      const imgTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.avif': 'image/avif' };
      if (!imgTypes[ext] || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
      const res = await net.fetch(pathToFileURL(file).toString());
      return new Response(res.body, { headers: { 'Content-Type': imgTypes[ext], 'Cache-Control': 'no-store' } });
    }
    if (pathname === '/' || pathname === '') pathname = '/index.html';
    const root = paths.renderer;
    const file = path.normalize(path.join(root, pathname));
    if (!file.startsWith(path.normalize(root))) return new Response('Forbidden', { status: 403 });
    if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    const ext = path.extname(file).toLowerCase();
    const types: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };
    if (types[ext]) headers.set('Content-Type', types[ext]);
    if (ext === '.html') headers.set('Content-Security-Policy', CSP);
    return new Response(res.body, { status: 200, headers });
  }
}

interface WinState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

function loadWinState(): WinState {
  const st = readJson<WinState>(path.join(paths.data, 'window.json'), { width: 1440, height: 900, maximized: false });
  const area = screen.getPrimaryDisplay().workAreaSize;
  st.width = Math.min(Math.max(st.width || 1440, 980), area.width);
  st.height = Math.min(Math.max(st.height || 900, 620), area.height);
  if (st.x !== undefined && st.y !== undefined) {
    const visible = screen.getAllDisplays().some((d) => st.x! >= d.bounds.x - 50 && st.y! >= d.bounds.y - 50 && st.x! < d.bounds.x + d.bounds.width - 100 && st.y! < d.bounds.y + d.bounds.height - 100);
    if (!visible) {
      delete st.x;
      delete st.y;
    }
  }
  return st;
}

function saveWinState(w: BrowserWindow) {
  try {
    const b = w.getNormalBounds();
    writeJsonAtomic(path.join(paths.data, 'window.json'), { x: b.x, y: b.y, width: b.width, height: b.height, maximized: w.isMaximized() });
  } catch {
    /* ignore */
  }
}

function themeColors() {
  const light = settings().theme === 'light';
  return { bg: light ? '#ffffff' : '#0a0a0a', fg: light ? '#111111' : '#e8e8e8', bar: light ? '#f6f6f6' : '#0d0d0d' };
}

function createWindow() {
  const st = loadWinState();
  const c = themeColors();
  const isTest = !!process.env.LUNARIX_TEST;
  const win = new BrowserWindow({
    x: st.x,
    y: st.y,
    width: isTest ? 1440 : st.width,
    height: isTest ? 900 : st.height,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: c.bg,
    title: 'Lunarix',
    icon: appIconImage(),
    // automated test windows stay off the user's taskbar
    skipTaskbar: isTest && !process.env.LUNARIX_TEST_TASKBAR,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: c.bar, symbolColor: c.fg, height: 38 },
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: false,
      additionalArguments: isTest ? ['--lunarix-test'] : []
    }
  });
  (win as any).__lunarixMain = true;
  mainWindow = win;
  brandWindow(win);
  win.once('ready-to-show', () => {
    if (st.maximized && !isTest) win.maximize();
    if (isTest) win.showInactive();
    else if (!process.env.LUNARIX_HIDDEN) win.show();
  });
  win.on('maximize', () => emit('window:state', { maximized: true }));
  win.on('unmaximize', () => emit('window:state', { maximized: false }));
  win.on('focus', () => win.flashFrame(false));
  win.on('close', () => saveWinState(win));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => log('renderer gone', d));
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) win.webContents.toggleDevTools();
  });
  win.loadURL('app://lunarix/index.html');
  if (process.env.LUNARIX_TEST_SCRIPT) runTestScript(win);
  return win;
}

export function updateTitleBarTheme() {
  const c = themeColors();
  for (const w of BrowserWindow.getAllWindows()) {
    if ((w as any).__lunarixMain) {
      try {
        w.setTitleBarOverlay({ color: c.bar, symbolColor: c.fg, height: 38 });
      } catch {
        /* not supported */
      }
    }
  }
}

function runTestScript(win: BrowserWindow) {
  const outDir = process.env.LUNARIX_TEST_OUT || path.join(paths.userData, 'test-shots');
  fs.mkdirSync(outDir, { recursive: true });
  ipcMain.handle('lx:test-capture', async (_e, name: string) => {
    const img = await win.webContents.capturePage();
    const file = path.join(outDir, `${String(name).replace(/[^\w.-]/g, '_')}.png`);
    fs.writeFileSync(file, img.toPNG());
    return file;
  });
  ipcMain.handle('lx:test-log', (_e, msg: string) => {
    fs.appendFileSync(path.join(outDir, 'test-log.txt'), `[${new Date().toISOString()}] ${msg}\n`);
  });
  ipcMain.handle('lx:test-quit', () => {
    setTimeout(() => app.quit(), 200);
  });
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      const script = fs.readFileSync(process.env.LUNARIX_TEST_SCRIPT!, 'utf8');
      win.webContents.executeJavaScript(script).catch((e) => fs.appendFileSync(path.join(outDir, 'test-log.txt'), `SCRIPT ERROR ${e}\n`));
    }, 1500);
  });
  win.webContents.on('console-message', (e: any) => {
    const msg = e?.message;
    const level = e?.level;
    if (level === 3 || level === 'error' || level === 2 || level === 'warning') fs.appendFileSync(path.join(outDir, 'console.txt'), `[${level}] ${msg}\n`);
  });
}

/**
 * Stamps our AppUserModelID on the installer's Start menu / desktop shortcuts, so the taskbar maps
 * Lunarix windows to "Lunarix" with its logo (and notifications work). Runs before the first window
 * exists; only touches shortcuts that point at this executable.
 */
function ensureShortcutAumid() {
  if (!app.isPackaged || process.platform !== 'win32' || process.env.LUNARIX_TEST) return;
  const lnks = [path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Lunarix.lnk'), path.join(app.getPath('desktop'), 'Lunarix.lnk')];
  for (const lnk of lnks) {
    try {
      if (!fs.existsSync(lnk)) continue;
      const sc = shell.readShortcutLink(lnk);
      if (!sc.target || path.resolve(sc.target).toLowerCase() !== path.resolve(process.execPath).toLowerCase()) continue;
      if (sc.appUserModelId !== AUMID) shell.writeShortcutLink(lnk, 'update', { ...sc, appUserModelId: AUMID });
    } catch (e) {
      log('shortcut aumid failed', lnk, e);
    }
  }
}

app.whenReady().then(async () => {
  initLog(paths.logs);
  log('Lunarix starting', app.getVersion(), process.versions.electron);
  ensureShortcutAumid();
  registerNotificationIdentity();
  await initSecrets().catch((e) => log('secrets init failed', e));
  registerProtocol();
  registerIpc();
  Menu.setApplicationMenu(null);
  createWindow();
  startUpdateChecks();
  ipcMain.on('lx:titlebar-theme', () => updateTitleBarTheme());
});

let quitting = false;
function cleanup() {
  if (quitting) return;
  quitting = true;
  try {
    stopAll();
    killAllTerminals();
    killAllProcesses();
    stopDesktopHelper();
    stopPreviewServers();
    unwatchAll();
    stopEngine();
    flushSettings();
    flushProjects();
    flushUsage();
  } catch (e) {
    log('cleanup error', e);
  }
}

app.on('before-quit', cleanup);
app.on('window-all-closed', () => {
  cleanup();
  app.quit();
});
process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('unhandledRejection', (e) => log('unhandledRejection', e));
