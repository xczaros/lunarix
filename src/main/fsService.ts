import { shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FileContent, FsEntry, SearchMatch } from '@shared/types';
import { emit, log } from './events';
import { toPosix } from './util';

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.vite',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.mypy_cache',
  '.pytest_cache',
  'target',
  'bin',
  'obj',
  '.idea',
  '.gradle',
  '.dart_tool',
  'Pods',
  '.expo'
]);

export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif']);
const BINARY_EXT = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.obj', '.o', '.a', '.lib', '.pdb', '.class', '.jar', '.war',
  '.zip', '.7z', '.rar', '.gz', '.tgz', '.bz2', '.xz', '.tar', '.iso', '.dmg', '.msi',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt',
  '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.mkv', '.mov', '.avi', '.webm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.gguf', '.safetensors', '.onnx', '.pt', '.pth', '.ckpt', '.db', '.sqlite', '.psd', '.blend', '.fbx', '.glb', '.unitypackage', '.pak', '.wasm'
]);

export function isLikelyBinaryExt(p: string) {
  const ext = path.extname(p).toLowerCase();
  return BINARY_EXT.has(ext) || IMAGE_EXT.has(ext);
}

export function looksBinary(buf: Buffer) {
  const n = Math.min(buf.length, 8000);
  let suspicious = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 7 || (c > 13 && c < 32)) suspicious++;
  }
  return n > 0 && suspicious / n > 0.1;
}

export async function listDir(dir: string): Promise<FsEntry[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out: FsEntry[] = [];
  await Promise.all(
    entries.map(async (e) => {
      if (e.name === '.git' || e.name === 'desktop.ini' || e.name === 'Thumbs.db') return;
      const p = path.join(dir, e.name);
      let size = 0;
      let mtime = 0;
      let isDir = e.isDirectory();
      try {
        const st = await fsp.stat(p);
        size = st.size;
        mtime = st.mtimeMs;
        isDir = st.isDirectory();
      } catch {
        /* broken symlink */
      }
      out.push({ name: e.name, path: p, isDir, size, mtime });
    })
  );
  out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.isDir ? -1 : 1));
  return out;
}

export async function readFileContent(p: string): Promise<FileContent> {
  const st = await fsp.stat(p);
  const ext = path.extname(p).toLowerCase();
  const image = IMAGE_EXT.has(ext) || ext === '.svg';
  const base: FileContent = { path: p, content: '', size: st.size, binary: false, image, tooLarge: false, eol: 'lf', mtime: st.mtimeMs };
  if (st.size > 8 * 1024 * 1024) return { ...base, tooLarge: true, binary: !image && isLikelyBinaryExt(p) };
  if (IMAGE_EXT.has(ext)) return { ...base, binary: true };
  const buf = await fsp.readFile(p);
  if (looksBinary(buf)) return { ...base, binary: true };
  let content = buf.toString('utf8');
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const eol = content.includes('\r\n') ? 'crlf' : 'lf';
  return { ...base, content, eol };
}

export async function writeFileContent(p: string, content: string) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, content, 'utf8');
}

export async function createFile(p: string) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const fh = await fsp.open(p, 'wx');
  await fh.close();
}

export async function createDir(p: string) {
  await fsp.mkdir(p, { recursive: true });
}

export async function renamePath(from: string, to: string) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.rename(from, to);
}

export async function deletePath(p: string) {
  try {
    await shell.trashItem(p);
  } catch (e) {
    log('trash failed, deleting', p, e);
    await fsp.rm(p, { recursive: true, force: true });
  }
}

export async function copyPath(from: string, to: string) {
  await fsp.cp(from, to, { recursive: true, errorOnExist: false, force: true });
}

// ------------------------------------------------------------- walking

export interface WalkOptions {
  maxFiles?: number;
  includeHidden?: boolean;
  ignore?: Set<string>;
  maxDepth?: number;
}

export async function walkFiles(root: string, opts: WalkOptions = {}): Promise<string[]> {
  const max = opts.maxFiles ?? 20000;
  const ignore = opts.ignore ?? IGNORED_DIRS;
  const out: string[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < max) {
    const { dir, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (ignore.has(e.name)) continue;
        if (!opts.includeHidden && e.name.startsWith('.') && e.name !== '.github' && e.name !== '.vscode') continue;
        if (opts.maxDepth === undefined || depth < opts.maxDepth) stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
      } else if (e.isFile()) {
        out.push(path.join(dir, e.name));
        if (out.length >= max) break;
      }
    }
  }
  return out;
}

export function globToRegExp(glob: string): RegExp {
  let g = toPosix(glob.trim());
  if (g.startsWith('./')) g = g.slice(2);
  let re = '';
  let i = 0;
  let inGroup = false;
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      re += '(?:';
      inGroup = true;
    } else if (c === '}' && inGroup) {
      re += ')';
      inGroup = false;
    } else if (c === ',' && inGroup) re += '|';
    else if ('.+^$()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
    i++;
  }
  return new RegExp(`^${re}$`, 'i');
}

