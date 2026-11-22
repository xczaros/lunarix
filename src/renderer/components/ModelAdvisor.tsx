import { useEffect } from 'react';
import { Gauge, X, Zap } from 'lucide-react';
import type { Chat, LocalTierId } from '@shared/types';
import { tierById } from '@shared/catalog';
import { useApp } from '../store/app';
import { api } from '../lib/api';
import { tx } from '../lib/i18n';

/**
 * Suggests a faster local model when the one in use runs slowly on this PC
 * (measured from real runs, or estimated before the first runs). One click downloads it
 * if needed and switches automatically when it is ready.
 */
export function ModelAdvisor({ chat }: { chat: Chat | null }) {
  const settings = useApp((s) => s.settings!);
  const hw = useApp((s) => s.hardware);
  const local = useApp((s) => s.localModels);
  const downloads = useApp((s) => s.downloads);
  const ref = chat?.model || settings.activeModel;
  const isLocal = ref.provider === 'local';

  useEffect(() => {
    if (isLocal && !hw) api.hardware().then((h) => useApp.setState({ hardware: h }));
  }, [isLocal, hw]);

  if (!isLocal || !hw) return null;
  const cur = ref.model as LocalTierId;
  const rec = hw.recommended;
  const rc = hw.ratings?.[cur];
  const rr = hw.ratings?.[rec];
  if (!rc || !rr || rec === cur) return null;
  if (rc.rating !== 'slow' && rc.rating !== 'unsupported') return null;
  if (rr.rating !== 'great' && rr.rating !== 'good') return null;
  const key = `${cur}>${rec}`;
  if (settings.ui.dismissed?.includes(key)) return null;

  const from = tierById(cur);
  const to = tierById(rec);
  const st = local.find((l) => l.tier === rec);
  const needDl = !st?.downloaded;
  const dl = downloads[`model-${rec}`] || downloads[`mmproj-${rec}`];
  const busy = dl?.state === 'running';
  const factor = rc.tps && rr.tps ? Math.round(rr.tps / rc.tps) : 0;
  const dismiss = () => useApp.getState().patchSettings({ ui: { ...settings.ui, dismissed: [...(settings.ui.dismissed || []), key] } });
  const go = () =>
    api.switchTier(rec, chat?.id).catch((e) => useApp.getState().toast(String(e?.message || e), 'error'));

  return (
    <div className="advisor">
      <Gauge size={15} className="adv-icon" />
      <div className="grow adv-text">
        <b>Lunarix {from.name}</b> {tx('działa na tym komputerze wolno', 'runs slowly on this PC')} ({rc.speed}).{' '}
        <b>Lunarix {to.name}</b> {tx('będzie', 'will be')}{' '}
        {factor >= 2 ? tx(`ok. ${factor}× szybszy`, `about ${factor}× faster`) : tx('szybszy', 'faster')}.
      </div>
      {busy ? (
        <span className="faint adv-progress">
          {dl.verifying ? tx('sprawdzanie…', 'verifying…') : `${Math.round((dl.received / Math.max(1, dl.total)) * 100)}%`}
        </span>
      ) : (
        <button className="btn sm primary" onClick={go}>
          <Zap size={12} />
          {needDl ? tx(`Pobierz i przełącz (${(to.sizeGB + to.mmprojGB).toFixed(1)} GB)`, `Download & switch (${(to.sizeGB + to.mmprojGB).toFixed(1)} GB)`) : tx(`Przełącz na ${to.name}`, `Switch to ${to.name}`)}
        </button>
      )}
      <button className="icon-btn sm" data-tip={tx('Nie pokazuj więcej', "Don't show again")} onClick={dismiss}>
        <X size={13} />
      </button>
    </div>
  );
}
