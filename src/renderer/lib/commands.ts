import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { api } from './api';
import { tx } from './i18n';
import { promptText } from '../components/ui';
import { joinPath } from './format';

type Handler = (payload?: any) => void;
const handlers = new Map<string, Set<Handler>>();

export const bus = {
  on(evt: string, h: Handler) {
    let s = handlers.get(evt);
    if (!s) {
      s = new Set();
      handlers.set(evt, s);
    }
    s.add(h);
    return () => {
      s!.delete(h);
    };
  },
  emit(evt: string, payload?: any) {
    handlers.get(evt)?.forEach((h) => h(payload));
  }
};

export interface Command {
  id: string;
  title: () => string;
  shortcut?: string;
  run: () => void | Promise<void>;
  when?: () => boolean;
}

const ui = () => useApp.getState().settings!.ui;
const patchUi = (p: any) => useApp.getState().patchUi(p);

export async function newFileInProject(dir?: string) {
  const proj = await useApp.getState().ensureProject();
  const name = await promptText(tx('Nowy plik', 'New file'), '', tx('np. src/index.html', 'e.g. src/index.html'), tx('Utwórz', 'Create'));
  if (!name) return;
  const p = joinPath(dir || proj.path, name);
  try {
    await api.createFile(p);
    useEditor.getState().openFile(p);
  } catch (e: any) {
    useApp.getState().toast(e.message, 'error');
  }
}

export async function newFolderInProject(dir?: string) {
  const proj = await useApp.getState().ensureProject();
  const name = await promptText(tx('Nowy folder', 'New folder'), '', tx('nazwa folderu', 'folder name'), tx('Utwórz', 'Create'));
  if (!name) return;
  try {
    await api.createDir(joinPath(dir || proj.path, name));
  } catch (e: any) {
    useApp.getState().toast(e.message, 'error');
  }
}

export async function openFolder() {
  const dir = await api.selectFolder(tx('Otwórz folder jako projekt', 'Open folder as project'));
  if (!dir) return;
  const p = await api.openFolderAsProject(dir);
  useApp.setState({ projects: await api.listProjects() });
  await useApp.getState().selectProject(p.id);
  useApp.getState().toast(tx(`Otwarto projekt „${p.name}”`, `Opened project "${p.name}"`), 'success');
}

