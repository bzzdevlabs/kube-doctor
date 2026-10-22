// Global state, actions and routing. Components read `S` through useStore();
// actions mutate it through set(), which re-renders subscribers once per tick.
import { useEffect, useState } from 'preact/hooks';
import type { ContextsResponse, DeepAnalysis, Finding, NamespaceRow, NodeSummary, PodRow, Report, Severity, WorkloadRow } from '../../shared/types';
import * as prefs from './prefs';
import { api, ApiError } from './api';
import { fmtObj, download, SEV_RANK } from './fmt';
import type { IconName } from './icons';

export type ViewId = 'overview' | 'incidents' | 'problems' | 'workloads' | 'pods' | 'nodes' | 'events' | 'namespaces' | 'scan';

export const VIEWS: { id: ViewId; label: string; icon: IconName; key: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'overview', key: 'o' },
  { id: 'incidents', label: 'Root causes', icon: 'incidents', key: 'i' },
  { id: 'problems', label: 'Problems', icon: 'problems', key: 'p' },
  { id: 'workloads', label: 'Workloads', icon: 'workloads', key: 'w' },
  { id: 'pods', label: 'Pods', icon: 'pods', key: 'd' },
  { id: 'nodes', label: 'Nodes', icon: 'nodes', key: 'n' },
  { id: 'events', label: 'Events', icon: 'events', key: 'e' },
  { id: 'namespaces', label: 'Namespaces', icon: 'namespaces', key: 's' },
  { id: 'scan', label: 'Scan & settings', icon: 'scan', key: 'c' },
];

export type Target =
  | { type: 'finding'; id: string }
  | { type: 'pod'; namespace: string; name: string }
  | { type: 'node'; name: string }
  | { type: 'workload'; kind: WorkloadRow['kind']; namespace: string; name: string };

export interface ResolvedEntry { id: string; t: string; s: Severity; o: string; first: number; at: number }

export interface Changes {
  baseline: number;
  previousScan: number | null;
  newIds: Set<string>;
  resolved: ResolvedEntry[];
  firstSeen: Record<string, number>;
}

export interface Index {
  byId: Map<string, Finding>;
  effects: Map<string, string[]>;
  byObj: Map<string, Finding[]>;
  pods: Map<string, PodRow>;
  workloads: Map<string, WorkloadRow>;
  nodes: Map<string, NodeSummary>;
  namespaces: Map<string, NamespaceRow>;
}

export interface Loadable<T> { loading?: boolean; data?: T; error?: ApiError | Error; at?: number }
export interface PanelState { open: boolean; pinned: boolean; width: number }
export interface Toast { id: number; message: string; tone: 'neutral' | 'ok' | 'warn' }
export type Theme = 'light' | 'dark' | null;
export type Density = 'comfortable' | 'compact';
export type FacetSelection = Record<string, (string | number)[]>;
export interface MuteEntry { at: number; title: string; object: string }

export interface State {
  contexts: string[];
  contextsLoaded: boolean;
  current: string | null;
  context: string | null;
  demo: boolean;
  report: Report | null;
  idx: Index | null;
  scanning: boolean;
  error: ApiError | Error | null;
  view: ViewId;
  ns: string[];
  facets: Partial<Record<ViewId, FacetSelection>>;
  query: Partial<Record<ViewId, string>>;
  insp: { stack: Target[]; i: number; pinned: boolean; width: number; tabs: Record<string, string> };
  filt: PanelState;
  navCollapsed: boolean;
  theme: Theme;
  density: Density;
  auto: number;
  analyzeLogs: boolean;
  collapsed: Record<string, boolean>;
  deep: Record<string, Loadable<DeepAnalysis>>;
  raw: Record<string, Loadable<unknown>>;
  palette: boolean;
  help: boolean;
  toasts: Toast[];
  muted: Record<string, MuteEntry>;
  mutedVer: number;
  changes: Changes | null;
  allChips: boolean;
}

