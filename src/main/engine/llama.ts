import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { EngineStatus, LocalModelState, LocalTierId } from '@shared/types';
import { LOCAL_TIERS, tierById, type LocalTier } from '@shared/catalog';
import { paths } from '../paths';
import { settings, updateSettings } from '../settings';
import { emit, log, toast } from '../events';
import { getChat, saveChat } from '../store';
import { downloadFile, extractArchive, fetchJson, fetchText, isDownloading } from '../download';
import { detectHardware } from './hardware';
import { errMsg, killTree, runCapture, sleep } from '../util';

type Backend = 'cuda' | 'vulkan' | 'cpu';
const PINNED_TAG = 'b12359'; // llama.cpp v1.0.0 (stable)

let status: EngineStatus = { state: 'stopped' };
let proc: ChildProcess | null = null;
let current: { tier: LocalTierId; backend: Backend; port: number; ctx: number; vision: boolean } | null = null;
let logBuf = '';
let startPromise: Promise<string> | null = null;
let startingTier: LocalTierId | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let activeRequests = 0;
const helpCache = new Map<string, string>();

function setStatus(p: Partial<EngineStatus>, replace = false) {
  status = replace ? (p as EngineStatus) : { ...status, ...p };
  emit('engine:status', status);
}

// Engine output is also kept on disk so a crash can be diagnosed after the app restarts.
let logStream: fs.WriteStream | null = null;
let logStreamFailed = false;

export function engineLogPath() {
  return path.join(paths.logs, 'engine.log');
}

function openLogStream() {
  if (logStream || logStreamFailed) return;
  try {
    const f = engineLogPath();
    try {
      if (fs.statSync(f).size > 4 * 1024 * 1024) fs.renameSync(f, path.join(paths.logs, 'engine.old.log'));
    } catch {
      /* no previous log */
    }
    logStream = fs.createWriteStream(f, { flags: 'a' });
    logStream.on('error', () => {
      logStream = null;
      logStreamFailed = true;
    });
  } catch {
    logStreamFailed = true;
  }
}

function appendLog(s: string) {
  logBuf += s;
  if (logBuf.length > 300_000) logBuf = logBuf.slice(-200_000);
  openLogStream();
  logStream?.write(s);
}

export function engineLogs() {
  if (logBuf) return logBuf;
  // nothing in memory yet (app restarted): show the end of the log file from the previous session
  try {
    const f = engineLogPath();
    const size = fs.statSync(f).size;
    const len = Math.min(size, 200_000);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(f, 'r');
    try {
      fs.readSync(fd, buf, 0, len, size - len);
    } finally {
      fs.closeSync(fd);
    }
    return buf.toString('utf8') || '(brak logów / no logs yet)';
  } catch {
    return '(brak logów / no logs yet)';
  }
}

/** Error-looking lines from the end of the engine log (for friendly error messages). */
function logTail(maxLines = 4) {
  return logBuf
    .slice(-4000)
    .split(/\r?\n/)
    .filter((l) => /error|fail|unable|out of memory|oom|cuda|vulkan|abort|exception|assert/i.test(l))
    .slice(-maxLines)
    .join(' | ')
    .slice(0, 600);
}

export interface EngineExit {
  code: number | null;
  signal: string | null;
  at: number;
  tier: LocalTierId;
  backend: Backend;
  tail: string;
}
let lastExit: EngineExit | null = null;

/** The last time llama-server exited on its own (crash), not because Lunarix stopped it. */
export function lastEngineExit() {
  return lastExit;
}

export function formatExitCode(code: number | null) {
  if (code === null) return '?';
  const u = code >>> 0;
  return u > 0x7fffffff ? `0x${u.toString(16).toUpperCase()}` : String(code);
}

function backendDir(b: Backend) {
  return path.join(paths.engine, b);
}

function findServer(dir: string, depth = 0): string | null {
  try {
    const direct = path.join(dir, 'llama-server.exe');
    if (fs.existsSync(direct)) return direct;
    if (depth > 2) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        const r = findServer(path.join(dir, e.name), depth + 1);
        if (r) return r;
      }
    }
  } catch {
    /* none */
  }
  return null;
}

export function installedBackends(): Backend[] {
  return (['cuda', 'vulkan', 'cpu'] as Backend[]).filter((b) => !!findServer(backendDir(b)));
}

