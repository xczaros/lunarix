import { useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowLeft,
  Globe,
  LayoutDashboard,
  AppWindow,
  Gamepad2,
  BrainCircuit,
  Workflow,
  Smartphone,
  GraduationCap,
  Check,
  Cpu,
  MemoryStick,
  MonitorCog,
  HardDrive,
  Loader2,
  KeyRound,
  Download,
  Moon,
  ShieldCheck,
  ShieldAlert,
  Sparkles,
  ExternalLink
} from 'lucide-react';
import type { HardwareInfo, LocalTierId, ApprovalMode } from '@shared/types';
import { LOCAL_TIERS, PROVIDERS } from '@shared/catalog';
import { useApp } from '../store/app';
import { api } from '../lib/api';
import { tx, setLang } from '../lib/i18n';
import { fmtBytes, fmtEta } from '../lib/format';
import { LogoTile } from './Logo';
import { Stars } from './Stars';
import { ProgressBar, Seg } from './ui';
import { TierBars } from './ModelPicker';

const USES = [
  { id: 'web', icon: Globe, pl: ['Strony WWW', 'Landing page, portfolio, blog'], en: ['Websites', 'Landing pages, portfolios, blogs'] },
  { id: 'fullstack', icon: LayoutDashboard, pl: ['Aplikacje webowe', 'React, Next.js, API, bazy'], en: ['Web apps', 'React, Next.js, APIs, databases'] },
  { id: 'desktop', icon: AppWindow, pl: ['Aplikacje desktop', 'Electron, C#, Python GUI'], en: ['Desktop apps', 'Electron, C#, Python GUI'] },
  { id: 'games', icon: Gamepad2, pl: ['Gry', 'Przeglądarka, pygame, Godot'], en: ['Games', 'Browser, pygame, Godot'] },
  { id: 'python', icon: BrainCircuit, pl: ['Python / AI / dane', 'Skrypty, analiza, ML'], en: ['Python / AI / data', 'Scripts, analysis, ML'] },
  { id: 'automation', icon: Workflow, pl: ['Automatyzacja', 'Skrypty, boty, narzędzia'], en: ['Automation', 'Scripts, bots, tooling'] },
  { id: 'mobile', icon: Smartphone, pl: ['Aplikacje mobilne', 'React Native, Flutter'], en: ['Mobile apps', 'React Native, Flutter'] },
  { id: 'learning', icon: GraduationCap, pl: ['Nauka programowania', 'Tłumaczę wszystko krok po kroku'], en: ['Learning to code', 'I explain everything step by step'] }
];

