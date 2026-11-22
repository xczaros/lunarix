import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Chat, TurnChange } from '@shared/types';
import { paths } from '../paths';
import { looksBinary } from '../fsService';
import { readJson, writeJsonAtomic } from '../util';

interface Entry {
  existed: boolean;
  dir?: boolean;
  data?: string; // base64
  skipped?: boolean; // too large to snapshot
  at: number;
}
interface TurnRecord {
  entries: Record<string, Entry>;
}

const cache = new Map<string, TurnRecord>();
const MAX_FILE = 12 * 1024 * 1024;
const MAX_DIR_FILES = 400;

function file(chatId: string, turnId: string) {
  return path.join(paths.checkpoints, path.basename(chatId), `${path.basename(turnId)}.json`);
}

function load(chatId: string, turnId: string): TurnRecord {
  const key = `${chatId}/${turnId}`;
  let r = cache.get(key);
  if (!r) {
    r = readJson<TurnRecord>(file(chatId, turnId), { entries: {} });
    cache.set(key, r);
  }
  return r;
}

function persist(chatId: string, turnId: string, r: TurnRecord) {
  writeJsonAtomic(file(chatId, turnId), r);
}

async function snapEntry(abs: string): Promise<Entry> {
  try {
    const st = await fsp.stat(abs);
    if (st.isDirectory()) return { existed: true, dir: true, at: Date.now() };
    if (st.size > MAX_FILE) return { existed: true, skipped: true, at: Date.now() };
    const buf = await fsp.readFile(abs);
    return { existed: true, data: buf.toString('base64'), at: Date.now() };
  } catch {
    return { existed: false, at: Date.now() };
  }
}

/** Record the state of a path before the agent modifies it during a turn. */
export async function snapshot(chatId: string, turnId: string, abs: string) {
  const r = load(chatId, turnId);
  const key = path.resolve(abs);
  if (r.entries[key]) return;
  const e = await snapEntry(key);
  r.entries[key] = e;
  if (e.dir) {
    // snapshot contained files (bounded) so a directory delete can be undone
    let count = 0;
    const walk = async (d: string) => {
      if (count > MAX_DIR_FILES) return;
      let items: fs.Dirent[] = [];
      try {
        items = await fsp.readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const it of items) {
        const p = path.join(d, it.name);
        if (it.isDirectory()) {
          if (it.name === 'node_modules' || it.name === '.git') continue;
          await walk(p);
        } else if (!r.entries[p] && count++ <= MAX_DIR_FILES) {
          r.entries[p] = await snapEntry(p);
        }
      }
    };
    await walk(key);
  }
  persist(chatId, turnId, r);
}

async function restoreRecord(r: TurnRecord): Promise<number> {
  let n = 0;
  // restore files; deepest paths first for removals, shallow first for creation
  const keys = Object.keys(r.entries).sort((a, b) => a.length - b.length);
  for (const k of keys) {
    const e = r.entries[k];
    if (e.dir && e.existed) {
      await fsp.mkdir(k, { recursive: true }).catch(() => {});
    }
  }
  for (const k of keys) {
    const e = r.entries[k];
    try {
      if (e.dir) continue;
      if (!e.existed) {
        const st = await fsp.stat(k).catch(() => null);
        if (st) {
          await fsp.rm(k, { recursive: true, force: true });
          n++;
        }
      } else if (e.data !== undefined) {
        await fsp.mkdir(path.dirname(k), { recursive: true });
        await fsp.writeFile(k, Buffer.from(e.data, 'base64'));
        n++;
      }
    } catch {
      /* best effort */
    }
  }
  // remove directories that did not exist before
  for (const k of [...keys].reverse()) {
    const e = r.entries[k];
    if (!e.existed) {
      try {
        const st = await fsp.stat(k);
        if (st.isDirectory()) await fsp.rm(k, { recursive: true, force: true });
      } catch {
        /* gone */
      }
    }
  }
  return n;
}

/** Restore project files to the state before `messageId` (a user message) was sent. */
export async function restoreFrom(chat: Chat, messageId: string): Promise<number> {
  const userIds = chat.messages.filter((m) => m.role === 'user').map((m) => m.id);
  const idx = userIds.indexOf(messageId);
  if (idx < 0) return 0;
  let total = 0;
  for (let i = userIds.length - 1; i >= idx; i--) {
    const r = load(chat.id, userIds[i]);
    if (Object.keys(r.entries).length) total += await restoreRecord(r);
  }
  return total;
}

export async function changesFor(chatId: string, turnId: string): Promise<TurnChange[]> {
  const r = load(chatId, turnId);
  const out: TurnChange[] = [];
  for (const [p, e] of Object.entries(r.entries)) {
    if (e.dir) continue;
    let before: string | null = null;
    let binary = false;
    if (e.existed && e.data !== undefined) {
      const buf = Buffer.from(e.data, 'base64');
      binary = looksBinary(buf);
      before = binary ? '' : buf.toString('utf8');
    } else if (e.existed && e.skipped) {
      binary = true;
      before = '';
    }
    let after: string | null = null;
    try {
      const buf = await fsp.readFile(p);
      if (looksBinary(buf)) binary = true;
      after = binary ? '' : buf.toString('utf8');
    } catch {
      after = null;
    }
    if (before === after) continue;
    out.push({ path: p, before, after, binary });
  }
  return out;
}

export function hasChanges(chatId: string, turnId: string) {
  return Object.keys(load(chatId, turnId).entries).length > 0;
}
