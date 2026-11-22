import { useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Eye,
  Save,
  FolderOpen,
  RefreshCw,
  ExternalLink,
  Monitor,
  Tablet,
  Smartphone,
  Sparkles,
  Loader2,
  Check,
  Undo2,
  FilePlus2,
  FolderPlus,
  MessageSquarePlus,
  Command as CmdIcon,
  Keyboard,
  Moon
} from 'lucide-react';
import { useApp } from '../store/app';
import { useEditor, type Tab } from '../store/editor';
import { api, on } from '../lib/api';
import { tx } from '../lib/i18n';
import { monaco, languageFor } from '../lib/monaco';
import { renderMarkdown } from '../lib/markdown';
import { basename, relPath, fmtBytes, timeAgo } from '../lib/format';
import { bus, newFileInProject, openFolder, runCommand } from '../lib/commands';
import { confirmDialog, FileIcon, Kbd, openMenu } from './ui';
import { LogoTile } from './Logo';

// ----------------------------------------------------------- model registry

interface ModelEntry {
  model: monaco.editor.ITextModel;
  view: monaco.editor.ICodeEditorViewState | null;
  saved: number;
  path: string;
}
const models = new Map<string, ModelEntry>();
const special = new Map<string, { kind: 'binary' | 'image' | 'large'; size: number }>();
const keyOf = (p: string) => p.replace(/\//g, '\\').toLowerCase();

async function ensureModel(path: string): Promise<ModelEntry | null> {
  const k = keyOf(path);
  const ex = models.get(k);
  if (ex && !ex.model.isDisposed()) return ex;
  const fc = await api.readFile(path);
  if (fc.image) {
    special.set(k, { kind: 'image', size: fc.size });
    return null;
  }
  if (fc.binary || fc.tooLarge) {
    special.set(k, { kind: fc.tooLarge ? 'large' : 'binary', size: fc.size });
    return null;
  }
  special.delete(k);
  const uri = monaco.Uri.file(path);
  let model = monaco.editor.getModel(uri);
  if (model) model.setValue(fc.content);
  else model = monaco.editor.createModel(fc.content, languageFor(path), uri);
  const entry: ModelEntry = { model, view: null, saved: model.getAlternativeVersionId(), path };
  models.set(k, entry);
  model.onDidChangeContent(() => {
    const dirty = model!.getAlternativeVersionId() !== entry.saved;
    useEditor.getState().setDirty('file:' + k, dirty);
    if (dirty && useApp.getState().settings?.editor.autoSave) scheduleAutoSave(entry);
  });
  return entry;
}

const autoSaveTimers = new Map<string, any>();
function scheduleAutoSave(e: ModelEntry) {
  clearTimeout(autoSaveTimers.get(e.path));
  autoSaveTimers.set(e.path, setTimeout(() => saveEntry(e), 900));
}

async function saveEntry(e: ModelEntry) {
  try {
    await api.writeFile(e.path, e.model.getValue());
    e.saved = e.model.getAlternativeVersionId();
    useEditor.getState().setDirty('file:' + keyOf(e.path), false);
  } catch (err: any) {
    useApp.getState().toast(tx('Nie udało się zapisać: ', 'Save failed: ') + err.message, 'error');
  }
}

export function disposeModel(path: string) {
  const k = keyOf(path);
  const e = models.get(k);
  if (e) {
    e.model.dispose();
    models.delete(k);
  }
}

/** Reload an open model from disk (keeps undo history) and flash the changed region. */
async function reloadFromDisk(path: string, flash: boolean): Promise<monaco.IRange | null> {
  const e = models.get(keyOf(path));
  if (!e || e.model.isDisposed()) return null;
  if (e.model.getAlternativeVersionId() !== e.saved) return null; // user has unsaved edits
  let fc;
  try {
    fc = await api.readFile(path);
  } catch {
    // file was deleted on disk (e.g. checkpoint restore) — close its clean tab
    if (!(await api.exists(path))) {
      useEditor.getState().removePath(path);
      disposeModel(path);
    }
    return null;
  }
  if (fc.binary || fc.tooLarge) return null;
  const cur = e.model.getValue();
  const next = fc.content.replace(/\r\n/g, e.model.getEOL() === '\r\n' ? '\r\n' : '\n');
  if (cur === next) return null;
  // find changed line range
  const a = cur.split(/\r?\n/);
  const b = next.split(/\r?\n/);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= s && eb >= s && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  e.model.pushEditOperations([], [{ range: e.model.getFullModelRange(), text: next }], () => null);
  e.saved = e.model.getAlternativeVersionId();
  useEditor.getState().setDirty('file:' + keyOf(path), false);
  if (!flash) return null;
  return { startLineNumber: s + 1, startColumn: 1, endLineNumber: Math.max(s + 1, eb + 1), endColumn: 1 };
}

// ------------------------------------------------------------------- area

export function EditorArea() {
  const tabs = useEditor((s) => s.tabs);
  const active = useEditor((s) => s.active);
  const tab = tabs.find((t) => t.id === active) || null;
  const project = useApp((s) => s.projects.find((p) => p.id === s.projectId));

  useEffect(() => bus.on('close-tab', (id: string) => closeTab(id)), []);

  return (
    <div className="editor-area">
      {tabs.length > 0 && (
        <div className="tabs">
          {tabs.map((t) => (
            <TabButton key={t.id} tab={t} active={t.id === active} />
          ))}
        </div>
      )}
      {!tab && <Welcome />}
      {tab && (tab.kind === 'file' || tab.kind === 'diff') && <CodeHost tab={tab} root={project?.path} />}
      {tab && tab.kind === 'preview' && <PreviewView key={tab.id} tab={tab} />}
      {tab && tab.kind === 'markdown' && <MarkdownView key={tab.id} path={tab.path!} />}
    </div>
  );
}

async function closeTab(id: string) {
  const t = useEditor.getState().tabs.find((x) => x.id === id);
  if (!t) return;
  if (t.dirty && t.path) {
    const ok = await confirmDialog(tx('Niezapisane zmiany', 'Unsaved changes'), tx(`Zamknąć „${t.title}” bez zapisywania?`, `Close "${t.title}" without saving?`), tx('Zamknij', 'Close'), true);
    if (!ok) return;
    disposeModel(t.path);
  }
  useEditor.getState().close(id);
}

function TabButton({ tab, active }: { tab: Tab; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);
  return (
    <div
      ref={ref}
      className={`tab ${active ? 'on' : ''}`}
      onClick={() => useEditor.getState().activate(tab.id)}
      onDoubleClick={() => useEditor.getState().pin(tab.id)}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(tab.id);
        }
      }}
      onContextMenu={(e) =>
        openMenu(e, [
          { label: tx('Zamknij', 'Close'), shortcut: 'Ctrl+W', onClick: () => closeTab(tab.id) },
          { label: tx('Zamknij pozostałe', 'Close others'), onClick: () => useEditor.getState().closeOthers(tab.id) },
          { label: tx('Zamknij wszystkie', 'Close all'), onClick: () => useEditor.getState().closeAll() },
          ...(tab.path ? [{ separator: true }, { label: tx('Pokaż w Eksploratorze', 'Reveal in Explorer'), onClick: () => api.showInFolder(tab.path!) }, { label: tx('Kopiuj ścieżkę', 'Copy path'), onClick: () => api.clipboardWrite(tab.path!) }] : [])
        ])
      }
      title={tab.path || tab.url}
    >
      {tab.kind === 'preview' ? <Eye size={14} className="ficon" /> : <FileIcon name={tab.title} />}
      <span className={`tname ${tab.transient ? 'preview' : ''}`}>{tab.title}</span>
      {tab.dirty ? <span className="dirty" /> : null}
      <button
        className="tclose"
        onClick={(e) => {
          e.stopPropagation();
          closeTab(tab.id);
        }}
      >
        <X size={13} />
      </button>
    </div>
  );
}

