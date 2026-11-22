import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  ChevronDown,
  Moon,
  MoreHorizontal,
  Copy,
  RotateCcw,
  Pencil,
  Brain,
  ChevronRight,
  AlertTriangle,
  RefreshCw,
  Settings as SettingsIcon,
  Download,
  ArrowDown,
  FileDiff,
  Info,
  Layers,
  Trash2,
  ListChecks,
  FileText,
  Image as ImageIcon,
  FileArchive,
  Check,
  Sparkles,
  Gamepad2,
  Globe,
  LayoutDashboard,
  Search
} from 'lucide-react';
import type { Block, Chat, Message, Todo } from '@shared/types';
import { useApp, useChats } from '../store/app';
import { useEditor } from '../store/editor';
import { api } from '../lib/api';
import { tx } from '../lib/i18n';
import { renderMarkdown } from '../lib/markdown';
import { fmtCost, fmtDuration, fmtTokens, timeAgo, relPath, joinPath } from '../lib/format';
import { bus } from '../lib/commands';
import { Composer } from './Composer';
import { ToolCard } from './ToolCard';
import { LogoMark, LogoTile } from './Logo';
import { modelLabel } from './Chrome';
import { confirmDialog, openMenu, openMenuAt } from './ui';
import { playChime } from '../lib/sound';

export function ChatPanel() {
  const activeChatId = useApp((s) => s.activeChatId);
  const chat = useChats((s) => (activeChatId ? s.chats[activeChatId] : undefined));
  const meta = useApp((s) => s.chatMetas.find((c) => c.id === activeChatId));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!activeChatId) return;
    if (!useChats.getState().chats[activeChatId]) {
      setLoading(true);
      useChats
        .getState()
        .load(activeChatId)
        .finally(() => setLoading(false));
    }
  }, [activeChatId]);

  const running = !!meta?.running;
  return (
    <div className="col" style={{ height: '100%', minHeight: 0 }}>
      <ChatHeader chat={chat || null} />
      {loading && !chat ? (
        <div className="grow" style={{ padding: 20 }}>
          <div className="skeleton" style={{ height: 60, marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 120 }} />
        </div>
      ) : chat && chat.messages.length ? (
        <MessageList chat={chat} running={running} />
      ) : (
        <EmptyChat />
      )}
      <Composer chat={chat || null} running={running} />
    </div>
  );
}

