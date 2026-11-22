import {
  BarChart3,
  ChevronDown,
  Cpu,
  Files,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Loader2,
  MessagesSquare,
  Moon,
  Search,
  Settings,
  Sun,
  Bot,
  Check,
  Circle,
  Zap,
  Languages,
  Contrast
} from 'lucide-react';
import { useApp } from '../store/app';
import { tx } from '../lib/i18n';
import { COMMANDS, openFolder, runCommand } from '../lib/commands';
import { openMenuAt, type MenuItem, Kbd } from './ui';
import { LogoMark } from './Logo';
import { api } from '../lib/api';
import { fmtCost, fmtTokens } from '../lib/format';
import { tierById } from '@shared/catalog';
import type { LocalTierId, SidebarView } from '@shared/types';

function menuFrom(ids: (string | '-')[]): MenuItem[] {
  return ids.map((id) => {
    if (id === '-') return { separator: true };
    const c = COMMANDS.find((x) => x.id === id)!;
    return { label: c.title(), shortcut: c.shortcut, onClick: () => c.run() };
  });
}

export function TitleBar() {
  const projects = useApp((s) => s.projects);
  const projectId = useApp((s) => s.projectId);
  const project = projects.find((p) => p.id === projectId);
  const running = useApp((s) => s.chatMetas.filter((c) => c.running).length);
  const theme = useApp((s) => s.settings?.theme);

  const projectMenu = (el: HTMLElement) => {
    const items: MenuItem[] = [{ header: tx('Projekty', 'Projects') }];
    for (const p of projects.slice(0, 12)) {
      items.push({
        label: p.name + (p.isDefault ? ' ·' : ''),
        icon: p.id === projectId ? <Check size={14} /> : <Circle size={6} style={{ opacity: 0 }} />,
        onClick: () => useApp.getState().selectProject(p.id)
      });
    }
    items.push({ separator: true });
    items.push({ label: tx('Nowy projekt…', 'New project…'), icon: <FolderPlus size={14} />, shortcut: 'Ctrl+Shift+N', onClick: () => runCommand('project.new') });
    items.push({ label: tx('Otwórz folder…', 'Open folder…'), icon: <FolderOpen size={14} />, shortcut: 'Ctrl+O', onClick: openFolder });
    if (project) items.push({ label: tx('Pokaż w Eksploratorze', 'Reveal in Explorer'), onClick: () => api.openPath(project.path) });
    openMenuAt(el, items);
  };

  return (
    <div className="titlebar">
      <LogoMark size={18} className="logo" />
      <button className="project-btn" onClick={(e) => projectMenu(e.currentTarget)}>
        <span>{project?.name || 'Lunarix'}</span>
        <ChevronDown size={13} style={{ opacity: 0.6 }} />
      </button>
      <button className="menu-btn" onClick={(e) => openMenuAt(e.currentTarget, menuFrom(['chat.new', 'project.new', 'project.open', '-', 'file.new', 'file.newFolder', 'file.save', '-', 'project.reveal', 'settings.open']))}>
        {tx('Plik', 'File')}
      </button>
      <button className="menu-btn" onClick={(e) => openMenuAt(e.currentTarget, menuFrom(['palette', 'quickopen', '-', 'view.sidebar', 'view.panel', 'view.chat', 'view.terminal', '-', 'chat.chill', 'theme.toggle', 'lang.toggle']))}>
        {tx('Widok', 'View')}
      </button>
      <button className="menu-btn" onClick={(e) => openMenuAt(e.currentTarget, menuFrom(['settings.models', 'settings.local', 'usage.open', '-', 'engine.start', 'engine.stop', '-', 'onboarding', 'app.devtools', 'app.reload', '-', 'about']))}>
        {tx('Pomoc', 'Help')}
      </button>
      <div className="search-box no-drag" onClick={() => runCommand('quickopen')}>
        <Search size={13} />
        <span className="ellipsis">{tx('Szukaj plików, poleceń…', 'Search files, commands…')}</span>
        <Kbd>Ctrl P</Kbd>
      </div>
      <div className="spacer" />
      {running > 0 && (
        <button className="btn sm ghost no-drag" onClick={() => useApp.setState({ chill: true })} data-tip={tx('Agent pracuje — otwórz tryb Chill', 'Agent working — open Chill Mode')}>
          <span className="pulse-dot" />
          {running > 1 ? `${running} ${tx('agentów', 'agents')}` : tx('Agent pracuje', 'Agent working')}
        </button>
      )}
      <button className="icon-btn" data-tip={tx('Tryb Chill', 'Chill Mode')} onClick={() => useApp.setState({ chill: true })}>
        <Moon size={15} />
      </button>
      <button className="icon-btn" data-tip={theme === 'dark' ? tx('Jasny motyw', 'Light theme') : tx('Ciemny motyw', 'Dark theme')} onClick={() => runCommand('theme.toggle')}>
        {theme === 'dark' ? <Sun size={15} /> : <Contrast size={15} />}
      </button>
    </div>
  );
}