// ------------------------------------------------------------ monaco host

let sharedEditor: monaco.editor.IStandaloneCodeEditor | null = null;

function CodeHost({ tab, root }: { tab: Tab; root?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const currentRef = useRef<ModelEntry | null>(null);
  const [spec, setSpec] = useState<{ kind: string; size: number } | null>(null);
  const [inline, setInline] = useState<{ top: number; busy: boolean; done: boolean } | null>(null);
  const settings = useApp((s) => s.settings!);
  const reveal = useEditor((s) => s.reveal);
  const flash = useEditor((s) => s.flash);
  const decoRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const inlineInput = useRef<HTMLInputElement>(null);
  const [instruction, setInstruction] = useState('');

  const theme = settings.theme === 'light' ? 'lunarix-light' : 'lunarix-dark';
  const opts: monaco.editor.IStandaloneEditorConstructionOptions = useMemo(
    () => ({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: settings.editor.fontSize,
      fontLigatures: settings.editor.ligatures,
      lineHeight: Math.round(settings.editor.fontSize * 1.6),
      minimap: { enabled: settings.editor.minimap, renderCharacters: false, maxColumn: 90, scale: 1 },
      wordWrap: settings.editor.wordWrap ? 'on' : 'off',
      tabSize: settings.editor.tabSize,
      automaticLayout: true,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'all',
      scrollBeyondLastLine: false,
      padding: { top: 10, bottom: 10 },
      bracketPairColorization: { enabled: false },
      guides: { indentation: true, bracketPairs: false },
      stickyScroll: { enabled: true },
      fixedOverflowWidgets: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      overviewRulerBorder: false,
      renderWhitespace: 'selection',
      mouseWheelZoom: true
    }),
    [settings.editor]
  );

  // create editors once
  useEffect(() => {
    if (!hostRef.current) return;
    const ed = monaco.editor.create(hostRef.current, { ...opts, theme, model: null });
    editorRef.current = ed;
    sharedEditor = ed;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => bus.emit('save'));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => openInline());
    ed.addAction({
      id: 'lunarix.ask',
      label: tx('Lunarix: zapytaj agenta o zaznaczenie', 'Lunarix: ask the agent about the selection'),
      contextMenuGroupId: '0_lunarix',
      run: (e) => {
        const sel = e.getSelection();
        const model = e.getModel();
        if (!sel || !model) return;
        const text = model.getValueInRange(sel);
        const p = currentRef.current?.path || '';
        useApp.getState().fillComposer(`@${relPath(p, root)}:${sel.startLineNumber}-${sel.endLineNumber}\n\`\`\`\n${text}\n\`\`\`\n`);
      }
    });
    ed.addAction({ id: 'lunarix.inline', label: tx('Lunarix: edytuj z AI (Ctrl+K)', 'Lunarix: edit with AI (Ctrl+K)'), contextMenuGroupId: '0_lunarix', run: () => openInline() });
    const d = monaco.editor.createDiffEditor(diffRef.current!, { ...opts, theme, readOnly: true, renderSideBySide: true, originalEditable: false, automaticLayout: true } as any);
    diffEditorRef.current = d;
    return () => {
      if (currentRef.current) currentRef.current.view = ed.saveViewState();
      ed.dispose();
      d.dispose();
      if (sharedEditor === ed) sharedEditor = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    editorRef.current?.updateOptions(opts);
    diffEditorRef.current?.updateOptions(opts as any);
  }, [opts]);
  useEffect(() => {
    monaco.editor.setTheme(theme);
  }, [theme]);

  // switch model when tab changes
  useEffect(() => {
    let cancelled = false;
    const ed = editorRef.current;
    if (!ed) return;
    if (tab.kind === 'diff' && tab.diff) {
      const lang = languageFor(tab.diff.path);
      const original = monaco.editor.createModel(tab.diff.before, lang);
      const modified = monaco.editor.createModel(tab.diff.after, lang);
      diffEditorRef.current!.setModel({ original, modified });
      setSpec(null);
      return () => {
        diffEditorRef.current?.setModel(null);
        original.dispose();
        modified.dispose();
      };
    }
    if (!tab.path) return;
    (async () => {
      if (currentRef.current && !currentRef.current.model.isDisposed()) currentRef.current.view = ed.saveViewState();
      const entry = await ensureModel(tab.path!).catch((e) => {
        useApp.getState().toast(e.message, 'error');
        return null;
      });
      if (cancelled) return;
      if (!entry) {
        setSpec(special.get(keyOf(tab.path!)) || { kind: 'binary', size: 0 });
        currentRef.current = null;
        ed.setModel(null);
        return;
      }
      setSpec(null);
      currentRef.current = entry;
      ed.setModel(entry.model);
      if (entry.view) ed.restoreViewState(entry.view);
      ed.focus();
    })();
    return () => {
      cancelled = true;
    };
  }, [tab.id, tab.kind, tab.path, tab.diff]);

  // save
  useEffect(
    () =>
      bus.on('save', () => {
        const e = currentRef.current;
        if (e) saveEntry(e);
      }),
    []
  );

  // reveal line
  useEffect(() => {
    if (!reveal || !tab.path || keyOf(reveal.path) !== keyOf(tab.path)) return;
    const t = setTimeout(() => {
      const ed = editorRef.current;
      if (!ed) return;
      ed.revealLineInCenter(reveal.line);
      ed.setPosition({ lineNumber: reveal.line, column: 1 });
      ed.focus();
    }, 80);
    return () => clearTimeout(t);
  }, [reveal, tab.path]);

  // external changes
  useEffect(() => {
    const flashRange = (range: monaco.IRange | null) => {
      const ed = editorRef.current;
      if (!range || !ed) return;
      decoRef.current?.clear();
      decoRef.current = ed.createDecorationsCollection([{ range, options: { isWholeLine: true, className: 'lx-flash-line', linesDecorationsClassName: 'lx-flash-gutter' } }]);
      ed.revealRangeInCenterIfOutsideViewport(range);
      setTimeout(() => decoRef.current?.clear(), 1800);
    };
    const off1 = on('fs:changed', async ({ paths }: { paths: string[] }) => {
      for (const p of paths) {
        if (!models.has(keyOf(p))) continue;
        const isActive = currentRef.current && keyOf(currentRef.current.path) === keyOf(p);
        const r = await reloadFromDisk(p, !!isActive);
        if (isActive) flashRange(r);
      }
    });
    return off1;
  }, []);

  useEffect(() => {
    if (!flash || !tab.path || keyOf(flash.path) !== keyOf(tab.path)) return;
    const ed = editorRef.current;
    const t = setTimeout(() => {
      if (!ed || !ed.getModel()) return;
      const lc = ed.getModel()!.getLineCount();
      decoRef.current?.clear();
      decoRef.current = ed.createDecorationsCollection([{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: lc, endColumn: 1 }, options: { isWholeLine: true, className: 'lx-flash-line' } }]);
      setTimeout(() => decoRef.current?.clear(), 1200);
    }, 200);
    return () => clearTimeout(t);
  }, [flash, tab.path]);

  // inline AI edit (Ctrl+K)
  const openInline = () => {
    const ed = editorRef.current;
    if (!ed || !ed.getModel()) return;
    const sel = ed.getSelection();
    if (!sel) return;
    const pos = ed.getScrolledVisiblePosition({ lineNumber: sel.startLineNumber, column: 1 });
    setInline({ top: Math.max(8, (pos?.top || 40) - 50), busy: false, done: false });
    setInstruction('');
    setTimeout(() => inlineInput.current?.focus(), 30);
  };
  const runInline = async () => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model || !instruction.trim() || !currentRef.current) return;
    let sel = ed.getSelection()!;
    if (sel.isEmpty()) sel = new monaco.Selection(sel.startLineNumber, 1, sel.startLineNumber, model.getLineMaxColumn(sel.startLineNumber));
    const fullSel = new monaco.Selection(sel.startLineNumber, 1, sel.endLineNumber, model.getLineMaxColumn(sel.endLineNumber));
    const code = model.getValueInRange(fullSel);
    const before = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: fullSel.startLineNumber, endColumn: 1 });
    const after = model.getValueInRange({ startLineNumber: fullSel.endLineNumber, startColumn: model.getLineMaxColumn(fullSel.endLineNumber), endLineNumber: model.getLineCount(), endColumn: model.getLineMaxColumn(model.getLineCount()) });
    setInline((i) => (i ? { ...i, busy: true } : i));
    try {
      const out = await api.inlineEdit({ filePath: currentRef.current.path, language: model.getLanguageId(), code, before, after, instruction: instruction.trim() });
      ed.pushUndoStop();
      ed.executeEdits('lunarix-inline', [{ range: fullSel, text: out }]);
      ed.pushUndoStop();
      const lines = out.split('\n').length;
      decoRef.current?.clear();
      decoRef.current = ed.createDecorationsCollection([{ range: { startLineNumber: fullSel.startLineNumber, startColumn: 1, endLineNumber: fullSel.startLineNumber + lines - 1, endColumn: 1 }, options: { isWholeLine: true, className: 'lx-inline-added' } }]);
      setInline((i) => (i ? { ...i, busy: false, done: true } : i));
    } catch (e: any) {
      useApp.getState().toast(e.message, 'error');
      setInline((i) => (i ? { ...i, busy: false } : i));
    }
  };
  const acceptInline = () => {
    decoRef.current?.clear();
    setInline(null);
    editorRef.current?.focus();
  };
  const rejectInline = () => {
    if (inline?.done) editorRef.current?.trigger('lunarix', 'undo', null);
    decoRef.current?.clear();
    setInline(null);
    editorRef.current?.focus();
  };

  const isDiff = tab.kind === 'diff';
  const isHtml = !!tab.path && /\.html?$/i.test(tab.path);
  const isMd = !!tab.path && /\.(md|markdown)$/i.test(tab.path);
  return (
    <>
      <div className="editor-toolbar">
        <span className="crumbs">{isDiff ? `${tab.diff?.label || ''} ↔ ${tx('bieżący', 'current')} · ${relPath(tab.diff!.path, root)}` : relPath(tab.path || '', root)}</span>
        {isHtml && (
          <button className="btn sm ghost" onClick={async () => root && tab.path && useEditor.getState().openPreview(await api.previewUrl(root, tab.path), basename(tab.path))}>
            <Eye size={13} /> {tx('Podgląd', 'Preview')}
          </button>
        )}
        {isMd && (
          <button className="btn sm ghost" onClick={() => useEditor.getState().openMarkdown(tab.path!)}>
            <Eye size={13} /> {tx('Podgląd', 'Preview')}
          </button>
        )}
        {!isDiff && tab.path && (
          <>
            <button className="icon-btn" data-tip={tx('Edytuj z AI (Ctrl+K)', 'Edit with AI (Ctrl+K)')} onClick={openInline}>
              <Sparkles size={14} />
            </button>
            <button className="icon-btn" data-tip={tx('Zapisz (Ctrl+S)', 'Save (Ctrl+S)')} onClick={() => bus.emit('save')}>
              <Save size={14} />
            </button>
            <button className="icon-btn" data-tip={tx('Pokaż w folderze', 'Reveal in folder')} onClick={() => api.showInFolder(tab.path!)}>
              <FolderOpen size={14} />
            </button>
          </>
        )}
      </div>
      <div className="monaco-host" style={{ display: isDiff || spec ? 'none' : 'block' }}>
        <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
        {inline && (
          <div className="inline-edit" style={{ top: inline.top }}>
            <Sparkles size={15} style={{ flex: 'none', marginLeft: 4 }} />
            {!inline.done ? (
              <>
                <input
                  ref={inlineInput}
                  className="input"
                  style={{ height: 30 }}
                  placeholder={tx('Opisz zmianę zaznaczonego kodu… (Enter)', 'Describe the change to the selection… (Enter)')}
                  value={instruction}
                  disabled={inline.busy}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') runInline();
                    if (e.key === 'Escape') rejectInline();
                  }}
                />
                <button className="btn sm primary" disabled={inline.busy || !instruction.trim()} onClick={runInline}>
                  {inline.busy ? <Loader2 size={13} className="spin" /> : tx('Generuj', 'Generate')}
                </button>
                <button className="icon-btn" onClick={rejectInline}>
                  <X size={14} />
                </button>
              </>
            ) : (
              <>
                <span className="grow muted" style={{ fontSize: 12.5 }}>
                  {tx('Zmiana zastosowana — zachować?', 'Change applied — keep it?')}
                </span>
                <button className="btn sm primary" onClick={acceptInline} autoFocus>
                  <Check size={13} /> {tx('Akceptuj', 'Accept')}
                </button>
                <button className="btn sm" onClick={rejectInline}>
                  <Undo2 size={13} /> {tx('Odrzuć', 'Reject')}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="monaco-host" style={{ display: isDiff ? 'block' : 'none' }}>
        <div ref={diffRef} style={{ position: 'absolute', inset: 0 }} />
      </div>
      {spec && !isDiff && <SpecialView path={tab.path!} spec={spec} />}
    </>
  );
}

function SpecialView({ path, spec }: { path: string; spec: { kind: string; size: number } }) {
  if (spec.kind === 'image') {
    const src = 'app://lunarix/local/' + encodeURIComponent(path);
    return (
      <div className="image-view">
        <img src={src} alt={basename(path)} />
      </div>
    );
  }
  return (
    <div className="welcome">
      <div style={{ textAlign: 'center' }} className="muted">
        <FileIcon name={basename(path)} size={34} />
        <p>{spec.kind === 'large' ? tx(`Plik jest zbyt duży do edycji (${fmtBytes(spec.size)}).`, `File is too large to edit (${fmtBytes(spec.size)}).`) : tx(`Plik binarny (${fmtBytes(spec.size)}).`, `Binary file (${fmtBytes(spec.size)}).`)}</p>
        <button className="btn sm" onClick={() => api.openPath(path)}>
          <ExternalLink size={13} /> {tx('Otwórz w domyślnej aplikacji', 'Open with default app')}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- preview

function PreviewView({ tab }: { tab: Tab }) {
  const [url, setUrl] = useState(tab.url || '');
  const [frameUrl, setFrameUrl] = useState(tab.url || '');
  const [device, setDevice] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    setUrl(tab.url || '');
    setFrameUrl(tab.url || '');
  }, [tab.url]);
  const width = device === 'desktop' ? '100%' : device === 'tablet' ? '820px' : '390px';
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="preview-bar">
        <button className="icon-btn" onClick={() => setNonce((n) => n + 1)} data-tip={tx('Odśwież', 'Reload')}>
          <RefreshCw size={14} />
        </button>
        <input
          className="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              let u = url.trim();
              if (!/^https?:\/\//.test(u)) u = 'http://' + u;
              setFrameUrl(u);
              setNonce((n) => n + 1);
            }
          }}
        />
        <div className="preview-devices">
          <button className={`icon-btn ${device === 'desktop' ? 'on' : ''}`} onClick={() => setDevice('desktop')} data-tip="Desktop">
            <Monitor size={14} />
          </button>
          <button className={`icon-btn ${device === 'tablet' ? 'on' : ''}`} onClick={() => setDevice('tablet')} data-tip="Tablet">
            <Tablet size={14} />
          </button>
          <button className={`icon-btn ${device === 'mobile' ? 'on' : ''}`} onClick={() => setDevice('mobile')} data-tip="Mobile">
            <Smartphone size={14} />
          </button>
        </div>
        <button className="icon-btn" onClick={() => api.openExternal(frameUrl)} data-tip={tx('Otwórz w przeglądarce', 'Open in browser')}>
          <ExternalLink size={14} />
        </button>
      </div>
      <div className="preview-stage">
        <div className="frame-wrap" style={{ width }}>
          {/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(frameUrl) ? (
            <iframe key={nonce} className="preview-frame" style={{ height: '100%' }} src={frameUrl} sandbox="allow-scripts allow-forms allow-same-origin allow-modals allow-popups allow-pointer-lock allow-downloads" title="preview" />
          ) : (
            <div className="welcome">
              <div className="muted" style={{ textAlign: 'center' }}>
                {tx('Podgląd w aplikacji działa dla adresów lokalnych (localhost).', 'In-app preview works for local addresses (localhost).')}
                <div style={{ marginTop: 10 }}>
                  <button className="btn sm" onClick={() => api.openExternal(frameUrl)}>
                    <ExternalLink size={13} /> {tx('Otwórz w przeglądarce', 'Open in browser')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MarkdownView({ path }: { path: string }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .readFile(path)
        .then((f) => alive && setHtml(renderMarkdown(f.content)))
        .catch(() => {});
    load();
    const off = on('fs:changed', ({ paths }: { paths: string[] }) => {
      if (paths.some((p) => keyOf(p) === keyOf(path))) load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [path]);
  return (
    <div className="md-preview">
      <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

// -------------------------------------------------------------- welcome

function Welcome() {
  const projects = useApp((s) => s.projects);
  const metas = useApp((s) => s.chatMetas);
  const project = useApp((s) => s.projects.find((p) => p.id === s.projectId));
  const recentChats = metas.filter((c) => c.projectId === project?.id).slice(0, 5);
  return (
    <div className="welcome">
      <div className="welcome-inner fade-up">
        <div className="hero">
          <LogoTile size={64} className="logo-lg" />
          <div>
            <h1>Lunarix</h1>
            <div className="tag">{tx('Ty opisujesz. AI planuje, koduje, testuje i naprawia. Ty odpoczywasz.', 'You describe. AI plans, codes, tests and fixes. You relax.')}</div>
          </div>
        </div>
        <div className="grid">
          <div>
            <h3>{tx('Start', 'Start')}</h3>
            <button className="action" onClick={() => runCommand('chat.new')}>
              <MessageSquarePlus size={16} /> {tx('Nowe zadanie dla agenta', 'New task for the agent')} <Kbd>Ctrl N</Kbd>
            </button>
            <button className="action" onClick={() => runCommand('project.new')}>
              <FolderPlus size={16} /> {tx('Nowy projekt', 'New project')} <Kbd>Ctrl ⇧ N</Kbd>
            </button>
            <button className="action" onClick={openFolder}>
              <FolderOpen size={16} /> {tx('Otwórz folder', 'Open folder')} <Kbd>Ctrl O</Kbd>
            </button>
            <button className="action" onClick={() => newFileInProject()}>
              <FilePlus2 size={16} /> {tx('Nowy plik', 'New file')}
            </button>
            <button className="action" onClick={() => runCommand('palette')}>
              <CmdIcon size={16} /> {tx('Wszystkie polecenia', 'All commands')} <Kbd>Ctrl ⇧ P</Kbd>
            </button>
            <button className="action" onClick={() => useApp.setState({ chill: true })}>
              <Moon size={16} /> {tx('Tryb Chill', 'Chill Mode')} <Kbd>Ctrl Alt C</Kbd>
            </button>
          </div>
          <div>
            <h3>{tx('Ostatnie projekty', 'Recent projects')}</h3>
            <div className="recent">
              {projects.slice(0, 6).map((p) => (
                <button key={p.id} className="action" onClick={() => useApp.getState().selectProject(p.id)} title={p.path}>
                  <FolderOpen size={15} />
                  <span className="col" style={{ minWidth: 0 }}>
                    <span className="ellipsis">{p.name}</span>
                    <span className="path">{p.path}</span>
                  </span>
                </button>
              ))}
            </div>
            {recentChats.length > 0 && (
              <>
                <h3 style={{ marginTop: 18 }}>{tx('Ostatnie czaty', 'Recent chats')}</h3>
                {recentChats.map((c) => (
                  <button key={c.id} className="action" onClick={() => useApp.getState().openChat(c.id)}>
                    <MessageSquarePlus size={15} />
                    <span className="ellipsis grow">{c.title}</span>
                    <span className="faint" style={{ fontSize: 11 }}>{timeAgo(c.updatedAt)}</span>
                  </button>
                ))}
              </>
            )}
          </div>
        </div>
        <div className="tips">
          <Keyboard size={16} style={{ flex: 'none', marginTop: 1 }} />
          <div>
            {tx(
              'Wskazówka: przeciągnij pliki, ZIP-y lub zrzuty ekranu do czatu. Zaznacz kod i wciśnij Ctrl+K, aby AI go przerobiło. Wpisz „/” w czacie, aby zobaczyć polecenia.',
              'Tip: drag files, ZIPs or screenshots into the chat. Select code and press Ctrl+K to let AI rewrite it. Type "/" in the chat to see commands.'
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function focusEditor() {
  sharedEditor?.focus();
}
