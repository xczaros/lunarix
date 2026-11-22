import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Command, FolderPlus, FolderOpen, X } from 'lucide-react';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { api } from '../lib/api';
import { tx } from '../lib/i18n';
import { basename, dirname, relPath } from '../lib/format';
import { COMMANDS } from '../lib/commands';
import { FileIcon, Kbd } from './ui';

function score(q: string, t: string) {
  const ql = q.toLowerCase();
  const tl = t.toLowerCase();
  if (!ql) return 1;
  if (tl.includes(ql)) return 100 - tl.indexOf(ql);
  let i = 0;
  for (const c of ql) {
    i = tl.indexOf(c, i);
    if (i < 0) return -1;
    i++;
  }
  return 10;
}

export function Palette({ mode: initialMode }: { mode: 'commands' | 'files' }) {
  const [q, setQ] = useState(initialMode === 'commands' ? '>' : '');
  const [hi, setHi] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const project = useApp((s) => s.projects.find((p) => p.id === s.projectId));
  const listRef = useRef<HTMLDivElement>(null);
  const isCmd = q.startsWith('>');
  const close = () => useApp.getState().setModal(null);

  useEffect(() => {
    if (isCmd || !project) return;
    let alive = true;
    const t = setTimeout(() => api.findFiles(project.path, q).then((f) => alive && setFiles(f)), q ? 60 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, isCmd, project]);

  const cmds = useMemo(() => {
    const cq = q.slice(1).trim();
    return COMMANDS.map((c) => ({ c, s: score(cq, c.title()) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [q]);

  const count = isCmd ? cmds.length : files.length;
  useEffect(() => setHi(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.hi')?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const run = (i: number) => {
    if (isCmd) {
      const c = cmds[i];
      if (!c) return;
      close();
      setTimeout(() => c.run(), 10);
    } else {
      const f = files[i];
      if (!f) return;
      close();
      useEditor.getState().openFile(f);
    }
  };

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal palette">
        <div className="p-input">
          {isCmd ? <Command size={16} className="faint" /> : <Search size={16} className="faint" />}
          <input
            autoFocus
            value={q}
            placeholder={tx('Szukaj pliku… (wpisz > aby zobaczyć polecenia)', 'Search files… (type > for commands)')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHi((h) => Math.min(count - 1, h + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHi((h) => Math.max(0, h - 1));
              } else if (e.key === 'Enter') run(hi);
              else if (e.key === 'Escape') close();
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="p-list" ref={listRef}>
          {isCmd &&
            cmds.map((c, i) => (
              <div key={c.id} className={`p-item ${i === hi ? 'hi' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => run(i)}>
                <Command size={14} />
                <span>{c.title()}</span>
                {c.shortcut && (
                  <span className="sc">
                    <Kbd>{c.shortcut}</Kbd>
                  </span>
                )}
              </div>
            ))}
          {!isCmd &&
            files.map((f, i) => (
              <div key={f} className={`p-item ${i === hi ? 'hi' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => run(i)}>
                <FileIcon name={basename(f)} />
                <span>{basename(f)}</span>
                <span className="sub">{relPath(dirname(f), project?.path)}</span>
              </div>
            ))}
          {count === 0 && <div className="p-empty">{isCmd ? tx('Brak poleceń', 'No commands') : tx('Brak plików — projekt jest pusty albo nic nie pasuje.', 'No files — the project is empty or nothing matches.')}</div>}
        </div>
      </div>
    </div>
  );
}

export function NewProjectModal() {
  const settings = useApp((s) => s.settings!);
  const [name, setName] = useState('');
  const [dir, setDir] = useState(settings.projectsRoot);
  const [busy, setBusy] = useState(false);
  const close = () => useApp.getState().setModal(null);
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const p = await api.createProject(name.trim(), dir);
      useApp.setState({ projects: await api.listProjects() });
      await useApp.getState().selectProject(p.id);
      close();
      await useApp.getState().newChat(p.id);
      useApp.getState().toast(tx(`Utworzono projekt „${p.name}” w ${p.path}`, `Created project "${p.name}" at ${p.path}`), 'success');
    } catch (e: any) {
      useApp.getState().toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="backdrop center" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" style={{ width: 520 }} onKeyDown={(e) => e.key === 'Escape' && close()}>
        <div className="modal-head">
          <FolderPlus size={17} /> {tx('Nowy projekt', 'New project')}
          <div className="grow" />
          <button className="icon-btn" onClick={close}>
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>{tx('Nazwa projektu', 'Project name')}</label>
            <input className="input" autoFocus value={name} placeholder={tx('np. Moja gra', 'e.g. My game')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
          </div>
          <div className="field">
            <label>{tx('Lokalizacja', 'Location')}</label>
            <div className="row">
              <input className="input mono" value={dir} onChange={(e) => setDir(e.target.value)} style={{ fontSize: 12 }} />
              <button
                className="btn"
                onClick={async () => {
                  const d = await api.selectFolder();
                  if (d) setDir(d);
                }}
              >
                <FolderOpen size={14} />
              </button>
            </div>
            <div className="hint">
              {tx('Folder projektu zostanie utworzony: ', 'The project folder will be created at: ')}
              <span className="mono">
                {dir}\{name.trim() || '…'}
              </span>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={close}>
            {tx('Anuluj', 'Cancel')}
          </button>
          <button className="btn primary" disabled={!name.trim() || busy} onClick={create}>
            {tx('Utwórz projekt', 'Create project')}
          </button>
        </div>
      </div>
    </div>
  );
}
