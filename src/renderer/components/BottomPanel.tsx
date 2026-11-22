import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Plus, X, TerminalSquare, Bot, Trash2, ChevronDown } from 'lucide-react';
import { useApp, useChats } from '../store/app';
import { api, on } from '../lib/api';
import { tx } from '../lib/i18n';
import { bus } from '../lib/commands';

interface TermTab {
  key: string;
  id: string | null;
  title: string;
}

let termCounter = 0;

export function BottomPanel() {
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [active, setActive] = useState<string>('agent');
  const project = useApp((s) => s.projects.find((p) => p.id === s.projectId));

  const addTerminal = () => {
    const key = `t${++termCounter}`;
    setTabs((t) => [...t, { key, id: null, title: `${tx('Terminal', 'Terminal')} ${termCounter}` }]);
    setActive(key);
  };

  useEffect(() => bus.on('new-terminal', addTerminal), []);
  useEffect(() => {
    if (tabs.length === 0 && termCounter === 0) addTerminal();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const closeTerm = (key: string) => {
    const t = tabs.find((x) => x.key === key);
    if (t?.id) api.terminalKill(t.id);
    const rest = tabs.filter((x) => x.key !== key);
    setTabs(rest);
    if (active === key) setActive(rest[rest.length - 1]?.key || 'agent');
  };

  return (
    <div className="bottom-panel" style={{ height: '100%' }}>
      <div className="bp-head">
        <button className={`bp-tab ${active === 'agent' ? 'on' : ''}`} onClick={() => setActive('agent')}>
          <Bot size={13} /> {tx('Agent', 'Agent')}
        </button>
        {tabs.map((t) => (
          <button key={t.key} className={`bp-tab ${active === t.key ? 'on' : ''}`} onClick={() => setActive(t.key)}>
            <TerminalSquare size={13} /> {t.title}
            <span
              className="icon-btn sm"
              style={{ width: 16, height: 16 }}
              onClick={(e) => {
                e.stopPropagation();
                closeTerm(t.key);
              }}
            >
              <X size={11} />
            </span>
          </button>
        ))}
        <button className="icon-btn sm" data-tip={tx('Nowy terminal', 'New terminal')} onClick={addTerminal}>
          <Plus size={14} />
        </button>
        <div className="grow" />
        {active === 'agent' && (
          <button className="icon-btn sm" data-tip={tx('Wyczyść', 'Clear')} onClick={() => bus.emit('clear-agent-log')}>
            <Trash2 size={13} />
          </button>
        )}
        <button className="icon-btn sm" data-tip={tx('Ukryj panel (Ctrl+J)', 'Hide panel (Ctrl+J)')} onClick={() => useApp.getState().patchUi({ panelVisible: false })}>
          <ChevronDown size={15} />
        </button>
      </div>
      <div className="bp-body">
        <AgentLog visible={active === 'agent'} />
        {tabs.map((t) => (
          <TerminalView
            key={t.key}
            visible={active === t.key}
            cwd={project?.path || ''}
            onReady={(id) => setTabs((all) => all.map((x) => (x.key === t.key ? { ...x, id } : x)))}
            onExit={() => closeTerm(t.key)}
          />
        ))}
      </div>
    </div>
  );
}

function termTheme() {
  const light = document.documentElement.dataset.theme === 'light';
  return light
    ? { background: '#ffffff', foreground: '#1a1a1a', cursor: '#000000', cursorAccent: '#ffffff', selectionBackground: '#00000025', black: '#000000', brightBlack: '#666666', white: '#bbbbbb', brightWhite: '#ffffff', red: '#333333', green: '#333333', yellow: '#555555', blue: '#333333', magenta: '#444444', cyan: '#444444', brightRed: '#000000', brightGreen: '#000000', brightYellow: '#222222', brightBlue: '#000000', brightMagenta: '#111111', brightCyan: '#111111' }
    : { background: '#0a0a0a', foreground: '#d6d6d6', cursor: '#ffffff', cursorAccent: '#000000', selectionBackground: '#ffffff30', black: '#1a1a1a', brightBlack: '#6a6a6a', white: '#cfcfcf', brightWhite: '#ffffff', red: '#bdbdbd', green: '#e6e6e6', yellow: '#d0d0d0', blue: '#a8a8a8', magenta: '#c4c4c4', cyan: '#dadada', brightRed: '#e0e0e0', brightGreen: '#ffffff', brightYellow: '#f0f0f0', brightBlue: '#cfcfcf', brightMagenta: '#e6e6e6', brightCyan: '#f5f5f5' };
}

function TerminalView({ visible, cwd, onReady, onExit }: { visible: boolean; cwd: string; onReady: (id: string) => void; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string | null>(null);
  const theme = useApp((s) => s.settings?.theme);
  const fontSize = useApp((s) => s.settings?.editor.fontSize || 13);

  useEffect(() => {
    const term = new XTerm({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      fontSize: Math.max(11, fontSize - 0.5),
      lineHeight: 1.25,
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      scrollback: 8000,
      theme: termTheme()
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    termRef.current = term;
    fitRef.current = fit;
    try {
      fit.fit();
    } catch {
      /* hidden */
    }
    let offData: (() => void) | null = null;
    let offExit: (() => void) | null = null;
    let disposed = false;
    api.terminalCreate(cwd, term.cols || 100, term.rows || 24).then((r) => {
      if (disposed) {
        api.terminalKill(r.id);
        return;
      }
      idRef.current = r.id;
      onReady(r.id);
      offData = on('terminal:data', ({ id, data }: { id: string; data: string }) => id === r.id && term.write(data));
      offExit = on('terminal:exit', ({ id }: { id: string }) => {
        if (id === r.id) {
          term.write(`\r\n\x1b[2m[${tx('proces zakończony', 'process exited')}]\x1b[0m\r\n`);
          setTimeout(onExit, 600);
        }
      });
    });
    term.onData((d) => idRef.current && api.terminalWrite(idRef.current, d));
    term.attachCustomKeyEventHandler((e) => {
      // Ctrl+C copies when there is a selection; Ctrl+V pastes
      if (e.type === 'keydown' && e.ctrlKey && e.key.toLowerCase() === 'c' && term.hasSelection()) {
        api.clipboardWrite(term.getSelection());
        return false;
      }
      if (e.type === 'keydown' && e.ctrlKey && e.key.toLowerCase() === 'v') {
        navigator.clipboard.readText().then((t) => {
          if (idRef.current) api.terminalWrite(idRef.current, t);
        });
        return false;
      }
      return true;
    });
    const ro = new ResizeObserver(() => {
      if (!host.current || host.current.offsetParent === null) return;
      try {
        fit.fit();
        if (idRef.current) api.terminalResize(idRef.current, term.cols, term.rows);
      } catch {
        /* ignore */
      }
    });
    ro.observe(host.current!);
    return () => {
      disposed = true;
      ro.disconnect();
      offData?.();
      offExit?.();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = termTheme();
  }, [theme]);

  useEffect(() => {
    if (visible) {
      setTimeout(() => {
        try {
          fitRef.current?.fit();
          if (idRef.current && termRef.current) api.terminalResize(idRef.current, termRef.current.cols, termRef.current.rows);
          termRef.current?.focus();
        } catch {
          /* ignore */
        }
      }, 30);
    }
  }, [visible]);

  return <div className="term-host" ref={host} style={{ display: visible ? 'block' : 'none' }} />;
}

function AgentLog({ visible }: { visible: boolean }) {
  const [lines, setLines] = useState<{ tool: string; cmd: string; text: string }[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = on('agent:output', ({ chatId, toolId, data }: { chatId: string; toolId: string; data: string }) => {
      setLines((ls) => {
        const last = ls[ls.length - 1];
        if (last && last.tool === toolId) {
          const merged = { ...last, text: (last.text + data).slice(-60000) };
          return [...ls.slice(0, -1), merged];
        }
        const chat = useChats.getState().chats[chatId];
        let cmd = '';
        if (chat) {
          for (const m of chat.messages)
            for (const b of m.blocks) if (b.type === 'tool' && b.id === toolId) cmd = b.input?.command || b.input?.name || b.name;
        }
        return [...ls.slice(-40), { tool: toolId, cmd, text: data }];
      });
    });
    const off2 = bus.on('clear-agent-log', () => setLines([]));
    return () => {
      off();
      off2();
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el && visible) el.scrollTop = el.scrollHeight;
  }, [lines, visible]);
  return (
    <div className="agent-log" ref={ref} style={{ display: visible ? 'block' : 'none' }}>
      {!lines.length && <div className="faint" style={{ fontFamily: 'var(--font)' }}>{tx('Tutaj zobaczysz na żywo wyjście komend uruchamianych przez agenta.', 'Live output of commands run by the agent appears here.')}</div>}
      {lines.map((l, i) => (
        <div key={i}>
          <div className="cmd">$ {l.cmd || '…'}</div>
          {l.text}
        </div>
      ))}
    </div>
  );
}