export function matchGlob(relPath: string, glob: string, re?: RegExp) {
  const r = re || globToRegExp(glob);
  const rel = toPosix(relPath);
  if (!glob.includes('/')) return r.test(path.posix.basename(rel)) || r.test(rel);
  return r.test(rel);
}

export async function searchFiles(
  root: string,
  query: string,
  opts: { regex?: boolean; caseSensitive?: boolean; include?: string; maxResults?: number } = {}
): Promise<SearchMatch[]> {
  if (!query) return [];
  const flags = opts.caseSensitive ? 'g' : 'gi';
  let re: RegExp;
  try {
    re = opts.regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch (e: any) {
    throw new Error('Invalid regex: ' + e.message);
  }
  const max = opts.maxResults ?? 2000;
  const files = await walkFiles(root, { maxFiles: 30000 });
  const includeRe = opts.include ? opts.include.split(',').map((g) => g.trim()).filter(Boolean).map((g) => ({ g, re: globToRegExp(g) })) : null;
  const out: SearchMatch[] = [];
  for (const f of files) {
    if (out.length >= max) break;
    if (isLikelyBinaryExt(f)) continue;
    const rel = path.relative(root, f);
    if (includeRe && !includeRe.some(({ g, re: r }) => matchGlob(rel, g, r))) continue;
    let st;
    try {
      st = await fsp.stat(f);
    } catch {
      continue;
    }
    if (st.size > 2 * 1024 * 1024) continue;
    let text: string;
    try {
      const buf = await fsp.readFile(f);
      if (looksBinary(buf)) continue;
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    let perFile = 0;
    for (let i = 0; i < lines.length && perFile < 100 && out.length < max; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (m) {
        perFile++;
        const line = lines[i];
        out.push({ path: f, line: i + 1, col: m.index + 1, text: line.length > 400 ? line.slice(Math.max(0, m.index - 100), m.index + 300) : line });
      }
    }
  }
  return out;
}

// quick-open fuzzy finder
const fileListCache = new Map<string, { at: number; files: string[] }>();

function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return 1;
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === ' ') continue;
    const found = t.indexOf(c, ti);
    if (found < 0) return -1;
    if (found === ti) {
      streak++;
      score += 3 + streak;
    } else {
      streak = 0;
      score += 1;
    }
    if (found === 0 || '/\\._-'.includes(t[found - 1])) score += 4;
    ti = found + 1;
  }
  const base = t.slice(t.lastIndexOf('/') + 1);
  if (base.startsWith(q)) score += 20;
  if (base.includes(q)) score += 10;
  return score - t.length * 0.02;
}

export async function findFiles(root: string, query: string): Promise<string[]> {
  let entry = fileListCache.get(root);
  if (!entry || Date.now() - entry.at > 8000) {
    const files = await walkFiles(root, { maxFiles: 40000 });
    entry = { at: Date.now(), files: files.map((f) => toPosix(path.relative(root, f))) };
    fileListCache.set(root, entry);
  }
  if (!query.trim()) return entry.files.slice(0, 60).map((f) => path.join(root, f));
  const scored: { f: string; s: number }[] = [];
  for (const f of entry.files) {
    const s = fuzzyScore(query.replace(/\\/g, '/'), f);
    if (s > 0) scored.push({ f, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, 60).map((x) => path.join(root, x.f));
}

// --------------------------------------------------------------- watching

const watchers = new Map<string, { w: fs.FSWatcher; pending: Set<string>; timer: NodeJS.Timeout | null }>();
type ChangeListener = (root: string, paths: string[]) => void;
const changeListeners = new Set<ChangeListener>();
export function onFsChange(l: ChangeListener) {
  changeListeners.add(l);
  return () => changeListeners.delete(l);
}

export function watchRoot(root: string) {
  const key = path.resolve(root).toLowerCase();
  if (watchers.has(key)) return;
  try {
    const state = { w: null as any as fs.FSWatcher, pending: new Set<string>(), timer: null as NodeJS.Timeout | null };
    state.w = fs.watch(root, { recursive: true }, (_ev, file) => {
      if (!file) return;
      const f = file.toString();
      state.pending.add(path.join(root, f));
      if (state.timer) return;
      state.timer = setTimeout(() => {
        state.timer = null;
        const list = [...state.pending].slice(0, 400);
        state.pending.clear();
        fileListCache.delete(root);
        const visible = list.filter((p) => !/[\\/](node_modules|\.git)[\\/]/.test(p));
        if (visible.length) emit('fs:changed', { root, paths: visible });
        for (const l of changeListeners) l(root, list);
      }, 220);
    });
    state.w.on('error', (e) => log('watch error', root, e));
    watchers.set(key, state);
  } catch (e) {
    log('watch failed', root, e);
  }
}

export function unwatchAll() {
  for (const s of watchers.values()) {
    try {
      s.w.close();
    } catch {
      /* ignore */
    }
  }
  watchers.clear();
}
