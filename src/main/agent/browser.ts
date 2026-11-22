import { BrowserWindow, app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { saveBlob } from '../store';
import { previewUrl } from '../preview';
import { paths } from '../paths';
import { sleep } from '../util';
import { brandWindow } from '../brand';

const VIEW = { width: 1280, height: 800 };
let win: BrowserWindow | null = null;
let mode: 'visible' | 'offscreen' | null = null;
let consoleLines: string[] = [];
let lastError = '';

function short(src: string) {
  try {
    const u = new URL(src);
    return u.pathname.split('/').pop() || u.host;
  } catch {
    return src.split(/[\\/]/).pop() || src;
  }
}

function push(line: string) {
  consoleLines.push(line.length > 600 ? line.slice(0, 600) + '…' : line);
  if (consoleLines.length > 200) consoleLines = consoleLines.slice(-150);
}

function iconPath() {
  const p = paths.appIcon;
  return fs.existsSync(p) ? p : undefined;
}

function ensureWindow(show: boolean): BrowserWindow {
  const wanted = show ? 'visible' : 'offscreen';
  if (win && !win.isDestroyed() && mode === wanted) return win;
  if (win && !win.isDestroyed()) win.destroy();
  const w = new BrowserWindow({
    width: VIEW.width,
    height: VIEW.height,
    useContentSize: true,
    show: false,
    title: 'Lunarix Browser',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    icon: iconPath(),
    webPreferences: {
      partition: 'persist:lunarix-browser',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: !show,
      backgroundThrottling: false
    }
  });
  win = w;
  mode = wanted;
  brandWindow(w);
  if (show) w.showInactive();
  w.webContents.on('console-message', (e: any) => {
    const raw = e?.level;
    const lvl = typeof raw === 'number' ? ['log', 'warn', 'error', 'debug'][raw] || 'log' : raw === 'warning' ? 'warn' : raw || 'log';
    const msg = String(e?.message ?? '');
    if (/Electron Security Warning|electronjs\.org\/docs\/tutorial\/security/i.test(msg)) return;
    const ln = e?.lineNumber;
    const src = e?.sourceId;
    push(`[${lvl}] ${msg}${src ? ` (${short(src)}:${ln})` : ''}`);
  });
  w.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain && code !== -3) {
      lastError = `Load failed (${code} ${desc}) for ${url}`;
      push(`[error] ${lastError}`);
    }
  });
  w.webContents.on('render-process-gone', (_e, d) => push(`[error] renderer crashed: ${d.reason}`));
  w.webContents.setWindowOpenHandler(({ url }) => {
    w.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  w.on('closed', () => {
    if (win === w) {
      win = null;
      mode = null;
    }
  });
  return w;
}

async function capture(w: BrowserWindow): Promise<{ blobId: string; width: number; height: number }> {
  await sleep(120);
  let img = await w.webContents.capturePage();
  const size = img.getSize();
  if (size.width > VIEW.width) img = img.resize({ width: VIEW.width, quality: 'good' });
  const png = img.toPNG();
  const s = img.getSize();
  return { blobId: saveBlob(png, 'image/png'), width: s.width, height: s.height };
}

async function waitIdle(w: BrowserWindow, ms = 700) {
  await sleep(ms);
  try {
    await w.webContents.executeJavaScript('new Promise(r => (document.readyState === "complete" ? r(1) : window.addEventListener("load", () => r(1), { once: true })))', true);
  } catch {
    /* ignore */
  }
}

const KEYMAP: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  tab: 'Tab',
  esc: 'Escape',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  up: 'Up',
  arrowup: 'Up',
  down: 'Down',
  arrowdown: 'Down',
  left: 'Left',
  arrowleft: 'Left',
  right: 'Right',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown'
};

export interface BrowserInput {
  action: 'open' | 'click' | 'type' | 'key' | 'scroll' | 'screenshot' | 'evaluate' | 'close' | 'back' | 'reload';
  url?: string;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
  script?: string;
}

