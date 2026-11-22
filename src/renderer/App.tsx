import { useEffect, useState } from 'react';
import { useApp, useChats, upsertMeta } from './store/app';
import { useEditor } from './store/editor';
import { api, on } from './lib/api';
import { tx } from './lib/i18n';
import { handleGlobalKey } from './lib/commands';
import { TitleBar, ActivityBar, StatusBar } from './components/Chrome';
import { Sidebar } from './components/Sidebar';
import { EditorArea } from './components/EditorArea';
import { BottomPanel } from './components/BottomPanel';
import { ChatPanel, onRunFinished } from './components/ChatPanel';
import { SettingsModal } from './components/Settings';
import { UsageModal } from './components/Usage';
import { Palette, NewProjectModal } from './components/Modals';
import { Onboarding } from './components/Onboarding';
import { ChillMode } from './components/ChillMode';
import { ContextMenu, DialogHost, Lightbox, Resizer, Toasts } from './components/ui';
import { LogoTile } from './components/Logo';
import type { ChatMeta } from '@shared/types';

function useEvents() {
  useEffect(() => {
    const st = useApp.setState;
    const offs = [
      on('settings', (s) => st({ settings: s })),
      on('providers', (p) => {
        st({ providers: p });
        useApp.getState().refreshModels();
      }),
      on('projects', (p) => st({ projects: p })),
      on('chat:meta', (m: ChatMeta) => upsertMeta(m)),
      on('chat:deleted', ({ id }: { id: string }) => {
        useChats.getState().drop(id);
        st((s) => {
          const chatMetas = s.chatMetas.filter((c) => c.id !== id);
          const next = s.activeChatId === id ? chatMetas.filter((c) => c.projectId === s.projectId).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id || null : s.activeChatId;
          return { chatMetas, activeChatId: next };
        });
      }),
      on('chat:message', ({ chatId, message }) => useChats.getState().upsertMessage(chatId, message)),
      on('chat:message-removed', ({ chatId, messageId }) => useChats.getState().removeMessage(chatId, messageId)),
      on('chat:reload', ({ chatId }) => useChats.getState().load(chatId, true)),
      on('chat:status', ({ chatId, text }) => st((s) => ({ status: { ...s.status, [chatId]: text } }))),
      on('chat:run', ({ chatId, state, done }) => {
        if (state === 'idle') {
          st((s) => ({ status: { ...s.status, [chatId]: '' }, queue: { ...s.queue, [chatId]: [] } }));
          onRunFinished(chatId, done);
        }
      }),
      on('chat:queue', ({ chatId, items }) => st((s) => ({ queue: { ...s.queue, [chatId]: items } }))),
      on('chat:todos', ({ chatId, todos }) => st((s) => ({ todos: { ...s.todos, [chatId]: todos } }))),
      on('engine:status', (e) => st({ engine: e })),
      on('download:progress', (d) => {
        st((s) => ({ downloads: { ...s.downloads, [d.id]: d } }));
        if (d.state !== 'running') api.localModels().then((l) => st({ localModels: l }));
      }),
      on('local:models', (l) => st({ localModels: l })),
      on('hardware', (h) => st({ hardware: h })),
      on('usage', (u) => st({ usage: u })),
      on('toast', ({ text, level }) => useApp.getState().toast(text, level)),
      on('toolchain', (t) => st({ toolchain: t })),
      on('open-chat', ({ chatId }) => useApp.getState().openChat(chatId)),
      on('window:state', ({ maximized }) => st({ maximized })),
      on('agent:preview', ({ url }) => useEditor.getState().openPreview(url, tx('Podgląd', 'Preview'))),
      on('agent:file', ({ chatId, path, kind }: { chatId: string; path: string; kind: string }) => {
        const s = useApp.getState();
        if (kind === 'deleted') {
          useEditor.getState().removePath(path);
          return;
        }
        if (!s.settings?.agent.followAgent || chatId !== s.activeChatId || s.chill) return;
        const ed = useEditor.getState();
        const activeTab = ed.tabs.find((t) => t.id === ed.active);
        if (activeTab?.dirty) return;
        if (/\.(png|jpe?g|gif|webp|ico|zip|exe|dll|bin|lock)$/i.test(path) || /[\\/](node_modules|\.git)[\\/]/.test(path)) return;
        ed.openFile(path, { transient: true, flash: true });
      })
    ];
    return () => offs.forEach((o) => o());
  }, []);
}

export function App() {
  const ready = useApp((s) => s.ready);
  const settings = useApp((s) => s.settings);
  const modal = useApp((s) => s.modal);
  const chill = useApp((s) => s.chill);
  const [panelMounted, setPanelMounted] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  useEvents();

  useEffect(() => {
    useApp
      .getState()
      .init()
      .catch((e) => setInitError(String(e?.message || e)));
    const onKey = (e: KeyboardEvent) => {
      if (useApp.getState().modal && e.key !== 'Escape') {
        if ((e.ctrlKey || e.metaKey) && ['p', 'P'].includes(e.key)) e.preventDefault();
        return;
      }
      handleGlobalKey(e);
    };
    window.addEventListener('keydown', onKey);
    // prevent the window from navigating when files are dropped outside drop zones
    const prevent = (e: DragEvent) => {
      if (!(e.target as HTMLElement)?.closest?.('.composer')) e.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  useEffect(() => {
    if (settings?.ui.panelVisible) setPanelMounted(true);
  }, [settings?.ui.panelVisible]);

  if (initError)
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 40, textAlign: 'center' }}>
        <div>
          <LogoTile size={64} />
          <p style={{ marginTop: 16 }}>{initError}</p>
          <button className="btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );

  if (!ready || !settings)
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <div className="fade-in" style={{ animationDuration: '.8s' }}>
          <LogoTile size={84} animated />
        </div>
      </div>
    );

  if (!settings.onboarded) return <Onboarding />;

  const ui = settings.ui;
  return (
    <div className="app">
      <TitleBar />
      <div className="workbench">
        <ActivityBar />
        {ui.sidebarVisible && (
          <>
            <div className="sidebar" style={{ width: ui.sidebarWidth }}>
              <Sidebar />
            </div>
            <Resizer dir="x" value={ui.sidebarWidth} min={180} max={560} onChange={(v) => useApp.getState().patchUi({ sidebarWidth: v })} />
          </>
        )}
        <div className="center">
          <EditorArea />
          {panelMounted && (
            <div style={{ display: ui.panelVisible ? 'flex' : 'none', flexDirection: 'column', height: ui.panelHeight, flex: 'none' }}>
              <Resizer dir="y" value={ui.panelHeight} min={120} max={Math.round(window.innerHeight * 0.75)} invert onChange={(v) => useApp.getState().patchUi({ panelHeight: v })} />
              <BottomPanel />
            </div>
          )}
        </div>
        {ui.chatVisible && (
          <>
            <Resizer dir="x" value={ui.chatWidth} min={340} max={Math.round(window.innerWidth * 0.62)} invert onChange={(v) => useApp.getState().patchUi({ chatWidth: v })} />
            <div className="chat" style={{ width: ui.chatWidth }}>
              <ChatPanel />
            </div>
          </>
        )}
      </div>
      <StatusBar />
      {modal === 'settings' && <SettingsModal />}
      {modal === 'usage' && <UsageModal />}
      {modal === 'palette' && <Palette mode="commands" />}
      {modal === 'quickopen' && <Palette mode="files" />}
      {modal === 'newproject' && <NewProjectModal />}
      {chill && <ChillMode />}
      <ContextMenu />
      <DialogHost />
      <Toasts />
      <Lightbox />
    </div>
  );
}