function ChatHeader({ chat }: { chat: Chat | null }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const metas = useApp((s) => s.chatMetas);
  const projectId = useApp((s) => s.projectId);
  const save = async () => {
    setEditing(false);
    if (chat && val.trim() && val.trim() !== chat.title) await api.renameChat(chat.id, val.trim());
  };
  const history = (el: HTMLElement) => {
    const list = metas.filter((c) => c.projectId === projectId).slice(0, 14);
    openMenuAt(el, [
      { header: tx('Czaty w projekcie', 'Chats in project') },
      ...list.map((c) => ({
        label: c.title,
        icon: c.running ? <span className="pulse-dot" /> : c.id === chat?.id ? <Check size={13} /> : <span style={{ width: 13 }} />,
        shortcut: timeAgo(c.updatedAt),
        onClick: () => useApp.getState().openChat(c.id)
      })),
      { separator: true },
      { label: tx('Wszystkie czaty…', 'All chats…'), onClick: () => useApp.getState().patchUi({ sidebarVisible: true, sidebarView: 'chats' }) }
    ]);
  };
  const more = (el: HTMLElement) =>
    openMenuAt(
      el,
      [
        { label: tx('Zmień nazwę', 'Rename'), icon: <Pencil size={14} />, onClick: () => chat && (setVal(chat.title), setEditing(true)) },
        { label: tx('Skompaktuj kontekst', 'Compact context'), icon: <Layers size={14} />, onClick: () => chat && api.compactChat(chat.id).catch((e) => useApp.getState().toast(e.message, 'error')) },
        {
          label: tx('Kopiuj rozmowę jako Markdown', 'Copy chat as Markdown'),
          icon: <Copy size={14} />,
          onClick: () => {
            if (!chat) return;
            const md = chat.messages
              .map((m) => {
                const t = m.blocks
                  .map((b) => (b.type === 'text' ? b.text : b.type === 'tool' ? `> 🔧 ${b.name} ${b.input?.path || b.input?.command || ''}` : b.type === 'attachment' ? `📎 ${b.name}` : ''))
                  .filter(Boolean)
                  .join('\n\n');
                return `### ${m.role === 'user' ? tx('Ty', 'You') : 'Lunarix'}\n\n${t}`;
              })
              .join('\n\n');
            api.clipboardWrite(md);
            useApp.getState().toast(tx('Skopiowano', 'Copied'), 'success');
          }
        },
        { separator: true },
        {
          label: tx('Usuń czat', 'Delete chat'),
          icon: <Trash2 size={14} />,
          danger: true,
          onClick: async () => {
            if (chat && (await confirmDialog(tx('Usunąć czat?', 'Delete chat?'), chat.title, tx('Usuń', 'Delete'), true))) await api.deleteChat(chat.id);
          }
        }
      ],
      'right'
    );
  return (
    <div className="chat-head">
      {editing ? (
        <input
          className="ctitle"
          autoFocus
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
      ) : (
        <div
          className="ctitle"
          title={tx('Kliknij dwukrotnie, aby zmienić nazwę', 'Double-click to rename')}
          onDoubleClick={() => {
            if (!chat) return;
            setVal(chat.title);
            setEditing(true);
          }}
        >
          {chat?.title || tx('Nowy czat', 'New chat')}
        </div>
      )}
      <button className="icon-btn" onClick={(e) => history(e.currentTarget)} data-tip={tx('Historia', 'History')}>
        <ChevronDown size={15} />
      </button>
      <button className="icon-btn" onClick={() => useApp.getState().newChat().then(() => bus.emit('focus-composer'))} data-tip={tx('Nowy czat (Ctrl+N)', 'New chat (Ctrl+N)')}>
        <Plus size={16} />
      </button>
      <button className="icon-btn" onClick={() => useApp.setState({ chill: true })} data-tip={tx('Tryb Chill', 'Chill Mode')}>
        <Moon size={15} />
      </button>
      {chat && (
        <button className="icon-btn" onClick={(e) => more(e.currentTarget)}>
          <MoreHorizontal size={16} />
        </button>
      )}
    </div>
  );
}

