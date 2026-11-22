import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Chat, ChatMeta, ModelRef, Project, AgentMode } from '@shared/types';
import { paths } from './paths';
import { settings } from './settings';
import { JsonStore, readJson, safeFileName, uid, writeJsonAtomic, debounce } from './util';
import { emit } from './events';

// ------------------------------------------------------------------ blobs

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg'
};

export function saveBlob(buf: Buffer, mime: string): string {
  const hash = createHash('sha1').update(buf).digest('hex').slice(0, 24);
  const id = `${hash}.${EXT_BY_MIME[mime] || 'bin'}`;
  const p = path.join(paths.blobs, id);
  if (!fs.existsSync(p)) fs.writeFileSync(p, buf);
  return id;
}

export function blobPath(id: string) {
  const safe = path.basename(id);
  return path.join(paths.blobs, safe);
}

export function readBlobBase64(id: string): string | null {
  try {
    return fs.readFileSync(blobPath(id)).toString('base64');
  } catch {
    return null;
  }
}

export function mimeOfBlob(id: string) {
  const ext = path.extname(id).slice(1).toLowerCase();
  return Object.entries(EXT_BY_MIME).find(([, e]) => e === ext)?.[0] || 'application/octet-stream';
}

// --------------------------------------------------------------- projects

let projectStore: JsonStore<{ projects: Project[] }>;
function projectsData() {
  if (!projectStore) projectStore = new JsonStore(path.join(paths.data, 'projects.json'), { projects: [] as Project[] });
  return projectStore.data;
}

