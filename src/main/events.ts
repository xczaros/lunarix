import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

type Listener = (type: string, payload: any) => void;
const listeners = new Set<Listener>();

/** Broadcast an event to every renderer window (and in-process listeners). */
export function emit(type: string, payload: any) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && (w as any).__lunarixMain) {
      try {
        w.webContents.send('lx:event', { type, payload });
      } catch {
        /* window closing */
      }
    }
  }
  for (const l of listeners) {
    try {
      l(type, payload);
    } catch {
      /* ignore */
    }
  }
}

export function onEvent(l: Listener) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function toast(text: string, level: 'info' | 'success' | 'warn' | 'error' = 'info') {
  emit('toast', { text, level });
}

let logFile: string | null = null;
export function initLog(dir: string) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'lunarix.log');
    const st = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
    if (st && st.size > 5 * 1024 * 1024) fs.renameSync(logFile, logFile + '.old');
  } catch {
    logFile = null;
  }
}

export function log(...args: any[]) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : safeStr(a))).join(' ')}\n`;
  if (process.env.LUNARIX_BUILD === 'dev' || process.env.LUNARIX_DEBUG) process.stdout.write(line);
  if (logFile) {
    try {
      fs.appendFileSync(logFile, line);
    } catch {
      /* ignore */
    }
  }
}

function safeStr(a: any) {
  if (a instanceof Error) return a.stack || a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}
