import { nativeImage } from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import type { AttachmentInput, AttachmentKind, Block } from '@shared/types';
import { paths } from './paths';
import { saveBlob } from './store';
import { looksBinary, IGNORED_DIRS } from './fsService';
import { extractArchive } from './download';
import { formatBytes, safeFileName, isSubPath, toPosix, errMsg } from './util';
import { log } from './events';

type AttachmentBlock = Extract<Block, { type: 'attachment' }>;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const ARCHIVE_EXT = ['.zip', '.7z', '.rar', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.tar.gz', '.tar.xz', '.tar.bz2'];
const OFFICE_EXT = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp']);
const MAX_TEXT = 150_000;

function extOf(name: string) {
  const l = name.toLowerCase();
  for (const e of ['.tar.gz', '.tar.xz', '.tar.bz2']) if (l.endsWith(e)) return e;
  return path.extname(l);
}

function langOf(ext: string) {
  const map: Record<string, string> = {
    '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JSX', '.ts': 'TypeScript', '.tsx': 'TSX', '.php': 'PHP', '.html': 'HTML', '.htm': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
    '.cpp': 'C++', '.cc': 'C++', '.cxx': 'C++', '.hpp': 'C++', '.h': 'C/C++ header', '.c': 'C', '.cs': 'C#', '.java': 'Java', '.kt': 'Kotlin', '.py': 'Python', '.rb': 'Ruby', '.go': 'Go', '.rs': 'Rust',
    '.swift': 'Swift', '.dart': 'Dart', '.lua': 'Lua', '.sql': 'SQL', '.json': 'JSON', '.xml': 'XML', '.yml': 'YAML', '.yaml': 'YAML', '.md': 'Markdown', '.sh': 'Shell', '.ps1': 'PowerShell', '.bat': 'Batch',
    '.vue': 'Vue', '.svelte': 'Svelte', '.txt': 'Text', '.csv': 'CSV', '.ini': 'INI', '.toml': 'TOML', '.gd': 'GDScript', '.r': 'R', '.m': 'Objective-C', '.scala': 'Scala', '.asm': 'Assembly', '.svg': 'SVG'
  };
  return map[ext] || (ext ? ext.slice(1).toUpperCase() : 'File');
}

function chatDir(chatId: string) {
  const d = path.join(paths.attachments, path.basename(chatId));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function uniquePath(dir: string, name: string) {
  const base = safeFileName(name);
  let p = path.join(dir, base);
  let i = 2;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  while (fs.existsSync(p)) p = path.join(dir, `${stem} (${i++})${ext}`);
  return p;
}

function xmlText(xml: string, para = /<\/(w:p|a:p|text:p|text:h)>/g) {
  return xml
    .replace(para, '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function officeText(buf: Buffer, ext: string): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  if (ext === '.docx') {
    const doc = await zip.file('word/document.xml')?.async('string');
    return doc ? xmlText(doc) : '';
  }
  if (ext === '.pptx') {
    const slides = Object.keys(zip.files)
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => Number(/\d+/.exec(a.split('/').pop()!)![0]) - Number(/\d+/.exec(b.split('/').pop()!)![0]));
    const out: string[] = [];
    for (const s of slides) out.push(`--- ${path.basename(s, '.xml')} ---\n` + xmlText((await zip.file(s)!.async('string')) || ''));
    return out.join('\n\n');
  }
  if (ext === '.xlsx') {
    const shared: string[] = [];
    const ss = await zip.file('xl/sharedStrings.xml')?.async('string');
    if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlText(m[1]));
    const sheets = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f));
    const out: string[] = [];
    for (const s of sheets) {
      const xml = (await zip.file(s)!.async('string')) || '';
      const rows: string[] = [];
      for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells: string[] = [];
        for (const c of r[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
          const attrs = c[1];
          const v = /<v>([\s\S]*?)<\/v>/.exec(c[2])?.[1] ?? xmlText(c[2]);
          cells.push(/t="s"/.test(attrs) ? shared[Number(v)] ?? '' : v);
        }
        rows.push(cells.join('\t'));
        if (rows.length > 2000) break;
      }
      out.push(`--- ${path.basename(s, '.xml')} ---\n${rows.join('\n')}`);
    }
    return out.join('\n\n');
  }
  // OpenDocument
  const content = await zip.file('content.xml')?.async('string');
  return content ? xmlText(content) : '';
}

async function pdfText(buf: Buffer): Promise<string> {
  try {
    const unpdf: any = await import('unpdf');
    const pdf = await unpdf.getDocumentProxy(new Uint8Array(buf));
    const r = await unpdf.extractText(pdf, { mergePages: false });
    const pages: string[] = Array.isArray(r.text) ? r.text : [String(r.text)];
    return pages.map((t, i) => `--- strona ${i + 1} ---\n${t}`).join('\n\n');
  } catch (e) {
    log('pdf extract failed', e);
    return '';
  }
}

