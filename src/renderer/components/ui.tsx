import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import {
  AlertTriangle,
  CheckCircle2,
  FileArchive,
  FileCode2,
  FileImage,
  FileJson,
  FileText,
  FileType2,
  Folder,
  FolderOpen,
  Info,
  Settings2,
  X,
  FileTerminal,
  Database,
  Palette,
  Lock,
  Package,
  BookOpen,
  Music,
  Film,
  Box
} from 'lucide-react';
import { useApp } from '../store/app';
import { tx } from '../lib/i18n';

// ------------------------------------------------------------------ switch
export function Switch({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button type="button" className={`switch ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)} role="switch" aria-checked={on} />;
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ReactNode; icon?: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} type="button">
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ menus
export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  separator?: boolean;
  header?: string;
}

interface MenuState {
  /** anchor = the button that opened the menu; clicking it again closes the menu */
  menu: { x: number; y: number; items: MenuItem[]; anchor?: HTMLElement } | null;
  open(x: number, y: number, items: MenuItem[], anchor?: HTMLElement): void;
  close(): void;
}
const setExpanded = (el: HTMLElement | undefined, v: boolean) => {
  if (!el) return;
  el.setAttribute('aria-expanded', String(v));
  el.classList.toggle('menu-open', v);
};
export const useMenu = create<MenuState>((set, get) => ({
  menu: null,
  open: (x, y, items, anchor) => {
    const prev = get().menu?.anchor;
    if (prev && prev !== anchor) setExpanded(prev, false);
    setExpanded(anchor, true);
    set({ menu: { x, y, items, anchor } });
  },
  close: () => {
    setExpanded(get().menu?.anchor, false);
    set({ menu: null });
  }
}));

export function openMenu(e: React.MouseEvent | MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  useMenu.getState().open(e.clientX, e.clientY, items);
}

/** Opens a menu under a button — or closes it, when that button's menu is already open (toggle). */
export function openMenuAt(el: HTMLElement, items: MenuItem[], align: 'left' | 'right' = 'left') {
  const m = useMenu.getState();
  if (m.menu?.anchor === el) {
    m.close();
    return;
  }
  const r = el.getBoundingClientRect();
  m.open(align === 'left' ? r.left : r.right - 220, r.bottom + 4, items, el);
}

export function ContextMenu() {
  const { menu, close } = useMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    let x = menu.x;
    let y = menu.y;
    if (x + r.width > window.innerWidth - 8) x = window.innerWidth - r.width - 8;
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, menu.y - r.height);
    setPos({ x: Math.max(8, x), y });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current || ref.current.contains(t)) return;
      // a press on the menu's own button is handled by its click (openMenuAt toggles it shut);
      // closing here would make that click open the menu again
      if (menu.anchor?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [menu, close]);
  if (!menu) return null;
  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }}>
      {menu.items.map((it, i) =>
        it.separator ? (
          <div key={i} className="sep" />
        ) : it.header ? (
          <div key={i} className="head">
            {it.header}
          </div>
        ) : (
          <button
            key={i}
            className={`item ${it.danger ? 'danger' : ''}`}
            disabled={it.disabled}
            style={it.disabled ? { opacity: 0.4 } : undefined}
            onClick={() => {
              close();
              it.onClick?.();
            }}
          >
            {it.icon}
            <span className="ellipsis">{it.label}</span>
            {it.shortcut && <span className="sc">{it.shortcut}</span>}
          </button>
        )
      )}
    </div>
  );
}

// ------------------------------------------------------------------ dialogs
interface DialogState {
  dlg: null | { kind: 'prompt' | 'confirm'; title: string; message?: string; value?: string; placeholder?: string; okLabel?: string; danger?: boolean; resolve: (v: any) => void };
  set(d: DialogState['dlg']): void;
}
const useDialog = create<DialogState>((set) => ({ dlg: null, set: (d) => set({ dlg: d }) }));

export function promptText(title: string, value = '', placeholder = '', okLabel?: string): Promise<string | null> {
  return new Promise((resolve) => useDialog.getState().set({ kind: 'prompt', title, value, placeholder, okLabel, resolve }));
}
export function confirmDialog(title: string, message: string, okLabel?: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => useDialog.getState().set({ kind: 'confirm', title, message, okLabel, danger, resolve }));
}

export function DialogHost() {
  const { dlg, set } = useDialog();
  const [val, setVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (dlg) {
      setVal(dlg.value || '');
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 30);
    }
  }, [dlg]);
  if (!dlg) return null;
  const done = (v: any) => {
    set(null);
    dlg.resolve(v);
  };
  return (
    <div className="backdrop center" onMouseDown={(e) => e.target === e.currentTarget && done(dlg.kind === 'confirm' ? false : null)}>
      <div className="modal" style={{ width: 440 }} onKeyDown={(e) => e.key === 'Escape' && done(dlg.kind === 'confirm' ? false : null)}>
        <div className="modal-head">{dlg.title}</div>
        <div className="modal-body">
          {dlg.message && <div className="muted" style={{ marginBottom: 10, whiteSpace: 'pre-wrap' }}>{dlg.message}</div>}
          {dlg.kind === 'prompt' && (
            <input
              ref={inputRef}
              className="input"
              value={val}
              placeholder={dlg.placeholder}
              onChange={(e) => setVal(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && val.trim()) done(val.trim());
              }}
            />
          )}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={() => done(dlg.kind === 'confirm' ? false : null)}>
            {tx('Anuluj', 'Cancel')}
          </button>
          <button className={`btn ${dlg.danger ? '' : 'primary'}`} autoFocus={dlg.kind === 'confirm'} onClick={() => done(dlg.kind === 'confirm' ? true : val.trim() || null)} disabled={dlg.kind === 'prompt' && !val.trim()}>
            {dlg.okLabel || 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ toasts
export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level} ${t.out ? 'out' : ''}`}>
          {t.level === 'success' ? <CheckCircle2 size={16} /> : t.level === 'error' || t.level === 'warn' ? <AlertTriangle size={16} /> : <Info size={16} />}
          <div style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{t.text}</div>
          <button className="icon-btn sm" onClick={() => useApp.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Lightbox() {
  const src = useApp((s) => s.lightbox);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && useApp.setState({ lightbox: null });
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  if (!src) return null;
  return (
    <div className="lightbox" onClick={() => useApp.setState({ lightbox: null })}>
      <img src={src} alt="" />
    </div>
  );
}

// ------------------------------------------------------------------ resizer
export function Resizer({ dir, value, min, max, onChange, invert }: { dir: 'x' | 'y'; value: number; min: number; max: number; onChange: (v: number) => void; invert?: boolean }) {
  const [drag, setDrag] = useState(false);
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    const startPos = dir === 'x' ? e.clientX : e.clientY;
    const startVal = value;
    setDrag(true);
    const move = (ev: PointerEvent) => {
      const d = (dir === 'x' ? ev.clientX : ev.clientY) - startPos;
      onChange(Math.max(min, Math.min(max, startVal + (invert ? -d : d))));
    };
    const up = () => {
      setDrag(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = dir === 'x' ? 'col-resize' : 'row-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div className={`resizer ${dir === 'y' ? 'h' : ''} ${drag ? 'drag' : ''}`} onPointerDown={start} />;
}

// ----------------------------------------------------------------- icons
const CODE = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'php', 'cs', 'cpp', 'cc', 'c', 'h', 'hpp', 'java', 'kt', 'go', 'rs', 'rb', 'swift', 'dart', 'lua', 'vue', 'svelte', 'html', 'htm', 'xml', 'sql', 'r', 'scala', 'gd']);
export function FileIcon({ name, isDir, open, size = 15 }: { name: string; isDir?: boolean; open?: boolean; size?: number }) {
  if (isDir) return open ? <FolderOpen size={size} className="ficon" /> : <Folder size={size} className="ficon" />;
  const n = name.toLowerCase();
  const ext = n.includes('.') ? n.split('.').pop()! : '';
  if (n === 'package.json' || n === 'composer.json' || n === 'cargo.toml' || n === 'requirements.txt') return <Package size={size} className="ficon" />;
  if (n.startsWith('.env') || ext === 'pem' || ext === 'key') return <Lock size={size} className="ficon" />;
  if (n.startsWith('readme') || ext === 'md' || ext === 'mdx') return <BookOpen size={size} className="ficon" />;
  if (ext === 'json' || ext === 'jsonc') return <FileJson size={size} className="ficon" />;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif'].includes(ext)) return <FileImage size={size} className="ficon" />;
  if (['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'xz'].includes(ext)) return <FileArchive size={size} className="ficon" />;
  if (['css', 'scss', 'less', 'sass'].includes(ext)) return <Palette size={size} className="ficon" />;
  if (['sh', 'ps1', 'bat', 'cmd'].includes(ext)) return <FileTerminal size={size} className="ficon" />;
  if (['db', 'sqlite', 'sql'].includes(ext)) return <Database size={size} className="ficon" />;
  if (['mp3', 'wav', 'ogg', 'flac'].includes(ext)) return <Music size={size} className="ficon" />;
  if (['mp4', 'mkv', 'mov', 'webm', 'avi'].includes(ext)) return <Film size={size} className="ficon" />;
  if (['ttf', 'otf', 'woff', 'woff2'].includes(ext)) return <FileType2 size={size} className="ficon" />;
  if (['glb', 'gltf', 'fbx', 'obj', 'blend'].includes(ext)) return <Box size={size} className="ficon" />;
  if (['yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'config', 'lock'].includes(ext) || n.startsWith('.')) return <Settings2 size={size} className="ficon" />;
  if (CODE.has(ext)) return <FileCode2 size={size} className="ficon" />;
  return <FileText size={size} className="ficon" />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function ProgressBar({ value, indeterminate }: { value: number; indeterminate?: boolean }) {
  return (
    <div className={`progress-bar ${indeterminate ? 'indet' : ''}`}>
      <i style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

/** Context usage ring. */
export function Ring({ value, size = 22 }: { value: number; size?: number }) {
  const r = size / 2 - 2.5;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg className="ctx-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--bg-5)" strokeWidth="2.2" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--fg)" strokeWidth="2.2" strokeDasharray={`${c * v} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dasharray .6s cubic-bezier(.16,1,.3,1)' }} />
    </svg>
  );
}