export function Onboarding() {
  const settings = useApp((s) => s.settings!);
  const [step, setStep] = useState(0);
  const [uses, setUses] = useState<string[]>(settings.profile.useCases.length ? settings.profile.useCases : ['web']);
  const [exp, setExp] = useState(settings.profile.experience);
  const [hw, setHw] = useState<HardwareInfo | null>(null);
  const [scanStage, setScanStage] = useState(0);
  const [tier, setTier] = useState<LocalTierId | null>(null);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [approval, setApproval] = useState<ApprovalMode>('chill');
  const [startDownload, setStartDownload] = useState(true);
  const downloads = useApp((s) => s.downloads);
  const steps = 6;

  // hardware scan with staged animation
  useEffect(() => {
    if (step !== 2 || hw) return;
    let alive = true;
    setScanStage(0);
    const timers = [1, 2, 3, 4].map((i) => setTimeout(() => alive && setScanStage(i), 450 * i));
    api.hardware(true).then((h) => {
      if (!alive) return;
      setTimeout(() => {
        setHw(h);
        useApp.setState({ hardware: h });
        setTier((t) => t || h.recommended);
        setScanStage(5);
      }, 1900);
    });
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
    };
  }, [step, hw]);

  const finish = async () => {
    const chosen = tier || hw?.recommended || 'medium';
    for (const [id, k] of Object.entries(keys)) if (k.trim()) await api.setProvider(id as any, { apiKey: k.trim() });
    const firstKey = Object.entries(keys).find(([, k]) => k.trim());
    const useLocal = startDownload || !firstKey;
    await useApp.getState().patchSettings({
      onboarded: true,
      profile: { useCases: uses, experience: exp },
      local: { ...settings.local, tier: chosen },
      activeModel: useLocal ? { provider: 'local', model: chosen } : settings.activeModel,
      agent: { ...settings.agent, approval }
    });
    if (startDownload) api.downloadTier(chosen);
    const proj = await api.getDefaultProject();
    useApp.setState({ projects: await api.listProjects() });
    await useApp.getState().selectProject(proj.id);
    await useApp.getState().refreshProviders();
    if (!useLocal && firstKey) {
      // pick the first model of the first provider with a key once models are fetched
      setTimeout(async () => {
        const prov = useApp.getState().providers.find((p) => p.id === firstKey[0]);
        const m = prov?.models[0];
        if (m) useApp.getState().patchSettings({ activeModel: { provider: prov!.id, model: m.id } });
      }, 2500);
    }
  };

  const next = () => setStep((s) => Math.min(steps, s + 1));
  const back = () => setStep((s) => Math.max(0, s - 1));
  const chosenTier = LOCAL_TIERS.find((t) => t.id === (tier || hw?.recommended));
  const dl = chosenTier ? downloads[`model-${chosenTier.id}`] : undefined;

  return (
    <div className="onboarding">
      <Stars light={settings.theme === 'light'} density={0.00012} />
      <div className="ob-drag" />
      <div className="ob-body">
        <div className="ob-card">
          {step === 0 && (
            <div className="ob-step" style={{ textAlign: 'center' }}>
              <LogoTile size={112} animated />
              <h1 style={{ marginTop: 26 }}>{tx('Witaj w Lunarix', 'Welcome to Lunarix')}</h1>
              <p className="lead" style={{ margin: '0 auto 26px' }}>
                {tx('Twój autonomiczny programista AI. Opisujesz pomysł — Lunarix planuje, pisze kod, instaluje, uruchamia, testuje i poprawia. Ty możesz się zrelaksować.', 'Your autonomous AI developer. You describe the idea — Lunarix plans, writes code, installs, runs, tests and fixes. You can relax.')}
              </p>
              <Seg
                value={settings.language}
                onChange={(v) => {
                  setLang(v);
                  useApp.getState().patchSettings({ language: v });
                }}
                options={[{ value: 'pl', label: 'Polski' }, { value: 'en', label: 'English' }]}
              />
              <div style={{ marginTop: 30 }}>
                <button className="btn primary lg" onClick={next}>
                  {tx('Zaczynamy', "Let's start")} <ArrowRight size={16} />
                </button>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="ob-step">
              <h1>{tx('Do czego będziesz używać Lunarix?', 'What will you use Lunarix for?')}</h1>
              <p className="lead">{tx('Wybierz dowolnie wiele — dopasuję technologie, styl pracy i model.', 'Pick as many as you like — I will tailor stacks, style and model.')}</p>
              <div className="choice-grid">
                {USES.map((u) => {
                  const on = uses.includes(u.id);
                  const [t, d] = tx('x', 'y') === 'x' ? u.pl : u.en;
                  return (
                    <button key={u.id} className={`choice ${on ? 'on' : ''}`} onClick={() => setUses(on ? uses.filter((x) => x !== u.id) : [...uses, u.id])}>
                      <u.icon size={20} />
                      <span className="ch-t">{t}</span>
                      <span className="ch-d">{d}</span>
                      {on && (
                        <span className="check">
                          <Check size={11} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <div className="row" style={{ marginTop: 22 }}>
                <span className="muted">{tx('Twoje doświadczenie:', 'Your experience:')}</span>
                <Seg
                  value={exp}
                  onChange={setExp}
                  options={[
                    { value: 'beginner', label: tx('Początkujący', 'Beginner') },
                    { value: 'intermediate', label: tx('Średniozaawansowany', 'Intermediate') },
                    { value: 'pro', label: 'Pro' }
                  ]}
                />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="ob-step">
              <h1>{tx('Dobieram model do Twojego komputera', 'Matching a model to your computer')}</h1>
              <p className="lead">{tx('Modele lokalne działają bez limitów i bez opłat. Sprawdzam, który będzie u Ciebie najlepszy.', 'Local models run with no limits and no fees. Checking which one fits your PC best.')}</p>
              <div className="scan-list">
                {[
                  { i: 1, icon: Cpu, l: tx('Procesor', 'Processor'), v: hw ? `${hw.cpu.model.replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').trim()} · ${hw.cpu.cores}C/${hw.cpu.threads}T` : '' },
                  { i: 2, icon: MemoryStick, l: tx('Pamięć RAM', 'Memory'), v: hw ? `${hw.ramGB.toFixed(1)} GB` : '' },
                  { i: 3, icon: MonitorCog, l: tx('Karta graficzna', 'Graphics'), v: hw ? (hw.bestGpu ? `${hw.bestGpu.name} · ${hw.bestGpu.vramGB} GB` : tx('brak dedykowanej — użyję CPU', 'none dedicated — using CPU')) : '' },
                  { i: 4, icon: HardDrive, l: tx('Wolne miejsce', 'Free disk'), v: hw ? `${hw.diskFreeGB.toFixed(0)} GB` : '' }
                ]
                  .filter((x) => scanStage >= x.i)
                  .map((x) => (
                    <div key={x.i} className="scan-item">
                      <span className="si-ico">
                        <x.icon size={16} />
                      </span>
                      <span>{x.l}</span>
                      <span className="si-v">{x.v || <Loader2 size={13} className="spin" />}</span>
                    </div>
                  ))}
              </div>
              {hw && scanStage >= 5 && (
                <div className="rec-card">
                  <div className="row" style={{ marginBottom: 8 }}>
                    <Sparkles size={16} />
                    <b>{tx('Rekomendacja', 'Recommendation')}</b>
                  </div>
                  <div className="col" style={{ gap: 6 }}>
                    {LOCAL_TIERS.map((t, i) => {
                      const r = hw.ratings[t.id];
                      const sel = (tier || hw.recommended) === t.id;
                      return (
                        <button key={t.id} className={`choice ${sel ? 'on' : ''}`} style={{ flexDirection: 'row', alignItems: 'center', padding: '9px 12px', opacity: r.rating === 'unsupported' ? 0.45 : 1 }} onClick={() => setTier(t.id)}>
                          <TierBars level={i + 1} />
                          <span className="ch-t" style={{ width: 120 }}>
                            Lunarix {t.name}
                          </span>
                          <span className="ch-d grow">
                            {t.model} · {(t.sizeGB + t.mmprojGB).toFixed(1)} GB
                          </span>
                          <span className="ch-d" style={{ width: 150, textAlign: 'right' }}>
                            {r.rating === 'great' ? tx('świetnie', 'great') : r.rating === 'good' ? tx('dobrze', 'good') : r.rating === 'slow' ? tx('wolno', 'slow') : tx('za słaby PC', 'too heavy')} {r.speed !== '—' ? `· ${r.speed}` : ''}
                          </span>
                          {hw.recommended === t.id && <span className="badge solid">{tx('najlepszy', 'best')}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="ob-step">
              <h1>{tx('Klucze API (opcjonalnie)', 'API keys (optional)')}</h1>
              <p className="lead">{tx('Chcesz też używać modeli w chmurze (Claude, GPT, Gemini, Grok…)? Wklej swoje klucze. Możesz to pominąć i dodać później w Ustawieniach.', 'Want to also use cloud models (Claude, GPT, Gemini, Grok…)? Paste your keys. You can skip this and add them later in Settings.')}</p>
              <div className="col" style={{ gap: 8 }}>
                {PROVIDERS.filter((p) => p.needsKey && !p.needsAccountId).map((p) => (
                  <div key={p.id} className="row">
                    <span style={{ width: 160, fontWeight: 500 }}>{p.name}</span>
                    <input className="input mono grow" type="password" placeholder={tx('wklej klucz…', 'paste key…')} value={keys[p.id] || ''} onChange={(e) => setKeys({ ...keys, [p.id]: e.target.value })} />
                    {p.keyUrl && (
                      <button className="icon-btn" data-tip={tx('Zdobądź klucz', 'Get a key')} onClick={() => api.openExternal(p.keyUrl!)}>
                        <ExternalLink size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <div className="hint" style={{ marginTop: 12 }}>
                <KeyRound size={12} style={{ verticalAlign: -2 }} /> {tx('Klucze są szyfrowane i nigdy nie opuszczają Twojego komputera (poza zapytaniami do danego dostawcy). Cloudflare skonfigurujesz w Ustawieniach.', 'Keys are encrypted and never leave your PC (except in requests to that provider). Configure Cloudflare in Settings.')}
              </div>
            </div>
          )}

          {step === 4 && chosenTier && (
            <div className="ob-step">
              <h1>{tx('Pobieranie modelu lokalnego', 'Download the local model')}</h1>
              <p className="lead">
                {tx(`Lunarix ${chosenTier.name} (${chosenTier.model}) — ${(chosenTier.sizeGB + chosenTier.mmprojGB).toFixed(1)} GB. Pobieranie trwa w tle; możesz od razu zacząć korzystać z aplikacji.`, `Lunarix ${chosenTier.name} (${chosenTier.model}) — ${(chosenTier.sizeGB + chosenTier.mmprojGB).toFixed(1)} GB. It downloads in the background; you can start using the app right away.`)}
              </p>
              <div className="card" style={{ padding: 16 }}>
                <label className="row" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={startDownload} onChange={(e) => setStartDownload(e.target.checked)} style={{ accentColor: 'var(--fg)', width: 16, height: 16 }} />
                  <span style={{ fontWeight: 500 }}>{tx('Pobierz model teraz', 'Download the model now')}</span>
                </label>
                {dl && dl.state === 'running' && (
                  <div style={{ marginTop: 12 }}>
                    <ProgressBar value={dl.received / Math.max(1, dl.total)} />
                    <div className="hint" style={{ marginTop: 6 }}>
                      {dl.verifying ? tx('Sprawdzanie sumy kontrolnej…', 'Verifying checksum…') : `${fmtBytes(dl.received)} / ${fmtBytes(dl.total)} · ${fmtBytes(dl.speed)}/s · ${fmtEta(dl.eta)}`}
                    </div>
                  </div>
                )}
                <div className="hint" style={{ marginTop: 10 }}>
                  <Download size={12} style={{ verticalAlign: -2 }} /> {tx('Silnik llama.cpp pobierze się automatycznie przy pierwszym użyciu (CUDA / Vulkan / CPU — dobrany do Twojej karty).', 'The llama.cpp engine downloads automatically on first use (CUDA / Vulkan / CPU — matched to your GPU).')}
                </div>
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="ob-step">
              <h1>{tx('Jak samodzielny ma być agent?', 'How autonomous should the agent be?')}</h1>
              <p className="lead">{tx('Możesz to zmienić w każdej chwili w polu wpisywania wiadomości.', 'You can change this any time in the message box.')}</p>
              <div className="col" style={{ gap: 8 }}>
                {[
                  { v: 'chill' as ApprovalMode, icon: Moon, t: tx('Chill — pełna autonomia (polecane)', 'Chill — full autonomy (recommended)'), d: tx('Agent robi wszystko sam: pisze, instaluje, uruchamia i testuje. Ty odpoczywasz. Pyta tylko przy groźnych komendach.', 'The agent does everything: writes, installs, runs and tests. You relax. Asks only for dangerous commands.') },
                  { v: 'auto-edits' as ApprovalMode, icon: ShieldCheck, t: tx('Auto-edycje', 'Auto-edit'), d: tx('Sam zmienia pliki, ale pyta przed uruchomieniem komend.', 'Edits files itself but asks before running commands.') },
                  { v: 'ask' as ApprovalMode, icon: ShieldAlert, t: tx('Pełna kontrola', 'Full control'), d: tx('Pyta o zgodę przy każdej zmianie i komendzie.', 'Asks before every change and command.') }
                ].map((o) => (
                  <button key={o.v} className={`choice ${approval === o.v ? 'on' : ''}`} style={{ flexDirection: 'row', alignItems: 'center', padding: '14px 16px' }} onClick={() => setApproval(o.v)}>
                    <o.icon size={20} />
                    <div className="col">
                      <span className="ch-t">{o.t}</span>
                      <span className="ch-d">{o.d}</span>
                    </div>
                    {approval === o.v && (
                      <span className="check">
                        <Check size={11} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 6 && (
            <div className="ob-step" style={{ textAlign: 'center' }}>
              <LogoTile size={96} animated />
              <h1 style={{ marginTop: 22 }}>{tx('Gotowe!', 'All set!')}</h1>
              <p className="lead" style={{ margin: '0 auto 26px' }}>
                {tx('Utworzę dla Ciebie „Default Project”. Opisz w czacie, co mam zbudować — a potem możesz się zrelaksować. 🌙', 'I will create a "Default Project" for you. Describe what to build in the chat — then you can relax. 🌙')}
              </p>
              <button className="btn primary lg" onClick={finish}>
                {tx('Otwórz Lunarix', 'Open Lunarix')} <ArrowRight size={16} />
              </button>
            </div>
          )}

          {step > 0 && step < 6 && (
            <div className="ob-foot">
              <div className="dots">
                {Array.from({ length: steps }, (_, i) => (
                  <i key={i} className={i + 1 === step ? 'on' : ''} />
                ))}
              </div>
              <button className="btn ghost" onClick={back}>
                <ArrowLeft size={14} /> {tx('Wstecz', 'Back')}
              </button>
              {step === 3 && !Object.values(keys).some((k) => k.trim()) ? (
                <button className="btn" onClick={next}>
                  {tx('Pomiń', 'Skip')} <ArrowRight size={14} />
                </button>
              ) : (
                <button className="btn primary" onClick={next} disabled={(step === 1 && !uses.length) || (step === 2 && !hw)}>
                  {tx('Dalej', 'Next')} <ArrowRight size={14} />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