export function engineStatus(): EngineStatus {
  if (status.state === 'stopped' || status.state === 'not-installed') {
    const inst = installedBackends();
    const st: EngineStatus = { ...status, state: inst.length ? 'stopped' : 'not-installed', backend: inst[0] };
    try {
      if (inst[0]) st.version = fs.readFileSync(path.join(backendDir(inst[0]), 'version.txt'), 'utf8').trim();
    } catch {
      /* ignore */
    }
    status = st;
  }
  return status;
}

function cudaOk(v?: string) {
  if (!v) return true; // nvidia-smi without version line: assume modern driver
  const n = parseFloat(v);
  return n >= 12.4;
}

export async function pickBackend(): Promise<Backend> {
  const pref = settings().local.backend;
  if (pref && pref !== 'auto') return pref;
  const hw = await detectHardware();
  if (hw.bestGpu?.vendor === 'nvidia' && cudaOk(hw.cudaVersion)) return 'cuda';
  if (hw.bestGpu) return 'vulkan';
  return 'cpu';
}

async function resolveTag(): Promise<string> {
  try {
    const t = (await fetchText('https://github.com/ggml-org/llama.cpp/releases/latest/download/nightly-tag.txt', 15000)).trim();
    if (/^b\d+$/.test(t)) return t;
  } catch (e) {
    log('nightly-tag lookup failed', errMsg(e));
  }
  return PINNED_TAG;
}

export async function installEngine(b: Backend) {
  setStatus({ state: 'installing', backend: b, message: 'Pobieranie silnika llama.cpp…', error: undefined });
  const tag = await resolveTag();
  const variant = b === 'cuda' ? 'cuda-12.4' : b;
  const files = [`llama-${tag}-bin-win-${variant}-x64.zip`];
  if (b === 'cuda') files.push('cudart-llama-bin-win-cuda-12.4-x64.zip');
  const tmp = path.join(paths.temp, `engine-${b}`);
  await fsp.mkdir(tmp, { recursive: true });
  try {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const url = `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${f}`;
      await downloadFile(`engine-${b}-${i}`, `Silnik llama.cpp (${b.toUpperCase()}) ${i + 1}/${files.length}`, url, path.join(tmp, f));
    }
    const dir = backendDir(b);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
    setStatus({ message: 'Rozpakowywanie silnika…' });
    for (const f of files) await extractArchive(path.join(tmp, f), dir);
    const exe = findServer(dir);
    if (!exe) throw new Error('llama-server.exe not found in the downloaded archive');
    const exeDir = path.dirname(exe);
    if (path.resolve(exeDir) !== path.resolve(dir)) {
      // cudart dlls are extracted to the root; copy them next to the server binary
      for (const e of await fsp.readdir(dir)) {
        if (e.toLowerCase().endsWith('.dll')) await fsp.copyFile(path.join(dir, e), path.join(exeDir, e)).catch(() => {});
      }
    }
    await fsp.writeFile(path.join(dir, 'version.txt'), tag, 'utf8');
    helpCache.clear();
    setStatus({ state: 'stopped', backend: b, version: tag, message: undefined });
  } catch (e) {
    setStatus({ state: 'error', error: `Instalacja silnika nie powiodła się: ${errMsg(e)}`, message: undefined });
    throw e;
  } finally {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ------------------------------------------------------------- models

export function modelsDir() {
  return settings().local.modelsDir || paths.defaultModels;
}

export function modelPaths(id: LocalTierId) {
  const t = tierById(id);
  const dir = path.join(modelsDir(), id);
  return { dir, model: path.join(dir, t.file), mmproj: path.join(dir, t.mmproj) };
}

function fileSize(p: string) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

export function localModels(): LocalModelState[] {
  return LOCAL_TIERS.map((t) => {
    const mp = modelPaths(t.id);
    const size = fileSize(mp.model);
    return {
      tier: t.id,
      downloaded: size > 1024 * 1024,
      visionDownloaded: fileSize(mp.mmproj) > 1024 * 1024,
      sizeBytes: size + fileSize(mp.mmproj),
      path: size ? mp.model : undefined,
      downloading: isDownloading(`model-${t.id}`) || isDownloading(`mmproj-${t.id}`)
    };
  });
}

const hfUrl = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}?download=true`;

interface HfFileMeta {
  size: number;
  sha256?: string;
}
const hfMetaCache = new Map<string, Map<string, HfFileMeta>>();

/** Sizes and SHA-256 hashes Hugging Face publishes for a repo's files (best effort). */
async function hfFileMeta(repo: string): Promise<Map<string, HfFileMeta>> {
  const hit = hfMetaCache.get(repo);
  if (hit) return hit;
  const map = new Map<string, HfFileMeta>();
  try {
    const list = await fetchJson<any[]>(`https://huggingface.co/api/models/${repo}/tree/main`, 20000);
    for (const f of Array.isArray(list) ? list : []) {
      if (f?.type !== 'file' || typeof f.path !== 'string') continue;
      const sha = typeof f.lfs?.oid === 'string' && /^[0-9a-f]{64}$/i.test(f.lfs.oid) ? f.lfs.oid : undefined;
      map.set(f.path, { size: Number(f.lfs?.size ?? f.size) || 0, sha256: sha });
    }
    if (map.size) hfMetaCache.set(repo, map);
  } catch (e) {
    log('hugging face metadata unavailable', repo, errMsg(e));
  }
  return map;
}

