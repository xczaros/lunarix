import { useEffect, useState } from 'react';
import {
  SlidersHorizontal,
  KeyRound,
  Cpu,
  Bot,
  Code2,
  Wrench,
  BookOpenText,
  Info,
  X,
  ExternalLink,
  Loader2,
  RefreshCw,
  Download,
  Trash2,
  Check,
  Play,
  Square,
  FolderOpen,
  HardDrive,
  MemoryStick,
  MonitorCog,
  Eye,
  ScrollText,
  Gift,
  ChevronDown,
  Moon,
  ShieldCheck,
  ShieldAlert,
  Zap
} from 'lucide-react';
import type { ProviderId, Settings as S, LocalTierId } from '@shared/types';
import { LOCAL_TIERS, PROVIDERS, USE_CASES } from '@shared/catalog';
import { useApp } from '../store/app';
import { useEditor } from '../store/editor';
import { api, on } from '../lib/api';
import { tx } from '../lib/i18n';
import { fmtBytes, fmtEta, joinPath } from '../lib/format';
import { Seg, Switch, ProgressBar, confirmDialog } from './ui';
import { LogoTile } from './Logo';
import { TierBars } from './ModelPicker';

const NAV = [
  { id: 'general', icon: SlidersHorizontal, pl: 'Ogólne', en: 'General' },
  { id: 'providers', icon: KeyRound, pl: 'Modele i klucze API', en: 'Models & API keys' },
  { id: 'local', icon: Cpu, pl: 'Modele lokalne', en: 'Local models' },
  { id: 'agent', icon: Bot, pl: 'Agent', en: 'Agent' },
  { id: 'editor', icon: Code2, pl: 'Edytor', en: 'Editor' },
  { id: 'tools', icon: Wrench, pl: 'Narzędzia deweloperskie', en: 'Developer tools' },
  { id: 'memory', icon: BookOpenText, pl: 'Instrukcje i pamięć', en: 'Instructions & memory' },
  { id: 'about', icon: Info, pl: 'O Lunarix', en: 'About' }
];

