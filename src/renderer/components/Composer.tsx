import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Paperclip,
  Square,
  Wand2,
  Loader2,
  X,
  ChevronDown,
  Bot,
  ListTodo,
  MessageCircleQuestion,
  ShieldCheck,
  ShieldAlert,
  Moon,
  FileText,
  Image as ImageIcon,
  FileArchive,
  AtSign
} from 'lucide-react';
import type { AgentMode, ApprovalMode, AttachmentInput, Chat, ModelRef } from '@shared/types';
import { tierById } from '@shared/catalog';
import { useApp } from '../store/app';
import { api } from '../lib/api';
import { tx } from '../lib/i18n';
import { basename, fmtTokens, relPath, joinPath } from '../lib/format';
import { bus, runCommand } from '../lib/commands';
import { ModelPicker } from './ModelPicker';
import { ModelAdvisor } from './ModelAdvisor';
import { modelLabel } from './Chrome';
import { openMenuAt, Ring } from './ui';

interface PendingAtt {
  key: string;
  input: AttachmentInput;
  name: string;
  preview?: string;
}

const SLASH: { cmd: string; pl: string; en: string }[] = [
  { cmd: '/new', pl: 'Nowy czat', en: 'New chat' },
  { cmd: '/plan', pl: 'Tryb planowania (tylko analiza i plan)', en: 'Plan mode (analysis & plan only)' },
  { cmd: '/ask', pl: 'Tryb pytań (bez zmian w plikach)', en: 'Ask mode (no file changes)' },
  { cmd: '/agent', pl: 'Tryb agenta (pełna autonomia)', en: 'Agent mode (full autonomy)' },
  { cmd: '/chill', pl: 'Tryb Chill — pełny ekran, AI pracuje', en: 'Chill Mode — fullscreen while AI works' },
  { cmd: '/init', pl: 'Przeanalizuj projekt i utwórz LUNARIX.md (pamięć projektu)', en: 'Analyze project & create LUNARIX.md (project memory)' },
  { cmd: '/test', pl: 'Uruchom i przetestuj projekt, napraw błędy', en: 'Run & test the project, fix errors' },
  { cmd: '/fix', pl: 'Znajdź i napraw błędy w projekcie', en: 'Find and fix bugs in the project' },
  { cmd: '/review', pl: 'Zrób code review projektu', en: 'Code review the project' },
  { cmd: '/explain', pl: 'Wyjaśnij, jak działa projekt', en: 'Explain how the project works' },
  { cmd: '/compact', pl: 'Skompaktuj kontekst rozmowy', en: 'Compact the conversation context' },
  { cmd: '/undo', pl: 'Cofnij zmiany z ostatniej wiadomości', en: 'Undo the changes from the last message' },
  { cmd: '/model', pl: 'Wybierz model', en: 'Choose a model' },
  { cmd: '/usage', pl: 'Zużycie tokenów', en: 'Token usage' },
  { cmd: '/settings', pl: 'Ustawienia', en: 'Settings' }
];

const PROMPTS: Record<string, [string, string]> = {
  '/init': [
    'Przeanalizuj ten projekt (struktura, technologie, komendy build/run/test, konwencje) i utwórz plik LUNARIX.md z najważniejszymi informacjami i zasadami pracy w tym projekcie. Ten plik będzie Twoją pamięcią projektu.',
    'Analyze this project (structure, technologies, build/run/test commands, conventions) and create LUNARIX.md with the key information and working rules for this project. This file will be your project memory.'
  ],
  '/test': ['Uruchom projekt i dokładnie go przetestuj (build, testy, a dla UI — przeglądarka ze zrzutami ekranu). Napraw wszystkie znalezione błędy i powtórz test.', 'Run the project and test it thoroughly (build, tests, and for UIs the browser with screenshots). Fix every error you find and test again.'],
  '/fix': ['Znajdź błędy w projekcie (uruchom go, sprawdź konsolę i logi) i napraw je wszystkie. Na koniec potwierdź, że działa.', 'Find bugs in the project (run it, check console and logs) and fix all of them. Confirm it works at the end.'],
  '/review': ['Zrób dokładne code review tego projektu: błędy, bezpieczeństwo, wydajność, czytelność. Podaj konkretne propozycje poprawek.', 'Do a thorough code review of this project: bugs, security, performance, readability. Give concrete improvement suggestions.'],
  '/explain': ['Wyjaśnij prostymi słowami, jak działa ten projekt: struktura, najważniejsze pliki i przepływ danych.', 'Explain in simple words how this project works: structure, key files and data flow.']
};

