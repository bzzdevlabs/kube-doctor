// Small helpers shared by the analyzers.

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function ts(t) {
  if (!t) return NaN;
  return typeof t === 'number' ? t : Date.parse(t);
}

export function ageMs(t, now = Date.now()) {
  const v = ts(t);
  return Number.isNaN(v) ? null : now - v;
}

export function fmtAge(ms) {
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

const BIN = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DEC = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

// Parses a Kubernetes resource.Quantity ("250m", "512Mi", "1.5Gi", "2", "1e3").
export function parseQuantity(q) {
  if (q == null || q === '') return null;
  if (typeof q === 'number') return q;
  const m = String(q).trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]{0,2})$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (m[2] in BIN) return n * BIN[m[2]];
  if (m[2] in DEC) return n * DEC[m[2]];
  return null;
}

// JVM / Node style sizes: "512m", "2g", "1024k", "2048" (bytes).
export function parseJavaSize(s) {
  const m = String(s || '').match(/^(\d+(?:\.\d+)?)([kKmMgGtT]?)$/);
  if (!m) return null;
  const mult = { '': 1, k: 2 ** 10, m: 2 ** 20, g: 2 ** 30, t: 2 ** 40 }[m[2].toLowerCase()];
  return parseFloat(m[1]) * mult;
}

export function fmtBytes(b) {
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

export function fmtCpu(c) {
  if (c == null || Number.isNaN(c)) return '—';
  if (c < 1) return `${Math.round(c * 1000)}m`;
  return `${+c.toFixed(2)}`;
}

export function pct(a, b) {
  if (a == null || !b) return null;
  return Math.round((a / b) * 100);
}

export const objKey = (kind, namespace, name) => `${kind}/${namespace || ''}/${name}`;
export const refKey = (r) => objKey(r.kind, r.namespace, r.name);

export function objRef(obj, kind) {
  return { kind: kind || obj.kind, namespace: obj.metadata?.namespace || '', name: obj.metadata?.name };
}

export function fmtRef(r) {
  if (!r) return '';
  return r.namespace ? `${r.kind} ${r.namespace}/${r.name}` : `${r.kind} ${r.name}`;
}

// Service-style selector (plain map).
export function matchLabels(selector, labels = {}) {
  if (!selector) return false;
  const entries = Object.entries(selector);
  if (!entries.length) return false;
  return entries.every(([k, v]) => labels[k] === v);
}

// metav1.LabelSelector with matchLabels + matchExpressions.
export function matchSelector(sel, labels = {}) {
  if (!sel) return false;
  const ml = sel.matchLabels || {};
  for (const [k, v] of Object.entries(ml)) if (labels[k] !== v) return false;
  for (const e of sel.matchExpressions || []) {
    const has = Object.prototype.hasOwnProperty.call(labels, e.key);
    const val = labels[e.key];
    switch (e.operator) {
      case 'In': if (!has || !e.values.includes(val)) return false; break;
      case 'NotIn': if (has && e.values.includes(val)) return false; break;
      case 'Exists': if (!has) return false; break;
      case 'DoesNotExist': if (has) return false; break;
      default: return false;
    }
  }
  return Object.keys(ml).length > 0 || (sel.matchExpressions || []).length > 0;
}

export function eventTime(ev) {
  return ts(ev.series?.lastObservedTime || ev.lastTimestamp || ev.eventTime || ev.firstTimestamp || ev.metadata?.creationTimestamp);
}

export function eventFirstTime(ev) {
  return ts(ev.firstTimestamp || ev.eventTime || ev.metadata?.creationTimestamp);
}

export function eventCount(ev) {
  return ev.series?.count || ev.count || 1;
}

// "spec.containers{api}" -> "api"
export function eventContainer(ev) {
  const m = (ev.involvedObject?.fieldPath || '').match(/\{([^}]+)\}/);
  return m ? m[1] : null;
}

export function truncate(s, n = 400) {
  if (!s) return s;
  s = String(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function uniq(arr) {
  return [...new Set(arr.filter((x) => x != null && x !== ''))];
}

export function cond(obj, type) {
  return (obj?.status?.conditions || []).find((c) => c.type === type);
}

export const SEVERITY_RANK = { critical: 3, warning: 2, info: 1 };

export function maxSeverity(list) {
  let best = 'info';
  for (const s of list) if ((SEVERITY_RANK[s] || 0) > SEVERITY_RANK[best]) best = s;
  return best;
}

export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = { status: 'fulfilled', value: await fn(items[idx], idx) };
      } catch (reason) {
        results[idx] = { status: 'rejected', reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export function kubectlCmd(parts, ctx) {
  const c = ctx?.context ? ` --context ${shellQuote(ctx.context)}` : '';
  return `kubectl ${parts}${c}`;
}

function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}
