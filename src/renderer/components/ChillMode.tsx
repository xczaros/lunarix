import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Square, ArrowUp, Check, Volume2, VolumeX } from 'lucide-react';
import type { Block, Chat } from '@shared/types';
import { useApp, useChats } from '../store/app';
import { api } from '../lib/api';
import { tx } from '../lib/i18n';
import { fmtTokens } from '../lib/format';
import { LogoTile } from './Logo';
import { Stars } from './Stars';
import { usePlanVisibility } from './ChatPanel';

type ToolBlock = Extract<Block, { type: 'tool' }>;

const stripMd = (s: string) =>
  s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>]/g, '')
    .replace(/^\s*[-•]\s+/gm, '• ')
    .replace(/\s*\n+\s*/g, ' ')
    .trim();

function describe(b: ToolBlock): string {
  const i = b.input || {};
  const short = (p?: string) => (p || '').split(/[\\/]/).slice(-2).join('/');
  switch (b.name) {
    case 'write_file':
      return tx(`Piszę ${short(i.path)}`, `Writing ${short(i.path)}`);
    case 'edit_file':
      return tx(`Poprawiam ${short(i.path)}`, `Editing ${short(i.path)}`);
    case 'read_file':
      return tx(`Czytam ${short(i.path)}`, `Reading ${short(i.path)}`);
    case 'list_files':
      return tx('Przeglądam projekt', 'Exploring the project');
    case 'search':
    case 'find_files':
      return tx('Przeszukuję kod', 'Searching the code');
    case 'run_command':
      return tx(`Uruchamiam: ${String(i.command || '').slice(0, 60)}`, `Running: ${String(i.command || '').slice(0, 60)}`);
    case 'browser':
      return tx('Testuję w przeglądarce', 'Testing in the browser');
    case 'screenshot':
    case 'computer':
      return tx('Testuję na pulpicie', 'Testing on the desktop');
    case 'install_tool':
      return tx(`Instaluję ${i.name}`, `Installing ${i.name}`);
    case 'web_search':
    case 'web_fetch':
      return tx('Szukam w internecie', 'Searching the web');
    case 'todo_write':
      return tx('Planuję kolejne kroki', 'Planning the next steps');
    case 'ask_user':
      return tx('Mam pytanie do Ciebie', 'I have a question for you');
    default:
      return tx('Pracuję…', 'Working…');
  }
}