export const COMMANDS: Command[] = [
  { id: 'chat.new', title: () => tx('Nowy czat z agentem', 'New agent chat'), shortcut: 'Ctrl+N', run: () => useApp.getState().newChat().then(() => bus.emit('focus-composer')) },
  { id: 'chat.focus', title: () => tx('Przejdź do czatu', 'Focus chat'), shortcut: 'Ctrl+L', run: () => {
      if (!ui().chatVisible) patchUi({ chatVisible: true });
      setTimeout(() => bus.emit('focus-composer'), 50);
    } },
  { id: 'chat.chill', title: () => tx('Tryb Chill (pełny ekran, AI pracuje)', 'Chill Mode (fullscreen, AI works)'), shortcut: 'Ctrl+Alt+C', run: () => useApp.setState((s) => ({ chill: !s.chill })) },
  { id: 'project.new', title: () => tx('Nowy projekt…', 'New project…'), shortcut: 'Ctrl+Shift+N', run: () => useApp.getState().setModal('newproject') },
  { id: 'project.open', title: () => tx('Otwórz folder jako projekt…', 'Open folder as project…'), shortcut: 'Ctrl+O', run: openFolder },
  { id: 'project.reveal', title: () => tx('Pokaż projekt w Eksploratorze Windows', 'Reveal project in File Explorer'), run: async () => {
      const p = useApp.getState().project();
      if (p) api.openPath(p.path);
    } },
  { id: 'file.new', title: () => tx('Nowy plik…', 'New file…'), run: () => newFileInProject() },
  { id: 'file.newFolder', title: () => tx('Nowy folder…', 'New folder…'), run: () => newFolderInProject() },
  { id: 'file.save', title: () => tx('Zapisz plik', 'Save file'), shortcut: 'Ctrl+S', run: () => bus.emit('save') },
  { id: 'file.close', title: () => tx('Zamknij kartę', 'Close tab'), shortcut: 'Ctrl+W', run: () => {
      const a = useEditor.getState().active;
      if (a) bus.emit('close-tab', a);
    } },
  { id: 'quickopen', title: () => tx('Szybkie otwieranie pliku', 'Quick open file'), shortcut: 'Ctrl+P', run: () => useApp.getState().setModal('quickopen') },
  { id: 'palette', title: () => tx('Paleta poleceń', 'Command palette'), shortcut: 'Ctrl+Shift+P', run: () => useApp.getState().setModal('palette') },
  { id: 'view.sidebar', title: () => tx('Pokaż/ukryj pasek boczny', 'Toggle sidebar'), shortcut: 'Ctrl+B', run: () => patchUi({ sidebarVisible: !ui().sidebarVisible }) },
  { id: 'view.panel', title: () => tx('Pokaż/ukryj panel (terminal)', 'Toggle panel (terminal)'), shortcut: 'Ctrl+J', run: () => patchUi({ panelVisible: !ui().panelVisible }) },
  { id: 'view.terminal', title: () => tx('Nowy terminal', 'New terminal'), shortcut: 'Ctrl+`', run: () => {
      patchUi({ panelVisible: true });
      setTimeout(() => bus.emit('new-terminal'), 60);
    } },
  { id: 'view.chat', title: () => tx('Pokaż/ukryj panel agenta', 'Toggle agent panel'), shortcut: 'Ctrl+Alt+B', run: () => patchUi({ chatVisible: !ui().chatVisible }) },
  { id: 'view.explorer', title: () => tx('Eksplorator plików', 'Explorer'), shortcut: 'Ctrl+Shift+E', run: () => patchUi({ sidebarVisible: true, sidebarView: 'explorer' }) },
  { id: 'view.search', title: () => tx('Szukaj w plikach', 'Search in files'), shortcut: 'Ctrl+Shift+F', run: () => {
      patchUi({ sidebarVisible: true, sidebarView: 'search' });
      setTimeout(() => bus.emit('focus-search'), 60);
    } },
  { id: 'view.chats', title: () => tx('Historia czatów', 'Chat history'), shortcut: 'Ctrl+Shift+H', run: () => patchUi({ sidebarVisible: true, sidebarView: 'chats' }) },
  { id: 'view.git', title: () => tx('Kontrola wersji (Git)', 'Source control (Git)'), shortcut: 'Ctrl+Shift+G', run: () => patchUi({ sidebarVisible: true, sidebarView: 'git' }) },
  { id: 'settings.open', title: () => tx('Ustawienia', 'Settings'), shortcut: 'Ctrl+,', run: () => useApp.getState().setModal('settings', 'general') },
  { id: 'settings.models', title: () => tx('Modele i klucze API', 'Models & API keys'), run: () => useApp.getState().setModal('settings', 'providers') },
  { id: 'settings.local', title: () => tx('Modele lokalne (Low → Max)', 'Local models (Low → Max)'), run: () => useApp.getState().setModal('settings', 'local') },
  { id: 'usage.open', title: () => tx('Zużycie tokenów', 'Token usage'), run: () => useApp.getState().setModal('usage') },
  { id: 'theme.toggle', title: () => tx('Przełącz motyw (czarny / biały)', 'Toggle theme (black / white)'), run: () => {
      const s = useApp.getState().settings!;
      useApp.getState().patchSettings({ theme: s.theme === 'dark' ? 'light' : 'dark' });
    } },
  { id: 'lang.toggle', title: () => tx('Language: English', 'Język: Polski'), run: () => {
      const s = useApp.getState().settings!;
      useApp.getState().patchSettings({ language: s.language === 'pl' ? 'en' : 'pl' });
    } },
  { id: 'engine.start', title: () => tx('Uruchom model lokalny', 'Start local model'), run: () => api.startEngine() },
  { id: 'engine.stop', title: () => tx('Zatrzymaj model lokalny (zwolnij pamięć)', 'Stop local model (free memory)'), run: () => api.stopEngine() },
  { id: 'onboarding', title: () => tx('Uruchom ponownie konfigurację startową', 'Run the setup wizard again'), run: () => useApp.getState().patchSettings({ onboarded: false }) },
  { id: 'app.devtools', title: () => tx('Narzędzia deweloperskie', 'Developer tools'), run: () => api.windowControl('devtools') },
  { id: 'app.reload', title: () => tx('Przeładuj okno', 'Reload window'), run: () => api.windowControl('reload') },
  { id: 'about', title: () => tx('O Lunarix', 'About Lunarix'), run: () => useApp.getState().setModal('settings', 'about') }
];

export function runCommand(id: string) {
  const c = COMMANDS.find((x) => x.id === id);
  if (c) c.run();
}

/** Global keyboard shortcuts. */
export function handleGlobalKey(e: KeyboardEvent): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const combo = `${ctrl ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : e.key}`;
  const map: Record<string, string> = {
    'Ctrl+N': 'chat.new',
    'Ctrl+L': 'chat.focus',
    'Ctrl+Alt+C': 'chat.chill',
    'Ctrl+Shift+N': 'project.new',
    'Ctrl+O': 'project.open',
    'Ctrl+P': 'quickopen',
    'Ctrl+Shift+P': 'palette',
    'Ctrl+B': 'view.sidebar',
    'Ctrl+J': 'view.panel',
    'Ctrl+`': 'view.terminal',
    'Ctrl+Alt+B': 'view.chat',
    'Ctrl+Shift+E': 'view.explorer',
    'Ctrl+Shift+F': 'view.search',
    'Ctrl+Shift+H': 'view.chats',
    'Ctrl+Shift+G': 'view.git',
    'Ctrl+,': 'settings.open',
    'Ctrl+W': 'file.close'
  };
  const id = map[combo];
  if (!id) return false;
  e.preventDefault();
  runCommand(id);
  return true;
}
