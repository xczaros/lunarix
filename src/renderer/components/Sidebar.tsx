import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  FilePlus2,
  FolderPlus,
  RefreshCw,
  ChevronsDownUp,
  ExternalLink,
  Copy,
  Pencil,
  Trash2,
  Eye,
  MessageSquarePlus,
  CaseSensitive,
  Regex,
  Plus,
  MessagesSquare,
  Sparkles,
  GitCommitHorizontal,
  Download,
  GitBranch,
  Loader2,
  FolderOpen,
  Search as SearchIcon
} from 'lucide-react';
import type { FsEntry, GitStatus, SearchMatch } from '@shared/types';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { api, on } from '../lib/api';
import { tx } from '../lib/i18n';
import { basename, dirname, joinPath, relPath, timeAgo } from '../lib/format';
import { bus, newFileInProject, newFolderInProject } from '../lib/commands';
import { confirmDialog, FileIcon, openMenu, promptText } from './ui';

export function Sidebar() {
  const view = useApp((s) => s.settings!.ui.sidebarView);
  return (
    <>
      {view === 'explorer' && <Explorer />}
      {view === 'search' && <SearchView />}
      {view === 'chats' && <ChatsView />}
      {view === 'git' && <GitView />}
    </>
  );
}

// =================================================================== explorer

const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();

