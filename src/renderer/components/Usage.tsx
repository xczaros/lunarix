import { useEffect, useMemo, useState } from 'react';
import { BarChart3, X, Trash2, Cpu, Cloud } from 'lucide-react';
import { useApp } from '../store/app';
import { api } from '../lib/api';
import { tx, getLang } from '../lib/i18n';
import { fmtCost, fmtNum, fmtTokens } from '../lib/format';
import { providerMeta } from '@shared/catalog';
import { confirmDialog } from './ui';

export function UsageModal() {
  const usage = useApp((s) => s.usage);
  const close = () => useApp.getState().setModal(null);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    api.usage().then((u) => useApp.setState({ usage: u }));
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const days = useMemo(() => {
    const out: { date: string; input: number; output: number; cost: number }[] = [];
    const map = new Map((usage?.days || []).map((d) => [d.date, d]));
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const day = map.get(key);
      let input = 0;
      let output = 0;
      let cost = 0;
      if (day) for (const c of Object.values(day.models)) {
        input += c.input;
        output += c.output;
        cost += c.cost;
      }
      out.push({ date: key, input, output, cost });
    }
    return out;
  }, [usage]);

  const perModel = useMemo(() => {
    const m = new Map<string, { provider: string; model: string; input: number; output: number; cacheRead: number; requests: number; cost: number; estimated: boolean }>();
    for (const d of usage?.days || [])
      for (const c of Object.values(d.models)) {
        const k = `${c.provider}|${c.model}`;
        const e = m.get(k) || { provider: c.provider, model: c.model, input: 0, output: 0, cacheRead: 0, requests: 0, cost: 0, estimated: false };
        e.input += c.input;
        e.output += c.output;
        e.cacheRead += c.cacheRead;
        e.requests += c.requests;
        e.cost += c.cost;
        e.estimated ||= c.estimated;
        m.set(k, e);
      }
    return [...m.values()].sort((a, b) => b.input + b.output - (a.input + a.output));
  }, [usage]);

  const max = Math.max(1, ...days.map((d) => d.input + d.output));
  const W = 900;
  const H = 170;
  const bw = W / days.length;
  const hd = hover !== null ? days[hover] : null;

  const Stat = ({ label, v }: { label: string; v?: { input: number; output: number; cost: number; requests: number } }) => (
    <div className="stat">
      <div className="sl">{label}</div>
      <div className="sv">{fmtTokens((v?.input || 0) + (v?.output || 0))}</div>
      <div className="ss">
        {fmtTokens(v?.input)} ↑ · {fmtTokens(v?.output)} ↓ · {v?.requests || 0} {tx('zapytań', 'requests')}
        {v && v.cost > 0 ? ` · ${fmtCost(v.cost)}` : ''}
      </div>
    </div>
  );

  return (
    <div className="backdrop center" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal usage-page">
        <div className="modal-head">
          <BarChart3 size={17} /> {tx('Zużycie tokenów', 'Token usage')}
          <div className="grow" />
          <button
            className="btn sm ghost"
            onClick={async () => {
              if (await confirmDialog(tx('Wyzerować statystyki?', 'Reset statistics?'), tx('Historia zużycia zostanie usunięta.', 'Usage history will be deleted.'), tx('Wyzeruj', 'Reset'), true)) {
                await api.resetUsage();
                useApp.setState({ usage: await api.usage() });
              }
            }}
          >
            <Trash2 size={13} /> {tx('Wyzeruj', 'Reset')}
          </button>
          <button className="icon-btn" onClick={close}>
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <div className="stat-grid">
            <Stat label={tx('Dziś', 'Today')} v={usage?.today} />
            <Stat label={tx('7 dni', '7 days')} v={usage?.week} />
            <Stat label={tx('30 dni', '30 days')} v={usage?.month} />
            <Stat label={tx('Łącznie', 'All time')} v={usage?.allTime} />
          </div>
          <div className="card" style={{ padding: '14px 14px 6px', marginBottom: 18, position: 'relative' }}>
            <div className="row" style={{ marginBottom: 6, fontSize: 12 }}>
              <b>{tx('Ostatnie 30 dni', 'Last 30 days')}</b>
              <span className="faint">
                <span style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--fg-2)', borderRadius: 2, marginRight: 4 }} />
                {tx('wyjście', 'output')}
                <span style={{ display: 'inline-block', width: 9, height: 9, background: 'var(--fg-4)', borderRadius: 2, margin: '0 4px 0 10px' }} />
                {tx('wejście', 'input')}
              </span>
              <div className="grow" />
              {hd && (
                <span className="faint">
                  {new Date(hd.date).toLocaleDateString(getLang() === 'pl' ? 'pl-PL' : 'en-US', { day: 'numeric', month: 'short' })}: {fmtNum(hd.input)} ↑ · {fmtNum(hd.output)} ↓{hd.cost ? ` · ${fmtCost(hd.cost)}` : ''}
                </span>
              )}
            </div>
            <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} onMouseLeave={() => setHover(null)}>
              {[0.25, 0.5, 0.75, 1].map((f) => (
                <line key={f} x1={0} x2={W} y1={H - H * f} y2={H - H * f} style={{ stroke: 'var(--line)' }} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              ))}
              {days.map((d, i) => {
                const hi = ((d.input + d.output) / max) * (H - 6);
                const ho = (d.output / max) * (H - 6);
                return (
                  <g key={d.date} onMouseEnter={() => setHover(i)}>
                    <rect x={i * bw} y={0} width={bw} height={H} fill="transparent" />
                    <rect className="bar in" x={i * bw + bw * 0.18} y={H - hi} width={bw * 0.64} height={Math.max(0, hi - ho)} rx={2} />
                    <rect className="bar" x={i * bw + bw * 0.18} y={H - ho} width={bw * 0.64} height={ho} rx={2} style={{ opacity: hover === null || hover === i ? 1 : 0.5 }} />
                  </g>
                );
              })}
            </svg>
            <div style={{ position: 'relative', height: 18, fontSize: 10.5, color: 'var(--fg-3)' }}>
              {days.map((d, i) =>
                i % 5 === 0 || i === days.length - 1 ? (
                  <span key={d.date} style={{ position: 'absolute', left: `${((i + 0.5) / days.length) * 100}%`, transform: 'translateX(-50%)', top: 4 }}>
                    {d.date.slice(8)}.{d.date.slice(5, 7)}
                  </span>
                ) : null
              )}
            </div>
          </div>
          <table className="utable">
            <thead>
              <tr>
                <th>{tx('Model', 'Model')}</th>
                <th className="num">{tx('Zapytania', 'Requests')}</th>
                <th className="num">{tx('Wejście', 'Input')}</th>
                <th className="num">{tx('w tym cache', 'cached')}</th>
                <th className="num">{tx('Wyjście', 'Output')}</th>
                <th className="num">{tx('Koszt', 'Cost')}</th>
              </tr>
            </thead>
            <tbody>
              {perModel.map((m) => (
                <tr key={m.provider + m.model}>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      {m.provider === 'local' ? <Cpu size={13} /> : <Cloud size={13} />}
                      <span>{m.model}</span>
                      <span className="faint" style={{ fontSize: 11 }}>
                        {m.provider === 'local' ? tx('lokalny · bez limitów', 'local · unlimited') : providerMeta(m.provider as any)?.short || m.provider}
                      </span>
                    </span>
                  </td>
                  <td className="num">{fmtNum(m.requests)}</td>
                  <td className="num">
                    {m.estimated ? '~' : ''}
                    {fmtNum(m.input)}
                  </td>
                  <td className="num faint">{m.cacheRead ? fmtNum(m.cacheRead) : '—'}</td>
                  <td className="num">{fmtNum(m.output)}</td>
                  <td className="num">{m.provider === 'local' ? tx('darmowe', 'free') : m.cost ? fmtCost(m.cost) : '—'}</td>
                </tr>
              ))}
              {!perModel.length && (
                <tr>
                  <td colSpan={6} className="faint" style={{ textAlign: 'center', padding: 30 }}>
                    {tx('Brak danych — zużycie pojawi się po pierwszej rozmowie z agentem.', 'No data yet — usage appears after your first agent chat.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="hint" style={{ marginTop: 12 }}>
            {tx('Koszty są szacunkowe (na podstawie cenników dostawców; dokładne dla OpenRouter i Anthropic). „~” oznacza tokeny oszacowane, gdy dostawca ich nie zwrócił. Modele lokalne są zawsze darmowe i bez limitów.', 'Costs are estimates (from provider price lists; exact for OpenRouter and Anthropic). "~" means tokens were estimated because the provider did not report them. Local models are always free and unlimited.')}
          </div>
        </div>
      </div>
    </div>
  );
}