export async function browserAction(input: BrowserInput, projectRoot: string, show: boolean) {
  const action = input.action || 'screenshot';
  if (action === 'close') {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    return { text: 'Browser closed.', image: undefined as any };
  }
  const w = ensureWindow(show);
  const before = consoleLines.length;
  lastError = '';
  let extra = '';
  if (action === 'open') {
    let url = (input.url || '').trim();
    if (!url) throw new Error('url is required for action=open');
    if (!/^[a-z]+:\/\//i.test(url)) {
      const abs = path.isAbsolute(url) ? url : path.resolve(projectRoot, url);
      if (fs.existsSync(abs) && (abs.toLowerCase().startsWith(projectRoot.toLowerCase()) || fs.statSync(abs).isFile())) {
        const root = abs.toLowerCase().startsWith(projectRoot.toLowerCase()) ? projectRoot : path.dirname(abs);
        url = await previewUrl(root, path.relative(root, abs));
      } else if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?/i.test(url)) url = 'http://' + url;
      else url = 'https://' + url;
    }
    try {
      await w.loadURL(url);
    } catch (e: any) {
      if (!lastError) lastError = String(e?.message || e);
    }
    await waitIdle(w, 900);
  } else if (action === 'click') {
    const x = Math.round(input.x ?? 0);
    const y = Math.round(input.y ?? 0);
    w.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    w.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    w.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await waitIdle(w, 700);
  } else if (action === 'type') {
    await w.webContents.insertText(input.text || '');
    await sleep(400);
  } else if (action === 'key') {
    const raw = (input.key || 'Enter').trim();
    const parts = raw.split('+').map((p) => p.trim());
    const mods = parts.slice(0, -1).map((m) => m.toLowerCase()).map((m) => (m === 'ctrl' ? 'control' : m === 'cmd' || m === 'win' ? 'meta' : m)) as any[];
    const k = parts[parts.length - 1];
    const code = KEYMAP[k.toLowerCase()] || (k.length === 1 ? k : k);
    w.webContents.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: mods });
    if (code.length === 1 && !mods.length) w.webContents.sendInputEvent({ type: 'char', keyCode: code });
    w.webContents.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: mods });
    await waitIdle(w, 600);
  } else if (action === 'scroll') {
    const dy = (input.direction === 'up' ? -1 : 1) * Math.round(input.amount || 600);
    await w.webContents.executeJavaScript(`window.scrollBy({top:${dy},behavior:'instant'})`, true).catch(() => {});
    await sleep(400);
  } else if (action === 'back') {
    if (w.webContents.navigationHistory?.canGoBack()) w.webContents.navigationHistory.goBack();
    await waitIdle(w, 900);
  } else if (action === 'reload') {
    w.webContents.reload();
    await waitIdle(w, 900);
  } else if (action === 'evaluate') {
    try {
      const r = await w.webContents.executeJavaScript(String(input.script || 'document.title'), true);
      let s: string;
      try {
        s = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
      } catch {
        s = String(r);
      }
      extra = `\nEvaluate result:\n${(s ?? 'undefined').slice(0, 8000)}`;
    } catch (e: any) {
      extra = `\nEvaluate error: ${e?.message || e}`;
    }
  }
  const shot = await capture(w);
  const newLogs = consoleLines.slice(before);
  const url = w.webContents.getURL();
  const title = w.webContents.getTitle();
  const errors = newLogs.filter((l) => l.startsWith('[error]')).length;
  const text =
    `Browser ${action} done. URL: ${url}\nTitle: ${title}\nViewport: ${shot.width}x${shot.height} (click coordinates use this screenshot's pixels)` +
    (lastError ? `\nLOAD ERROR: ${lastError}` : '') +
    `\nConsole (${newLogs.length} new, ${errors} errors):\n${newLogs.slice(-40).join('\n') || '(empty)'}` +
    extra;
  return { text, image: { blobId: shot.blobId, mime: 'image/png' } };
}

export function closeBrowser() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

app.on('before-quit', closeBrowser);
