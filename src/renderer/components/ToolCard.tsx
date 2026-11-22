import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText,
  FilePen,
  FilePlus2,
  Trash2,
  FolderTree,
  Search,
  TerminalSquare,
  Globe,
  MonitorSmartphone,
  Camera,
  MousePointerClick,
  Download,
  Archive,
  ListChecks,
  MessageCircleQuestion,
  Eye,
  ArrowRightLeft,
  Activity,
  Check,
  X,
  Loader2,
  ShieldQuestion,
  Ban,
  ChevronRight,
  ExternalLink,
  Square
} from 'lucide-react';
import type { Block, DiffLine } from '@shared/types';
import { api } from '../lib/api';
import { tx } from '../lib/i18n';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { fmtDuration } from '../lib/format';
import { highlightCode, langFromPath } from '../lib/markdown';

type ToolBlock = Extract<Block, { type: 'tool' }>;

/** Extract a (possibly unterminated) string field from streaming JSON. */
export function partialField(json: string | undefined, field: string): string | undefined {
  if (!json) return undefined;
  const key = `"${field}"`;
  const i = json.indexOf(key);
  if (i < 0) return undefined;
  let j = json.indexOf(':', i + key.length);
  if (j < 0) return undefined;
  j++;
  while (j < json.length && /\s/.test(json[j])) j++;
  if (json[j] !== '"') return undefined;
  j++;
  let out = '';
  for (; j < json.length; j++) {
    const c = json[j];
    if (c === '\\') {
      const n = json[j + 1];
      if (n === undefined) break;
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '\r';
      else if (n === 'u') {
        const hex = json.slice(j + 2, j + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        j += 4;
      } else out += n;
      j++;
      continue;
    }
    if (c === '"') break;
    out += c;
  }
  return out;
}

function arg(b: ToolBlock): string {
  const i = b.input || {};
  const p = (k: string) => (typeof i[k] === 'string' && i[k]) || partialField(b.inputText, k) || '';
  switch (b.name) {
    case 'run_command':
      return p('command');
    case 'search':
      return p('pattern') + (i.glob ? `  ·  ${i.glob}` : '');
    case 'find_files':
      return p('pattern');
    case 'move_path':
      return `${p('from')} → ${p('to')}`;
    case 'browser':
      return [i.action || partialField(b.inputText, 'action') || '', i.url || (i.x !== undefined ? `${i.x},${i.y}` : '') || i.text || i.key || ''].filter(Boolean).join(' · ');
    case 'computer':
      return [i.action, i.x !== undefined ? `${i.x},${i.y}` : '', i.text || i.keys || ''].filter(Boolean).join(' · ');
    case 'web_search':
      return p('query');
    case 'web_fetch':
      return p('url');
    case 'install_tool':
      return p('name');
    case 'open_preview':
      return p('target');
    case 'process_output':
    case 'stop_process':
      return p('process_id');
    case 'ask_user':
      return '';
    case 'todo_write':
      return '';
    default:
      return p('path') || '.';
  }
}

function meta(b: ToolBlock): { icon: any; label: string } {
  const running = b.status === 'running' || b.status === 'streaming' || b.status === 'pending' || b.status === 'awaiting-approval';
  const r = b.result?.meta;
  switch (b.name) {
    case 'list_files':
      return { icon: FolderTree, label: tx('Przegląda', 'List') };
    case 'read_file':
      return { icon: FileText, label: tx('Czyta', 'Read') };
    case 'write_file':
      return { icon: r?.created || (!r && running) ? FilePlus2 : FilePen, label: running ? tx('Pisze', 'Writing') : r?.created ? tx('Utworzono', 'Created') : tx('Zapisano', 'Wrote') };
    case 'edit_file':
      return { icon: FilePen, label: running ? tx('Edytuje', 'Editing') : tx('Edytowano', 'Edited') };
    case 'delete_path':
      return { icon: Trash2, label: tx('Usuwa', 'Delete') };
    case 'move_path':
      return { icon: ArrowRightLeft, label: tx('Przenosi', 'Move') };
    case 'search':
      return { icon: Search, label: tx('Szuka', 'Search') };
    case 'find_files':
      return { icon: Search, label: tx('Szuka plików', 'Find files') };
    case 'run_command':
      return { icon: TerminalSquare, label: b.input?.background ? tx('W tle', 'Background') : running ? tx('Uruchamia', 'Running') : tx('Uruchomiono', 'Ran') };
    case 'process_output':
      return { icon: Activity, label: tx('Proces', 'Process') };
    case 'stop_process':
      return { icon: Square, label: tx('Zatrzymuje proces', 'Stop process') };
    case 'browser':
      return { icon: MonitorSmartphone, label: tx('Przeglądarka', 'Browser') };
    case 'open_preview':
      return { icon: Eye, label: tx('Podgląd', 'Preview') };
    case 'screenshot':
      return { icon: Camera, label: tx('Zrzut ekranu pulpitu', 'Desktop screenshot') };
    case 'computer':
      return { icon: MousePointerClick, label: tx('Pulpit', 'Desktop') };
    case 'web_search':
      return { icon: Globe, label: tx('Szuka w sieci', 'Web search') };
    case 'web_fetch':
      return { icon: Globe, label: tx('Pobiera stronę', 'Fetch page') };
    case 'install_tool':
      return { icon: Download, label: running ? tx('Instaluje', 'Installing') : tx('Instalacja', 'Install') };
    case 'extract_archive':
      return { icon: Archive, label: tx('Rozpakowuje', 'Extract') };
    case 'todo_write':
      return { icon: ListChecks, label: tx('Plan zadań', 'Task plan') };
    case 'ask_user':
      return { icon: MessageCircleQuestion, label: tx('Pytanie', 'Question') };
    default:
      return { icon: Activity, label: b.name };
  }
}

function approvalText(b: ToolBlock) {
  const outside = (b.input?.path || '').match(/^[a-z]:\\/i);
  switch (b.name) {
    case 'run_command':
      return tx('Lunarix chce uruchomić komendę:', 'Lunarix wants to run a command:');
    case 'write_file':
    case 'edit_file':
      return outside ? tx('Lunarix chce zmienić plik poza projektem:', 'Lunarix wants to modify a file outside the project:') : tx('Lunarix chce zmienić plik:', 'Lunarix wants to modify a file:');
    case 'delete_path':
      return tx('Lunarix chce usunąć:', 'Lunarix wants to delete:');
    case 'computer':
      return tx('Lunarix chce sterować myszą/klawiaturą:', 'Lunarix wants to control mouse/keyboard:');
    case 'screenshot':
      return tx('Lunarix chce zrobić zrzut ekranu pulpitu.', 'Lunarix wants to take a desktop screenshot.');
    case 'install_tool':
      return tx('Lunarix chce zainstalować narzędzie:', 'Lunarix wants to install a tool:');
    default:
      return tx('Lunarix prosi o zgodę na:', 'Lunarix asks permission for:');
  }
}

function Diff({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="diff">
      {lines.map((l, i) =>
        l.t === '~' ? (
          <div key={i} className="dl gap">
            ···
          </div>
        ) : (
          <div key={i} className={`dl ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : ''}`}>
            <span className="sign">{l.t === ' ' ? '' : l.t === '-' ? '−' : '+'}</span>
            <span>{l.s || ' '}</span>
          </div>
        )
      )}
    </div>
  );
}

function LiveCode({ code, path }: { code: string; path: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const html = useMemo(() => highlightCode(code.length > 40000 ? code.slice(-40000) : code, langFromPath(path)), [code, path]);
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (el) el.scrollTop = el.scrollHeight;
  }, [html]);
  return (
    <pre ref={ref} className="caret-blink" style={{ color: 'var(--fg)' }}>
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

export const ToolCard = memo(function ToolCard({ b, chatId, root }: { b: ToolBlock; chatId: string; root?: string }) {
  const { icon: Icon, label } = meta(b);
  const a = arg(b);
  const running = b.status === 'running' || b.status === 'streaming' || b.status === 'pending';
  const waiting = b.status === 'awaiting-approval' || b.status === 'awaiting-answer';
  const r = b.result;
  const hasImage = !!r?.images?.length;
  const visual = b.name === 'browser' || b.name === 'screenshot' || b.name === 'computer';
  const defaultOpen = waiting || (running && (b.name === 'run_command' || b.name === 'write_file' || b.name === 'install_tool')) || hasImage || (!!r?.isError && b.name === 'run_command');
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? defaultOpen;
  const [feedback, setFeedback] = useState('');
  const [answer, setAnswer] = useState('');

  if (b.name === 'todo_write' && b.status === 'done') {
    const todos: any[] = Array.isArray(b.input?.todos) ? b.input.todos : [];
    const done = todos.filter((t) => t.status === 'completed').length;
    return (
      <div className="notice" style={{ borderStyle: 'solid', borderColor: 'var(--line-2)' }}>
        <ListChecks size={14} />
        {tx('Plan zaktualizowany', 'Plan updated')} · {done}/{todos.length}
        {todos.find((t) => t.status === 'in_progress') && <span className="faint ellipsis">— {todos.find((t) => t.status === 'in_progress').content}</span>}
      </div>
    );
  }

  const statusIcon =
    b.status === 'done' ? (
      <Check size={14} />
    ) : b.status === 'error' ? (
      <X size={14} />
    ) : b.status === 'denied' || b.status === 'cancelled' ? (
      <Ban size={13} />
    ) : waiting ? (
      <ShieldQuestion size={14} />
    ) : (
      <Loader2 size={13} className="spin" />
    );
  const dur = b.endedAt && b.startedAt ? fmtDuration(b.endedAt - b.startedAt) : '';
  const m = r?.meta;
  const path = (b.input?.path as string) || partialField(b.inputText, 'path') || '';
  const absPath = path && root && !/^[a-z]:[\\/]/i.test(path) ? `${root}\\${path.replace(/\//g, '\\')}` : path;
  const canOpen = ['read_file', 'write_file', 'edit_file'].includes(b.name) && path && b.status !== 'error';
  const decide = (d: 'allow' | 'always' | 'deny') => api.approveTool(chatId, b.id, d, d === 'deny' ? feedback : undefined);

  let body: React.ReactNode = null;
  if (b.name === 'write_file' && b.status === 'streaming') {
    body = <LiveCode code={partialField(b.inputText, 'content') || ''} path={path} />;
  } else if (b.status === 'awaiting-approval' && b.name === 'write_file') {
    const code = String(b.input?.content ?? '');
    body = (
      <pre>
        <code dangerouslySetInnerHTML={{ __html: highlightCode(code.length > 30000 ? code.slice(0, 30000) + '\n…' : code, langFromPath(path)) }} />
      </pre>
    );
  } else if (b.status === 'awaiting-approval' && b.name === 'edit_file') {
    const edits: { old_text?: string; new_text?: string }[] = Array.isArray(b.input?.edits) && b.input.edits.length ? b.input.edits : [{ old_text: b.input?.old_text, new_text: b.input?.new_text }];
    const lines: DiffLine[] = [];
    edits.forEach((ed, i) => {
      if (i) lines.push({ t: '~', s: '' });
      for (const s of String(ed.old_text ?? '').split('\n')) lines.push({ t: '-', s });
      for (const s of String(ed.new_text ?? '').split('\n')) lines.push({ t: '+', s });
    });
    body = <Diff lines={lines.slice(0, 400)} />;
  } else if ((b.name === 'write_file' || b.name === 'edit_file') && m?.diff?.length) {
    body = <Diff lines={m.diff} />;
  } else if (b.name === 'run_command') {
    const out = b.live ?? r?.text ?? '';
    body = (
      <pre className="term">
        <span className="prompt">$ {b.input?.command || partialField(b.inputText, 'command')}</span>
        {'\n'}
        {out.length > 30000 ? '…' + out.slice(-30000) : out}
      </pre>
    );
  } else if (b.name === 'install_tool' && (b.live || r)) {
    body = <pre className="term">{b.live ?? r?.text}</pre>;
  } else if (r?.text && b.name !== 'ask_user') {
    body = <pre>{r.text.length > 20000 ? r.text.slice(0, 20000) + '\n…' : r.text}</pre>;
  } else if (b.status === 'streaming' && b.inputText) {
    body = <pre>{b.inputText.slice(-4000)}</pre>;
  }

  return (
    <div className={`tool ${running ? 'running' : ''} ${waiting ? 'waiting' : ''}`}>
      <div className="tool-head" onClick={() => setOpen(!isOpen)}>
        <span className="ticon">
          <Icon size={13} />
        </span>
        <span className="tlabel">{label}</span>
        <span className="targ" title={a}>
          {a}
        </span>
        <span className="tstat">
          {m && (m.added !== undefined || m.removed !== undefined) && (m.added || m.removed) ? (
            <span className="delta">
              +{m.added || 0} −{m.removed || 0}
            </span>
          ) : null}
          {m?.kind === 'command' && m.exitCode !== undefined && m.exitCode !== null && b.status !== 'running' ? <span className="delta">exit {m.exitCode}</span> : null}
          {dur && <span>{dur}</span>}
          {canOpen && (
            <button
              className="icon-btn sm"
              onClick={(e) => {
                e.stopPropagation();
                useEditor.getState().openFile(absPath);
              }}
              data-tip={tx('Otwórz', 'Open')}
            >
              <ExternalLink size={12} />
            </button>
          )}
          {statusIcon}
          <ChevronRight size={13} style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
        </span>
      </div>
      {isOpen && body && !visual && <div className="tool-body">{body}</div>}
      {isOpen &&
        hasImage &&
        r!.images!.map((img) => (
          <img key={img.blobId} className="tool-shot" src={`app://lunarix/blob/${img.blobId}`} alt="" onClick={() => useApp.setState({ lightbox: `app://lunarix/blob/${img.blobId}` })} />
        ))}
      {isOpen && body && visual && (
        <div className="tool-body" style={{ maxHeight: 150 }}>
          {body}
        </div>
      )}
      {b.status === 'awaiting-approval' && (
        <div className="approval">
          <div className="q">
            <ShieldQuestion size={15} /> {approvalText(b)}
          </div>
          <button className="btn sm primary" onClick={() => decide('allow')} autoFocus>
            <Check size={13} /> {tx('Zezwól', 'Allow')}
          </button>
          <button className="btn sm" onClick={() => decide('always')}>
            {tx('Zawsze w tym czacie', 'Always in this chat')}
          </button>
          <input className="input fb" placeholder={tx('Uwagi dla agenta (opcjonalnie)', 'Feedback for the agent (optional)')} value={feedback} onChange={(e) => setFeedback(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && decide('deny')} />
          <button className="btn sm" onClick={() => decide('deny')}>
            <X size={13} /> {tx('Odmów', 'Deny')}
          </button>
        </div>
      )}
      {b.status === 'awaiting-answer' && b.question && (
        <div className="question-card">
          <div style={{ fontWeight: 600, display: 'flex', gap: 7, alignItems: 'center' }}>
            <MessageCircleQuestion size={15} />
            {b.question.question}
          </div>
          {!!b.question.options?.length && (
            <div className="opts">
              {b.question.options.map((o) => (
                <button key={o} className="btn sm" onClick={() => api.answerTool(chatId, b.id, o)}>
                  {o}
                </button>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 6 }}>
            <input className="input" style={{ height: 30 }} placeholder={tx('Twoja odpowiedź…', 'Your answer…')} value={answer} onChange={(e) => setAnswer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && answer.trim() && api.answerTool(chatId, b.id, answer.trim())} autoFocus />
            <button className="btn sm primary" disabled={!answer.trim()} onClick={() => api.answerTool(chatId, b.id, answer.trim())}>
              {tx('Wyślij', 'Send')}
            </button>
          </div>
        </div>
      )}
      {b.name === 'ask_user' && b.status === 'done' && r?.text && (
        <div className="tool-body">
          <pre>
            {b.input?.question}
            {'\n→ '}
            {r.text.replace(/^User answered:\s*/, '')}
          </pre>
        </div>
      )}
    </div>
  );
});