function Explorer() {
  const project = useApp((s) => s.projects.find((p) => p.id === s.projectId));
  const root = project?.path || '';
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [flash, setFlash] = useState<Record<string, number>>({});
  const activeTab = useEditor((s) => s.tabs.find((t) => t.id === s.active));
  const loadingRef = useRef(new Set<string>());

  const load = useCallback(async (dir: string) => {
    if (loadingRef.current.has(norm(dir))) return;
    loadingRef.current.add(norm(dir));
    try {
      const list = await api.listDir(dir);
      setChildren((c) => ({ ...c, [norm(dir)]: list }));
    } catch {
      setChildren((c) => {
        const n = { ...c };
        delete n[norm(dir)];
        return n;
      });
    } finally {
      loadingRef.current.delete(norm(dir));
    }
  }, []);

  useEffect(() => {
    if (!root) return;
    setChildren({});
    setExpanded(new Set());
    load(root);
  }, [root, load]);

  const childrenRef = useRef(children);
  childrenRef.current = children;

  // refresh on file system changes
  useEffect(() => {
    let pending = new Map<string, string>();
    let timer: any = null;
    const off = on('fs:changed', ({ root: r, paths }: { root: string; paths: string[] }) => {
      if (!root || norm(r) !== norm(root)) return;
      for (const p of paths) pending.set(norm(dirname(p)), dirname(p));
      clearTimeout(timer);
      timer = setTimeout(() => {
        const dirs = pending;
        pending = new Map();
        for (const [k, orig] of dirs) {
          if (k === norm(root)) load(root);
          else if (childrenRef.current[k]) load(orig);
        }
      }, 150);
    });
    const off2 = on('agent:file', ({ path }: { path: string }) => {
      const k = norm(path);
      setFlash((f) => ({ ...f, [k]: Date.now() }));
      setTimeout(() => setFlash((f) => {
        const n = { ...f };
        delete n[k];
        return n;
      }), 1700);
      // auto-expand parents of files the agent touched
      if (root && k.startsWith(norm(root))) {
        const parts: string[] = [];
        const origs: string[] = [];
        let d = dirname(path);
        while (d && norm(d).startsWith(norm(root)) && norm(d) !== norm(root)) {
          parts.push(norm(d));
          origs.push(d);
          d = dirname(d);
        }
        if (parts.length) {
          setExpanded((e) => {
            const n = new Set(e);
            for (const p of parts) n.add(p);
            return n;
          });
          for (const p of origs) load(p);
        }
      }
    });
    return () => {
      off();
      off2();
      clearTimeout(timer);
    };
  }, [root, load]);

  const toggle = (p: string) => {
    const k = norm(p);
    setExpanded((e) => {
      const n = new Set(e);
      if (n.has(k)) n.delete(k);
      else {
        n.add(k);
        load(p);
      }
      return n;
    });
  };

  const doRename = async (entry: FsEntry, name: string) => {
    setRenaming(null);
    if (!name || name === entry.name) return;
    const to = joinPath(dirname(entry.path), name);
    try {
      await api.renamePath(entry.path, to);
      useEditor.getState().renamePath(entry.path, to);
    } catch (e: any) {
      useApp.getState().toast(e.message, 'error');
    }
  };

  const doDelete = async (entry: FsEntry) => {
    const ok = await confirmDialog(tx('Usunąć?', 'Delete?'), tx(`„${entry.name}” zostanie przeniesiony do Kosza.`, `"${entry.name}" will be moved to the Recycle Bin.`), tx('Usuń', 'Delete'), true);
    if (!ok) return;
    try {
      await api.deletePath(entry.path);
      useEditor.getState().removePath(entry.path);
    } catch (e: any) {
      useApp.getState().toast(e.message, 'error');
    }
  };

  const ctx = (e: React.MouseEvent, entry: FsEntry | null) => {
    const dir = entry ? (entry.isDir ? entry.path : dirname(entry.path)) : root;
    const items: any[] = [];
    if (entry && !entry.isDir) {
      items.push({ label: tx('Otwórz', 'Open'), onClick: () => useEditor.getState().openFile(entry.path) });
      if (/\.html?$/i.test(entry.name)) items.push({ label: tx('Podgląd na żywo', 'Live preview'), icon: <Eye size={14} />, onClick: async () => useEditor.getState().openPreview(await api.previewUrl(root, entry.path), entry.name) });
      if (/\.md$/i.test(entry.name)) items.push({ label: tx('Podgląd Markdown', 'Markdown preview'), icon: <Eye size={14} />, onClick: () => useEditor.getState().openMarkdown(entry.path) });
      items.push({ label: tx('Zapytaj agenta o ten plik', 'Ask the agent about this file'), icon: <MessageSquarePlus size={14} />, onClick: () => useApp.getState().fillComposer(`@${relPath(entry.path, root)} `) });
      items.push({ separator: true });
    }
    items.push({ label: tx('Nowy plik', 'New file'), icon: <FilePlus2 size={14} />, onClick: () => newFileInProject(dir) });
    items.push({ label: tx('Nowy folder', 'New folder'), icon: <FolderPlus size={14} />, onClick: () => newFolderInProject(dir) });
    items.push({ separator: true });
    if (entry) {
      items.push({ label: tx('Pokaż w Eksploratorze', 'Reveal in Explorer'), icon: <FolderOpen size={14} />, onClick: () => api.showInFolder(entry.path) });
      if (!entry.isDir) items.push({ label: tx('Otwórz w domyślnej aplikacji', 'Open with default app'), icon: <ExternalLink size={14} />, onClick: () => api.openPath(entry.path) });
      items.push({ label: tx('Kopiuj ścieżkę', 'Copy path'), icon: <Copy size={14} />, onClick: () => api.clipboardWrite(entry.path) });
      items.push({ label: tx('Kopiuj ścieżkę względną', 'Copy relative path'), onClick: () => api.clipboardWrite(relPath(entry.path, root)) });
      items.push({ separator: true });
      items.push({ label: tx('Zmień nazwę', 'Rename'), icon: <Pencil size={14} />, shortcut: 'F2', onClick: () => setRenaming(norm(entry.path)) });
      items.push({ label: tx('Usuń', 'Delete'), icon: <Trash2 size={14} />, shortcut: 'Del', danger: true, onClick: () => doDelete(entry) });
    } else {
      items.push({ label: tx('Otwórz folder projektu', 'Open project folder'), icon: <FolderOpen size={14} />, onClick: () => api.openPath(root) });
    }
    openMenu(e, items);
  };

  const rows: { entry: FsEntry; depth: number }[] = useMemo(() => {
    const out: { entry: FsEntry; depth: number }[] = [];
    const walk = (dir: string, depth: number) => {
      for (const e of children[norm(dir)] || []) {
        out.push({ entry: e, depth });
        if (e.isDir && expanded.has(norm(e.path))) walk(e.path, depth + 1);
      }
    };
    if (root) walk(root, 0);
    return out;
  }, [children, expanded, root]);

  const activePath = activeTab?.path ? norm(activeTab.path) : '';

  const onKeyDown = (e: React.KeyboardEvent) => {
    const sel = rows.find((r) => norm(r.entry.path) === selected);
    if (!sel || renaming) return;
    if (e.key === 'F2') setRenaming(selected);
    else if (e.key === 'Delete') doDelete(sel.entry);
    else if (e.key === 'Enter') sel.entry.isDir ? toggle(sel.entry.path) : useEditor.getState().openFile(sel.entry.path);
  };

  if (!project) return null;
  const rootLoaded = !!children[norm(root)];
  return (
    <>
      <div className="panel-head">
        <span className="title">{project.name}</span>
        <button className="icon-btn sm" data-tip={tx('Nowy plik', 'New file')} onClick={() => newFileInProject()}>
          <FilePlus2 size={14} />
        </button>
        <button className="icon-btn sm" data-tip={tx('Nowy folder', 'New folder')} onClick={() => newFolderInProject()}>
          <FolderPlus size={14} />
        </button>
        <button className="icon-btn sm" data-tip={tx('Odśwież', 'Refresh')} onClick={() => {
            load(root);
            for (const r of rows) if (r.entry.isDir && expanded.has(norm(r.entry.path))) load(r.entry.path);
          }}>
          <RefreshCw size={13} />
        </button>
        <button className="icon-btn sm" data-tip={tx('Zwiń wszystko', 'Collapse all')} onClick={() => setExpanded(new Set())}>
          <ChevronsDownUp size={14} />
        </button>
      </div>
      <div className="scroll grow tree" tabIndex={0} onKeyDown={onKeyDown} onContextMenu={(e) => e.target === e.currentTarget && ctx(e, null)}>
        {rootLoaded && rows.length === 0 && (
          <div className="tree-empty">
            {tx('Projekt jest pusty. Opisz agentowi, co ma zbudować — pliki pojawią się tutaj na żywo.', 'The project is empty. Describe what to build — files will appear here live.')}
            <div className="row" style={{ marginTop: 12, gap: 6 }}>
              <button className="btn sm" onClick={() => newFileInProject()}>
                <FilePlus2 size={13} /> {tx('Nowy plik', 'New file')}
              </button>
              <button className="btn sm" onClick={() => api.openPath(root)}>
                <FolderOpen size={13} /> {tx('Otwórz folder', 'Open folder')}
              </button>
            </div>
          </div>
        )}
        {rows.map(({ entry, depth }) => (
          <TreeRow
            key={entry.path}
            entry={entry}
            depth={depth}
            open={expanded.has(norm(entry.path))}
            selected={selected === norm(entry.path) || activePath === norm(entry.path)}
            renaming={renaming === norm(entry.path)}
            flash={!!flash[norm(entry.path)]}
            onClick={() => {
              setSelected(norm(entry.path));
              if (entry.isDir) toggle(entry.path);
              else useEditor.getState().openFile(entry.path, { transient: true });
            }}
            onDouble={() => !entry.isDir && useEditor.getState().openFile(entry.path)}
            onContext={(e) => {
              setSelected(norm(entry.path));
              ctx(e, entry);
            }}
            onRename={(name) => doRename(entry, name)}
            onCancelRename={() => setRenaming(null)}
          />
        ))}
      </div>
    </>
  );
}