const PRIORITY = /(^|\/)(package\.json|readme(\.md)?|composer\.json|requirements\.txt|pyproject\.toml|cargo\.toml|index\.(html|php|js|ts|tsx|jsx)|main\.\w+|app\.\w+|program\.cs|\w+\.csproj|cmakelists\.txt|makefile)$/i;

async function describeTree(root: string): Promise<{ listing: string; inline: string; count: number; totalSize: number }> {
  const files: { rel: string; size: number }[] = [];
  const walk = async (d: string) => {
    if (files.length > 5000) return;
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name === '__MACOSX') continue;
        await walk(p);
      } else {
        const st = await fsp.stat(p);
        files.push({ rel: toPosix(path.relative(root, p)), size: st.size });
      }
    }
  };
  await walk(root);
  files.sort((a, b) => a.rel.localeCompare(b.rel));
  const listing = files
    .slice(0, 400)
    .map((f) => `${f.rel} (${formatBytes(f.size)})`)
    .join('\n') + (files.length > 400 ? `\n… i ${files.length - 400} więcej plików` : '');
  // inline the most relevant small text files
  const ordered = [...files].sort((a, b) => Number(PRIORITY.test(b.rel)) - Number(PRIORITY.test(a.rel)) || a.size - b.size);
  let budget = 90_000;
  const parts: string[] = [];
  for (const f of ordered) {
    if (budget <= 0) break;
    if (f.size > 40_000 || f.size === 0) continue;
    const abs = path.join(root, f.rel);
    const buf = await fsp.readFile(abs).catch(() => null);
    if (!buf || looksBinary(buf)) continue;
    const txt = buf.toString('utf8');
    parts.push(`<file path="${f.rel}">\n${txt}\n</file>`);
    budget -= txt.length;
  }
  return { listing, inline: parts.join('\n'), count: files.length, totalSize: files.reduce((s, f) => s + f.size, 0) };
}

async function extractZip(buf: Buffer, dest: string) {
  const zip = await JSZip.loadAsync(buf);
  let count = 0;
  let bytes = 0;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (count > 20000) break;
    const target = path.resolve(dest, name);
    if (!isSubPath(dest, target)) continue; // zip-slip protection
    if (entry.dir) {
      await fsp.mkdir(target, { recursive: true });
      continue;
    }
    const data = await entry.async('nodebuffer');
    bytes += data.length;
    if (bytes > 2 * 1024 ** 3) throw new Error('Archive too large to extract (>2 GB)');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, data);
    count++;
  }
  return count;
}

export async function extractAnyArchive(src: string, dest: string): Promise<number> {
  const ext = extOf(src);
  await fsp.mkdir(dest, { recursive: true });
  if (ext === '.zip') {
    const buf = await fsp.readFile(src);
    try {
      return await extractZip(buf, dest);
    } catch (e) {
      log('jszip failed, trying tar', errMsg(e));
    }
  }
  await extractArchive(src, dest);
  let n = 0;
  const count = async (d: string) => {
    for (const e of await fsp.readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) await count(path.join(d, e.name));
      else n++;
    }
  };
  await count(dest);
  return n;
}

