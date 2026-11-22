import path from 'node:path';
import type { ModelInfo, ProviderId, TokenUsage, UsageCell, UsageDay, UsageSummary } from '@shared/types';
import { paths } from './paths';
import { JsonStore, throttle } from './util';
import { emit } from './events';
import { priceFor } from './providers/models';

interface UsageData {
  days: Record<string, Record<string, UsageCell>>;
}

let store: JsonStore<UsageData>;
function data() {
  if (!store) store = new JsonStore<UsageData>(path.join(paths.data, 'usage.json'), { days: {} });
  return store.data;
}

function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export function costOf(provider: ProviderId, model: string, u: TokenUsage, info?: ModelInfo): number {
  if (typeof u.cost === 'number') return u.cost;
  if (provider === 'local' || provider === 'mock' || provider === 'ollama' || provider === 'lmstudio') return 0;
  const p: any = priceFor(provider, model, info);
  if (!p) return 0;
  const cacheRead = u.cacheRead || 0;
  const cacheWrite = u.cacheWrite || 0;
  const plainIn = Math.max(0, u.input - cacheRead - cacheWrite);
  const readPrice = p.cacheRead ?? p.input * 0.1;
  return (plainIn * p.input + cacheRead * readPrice + cacheWrite * p.input * 1.25 + u.output * p.output) / 1e6;
}

const publish = throttle(() => emit('usage', usageSummary()), 1500);

export function recordUsage(provider: ProviderId, model: string, u: TokenUsage, info?: ModelInfo): number {
  if (!u || (!u.input && !u.output)) return 0;
  const d = data();
  const key = dayKey();
  const day = (d.days[key] ||= {});
  const id = `${provider}|${model}`;
  const cell = (day[id] ||= { provider, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, cost: 0, estimated: false });
  const cost = costOf(provider, model, u, info);
  cell.input += u.input || 0;
  cell.output += u.output || 0;
  cell.cacheRead += u.cacheRead || 0;
  cell.cacheWrite += u.cacheWrite || 0;
  cell.requests += 1;
  cell.cost += cost;
  if (u.estimated) cell.estimated = true;
  store.save();
  publish();
  return cost;
}

function sum(days: UsageDay[]) {
  const t = { input: 0, output: 0, cost: 0, requests: 0 };
  for (const d of days)
    for (const c of Object.values(d.models)) {
      t.input += c.input;
      t.output += c.output;
      t.cost += c.cost;
      t.requests += c.requests;
    }
  return t;
}

export function usageSummary(): UsageSummary {
  const d = data();
  const days: UsageDay[] = Object.keys(d.days)
    .sort()
    .map((date) => ({ date, models: d.days[date] }));
  const now = new Date();
  const today = dayKey(now);
  const weekAgo = dayKey(new Date(now.getTime() - 6 * 86400000));
  const monthAgo = dayKey(new Date(now.getTime() - 29 * 86400000));
  return {
    days: days.slice(-90),
    today: sum(days.filter((x) => x.date === today)),
    week: sum(days.filter((x) => x.date >= weekAgo)),
    month: sum(days.filter((x) => x.date >= monthAgo)),
    allTime: sum(days)
  };
}

export function resetUsage() {
  data().days = {};
  store.save();
  emit('usage', usageSummary());
}

export function flushUsage() {
  store?.flush();
}