export async function downloadTier(id: LocalTierId) {
  const t = tierById(id);
  const mp = modelPaths(id);
  await fsp.mkdir(mp.dir, { recursive: true });
  const hw = await detectHardware(true);
  const needGB = (fs.existsSync(mp.model) ? 0 : t.sizeGB) + (fs.existsSync(mp.mmproj) ? 0 : t.mmprojGB);
  if (hw.diskFreeGB && hw.diskFreeGB < needGB * 1.05 + 0.5) {
    throw new Error(`Za mało miejsca na dysku: potrzeba ~${needGB.toFixed(1)} GB, wolne ${hw.diskFreeGB.toFixed(1)} GB / Not enough disk space`);
  }
  const wantVision = settings().local.vision && !fs.existsSync(mp.mmproj);
  const meta = !fs.existsSync(mp.model) || wantVision ? await hfFileMeta(t.repo) : new Map<string, HfFileMeta>();
  if (!fs.existsSync(mp.model)) {
    const m = meta.get(t.file);
    await downloadFile(`model-${id}`, `Lunarix ${t.name} — ${t.model}`, hfUrl(t.repo, t.file), mp.model, { expectedSize: m?.size || undefined, sha256: m?.sha256 });
  }
  if (wantVision) {
    const m = meta.get(t.mmproj);
    await downloadFile(`mmproj-${id}`, `Lunarix ${t.name} — moduł widzenia`, hfUrl(t.repo, t.mmproj), mp.mmproj, { expectedSize: m?.size || undefined, sha256: m?.sha256 });
  }
  emit('local:models', localModels());
}

/**
 * Makes a tier the active model (and the model of `chatId`, if given). Downloads it first when
 * needed; the switch happens automatically once the download has finished.
 */
export async function switchTier(id: LocalTierId, chatId?: string): Promise<{ switched: boolean }> {
  const t = tierById(id);
  const P = () => settings().language === 'pl';
  const apply = () => {
    const s = settings();
    updateSettings({ activeModel: { provider: 'local', model: id }, local: { ...s.local, tier: id } });
    if (chatId) {
      const c = getChat(chatId);
      if (c && !c.running && c.model.provider === 'local') {
        c.model = { provider: 'local', model: id };
        saveChat(c, { touch: false });
      }
    }
    toast(P() ? `Teraz używasz Lunarix ${t.name}` : `Now using Lunarix ${t.name}`, 'success');
  };
  const st = localModels().find((m) => m.tier === id);
  if (st?.downloaded && (!settings().local.vision || st.visionDownloaded)) {
    apply();
    return { switched: true };
  }
  if (st?.downloading) throw new Error(P() ? 'Ten model jest już pobierany' : 'This model is already downloading');
  void downloadTier(id)
    .then(apply)
    .catch((e) => {
      if (!/cancel/i.test(errMsg(e))) toast(errMsg(e), 'error');
      emit('local:models', localModels());
    });
  setTimeout(() => emit('local:models', localModels()), 300);
  return { switched: false };
}

export async function deleteTier(id: LocalTierId) {
  if (current?.tier === id) await stopEngine();
  await fsp.rm(modelPaths(id).dir, { recursive: true, force: true });
  emit('local:models', localModels());
}

// ------------------------------------------------------------- server

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