async function processOne(chatId: string, input: AttachmentInput): Promise<AttachmentBlock> {
  const dir = chatDir(chatId);
  let name: string;
  let src: string;
  if (input.kind === 'data') {
    name = input.name || `wklejony-${Date.now()}.png`;
    src = uniquePath(dir, name);
    await fsp.writeFile(src, Buffer.from(input.data, 'base64'));
  } else {
    name = path.basename(input.path);
    const st = await fsp.stat(input.path);
    if (st.isDirectory()) {
      const tree = await describeTree(input.path);
      return {
        type: 'attachment',
        name,
        size: tree.totalSize,
        kind: 'archive',
        summary: `Folder · ${tree.count} plików`,
        savedPath: input.path,
        modelText: `<attachment type="folder" name="${name}" path="${input.path}" files="${tree.count}">\nFile list:\n${tree.listing}\n\nKey files:\n${tree.inline}\n</attachment>`
      };
    }
    if (st.size <= 300 * 1024 * 1024) {
      src = uniquePath(dir, name);
      await fsp.copyFile(input.path, src);
    } else src = input.path;
  }
  const ext = extOf(name);
  const size = (await fsp.stat(src)).size;

  if (IMAGE_EXT.has(ext)) {
    // decode from a buffer: nativeImage.createFromPath fails for paths longer than MAX_PATH
    let img = nativeImage.createEmpty();
    try {
      img = nativeImage.createFromBuffer(await fsp.readFile(src));
    } catch {
      /* handled below */
    }
    if (img.isEmpty()) {
      return { type: 'attachment', name, size, kind: 'binary', summary: `${ext.slice(1).toUpperCase()} · ${formatBytes(size)}`, savedPath: src, modelText: `<attachment name="${name}" path="${src}" type="image">(nie udało się odczytać obrazu)</attachment>` };
    }
    const { width, height } = img.getSize();
    if (width > 1600 || height > 1600) img = img.resize(width >= height ? { width: 1600, quality: 'good' } : { height: 1600, quality: 'good' });
    const isPhoto = ext === '.jpg' || ext === '.jpeg';
    const buf = isPhoto ? img.toJPEG(88) : img.toPNG();
    const mime = isPhoto ? 'image/jpeg' : 'image/png';
    const blobId = saveBlob(buf, mime);
    return {
      type: 'attachment',
      name,
      size,
      kind: 'image',
      summary: `${ext.slice(1).toUpperCase()} · ${width}×${height}`,
      savedPath: src,
      images: [{ blobId, mime }],
      modelText: `<attachment name="${name}" type="image" width="${width}" height="${height}" path="${src}" />`
    };
  }

  if (ARCHIVE_EXT.includes(ext)) {
    const dest = uniquePath(dir, name.replace(/\.(zip|7z|rar|tar|gz|tgz|bz2|xz)$/i, '').replace(/\.tar$/i, '') + '_extracted');
    try {
      const count = await extractAnyArchive(src, dest);
      const tree = await describeTree(dest);
      return {
        type: 'attachment',
        name,
        size,
        kind: 'archive',
        summary: `${ext.slice(1).toUpperCase()} · ${count} plików · ${formatBytes(size)}`,
        savedPath: dest,
        modelText:
          `<attachment type="archive" name="${name}" size="${formatBytes(size)}" extracted_to="${dest}" files="${count}">\n` +
          `The archive was extracted to: ${dest}\nUse read_file with absolute paths to read more, or extract_archive to unpack it into the project.\n\nFile list:\n${tree.listing}\n\nContents of key files:\n${tree.inline}\n</attachment>`
      };
    } catch (e) {
      return { type: 'attachment', name, size, kind: 'archive', summary: `${ext.slice(1).toUpperCase()} · ${formatBytes(size)}`, savedPath: src, modelText: `<attachment type="archive" name="${name}" path="${src}">Could not extract: ${errMsg(e)}</attachment>` };
    }
  }

  const buf = size <= 60 * 1024 * 1024 ? await fsp.readFile(src) : null;
  if (buf && ext === '.pdf') {
    const text = await pdfText(buf);
    const pages = (text.match(/--- strona/g) || []).length;
    return {
      type: 'attachment',
      name,
      size,
      kind: 'document',
      summary: `PDF · ${pages || '?'} str. · ${formatBytes(size)}`,
      savedPath: src,
      modelText: `<attachment type="pdf" name="${name}" path="${src}" pages="${pages}">\n${text ? text.slice(0, MAX_TEXT) : '(no extractable text — the PDF may be scanned images)'}${text.length > MAX_TEXT ? '\n…[truncated]' : ''}\n</attachment>`
    };
  }
  if (buf && OFFICE_EXT.has(ext)) {
    let text = '';
    try {
      text = await officeText(buf, ext);
    } catch (e) {
      text = `(could not read document: ${errMsg(e)})`;
    }
    return {
      type: 'attachment',
      name,
      size,
      kind: 'document',
      summary: `${ext.slice(1).toUpperCase()} · ${formatBytes(size)}`,
      savedPath: src,
      modelText: `<attachment type="document" name="${name}" path="${src}">\n${text.slice(0, MAX_TEXT)}${text.length > MAX_TEXT ? '\n…[truncated]' : ''}\n</attachment>`
    };
  }
  if (buf && !looksBinary(buf)) {
    let text = buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const lines = text.split(/\r?\n/).length;
    const kind: AttachmentKind = 'text';
    const truncated = text.length > MAX_TEXT;
    return {
      type: 'attachment',
      name,
      size,
      kind,
      summary: `${langOf(ext)} · ${lines} linii · ${formatBytes(size)}`,
      savedPath: src,
      modelText: `<attachment name="${name}" language="${langOf(ext)}" lines="${lines}" path="${src}">\n${truncated ? text.slice(0, MAX_TEXT) + `\n…[truncated — full file at ${src}]` : text}\n</attachment>`
    };
  }
  return {
    type: 'attachment',
    name,
    size,
    kind: 'binary',
    summary: `${ext ? ext.slice(1).toUpperCase() : 'Plik'} · ${formatBytes(size)}`,
    savedPath: src,
    modelText: `<attachment name="${name}" type="binary" size="${formatBytes(size)}" path="${src}">Binary file — content not shown. It is available at the path above.</attachment>`
  };
}

export async function processAttachments(chatId: string, inputs: AttachmentInput[]): Promise<AttachmentBlock[]> {
  const out: AttachmentBlock[] = [];
  for (const i of inputs) {
    try {
      out.push(await processOne(chatId, i));
    } catch (e) {
      const name = i.kind === 'path' ? path.basename(i.path) : i.name;
      out.push({ type: 'attachment', name, size: 0, kind: 'binary', summary: 'Błąd odczytu', modelText: `<attachment name="${name}">Could not read attachment: ${errMsg(e)}</attachment>` });
    }
  }
  return out;
}
