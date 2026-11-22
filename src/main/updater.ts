// Forced updates from GitHub Releases.
//
// On start (and every 30 minutes) Lunarix asks GitHub for the latest release of UPDATE_REPO.
// If its tag (v1.2.3) is newer than this build and the release has a `lunarix-setup.exe` asset,
// the app is locked behind an "update required" window: update (download + silent install +
// relaunch) or quit. Drafts and pre-releases are ignored by GitHub's /releases/latest.
// No internet / GitHub down / rate limit → the app keeps working (local models work offline).
import { app } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UpdateInfo } from '@shared/types';
import { emit, log } from './events';
import { downloadFile, fetchJson } from './download';
import { errMsg } from './util';

export const UPDATE_REPO = 'xczaros/lunarix';
export const SETUP_ASSET = 'lunarix-setup.exe';
const CHECK_EVERY_MS = 30 * 60_000;
const isTest = !!process.env.LUNARIX_TEST;

type Ver = [number, number, number];

export function parseVersion(v: unknown): Ver | null {
  const m = /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/i.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

export function compareVersions(a: Ver, b: Ver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const fmt = (v: Ver) => v.join('.');

function currentVersion(): string {
  return (isTest && process.env.LUNARIX_UPDATE_CURRENT) || app.getVersion();
}

/** Only the installed app updates itself; dev runs and automated tests opt in via env. */
function enabled(): boolean {
  if (process.env.LUNARIX_UPDATE_URL) return true;
  return app.isPackaged && !isTest && process.platform === 'win32';
}

let state: UpdateInfo = { state: 'none', current: currentVersion() };
let asset: { url: string; size: number; sha256?: string } | null = null;
let checking: Promise<UpdateInfo> | null = null;
let timer: NodeJS.Timeout | null = null;

function set(patch: Partial<UpdateInfo>) {
  state = { ...state, ...patch };
  emit('update', state);
}

export function updateState(): UpdateInfo {
  return state;
}

export function startUpdateChecks() {
  if (!enabled()) return;
  void checkForUpdate();
  timer = setInterval(() => void checkForUpdate(), CHECK_EVERY_MS);
  timer.unref?.();
}

export function checkForUpdate(): Promise<UpdateInfo> {
  if (!enabled() || state.state === 'downloading' || state.state === 'installing') return Promise.resolve(state);
  if (!checking) checking = doCheck().finally(() => (checking = null));
  return checking;
}

async function doCheck(): Promise<UpdateInfo> {
  const url = process.env.LUNARIX_UPDATE_URL || `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
  try {
    const rel: any = await fetchJson(url, 12_000, { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' });
    if (!rel || rel.draft || rel.prerelease) return state;
    const latest = parseVersion(rel.tag_name);
    const current = parseVersion(currentVersion());
    if (!latest || !current) {
      log('update: unreadable version', rel.tag_name, currentVersion());
      return state;
    }
    if (compareVersions(latest, current) <= 0) {
      if (state.state !== 'none') set({ state: 'none', latest: fmt(latest) });
      return state;
    }
    const a = (Array.isArray(rel.assets) ? rel.assets : []).find((x: any) => String(x?.name).toLowerCase() === SETUP_ASSET);
    if (!a?.browser_download_url) {
      // a release without the installer can't be installed — don't lock people out
      log('update: release', rel.tag_name, 'has no', SETUP_ASSET);
      return state;
    }
    const digest = String(a.digest || '');
    asset = { url: a.browser_download_url, size: Number(a.size) || 0, sha256: /^sha256:[0-9a-f]{64}$/i.test(digest) ? digest.slice(7) : undefined };
    if (state.state === 'error' && state.latest === fmt(latest)) return state; // keep the error + retry button visible
    log('update required', currentVersion(), '->', fmt(latest));
    set({
      state: 'required',
      current: currentVersion(),
      latest: fmt(latest),
      title: String(rel.name || '').trim() || undefined,
      notes: String(rel.body || '').slice(0, 30_000),
      pageUrl: typeof rel.html_url === 'string' ? rel.html_url : `https://github.com/${UPDATE_REPO}/releases/latest`,
      size: asset.size,
      publishedAt: rel.published_at,
      error: undefined
    });
  } catch (e) {
    log('update check failed', errMsg(e));
  }
  return state;
}

export async function installUpdate(): Promise<void> {
  if (!asset || !state.latest || (state.state !== 'required' && state.state !== 'error')) return;
  const dir = path.join(os.tmpdir(), 'lunarix-update');
  const file = path.join(dir, `lunarix-setup-${state.latest}.exe`);
  set({ state: 'downloading', received: 0, speed: 0, verifying: false, error: undefined });
  try {
    fs.mkdirSync(dir, { recursive: true });
    // leftovers of other versions
    for (const f of fs.readdirSync(dir)) if (!f.startsWith(`lunarix-setup-${state.latest}.`)) fs.rmSync(path.join(dir, f), { force: true });
    let ok = false;
    if (fs.existsSync(file) && asset.size && fs.statSync(file).size === asset.size && !asset.sha256) ok = true;
    if (!ok) {
      fs.rmSync(file, { force: true });
      await downloadFile('app-update', `Lunarix ${state.latest}`, asset.url, file, {
        expectedSize: asset.size || undefined,
        sha256: asset.sha256,
        quiet: true,
        onProgress: (p) => set({ received: p.received, size: p.total || state.size, speed: p.speed, verifying: !!p.verifying })
      });
    }
    if (asset.size && fs.statSync(file).size !== asset.size) throw new Error('size mismatch');
  } catch (e) {
    log('update download failed', errMsg(e));
    set({ state: 'error', error: errMsg(e) });
    return;
  }

  set({ state: 'installing', verifying: false });
  const installDir = path.dirname(process.execPath);
  const args = isTest && process.env.LUNARIX_UPDATE_ARGS ? process.env.LUNARIX_UPDATE_ARGS.split('|') : ['/S', '/launch', `/D=${installDir}`];
  log('update: running installer', file, args.join(' '));
  if (isTest && process.env.LUNARIX_UPDATE_DRYRUN) {
    emit('update:test-installed', { file, args, size: fs.statSync(file).size });
    return;
  }
  try {
    // The installer waits for this process to exit, replaces the files and starts the new version.
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => {
      log('update: installer failed to start', errMsg(e));
      set({ state: 'error', error: errMsg(e) });
    });
    child.unref();
    setTimeout(() => {
      if (state.state === 'installing') app.quit();
    }, 800);
  } catch (e) {
    set({ state: 'error', error: errMsg(e) });
  }
}