async function helpText(exe: string) {
  if (helpCache.has(exe)) return helpCache.get(exe)!;
  const r = await runCapture(exe, ['--help'], { timeout: 30000, cwd: path.dirname(exe) });
  const text = (r.stdout || '') + '\n' + (r.stderr || '');
  helpCache.set(exe, text);
  return text;
}

function autoContext(t: LocalTier, ramGB: number) {
  let ctx = t.defaultContext;
  const freeForKv = ramGB - (t.sizeGB + t.mmprojGB) - 3;
  const kvGB = (t.kvBytesPerToken * ctx) / 1024 ** 3;
  if (kvGB > freeForKv) ctx = 16384;
  return ctx;
}

function autoGpuLayers(t: LocalTier, vramGB: number, ctx: number, vision: boolean) {
  if (vramGB <= 0) return 0;
  const kvGB = (t.kvBytesPerToken * ctx) / 1024 ** 3;
  const usable = vramGB - 0.9 - kvGB - (vision ? t.mmprojGB : 0);
  if (usable >= t.sizeGB) return 999;
  return Math.max(0, Math.min(t.layers, Math.floor((t.layers * usable) / t.sizeGB)));
}

export function engineBaseUrl() {
  return current && status.state === 'ready' ? `http://127.0.0.1:${current.port}/v1` : null;
}

export function currentTier() {
  return current?.tier;
}

export async function ensureEngine(tier?: LocalTierId): Promise<string> {
  const t = tier || settings().local.tier;
  if (current && current.tier === t && proc && status.state === 'ready') {
    touch();
    return `http://127.0.0.1:${current.port}/v1`;
  }
  if (startPromise && startingTier === t) return startPromise;
  if (startPromise) await startPromise.catch(() => {});
  startingTier = t;
  startPromise = startServer(t).finally(() => {
    startPromise = null;
    startingTier = null;
  });
  return startPromise;
}

async function startServer(id: LocalTierId): Promise<string> {
  await stopEngine();
  const t = tierById(id);
  const mp = modelPaths(id);
  if (!fs.existsSync(mp.model)) {
    const e: any = new Error(`Model Lunarix ${t.name} nie jest pobrany. Pobierz go w Ustawieniach → Modele lokalne. / Model not downloaded.`);
    e.code = 'model_missing';
    throw e;
  }
  const first = await pickBackend();
  const order: Backend[] = first === 'cuda' ? ['cuda', 'vulkan', 'cpu'] : first === 'vulkan' ? ['vulkan', 'cpu'] : ['cpu'];
  let lastErr: any;
  for (const b of order) {
    try {
      if (!findServer(backendDir(b))) await installEngine(b);
      return await launch(b, t, mp);
    } catch (e) {
      lastErr = e;
      log('engine launch failed', b, errMsg(e));
      appendLog(`\n[lunarix] backend ${b} failed: ${errMsg(e)}\n`);
    }
  }
  setStatus({ state: 'error', error: errMsg(lastErr), message: undefined });
  throw lastErr;
}