export const S: State = {
  contexts: [], contextsLoaded: false, current: null, context: null, demo: false,
  report: null, idx: null, scanning: false, error: null,
  view: 'overview',
  ns: prefs.load<string[]>('ns', []),
  facets: {},
  query: {},
  insp: { stack: [], i: -1, pinned: prefs.load('insp.pinned', false), width: prefs.load('insp.width', 620), tabs: {} },
  filt: { open: prefs.load('filt.open', false), pinned: prefs.load('filt.pinned', true), width: prefs.load('filt.width', 270) },
  navCollapsed: prefs.load('nav.collapsed', false),
  theme: prefs.load<Theme>('theme', null),
  density: prefs.load<Density>('density', 'comfortable'),
  auto: prefs.load('auto', 0),
  analyzeLogs: prefs.load('logs', true),
  collapsed: prefs.load<Record<string, boolean>>('collapsed', {}),
  deep: {}, raw: {},
  palette: false, help: false, toasts: [],
  muted: {}, mutedVer: 0, changes: null, allChips: false,
};

const subs = new Set<() => void>();
let queued = false;

export function set(fn?: (s: State) => void): void {
  if (fn) fn(S);
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    queued = false;
    for (const s of [...subs]) s();
  });
}

export function useStore(): State {
  const [, force] = useState(0);
  useEffect(() => {
    const s = () => force((x) => x + 1);
    subs.add(s);
    return () => {
      subs.delete(s);
    };
  }, []);
  return S;
}

// ------------------------------------------------------------------ toasts
let toastSeq = 0;
export function toast(message: string, tone: Toast['tone'] = 'neutral'): void {
  const id = ++toastSeq;
  set((s) => { s.toasts = [...s.toasts, { id, message, tone }]; });
  setTimeout(() => set((s) => { s.toasts = s.toasts.filter((t) => t.id !== id); }), 2600);
}

export async function copy(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} to clipboard`, 'ok');
  } catch {
    toast('Copy failed — select the text manually', 'warn');
  }
}

// ------------------------------------------------------------------ routing
export function targetKey(t: Target | null | undefined): string {
  if (!t) return '';
  switch (t.type) {
    case 'finding': return `finding:${t.id}`;
    case 'pod': return `pod:${t.namespace}/${t.name}`;
    case 'node': return `node:${t.name}`;
    case 'workload': return `workload:${t.kind}/${t.namespace}/${t.name}`;
  }
}

export function parseTarget(str: string): Target | null {
  const i = str.indexOf(':');
  const type = str.slice(0, i);
  const rest = str.slice(i + 1);
  if (type === 'finding') return { type, id: rest };
  if (type === 'node') return { type, name: rest };
  if (type === 'pod') {
    const [namespace = '', name = ''] = rest.split('/');
    return { type, namespace, name };
  }
  if (type === 'workload') {
    const [kind = '', namespace = '', name = ''] = rest.split('/');
    return { type, kind: kind as WorkloadRow['kind'], namespace, name };
  }
  return null;
}

export const currentTarget = (): Target | null => (S.insp.i >= 0 ? S.insp.stack[S.insp.i] ?? null : null);

function writeHash(push: boolean): void {
  const t = currentTarget();
  const hash = `#/${S.view}${t ? `?i=${encodeURIComponent(targetKey(t))}` : ''}`;
  if (location.hash === hash) return;
  if (push) location.hash = hash;
  else history.replaceState(null, '', hash);
}