export function SettingsModal() {
  const tab = useApp((s) => s.settingsTab);
  const close = () => useApp.getState().setModal(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return (
    <div className="backdrop center" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal settings">
        <div className="s-nav">
          <div className="s-title">
            <SlidersHorizontal size={16} /> {tx('Ustawienia', 'Settings')}
          </div>
          {NAV.map((n) => (
            <button key={n.id} className={tab === n.id ? 'on' : ''} onClick={() => useApp.setState({ settingsTab: n.id })}>
              <n.icon size={15} /> {tx(n.pl, n.en)}
            </button>
          ))}
        </div>
        <div className="s-main">
          <button className="icon-btn" style={{ position: 'absolute', right: 14, top: 14 }} onClick={close}>
            <X size={16} />
          </button>
          <div key={tab} className="fade-up">
            {tab === 'general' && <General />}
            {tab === 'providers' && <Providers />}
            {tab === 'local' && <LocalModels />}
            {tab === 'agent' && <AgentSettings />}
            {tab === 'editor' && <EditorSettings />}
            {tab === 'tools' && <Toolchain />}
            {tab === 'memory' && <Memory />}
            {tab === 'about' && <About />}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="sr-text">
        <div className="sr-title">{title}</div>
        {desc && <div className="sr-desc">{desc}</div>}
      </div>
      {children}
    </div>
  );
}

function useS() {
  const s = useApp((x) => x.settings!);
  const patch = useApp((x) => x.patchSettings);
  return { s, patch };
}

const USE_LABEL: Record<string, [string, string]> = {
  web: ['Strony WWW', 'Websites'],
  fullstack: ['Aplikacje webowe', 'Web apps'],
  desktop: ['Aplikacje desktop', 'Desktop apps'],
  games: ['Gry', 'Games'],
  python: ['Python / AI / dane', 'Python / AI / data'],
  automation: ['Skrypty i automatyzacja', 'Scripts & automation'],
  mobile: ['Aplikacje mobilne', 'Mobile apps'],
  learning: ['Nauka programowania', 'Learning to code']
};

function General() {
  const { s, patch } = useS();
  return (
    <>
      <h2>{tx('Ogólne', 'General')}</h2>
      <div className="s-sub">{tx('Wygląd, język i Twój profil.', 'Appearance, language and your profile.')}</div>
      <Row title={tx('Język', 'Language')}>
        <Seg value={s.language} onChange={(v) => patch({ language: v })} options={[{ value: 'pl', label: 'Polski' }, { value: 'en', label: 'English' }]} />
      </Row>
      <Row title={tx('Motyw', 'Theme')} desc={tx('Czarny lub biały — zawsze monochromatyczny.', 'Black or white — always monochrome.')}>
        <Seg value={s.theme} onChange={(v) => patch({ theme: v })} options={[{ value: 'dark', label: tx('Czarny', 'Black') }, { value: 'light', label: tx('Biały', 'White') }]} />
      </Row>
      <Row title={tx('Folder projektów', 'Projects folder')} desc={s.projectsRoot}>
        <button
          className="btn sm"
          onClick={async () => {
            const d = await api.selectFolder();
            if (d) patch({ projectsRoot: d });
          }}
        >
          <FolderOpen size={13} /> {tx('Zmień', 'Change')}
        </button>
      </Row>
      <h4>{tx('Do czego używasz Lunarix', 'What you use Lunarix for')}</h4>
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {USE_CASES.map((u) => {
          const on = s.profile.useCases.includes(u);
          return (
            <button
              key={u}
              className={`btn sm ${on ? 'primary' : ''}`}
              onClick={() => patch({ profile: { ...s.profile, useCases: on ? s.profile.useCases.filter((x) => x !== u) : [...s.profile.useCases, u] } })}
            >
              {tx(USE_LABEL[u][0], USE_LABEL[u][1])}
            </button>
          );
        })}
      </div>
      <Row title={tx('Doświadczenie', 'Experience')} desc={tx('Agent dopasuje sposób tłumaczenia.', 'The agent adapts how it explains things.')}>
        <Seg
          value={s.profile.experience}
          onChange={(v) => patch({ profile: { ...s.profile, experience: v } })}
          options={[
            { value: 'beginner', label: tx('Początkujący', 'Beginner') },
            { value: 'intermediate', label: tx('Średni', 'Intermediate') },
            { value: 'pro', label: 'Pro' }
          ]}
        />
      </Row>
      <h4>{tx('Powiadomienia', 'Notifications')}</h4>
      <Row title={tx('Powiadom, gdy agent skończy', 'Notify when the agent finishes')} desc={tx('Powiadomienie Windows, gdy okno jest w tle.', 'Windows notification when the window is in the background.')}>
        <Switch on={s.agent.notifyOnDone} onChange={(v) => patch({ agent: { ...s.agent, notifyOnDone: v } })} />
      </Row>
      <Row title={tx('Dźwięk zakończenia', 'Completion sound')}>
        <Switch on={s.agent.sound} onChange={(v) => patch({ agent: { ...s.agent, sound: v } })} />
      </Row>
      <Row title={tx('Konfiguracja startowa', 'Setup wizard')} desc={tx('Przejdź ponownie przez konfigurację i dobór modelu.', 'Run the setup and model matching again.')}>
        <button className="btn sm" onClick={() => patch({ onboarded: false }).then(() => useApp.getState().setModal(null))}>
          {tx('Uruchom', 'Run')}
        </button>
      </Row>
    </>
  );
}

// ------------------------------------------------------------- providers

function Providers() {
  const providers = useApp((s) => s.providers);
  const [open, setOpen] = useState<ProviderId | null>(() => providers.find((p) => p.hasKey)?.id || 'anthropic');
  useEffect(() => {
    useApp.getState().refreshProviders();
  }, []);
  return (
    <>
      <h2>{tx('Modele i klucze API', 'Models & API keys')}</h2>
      <div className="s-sub">{tx('Wklej własne klucze — płacisz bezpośrednio dostawcy, Lunarix nie dolicza nic. Klucze są szyfrowane (Windows DPAPI).', 'Paste your own keys — you pay the provider directly, Lunarix adds nothing. Keys are encrypted (Windows DPAPI).')}</div>
      {PROVIDERS.map((meta) => {
        const p = providers.find((x) => x.id === meta.id);
        if (!p) return null;
        return <ProviderCard key={meta.id} id={meta.id} open={open === meta.id} onToggle={() => setOpen(open === meta.id ? null : meta.id)} />;
      })}
    </>
  );
}

function ProviderCard({ id, open, onToggle }: { id: ProviderId; open: boolean; onToggle: () => void }) {
  const meta = PROVIDERS.find((p) => p.id === id)!;
  const p = useApp((s) => s.providers.find((x) => x.id === id))!;
  const active = useApp((s) => s.settings!.activeModel);
  const [key, setKey] = useState('');
  const [account, setAccount] = useState(p.accountId || '');
  const [base, setBase] = useState(p.baseUrl || meta.defaultBaseUrl || '');
  const [busy, setBusy] = useState(false);
  const fetched = p.modelsFetchedAt;
  const save = async () => {
    setBusy(true);
    try {
      const patch: any = {};
      if (key.trim()) patch.apiKey = key.trim();
      if (meta.needsAccountId) patch.accountId = account;
      if (meta.needsBaseUrl) patch.baseUrl = base;
      await api.setProvider(id, patch);
      setKey('');
      if (!meta.needsKey || patch.apiKey || patch.baseUrl || patch.accountId) {
        const models = await api.fetchModels(id).catch((e) => {
          useApp.getState().toast(`${meta.short}: ${e.message}`, 'error');
          return null;
        });
        if (models) useApp.getState().toast(tx(`${meta.short}: ${models.length} modeli dostępnych`, `${meta.short}: ${models.length} models available`), 'success');
      }
      await useApp.getState().refreshProviders();
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    await api.setProvider(id, { apiKey: '' });
    await useApp.getState().refreshProviders();
  };
  const status = p.hasKey || (meta.needsBaseUrl && fetched) ? (p.lastError ? tx('błąd', 'error') : fetched ? tx(`${p.models.length} modeli`, `${p.models.length} models`) : tx('klucz zapisany', 'key saved')) : tx('nie skonfigurowano', 'not configured');
  return (
    <div className="prov-card">
      <div className="ph" onClick={onToggle}>
        <div className="pi">{meta.short.slice(0, 2)}</div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>{meta.name}</div>
          <div className="faint ellipsis" style={{ fontSize: 12 }}>{tx(meta.description.pl, meta.description.en)}</div>
        </div>
        <span className={`badge ${p.hasKey || (meta.needsBaseUrl && fetched) ? 'solid' : 'dim'}`}>
          {p.hasKey || (meta.needsBaseUrl && fetched) ? <Check size={10} /> : null}
          {status}
        </span>
        <ChevronDown size={15} style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .2s' }} />
      </div>
      {open && (
        <div className="pb fade-in">
          {meta.needsKey && (
            <div className="field" style={{ marginTop: 12 }}>
              <label>
                {meta.id === 'cloudflare' ? 'API Token' : tx('Klucz API', 'API key')}
                {p.keyPreview && <span className="faint"> · {tx('zapisany', 'saved')}: {p.keyPreview}</span>}
              </label>
              <input className="input mono" type="password" placeholder={p.hasKey ? tx('Wklej nowy, aby zmienić', 'Paste a new one to replace') : 'sk-…'} value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
            </div>
          )}
          {meta.needsAccountId && (
            <div className="field">
              <label>Account ID</label>
              <input className="input mono" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="0123456789abcdef…" />
            </div>
          )}
          {meta.needsBaseUrl && (
            <div className="field" style={{ marginTop: meta.needsKey ? 0 : 12 }}>
              <label>Base URL</label>
              <input className="input mono" value={base} onChange={(e) => setBase(e.target.value)} />
            </div>
          )}
          {meta.id === 'custom' && (
            <div className="field">
              <label>{tx('Klucz API (opcjonalnie)', 'API key (optional)')}</label>
              <input className="input mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} />
            </div>
          )}
          {p.lastError && <div className="hint" style={{ marginBottom: 10 }}>⚠ {p.lastError}</div>}
          <div className="row">
            <button className="btn sm primary" onClick={save} disabled={busy}>
              {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} {tx('Zapisz i pobierz listę modeli', 'Save & fetch model list')}
            </button>
            {meta.keyUrl && (
              <button className="btn sm ghost" onClick={() => api.openExternal(meta.keyUrl!)}>
                <ExternalLink size={13} /> {tx('Zdobądź klucz', 'Get a key')}
              </button>
            )}
            <div className="grow" />
            {p.hasKey && (
              <button className="btn sm ghost" onClick={remove}>
                <Trash2 size={13} /> {tx('Usuń klucz', 'Remove key')}
              </button>
            )}
          </div>
          {p.models.length > 0 && (p.hasKey || !!fetched) && (
            <>
              <div className="hint" style={{ marginTop: 12 }}>
                {tx('Kliknij model, aby ustawić go jako domyślny:', 'Click a model to make it the default:')}
              </div>
              <div className="model-chips">
                {p.models.slice(0, 300).map((m) => {
                  const on = active.provider === id && active.model === m.id;
                  return (
                    <button key={m.id} className={`btn sm ${on ? 'primary' : ''}`} onClick={() => useApp.getState().patchSettings({ activeModel: { provider: id, model: m.id } })} title={m.id}>
                      {m.free && <Gift size={11} />}
                      {m.vision && <Eye size={11} />}
                      {m.name}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------- local models

const RATING: Record<string, [string, string]> = {
  great: ['Świetnie', 'Great'],
  good: ['Dobrze', 'Good'],
  slow: ['Wolno', 'Slow'],
  unsupported: ['Za słaby PC', 'Too heavy']
};

export function LocalModels() {
  const { s, patch } = useS();
  const hw = useApp((x) => x.hardware);
  const local = useApp((x) => x.localModels);
  const downloads = useApp((x) => x.downloads);
  const engine = useApp((x) => x.engine);
  const [logs, setLogs] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  useEffect(() => {
    api.localModels().then((l) => useApp.setState({ localModels: l }));
    if (!hw) api.hardware().then((h) => useApp.setState({ hardware: h }));
  }, [hw]);
  const active = s.activeModel.provider === 'local' ? s.activeModel.model : null;
  return (
    <>
      <h2>{tx('Modele lokalne', 'Local models')}</h2>
      <div className="s-sub">{tx('Działają na Twoim komputerze: bez limitów, bez opłat, prywatnie. Wszystkie rozumieją też obrazy i zrzuty ekranu.', 'Run on your PC: no limits, no fees, private. All of them also understand images and screenshots.')}</div>
      <div className="card" style={{ padding: 14, marginBottom: 16 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <MonitorCog size={16} />
          <b>{tx('Twój komputer', 'Your computer')}</b>
          <div className="grow" />
          <button
            className="btn sm ghost"
            onClick={async () => {
              setScanning(true);
              useApp.setState({ hardware: await api.hardware(true) });
              setScanning(false);
            }}
          >
            {scanning ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} {tx('Skanuj ponownie', 'Rescan')}
          </button>
        </div>
        {hw ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, fontSize: 12.5 }}>
            <div>
              <div className="faint">CPU</div>
              <div className="ellipsis" title={hw.cpu.model}>{hw.cpu.model.replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').trim()}</div>
              <div className="faint">{hw.cpu.cores} {tx('rdzeni', 'cores')} / {hw.cpu.threads} {tx('wątków', 'threads')}</div>
            </div>
            <div>
              <div className="faint">RAM</div>
              <div>{hw.ramGB.toFixed(1)} GB</div>
              <div className="faint">{tx('wolne', 'free')} {hw.freeRamGB.toFixed(1)} GB</div>
            </div>
            <div>
              <div className="faint">GPU</div>
              <div className="ellipsis" title={hw.bestGpu?.name}>{hw.bestGpu?.name || tx('brak dedykowanego', 'no dedicated GPU')}</div>
              <div className="faint">{hw.bestGpu ? `${hw.bestGpu.vramGB} GB VRAM` : 'CPU'}{hw.cudaVersion ? ` · CUDA ${hw.cudaVersion}` : ''}</div>
            </div>
            <div>
              <div className="faint">{tx('Dysk', 'Disk')}</div>
              <div>{hw.diskFreeGB.toFixed(0)} GB {tx('wolne', 'free')}</div>
              <div className="faint">{tx('polecany', 'recommended')}: <b style={{ color: 'var(--fg)' }}>{hw.recommended.toUpperCase()}</b></div>
            </div>
          </div>
        ) : (
          <div className="skeleton" style={{ height: 40 }} />
        )}
      </div>
      <div className="tier-grid">
        {LOCAL_TIERS.map((t, i) => {
          const st = local.find((l) => l.tier === t.id);
          const r = hw?.ratings?.[t.id];
          const dl = downloads[`model-${t.id}`] || downloads[`mmproj-${t.id}`];
          const dlRunning = dl && dl.state === 'running';
          return (
            <div key={t.id} className={`tier-card ${active === t.id ? 'active' : ''}`}>
              <div className="tc-head">
                <TierBars level={i + 1} />
                <span className="tc-name">Lunarix {t.name}</span>
                {hw?.recommended === t.id && <span className="badge solid">{tx('polecany', 'recommended')}</span>}
                <div className="grow" />
                {st?.downloaded && <span className="badge"><Check size={10} /> {tx('pobrany', 'downloaded')}</span>}
              </div>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {t.model} · {t.params}
              </div>
              <div className="row faint" style={{ fontSize: 12, gap: 12 }}>
                <span><HardDrive size={11} /> {(t.sizeGB + t.mmprojGB).toFixed(1)} GB</span>
                <span><MemoryStick size={11} /> {tx('min.', 'min')} {t.minRamGB} GB RAM</span>
                {r && <span><Zap size={11} /> {tx(RATING[r.rating][0], RATING[r.rating][1])} {r.speed !== '—' ? r.speed : ''}</span>}
              </div>
              {dlRunning && (
                <div className="col" style={{ gap: 4 }}>
                  <ProgressBar value={dl.received / Math.max(1, dl.total)} indeterminate={!dl.total} />
                  <div className="row faint" style={{ fontSize: 11.5 }}>
                    {dl.verifying ? tx('Sprawdzanie sumy kontrolnej…', 'Verifying checksum…') : `${fmtBytes(dl.received)} / ${fmtBytes(dl.total)} · ${fmtBytes(dl.speed)}/s`}
                    <div className="grow" />
                    {dl.verifying ? '' : fmtEta(dl.eta)}
                  </div>
                </div>
              )}
              <div className="row" style={{ marginTop: 'auto' }}>
                {st?.downloaded ? (
                  <button className={`btn sm ${active === t.id ? '' : 'primary'}`} onClick={() => patch({ activeModel: { provider: 'local', model: t.id }, local: { ...s.local, tier: t.id } })}>
                    {active === t.id ? <Check size={13} /> : null}
                    {active === t.id ? tx('Używany', 'In use') : tx('Używaj', 'Use')}
                  </button>
                ) : dlRunning ? (
                  <button className="btn sm" onClick={() => api.cancelDownload(dl.id)}>
                    <X size={13} /> {tx('Anuluj', 'Cancel')}
                  </button>
                ) : (
                  <button
                    className="btn sm primary"
                    onClick={async () => {
                      if (r?.rating === 'unsupported' && !(await confirmDialog(tx('Model może nie działać', 'Model may not run'), tx('Twój komputer może mieć za mało pamięci dla tego modelu. Pobrać mimo to?', 'Your PC may not have enough memory for this model. Download anyway?'), tx('Pobierz', 'Download')))) return;
                      api.downloadTier(t.id);
                    }}
                  >
                    <Download size={13} /> {tx('Pobierz', 'Download')} {(t.sizeGB + t.mmprojGB).toFixed(1)} GB
                  </button>
                )}
                {st?.downloaded && (
                  <button
                    className="icon-btn"
                    data-tip={tx('Usuń z dysku', 'Delete from disk')}
                    onClick={async () => {
                      if (await confirmDialog(tx('Usunąć model?', 'Delete model?'), `Lunarix ${t.name} (${(t.sizeGB + t.mmprojGB).toFixed(1)} GB)`, tx('Usuń', 'Delete'), true)) {
                        await api.deleteTier(t.id);
                        useApp.setState({ localModels: await api.localModels() });
                      }
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <h4>{tx('Silnik (llama.cpp)', 'Engine (llama.cpp)')}</h4>
      <div className="card" style={{ padding: 14 }}>
        <div className="row">
          {engine.state === 'ready' ? <span className="pulse-dot" /> : engine.state === 'starting' || engine.state === 'installing' ? <Loader2 size={14} className="spin" /> : <Cpu size={14} />}
          <b>
            {engine.state === 'ready'
              ? tx(`Działa: Lunarix ${engine.tier?.toUpperCase()} (${engine.backend?.toUpperCase()})`, `Running: Lunarix ${engine.tier?.toUpperCase()} (${engine.backend?.toUpperCase()})`)
              : engine.state === 'not-installed'
                ? tx('Silnik zostanie pobrany automatycznie przy pierwszym użyciu', 'The engine downloads automatically on first use')
                : engine.message || engine.state}
          </b>
          <div className="grow" />
          {engine.state === 'ready' || engine.state === 'starting' ? (
            <button className="btn sm" onClick={() => api.stopEngine()}>
              <Square size={12} /> {tx('Zatrzymaj', 'Stop')}
            </button>
          ) : (
            <button className="btn sm" onClick={() => api.startEngine(s.activeModel.provider === 'local' ? (s.activeModel.model as LocalTierId) : s.local.tier)}>
              <Play size={12} /> {tx('Uruchom', 'Start')}
            </button>
          )}
          <button className="btn sm ghost" onClick={async () => setLogs(await api.engineLogs())}>
            <ScrollText size={13} /> {tx('Logi', 'Logs')}
          </button>
        </div>
        {engine.error && <div className="hint" style={{ marginTop: 8 }}>⚠ {engine.error}</div>}
        {engine.state === 'ready' && (
          <div className="hint" style={{ marginTop: 8 }}>
            {tx('Kontekst', 'Context')}: {engine.contextSize?.toLocaleString()} {tx('tokenów', 'tokens')} · {tx('widzenie', 'vision')}: {engine.vision ? tx('tak', 'yes') : tx('nie', 'no')} · llama.cpp {engine.version}
          </div>
        )}
      </div>
      <Row title={tx('Akceleracja', 'Acceleration')} desc={tx('Auto: CUDA dla NVIDIA, Vulkan dla AMD/Intel, CPU bez karty.', 'Auto: CUDA for NVIDIA, Vulkan for AMD/Intel, CPU without GPU.')}>
        <Seg value={s.local.backend} onChange={(v) => patch({ local: { ...s.local, backend: v } })} options={[{ value: 'auto', label: 'Auto' }, { value: 'cuda', label: 'CUDA' }, { value: 'vulkan', label: 'Vulkan' }, { value: 'cpu', label: 'CPU' }]} />
      </Row>
      <Row title={tx('Rozmiar kontekstu', 'Context size')} desc={tx('Więcej = dłuższa pamięć rozmowy, ale więcej RAM. 0 = automatycznie.', 'More = longer memory, but more RAM. 0 = automatic.')}>
        <select className="select" style={{ width: 150 }} value={s.local.contextSize} onChange={(e) => patch({ local: { ...s.local, contextSize: Number(e.target.value) } })}>
          {[0, 8192, 16384, 32768, 49152, 65536, 98304, 131072, 262144].map((v) => (
            <option key={v} value={v}>
              {v === 0 ? 'Auto' : `${v / 1024}K`}
            </option>
          ))}
        </select>
      </Row>
      <Row title={tx('Warstwy na GPU', 'GPU layers')} desc={tx('-1 = automatycznie dopasuj do VRAM.', '-1 = auto-fit to VRAM.')}>
        <input className="input" type="number" style={{ width: 90 }} value={s.local.gpuLayers} min={-1} max={999} onChange={(e) => patch({ local: { ...s.local, gpuLayers: Number(e.target.value) } })} />
      </Row>
      <Row title={tx('Wątki CPU', 'CPU threads')} desc={tx('0 = automatycznie.', '0 = automatic.')}>
        <input className="input" type="number" style={{ width: 90 }} value={s.local.threads} min={0} max={128} onChange={(e) => patch({ local: { ...s.local, threads: Number(e.target.value) } })} />
      </Row>
      <Row title={tx('Tryb myślenia', 'Thinking mode')} desc={tx('Model najpierw rozumuje — lepsza jakość, trochę wolniej.', 'The model reasons first — better quality, a bit slower.')}>
        <Switch on={s.local.thinking} onChange={(v) => patch({ local: { ...s.local, thinking: v } })} />
      </Row>
      <Row title={tx('Widzenie (obrazy i zrzuty ekranu)', 'Vision (images & screenshots)')} desc={tx('Ładuje moduł widzenia (~0,6–0,9 GB).', 'Loads the vision module (~0.6–0.9 GB).')}>
        <Switch on={s.local.vision} onChange={(v) => patch({ local: { ...s.local, vision: v } })} />
      </Row>
      <Row title={tx('Zwolnij pamięć po bezczynności', 'Unload after idle')} desc={tx('Minuty bez użycia, po których model jest wyładowany. 0 = nigdy.', 'Minutes idle before unloading. 0 = never.')}>
        <input className="input" type="number" style={{ width: 90 }} value={s.local.idleUnloadMinutes} min={0} max={1440} onChange={(e) => patch({ local: { ...s.local, idleUnloadMinutes: Number(e.target.value) } })} />
      </Row>
      <Row title={tx('Folder modeli', 'Models folder')} desc={s.local.modelsDir}>
        <button className="btn sm" onClick={() => api.openPath(s.local.modelsDir)}>
          <FolderOpen size={13} />
        </button>
        <button
          className="btn sm"
          onClick={async () => {
            const d = await api.selectFolder();
            if (d) patch({ local: { ...s.local, modelsDir: d } });
          }}
        >
          {tx('Zmień', 'Change')}
        </button>
      </Row>
      {logs !== null && (
        <div className="backdrop center" style={{ zIndex: 950 }} onMouseDown={(e) => e.target === e.currentTarget && setLogs(null)}>
          <div className="modal" style={{ width: 'min(900px, 92vw)', height: '70vh' }}>
            <div className="modal-head">
              <ScrollText size={16} /> {tx('Logi silnika', 'Engine logs')}
              <div className="grow" />
              <button className="icon-btn" onClick={() => setLogs(null)}>
                <X size={15} />
              </button>
            </div>
            <pre className="selectable" style={{ margin: 0, padding: '0 18px 18px', overflow: 'auto', fontSize: 11.5, flex: 1, whiteSpace: 'pre-wrap', color: 'var(--fg-2)' }}>
              {logs}
            </pre>
          </div>
        </div>
      )}
    </>
  );
}

function AgentSettings() {
  const { s, patch } = useS();
  const a = s.agent;
  const set = (p: Partial<S['agent']>) => patch({ agent: { ...a, ...p } });
  return (
    <>
      <h2>Agent</h2>
      <div className="s-sub">{tx('Jak samodzielnie ma działać Lunarix.', 'How autonomously Lunarix works.')}</div>
      <h4>{tx('Autonomia', 'Autonomy')}</h4>
      <div className="col" style={{ gap: 8 }}>
        {[
          { v: 'ask', icon: ShieldAlert, t: tx('Pytaj o zgodę', 'Ask for approval'), d: tx('Każda zmiana pliku i komenda wymaga Twojej zgody.', 'Every file change and command needs your approval.') },
          { v: 'auto-edits', icon: ShieldCheck, t: tx('Auto-edycje', 'Auto-edit'), d: tx('Pliki w projekcie zmienia sam, o komendy i sterowanie pulpitem pyta.', 'Edits project files on its own, asks before commands and desktop control.') },
          { v: 'chill', icon: Moon, t: tx('Chill — pełna autonomia', 'Chill — full autonomy'), d: tx('Robi wszystko sam: pisze, instaluje, uruchamia, testuje. Pyta tylko o groźne komendy.', 'Does everything itself: writes, installs, runs, tests. Asks only about dangerous commands.') }
        ].map((o) => (
          <button key={o.v} className={`choice ${a.approval === o.v ? 'on' : ''}`} style={{ flexDirection: 'row', alignItems: 'center', padding: '12px 14px' }} onClick={() => set({ approval: o.v as any })}>
            <o.icon size={18} />
            <div className="col">
              <span className="ch-t">{o.t}</span>
              <span className="ch-d">{o.d}</span>
            </div>
            {a.approval === o.v && (
              <span className="check">
                <Check size={11} />
              </span>
            )}
          </button>
        ))}
      </div>
      <h4>{tx('Zachowanie', 'Behaviour')}</h4>
      <Row title={tx('Domyślny tryb nowych czatów', 'Default mode for new chats')}>
        <Seg value={a.defaultMode} onChange={(v) => set({ defaultMode: v })} options={[{ value: 'agent', label: 'Agent' }, { value: 'plan', label: 'Plan' }, { value: 'ask', label: 'Ask' }]} />
      </Row>
      <Row title={tx('Śledź agenta w edytorze', 'Follow the agent in the editor')} desc={tx('Otwieraj pliki, które agent właśnie zmienia.', 'Open files the agent is editing.')}>
        <Switch on={a.followAgent} onChange={(v) => set({ followAgent: v })} />
      </Row>
      <Row title={tx('Pokazuj okno przeglądarki testowej', 'Show the test browser window')} desc={tx('Widzisz na żywo, jak agent testuje strony.', 'Watch the agent test web pages live.')}>
        <Switch on={a.showBrowser} onChange={(v) => set({ showBrowser: v })} />
      </Row>
      <Row title={tx('Sterowanie pulpitem', 'Desktop control')} desc={tx('Pozwól agentowi robić zrzuty ekranu i używać myszy/klawiatury do testowania aplikacji.', 'Allow screenshots and mouse/keyboard control for testing apps.')}>
        <Switch on={a.allowDesktop} onChange={(v) => set({ allowDesktop: v })} />
      </Row>
      <Row title={tx('Automatyczne kompaktowanie kontekstu', 'Auto-compact context')} desc={tx('Gdy rozmowa jest bardzo długa, starsza część jest streszczana.', 'When the chat gets long, older parts are summarized.')}>
        <Switch on={a.autoCompact} onChange={(v) => set({ autoCompact: v })} />
      </Row>
      <Row title={tx('Automatyczne nazwy czatów', 'Automatic chat titles')}>
        <Switch on={a.autoTitle} onChange={(v) => set({ autoTitle: v })} />
      </Row>
      <Row title={tx('Maksymalna liczba kroków', 'Maximum steps')} desc={tx('Ile wywołań narzędzi agent może wykonać na jedno zadanie.', 'How many tool calls per task.')}>
        <input className="input" type="number" style={{ width: 90 }} value={a.maxSteps} min={5} max={1000} onChange={(e) => set({ maxSteps: Number(e.target.value) })} />
      </Row>
      <Row title={tx('Limit czasu komendy (s)', 'Command timeout (s)')} desc={tx('Po tym czasie komenda przechodzi w tło.', 'After this the command moves to the background.')}>
        <input className="input" type="number" style={{ width: 90 }} value={a.commandTimeoutSec} min={10} max={900} onChange={(e) => set({ commandTimeoutSec: Number(e.target.value) })} />
      </Row>
      <h4>{tx('Modele w chmurze', 'Cloud models')}</h4>
      <Row title={tx('Poziom rozumowania (effort)', 'Reasoning effort')} desc={tx('Dla modeli, które go obsługują (Claude, GPT). Auto = wysoki dla kodowania.', 'For models that support it (Claude, GPT). Auto = high for coding.')}>
        <select className="select" style={{ width: 130 }} value={a.effort} onChange={(e) => set({ effort: e.target.value as any })}>
          {['auto', 'low', 'medium', 'high', 'xhigh', 'max'].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </Row>
      <Row title={tx('Fallback przy odmowie (Anthropic)', 'Refusal fallback (Anthropic)')} desc={tx('Gdy model Claude odmówi z powodów polityki, zapytanie automatycznie przejdzie do modelu zapasowego.', 'If a Claude model declines for policy reasons, the request automatically falls back to a backup model.')}>
        <Switch on={a.anthropicFallback} onChange={(v) => set({ anthropicFallback: v })} />
      </Row>
    </>
  );
}

function EditorSettings() {
  const { s, patch } = useS();
  const e = s.editor;
  const set = (p: Partial<S['editor']>) => patch({ editor: { ...e, ...p } });
  return (
    <>
      <h2>{tx('Edytor', 'Editor')}</h2>
      <div className="s-sub">Monaco — {tx('ten sam silnik co VS Code.', 'the same engine as VS Code.')}</div>
      <Row title={tx('Rozmiar czcionki', 'Font size')}>
        <input className="input" type="number" style={{ width: 90 }} value={e.fontSize} min={9} max={28} step={0.5} onChange={(ev) => set({ fontSize: Number(ev.target.value) })} />
      </Row>
      <Row title={tx('Zawijanie wierszy', 'Word wrap')}>
        <Switch on={e.wordWrap} onChange={(v) => set({ wordWrap: v })} />
      </Row>
      <Row title={tx('Minimapa', 'Minimap')}>
        <Switch on={e.minimap} onChange={(v) => set({ minimap: v })} />
      </Row>
      <Row title={tx('Ligatury czcionki', 'Font ligatures')}>
        <Switch on={e.ligatures} onChange={(v) => set({ ligatures: v })} />
      </Row>
      <Row title={tx('Rozmiar tabulacji', 'Tab size')}>
        <Seg value={String(e.tabSize) as any} onChange={(v) => set({ tabSize: Number(v) })} options={[{ value: '2', label: '2' }, { value: '4', label: '4' }]} />
      </Row>
      <Row title={tx('Automatyczny zapis', 'Auto save')}>
        <Switch on={e.autoSave} onChange={(v) => set({ autoSave: v })} />
      </Row>
    </>
  );
}

function Toolchain() {
  const items = useApp((s) => s.toolchain);
  const [busy, setBusy] = useState<string | null>(null);
  const [logLine, setLogLine] = useState('');
  useEffect(() => {
    api.toolchain(true).then((t) => useApp.setState({ toolchain: t }));
    return on('toolchain:log', ({ text }: { text: string }) => setLogLine(text));
  }, []);
  const install = async (id: string) => {
    setBusy(id);
    try {
      const r = await api.installTool(id);
      useApp.getState().toast(r.split('\n')[0], /fail|nie powiod/i.test(r) ? 'error' : 'success');
      useApp.setState({ toolchain: await api.toolchain(true) });
    } catch (e: any) {
      useApp.getState().toast(e.message, 'error');
    } finally {
      setBusy(null);
      setLogLine('');
    }
  };
  return (
    <>
      <h2>{tx('Narzędzia deweloperskie', 'Developer tools')}</h2>
      <div className="s-sub">{tx('Agent sam instaluje brakujące narzędzia (np. Node.js) gdy są potrzebne. Możesz to zrobić też tutaj.', 'The agent installs missing tools (e.g. Node.js) when needed. You can also do it here.')}</div>
      {items.map((t) => (
        <Row key={t.id} title={t.name} desc={t.installed ? `${t.version || ''}${t.source === 'lunarix' ? tx(' · zainstalowane przez Lunarix', ' · installed by Lunarix') : ''}` : tx('nie znaleziono', 'not found')}>
          {t.installed ? (
            <span className="badge">
              <Check size={10} /> OK
            </span>
          ) : ['node', 'git', 'python', 'go', 'rustc', 'java', 'dotnet'].includes(t.id) ? (
            <button className="btn sm" disabled={!!busy} onClick={() => install(t.id === 'rustc' ? 'rust' : t.id)}>
              {busy === t.id ? <Loader2 size={13} className="spin" /> : <Download size={13} />} {tx('Zainstaluj', 'Install')}
            </button>
          ) : null}
        </Row>
      ))}
      {busy && <div className="hint" style={{ marginTop: 10 }}>{logLine}</div>}
    </>
  );
}

function Memory() {
  const { s, patch } = useS();
  const project = useApp((x) => x.project());
  const [val, setVal] = useState(s.customInstructions);
  return (
    <>
      <h2>{tx('Instrukcje i pamięć', 'Instructions & memory')}</h2>
      <div className="s-sub">{tx('Stałe wskazówki dla agenta we wszystkich projektach.', 'Permanent guidance for the agent across all projects.')}</div>
      <textarea
        className="textarea mono"
        rows={10}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => patch({ customInstructions: val })}
        placeholder={tx('Np. „Zawsze pisz komentarze po polsku. Preferuję TypeScript i Tailwind. Używaj pnpm.”', 'E.g. "Always comment in English. I prefer TypeScript and Tailwind. Use pnpm."')}
      />
      <h4>{tx('Pamięć projektu', 'Project memory')}</h4>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
        {tx('Plik LUNARIX.md w folderze projektu jest automatycznie czytany przez agenta (obsługiwane są też CLAUDE.md i AGENTS.md). Użyj /init w czacie, aby agent sam go przygotował.', 'LUNARIX.md in the project folder is read by the agent automatically (CLAUDE.md and AGENTS.md also work). Use /init in the chat to let the agent create it.')}
      </div>
      {project && (
        <button
          className="btn sm"
          onClick={async () => {
            const p = joinPath(project.path, 'LUNARIX.md');
            if (!(await api.exists(p))) await api.writeFile(p, `# ${project.name}\n\n${tx('Zasady i informacje dla agenta Lunarix w tym projekcie.', 'Rules and information for the Lunarix agent in this project.')}\n\n- \n`);
            useEditor.getState().openFile(p);
            useApp.getState().setModal(null);
          }}
        >
          <BookOpenText size={13} /> {tx('Otwórz LUNARIX.md', 'Open LUNARIX.md')}
        </button>
      )}
    </>
  );
}

function About() {
  const info = useApp((s) => s.info);
  return (
    <div style={{ textAlign: 'center', paddingTop: 30 }}>
      <LogoTile size={96} animated />
      <h2 style={{ marginTop: 16, fontSize: 26 }}>Lunarix</h2>
      <div className="muted">{tx('Darmowy, autonomiczny agent AI do programowania.', 'A free, autonomous AI coding agent.')}</div>
      <div className="faint" style={{ marginTop: 8, fontSize: 12 }}>
        {tx('Wersja', 'Version')} {info?.version} · Electron {info?.electron}
      </div>
      <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}>
        <button className="btn sm" onClick={() => info && api.openPath(info.userData)}>
          <FolderOpen size={13} /> {tx('Folder danych', 'Data folder')}
        </button>
      </div>
      <div className="hint" style={{ maxWidth: 520, margin: '26px auto 0', lineHeight: 1.7 }}>
        {tx(
          'Modele lokalne: Qwen 3.5 / 3.6 / 3.8 (Apache 2.0) uruchamiane przez llama.cpp (MIT). Edytor: Monaco (MIT). Terminal: xterm.js (MIT). Ikony: Lucide (ISC). Czcionki: Inter i JetBrains Mono (OFL).',
          'Local models: Qwen 3.5 / 3.6 / 3.8 (Apache 2.0) run by llama.cpp (MIT). Editor: Monaco (MIT). Terminal: xterm.js (MIT). Icons: Lucide (ISC). Fonts: Inter and JetBrains Mono (OFL).'
        )}
      </div>
    </div>
  );
}
