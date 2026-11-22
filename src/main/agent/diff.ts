import type { DiffLine } from '@shared/types';

/** Myers diff on lines. Returns edit script as DiffLine[] (' ', '+', '-'). */
export function diffLines(a: string[], b: string[], maxD = 4000): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const limit = Math.min(max, maxD);
  const v = new Map<number, number>();
  v.set(1, 0);
  const trace: Map<number, number>[] = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) x = v.get(k + 1) ?? 0;
      else x = (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) {
        return backtrack(trace, a, b, d);
      }
    }
  }
  return null;
}

function backtrack(trace: Map<number, number>[], a: string[], b: string[], dEnd: number): DiffLine[] {
  const out: DiffLine[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dEnd; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))) prevK = k + 1;
    else prevK = k - 1;
    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ t: ' ', s: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ t: '+', s: b[y - 1] });
      else out.push({ t: '-', s: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return out.reverse();
}

export interface DiffSummary {
  added: number;
  removed: number;
  preview: DiffLine[];
}

/** Computes +/- counts and a compact preview (changed hunks with context). */
export function summarizeDiff(before: string | null, after: string, maxPreview = 160): DiffSummary {
  const a = before === null ? [] : before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  if (before === null) {
    return { added: b.length, removed: 0, preview: b.slice(0, maxPreview).map((s) => ({ t: '+', s })) };
  }
  const d = a.length + b.length > 12000 ? null : diffLines(a, b);
  if (!d) {
    // too large – rough estimate
    const setA = new Set(a);
    const setB = new Set(b);
    const added = b.filter((l) => !setA.has(l)).length;
    const removed = a.filter((l) => !setB.has(l)).length;
    return { added, removed, preview: [] };
  }
  let added = 0;
  let removed = 0;
  for (const l of d) {
    if (l.t === '+') added++;
    else if (l.t === '-') removed++;
  }
  const keep = new Array(d.length).fill(false);
  d.forEach((l, i) => {
    if (l.t !== ' ') for (let j = Math.max(0, i - 2); j <= Math.min(d.length - 1, i + 2); j++) keep[j] = true;
  });
  const preview: DiffLine[] = [];
  let skipping = false;
  for (let i = 0; i < d.length && preview.length < maxPreview; i++) {
    if (keep[i]) {
      preview.push({ t: d[i].t, s: d[i].s.length > 300 ? d[i].s.slice(0, 300) + '…' : d[i].s });
      skipping = false;
    } else if (!skipping) {
      preview.push({ t: '~', s: '' });
      skipping = true;
    }
  }
  if (preview.length && preview[0].t === '~') preview.shift();
  if (preview.length && preview[preview.length - 1].t === '~') preview.pop();
  return { added, removed, preview };
}