export function listProjects(): Project[] {
  return [...projectsData().projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export function getProject(id: string): Project | undefined {
  return projectsData().projects.find((p) => p.id === id);
}

function uniqueDir(parent: string, name: string) {
  let base = safeFileName(name).trim() || 'Projekt';
  let candidate = path.join(parent, base);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${base} (${i++})`);
  }
  return candidate;
}

export function createProject(name: string, parentDir?: string, isDefault = false): Project {
  const root = parentDir || settings().projectsRoot || paths.defaultProjectsRoot;
  fs.mkdirSync(root, { recursive: true });
  const dir = isDefault ? path.join(root, name) : uniqueDir(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const p: Project = { id: uid('p_'), name: name.trim() || path.basename(dir), path: dir, createdAt: now, updatedAt: now, lastOpenedAt: now, isDefault };
  projectsData().projects.push(p);
  projectStore.save();
  emit('projects', listProjects());
  return p;
}

export function openFolderAsProject(dir: string): Project {
  const norm = path.resolve(dir);
  const existing = projectsData().projects.find((p) => path.resolve(p.path).toLowerCase() === norm.toLowerCase());
  if (existing) {
    existing.lastOpenedAt = Date.now();
    projectStore.save();
    emit('projects', listProjects());
    return existing;
  }
  fs.mkdirSync(norm, { recursive: true });
  const now = Date.now();
  const p: Project = { id: uid('p_'), name: path.basename(norm) || norm, path: norm, createdAt: now, updatedAt: now, lastOpenedAt: now };
  projectsData().projects.push(p);
  projectStore.save();
  emit('projects', listProjects());
  return p;
}

export function getDefaultProject(): Project {
  const existing = projectsData().projects.find((p) => p.isDefault);
  if (existing) {
    if (!fs.existsSync(existing.path)) fs.mkdirSync(existing.path, { recursive: true });
    return existing;
  }
  return createProject('Default Project', undefined, true);
}

export function renameProject(id: string, name: string): Project {
  const p = getProject(id);
  if (!p) throw new Error('Project not found');
  p.name = name.trim() || p.name;
  p.updatedAt = Date.now();
  projectStore.save();
  emit('projects', listProjects());
  return p;
}

export function removeProject(id: string) {
  const d = projectsData();
  d.projects = d.projects.filter((p) => p.id !== id);
  projectStore.save();
  for (const c of listChats(id)) deleteChat(c.id);
  emit('projects', listProjects());
}

export function touchProject(id: string) {
  const p = getProject(id);
  if (p) {
    p.lastOpenedAt = Date.now();
    projectStore.save();
  }
}

export function flushProjects() {
  projectStore?.flush();
  chatIndexStore?.flush();
  for (const id of dirtyChats) writeChatNow(id);
}

// ------------------------------------------------------------------ chats

let chatIndexStore: JsonStore<{ chats: ChatMeta[] }>;
function chatIndex() {
  if (!chatIndexStore) chatIndexStore = new JsonStore(path.join(paths.chats, 'index.json'), { chats: [] as ChatMeta[] });
  return chatIndexStore.data;
}

const cache = new Map<string, Chat>();
const dirtyChats = new Set<string>();

export function metaOf(c: Chat): ChatMeta {
  return {
    id: c.id,
    projectId: c.projectId,
    title: c.title,
    titleLocked: c.titleLocked,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    model: c.model,
    mode: c.mode,
    usage: c.usage,
    messageCount: c.messages.length,
    running: c.running,
    contextTokens: c.contextTokens
  };
}

export function listChats(projectId?: string): ChatMeta[] {
  const all = chatIndex().chats;
  return all.filter((c) => !projectId || c.projectId === projectId).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createChat(projectId: string, model: ModelRef, mode: AgentMode, title: string): Chat {
  const now = Date.now();
  const chat: Chat = {
    id: uid('c_'),
    projectId,
    title,
    titleLocked: false,
    createdAt: now,
    updatedAt: now,
    model,
    mode,
    usage: { input: 0, output: 0 },
    messageCount: 0,
    messages: []
  };
  cache.set(chat.id, chat);
  chatIndex().chats.push(metaOf(chat));
  chatIndexStore.save();
  writeChatNow(chat.id);
  emit('chat:meta', metaOf(chat));
  return chat;
}

function chatFile(id: string) {
  return path.join(paths.chats, `${path.basename(id)}.json`);
}

export function getChat(id: string): Chat | null {
  if (cache.has(id)) return cache.get(id)!;
  const c = readJson<Chat | null>(chatFile(id), null);
  if (c) {
    c.running = false;
    cache.set(id, c);
  }
  return c;
}

function writeChatNow(id: string) {
  const c = cache.get(id);
  dirtyChats.delete(id);
  if (!c) return;
  writeJsonAtomic(chatFile(id), c);
}

const writers = new Map<string, ReturnType<typeof debounce>>();
export function saveChat(chat: Chat, opts: { touch?: boolean } = {}) {
  if (opts.touch !== false) chat.updatedAt = Date.now();
  chat.messageCount = chat.messages.length;
  cache.set(chat.id, chat);
  dirtyChats.add(chat.id);
  let w = writers.get(chat.id);
  if (!w) {
    w = debounce(() => writeChatNow(chat.id), 600);
    writers.set(chat.id, w);
  }
  w();
  const idx = chatIndex();
  const i = idx.chats.findIndex((m) => m.id === chat.id);
  const meta = metaOf(chat);
  if (i >= 0) idx.chats[i] = meta;
  else idx.chats.push(meta);
  chatIndexStore.save();
  emit('chat:meta', meta);
}

export function renameChat(id: string, title: string, lock = true): ChatMeta {
  const c = getChat(id);
  if (!c) throw new Error('Chat not found');
  c.title = title.trim().slice(0, 120) || c.title;
  if (lock) c.titleLocked = true;
  saveChat(c, { touch: false });
  return metaOf(c);
}

export function deleteChat(id: string) {
  cache.delete(id);
  dirtyChats.delete(id);
  const idx = chatIndex();
  idx.chats = idx.chats.filter((c) => c.id !== id);
  chatIndexStore.save();
  const safe = path.basename(id);
  fsp.rm(chatFile(safe), { force: true }).catch(() => {});
  fsp.rm(path.join(paths.attachments, safe), { recursive: true, force: true }).catch(() => {});
  fsp.rm(path.join(paths.checkpoints, safe), { recursive: true, force: true }).catch(() => {});
  emit('chat:deleted', { id });
}
