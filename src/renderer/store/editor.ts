import { create } from 'zustand';
import { basename } from '../lib/format';

export type TabKind = 'file' | 'preview' | 'diff' | 'markdown';

export interface Tab {
  id: string;
  kind: TabKind;
  title: string;
  path?: string;
  url?: string;
  diff?: { before: string; after: string; path: string; label?: string };
  dirty?: boolean;
  transient?: boolean; // preview tab (italic) replaced by the next quick open
}

interface EditorState {
  tabs: Tab[];
  active: string | null;
  reveal: { path: string; line: number; nonce: number } | null;
  flash: { path: string; nonce: number } | null;
  openFile(path: string, opts?: { line?: number; transient?: boolean; flash?: boolean }): void;
  openPreview(url: string, title?: string): void;
  openDiff(path: string, before: string, after: string, label?: string): void;
  openMarkdown(path: string): void;
  close(id: string): void;
  closeOthers(id: string): void;
  closeAll(): void;
  activate(id: string): void;
  setDirty(id: string, dirty: boolean): void;
  pin(id: string): void;
  renamePath(from: string, to: string): void;
  removePath(path: string): void;
}

const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();

export const useEditor = create<EditorState>((set, get) => ({
  tabs: [],
  active: null,
  reveal: null,
  flash: null,

  openFile(path, opts = {}) {
    const id = 'file:' + norm(path);
    const existing = get().tabs.find((t) => t.id === id);
    if (existing) {
      set({ active: id });
      if (!opts.transient && existing.transient) get().pin(id);
    } else {
      let tabs = get().tabs;
      if (opts.transient) {
        const tIdx = tabs.findIndex((t) => t.transient && !t.dirty);
        if (tIdx >= 0) tabs = tabs.filter((_, i) => i !== tIdx);
      }
      const activeIdx = tabs.findIndex((t) => t.id === get().active);
      const tab: Tab = { id, kind: 'file', title: basename(path), path, transient: opts.transient };
      const next = [...tabs];
      next.splice(activeIdx >= 0 ? activeIdx + 1 : next.length, 0, tab);
      set({ tabs: next, active: id });
    }
    if (opts.line) set({ reveal: { path, line: opts.line, nonce: Date.now() } });
    if (opts.flash) set({ flash: { path, nonce: Date.now() } });
  },

  openPreview(url, title) {
    const id = 'preview:' + url.replace(/\?.*$/, '').replace(/:\d+\//, ':*/');
    const existing = get().tabs.find((t) => t.kind === 'preview' && t.id === id);
    if (existing) {
      set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, url } : t)), active: id });
      return;
    }
    set({ tabs: [...get().tabs, { id, kind: 'preview', title: title || 'Preview', url }], active: id });
  },

  openDiff(path, before, after, label) {
    const id = 'diff:' + norm(path) + ':' + (label || '');
    const tab: Tab = { id, kind: 'diff', title: `${basename(path)} ↔`, path, diff: { before, after, path, label } };
    const others = get().tabs.filter((t) => t.id !== id);
    set({ tabs: [...others, tab], active: id });
  },

  openMarkdown(path) {
    const id = 'md:' + norm(path);
    if (!get().tabs.some((t) => t.id === id)) set({ tabs: [...get().tabs, { id, kind: 'markdown', title: basename(path) + ' ◉', path }] });
    set({ active: id });
  },

  close(id) {
    const tabs = get().tabs;
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const next = tabs.filter((t) => t.id !== id);
    let active = get().active;
    if (active === id) active = next[Math.min(idx, next.length - 1)]?.id || null;
    set({ tabs: next, active });
  },

  closeOthers(id) {
    set({ tabs: get().tabs.filter((t) => t.id === id || t.dirty), active: id });
  },

  closeAll() {
    const dirty = get().tabs.filter((t) => t.dirty);
    set({ tabs: dirty, active: dirty[0]?.id || null });
  },

  activate(id) {
    set({ active: id });
  },

  setDirty(id, dirty) {
    const t = get().tabs.find((x) => x.id === id);
    if (!t || !!t.dirty === dirty) return;
    set({ tabs: get().tabs.map((x) => (x.id === id ? { ...x, dirty, transient: dirty ? false : x.transient } : x)) });
  },

  pin(id) {
    set({ tabs: get().tabs.map((x) => (x.id === id ? { ...x, transient: false } : x)) });
  },

  renamePath(from, to) {
    const f = norm(from);
    set({
      tabs: get().tabs.map((t) => {
        if (t.path && (norm(t.path) === f || norm(t.path).startsWith(f + '\\'))) {
          const np = to + t.path.slice(from.length);
          return { ...t, path: np, title: basename(np), id: t.kind === 'file' ? 'file:' + norm(np) : t.id };
        }
        return t;
      })
    });
  },

  removePath(path) {
    const f = norm(path);
    const remove = get().tabs.filter((t) => t.path && !t.dirty && (norm(t.path) === f || norm(t.path).startsWith(f + '\\')));
    for (const t of remove) get().close(t.id);
  }
}));