async function launch(b: Backend, t: LocalTier, mp: { model: string; mmproj: string }): Promise<string> {
  const exe = findServer(backendDir(b))!;
  const help = await helpText(exe);
  const has = (flag: string) => new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, '\\-')}([\\s,=]|$)`, 'm').test(help);
  const s = settings().local;
  const hw = await detectHardware();
  const port = await freePort();
  const ctx = s.contextSize > 0 ? s.contextSize : autoContext(t, hw.ramGB);
  const vision = s.vision && fs.existsSync(mp.mmproj) && has('--mmproj');
  const args = ['-m', mp.model, '--host', '127.0.0.1', '--port', String(port), '-c', String(ctx)];
  if (has('--jinja')) args.push('--jinja');
  if (vision) args.push('--mmproj', mp.mmproj);
  if (has('--parallel')) args.push('--parallel', '1');
  if (has('--alias')) args.push('--alias', `lunarix-${t.id}`);
  if (has('--no-webui')) args.push('--no-webui');
  if (has('--reasoning-format')) args.push('--reasoning-format', 'deepseek');
  if (has('--threads')) args.push('--threads', String(s.threads > 0 ? s.threads : Math.max(2, hw.cpu.cores)));
  if (b === 'cpu') {
    args.push('--n-gpu-layers', '0');
  } else if (s.gpuLayers >= 0) {
    args.push('--n-gpu-layers', String(s.gpuLayers));
  } else {
    // Newer llama.cpp builds fit layers to free VRAM automatically (--fit, ngl default "auto").
    // Only compute the split ourselves when the build would otherwise keep everything on the CPU.
    const nglLine = help.split(/\r?\n/).find((l) => /--n-gpu-layers/.test(l)) || '';
    const def = /default:\s*([^)\s,]+)/i.exec(nglLine)?.[1]?.toLowerCase();
    const autoFits = has('--fit') && def !== '0';
    if (!autoFits) {
      const vram = hw.bestGpu?.dedicated ? hw.bestGpu.vramGB : 0;
      args.push('--n-gpu-layers', String(autoGpuLayers(t, vram, ctx, vision)));
    }
  }
  if (has('--cache-reuse')) args.push('--cache-reuse', '256');

  setStatus({ state: 'starting', backend: b, tier: t.id, message: `Ładowanie modelu ${t.model}…`, error: undefined, contextSize: ctx, vision }, false);
  appendLog(`\n[lunarix] ${new Date().toISOString()} starting ${exe} ${args.join(' ')}\n`);
  const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, env: { ...process.env } });
  proc = child;
  let exited = false;
  let exitCode: number | null = null;
  child.stdout?.on('data', (d) => appendLog(d.toString()));
  child.stderr?.on('data', (d) => appendLog(d.toString()));
  child.on('exit', (code, sig) => {
    exited = true;
    exitCode = code;
    appendLog(`\n[lunarix] ${new Date().toISOString()} server exited with code ${formatExitCode(code)}${sig ? ` (${sig})` : ''}\n`);
    if (proc === child) {
      // not stopped by us: the engine crashed (or was killed from outside)
      proc = null;
      const wasReady = status.state === 'ready';
      current = null;
      if (wasReady) {
        lastExit = { code, signal: sig, at: Date.now(), tier: t.id, backend: b, tail: logTail() };
        log('engine exited unexpectedly', formatExitCode(code), lastExit.tail);
        setStatus({ state: 'stopped', message: undefined, port: undefined });
      }
    }
  });
  const started = Date.now();
  const deadline = started + 20 * 60_000;
  for (;;) {
    if (exited) {
      throw new Error(`llama-server (${b}) zakończył działanie (kod ${formatExitCode(exitCode)}). ${logTail()}`);
    }
    if (Date.now() > deadline) {
      killTree(child.pid);
      throw new Error('Przekroczono czas ładowania modelu / model load timeout');
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    const secs = Math.round((Date.now() - started) / 1000);
    if (secs % 2 === 0) setStatus({ message: `Ładowanie modelu ${t.model}… ${secs}s` });
    await sleep(500);
  }
  current = { tier: t.id, backend: b, port, ctx, vision };
  let version = '';
  try {
    version = fs.readFileSync(path.join(backendDir(b), 'version.txt'), 'utf8').trim();
  } catch {
    /* ignore */
  }
  setStatus({ state: 'ready', backend: b, tier: t.id, port, message: undefined, version, contextSize: ctx, vision });
  touch();
  return `http://127.0.0.1:${port}/v1`;
}

function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  const mins = settings().local.idleUnloadMinutes;
  if (mins > 0) {
    idleTimer = setTimeout(() => {
      if (activeRequests > 0) return touch();
      log('engine idle — unloading');
      stopEngine();
    }, mins * 60_000);
  }
}

export function beginEngineRequest() {
  activeRequests++;
  touch();
}
export function endEngineRequest() {
  activeRequests = Math.max(0, activeRequests - 1);
  touch();
}

export async function stopEngine() {
  if (idleTimer) clearTimeout(idleTimer);
  const p = proc;
  proc = null;
  current = null;
  if (p) {
    appendLog(`\n[lunarix] ${new Date().toISOString()} stopping engine\n`);
    killTree(p.pid);
    try {
      p.kill();
    } catch {
      /* ignore */
    }
    await sleep(300);
  }
  if (status.state !== 'installing') setStatus({ state: installedBackends().length ? 'stopped' : 'not-installed', message: undefined, port: undefined });
}

/** True when llama-server is running and answers /health. */
export async function engineHealthy(): Promise<boolean> {
  const c = current;
  if (!proc || !c || status.state !== 'ready') return false;
  try {
    const r = await fetch(`http://127.0.0.1:${c.port}/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok;
  } catch {
    return false;
  }
}

export function engineContextSize() {
  return current?.ctx || 0;
}

export function engineHasVision() {
  return !!current?.vision;
}