const TreeRow = memo(function TreeRow(props: {
  entry: FsEntry;
  depth: number;
  open: boolean;
  selected: boolean;
  renaming: boolean;
  flash: boolean;
  onClick: () => void;
  onDouble: () => void;
  onContext: (e: React.MouseEvent) => void;
  onRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const { entry, depth, open, selected, renaming, flash } = props;
  const [val, setVal] = useState(entry.name);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) {
      setVal(entry.name);
      setTimeout(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        const dot = entry.isDir ? -1 : entry.name.lastIndexOf('.');
        el.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
      }, 20);
    }
  }, [renaming, entry]);
  return (
    <div
      className={`tree-row ${selected ? 'sel' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={renaming ? undefined : props.onClick}
      onDoubleClick={renaming ? undefined : props.onDouble}
      onContextMenu={props.onContext}
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/lunarix-path', entry.path);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      title={entry.path}
    >
      {entry.isDir ? <ChevronRight className={`chev ${open ? 'open' : ''}`} size={14} /> : <span style={{ width: 14, flex: 'none' }} />}
      <FileIcon name={entry.name} isDir={entry.isDir} open={open} />
      {renaming ? (
        <input
          ref={inputRef}
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') props.onRename(val.trim());
            if (e.key === 'Escape') props.onCancelRename();
          }}
          onBlur={() => props.onRename(val.trim())}
        />
      ) : (
        <span className="name">{entry.name}</span>
      )}
      {flash && <span className="flash" />}
    </div>
  );
});

// ===================================================================== search

function SearchView() {
  const project = useApp((s) => s.projects.find((p) => p.id === s.projectId));
  const [q, setQ] = useState('');
  const [include, setInclude] = useState('');
  const [regex, setRegex] = useState(false);
  const [cs, setCs] = useState(false);
  const [results, setResults] = useState<SearchMatch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => bus.on('focus-search', () => inputRef.current?.focus()), []);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!project || !q.trim()) {
      setResults(null);
      return;
    }
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        setResults(await api.search(project.path, q, { regex, caseSensitive: cs, include: include || undefined }));
      } catch (e: any) {
        useApp.getState().toast(e.message, 'error');
      } finally {
        setBusy(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [q, include, regex, cs, project]);
  const grouped = useMemo(() => {
    const m = new Map<string, SearchMatch[]>();
    for (const r of results || []) {
      if (!m.has(r.path)) m.set(r.path, []);
      m.get(r.path)!.push(r);
    }
    return [...m.entries()];
  }, [results]);
  const hl = (text: string) => {
    try {
      const re = regex ? new RegExp(q, cs ? 'g' : 'gi') : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs ? 'g' : 'gi');
      const parts: React.ReactNode[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      let i = 0;
      while ((m = re.exec(text)) && i++ < 20) {
        if (m[0].length === 0) break;
        parts.push(text.slice(last, m.index), <mark key={i}>{m[0]}</mark>);
        last = m.index + m[0].length;
      }
      parts.push(text.slice(last));
      return parts;
    } catch {
      return text;
    }
  };
  return (
    <>
      <div className="panel-head">
        <span className="title">{tx('Szukaj', 'Search')}</span>
        {busy && <Loader2 size={13} className="spin" />}
      </div>
      <div style={{ padding: '0 10px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ position: 'relative' }}>
          <input ref={inputRef} className="input" style={{ height: 30, paddingRight: 56 }} placeholder={tx('Szukaj w projekcie', 'Search in project')} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="row" style={{ position: 'absolute', right: 4, top: 4, gap: 2 }}>
            <button className={`icon-btn sm ${cs ? 'on' : ''}`} data-tip={tx('Wielkość liter', 'Match case')} onClick={() => setCs(!cs)}>
              <CaseSensitive size={14} />
            </button>
            <button className={`icon-btn sm ${regex ? 'on' : ''}`} data-tip="Regex" onClick={() => setRegex(!regex)}>
              <Regex size={13} />
            </button>
          </div>
        </div>
        <input className="input" style={{ height: 28, fontSize: 12 }} placeholder={tx('Pliki (np. *.ts, src/**)', 'Files to include (e.g. *.ts, src/**)')} value={include} onChange={(e) => setInclude(e.target.value)} />
        {results && <div className="hint">{tx(`${results.length} wyników w ${grouped.length} plikach`, `${results.length} results in ${grouped.length} files`)}</div>}
      </div>
      <div className="scroll grow" style={{ paddingBottom: 20 }}>
        {grouped.map(([file, matches]) => (
          <div key={file}>
            <div className="search-result-file" onClick={() => useEditor.getState().openFile(file)} title={file}>
              <FileIcon name={basename(file)} />
              <span className="ellipsis">{basename(file)}</span>
              <span className="faint ellipsis" style={{ fontWeight: 400, fontSize: 11.5 }}>
                {relPath(dirname(file), project?.path)}
              </span>
            </div>
            {matches.slice(0, 50).map((m, i) => (
              <div key={i} className="search-result-line" onClick={() => useEditor.getState().openFile(m.path, { line: m.line })}>
                <span style={{ color: 'var(--fg-4)', marginRight: 8 }}>{m.line}</span>
                {hl(m.text.trim())}
              </div>
            ))}
          </div>
        ))}
        {!q && (
          <div className="tree-empty">
            <SearchIcon size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
            {tx('Wpisz frazę, aby przeszukać wszystkie pliki projektu.', 'Type to search across all project files.')}
          </div>
        )}
      </div>
    </>
  );
}

// ====================================================================== chats

function ChatsView() {
  const metas = useApp((s) => s.chatMetas);
  const projects = useApp((s) => s.projects);
  const projectId = useApp((s) => s.projectId);
  const activeChatId = useApp((s) => s.activeChatId);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const ordered = [...projects].sort((a, b) => (a.id === projectId ? -1 : b.id === projectId ? 1 : b.lastOpenedAt - a.lastOpenedAt));
  const ctx = (e: React.MouseEvent, id: string, title: string) =>
    openMenu(e, [
      { label: tx('Otwórz', 'Open'), onClick: () => useApp.getState().openChat(id) },
      {
        label: tx('Zmień nazwę', 'Rename'),
        icon: <Pencil size={14} />,
        onClick: async () => {
          const t = await promptText(tx('Nazwa czatu', 'Chat name'), title);
          if (t) await api.renameChat(id, t);
        }
      },
      { separator: true },
      {
        label: tx('Usuń czat', 'Delete chat'),
        icon: <Trash2 size={14} />,
        danger: true,
        onClick: async () => {
          if (await confirmDialog(tx('Usunąć czat?', 'Delete chat?'), title, tx('Usuń', 'Delete'), true)) {
            await api.deleteChat(id);
          }
        }
      }
    ]);
  return (
    <>
      <div className="panel-head">
        <span className="title">{tx('Czaty', 'Chats')}</span>
        <button className="icon-btn sm" data-tip={tx('Nowy czat', 'New chat')} onClick={() => useApp.getState().newChat()}>
          <Plus size={15} />
        </button>
      </div>
      <div style={{ padding: '0 10px 6px' }}>
        <input className="input" style={{ height: 28 }} placeholder={tx('Filtruj czaty…', 'Filter chats…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="scroll grow" style={{ paddingBottom: 16 }}>
        {ordered.map((p) => {
          const list = metas.filter((c) => c.projectId === p.id && (!filter || c.title.toLowerCase().includes(filter.toLowerCase()))).sort((a, b) => b.updatedAt - a.updatedAt);
          if (!list.length && p.id !== projectId) return null;
          const isCollapsed = collapsed.has(p.id);
          return (
            <div key={p.id}>
              <div
                className="proj-head"
                onClick={() => {
                  const n = new Set(collapsed);
                  n.has(p.id) ? n.delete(p.id) : n.add(p.id);
                  setCollapsed(n);
                }}
              >
                <ChevronRight size={12} style={{ transform: isCollapsed ? 'none' : 'rotate(90deg)', transition: 'transform .15s' }} />
                <span className="ellipsis">{p.name}</span>
                <span style={{ marginLeft: 'auto', fontWeight: 500 }}>{list.length}</span>
              </div>
              {!isCollapsed &&
                list.map((c) => (
                  <div key={c.id} className={`chat-list-item ${c.id === activeChatId ? 'on' : ''}`} onClick={() => useApp.getState().openChat(c.id)} onContextMenu={(e) => ctx(e, c.id, c.title)}>
                    {c.running ? <span className="pulse-dot" /> : <MessagesSquare size={13} style={{ flex: 'none', opacity: 0.5 }} />}
                    <span className="cl-t">{c.title}</span>
                    <span className="cl-time">{timeAgo(c.updatedAt)}</span>
                    <span className="acts">
                      <button
                        className="icon-btn sm"
                        onClick={async (e) => {
                          e.stopPropagation();
                          const t = await promptText(tx('Nazwa czatu', 'Chat name'), c.title);
                          if (t) await api.renameChat(c.id, t);
                        }}
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        className="icon-btn sm"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (await confirmDialog(tx('Usunąć czat?', 'Delete chat?'), c.title, tx('Usuń', 'Delete'), true)) await api.deleteChat(c.id);
                        }}
                      >
                        <Trash2 size={12} />
                      </button>
                    </span>
                  </div>
                ))}
              {!isCollapsed && !list.length && <div className="tree-empty" style={{ padding: '4px 30px 10px' }}>{tx('Brak czatów', 'No chats yet')}</div>}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ======================================================================== git

function GitView() {
  const project = useApp((s) => s.projects.find((p) => p.id === s.projectId));
  const [st, setSt] = useState<GitStatus | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!project) return;
    try {
      setSt(await api.gitStatus(project.path));
    } catch {
      setSt({ isRepo: false, gitAvailable: false, files: [] });
    }
  }, [project]);
  useEffect(() => {
    refresh();
    let t: any;
    const off = on('fs:changed', () => {
      clearTimeout(t);
      t = setTimeout(refresh, 800);
    });
    return () => {
      off();
      clearTimeout(t);
    };
  }, [refresh]);
  if (!project) return null;
  const toast = useApp.getState().toast;
  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
      refresh();
    }
  };
  return (
    <>
      <div className="panel-head">
        <span className="title">Git</span>
        <button className="icon-btn sm" onClick={refresh} data-tip={tx('Odśwież', 'Refresh')}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="scroll grow">
        {!st && <div className="tree-empty">…</div>}
        {st && !st.gitAvailable && (
          <div className="tree-empty">
            {tx('Git nie jest zainstalowany. Lunarix może go zainstalować (wersja przenośna, bez uprawnień administratora).', 'Git is not installed. Lunarix can install a portable version (no admin rights).')}
            <button className="btn sm primary" style={{ marginTop: 12 }} disabled={!!busy} onClick={() => run('install', () => api.installTool('git').then((r) => toast(r, 'success')))}>
              {busy === 'install' ? <Loader2 size={13} className="spin" /> : <Download size={13} />} {tx('Zainstaluj Git', 'Install Git')}
            </button>
          </div>
        )}
        {st && st.gitAvailable && !st.isRepo && (
          <div className="tree-empty">
            {tx('Ten projekt nie jest repozytorium Git.', 'This project is not a Git repository.')}
            <button className="btn sm primary" style={{ marginTop: 12 }} disabled={!!busy} onClick={() => run('init', () => api.gitInit(project.path))}>
              <GitBranch size={13} /> {tx('Zainicjuj repozytorium', 'Initialize repository')}
            </button>
          </div>
        )}
        {st && st.isRepo && (
          <div style={{ padding: '0 10px' }}>
            <div className="row faint" style={{ fontSize: 12, marginBottom: 8 }}>
              <GitBranch size={13} /> {st.branch || 'main'}
              {!!st.ahead && <span className="badge dim">↑{st.ahead}</span>}
              {!!st.behind && <span className="badge dim">↓{st.behind}</span>}
            </div>
            <textarea className="textarea" rows={3} placeholder={tx('Opis zmian (commit message)', 'Commit message')} value={msg} onChange={(e) => setMsg(e.target.value)} style={{ fontSize: 12.5 }} />
            <div className="row" style={{ margin: '6px 0 12px' }}>
              <button className="btn sm" disabled={!!busy || !st.files.length} onClick={() => run('gen', async () => setMsg(await api.gitCommitMessage(project.path)))} data-tip={tx('AI napisze opis zmian', 'AI writes the message')}>
                {busy === 'gen' ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} AI
              </button>
              <button
                className="btn sm primary grow"
                disabled={!!busy || !msg.trim() || !st.files.length}
                onClick={() =>
                  run('commit', async () => {
                    await api.gitCommit(project.path, msg.trim());
                    setMsg('');
                    toast(tx('Zatwierdzono zmiany ✓', 'Committed ✓'), 'success');
                  })
                }
              >
                {busy === 'commit' ? <Loader2 size={13} className="spin" /> : <GitCommitHorizontal size={14} />} Commit ({st.files.length})
              </button>
            </div>
          </div>
        )}
        {st?.isRepo &&
          st.files.map((f) => (
            <div
              key={f.path}
              className="git-file"
              title={f.path}
              onClick={async () => {
                const d = await api.gitDiff(project.path, f.path);
                useEditor.getState().openDiff(f.path, d.before, d.after, 'HEAD');
              }}
            >
              <FileIcon name={basename(f.path)} />
              <span className="ellipsis grow">{relPath(f.path, project.path)}</span>
              <span className="gs">{f.status.replace('??', 'U')}</span>
            </div>
          ))}
        {st?.isRepo && !st.files.length && <div className="tree-empty">{tx('Brak zmian — wszystko zatwierdzone.', 'No changes — working tree clean.')}</div>}
      </div>
    </>
  );
}
