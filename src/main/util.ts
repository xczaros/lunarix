import { spawn, execFile, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const isWin = process.platform === 'win32';

export function uid(prefix = ''): string {
  return prefix + randomUUID().replace(/-/g, '').slice(0, 16);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number) {
  let t: NodeJS.Timeout | null = null;
  const d = (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
  d.flush = (...args: Parameters<T>) => {
    if (t) clearTimeout(t);
    t = null;
    fn(...args);
  };
  return d as T & { flush: (...a: Parameters<T>) => void };
}

export function throttle<T extends (...a: any[]) => void>(fn: T, ms: number) {
  let last = 0;
  let timer: NodeJS.Timeout | null = null;
  let pending: Parameters<T> | null = null;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    pending = args;
    if (now - last >= ms) {
      last = now;
      pending = null;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        if (pending) {
          const p = pending;
          pending = null;
          fn(...p);
        }
      }, ms - (now - last));
    }
  };
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    // try backup
    try {
      const raw = fs.readFileSync(file + '.bak', 'utf8');
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
}

export function writeJsonAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const json = JSON.stringify(data);
  fs.writeFileSync(tmp, json, 'utf8');
  try {
    if (fs.existsSync(file)) {
      try {
        fs.copyFileSync(file, file + '.bak');
      } catch {
        /* ignore */
      }
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.writeFileSync(file, json, 'utf8');
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

export class JsonStore<T extends object> {
  data: T;
  private saveLater: ReturnType<typeof debounce>;
  constructor(public file: string, defaults: T, migrate?: (d: any) => T) {
    const loaded = readJson<any>(file, null);
    this.data = loaded ? (migrate ? migrate(loaded) : deepMerge(structuredClone(defaults), loaded)) : structuredClone(defaults);
    this.saveLater = debounce(() => writeJsonAtomic(this.file, this.data), 400);
  }
  save() {
    this.saveLater();
  }
  flush() {
    this.saveLater.flush();
  }
}

export function deepMerge<T>(base: T, patch: any): T {
  if (patch === undefined || patch === null) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;
  const out: any = { ...base };
  for (const k of Object.keys(patch)) {
    const bv = (base as any)[k];
    const pv = patch[k];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && pv && typeof pv === 'object' && !Array.isArray(pv)) {
      out[k] = deepMerge(bv, pv);
    } else if (pv !== undefined) {
      out[k] = pv;
    }
  }
  return out;
}

const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;
export function stripAnsi(s: string) {
  return s.replace(ANSI_RE, '').replace(/\r(?!\n)/g, '\n');
}

export function tailText(s: string, max: number) {
  if (s.length <= max) return s;
  const cut = s.slice(s.length - max);
  const nl = cut.indexOf('\n');
  return `…[${(s.length - max).toLocaleString()} znaków pominięto]…\n` + (nl > 0 && nl < 500 ? cut.slice(nl + 1) : cut);
}

export function headText(s: string, max: number) {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[obcięto ${(s.length - max).toLocaleString()} znaków]`;
}

export function estimateTokens(text: string) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.6);
}

export function formatBytes(n: number) {
  if (!isFinite(n) || n < 0) return '?';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}

/** Parses JSON that may be truncated / slightly malformed (used for streamed tool arguments). */
export function parseJsonLoose(text: string): any {
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    /* fallthrough */
  }
  // attempt repair: close strings / brackets
  let s = text.trim();
  let inStr = false;
  let esc = false;
  const stack: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  if (inStr) s += '"';
  s = s.replace(/,\s*$/, '');
  while (stack.length) s += stack.pop();
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function isSubPath(parent: string, child: string) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function toPosix(p: string) {
  return p.replace(/\\/g, '/');
}

/** Find an executable on PATH (Windows aware). */
export function which(cmd: string, extraDirs: string[] = []): string | null {
  const exts = isWin ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase()) : [''];
  const dirs = [...extraDirs, ...(process.env.PATH || process.env.Path || '').split(path.delimiter)].filter(Boolean);
  for (const d of dirs) {
    for (const e of path.extname(cmd) ? [''] : exts) {
      const full = path.join(d, cmd + e);
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

export interface CaptureResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runCapture(cmd: string, args: string[], opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv; input?: string } = {}): Promise<CaptureResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env || process.env, windowsHide: true });
    } catch (e: any) {
      resolve({ code: -1, stdout: '', stderr: String(e?.message || e), timedOut: false });
      return;
    }
    const timer = opts.timeout
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, opts.timeout)
      : null;
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      stderr += String(e?.message || e);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.input) {
      child.stdin?.write(opts.input);
    }
    child.stdin?.end();
  });
}

export function encodePowerShell(script: string) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export const POWERSHELL = isWin ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'pwsh';

export async function powershell(script: string, timeout = 30000): Promise<CaptureResult> {
  const prelude = "$ErrorActionPreference='SilentlyContinue';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;";
  return runCapture(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(prelude + script)], { timeout });
}

export function killTree(pid?: number) {
  if (!pid) return;
  if (isWin) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }
}

export async function pathExists(p: string) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirSize(p);
      else {
        try {
          total += (await fsp.stat(p)).size;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return total;
}

export function safeFileName(name: string) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+$/g, '').slice(0, 120) || 'plik';
}

export function spawnDetached(cmd: string, args: string[], opts: SpawnOptions = {}) {
  const c = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
  c.unref();
  return c;
}

export function errMsg(e: any): string {
  if (!e) return 'Unknown error';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}