function readHash(): { view: ViewId; target: Target | null } {
  const m = location.hash.match(/^#\/([a-z]+)(?:\?i=(.*))?$/);
  const view = (m && VIEWS.some((v) => v.id === m[1]) ? m[1] : 'overview') as ViewId;
  const target = m && m[2] ? parseTarget(decodeURIComponent(m[2])) : null;
  return { view, target };
}

export function navigate(view: ViewId): void {
  set((s) => { s.view = view; });
  writeHash(true);
  document.querySelector('.main-scroll')?.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- inspector
export function inspect(target: Target, { replace = false } = {}): void {
  set((s) => {
    const cur = currentTarget();
    if (cur && targetKey(cur) === targetKey(target)) return;
    if (replace && s.insp.i >= 0) {
      s.insp.stack = [...s.insp.stack.slice(0, s.insp.i), target];
    } else {
      s.insp.stack = [...s.insp.stack.slice(0, s.insp.i + 1), target].slice(-50);
      s.insp.i = s.insp.stack.length - 1;
    }
  });
  writeHash(false);
}

export const inspectFinding = (id: string): void => inspect({ type: 'finding', id });

export function closeInspector(): void {
  set((s) => { s.insp.stack = []; s.insp.i = -1; });
  writeHash(false);
}

export function inspectorStep(delta: number): void {
  const n = S.insp.i + delta;
  if (n < 0 || n >= S.insp.stack.length) return;
  set((s) => { s.insp.i = n; });
  writeHash(false);
}

export function togglePin(panel: 'insp' | 'filt'): void {
  set((s) => { s[panel].pinned = !s[panel].pinned; });
  prefs.save(`${panel}.pinned`, S[panel].pinned);
}

export function setPanelWidth(panel: 'insp' | 'filt', w: number): void {
  set((s) => { s[panel].width = w; });
  prefs.save(`${panel}.width`, w);
}

export function setInspectorTab(type: string, tab: string): void {
  set((s) => { s.insp.tabs = { ...s.insp.tabs, [type]: tab }; });
}

export function toggleFilters(open = !S.filt.open): void {
  set((s) => { s.filt.open = open; });
  prefs.save('filt.open', open);
}

// ------------------------------------------------------------------ filters
export function setNamespaces(list: string[]): void {
  set((s) => { s.ns = list; });
  prefs.save('ns', list);
}

export function toggleFacet(view: ViewId, key: string, value: string | number): void {
  if (key === 'namespace') {
    const v = String(value);
    setNamespaces(S.ns.includes(v) ? S.ns.filter((x) => x !== v) : [...S.ns, v]);
    return;
  }
  set((s) => {
    const f = s.facets[view] || {};
    const cur = f[key] || [];
    s.facets = { ...s.facets, [view]: { ...f, [key]: cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value] } };
  });
}

export function setFacet(view: ViewId, key: string, values: (string | number)[]): void {
  if (key === 'namespace') {
    setNamespaces(values.map(String));
    return;
  }
  set((s) => { s.facets = { ...s.facets, [view]: { ...(s.facets[view] || {}), [key]: values } }; });
}

export function clearFacets(view: ViewId, { keepNamespace = false } = {}): void {
  set((s) => {
    s.facets = { ...s.facets, [view]: {} };
    s.query = { ...s.query, [view]: '' };
  });
  if (!keepNamespace) setNamespaces([]);
}

export function setQuery(view: ViewId, q: string): void {
  set((s) => { s.query = { ...s.query, [view]: q }; });
}

// Navigate to a view with a given facet selection (used by charts and links).
export function drill(view: ViewId, facets: FacetSelection = {}): void {
  set((s) => {
    s.facets = { ...s.facets, [view]: facets };
    s.query = { ...s.query, [view]: '' };
  });
  navigate(view);
}

// ------------------------------------------------------------- preferences
type PrefKey = 'theme' | 'density' | 'auto' | 'analyzeLogs' | 'navCollapsed';
const PREF_STORAGE: Record<PrefKey, string> = { theme: 'theme', density: 'density', auto: 'auto', analyzeLogs: 'logs', navCollapsed: 'nav.collapsed' };

export function setPref<K extends PrefKey>(key: K, value: State[K]): void {
  set((s) => { s[key] = value; });
  prefs.save(PREF_STORAGE[key], value);
  if (key === 'theme' || key === 'density') applyAppearance();
  if (key === 'auto') startAuto();
}

export function setCollapsed(id: string, collapsed: boolean): void {
  set((s) => { s.collapsed = { ...s.collapsed, [id]: collapsed }; });
  prefs.save('collapsed', S.collapsed);
}

export function applyAppearance(): void {
  const root = document.documentElement;
  if (S.theme) root.dataset.theme = S.theme;
  else delete root.dataset.theme;
  root.dataset.density = S.density;
}

export const isDark = (): boolean => (S.theme ? S.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);

export function toggleTheme(): void {
  setPref('theme', isDark() ? 'light' : 'dark');
}

// --------------------------------------------------------------- mute/seen
export const isMuted = (id: string): boolean => !!S.muted[id];
export const isNew = (id: string): boolean => !!S.changes?.newIds.has(id);

export function toggleMute(f: Finding): void {
  set((s) => {
    const m = { ...s.muted };
    if (m[f.id]) delete m[f.id];
    else m[f.id] = { at: Date.now(), title: f.title, object: fmtObj(f.object) };
    s.muted = m;
    s.mutedVer++;
  });
  prefs.save(`muted.${S.context}`, S.muted);
  toast(S.muted[f.id] ? 'Muted — hidden from lists and counts until unmuted' : 'Unmuted');
}

export function unmute(id: string): void {
  set((s) => {
    const m = { ...s.muted };
    delete m[id];
    s.muted = m;
    s.mutedVer++;
  });
  prefs.save(`muted.${S.context}`, S.muted);
}

const NEW_WINDOW = 30 * 60_000;

interface SeenStore {
  baseline: number;
  at: number;
  items: Record<string, { t: string; s: Severity; o: string; first: number }>;
  resolved: ResolvedEntry[];
}

// Remembers when each problem was first seen, to flag new ones and list resolved ones.
function trackChanges(report: Report): Changes {
  const key = `seen.${S.context}`;
  const prev = prefs.load<SeenStore | null>(key, null);
  const now = Date.now();
  const items: SeenStore['items'] = {};
  for (const f of report.findings) {
    items[f.id] = { t: f.title, s: f.severity, o: fmtObj(f.object), first: prev?.items?.[f.id]?.first ?? now };
  }
  const baseline = prev?.baseline ?? now;
  const resolvedNow: ResolvedEntry[] = prev ? Object.entries(prev.items).filter(([id]) => !items[id]).map(([id, v]) => ({ id, ...v, at: now })) : [];
  const resolved = [...resolvedNow, ...(prev?.resolved || []).filter((r) => !items[r.id] && now - r.at < 24 * 3600_000 && !resolvedNow.some((x) => x.id === r.id))].slice(0, 200);
  const ids = Object.keys(items);
  if (ids.length > 4000) for (const id of ids.slice(4000)) delete items[id];
  prefs.save(key, { baseline, at: now, items, resolved } satisfies SeenStore);
  const firstSeen: Record<string, number> = {};
  for (const [id, v] of Object.entries(items)) firstSeen[id] = v.first;
  const newIds = new Set(report.findings.filter((f) => (firstSeen[f.id] ?? 0) > baseline && now - (firstSeen[f.id] ?? 0) < NEW_WINDOW).map((f) => f.id));
  return { baseline, previousScan: prev?.at || null, newIds, resolved, firstSeen };
}

// ----------------------------------------------------------------- indexes
function buildIndex(r: Report): Index {
  const byId = new Map(r.findings.map((f) => [f.id, f]));
  const effects = new Map<string, string[]>();
  for (const f of r.findings) {
    for (const c of f.causedBy || []) {
      const list = effects.get(c);
      if (list) list.push(f.id);
      else effects.set(c, [f.id]);
    }
  }
  for (const list of effects.values()) list.sort((a, b) => SEV_RANK[byId.get(b)!.severity]! - SEV_RANK[byId.get(a)!.severity]!);
  const byObj = new Map<string, Finding[]>();
  const reg = (k: string, f: Finding) => {
    const list = byObj.get(k);
    if (!list) byObj.set(k, [f]);
    else if (!list.includes(f)) list.push(f);
  };
  for (const f of r.findings) {
    reg(`${f.object.kind}/${f.object.namespace || ''}/${f.object.name}`, f);
    for (const i of f.instances || []) reg(`Pod/${i.namespace}/${i.pod}`, f);
  }
  const inv = r.inventory || { pods: [], workloads: [], namespaces: [] };
  return {
    byId, effects, byObj,
    pods: new Map(inv.pods.map((p) => [`${p.namespace}/${p.name}`, p])),
    workloads: new Map(inv.workloads.map((w) => [`${w.kind}/${w.namespace}/${w.name}`, w])),
    nodes: new Map(r.nodes.map((n) => [n.name, n])),
    namespaces: new Map(inv.namespaces.map((n) => [n.name, n])),
  };
}

export const findingsFor = (kind: string, namespace: string | null | undefined, name: string): Finding[] => S.idx?.byObj.get(`${kind}/${namespace || ''}/${name}`) || [];

// -------------------------------------------------------------------- scan
const asError = (e: unknown): ApiError | Error => (e instanceof Error ? e : new Error(String(e)));

export async function loadContexts(): Promise<void> {
  try {
    const c = await api<ContextsResponse>('/api/contexts');
    set((s) => {
      s.contexts = c.contexts;
      s.current = c.current;
      s.demo = c.demo;
      const saved = prefs.load<string | null>('context', null);
      s.context = saved && c.contexts.includes(saved) ? saved : c.current || c.contexts[0] || null;
      s.muted = prefs.load(`muted.${s.context}`, {});
    });
  } catch (e) {
    set((s) => { s.error = asError(e); });
  } finally {
    set((s) => { s.contextsLoaded = true; });
  }
}

export async function scan({ quiet = false } = {}): Promise<void> {
  if (S.scanning) return;
  set((s) => {
    s.scanning = true;
    if (!quiet) s.error = null;
  });
  try {
    const report = await api<Report>('/api/scan', { context: S.context, logs: S.analyzeLogs ? '1' : '0' });
    const changes = trackChanges(report);
    set((s) => {
      s.report = report;
      s.idx = buildIndex(report);
      s.changes = changes;
      s.error = null;
      s.raw = {};
      const t = currentTarget();
      if (t?.type === 'finding' && !s.idx.byId.has(t.id)) {
        s.insp.stack = s.insp.stack.filter((x) => x.type !== 'finding' || s.idx!.byId.has(x.id));
        s.insp.i = s.insp.stack.length - 1;
      }
    });
  } catch (e) {
    set((s) => { s.error = asError(e); });
  } finally {
    set((s) => { s.scanning = false; });
  }
}

export function setContext(ctx: string): void {
  prefs.save('context', ctx);
  set((s) => {
    s.context = ctx;
    s.report = null;
    s.idx = null;
    s.deep = {};
    s.raw = {};
    s.insp.stack = [];
    s.insp.i = -1;
    s.muted = prefs.load(`muted.${ctx}`, {});
    s.mutedVer++;
  });
  writeHash(false);
  void scan();
}

let autoTimer: ReturnType<typeof setInterval> | null = null;
export function startAuto(): void {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = S.auto > 0 ? setInterval(() => { if (!document.hidden) void scan({ quiet: true }); }, S.auto * 1000) : null;
}

// ---------------------------------------------------------- deep analysis
export async function runDeep(namespace: string, name: string, { force = false } = {}): Promise<void> {
  const key = `${namespace}/${name}`;
  const cur = S.deep[key];
  if (!force && cur && (cur.loading || (cur.data && Date.now() - (cur.at ?? 0) < 60_000))) return;
  set((s) => { s.deep = { ...s.deep, [key]: { loading: true, data: cur?.data } }; });
  try {
    const data = await api<DeepAnalysis>('/api/pod', { context: S.context, namespace, name });
    set((s) => { s.deep = { ...s.deep, [key]: { data, at: Date.now() } }; });
  } catch (e) {
    set((s) => { s.deep = { ...s.deep, [key]: { error: asError(e) } }; });
  }
}

export async function loadRaw(obj: { kind: string; namespace?: string; name: string }): Promise<void> {
  const key = `${obj.kind}/${obj.namespace || ''}/${obj.name}`;
  if (S.raw[key]?.data || S.raw[key]?.loading) return;
  set((s) => { s.raw = { ...s.raw, [key]: { loading: true } }; });
  try {
    const data = await api<unknown>('/api/object', { context: S.context, kind: obj.kind, namespace: obj.namespace || '', name: obj.name });
    set((s) => { s.raw = { ...s.raw, [key]: { data } }; });
  } catch (e) {
    set((s) => { s.raw = { ...s.raw, [key]: { error: asError(e) } }; });
  }
}

// ------------------------------------------------------------------ export
export function findingMarkdown(f: Finding): string {
  const lines = [`### [${f.severity.toUpperCase()}] ${f.title}`, '', `- **Object:** ${fmtObj(f.object)}${f.owner ? ` (owned by ${f.owner.kind} ${f.owner.name})` : ''}`];
  if (f.instances.length > 1) lines.push(`- **Affected pods (${f.instances.length}):** ${f.instances.map((i) => i.pod).join(', ')}`);
  lines.push(`- **Root cause (${f.rootCause.confidence} confidence):** ${f.rootCause.summary}`);
  if (f.rootCause.inherited) lines.push(`- **Upstream root cause:** ${f.rootCause.inherited.title} — ${f.rootCause.inherited.summary}`);
  if (f.evidence.length) lines.push('', '**Evidence**', ...f.evidence.map((e) => `- ${e}`));
  if (f.fixes.length) lines.push('', '**How to fix**', ...f.fixes.map((e) => `- ${e}`));
  if (f.commands.length) lines.push('', '**Investigate**', '```', ...f.commands, '```');
  return lines.join('\n');
}

export function reportMarkdown(): string {
  const r = S.report;
  const idx = S.idx;
  if (!r || !idx) return '';
  const m = r.meta;
  const out = [`# Kube Doctor report — ${m.context}`, '', `Scanned ${new Date(m.scannedAt).toLocaleString()} · Kubernetes ${m.version} · ${r.summary.nodes.ready}/${r.summary.nodes.total} nodes ready · ${r.summary.pods.withProblems}/${r.summary.pods.total} pods with problems`, ''];
  const incidents = r.incidents.filter((i) => !isMuted(i.rootId) && (!S.ns.length || i.namespaces.some((n) => S.ns.includes(n))));
  out.push(`## Root causes (${incidents.length})`, '');
  for (const i of incidents) {
    const f = idx.byId.get(i.rootId);
    if (!f) continue;
    out.push(findingMarkdown(f));
    if (i.impacted.length) {
      out.push('', `**Impacts (${i.impacted.length}):**`, ...i.impacted.slice(0, 25).map((id) => {
        const x = idx.byId.get(id);
        return x ? `- ${fmtObj(x.object)} — ${x.title}` : '';
      }));
    }
    out.push('');
  }
  return out.join('\n');
}

export function exportJson(): void {
  if (!S.report) return;
  download(`kube-doctor-${S.context}-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.json`, JSON.stringify(S.report, null, 2));
}

// --------------------------------------------------------------------- init
export async function init(): Promise<void> {
  applyAppearance();
  const { view, target } = readHash();
  S.view = view;
  if (target) {
    S.insp.stack = [target];
    S.insp.i = 0;
  }
  window.addEventListener('hashchange', () => {
    const h = readHash();
    set((s) => {
      s.view = h.view;
      if (h.target && targetKey(h.target) !== targetKey(currentTarget())) {
        s.insp.stack = [...s.insp.stack.slice(0, s.insp.i + 1), h.target];
        s.insp.i = s.insp.stack.length - 1;
      }
    });
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => set());
  setInterval(() => set(), 30_000); // keeps relative times ("2m ago") fresh
  await loadContexts();
  startAuto();
  if (S.context) await scan();
}
