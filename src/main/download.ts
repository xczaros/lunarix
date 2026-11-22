import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { DownloadProgress } from '@shared/types';
import { emit, log } from './events';
import { errMsg, runCapture, sleep } from './util';

const active = new Map<string, { ctrl: AbortController; progress: DownloadProgress }>();
const finished = new Map<string, DownloadProgress>();

export function listDownloads(): DownloadProgress[] {
  return [...[...active.values()].map((a) => a.progress), ...finished.values()];
}

export function cancelDownload(id: string) {
  const a = active.get(id);
  if (a) a.ctrl.abort();
}

export function isDownloading(id: string) {
  return active.has(id);
}

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Lunarix/1.0 Chrome/140 Safari/537.36';

/** SHA-256 of a file, streamed (multi-GB model files never sit in memory). */
export function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const rs = fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    const onAbort = () => rs.destroy(new Error('cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    rs.on('data', (c) => h.update(c));
    rs.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    rs.on('end', () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(h.digest('hex'));
    });
  });
}

/**
 * Resumable download with progress events. Writes to `${dest}.part` then renames.
 * With `sha256` the finished file is verified before it replaces `dest`.
 */
export async function downloadFile(
  id: string,
  label: string,
  url: string,
  dest: string,
  opts: { expectedSize?: number; sha256?: string; signal?: AbortSignal; quiet?: boolean; onProgress?: (p: DownloadProgress) => void } = {}
): Promise<void> {
  if (active.has(id)) throw new Error('Download already running: ' + label);
  const ctrl = new AbortController();
  if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  const progress: DownloadProgress = { id, label, received: 0, total: opts.expectedSize || 0, speed: 0, eta: 0, state: 'running' };
  active.set(id, { ctrl, progress });
  finished.delete(id);
  const publish = () => {
    if (!opts.quiet) emit('download:progress', { ...progress });
    opts.onProgress?.({ ...progress });
  };
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  let attempt = 0;
  let lastEmit = 0;
  let windowStart = Date.now();
  let windowBytes = 0;
  try {
    for (;;) {
      attempt++;
      let start = 0;
      try {
        start = (await fsp.stat(part)).size;
      } catch {
        start = 0;
      }
      if (progress.total && start >= progress.total && progress.total > 0) break;
      const headers: Record<string, string> = { 'User-Agent': UA };
      if (start > 0) headers.Range = `bytes=${start}-`;
      try {
        const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
        if (res.status === 416) {
          // already complete
          break;
        }
        if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const resumed = res.status === 206 && start > 0;
        if (!resumed && start > 0) start = 0; // server ignored range
        const len = Number(res.headers.get('content-length') || 0);
        if (len) progress.total = start + len;
        progress.received = start;
        const ws = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
        const body = Readable.fromWeb(res.body as any);
        await new Promise<void>((resolve, reject) => {
          body.on('data', (chunk: Buffer) => {
            progress.received += chunk.length;
            windowBytes += chunk.length;
            const now = Date.now();
            const dt = now - windowStart;
            if (dt >= 1000) {
              const inst = (windowBytes * 1000) / dt;
              progress.speed = progress.speed ? progress.speed * 0.6 + inst * 0.4 : inst;
              windowStart = now;
              windowBytes = 0;
            }
            if (progress.total && progress.speed) progress.eta = Math.max(0, (progress.total - progress.received) / progress.speed);
            if (now - lastEmit > 250) {
              lastEmit = now;
              publish();
            }
          });
          body.on('error', reject);
          ws.on('error', reject);
          ws.on('finish', () => resolve());
          body.pipe(ws);
        });
        if (progress.total && progress.received < progress.total) throw new Error('Connection closed early');
        break;
      } catch (e: any) {
        if (ctrl.signal.aborted) throw new Error('cancelled');
        log('download error', label, attempt, errMsg(e));
        if (attempt >= 6) throw e;
        await sleep(1000 * attempt * attempt);
      }
    }
    if (opts.sha256) {
      // a damaged model file makes the engine crash or talk nonsense — never install one
      progress.verifying = true;
      publish();
      const got = await sha256File(part, ctrl.signal);
      progress.verifying = false;
      if (got.toLowerCase() !== opts.sha256.toLowerCase()) {
        await fsp.rm(part, { force: true });
        log('checksum mismatch', label, got, opts.sha256);
        throw new Error('Pobrany plik jest uszkodzony (zła suma kontrolna) — pobierz ponownie / The downloaded file is corrupted, download again');
      }
    }
    await fsp.rm(dest, { force: true });
    await fsp.rename(part, dest);
    progress.state = 'done';
    progress.received = progress.total || progress.received;
    publish();
  } catch (e: any) {
    progress.state = ctrl.signal.aborted ? 'cancelled' : 'error';
    progress.error = errMsg(e);
    publish();
    if (ctrl.signal.aborted) await fsp.rm(part, { force: true }).catch(() => {});
    throw e;
  } finally {
    active.delete(id);
    finished.set(id, { ...progress });
    setTimeout(() => finished.delete(id), 60_000);
  }
}

/** Extract a .zip (or any archive bsdtar understands) using Windows' built-in tar.exe. */
export async function extractArchive(archive: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const r = await runCapture(tar, ['-xf', archive, '-C', destDir], { timeout: 15 * 60_000 });
  if (r.code !== 0) {
    // fallback to PowerShell Expand-Archive for zip files
    if (archive.toLowerCase().endsWith('.zip')) {
      const { powershell } = await import('./util');
      const ps = await powershell(`Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`, 15 * 60_000);
      if (ps.code === 0) return;
      throw new Error('Extract failed: ' + (ps.stderr || r.stderr));
    }
    throw new Error('Extract failed: ' + r.stderr);
  }
}

export async function fetchText(url: string, timeoutMs = 20000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export async function fetchJson<T = any>(url: string, timeoutMs = 20000, headers: Record<string, string> = {}): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}
