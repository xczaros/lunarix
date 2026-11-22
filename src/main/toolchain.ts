import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ToolchainItem } from '@shared/types';
import { paths } from './paths';
import { downloadFile, extractArchive, fetchJson } from './download';
import { log } from './events';
import { errMsg, isWin, powershell, runCapture, which } from './util';

function nodeDir(): string | null {
  const base = path.join(paths.tools, 'node');
  try {
    const cur = fs.readFileSync(path.join(base, 'current.txt'), 'utf8').trim();
    const d = path.join(base, cur);
    if (fs.existsSync(path.join(d, 'node.exe'))) return d;
  } catch {
    /* none */
  }
  return null;
}

export function toolBinDirs(): string[] {
  const dirs: string[] = [];
  const n = nodeDir();
  if (n) dirs.push(n);
  const git = path.join(paths.tools, 'git');
  if (fs.existsSync(path.join(git, 'cmd', 'git.exe'))) dirs.push(path.join(git, 'cmd'), path.join(git, 'usr', 'bin'));
  const pyUser = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python');
  try {
    for (const d of fs.readdirSync(pyUser)) {
      if (/^Python3\d+$/i.test(d)) {
        dirs.push(path.join(pyUser, d), path.join(pyUser, d, 'Scripts'));
        break;
      }
    }
  } catch {
    /* no python */
  }
  const npmGlobal = path.join(process.env.APPDATA || '', 'npm');
  if (fs.existsSync(npmGlobal)) dirs.push(npmGlobal);
  return dirs;
}

export function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
  const current = env[key] || '';
  const extra = toolBinDirs().filter((d) => !current.toLowerCase().includes(d.toLowerCase()));
  env[key] = [...extra, current].filter(Boolean).join(path.delimiter);
  if (key !== 'PATH') env.PATH = env[key];
  env.npm_config_yes = 'true';
  env.npm_config_fund = 'false';
  env.npm_config_audit = 'false';
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONUNBUFFERED = '1';
  env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
  env.LUNARIX = '1';
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

/** Re-read PATH from the registry (after winget / installers modify it). */
export async function refreshPathFromRegistry() {
  if (!isWin) return;
  const r = await powershell("[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')", 8000);
  if (r.code === 0 && r.stdout.trim()) {
    const fresh = r.stdout.trim().split(';').filter(Boolean);
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'Path';
    const cur = (process.env[key] || '').split(';').filter(Boolean);
    const merged = [...cur];
    for (const p of fresh) if (!merged.some((m) => m.toLowerCase() === p.toLowerCase())) merged.push(p);
    process.env[key] = merged.join(';');
  }
}

function realWhich(cmd: string) {
  const p = which(cmd, toolBinDirs());
  if (p && /WindowsApps/i.test(p) && /python/i.test(cmd)) return null; // Microsoft Store alias
  return p;
}

async function versionOf(cmd: string, args: string[]) {
  const p = realWhich(cmd);
  if (!p) return null;
  const isCmd = /\.(cmd|bat)$/i.test(p);
  const r = isCmd ? await runCapture(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `"${p}" ${args.join(' ')}`], { timeout: 10000, env: agentEnv() }) : await runCapture(p, args, { timeout: 10000, env: agentEnv() });
  const out = (r.stdout || r.stderr).trim().split(/\r?\n/)[0];
  return { path: p, version: out.replace(/^(git version|Python)\s*/i, '').trim() };
}

let cache: { at: number; items: ToolchainItem[] } | null = null;

export async function detectToolchain(force = false): Promise<ToolchainItem[]> {
  if (!force && cache && Date.now() - cache.at < 60_000) return cache.items;
  const defs: [string, string, string, string[]][] = [
    ['node', 'Node.js', 'node', ['-v']],
    ['npm', 'npm', 'npm', ['-v']],
    ['git', 'Git', 'git', ['--version']],
    ['python', 'Python', 'python', ['--version']],
    ['dotnet', '.NET SDK', 'dotnet', ['--version']],
    ['java', 'Java', 'java', ['-version']],
    ['go', 'Go', 'go', ['version']],
    ['rustc', 'Rust', 'rustc', ['--version']]
  ];
  const items = await Promise.all(
    defs.map(async ([id, name, cmd, args]) => {
      try {
        const v = await versionOf(cmd, args);
        if (!v) return { id, name, installed: false } as ToolchainItem;
        return { id, name, installed: true, version: v.version.slice(0, 60), path: v.path, source: v.path.startsWith(paths.tools) ? 'lunarix' : 'system' } as ToolchainItem;
      } catch {
        return { id, name, installed: false } as ToolchainItem;
      }
    })
  );
  cache = { at: Date.now(), items };
  return items;
}

export async function toolchainSummary(): Promise<string> {
  const items = await detectToolchain();
  return items.map((i) => `${i.name}: ${i.installed ? i.version || 'installed' : 'not installed'}`).join(', ');
}