function EmptyChat() {
  const profile = useApp((s) => s.settings!.profile);
  const s = (pl: string, en: string, icon: any) => ({ text: tx(pl, en), icon });
  const all = {
    web: s('Zbuduj nowoczesną stronę-portfolio z animacjami i trybem ciemnym', 'Build a modern portfolio website with animations and dark mode', Globe),
    fullstack: s('Stwórz aplikację do zadań: React + Vite + TypeScript, z zapisem w localStorage', 'Create a todo app: React + Vite + TypeScript with localStorage', LayoutDashboard),
    games: s('Zrób grywalną grę w węża w przeglądarce z punktacją i poziomami', 'Make a playable browser snake game with score and levels', Gamepad2),
    python: s('Napisz skrypt w Pythonie, który porządkuje pliki w folderze Pobrane', 'Write a Python script that organizes my Downloads folder', FileText),
    analyze: s('Przeanalizuj ten projekt i opisz, jak działa', 'Analyze this project and explain how it works', Search)
  };
  const order = profile.useCases.includes('games') ? ['games', 'web', 'fullstack', 'analyze'] : profile.useCases.includes('python') ? ['python', 'web', 'games', 'analyze'] : ['web', 'fullstack', 'games', 'analyze'];
  return (
    <div className="messages">
      <div className="empty-chat fade-up">
        <LogoTile size={72} className="logo-xl" animated />
        <h2>{tx('Co dziś budujemy?', 'What are we building today?')}</h2>
        <p>{tx('Opisz pomysł — Lunarix zaplanuje, napisze, uruchomi i przetestuje kod. Ty możesz odpocząć.', 'Describe your idea — Lunarix plans, writes, runs and tests the code. You can relax.')}</p>
        <div className="suggestions">
          {order.map((k) => {
            const it = (all as any)[k];
            return (
              <button key={k} className="suggestion" onClick={() => useApp.getState().fillComposer(it.text)}>
                <it.icon size={15} style={{ flex: 'none' }} />
                {it.text}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- messages

interface Group {
  key: string;
  user?: Message;
  assistant: Message[];
}

function MessageList({ chat, running }: { chat: Chat; running: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [showDown, setShowDown] = useState(false);
  const status = useApp((s) => s.status[chat.id]);
  const todos = useApp((s) => s.todos[chat.id]) || chat.todos;
  const project = useApp((s) => s.projects.find((p) => p.id === chat.projectId));
  const [limit, setLimit] = useState(60);
  const { show: showPlan, done: planDone } = usePlanVisibility(todos, running);

  const groups = useMemo(() => {
    const out: Group[] = [];
    for (const m of chat.messages) {
      if (m.role === 'user') out.push({ key: m.id, user: m, assistant: [] });
      else {
        const last = out[out.length - 1];
        if (last) last.assistant.push(m);
        else out.push({ key: m.id, assistant: [m] });
      }
    }
    return out;
  }, [chat.messages]);

  const visible = groups.length > limit ? groups.slice(groups.length - limit) : groups;

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  useEffect(() => {
    stick.current = true;
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.id]);

  const onScroll = () => {
    const el = ref.current!;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    stick.current = near;
    setShowDown(!near);
  };

  const last = chat.messages[chat.messages.length - 1];
  const thinkingIdle = running && (!last || last.role === 'user' || (last.status !== 'streaming' && !last.blocks.some((b) => b.type === 'tool' && (b.status === 'running' || b.status.startsWith('awaiting')))) || (last.status === 'streaming' && last.blocks.length === 0));

  return (
    <div className="messages" ref={ref} onScroll={onScroll} style={{ position: 'relative' }}>
      {showPlan && todos && <TodoCard todos={todos} sticky={running} leaving={!running && planDone} />}
      {groups.length > limit && (
        <div style={{ textAlign: 'center', margin: '4px 0 10px' }}>
          <button className="btn sm ghost" onClick={() => setLimit((l) => l + 60)}>
            {tx('Pokaż wcześniejsze wiadomości', 'Show earlier messages')}
          </button>
        </div>
      )}
      {visible.map((g, gi) => (
        <div key={g.key}>
          {chat.compactAt !== undefined && g.user && chat.messages.indexOf(g.user) === chat.compactAt && (
            <div className="notice" style={{ margin: '10px 16px' }}>
              <Layers size={14} /> {tx('Kontekst skompaktowany — wcześniejsza rozmowa zastąpiona podsumowaniem.', 'Context compacted — earlier conversation summarized.')}
            </div>
          )}
          {g.user && <UserMessage m={g.user} chatId={chat.id} running={running} />}
          {g.assistant.length > 0 && <AssistantGroup msgs={g.assistant} chat={chat} root={project?.path} isLast={gi === visible.length - 1} running={running} turnId={g.user?.id} />}
        </div>
      ))}
      {running && (thinkingIdle || status) && (
        <div className="status-line fade-in">
          <span className="typing">
            <i />
            <i />
            <i />
          </span>
          <span className="shimmer">{status || tx('Lunarix myśli…', 'Lunarix is thinking…')}</span>
        </div>
      )}
      {showDown && (
        <button
          className="btn sm"
          style={{ position: 'sticky', bottom: 8, left: '50%', transform: 'translateX(-50%)', borderRadius: 20, boxShadow: 'var(--shadow-sm)', zIndex: 5 }}
          onClick={() => {
            const el = ref.current!;
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
            stick.current = true;
          }}
        >
          <ArrowDown size={13} /> {tx('Na dół', 'Bottom')}
        </button>
      )}
    </div>
  );
}

/**
 * The plan is shown while the agent works, and while it still has open items (task stopped
 * halfway). Once the task is finished and every item is ticked, it stays for a moment so the
 * user sees it complete, then fades away.
 */
export function usePlanVisibility(todos: Todo[] | undefined, running: boolean) {
  const done = !!todos?.length && todos.every((t) => t.status === 'completed');
  const wasRunning = useRef(running);
  const [linger, setLinger] = useState(false);
  useEffect(() => {
    const stopped = wasRunning.current && !running;
    wasRunning.current = running;
    if (running) setLinger(false);
    if (!stopped || !done) return;
    setLinger(true);
    const t = setTimeout(() => setLinger(false), 2600);
    return () => clearTimeout(t);
  }, [running, done]);
  return { show: !!todos?.length && (running || !done || linger), done };
}

export function TodoCard({ todos, sticky, leaving }: { todos: Todo[]; sticky?: boolean; leaving?: boolean }) {
  const [open, setOpen] = useState(true);
  const done = todos.filter((t) => t.status === 'completed').length;
  return (
    <div className={`msg${leaving ? ' todo-leaving' : ''}`} style={sticky ? { position: 'sticky', top: -14, zIndex: 4, paddingTop: 0 } : undefined}>
      <div className="todo-card" style={sticky ? { boxShadow: 'var(--shadow-sm)' } : undefined}>
        <div className="th" onClick={() => setOpen(!open)} style={{ cursor: 'pointer' }}>
          <ListChecks size={14} />
          <span>{tx('Plan', 'Plan')}</span>
          <span className="faint" style={{ fontWeight: 500 }}>
            {done}/{todos.length}
          </span>
          <div className="progress">
            <i style={{ width: `${(done / Math.max(1, todos.length)) * 100}%` }} />
          </div>
          <ChevronDown size={13} style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }} />
        </div>
        {open &&
          todos.map((t, i) => (
            <div key={i} className={`todo ${t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : ''}`}>
              <span className="box">{t.status === 'completed' && <Check size={10} strokeWidth={3} />}</span>
              <span>{t.content}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

const UserMessage = memo(function UserMessage({ m, chatId, running }: { m: Message; chatId: string; running: boolean }) {
  const text = m.blocks
    .filter((b) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');
  const atts = m.blocks.filter((b) => b.type === 'attachment') as Extract<Block, { type: 'attachment' }>[];
  const restore = async () => {
    const ok = await confirmDialog(
      tx('Przywrócić stan sprzed tej wiadomości?', 'Restore the state before this message?'),
      tx('Pliki zmienione przez agenta od tego momentu zostaną przywrócone, a rozmowa cofnięta do tej wiadomości (jej treść wróci do pola wpisywania).', 'Files changed by the agent since then will be restored and the chat rewound to this message (its text returns to the input box).'),
      tx('Przywróć', 'Restore')
    );
    if (!ok) return;
    try {
      const r = await api.restoreCheckpoint(chatId, m.id);
      useApp.getState().fillComposer(r.text);
      useApp.getState().toast(tx(`Przywrócono ${r.restored} plików`, `Restored ${r.restored} files`), 'success');
    } catch (e: any) {
      useApp.getState().toast(e.message, 'error');
    }
  };
  return (
    <div className="msg msg-user">
      {m.mode && m.mode !== 'agent' && <div className="mode-chip">{m.mode === 'plan' ? 'Plan' : 'Ask'}</div>}
      {atts.length > 0 && (
        <div className="atts">
          {atts.map((a, i) =>
            a.kind === 'image' && a.images?.[0] ? (
              <img key={i} className="att-img" src={`app://lunarix/blob/${a.images[0].blobId}`} alt={a.name} onClick={() => useApp.setState({ lightbox: `app://lunarix/blob/${a.images![0].blobId}` })} />
            ) : (
              <div key={i} className="att" title={a.savedPath}>
                <span className="ico">{a.kind === 'archive' ? <FileArchive size={12} /> : a.kind === 'image' ? <ImageIcon size={12} /> : <FileText size={12} />}</span>
                <span className="aname">{a.name}</span>
                <span className="asum">{a.summary}</span>
              </div>
            )
          )}
        </div>
      )}
      {text && <div className="bubble">{text}</div>}
      <div className="meta">
        <button className="icon-btn sm" data-tip={tx('Kopiuj', 'Copy')} onClick={() => api.clipboardWrite(text)}>
          <Copy size={12} />
        </button>
        <button className="icon-btn sm" data-tip={tx('Edytuj i wyślij ponownie', 'Edit & resend')} onClick={() => useApp.getState().fillComposer(text)}>
          <Pencil size={12} />
        </button>
        {!running && (
          <button className="icon-btn sm" data-tip={tx('Przywróć punkt kontrolny', 'Restore checkpoint')} onClick={restore}>
            <RotateCcw size={12} />
          </button>
        )}
      </div>
    </div>
  );
});

function AssistantGroup({ msgs, chat, root, isLast, running, turnId }: { msgs: Message[]; chat: Chat; root?: string; isLast: boolean; running: boolean; turnId?: string }) {
  const models = useApp((s) => s.models);
  const first = msgs.find((m) => m.model) || msgs[0];
  const usage = msgs.reduce(
    (a, m) => ({ input: a.input + (m.usage?.input || 0), output: a.output + (m.usage?.output || 0), cost: a.cost + (m.usage?.cost || 0), est: a.est || !!m.usage?.estimated }),
    { input: 0, output: 0, cost: 0, est: false }
  );
  const duration = msgs.reduce((a, m) => a + (m.durationMs || 0), 0);
  const tps = [...msgs].reverse().find((m) => m.tokensPerSec)?.tokensPerSec;
  const changed = msgs.some((m) => m.blocks.some((b) => b.type === 'tool' && ['write_file', 'edit_file', 'delete_path', 'move_path', 'extract_archive'].includes(b.name) && b.status === 'done'));
  const groupRunning = isLast && running;
  const onlyNotices = msgs.every((m) => m.blocks.every((b) => b.type === 'notice'));

  const review = async (el: HTMLElement) => {
    if (!turnId) return;
    const changes = await api.turnChanges(chat.id, turnId);
    if (!changes.length) {
      useApp.getState().toast(tx('Brak zmian w plikach (lub zostały już cofnięte).', 'No file changes (or already reverted).'));
      return;
    }
    openMenuAt(el, [
      { header: tx(`Zmienione pliki (${changes.length})`, `Changed files (${changes.length})`) },
      ...changes.slice(0, 30).map((c) => ({
        label: relPath(c.path, root) + (c.before === null ? ` (${tx('nowy', 'new')})` : c.after === null ? ` (${tx('usunięty', 'deleted')})` : ''),
        icon: <FileDiff size={14} />,
        onClick: () => (c.binary ? useEditor.getState().openFile(c.path) : useEditor.getState().openDiff(c.path, c.before ?? '', c.after ?? '', tx('przed', 'before')))
      }))
    ]);
  };

  return (
    <div className="msg msg-assistant">
      {!onlyNotices && (
        <div className="assistant-head">
          <LogoMark size={15} className="logo" />
          <b>Lunarix</b>
          <span>· {first?.model ? modelLabel(first.model.provider, first.model.model, models) : ''}</span>
        </div>
      )}
      {msgs.map((m) => (
        <AssistantMessage key={m.id} m={m} chatId={chat.id} root={root} />
      ))}
      {!groupRunning && !onlyNotices && (
        <div className={`msg-footer ${isLast ? 'show' : ''}`}>
          {usage.input + usage.output > 0 && (
            <span data-tip={tx('tokeny wejście / wyjście', 'tokens in / out')} data-tip-pos="top">
              {usage.est ? '~' : ''}
              {fmtTokens(usage.input)} ↑ {fmtTokens(usage.output)} ↓
            </span>
          )}
          {usage.cost > 0 && <span>{fmtCost(usage.cost)}</span>}
          {duration > 0 && <span>{fmtDuration(duration)}</span>}
          {tps ? <span>{tps.toFixed(1)} tok/s</span> : null}
          <div className="grow" />
          {changed && turnId && (
            <button className="btn sm ghost" onClick={(e) => review(e.currentTarget)}>
              <FileDiff size={12} /> {tx('Przejrzyj zmiany', 'Review changes')}
            </button>
          )}
          <button
            className="icon-btn sm"
            data-tip={tx('Kopiuj odpowiedź', 'Copy answer')}
            data-tip-pos="top"
            onClick={() =>
              api.clipboardWrite(
                msgs
                  .flatMap((m) => m.blocks)
                  .filter((b) => b.type === 'text')
                  .map((b: any) => b.text)
                  .join('\n\n')
              )
            }
          >
            <Copy size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

const AssistantMessage = memo(function AssistantMessage({ m, chatId, root }: { m: Message; chatId: string; root?: string }) {
  const streaming = m.status === 'streaming';
  return (
    <>
      {m.blocks.map((b, i) => {
        const isLastBlock = i === m.blocks.length - 1;
        switch (b.type) {
          case 'text':
            return b.text.trim() ? <Markdown key={i} text={b.text} streaming={streaming && isLastBlock} /> : null;
          case 'thinking':
            return <Thinking key={i} text={b.text} live={streaming && !b.done} />;
          case 'tool':
            return <ToolCard key={b.id} b={b} chatId={chatId} root={root} />;
          case 'error':
            return <ErrorBlock key={i} text={b.text} code={b.code} chatId={chatId} />;
          case 'notice':
            return (
              <div key={i} className="notice">
                {b.level === 'compact' ? <Layers size={14} /> : <Info size={14} />} {b.text}
              </div>
            );
          case 'image':
            return <img key={i} className="tool-shot" src={`app://lunarix/blob/${b.blobId}`} alt="" />;
          default:
            return null;
        }
      })}
      {m.status === 'stopped' && <div className="notice">{tx('Zatrzymano.', 'Stopped.')}</div>}
    </>
  );
});

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  const words = text.trim().split(/\s+/).length;
  return (
    <div className="thinking">
      <div className="th-head" onClick={() => setOpen(!open)}>
        <Brain size={13} />
        {live ? <span className="shimmer">{tx('Myśli…', 'Thinking…')}</span> : <span>{tx(`Przemyślenia · ${words} słów`, `Thought · ${words} words`)}</span>}
        <ChevronRight size={12} style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
      </div>
      {open && <div className="th-body">{text.trim()}</div>}
    </div>
  );
}

const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  const onClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const copy = t.closest('[data-copy]');
    if (copy) {
      const code = copy.closest('pre')?.querySelector('code')?.textContent || '';
      api.clipboardWrite(code);
      useApp.getState().toast(tx('Skopiowano kod', 'Code copied'), 'success');
      return;
    }
    const a = t.closest('a');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('data-href') || a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href)) api.openExternal(href);
      else if (href) {
        const proj = useApp.getState().project();
        const p = /^[a-z]:[\\/]/i.test(href) ? href : proj ? joinPath(proj.path, href.replace(/^\.\//, '')) : href;
        api.exists(p).then((ok) => ok && useEditor.getState().openFile(p));
      }
    }
  };
  return <div className={`md ${streaming ? 'caret-blink' : ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});

function ErrorBlock({ text, code, chatId }: { text: string; code?: string; chatId: string }) {
  const local = useApp((s) => s.settings?.activeModel);
  return (
    <div className="error-block">
      <div className="eh">
        <AlertTriangle size={15} /> {tx('Coś poszło nie tak', 'Something went wrong')}
      </div>
      {text}
      <div className="acts">
        <button className="btn sm" onClick={() => api.retryChat(chatId)}>
          <RefreshCw size={12} /> {tx('Ponów', 'Retry')}
        </button>
        {code === 'auth' && (
          <button className="btn sm" onClick={() => useApp.getState().setModal('settings', 'providers')}>
            <SettingsIcon size={12} /> {tx('Klucze API', 'API keys')}
          </button>
        )}
        {code === 'model_missing' && (
          <button
            className="btn sm primary"
            onClick={() => {
              if (local?.provider === 'local') api.downloadTier(local.model as any);
              useApp.getState().setModal('settings', 'local');
            }}
          >
            <Download size={12} /> {tx('Pobierz model', 'Download model')}
          </button>
        )}
        {code === 'engine_crash' && (
          <button className="btn sm" onClick={() => useApp.getState().setModal('settings', 'local')}>
            <SettingsIcon size={12} /> {tx('Modele lokalne', 'Local models')}
          </button>
        )}
        {(code === 'rate' || code === 'auth' || code === 'network' || code === 'engine_crash') && (
          <button className="btn sm" onClick={() => bus.emit('open-model-picker')}>
            <Sparkles size={12} /> {tx('Zmień model', 'Change model')}
          </button>
        )}
      </div>
    </div>
  );
}

export function onRunFinished(chatId: string, done: boolean) {
  const s = useApp.getState();
  if (done && s.settings?.agent.sound) playChime();
  if (done && s.activeChatId !== chatId) {
    const meta = s.chatMetas.find((c) => c.id === chatId);
    s.toast(tx(`Agent skończył: ${meta?.title || ''}`, `Agent finished: ${meta?.title || ''}`), 'success');
  }
}
