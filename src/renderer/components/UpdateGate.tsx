import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Download, ExternalLink, Power, RotateCw } from 'lucide-react';
import type { UpdateInfo } from '@shared/types';
import { api, on } from '../lib/api';
import { tx } from '../lib/i18n';
import { fmtBytes, fmtEta } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';
import { LogoTile } from './Logo';

/**
 * Full-window lock shown when GitHub has a newer Lunarix release.
 * The only ways out: install the update, or quit the app.
 */
export function UpdateGate() {
  const [u, setU] = useState<UpdateInfo | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.updateState().then(setU).catch(() => {});
    return on('update', (s: UpdateInfo) => setU(s));
  }, []);

  const active = !!u && u.state !== 'none';

  // nothing behind the lock may react to the keyboard (shortcuts, Escape closing things…)
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const inside = e.target instanceof Node && !!ref.current?.contains(e.target);
      if (inside && ['Tab', 'Enter', ' '].includes(e.key)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    (document.activeElement as HTMLElement | null)?.blur?.();
    setTimeout(() => ref.current?.querySelector<HTMLButtonElement>('.btn.primary')?.focus(), 50);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);

  const notes = useMemo(() => (u?.notes?.trim() ? renderMarkdown(u.notes) : ''), [u?.notes]);

  if (!u || !active) return null;

  const busy = u.state === 'downloading' || u.state === 'installing';
  const total = u.size || 0;
  const pct = total ? Math.min(100, Math.round(((u.received || 0) / total) * 100)) : 0;
  const date = u.publishedAt ? new Date(u.publishedAt) : null;

  const onNotesClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (a?.href) {
      e.preventDefault();
      api.openExternal(a.href);
    }
  };

  return (
    <div className="update-gate" ref={ref} role="dialog" aria-modal="true" aria-labelledby="ug-title">
      <div className="ug-drag" />
      <div className="ug-card">
        <div className="ug-top">
          <LogoTile size={56} animated={busy} />
          <div>
            <div className="ug-kicker">{tx('Wymagana aktualizacja', 'Update required')}</div>
            <h2 id="ug-title">{u.title || `Lunarix ${u.latest}`}</h2>
          </div>
        </div>

        <div className="ug-versions">
          <span className="ug-ver old">v{u.current}</span>
          <ArrowRight size={15} />
          <span className="ug-ver new">v{u.latest}</span>
          {date && !isNaN(+date) && <span className="ug-date">{date.toLocaleDateString(tx('pl-PL', 'en-US'), { day: 'numeric', month: 'long', year: 'numeric' })}</span>}
        </div>

        <p className="ug-lead">
          {tx(
            'Wyszła nowa wersja Lunarix. Ta wersja przestała być wspierana, więc żeby dalej korzystać z aplikacji, zaktualizuj ją. Czaty, projekty, klucze API i pobrane modele zostają na miejscu.',
            'A new version of Lunarix is out. This version is no longer supported, so update to keep using the app. Your chats, projects, API keys and downloaded models stay where they are.'
          )}
        </p>

        {notes && (
          <div className="ug-notes">
            <div className="ug-notes-head">{tx('Co nowego', "What's new")}</div>
            <div className="md" onClick={onNotesClick} dangerouslySetInnerHTML={{ __html: notes }} />
          </div>
        )}

        {u.state === 'downloading' && (
          <div className="ug-progress">
            <div className="ug-bar">
              <i style={{ width: `${u.verifying ? 100 : pct}%` }} />
            </div>
            <div className="ug-progress-text">
              {u.verifying ? (
                tx('Sprawdzam sumę kontrolną…', 'Verifying the checksum…')
              ) : (
                <>
                  <span>
                    {tx('Pobieranie', 'Downloading')} {pct}% · {fmtBytes(u.received || 0)}
                    {total ? ` / ${fmtBytes(total)}` : ''}
                  </span>
                  {!!u.speed && (
                    <span className="faint">
                      {fmtBytes(u.speed)}/s{total ? ` · ${fmtEta(Math.max(0, (total - (u.received || 0)) / u.speed))}` : ''}
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {u.state === 'installing' && (
          <div className="ug-progress">
            <div className="ug-bar indeterminate">
              <i />
            </div>
            <div className="ug-progress-text">{tx('Instaluję… Lunarix zamknie się na chwilę i sam uruchomi ponownie.', 'Installing… Lunarix will close for a moment and start again by itself.')}</div>
          </div>
        )}

        {u.state === 'error' && (
          <div className="ug-error">
            {tx('Nie udało się pobrać aktualizacji', 'Could not download the update')}: {u.error}
          </div>
        )}

        <div className="ug-actions">
          <button className="btn lg ghost" onClick={() => api.quitApp()} disabled={u.state === 'installing'}>
            <Power size={15} /> {tx('Zamknij aplikację', 'Quit app')}
          </button>
          <div className="grow" />
          {u.state === 'error' && u.pageUrl && (
            <button className="btn lg outline" onClick={() => api.openExternal(u.pageUrl!)}>
              <ExternalLink size={15} /> {tx('Pobierz ręcznie', 'Download manually')}
            </button>
          )}
          <button className="btn lg primary" onClick={() => api.installUpdate()} disabled={busy}>
            {u.state === 'error' ? <RotateCw size={15} /> : <Download size={15} />}
            {u.state === 'error'
              ? tx('Spróbuj ponownie', 'Try again')
              : busy
                ? tx('Aktualizuję…', 'Updating…')
                : `${tx('Aktualizuj', 'Update')}${total ? ` (${fmtBytes(total)})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}
