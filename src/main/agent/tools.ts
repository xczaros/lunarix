import { nativeImage, shell } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentMode, Settings, Todo, ToolResult } from '@shared/types';
import type { ToolDef } from '../providers/types';
import { IGNORED_DIRS, IMAGE_EXT, looksBinary, matchGlob, globToRegExp, searchFiles, walkFiles } from '../fsService';
import { processOutput, runCommand, stopProcess } from '../processes';
import { previewUrl } from '../preview';
import { saveBlob } from '../store';
import { safeInstall } from '../toolchain';
import { extractAnyArchive } from '../attachments';
import { emit } from '../events';
import { formatBytes, headText, isSubPath, tailText, toPosix } from '../util';
import { snapshot } from './checkpoints';
import { summarizeDiff } from './diff';
import { webFetch, webSearch } from './web';
import { browserAction } from './browser';
import { computerAction, screenshotDesktop } from './desktop';

export type ToolCategory = 'read' | 'edit' | 'command' | 'desktop' | 'browser' | 'web' | 'meta';

interface ToolSpec extends ToolDef {
  category: ToolCategory;
  core: boolean;
}

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const bool = (description: string) => ({ type: 'boolean', description });

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'list_files',
    category: 'read',
    core: true,
    description: 'List files and folders as a tree. Paths are relative to the project root unless absolute. Heavy folders like node_modules are skipped.',
    parameters: { type: 'object', properties: { path: str('Directory to list (default: project root ".")'), depth: int('How many levels deep, 1-6 (default 2)') } }
  },
  {
    name: 'read_file',
    category: 'read',
    core: true,
    description: 'Read a text file (or view an image file). For big files use start_line/end_line (1-based, inclusive).',
    parameters: { type: 'object', properties: { path: str('File path'), start_line: int('First line to read'), end_line: int('Last line to read') }, required: ['path'] }
  },
  {
    name: 'write_file',
    category: 'edit',
    core: true,
    description: 'Create a new file or completely overwrite an existing one with the full content. Parent folders are created automatically. Always write the COMPLETE file content, never placeholders like "rest of code here".',
    parameters: { type: 'object', properties: { path: str('File path'), content: str('Complete file content') }, required: ['path', 'content'] }
  },
  {
    name: 'edit_file',
    category: 'edit',
    core: true,
    description: 'Edit an existing file by replacing an exact snippet. old_text must match the file exactly (including indentation) and be unique unless replace_all is true. Prefer this over write_file for small changes in big files.',
    parameters: {
      type: 'object',
      properties: { path: str('File path'), old_text: str('Exact text to find'), new_text: str('Replacement text'), replace_all: bool('Replace every occurrence') },
      required: ['path', 'old_text', 'new_text']
    }
  },
  {
    name: 'delete_path',
    category: 'edit',
    core: true,
    description: 'Delete a file or folder (moved to the Recycle Bin; can be undone with a checkpoint).',
    parameters: { type: 'object', properties: { path: str('File or folder to delete') }, required: ['path'] }
  },
  {
    name: 'move_path',
    category: 'edit',
    core: false,
    description: 'Move or rename a file or folder.',
    parameters: { type: 'object', properties: { from: str('Source path'), to: str('Destination path') }, required: ['from', 'to'] }
  },
  {
    name: 'search',
    category: 'read',
    core: true,
    description: 'Search file contents with a regular expression (like grep). Returns matching lines as path:line: text.',
    parameters: {
      type: 'object',
      properties: { pattern: str('Regex or text to search for'), path: str('Folder to search in (default project root)'), glob: str('Only files matching this glob, e.g. "*.ts" or "src/**/*.css"'), case_sensitive: bool('Case sensitive (default false)') },
      required: ['pattern']
    }
  },
  {
    name: 'find_files',
    category: 'read',
    core: true,
    description: 'Find files by glob pattern, e.g. "**/*.tsx" or "*.json".',
    parameters: { type: 'object', properties: { pattern: str('Glob pattern') }, required: ['pattern'] }
  },
  {
    name: 'run_command',
    category: 'command',
    core: true,
    description:
      'Run a shell command on the user\'s Windows PC (PowerShell; commands with && run in cmd.exe). Use it to install packages, build, run tests, git, etc. Commands must be non-interactive (use flags like -y). For long-running servers (npm run dev, python -m http.server) set background=true; you get a process_id. A foreground command that exceeds the timeout keeps running in the background.',
    parameters: {
      type: 'object',
      properties: {
        command: str('The command to run'),
        cwd: str('Working directory (default project root)'),
        timeout_sec: int('Timeout in seconds for foreground commands (default 120, max 900)'),
        background: bool('Start as a background process (dev servers, watchers)')
      },
      required: ['command']
    }
  },
  {
    name: 'process_output',
    category: 'read',
    core: true,
    description: 'Get new output and status of a background process started by run_command.',
    parameters: { type: 'object', properties: { process_id: str('Process id from run_command') }, required: ['process_id'] }
  },
  {
    name: 'stop_process',
    category: 'command',
    core: true,
    description: 'Stop a background process.',
    parameters: { type: 'object', properties: { process_id: str('Process id') }, required: ['process_id'] }
  },
  {
    name: 'browser',
    category: 'browser',
    core: true,
    description:
      'Control a real Chromium browser to test web apps. Every action returns a screenshot (1280x800) plus console logs. Actions: open (url = http URL, localhost:port or a project HTML file path), click (x,y from the latest screenshot), type (text into the focused element), key (e.g. "Enter", "Tab", "ctrl+a"), scroll (direction up/down), evaluate (run JavaScript, returns result), back, reload, screenshot, close. Use it to verify your work visually and fix errors.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'click', 'type', 'key', 'scroll', 'evaluate', 'back', 'reload', 'screenshot', 'close'], description: 'Browser action' },
        url: str('URL or project file for open'),
        x: int('X coordinate for click'),
        y: int('Y coordinate for click'),
        text: str('Text for type'),
        key: str('Key for key action'),
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
        script: str('JavaScript for evaluate')
      },
      required: ['action']
    }
  },
  {
    name: 'open_preview',
    category: 'meta',
    core: true,
    description: 'Show a live preview to the user inside Lunarix (an HTML file from the project or a URL such as http://localhost:5173). It auto-reloads when files change.',
    parameters: { type: 'object', properties: { target: str('HTML file path or URL') }, required: ['target'] }
  },
  {
    name: 'screenshot',
    category: 'desktop',
    core: false,
    description: "Take a screenshot of the user's whole desktop (primary screen). Use it to check desktop apps or games you launched.",
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'computer',
    category: 'desktop',
    core: false,
    description:
      'Control the mouse and keyboard on the user\'s desktop to test desktop apps/games. Coordinates refer to the latest desktop screenshot. Actions: click, double_click, right_click, move, drag (x,y → x2,y2), type (text), key (combo like "ctrl+s", "alt+tab", "enter"), scroll (amount: negative = down), wait (seconds). Returns a new screenshot.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'double_click', 'right_click', 'move', 'drag', 'type', 'key', 'scroll', 'wait', 'screenshot'], description: 'Action' },
        x: int('X'),
        y: int('Y'),
        x2: int('Drag end X'),
        y2: int('Drag end Y'),
        text: str('Text to type'),
        keys: str('Key combination'),
        amount: int('Scroll amount in notches (negative = down)'),
        seconds: { type: 'number', description: 'Seconds to wait' }
      },
      required: ['action']
    }
  },
  {
    name: 'web_search',
    category: 'web',
    core: false,
    description: 'Search the internet (DuckDuckGo). Use for docs, error messages, library versions.',
    parameters: { type: 'object', properties: { query: str('Search query') }, required: ['query'] }
  },
  {
    name: 'web_fetch',
    category: 'web',
    core: false,
    description: 'Download a web page or API response and return it as readable text.',
    parameters: { type: 'object', properties: { url: str('URL') }, required: ['url'] }
  },
  {
    name: 'install_tool',
    category: 'command',
    core: true,
    description: 'Install a developer tool on the PC when it is missing: node (portable Node.js LTS + npm), git, python, pnpm, yarn, go, rust, java, dotnet, php, bun, deno, cmake, ffmpeg, 7zip, or any winget package id.',
    parameters: { type: 'object', properties: { name: str('Tool name, e.g. "node"') }, required: ['name'] }
  },
  {
    name: 'extract_archive',
    category: 'edit',
    core: true,
    description: 'Unpack a .zip/.7z/.rar/.tar(.gz) archive (for example a user attachment) into a folder (default: a new folder in the project).',
    parameters: { type: 'object', properties: { path: str('Archive path'), destination: str('Target folder') }, required: ['path'] }
  },
  {
    name: 'todo_write',
    category: 'meta',
    core: true,
    description: 'Create/update the task plan shown to the user. Send the FULL list each time. Use it for any task with 3+ steps; keep exactly one item in_progress.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'Full todo list',
          items: {
            type: 'object',
            properties: { content: str('Task description'), status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Status' } },
            required: ['content', 'status']
          }
        }
      },
      required: ['todos']
    }
  },
  {
    name: 'ask_user',
    category: 'meta',
    core: true,
    description: 'Ask the user a question and wait for the answer. Only use it when you truly cannot proceed without a decision; otherwise choose sensible defaults yourself.',
    parameters: { type: 'object', properties: { question: str('Question'), options: { type: 'array', items: { type: 'string' }, description: 'Optional answer choices' } }, required: ['question'] }
  }
];