export function ActivityBar() {
  const ui = useApp((s) => s.settings!.ui);
  const patchUi = useApp((s) => s.patchUi);
  const running = useApp((s) => s.chatMetas.some((c) => c.running));
  const views: { id: SidebarView; icon: any; label: string; sc: string }[] = [
    { id: 'explorer', icon: Files, label: tx('Pliki', 'Explorer'), sc: 'Ctrl+Shift+E' },
    { id: 'search', icon: Search, label: tx('Szukaj', 'Search'), sc: 'Ctrl+Shift+F' },
    { id: 'chats', icon: MessagesSquare, label: tx('Czaty', 'Chats'), sc: 'Ctrl+Shift+H' },
    { id: 'git', icon: GitBranch, label: 'Git', sc: 'Ctrl+Shift+G' }
  ];
  return (
    <div className="activitybar">
      {views.map((v) => {
        const on = ui.sidebarVisible && ui.sidebarView === v.id;
        return (
          <button
            key={v.id}
            className={`act ${on ? 'on' : ''}`}
            data-tip={`${v.label} (${v.sc})`}
            data-tip-pos="right"
            onClick={() => (on ? patchUi({ sidebarVisible: false }) : patchUi({ sidebarVisible: true, sidebarView: v.id }))}
          >
            <v.icon size={19} strokeWidth={1.7} />
            {v.id === 'chats' && running && <span className="dot" />}
          </button>
        );
      })}
      <div className="grow" />
      <button className={`act ${!ui.chatVisible ? '' : 'on'}`} data-tip={tx('Agent AI (Ctrl+L)', 'AI agent (Ctrl+L)')} data-tip-pos="right" onClick={() => patchUi({ chatVisible: !ui.chatVisible })}>
        <Bot size={19} strokeWidth={1.7} />
      </button>
      <button className="act" data-tip={tx('Zużycie tokenów', 'Token usage')} data-tip-pos="right" onClick={() => useApp.getState().setModal('usage')}>
        <BarChart3 size={19} strokeWidth={1.7} />
      </button>
      <button className="act" data-tip={tx('Ustawienia (Ctrl+,)', 'Settings (Ctrl+,)')} data-tip-pos="right" onClick={() => useApp.getState().setModal('settings', 'general')}>
        <Settings size={19} strokeWidth={1.7} />
      </button>
    </div>
  );
}

export function modelLabel(provider: string, model: string, models: { id: string; provider: string; name: string }[]) {
  if (provider === 'local') {
    try {
      return `Lunarix ${tierById(model as LocalTierId).name}`;
    } catch {
      return 'Lunarix';
    }
  }
  return models.find((m) => m.provider === provider && m.id === model)?.name || model;
}

export function StatusBar() {
  const engine = useApp((s) => s.engine);
  const settings = useApp((s) => s.settings!);
  const models = useApp((s) => s.models);
  const usage = useApp((s) => s.usage);
  const project = useApp((s) => s.projects.find((p) => p.id === s.projectId));
  const allDownloads = useApp((s) => s.downloads);
  const downloads = Object.values(allDownloads).filter((d) => d.state === 'running');
  const active = settings.activeModel;
  const engineText =
    engine.state === 'ready'
      ? tx(`Lokalny: ${engine.tier?.toUpperCase()} gotowy`, `Local: ${engine.tier?.toUpperCase()} ready`)
      : engine.state === 'starting'
        ? engine.message || tx('Ładowanie modelu…', 'Loading model…')
        : engine.state === 'installing'
          ? engine.message || tx('Instalacja silnika…', 'Installing engine…')
          : engine.state === 'error'
            ? tx('Błąd silnika', 'Engine error')
            : tx('Lokalny: uśpiony', 'Local: idle');
  return (
    <div className="statusbar">
      <button className="sb" onClick={() => project && api.openPath(project.path)} data-tip-pos="top" data-tip={project?.path || ''}>
        <FolderOpen size={12} />
        {project?.name}
      </button>
      <button className="sb" onClick={() => useApp.getState().setModal('settings', 'local')}>
        {engine.state === 'starting' || engine.state === 'installing' ? <Loader2 size={12} className="spin" /> : <Cpu size={12} />}
        <span className="ellipsis" style={{ maxWidth: 280 }}>{engineText}</span>
      </button>
      {downloads.length > 0 && (
        <button className="sb" onClick={() => useApp.getState().setModal('settings', 'local')}>
          <Loader2 size={12} className="spin" />
          {downloads[0].label} · {Math.round((downloads[0].received / Math.max(1, downloads[0].total)) * 100)}%
        </button>
      )}
      <div className="grow" />
      <button className="sb" onClick={() => useApp.getState().setModal('usage')} data-tip-pos="top" data-tip={tx('Tokeny dziś (wejście / wyjście)', 'Tokens today (in / out)')}>
        <Zap size={12} />
        {fmtTokens(usage?.today.input)} / {fmtTokens(usage?.today.output)}
        {usage && usage.today.cost > 0 ? ` · ${fmtCost(usage.today.cost)}` : ''}
      </button>
      <button className="sb" onClick={() => useApp.getState().setModal('settings', active.provider === 'local' ? 'local' : 'providers')}>
        <Bot size={12} />
        {modelLabel(active.provider, active.model, models)}
      </button>
      <button className="sb" onClick={() => runCommand('lang.toggle')}>
        <Languages size={12} />
        {settings.language.toUpperCase()}
      </button>
    </div>
  );
}
