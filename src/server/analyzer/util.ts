// Small helpers shared by the analyzers.
import type { ObjRef, Severity } from '../../shared/types.js';
import type { AnyObj, EventObj } from '../k8s.js';

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export type TimeLike = string | number | null | undefined;

export function ts(t: TimeLike): number {
  if (!t) return NaN;
  return typeof t === 'number' ? t : Date.parse(t);
}

export function ageMs(t: TimeLike, now = Date.now()): number | null {
  const v = ts(t);
  return Number.isNaN(v) ? null : now - v;
}

export function fmtAge(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return '?';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? `${h % 24}h` : ''}`;
}

const BIN: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DEC: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

// Parses a Kubernetes resource.Quantity ("250m", "512Mi", "1.5Gi", "2", "1e3").
export function parseQuantity(q: string | number | null | undefined): number | null {
  if (q == null || q === '') return null;
  if (typeof q === 'number') return q;
  const m = String(q).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]{0,2})$/);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  const unit = m[2]!;
  if (unit in BIN) return n * BIN[unit]!;
  if (unit in DEC) return n * DEC[unit]!;
  return null;
}

// JVM / Node style sizes: "512m", "2g", "1024k", "2048" (bytes).
export function parseJavaSize(s: string | null | undefined): number | null {
  const m = String(s || '').match(/^(\d+(?:\.\d+)?)([kKmMgGtT]?)$/);
  if (!m) return null;
  const mult = ({ '': 1, k: 2 ** 10, m: 2 ** 20, g: 2 ** 30, t: 2 ** 40 } as Record<string, number>)[m[2]!.toLowerCase()]!;
  return parseFloat(m[1]!) * mult;
}

export function fmtBytes(b: number | null | undefined): string {
  if (b == null || Number.isNaN(b)) return '—';
  const units = ['B', 'Ki', 'Mi', 'Gi', 'Ti', 'Pi'];
  let i = 0;
  let v = b;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}${units[i]}`;
}

export function fmtCpu(c: number | null | undefined): string {
  if (c == null || Number.isNaN(c)) return '—';
  if (c < 1) return `${Math.round(c * 1000)}m`;
  return `${+c.toFixed(2)}`;
}

export function pct(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a == null || !b) return null;
  return Math.round((a / b) * 100);
}

export const objKey = (kind: string | undefined, namespace: string | null | undefined, name: string | undefined): string => `${kind}/${namespace || ''}/${name}`;
export const refKey = (r: ObjRef): string => objKey(r.kind, r.namespace, r.name);

export function objRef(obj: AnyObj, kind?: string): ObjRef {
  return { kind: kind || obj.kind, namespace: obj.metadata?.namespace || '', name: obj.metadata?.name };
}

export function fmtRef(r: ObjRef | null | undefined): string {
  if (!r) return '';
  return r.namespace ? `${r.kind} ${r.namespace}/${r.name}` : `${r.kind} ${r.name}`;
}

type Labels = { [key: string]: string };

// Service-style selector (plain map).
export function matchLabels(selector: Labels | null | undefined, labels: Labels | undefined = {}): boolean {
  if (!selector) return false;
  const entries = Object.entries(selector);
  if (!entries.length) return false;
  return entries.every(([k, v]) => labels[k] === v);
}

export interface LabelSelector {
  matchLabels?: Labels;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
}

// metav1.LabelSelector with matchLabels + matchExpressions.
export function matchSelector(sel: LabelSelector | null | undefined, labels: Labels | undefined = {}): boolean {
  if (!sel) return false;
  const ml = sel.matchLabels || {};
  labels ||= {};
  for (const [k, v] of Object.entries(ml)) if (labels[k] !== v) return false;
  for (const e of sel.matchExpressions || []) {
    const has = Object.prototype.hasOwnProperty.call(labels, e.key);
    const val = labels[e.key]!;
    const values = e.values || [];
    switch (e.operator) {
      case 'In': if (!has || !values.includes(val)) return false; break;
      case 'NotIn': if (has && values.includes(val)) return false; break;
      case 'Exists': if (!has) return false; break;
      case 'DoesNotExist': if (has) return false; break;
      default: return false;
    }
  }
  return Object.keys(ml).length > 0 || (sel.matchExpressions || []).length > 0;
}

export function eventTime(ev: EventObj): number {
  return ts(ev.series?.lastObservedTime || ev.lastTimestamp || ev.eventTime || ev.firstTimestamp || ev.metadata?.creationTimestamp);
}

export function eventFirstTime(ev: EventObj): number {
  return ts(ev.firstTimestamp || ev.eventTime || ev.metadata?.creationTimestamp);
}

export function eventCount(ev: EventObj): number {
  return ev.series?.count || ev.count || 1;
}

// "spec.containers{api}" -> "api"
export function eventContainer(ev: EventObj): string | null {
  const m = (ev.involvedObject?.fieldPath || '').match(/\{([^}]+)\}/);
  return m ? m[1]! : null;
}

export function truncate(s: string | null | undefined, n = 400): string {
  if (!s) return s ?? '';
  const str = String(s);
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

export function uniq<T>(arr: (T | null | undefined | '')[]): T[] {
  return [...new Set(arr.filter((x): x is T => x != null && x !== ''))];
}

export interface ConditionLike {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export function cond<C extends ConditionLike>(obj: { status?: { conditions?: C[] } } | null | undefined, type: string): C | undefined {
  return (obj?.status?.conditions || []).find((c) => c.type === type);
}

export const SEVERITY_RANK: Record<Severity, number> = { critical: 3, warning: 2, info: 1 };

export function maxSeverity(list: Severity[]): Severity {
  let best: Severity = 'info';
  for (const s of list) if ((SEVERITY_RANK[s] || 0) > SEVERITY_RANK[best]) best = s;
  return best;
}

export type Settled<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

export async function mapLimit<I, O>(items: I[], limit: number, fn: (item: I, index: number) => Promise<O>): Promise<Settled<O>[]> {
  const results: Settled<O>[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = { status: 'fulfilled', value: await fn(items[idx]!, idx) };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