export const toolCategory = (name: string): ToolCategory => TOOL_SPECS.find((t) => t.name === name)?.category || 'meta';

export function toolsFor(opts: { compact: boolean }): ToolDef[] {
  return TOOL_SPECS.filter((t) => !opts.compact || t.core).map(({ name, description, parameters }) => ({ name, description, parameters }));
}

// ------------------------------------------------------------ execution

export interface ToolContext {
  chatId: string;
  projectRoot: string;
  turnId: string;
  signal: AbortSignal;
  settings: Settings;
  mode: AgentMode;
  vision: boolean;
  maxChars: number;
  live(text: string): void;
  ask(question: string, options?: string[]): Promise<string>;
  setTodos(todos: Todo[]): void;
}

export function resolvePath(p: string | undefined, root: string) {
  if (!p || !String(p).trim()) return root;
  let s = String(p).trim().replace(/^["'`]+|["'`]+$/g, '');
  if (s.startsWith('~')) s = path.join(os.homedir(), s.slice(1));
  if (s.startsWith('/') && !s.startsWith('//') && process.platform === 'win32' && !/^\/[a-z]:/i.test(s)) s = s.replace(/^\/+/, ''); // "/src/x" → project-relative
  return path.isAbsolute(s) ? path.normalize(s) : path.resolve(root, s);
}

export function displayPath(abs: string, root: string) {
  return isSubPath(root, abs) ? toPosix(path.relative(root, abs)) || '.' : abs;
}

function needString(v: any, name: string): string {
  if (typeof v === 'string') return v;
  if (v === undefined || v === null) throw new Error(`Missing required parameter "${name}"`);
  if (typeof v === 'object') return JSON.stringify(v, null, 2);
  return String(v);
}

const ok = (text: string, meta?: ToolResult['meta'], images?: ToolResult['images']): ToolResult => ({ text, meta, images });
const fail = (text: string, meta?: ToolResult['meta']): ToolResult => ({ text, isError: true, meta });

async function readTextIfExists(p: string): Promise<{ text: string | null; crlf: boolean }> {
  try {
    const buf = await fsp.readFile(p);
    if (looksBinary(buf)) return { text: null, crlf: false };
    let t = buf.toString('utf8');
    if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    return { text: t, crlf: t.includes('\r\n') };
  } catch {
    return { text: null, crlf: false };
  }
}

function notifyFile(ctx: ToolContext, abs: string, kind: string) {
  emit('agent:file', { chatId: ctx.chatId, path: abs, kind });
}

async function tree(root: string, depth: number, limit = 600): Promise<{ text: string; count: number }> {
  const lines: string[] = [];
  let count = 0;
  const walk = async (dir: string, level: number) => {
    if (count >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));
    for (const e of entries) {
      if (count >= limit) {
        lines.push('  '.repeat(level) + '…');
        return;
      }
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      count++;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) {
          lines.push(`${'  '.repeat(level)}${e.name}/ (skipped)`);
          continue;
        }
        lines.push(`${'  '.repeat(level)}${e.name}/`);
        if (level + 1 < depth) await walk(p, level + 1);
      } else {
        let size = '';
        try {
          size = ` (${formatBytes((await fsp.stat(p)).size)})`;
        } catch {
          /* ignore */
        }
        lines.push(`${'  '.repeat(level)}${e.name}${size}`);
      }
    }
  };
  await walk(root, 0);
  return { text: lines.join('\n') || '(empty folder)', count };
}