let attKey = 0;
const NO_QUEUE: string[] = [];

export function Composer({ chat, running }: { chat: Chat | null; running: boolean }) {
  const settings = useApp((s) => s.settings!);
  const models = useApp((s) => s.models);
  const project = useApp((s) => s.projects.find((p) => p.id === s.projectId));
  const fill = useApp((s) => s.composerFill);
  const engine = useApp((s) => s.engine);
  const queue = useApp((s) => (chat ? s.queue[chat.id] : undefined)) || NO_QUEUE;
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<PendingAtt[]>([]);
  const [focus, setFocus] = useState(false);
  const [drag, setDrag] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const [slashHi, setSlashHi] = useState(0);
  const [mention, setMention] = useState<{ q: string; files: string[]; hi: number } | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const modelBtn = useRef<HTMLButtonElement>(null);
  const mode: AgentMode = (chat?.mode as AgentMode) || settings.agent.defaultMode;
  const modelRef: ModelRef = chat?.model || settings.activeModel;

  // focus & fill
  useEffect(() => bus.on('focus-composer', () => taRef.current?.focus()), []);
  useEffect(() => {
    if (fill) {
      setText((t) => (t && !t.endsWith('\n') ? t + '\n' : t) + fill.text);
      setTimeout(() => {
        const ta = taRef.current;
        if (ta) {
          ta.focus();
          ta.selectionStart = ta.selectionEnd = ta.value.length;
        }
      }, 30);
    }
  }, [fill]);
  useEffect(() => bus.on('open-model-picker', () => modelBtn.current && setPicker(modelBtn.current)), []);

  // autosize
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(260, ta.scrollHeight) + 'px';
  }, [text]);

  const slashItems = useMemo(() => {
    if (!text.startsWith('/') || text.includes(' ') || text.includes('\n')) return [];
    return SLASH.filter((s) => s.cmd.startsWith(text.toLowerCase()));
  }, [text]);
  useEffect(() => setSlashHi(0), [slashItems.length]);

  // @ mentions
  const updateMention = useCallback(
    async (value: string, caret: number) => {
      const before = value.slice(0, caret);
      const m = /(^|\s)@([^\s@]*)$/.exec(before);
      if (!m || !project) {
        setMention(null);
        return;
      }
      const files = await api.findFiles(project.path, m[2]).catch(() => []);
      setMention({ q: m[2], files: files.slice(0, 8), hi: 0 });
    },
    [project]
  );

  const insertMention = (file: string) => {
    const ta = taRef.current!;
    const caret = ta.selectionStart;
    const before = text.slice(0, caret).replace(/@([^\s@]*)$/, `@${relPath(file, project?.path)} `);
    const next = before + text.slice(caret);
    setText(next);
    setMention(null);
    setTimeout(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = before.length;
    }, 10);
  };

  const addPaths = (paths: string[]) => {
    const items = paths.filter(Boolean).map((p) => ({ key: 'a' + ++attKey, input: { kind: 'path', path: p } as AttachmentInput, name: basename(p), preview: /\.(png|jpe?g|gif|webp|bmp)$/i.test(p) ? 'app://lunarix/local/' + encodeURIComponent(p) : undefined }));
    setAtts((a) => [...a, ...items]);
  };

  const addFiles = async (files: File[]) => {
    const paths: string[] = [];
    for (const f of files) {
      const p = window.lunarix.pathForFile(f);
      if (p) paths.push(p);
      else {
        const buf = await f.arrayBuffer();
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const data = btoa(bin);
        const name = f.name || `wklejony-obraz-${Date.now()}.png`;
        setAtts((a) => [...a, { key: 'a' + ++attKey, input: { kind: 'data', name, mime: f.type || 'application/octet-stream', data }, name, preview: f.type.startsWith('image/') ? `data:${f.type};base64,${data}` : undefined }]);
      }
    }
    if (paths.length) addPaths(paths);
  };

  const setMode = async (m: AgentMode) => {
    if (chat) await api.setChatMode(chat.id, m);
    else await useApp.getState().patchSettings({ agent: { ...settings.agent, defaultMode: m } });
  };

  const setModel = async (m: ModelRef) => {
    if (chat) await api.setChatModel(chat.id, m);
    await useApp.getState().patchSettings({ activeModel: m });
  };

  const runSlash = async (cmd: string): Promise<boolean> => {
    const c = cmd.trim().toLowerCase();
    if (c === '/new' || c === '/clear') {
      await useApp.getState().newChat();
      return true;
    }
    if (c === '/plan' || c === '/ask' || c === '/agent') {
      await setMode(c.slice(1) as AgentMode);
      return true;
    }
    if (c === '/chill') {
      useApp.setState({ chill: true });
      return true;
    }
    if (c === '/compact') {
      if (chat) {
        useApp.getState().toast(tx('Kompaktowanie kontekstu…', 'Compacting context…'));
        await api.compactChat(chat.id).catch((e) => useApp.getState().toast(e.message, 'error'));
      }
      return true;
    }
    if (c === '/undo') {
      const last = chat?.messages.filter((m) => m.role === 'user').pop();
      if (chat && last) {
        const r = await api.restoreCheckpoint(chat.id, last.id).catch((e) => {
          useApp.getState().toast(e.message, 'error');
          return null;
        });
        if (r) {
          setText(r.text);
          useApp.getState().toast(tx(`Przywrócono ${r.restored} plików`, `Restored ${r.restored} files`), 'success');
        }
      }
      return true;
    }
    if (c === '/model') {
      if (modelBtn.current) setPicker(modelBtn.current);
      return true;
    }
    if (c === '/usage') {
      useApp.getState().setModal('usage');
      return true;
    }
    if (c === '/settings') {
      useApp.getState().setModal('settings', 'general');
      return true;
    }
    if (PROMPTS[c]) {
      const [pl, en] = PROMPTS[c];
      await send(tx(pl, en), c === '/explain' || c === '/review' ? 'ask' : 'agent');
      return true;
    }
    return false;
  };

  const send = async (overrideText?: string, overrideMode?: AgentMode) => {
    const raw = (overrideText ?? text).trim();
    if (!raw && !atts.length) return;
    if (!overrideText && raw.startsWith('/') && !raw.includes(' ') && (await runSlash(raw))) {
      setText('');
      return;
    }
    let c = chat;
    if (!c) c = await useApp.getState().newChat();
    const attachments: AttachmentInput[] = atts.map((a) => a.input);
    // @mentions → attach referenced project files
    if (project) {
      const seen = new Set<string>();
      for (const m of raw.matchAll(/(?:^|\s)@([^\s@:]+)(?::\d+-\d+)?/g)) {
        const rel = m[1];
        if (seen.has(rel)) continue;
        seen.add(rel);
        const abs = /^[a-z]:[\\/]/i.test(rel) ? rel : joinPath(project.path, rel);
        if (await api.exists(abs)) attachments.push({ kind: 'path', path: abs });
      }
    }
    if (!overrideText) {
      setText('');
      setAtts([]);
    }
    setMention(null);
    try {
      await api.sendMessage(c.id, { text: raw, attachments, mode: overrideMode || mode, model: modelRef });
    } catch (e: any) {
      useApp.getState().toast(e.message, 'error');
    }
  };

  const enhance = async () => {
    if (!text.trim()) return;
    setEnhancing(true);
    try {
      setText(await api.enhancePrompt(text));
    } catch (e: any) {
      useApp.getState().toast(e.message, 'error');
    } finally {
      setEnhancing(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mention.files.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMention({ ...mention, hi: Math.min(mention.files.length - 1, mention.hi + 1) });
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMention({ ...mention, hi: Math.max(0, mention.hi - 1) });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(mention.files[mention.hi]);
        return;
      }
      if (e.key === 'Escape') {
        setMention(null);
        return;
      }
    }
    if (slashItems.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashHi((h) => Math.min(slashItems.length - 1, h + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashHi((h) => Math.max(0, h - 1));
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        setText(slashItems[slashHi].cmd);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const cmd = slashItems[slashHi].cmd;
        setText('');
        runSlash(cmd);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape' && running && chat) {
      api.stopChat(chat.id);
    } else if (e.key === 'ArrowUp' && !text && chat) {
      const last = [...chat.messages].reverse().find((m) => m.role === 'user');
      const t = last?.blocks.find((b) => b.type === 'text') as any;
      if (t?.text) {
        e.preventDefault();
        setText(t.text);
      }
    }
  };

  // context meter
  const modelInfo = models.find((m) => m.provider === modelRef.provider && m.id === modelRef.model);
  const ctxWindow = modelRef.provider === 'local' ? engine.contextSize || (() => {
        try {
          return tierById(modelRef.model as any).defaultContext;
        } catch {
          return 32768;
        }
      })() : modelInfo?.contextWindow || 128000;
  const used = chat?.contextTokens || 0;

  const approval = settings.agent.approval;
  const approvalMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      { header: tx('Poziom autonomii', 'Autonomy level') },
      { label: tx('Pytaj o zgodę na zmiany i komendy', 'Ask before edits & commands'), icon: <ShieldAlert size={14} />, onClick: () => useApp.getState().patchSettings({ agent: { ...settings.agent, approval: 'ask' } }) },
      { label: tx('Auto-edycje (pytaj o komendy)', 'Auto-edit (ask for commands)'), icon: <ShieldCheck size={14} />, onClick: () => useApp.getState().patchSettings({ agent: { ...settings.agent, approval: 'auto-edits' } }) },
      { label: tx('Chill — pełna autonomia', 'Chill — full autonomy'), icon: <Moon size={14} />, onClick: () => useApp.getState().patchSettings({ agent: { ...settings.agent, approval: 'chill' } }) }
    ]);
  const approvalLabel: Record<ApprovalMode, string> = { ask: tx('Pytaj', 'Ask'), 'auto-edits': tx('Auto-edycje', 'Auto-edit'), chill: 'Chill' };

  const modeMenu = (el: HTMLElement) =>
    openMenuAt(el, [
      { header: tx('Tryb', 'Mode') },
      { label: tx('Agent — buduje, uruchamia, testuje', 'Agent — builds, runs, tests'), icon: <Bot size={14} />, onClick: () => setMode('agent') },
      { label: tx('Plan — analiza i plan bez zmian', 'Plan — analysis & plan, no changes'), icon: <ListTodo size={14} />, onClick: () => setMode('plan') },
      { label: tx('Ask — pytania i wyjaśnienia', 'Ask — questions & explanations'), icon: <MessageCircleQuestion size={14} />, onClick: () => setMode('ask') }
    ]);
  const ModeIcon = mode === 'plan' ? ListTodo : mode === 'ask' ? MessageCircleQuestion : Bot;

  return (
    <div className="composer-wrap">
      {!running && <ModelAdvisor chat={chat} />}
      {queue.length > 0 && (
        <div className="queue">
          {queue.map((q, i) => (
            <div key={i} className="qi">
              <Loader2 size={12} className="spin" />
              <span className="ellipsis">{tx('W kolejce: ', 'Queued: ')}{q}</span>
            </div>
          ))}
        </div>
      )}
      {slashItems.length > 0 && (
        <div className="slash-menu">
          {slashItems.map((s, i) => (
            <div
              key={s.cmd}
              className={`item ${i === slashHi ? 'hi' : ''}`}
              onMouseEnter={() => setSlashHi(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                setText('');
                runSlash(s.cmd);
              }}
            >
              <b>{s.cmd}</b>
              <span>{tx(s.pl, s.en)}</span>
            </div>
          ))}
        </div>
      )}
      {mention && mention.files.length > 0 && (
        <div className="slash-menu">
          {mention.files.map((f, i) => (
            <div
              key={f}
              className={`item ${i === mention.hi ? 'hi' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                insertMention(f);
              }}
            >
              <AtSign size={13} />
              <span style={{ color: 'var(--fg)' }}>{basename(f)}</span>
              <span className="ellipsis">{relPath(f, project?.path)}</span>
            </div>
          ))}
        </div>
      )}
      <div
        className={`composer ${focus ? 'focus' : ''} ${drag ? 'drag' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const internal = e.dataTransfer.getData('text/lunarix-path');
          if (internal) addPaths([internal]);
          else if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
        }}
      >
        {drag && <div className="drop-overlay">{tx('Upuść pliki, ZIP-y lub obrazy', 'Drop files, ZIPs or images')}</div>}
        {atts.length > 0 && (
          <div className="c-atts">
            {atts.map((a) => (
              <div key={a.key} className="att">
                <span className="ico">
                  {a.preview ? <img src={a.preview} alt="" /> : /\.(zip|rar|7z|tar|gz)$/i.test(a.name) ? <FileArchive size={12} /> : /\.(png|jpe?g|gif|webp)$/i.test(a.name) ? <ImageIcon size={12} /> : <FileText size={12} />}
                </span>
                <span className="aname">{a.name}</span>
                <button className="icon-btn sm" onClick={() => setAtts((x) => x.filter((y) => y.key !== a.key))}>
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          value={text}
          rows={1}
          placeholder={
            running
              ? tx('Agent pracuje… możesz dopisać kolejną wiadomość (trafi do kolejki)', 'Agent is working… you can queue another message')
              : mode === 'agent'
                ? tx('Opisz, co mam zbudować… (Enter — wyślij, / — polecenia, @ — plik)', 'Describe what to build… (Enter to send, / commands, @ file)')
                : mode === 'plan'
                  ? tx('Opisz zadanie — przygotuję plan bez zmian w plikach', 'Describe the task — I will plan without changing files')
                  : tx('Zadaj pytanie o kod…', 'Ask a question about the code…')
          }
          onChange={(e) => {
            setText(e.target.value);
            updateMention(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocus(true)}
          onBlur={() => {
            setFocus(false);
            setTimeout(() => setMention(null), 150);
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
        />
        <div className="c-bar">
          <button className="chip-btn" onClick={(e) => modeMenu(e.currentTarget)} data-tip={tx('Tryb pracy', 'Mode')} data-tip-pos="top">
            <ModeIcon size={13} />
            <span>{mode === 'agent' ? 'Agent' : mode === 'plan' ? 'Plan' : 'Ask'}</span>
            <ChevronDown size={11} />
          </button>
          <button ref={modelBtn} className="chip-btn" onClick={(e) => setPicker(picker ? null : e.currentTarget)}>
            <span>{modelLabel(modelRef.provider, modelRef.model, models)}</span>
            <ChevronDown size={11} />
          </button>
          <button className="chip-btn" onClick={(e) => approvalMenu(e.currentTarget)} data-tip={tx('Poziom autonomii', 'Autonomy')} data-tip-pos="top">
            {approval === 'chill' ? <Moon size={13} /> : approval === 'ask' ? <ShieldAlert size={13} /> : <ShieldCheck size={13} />}
            <span>{approvalLabel[approval]}</span>
          </button>
          <div className="grow" />
          <span data-tip={`${tx('Kontekst', 'Context')}: ${fmtTokens(used)} / ${fmtTokens(ctxWindow)}`} data-tip-pos="top" style={{ display: 'grid' }}>
            <Ring value={used / Math.max(1, ctxWindow)} />
          </span>
          <button className="icon-btn" onClick={enhance} disabled={!text.trim() || enhancing} data-tip={tx('Ulepsz prompt z AI', 'Improve prompt with AI')} data-tip-pos="top">
            {enhancing ? <Loader2 size={15} className="spin" /> : <Wand2 size={15} />}
          </button>
          <button
            className="icon-btn"
            onClick={async () => addPaths(await api.selectFiles())}
            data-tip={tx('Załącz pliki (ZIP, kod, obrazy, PDF…)', 'Attach files (ZIP, code, images, PDF…)')}
            data-tip-pos="top"
          >
            <Paperclip size={15} />
          </button>
          {running && !text.trim() ? (
            <button className="send stop" onClick={() => chat && api.stopChat(chat.id)} data-tip={tx('Zatrzymaj (Esc)', 'Stop (Esc)')} data-tip-pos="top">
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button className="send" disabled={!text.trim() && !atts.length} onClick={() => send()}>
              <ArrowUp size={16} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      {picker && <ModelPicker anchor={picker} current={modelRef} onSelect={setModel} onClose={() => setPicker(null)} />}
    </div>
  );
}

export { runCommand };