const WINGET: Record<string, string> = {
  python: 'Python.Python.3.12',
  go: 'GoLang.Go',
  rust: 'Rustlang.Rustup',
  rustc: 'Rustlang.Rustup',
  java: 'EclipseAdoptium.Temurin.21.JDK',
  dotnet: 'Microsoft.DotNet.SDK.8',
  cmake: 'Kitware.CMake',
  '7zip': '7zip.7zip',
  ffmpeg: 'Gyan.FFmpeg',
  bun: 'Oven-sh.Bun',
  deno: 'DenoLand.Deno',
  php: 'PHP.PHP.8.3',
  ruby: 'RubyInstallerTeam.Ruby.3.3',
  vscode: 'Microsoft.VisualStudioCode',
  docker: 'Docker.DockerDesktop',
  pwsh: 'Microsoft.PowerShell',
  gh: 'GitHub.cli',
  mingw: 'BrechtSanders.WinLibs.POSIX.UCRT'
};

export async function installTool(id: string, onLog: (s: string) => void = () => {}): Promise<string> {
  const name = id.toLowerCase().trim();
  try {
    if (name === 'node' || name === 'nodejs' || name === 'node.js' || name === 'npm') return await installNode(onLog);
    if (name === 'git') return await installGit(onLog);
    if (name === 'pnpm' || name === 'yarn') {
      await ensureNode(onLog);
      const r = await runCapture(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `npm install -g ${name}`], { env: agentEnv(), timeout: 5 * 60_000 });
      cache = null;
      return r.code === 0 ? `${name} installed globally via npm.` : `npm install -g ${name} failed:\n${r.stderr || r.stdout}`;
    }
    const wingetId = WINGET[name] || id;
    return await installWinget(wingetId, onLog);
  } finally {
    cache = null;
  }
}

async function ensureNode(onLog: (s: string) => void) {
  if (!realWhich('node')) await installNode(onLog);
}

async function installNode(onLog: (s: string) => void): Promise<string> {
  const existing = realWhich('node');
  if (existing) {
    const v = await versionOf('node', ['-v']);
    return `Node.js already available (${v?.version}) at ${existing}`;
  }
  onLog('Fetching Node.js LTS index…');
  const index = await fetchJson<any[]>('https://nodejs.org/dist/index.json');
  const lts = index.find((r) => r.lts && Array.isArray(r.files) && r.files.includes('win-x64-zip'));
  if (!lts) throw new Error('Could not find a Node.js LTS release');
  const ver = lts.version as string;
  const folder = `node-${ver}-win-x64`;
  const url = `https://nodejs.org/dist/${ver}/${folder}.zip`;
  const base = path.join(paths.tools, 'node');
  const zip = path.join(paths.temp, `${folder}.zip`);
  onLog(`Downloading Node.js ${ver}…`);
  await downloadFile('tool-node', `Node.js ${ver}`, url, zip);
  onLog('Extracting…');
  await extractArchive(zip, base);
  await fsp.writeFile(path.join(base, 'current.txt'), folder, 'utf8');
  await fsp.rm(zip, { force: true });
  cache = null;
  return `Node.js ${ver} installed (portable) at ${path.join(base, folder)}. node, npm and npx are now on PATH for commands run by Lunarix.`;
}

async function installGit(onLog: (s: string) => void): Promise<string> {
  const existing = realWhich('git');
  if (existing) return `Git already available at ${existing}`;
  onLog('Looking up the latest MinGit release…');
  const rel = await fetchJson<any>('https://api.github.com/repos/git-for-windows/git/releases/latest', 20000, { Accept: 'application/vnd.github+json' });
  const asset = (rel.assets || []).find((a: any) => /^MinGit-[\d.]+-64-bit\.zip$/i.test(a.name));
  if (!asset) throw new Error('MinGit asset not found');
  const zip = path.join(paths.temp, asset.name);
  onLog(`Downloading ${asset.name}…`);
  await downloadFile('tool-git', asset.name, asset.browser_download_url, zip, { expectedSize: asset.size });
  const dest = path.join(paths.tools, 'git');
  await fsp.rm(dest, { recursive: true, force: true });
  await extractArchive(zip, dest);
  await fsp.rm(zip, { force: true });
  cache = null;
  return `Git (${rel.tag_name}) installed (portable) at ${dest}. git is now on PATH for Lunarix commands.`;
}

async function installWinget(wingetId: string, onLog: (s: string) => void): Promise<string> {
  const winget = which('winget');
  if (!winget) throw new Error('winget is not available on this system. Install the tool manually.');
  onLog(`winget install ${wingetId}…`);
  const r = await runCapture(winget, ['install', '-e', '--id', wingetId, '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], { timeout: 20 * 60_000 });
  await refreshPathFromRegistry();
  const out = (r.stdout + '\n' + r.stderr).replace(/[\r\b]+/g, '\n').split('\n').filter((l) => l.trim() && !/^[-\\|/\s█▒]+$/.test(l)).slice(-25).join('\n');
  log('winget', wingetId, r.code);
  if (r.code === 0 || /already installed|Successfully installed|Pomyślnie zainstalowano|jest już zainstalowany/i.test(out)) return `Installed ${wingetId} via winget.\n${out}`;
  return `winget install ${wingetId} finished with code ${r.code}:\n${out}`;
}

export async function safeInstall(id: string, onLog?: (s: string) => void) {
  try {
    return await installTool(id, onLog);
  } catch (e) {
    return `Installation of ${id} failed: ${errMsg(e)}`;
  }
}