function imageResult(file: string, vision: boolean): ToolResult {
  // decode from a buffer: nativeImage.createFromPath fails for paths longer than MAX_PATH
  let img: Electron.NativeImage;
  try {
    img = nativeImage.createFromBuffer(fs.readFileSync(file));
  } catch {
    return fail(`Could not read image ${file}`);
  }
  if (img.isEmpty()) return fail(`Could not decode image ${file}`);
  const { width, height } = img.getSize();
  if (!vision) return ok(`Image file ${path.basename(file)} (${width}×${height}). The current model cannot view images.`, { kind: 'read' });
  if (width > 1400 || height > 1400) img = img.resize(width >= height ? { width: 1400 } : { height: 1400 });
  const blobId = saveBlob(img.toPNG(), 'image/png');
  return ok(`Image ${path.basename(file)} (${width}×${height})`, { kind: 'read' }, [{ blobId, mime: 'image/png' }]);
}

const NEEDS_CRLF = new Set(['.bat', '.cmd']);

export async function executeTool(name: string, input: any, ctx: ToolContext): Promise<ToolResult> {
  const root = ctx.projectRoot;
  input = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'list_files': {
      const dir = resolvePath(input.path, root);
      const st = await fsp.stat(dir).catch(() => null);
      if (!st) return fail(`Path not found: ${displayPath(dir, root)}`);
      if (!st.isDirectory()) return fail(`Not a directory: ${displayPath(dir, root)}`);
      const depth = Math.max(1, Math.min(6, Number(input.depth) || 2));
      const t = await tree(dir, depth);
      return ok(`${displayPath(dir, root)}/\n${t.text}`, { kind: 'list', path: displayPath(dir, root), count: t.count });
    }
    case 'read_file': {
      const file = resolvePath(needString(input.path, 'path'), root);
      const st = await fsp.stat(file).catch(() => null);
      if (!st) return fail(`File not found: ${displayPath(file, root)}`);
      if (st.isDirectory()) return fail(`${displayPath(file, root)} is a directory — use list_files.`);
      const ext = path.extname(file).toLowerCase();
      if (IMAGE_EXT.has(ext)) return imageResult(file, ctx.vision);
      if (st.size > 20 * 1024 * 1024) return fail(`File is too large (${formatBytes(st.size)}). Use search or read a smaller range.`);
      const buf = await fsp.readFile(file);
      if (looksBinary(buf)) return ok(`Binary file ${displayPath(file, root)} (${formatBytes(st.size)}) — content not shown.`, { kind: 'read', path: displayPath(file, root) });
      let text = buf.toString('utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const lines = text.split(/\r?\n/);
      const s = Math.max(1, Number(input.start_line) || 1);
      const e = Math.min(lines.length, Number(input.end_line) || lines.length);
      let body = lines.slice(s - 1, e).join('\n');
      let note = '';
      if (body.length > ctx.maxChars) {
        const cut = body.slice(0, ctx.maxChars);
        const shownLines = cut.split('\n').length;
        body = cut;
        note = `\n\n[Showing lines ${s}-${s + shownLines - 1} of ${lines.length}. Read more with start_line=${s + shownLines - 1}.]`;
      } else if (s > 1 || e < lines.length) note = `\n\n[Lines ${s}-${e} of ${lines.length}]`;
      return ok(body + note, { kind: 'read', path: displayPath(file, root), lines: lines.length });
    }
    case 'write_file': {
      const file = resolvePath(needString(input.path, 'path'), root);
      let content = needString(input.content ?? '', 'content');
      const st = await fsp.stat(file).catch(() => null);
      if (st?.isDirectory()) return fail(`${displayPath(file, root)} is a directory.`);
      await snapshot(ctx.chatId, ctx.turnId, file);
      const old = await readTextIfExists(file);
      const ext = path.extname(file).toLowerCase();
      if ((old.crlf || NEEDS_CRLF.has(ext)) && !content.includes('\r\n')) content = content.replace(/\n/g, '\r\n');
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, content, 'utf8');
      const d = summarizeDiff(st ? old.text ?? '' : null, content);
      notifyFile(ctx, file, st ? 'modified' : 'created');
      const rel = displayPath(file, root);
      return ok(st ? `Updated ${rel} (+${d.added} −${d.removed})` : `Created ${rel} (${content.split(/\r?\n/).length} lines)`, {
        kind: 'write',
        path: rel,
        added: d.added,
        removed: d.removed,
        diff: d.preview,
        created: !st,
        outsideProject: !isSubPath(root, file)
      });
    }
    case 'edit_file': {
      const file = resolvePath(needString(input.path, 'path'), root);
      const cur = await readTextIfExists(file);
      const exists = fs.existsSync(file);
      if (!exists) {
        if (!input.old_text) {
          // treat as create
          return executeTool('write_file', { path: input.path, content: input.new_text ?? '' }, ctx);
        }
        return fail(`File not found: ${displayPath(file, root)}. Use write_file to create it.`);
      }
      if (cur.text === null) return fail('Cannot edit a binary file.');
      const edits: { old_text: string; new_text: string; replace_all?: boolean }[] = Array.isArray(input.edits) && input.edits.length ? input.edits : [{ old_text: input.old_text, new_text: input.new_text, replace_all: input.replace_all }];
      let lf = cur.text.replace(/\r\n/g, '\n');
      const original = lf;
      for (const ed of edits) {
        const oldT = needString(ed.old_text ?? '', 'old_text').replace(/\r\n/g, '\n');
        const newT = needString(ed.new_text ?? '', 'new_text').replace(/\r\n/g, '\n');
        if (!oldT) {
          if (!lf.trim()) {
            lf = newT;
            continue;
          }
          return fail('old_text is empty. Provide the exact text to replace (or use write_file).');
        }
        let count = lf.split(oldT).length - 1;
        if (count === 0) {
          // fuzzy: ignore trailing whitespace differences
          const norm = (s: string) => s.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
          const nLf = norm(lf);
          const nOld = norm(oldT);
          const idx = nLf.indexOf(nOld);
          if (idx >= 0 && nLf.indexOf(nOld, idx + 1) < 0) {
            // map back by line numbers
            const startLine = nLf.slice(0, idx).split('\n').length - 1;
            const lineCount = nOld.split('\n').length;
            const arr = lf.split('\n');
            arr.splice(startLine, lineCount, ...newT.split('\n'));
            lf = arr.join('\n');
            continue;
          }
          // try with trimmed indentation
          const firstLine = oldT.split('\n').find((l) => l.trim())?.trim() || '';
          const hintIdx = firstLine ? lf.split('\n').findIndex((l) => l.includes(firstLine)) : -1;
          const hint = hintIdx >= 0 ? `\nThe first line was found at line ${hintIdx + 1}:\n${lf.split('\n').slice(Math.max(0, hintIdx - 2), hintIdx + 6).join('\n')}` : '';
          return fail(`old_text was not found in ${displayPath(file, root)}. Read the file again and copy the exact text (whitespace matters).${hint}`);
        }
        if (count > 1 && !ed.replace_all) return fail(`old_text appears ${count} times in ${displayPath(file, root)}. Include more surrounding lines to make it unique, or set replace_all=true.`);
        lf = ed.replace_all ? lf.split(oldT).join(newT) : lf.replace(oldT, () => newT);
      }
      if (lf === original) return ok(`No changes made to ${displayPath(file, root)} (new text identical).`, { kind: 'edit', path: displayPath(file, root), added: 0, removed: 0 });
      await snapshot(ctx.chatId, ctx.turnId, file);
      const out = cur.crlf ? lf.replace(/\n/g, '\r\n') : lf;
      await fsp.writeFile(file, out, 'utf8');
      const d = summarizeDiff(original, lf);
      notifyFile(ctx, file, 'modified');
      const rel = displayPath(file, root);
      return ok(`Edited ${rel} (+${d.added} −${d.removed})`, { kind: 'edit', path: rel, added: d.added, removed: d.removed, diff: d.preview, outsideProject: !isSubPath(root, file) });
    }
    case 'delete_path': {
      const p = resolvePath(needString(input.path, 'path'), root);
      if (path.resolve(p) === path.resolve(root)) return fail('Refusing to delete the whole project folder.');
      const st = await fsp.stat(p).catch(() => null);
      if (!st) return fail(`Not found: ${displayPath(p, root)}`);
      await snapshot(ctx.chatId, ctx.turnId, p);
      try {
        await shell.trashItem(p);
      } catch {
        await fsp.rm(p, { recursive: true, force: true });
      }
      notifyFile(ctx, p, 'deleted');
      return ok(`Deleted ${displayPath(p, root)}${st.isDirectory() ? '/' : ''}`, { kind: 'delete', path: displayPath(p, root) });
    }
    case 'move_path': {
      const from = resolvePath(needString(input.from, 'from'), root);
      const to = resolvePath(needString(input.to, 'to'), root);
      if (!fs.existsSync(from)) return fail(`Not found: ${displayPath(from, root)}`);
      await snapshot(ctx.chatId, ctx.turnId, from);
      await snapshot(ctx.chatId, ctx.turnId, to);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
      notifyFile(ctx, to, 'created');
      notifyFile(ctx, from, 'deleted');
      return ok(`Moved ${displayPath(from, root)} → ${displayPath(to, root)}`, { kind: 'move', path: displayPath(to, root) });
    }
    case 'search': {
      const dir = resolvePath(input.path, root);
      const pattern = needString(input.pattern, 'pattern');
      let matches;
      try {
        matches = await searchFiles(dir, pattern, { regex: true, caseSensitive: !!input.case_sensitive, include: input.glob, maxResults: 300 });
      } catch {
        matches = await searchFiles(dir, pattern, { regex: false, caseSensitive: !!input.case_sensitive, include: input.glob, maxResults: 300 });
      }
      if (!matches.length) return ok(`No matches for /${pattern}/${input.glob ? ` in ${input.glob}` : ''}.`, { kind: 'search', count: 0 });
      const text = matches.map((m) => `${displayPath(m.path, root)}:${m.line}: ${m.text.trim().slice(0, 250)}`).join('\n');
      return ok(headText(text, ctx.maxChars) + (matches.length >= 300 ? '\n[results truncated at 300]' : ''), { kind: 'search', count: matches.length });
    }
    case 'find_files': {
      const pattern = needString(input.pattern, 'pattern');
      const files = await walkFiles(root, { maxFiles: 50000 });
      const re = globToRegExp(pattern);
      const hits = files.filter((f) => matchGlob(path.relative(root, f), pattern, re)).slice(0, 400);
      return ok(hits.length ? hits.map((f) => displayPath(f, root)).join('\n') : `No files match ${pattern}`, { kind: 'search', count: hits.length });
    }
    case 'run_command': {
      const command = needString(input.command, 'command').trim();
      if (!command) return fail('Empty command');
      const cwd = resolvePath(input.cwd, root);
      const timeoutSec = Math.max(5, Math.min(900, Number(input.timeout_sec) || ctx.settings.agent.commandTimeoutSec || 120));
      const r = await runCommand({ command, cwd, timeoutMs: timeoutSec * 1000, background: !!input.background, onOutput: (s) => ctx.live(s), signal: ctx.signal });
      const out = tailText(r.output.trim(), Math.min(14000, ctx.maxChars));
      const meta = { kind: 'command' as const, exitCode: r.exitCode, durationMs: r.durationMs, processId: r.processId, background: r.background };
      if (r.background) {
        const why = r.timedOut ? `still running after ${timeoutSec}s, so it was moved to the background` : 'started in the background';
        return ok(`Command ${why} as process ${r.processId}.\nOutput so far:\n${out || '(no output yet)'}\n\nUse process_output to check it later or stop_process to stop it.`, meta);
      }
      const head = `Exit code: ${r.exitCode}  (${(r.durationMs / 1000).toFixed(1)}s, ${r.shell})`;
      return { text: `${head}\n${out || '(no output)'}`, isError: r.exitCode !== 0, meta };
    }
    case 'process_output': {
      const id = needString(input.process_id, 'process_id');
      const r = processOutput(id);
      if (!r.found) return fail(`Unknown process ${id} (it may have finished and been cleaned up).`);
      const state = r.exited ? `exited with code ${r.exitCode}` : `running for ${Math.round((r.runningFor || 0) / 1000)}s`;
      return ok(`Process ${id} (${r.command}) — ${state}\nNew output:\n${tailText(r.output.trim(), 12000) || '(no new output)'}`, { kind: 'command', processId: id, exitCode: r.exitCode });
    }
    case 'stop_process': {
      const id = needString(input.process_id, 'process_id');
      return stopProcess(id) ? ok(`Stopped process ${id}`, { kind: 'command' }) : fail(`Unknown process ${id}`);
    }
    case 'browser': {
      const r = await browserAction(input, root, ctx.settings.agent.showBrowser);
      const images = r.image ? [r.image] : undefined;
      const note = ctx.vision ? '' : '\n(The current model cannot see images; rely on the console output and evaluate results.)';
      return { text: r.text + note, images, meta: { kind: 'browser', url: (input.url as string) || undefined } };
    }
    case 'open_preview': {
      const target = needString(input.target, 'target').trim();
      let url = target;
      if (!/^[a-z]+:\/\//i.test(target)) {
        if (/^(localhost|127\.0\.0\.1)(:\d+)?/i.test(target)) url = 'http://' + target;
        else {
          const abs = resolvePath(target, root);
          if (!fs.existsSync(abs)) return fail(`File not found: ${displayPath(abs, root)}`);
          url = await previewUrl(isSubPath(root, abs) ? root : path.dirname(abs), isSubPath(root, abs) ? path.relative(root, abs) : path.basename(abs));
        }
      }
      emit('agent:preview', { chatId: ctx.chatId, url });
      return ok(`Live preview opened for the user: ${url}`, { kind: 'preview', url });
    }
    case 'screenshot': {
      if (!ctx.settings.agent.allowDesktop) return fail('Desktop access is disabled in Lunarix settings (Agent → Desktop control).');
      const s = await screenshotDesktop();
      return ok(`Desktop screenshot ${s.width}×${s.height} (physical ${s.physW}×${s.physH}). Coordinates for the computer tool use this screenshot's pixels.`, { kind: 'screenshot' }, [{ blobId: s.blobId, mime: 'image/png' }]);
    }
    case 'computer': {
      if (!ctx.settings.agent.allowDesktop) return fail('Desktop control is disabled in Lunarix settings (Agent → Desktop control).');
      const s = await computerAction(input);
      return ok(`Done: ${input.action}. New screenshot ${s.width}×${s.height}.`, { kind: 'desktop' }, [{ blobId: s.blobId, mime: 'image/png' }]);
    }
    case 'web_search': {
      const q = needString(input.query, 'query');
      return ok(await webSearch(q, ctx.signal), { kind: 'web' });
    }
    case 'web_fetch': {
      const url = needString(input.url, 'url');
      return ok(headText(await webFetch(url, ctx.signal), ctx.maxChars), { kind: 'web', url });
    }
    case 'install_tool': {
      const n = needString(input.name, 'name');
      const r = await safeInstall(n, (s) => ctx.live(s + '\n'));
      return { text: r, isError: /failed|nie powiod/i.test(r), meta: { kind: 'install' } };
    }
    case 'extract_archive': {
      const src = resolvePath(needString(input.path, 'path'), root);
      if (!fs.existsSync(src)) return fail(`Archive not found: ${src}`);
      const base = path.basename(src).replace(/\.(zip|7z|rar|tgz|gz|bz2|xz|tar)$/gi, '').replace(/\.tar$/i, '');
      const dest = resolvePath(input.destination || base, root);
      await snapshot(ctx.chatId, ctx.turnId, dest);
      const n = await extractAnyArchive(src, dest);
      notifyFile(ctx, dest, 'created');
      const t = await tree(dest, 2, 200);
      return ok(`Extracted ${n} files to ${displayPath(dest, root)}\n${t.text}`, { kind: 'archive', path: displayPath(dest, root), count: n });
    }
    case 'todo_write': {
      let todos = input.todos;
      if (typeof todos === 'string') {
        try {
          todos = JSON.parse(todos);
        } catch {
          todos = todos
            .split('\n')
            .map((l: string) => l.trim())
            .filter(Boolean)
            .map((l: string) => ({ content: l.replace(/^[-*\d.)\s[\]x]+/i, ''), status: /\[x\]/i.test(l) ? 'completed' : 'pending' }));
        }
      }
      if (!Array.isArray(todos)) return fail('todos must be an array of {content, status}');
      // models spell statuses in many ways ("done", "Completed", "in-progress", "✓", checked: true…)
      const normStatus = (t: any): Todo['status'] => {
        const s = String(t.status ?? t.state ?? '').toLowerCase().replace(/[\s-]+/g, '_');
        if (/^(completed?|done|finished|ok|success|✓|✔|x|\[x\])$/.test(s) || t.done === true || t.completed === true || t.checked === true) return 'completed';
        if (/^(in_?progress|doing|active|current|running|working|started)$/.test(s)) return 'in_progress';
        return 'pending';
      };
      const clean: Todo[] = todos
        .map((t: any) => (typeof t === 'string' ? { content: t } : t))
        .filter((t: any) => t && (t.content || t.task || t.title || t.text))
        .map((t: any) => ({ content: String(t.content || t.task || t.title || t.text).slice(0, 300), status: normStatus(t) }));
      ctx.setTodos(clean);
      const done = clean.filter((t) => t.status === 'completed').length;
      const left = clean.length - done;
      return ok(
        left
          ? `Plan updated: ${done}/${clean.length} done. As soon as you finish an item, call todo_write again with the full list and mark it "completed".`
          : `Plan updated: all ${clean.length} items done.`,
        { kind: 'todo', count: clean.length }
      );
    }
    case 'ask_user': {
      const q = needString(input.question, 'question');
      const options = Array.isArray(input.options) ? input.options.map(String).slice(0, 8) : undefined;
      const answer = await ctx.ask(q, options);
      return ok(`User answered: ${answer}`, { kind: 'question' });
    }
    default:
      return fail(`Unknown tool "${name}". Available tools: ${TOOL_SPECS.map((t) => t.name).join(', ')}`);
  }
}