export function ChillMode() {
  const activeChatId = useApp((s) => s.activeChatId);
  const metas = useApp((s) => s.chatMetas);
  const running = metas.filter((c) => c.running);
  const chatId = running.find((c) => c.id === activeChatId)?.id || running[0]?.id || activeChatId;
  const chat = useChats((s) => (chatId ? s.chats[chatId] : undefined));
  const meta = metas.find((c) => c.id === chatId);
  const todos = useApp((s) => (chatId ? s.todos[chatId] : undefined)) || chat?.todos;
  const status = useApp((s) => (chatId ? s.status[chatId] : undefined));
  const theme = useApp((s) => s.settings!.theme);
  const sound = useApp((s) => s.settings!.agent.sound);
  const [now, setNow] = useState(Date.now());
  const [text, setText] = useState('');
  const close = () => useApp.setState({ chill: false });

  useEffect(() => {
    if (chatId && !useChats.getState().chats[chatId]) useChats.getState().load(chatId);
  }, [chatId]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', k);
    return () => {
      clearInterval(t);
      window.removeEventListener('keydown', k);
    };
  }, []);

  const info = useMemo(() => {
    if (!chat) return null;
    const lastUserIdx = chat.messages.map((m) => m.role).lastIndexOf('user');
    const turn = chat.messages.slice(lastUserIdx + 1);
    const tools = turn.flatMap((m) => m.blocks.filter((b) => b.type === 'tool')) as ToolBlock[];
    const current = [...tools].reverse().find((b) => ['running', 'streaming', 'awaiting-approval', 'awaiting-answer'].includes(b.status));
    const shot = [...tools].reverse().find((b) => b.result?.images?.length)?.result?.images?.[0];
    const feed = tools.slice(-8).map((b) => `${b.status === 'done' ? '✓' : b.status === 'error' ? '✗' : '›'} ${describe(b)}`);
    const started = chat.messages[lastUserIdx]?.createdAt || Date.now();
    const lastText = [...turn].reverse().flatMap((m) => m.blocks).find((b) => b.type === 'text') as any;
    const tokens = turn.reduce((a, m) => a + (m.usage?.output || 0), 0);
    const waiting = tools.some((b) => b.status === 'awaiting-approval' || b.status === 'awaiting-answer');
    return { current, shot, feed, started, lastText: lastText?.text as string | undefined, tokens, waiting };
  }, [chat]);

  const isRunning = !!meta?.running;
  const { show: showPlan, done: planDone } = usePlanVisibility(todos, isRunning);
  const elapsed = info ? Math.max(0, Math.floor((now - info.started) / 1000)) : 0;
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');
  const headline = isRunning
    ? info?.waiting
      ? tx('Czekam na Twoją decyzję w czacie', 'Waiting for your decision in the chat')
      : status || (info?.current ? describe(info.current) : tx('Myślę…', 'Thinking…'))
    : chat && chat.messages.length
      ? tx('Gotowe. Możesz sprawdzić efekt.', 'Done. You can check the result.')
      : tx('Opisz zadanie i odpocznij', 'Describe a task and relax');

  const send = async () => {
    if (!text.trim()) return;
    let c: Chat | undefined = chat;
    if (!c) c = await useApp.getState().newChat();
    await api.sendMessage(c.id, { text: text.trim() });
    setText('');
  };

  return (
    <div className="chill">
      <Stars light={theme === 'light'} density={0.00022} />
      <div className="ch-top">
        <button className="ch-btn" onClick={close}>
          <ArrowLeft size={14} /> {tx('Wróć do edytora', 'Back to editor')}
        </button>
        <span style={{ marginLeft: 6 }}>{meta?.title}</span>
        <div className="grow" />
        <button className="ch-btn" onClick={() => useApp.getState().patchSettings({ agent: { ...useApp.getState().settings!.agent, sound: !sound } })}>
          {sound ? <Volume2 size={14} /> : <VolumeX size={14} />}
        </button>
      </div>
      <div className="ch-center">
        <LogoTile size={150} className="moon" animated={isRunning} />
        <div className="ch-status" key={headline}>
          <span className={isRunning ? 'shimmer' : 'fade-up'} style={isRunning ? undefined : { display: 'inline-block' }}>
            {!isRunning && chat && chat.messages.length ? <Check size={20} style={{ verticalAlign: -3, marginRight: 8 }} /> : null}
            {headline}
          </span>
        </div>
        {isRunning && (
          <div className="ch-sub">
            <span className="elapsed">
              {mm}:{ss}
            </span>{' '}
            · {fmtTokens(info?.tokens)} {tx('tokenów wygenerowanych', 'tokens generated')}
          </div>
        )}
        {!isRunning && info?.lastText && (
          <div className="ch-sub" style={{ maxWidth: 640, opacity: 0.75, fontSize: 13.5, lineHeight: 1.6 }}>
            {stripMd(info.lastText).slice(0, 320)}
            {stripMd(info.lastText).length > 320 ? '…' : ''}
          </div>
        )}
        {showPlan && todos && (
          <div className={`ch-todos${!isRunning && planDone ? ' todo-leaving' : ''}`}>
            {todos.map((t, i) => (
              <div key={i} className={`todo ${t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'doing' : ''}`}>
                <span className="box">{t.status === 'completed' && <Check size={10} strokeWidth={3} />}</span>
                <span>{t.content}</span>
              </div>
            ))}
          </div>
        )}
        {isRunning ? (
          <div className="row" style={{ marginTop: 10 }}>
            {info?.waiting && (
              <button className="ch-btn" onClick={close}>
                {tx('Przejdź do decyzji', 'Go to the decision')}
              </button>
            )}
            <button className="ch-btn" onClick={() => chatId && api.stopChat(chatId)}>
              <Square size={12} /> {tx('Zatrzymaj', 'Stop')}
            </button>
          </div>
        ) : (
          <div className="row" style={{ marginTop: 14, width: 'min(560px, 90vw)' }}>
            <input
              className="input grow"
              style={{ height: 42, borderRadius: 12, background: 'rgba(127,127,127,.08)', fontSize: 14 }}
              placeholder={tx('Np. „Zbuduj grę w węża w przeglądarce”', 'E.g. "Build a snake game in the browser"')}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              autoFocus
            />
            <button className="ch-btn" style={{ height: 42 }} onClick={send} disabled={!text.trim()}>
              <ArrowUp size={15} />
            </button>
          </div>
        )}
      </div>
      <div className="ch-log">
        <div className="ch-feed">
          {(info?.feed || []).map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
        {info?.shot && <img key={info.shot.blobId} className="ch-shot" src={`app://lunarix/blob/${info.shot.blobId}`} alt="" />}
      </div>
    </div>
  );
}
