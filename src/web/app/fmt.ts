// Formatting helpers shared by the views.
import type { ObjRef, Severity } from '../../shared/types';

export const SEV_RANK: Record<string, number> = { critical: 3, warning: 2, info: 1, ok: 0 };
export const SEVERITIES: Severity[] = ['critical', 'warning', 'info'];
export type Tone = 'crit' | 'warn' | 'info' | 'ok' | 'accent' | 'neutral' | 'muted';
export const SEV_TONE: Record<Severity, Tone> = { critical: 'crit', warning: 'warn', info: 'info' };

export const toMs = (t: string | number | null | undefined): number => (t == null || t === '' ? NaN : typeof t === 'number' ? t : Date.parse(t));

export function dur(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

export function ago(t: string | number | null | undefined): string {
  const ms = Date.now() - toMs(t);
  return Number.isFinite(ms) ? `${dur(ms)} ago` : '—';
}

export const age = (t: string | number | null | undefined): string => dur(Date.now() - toMs(t));

export function clock(t: string | number | null | undefined): string {
  const d = new Date(toMs(t));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateTime(t: string | number | null | undefined): string {
  const d = new Date(toMs(t));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export function bytes(b: number | null | undefined): string {
  if (b == null || !Number.isFinite(b)) return '—';
  const u = ['B', 'Ki', 'Mi', 'Gi', 'Ti'];
  let i = 0;
  let v = b;
  while (Math.abs(v) >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')}${u[i]}`;
}

export function cpu(c: number | null | undefined): string {
  if (c == null || !Number.isFinite(c)) return '—';
  return c < 1 ? `${Math.round(c * 1000)}m` : `${+c.toFixed(2)}`;
}

export const plural = (n: number, w: string, p = `${w}s`): string => `${n} ${n === 1 ? w : p}`;
export const pct = (a: number | null | undefined, b: number | null | undefined): number => (a != null && b ? Math.round((a / b) * 100) : 0);

export function maxSev(list: (Severity | null | undefined)[]): Severity | null {
  let best: Severity | null = null;
  for (const s of list) if (s && (!best || SEV_RANK[s]! > SEV_RANK[best]!)) best = s;
  return best;
}

export const objKey = (o: ObjRef): string => `${o.kind}/${o.namespace || ''}/${o.name}`;
export const fmtObj = (o: ObjRef | null | undefined): string => (o ? `${o.kind} ${o.namespace ? `${o.namespace}/` : ''}${o.name}` : '');

export function parseQty(q: string | null | undefined): number | null {
  if (q == null || q === '') return null;
  const m = String(q).match(/^([\d.]+)([a-zA-Z]*)$/);
  if (!m) return null;
  const mult = ({ '': 1, m: 1e-3, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, k: 1e3, M: 1e6, G: 1e9 } as Record<string, number>)[m[2]!];
  return mult == null ? null : parseFloat(m[1]!) * mult;
}

export function truncate(s: string | null | undefined, n: number): string {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

export function matchTokens(text: string, q: string): boolean {
  if (!q) return true;
  const hay = text.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}

// Minimal YAML emitter for displaying Kubernetes objects.
function scalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v !== 'string') return String(v);
  if (v === '' || v.includes('\n') || /^[\s\-?:,[\]{}#&*!|>'"%@`]|\s$|: |\s#/.test(v) || /^(true|false|null|yes|no|on|off|~)$/i.test(v) || (!Number.isNaN(Number(v)) && v.trim() !== '')) {
    return JSON.stringify(v);
  }
  return v;
}

function yaml(v: unknown, ind: number): string {
  const pad = '  '.repeat(ind);
  if (Array.isArray(v)) {
    if (!v.length) return ' []';
    return `\n${v.map((x: unknown) => {
      if (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length) {
        const lines = yaml(x, ind + 1).replace(/^\n/, '').split('\n');
        lines[0] = `${pad}- ${lines[0]!.trimStart()}`;
        return lines.join('\n');
      }
      if (Array.isArray(x)) return `${pad}-${yaml(x, ind + 1)}`;
      return `${pad}- ${scalar(x)}`;
    }).join('\n')}`;
  }
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (!entries.length) return ' {}';
    return `\n${entries.map(([k, val]) => (val && typeof val === 'object' ? `${pad}${scalar(k)}:${yaml(val, ind + 1)}` : `${pad}${scalar(k)}: ${scalar(val)}`)).join('\n')}`;
  }
  return ` ${scalar(v)}`;
}

export const toYaml = (o: unknown): string => yaml(o, 0).replace(/^\n/, '');

export function download(name: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