// --------------------------------------------------------- safety checks

const DANGEROUS = [
  /\b(format(\.com)?\s+[a-z]:|diskpart|bcdedit|bootrec|cipher\s+\/w|vssadmin\s+delete|wbadmin\s+delete|reg(\.exe)?\s+delete\s+hk(lm|ey_local)|takeown\s+\/f\s+[a-z]:\\windows|icacls\s+[a-z]:\\windows|shutdown(\.exe)?\s|stop-computer|restart-computer|clear-disk|initialize-disk|remove-partition|format-volume|set-mppreference|netsh\s+advfirewall\s+set|net\s+user\s+\S+\s+\/delete|mkfs|dd\s+if=)/i,
  /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|[a-z]:[\\/]?)(\s|$)/i,
  /remove-item\s+.*-recurse.*\s([a-z]:\\?|\$env:(systemroot|windir|userprofile|programfiles)|~)(\s|$|\\(windows|users|program files)\\?(\s|$))/i,
  /\b(rd|rmdir)\s+\/s\s+(\/q\s+)?[a-z]:\\?(\s|$)/i,
  /\bdel\s+(\/[fsqa]\s+)+[a-z]:\\(windows|users)?\\?\*?(\s|$)/i
];
const RISKY = [/git\s+push\s+.*(--force|-f\b)/i, /git\s+reset\s+--hard/i, /git\s+clean\s+-[a-z]*f/i, /\bnpm\s+publish\b/i, /\bdrop\s+(database|table)\b/i];

export function commandRisk(cmd: string): 'dangerous' | 'risky' | 'normal' {
  if (DANGEROUS.some((r) => r.test(cmd))) return 'dangerous';
  if (RISKY.some((r) => r.test(cmd))) return 'risky';
  return 'normal';
}
