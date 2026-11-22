import { getLang, tx } from './i18n';

export function fmtTokens(n?: number) {
  if (!n || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 'k';
  if (n < 1_000_000_000) return (n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1) + 'M';
  return (n / 1e9).toFixed(2) + 'B';
}

export function fmtNum(n?: number) {
  return (n || 0).toLocaleString(getLang() === 'pl' ? 'pl-PL' : 'en-US');
}

export function fmtCost(c?: number) {
  if (!c) return '$0';
  if (c < 0.01) return '<$0.01';
  return '$' + c.toFixed(c < 10 ? 2 : 1);
}

export function fmtBytes(n?: number) {
  if (!n || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
}

export function fmtDuration(ms?: number) {
  if (!ms || ms < 0) return '0s';
  const s = ms / 1000;
  if (s < 10) return s.toFixed(1) + 's';
  if (s < 60) return Math.round(s) + 's';
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  if (m < 60) return `${m}m ${r}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtEta(sec: number) {
  if (!isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function timeAgo(ts: number) {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return tx('teraz', 'now');
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const days = Math.floor(h / 24);
  if (days < 7) return tx(`${days} d`, `${days}d`);
  return new Date(ts).toLocaleDateString(getLang() === 'pl' ? 'pl-PL' : 'en-US', { day: 'numeric', month: 'short' });
}

export function basename(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

export function dirname(p: string) {
  const parts = p.split(/[\\/]/);
  parts.pop();
  return parts.join('\\');
}

export function relPath(p: string, root?: string) {
  if (!root) return p;
  const a = p.replace(/\//g, '\\');
  const r = root.replace(/\//g, '\\').replace(/\\+$/, '');
  if (a.toLowerCase().startsWith(r.toLowerCase() + '\\')) return a.slice(r.length + 1).replace(/\\/g, '/');
  if (a.toLowerCase() === r.toLowerCase()) return '.';
  return p;
}

export function joinPath(...parts: string[]) {
  return parts
    .filter(Boolean)
    .join('\\')
    .replace(/[\\/]+/g, '\\');
}
