import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, Check, Download, Eye, KeyRound, RefreshCw, Cpu, Sparkles, Loader2, Gift } from 'lucide-react';
import type { ModelInfo, ModelRef } from '@shared/types';
import { LOCAL_TIERS } from '@shared/catalog';
import { useApp } from '../store/app';
import { api } from '../lib/api';
import { tx } from '../lib/i18n';
import { fmtTokens } from '../lib/format';
import { providerMeta } from '@shared/catalog';

const RATING: Record<string, [string, string]> = {
  great: ['świetnie', 'great'],
  good: ['dobrze', 'good'],
  slow: ['wolno', 'slow'],
  unsupported: ['za słaby PC', 'too heavy']
};

export function TierBars({ level }: { level: number }) {
  return (
    <span className="tier-bars">
      {[1, 2, 3, 4, 5].map((i) => (
        <i key={i} className={i <= level ? 'on' : ''} style={{ height: 3 + i * 2 }} />
      ))}
    </span>
  );
}

export function ModelPicker({ anchor, current, onSelect, onClose }: { anchor: HTMLElement; current: ModelRef; onSelect: (m: ModelRef) => void; onClose: () => void }) {
  const models = useApp((s) => s.models);
  const settings = useApp((s) => s.settings!);
  const local = useApp((s) => s.localModels);
  const hardware = useApp((s) => s.hardware);
  const downloads = useApp((s) => s.downloads);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const [refreshing, setRefreshing] = useState(false);

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const h = ref.current?.offsetHeight || 480;
    let top = r.top - h - 6;
    if (top < 44) top = Math.min(window.innerHeight - h - 8, r.bottom + 6);
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 390)), top });
  }, [anchor, models.length]);

  useEffect(() => {
    if (!hardware) api.hardware().then((h) => useApp.setState({ hardware: h }));
    const down = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', down, true);
    return () => window.removeEventListener('mousedown', down, true);
  }, [anchor, onClose, hardware]);

  const items = useMemo(() => {
    const ql = q.toLowerCase().trim();
    const match = (m: ModelInfo) => !ql || m.name.toLowerCase().includes(ql) || m.id.toLowerCase().includes(ql) || m.provider.includes(ql);
    const out: { group?: string; m?: ModelInfo }[] = [];
    const localModels = models.filter((m) => m.provider === 'local' && match(m));
    if (localModels.length) {
      out.push({ group: tx('Lokalne · bez limitów · darmowe', 'Local · unlimited · free') });
      for (const m of localModels) out.push({ m });
    }
    const recent = settings.recentModels
      .filter((r) => r.provider !== 'local')
      .map((r) => models.find((m) => m.provider === r.provider && m.id === r.model))
      .filter((m): m is ModelInfo => !!m && match(m));
    if (recent.length && !ql) {
      out.push({ group: tx('Ostatnio używane', 'Recent') });
      for (const m of recent.slice(0, 4)) out.push({ m });
    }
    const byProv = new Map<string, ModelInfo[]>();
    for (const m of models) {
      if (m.provider === 'local' || !match(m)) continue;
      if (!byProv.has(m.provider)) byProv.set(m.provider, []);
      byProv.get(m.provider)!.push(m);
    }
    for (const [prov, list] of byProv) {
      out.push({ group: providerMeta(prov as any)?.name || prov });
      const sorted = [...list].sort((a, b) => Number(!!b.free) - Number(!!a.free) || a.name.localeCompare(b.name));
      for (const m of sorted.slice(0, ql ? 200 : 60)) out.push({ m });
    }
    return out;
  }, [models, q, settings.recentModels]);

  const selectable = items.filter((i) => i.m);
  useEffect(() => setHi(0), [q]);

  const choose = (m: ModelInfo) => {
    onSelect({ provider: m.provider, model: m.id });
    onClose();
  };

  return (
    <div className="model-picker" ref={ref} style={pos}>
      <div className="mp-search">
        <Search size={14} className="faint" />
        <input
          autoFocus
          placeholder={tx('Szukaj modelu…', 'Search models…')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHi((h) => Math.min(selectable.length - 1, h + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHi((h) => Math.max(0, h - 1));
            } else if (e.key === 'Enter' && selectable[hi]?.m) choose(selectable[hi].m!);
            else if (e.key === 'Escape') onClose();
          }}
        />
      </div>
      <div className="mp-list">
        {items.map((it, idx) => {
          if (it.group)
            return (
              <div key={'g' + idx} className="mp-group">
                {it.group.startsWith('Lokal') || it.group.startsWith('Local') ? <Cpu size={11} /> : <Sparkles size={11} />}
                {it.group}
              </div>
            );
          const m = it.m!;
          const sIdx = selectable.indexOf(it);
          const isCur = current.provider === m.provider && current.model === m.id;
          if (m.provider === 'local') {
            const tier = LOCAL_TIERS.find((t) => t.id === m.id)!;
            const st = local.find((l) => l.tier === m.id);
            const rating = hardware?.ratings?.[tier.id];
            const dl = downloads[`model-${tier.id}`];
            const level = LOCAL_TIERS.indexOf(tier) + 1;
            return (
              <div key={m.provider + m.id} className={`mp-item ${sIdx === hi ? 'hi' : ''}`} onMouseEnter={() => setHi(sIdx)} onClick={() => choose(m)}>
                <TierBars level={level} />
                <div className="col grow" style={{ minWidth: 0 }}>
                  <span className="mn">
                    {m.name} {hardware?.recommended === tier.id && <span className="badge solid" style={{ marginLeft: 4 }}>{tx('polecany', 'recommended')}</span>}
                  </span>
                  <span className="md2">
                    {tier.model} · {tier.sizeGB.toFixed(1)} GB{rating ? ` · ${tx(RATING[rating.rating][0], RATING[rating.rating][1])}${rating.speed !== '—' ? ' ' + rating.speed : ''}` : ''}
                  </span>
                </div>
                {dl && dl.state === 'running' ? (
                  <span className="faint" style={{ fontSize: 11 }}>
                    {Math.round((dl.received / Math.max(1, dl.total)) * 100)}%
                  </span>
                ) : st?.downloaded ? null : (
                  <button
                    className="icon-btn sm"
                    data-tip={tx('Pobierz', 'Download')}
                    onClick={(e) => {
                      e.stopPropagation();
                      api.downloadTier(tier.id);
                      useApp.getState().toast(tx(`Pobieranie Lunarix ${tier.name} (${tier.sizeGB.toFixed(1)} GB)…`, `Downloading Lunarix ${tier.name} (${tier.sizeGB.toFixed(1)} GB)…`));
                    }}
                  >
                    <Download size={13} />
                  </button>
                )}
                {isCur && <Check size={14} />}
              </div>
            );
          }
          return (
            <div key={m.provider + m.id} className={`mp-item ${sIdx === hi ? 'hi' : ''}`} onMouseEnter={() => setHi(sIdx)} onClick={() => choose(m)}>
              <div className="col grow" style={{ minWidth: 0 }}>
                <span className="mn">{m.name}</span>
                <span className="md2">
                  {m.id}
                  {m.contextWindow ? ` · ${fmtTokens(m.contextWindow)} ctx` : ''}
                  {m.pricing && (m.pricing.input || m.pricing.output) ? ` · $${m.pricing.input}/$${m.pricing.output}` : ''}
                </span>
              </div>
              {m.free && (
                <span className="badge" title="free">
                  <Gift size={10} /> free
                </span>
              )}
              {m.vision && <Eye size={13} className="faint" />}
              {isCur && <Check size={14} />}
            </div>
          );
        })}
        {models.filter((m) => m.provider !== 'local').length === 0 && (
          <div className="hint" style={{ padding: '8px 10px' }}>
            {tx('Dodaj klucz API (Anthropic, OpenAI, Google, Grok, Groq, OpenRouter, Cloudflare), aby korzystać z modeli w chmurze.', 'Add an API key (Anthropic, OpenAI, Google, Grok, Groq, OpenRouter, Cloudflare) to use cloud models.')}
          </div>
        )}
      </div>
      <div className="mp-foot">
        <button
          className="btn sm ghost grow"
          onClick={() => {
            onClose();
            useApp.getState().setModal('settings', 'providers');
          }}
        >
          <KeyRound size={13} /> {tx('Klucze API', 'API keys')}
        </button>
        <button
          className="btn sm ghost grow"
          onClick={() => {
            onClose();
            useApp.getState().setModal('settings', 'local');
          }}
        >
          <Cpu size={13} /> {tx('Modele lokalne', 'Local models')}
        </button>
        <button
          className="icon-btn"
          data-tip={tx('Odśwież listy modeli', 'Refresh model lists')}
          onClick={async () => {
            setRefreshing(true);
            const provs = useApp.getState().providers.filter((p) => p.hasKey);
            await Promise.allSettled(provs.map((p) => api.fetchModels(p.id)));
            await useApp.getState().refreshProviders();
            setRefreshing(false);
          }}
        >
          {refreshing ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
        </button>
      </div>
    </div>
  );
}
