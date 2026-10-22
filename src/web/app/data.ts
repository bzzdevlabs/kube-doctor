// Per-view datasets: rows, search text and facets. The filter panel and the
// views both read through useDataset(), so counts and lists always agree.
import type { EventRow, Finding, Incident, NamespaceRow, NodeSummary, PodRow, Report, Severity, WorkloadRow } from '../../shared/types';
import { S, isMuted, isNew, type FacetSelection, type ViewId } from './store';
import { SEVERITIES, maxSev, matchTokens } from './fmt';

const uniq = <T>(a: (T | null | undefined | '')[]): T[] => [...new Set(a.filter((x): x is T => x != null && x !== ''))];
const SPECIAL_TAGS = new Set(['OOMKilled', 'LivenessProbe', 'ErrImagePull', 'MissingSecret', 'MissingConfigMap', 'QuotaExceeded', 'PodSecurity', 'MultiAttach']);

export type IncidentRow = Incident & { root: Finding };
export type EventRowK = EventRow & { _k: string };

export const findingNamespaces = (f: Finding): string[] => uniq([f.object.namespace, ...(f.instances || []).map((i) => i.namespace)]);

// Worst unmuted severity among the problems attached to an inventory row.
export function rowSeverity(ids: string[] = []): Severity | null {
  return maxSev(ids.filter((id) => !isMuted(id)).map((id) => S.idx?.byId.get(id)?.severity));
}

export type Health = 'Critical' | 'Warning' | 'Info only' | 'Healthy';
export const HEALTH_ORDER: Health[] = ['Critical', 'Warning', 'Info only', 'Healthy'];

export function health(ids: string[]): Health {
  const s = rowSeverity(ids);
  return s === 'critical' ? 'Critical' : s === 'warning' ? 'Warning' : s === 'info' ? 'Info only' : 'Healthy';
}

type FacetValue = string | null | undefined;

export interface FacetDef<R> {
  key: string;
  label: string;
  get: (r: R) => FacetValue | FacetValue[];
  order?: string[];
}

export interface Dataset<R> {
  rows: (r: Report) => R[];
  key: (r: R) => string;
  ns: ((r: R) => string[]) | null;
  muted?: (r: R) => boolean;
  search: (r: R) => string;
  facets: FacetDef<R>[];
}

export interface RowTypes {
  incidents: IncidentRow;
  problems: Finding;
  workloads: WorkloadRow;
  pods: PodRow;
  nodes: NodeSummary;
  events: EventRowK;
  namespaces: NamespaceRow;
}

export type DatasetView = keyof RowTypes;

const nodeFindings = (n: NodeSummary) => (S.idx?.byObj.get(`Node//${n.name}`) || []).map((f) => f.id);

export const DATASETS: { [V in DatasetView]: Dataset<RowTypes[V]> } = {
  incidents: {
    rows: (r) => r.incidents.flatMap((i) => {
      const root = S.idx?.byId.get(i.rootId);
      return root ? [{ ...i, root }] : [];
    }),
    key: (i) => i.id,
    ns: (i) => i.namespaces.filter(Boolean),
    muted: (i) => isMuted(i.rootId),
    search: (i) => [i.root.title, i.root.category, i.root.rootCause.summary, i.root.object.name, ...i.impacted.map((id) => {
      const f = S.idx?.byId.get(id);
      return f ? `${f.title} ${f.object.name}` : '';
    })].join(' '),
    facets: [
      { key: 'severity', label: 'Severity', get: (i) => i.severity, order: SEVERITIES },
      { key: 'category', label: 'Root cause type', get: (i) => i.root.category },
      { key: 'kind', label: 'Root object kind', get: (i) => i.root.object.kind },
      { key: 'state', label: 'State', get: (i) => [isNew(i.rootId) ? 'New' : 'Known', isMuted(i.rootId) ? 'Muted' : null] },
    ],
  },
  problems: {
    rows: (r) => r.findings,
    key: (f) => f.id,
    ns: findingNamespaces,
    muted: (f) => isMuted(f.id),
    search: (f) => [f.title, f.category, f.tags.join(' '), f.object.kind, f.object.namespace, f.object.name, f.rootCause.summary, f.node, (f.instances || []).map((i) => i.pod).join(' ')].join(' '),
    facets: [
      { key: 'severity', label: 'Severity', get: (f) => f.severity, order: SEVERITIES },
      { key: 'role', label: 'Role', get: (f) => (f.causedBy.length ? 'Symptom' : 'Root cause'), order: ['Root cause', 'Symptom'] },
      { key: 'category', label: 'Problem type', get: (f) => uniq([f.category, ...f.tags.filter((t) => SPECIAL_TAGS.has(t))]) },
      { key: 'kind', label: 'Object kind', get: (f) => f.object.kind },
      { key: 'node', label: 'Node', get: (f) => uniq([f.node, ...(f.instances || []).map((i) => i.node)]) },
      { key: 'state', label: 'State', get: (f) => [isNew(f.id) ? 'New' : 'Known', isMuted(f.id) ? 'Muted' : null] },
    ],
  },
  workloads: {
    rows: (r) => r.inventory.workloads,
    key: (w) => `${w.kind}/${w.namespace}/${w.name}`,
    ns: (w) => [w.namespace],
    search: (w) => `${w.kind} ${w.namespace} ${w.name} ${w.status} ${w.images.join(' ')}`,
    facets: [
      { key: 'health', label: 'Health', get: (w) => health(w.problems), order: HEALTH_ORDER },
      { key: 'kind', label: 'Kind', get: (w) => w.kind },
      { key: 'status', label: 'Status', get: (w) => w.status },
    ],
  },
  pods: {
    rows: (r) => r.inventory.pods,
    key: (p) => `${p.namespace}/${p.name}`,
    ns: (p) => [p.namespace],
    search: (p) => `${p.namespace} ${p.name} ${p.status} ${p.node || ''} ${p.owner?.name || ''} ${p.ip || ''} ${p.images.join(' ')}`,
    facets: [
      { key: 'health', label: 'Health', get: (p) => health(p.problems), order: HEALTH_ORDER },
      { key: 'status', label: 'Status', get: (p) => p.status },
      { key: 'phase', label: 'Phase', get: (p) => p.phase },
      { key: 'node', label: 'Node', get: (p) => p.node || '(unscheduled)' },
      { key: 'owner', label: 'Owner kind', get: (p) => p.owner?.kind || '(none)' },
      { key: 'restarts', label: 'Restarts', get: (p) => (p.restarts === 0 ? '0' : p.restarts < 5 ? '1–4' : p.restarts < 20 ? '5–19' : '20+'), order: ['0', '1–4', '5–19', '20+'] },
    ],
  },
  nodes: {
    rows: (r) => r.nodes,
    key: (n) => n.name,
    ns: null,
    search: (n) => `${n.name} ${n.roles.join(' ')} ${n.zone || ''} ${n.instanceType || ''} ${n.version} ${n.problems.map((p) => p.type).join(' ')}`,
    facets: [
      { key: 'status', label: 'Status', get: (n) => n.ready },
      { key: 'health', label: 'Health', get: (n) => health(nodeFindings(n)), order: HEALTH_ORDER },
      { key: 'role', label: 'Role', get: (n) => n.roles },
      { key: 'zone', label: 'Zone', get: (n) => n.zone || '(none)' },
      { key: 'sched', label: 'Scheduling', get: (n) => (n.cordoned ? 'Cordoned' : 'Schedulable') },
    ],
  },
  events: {
    rows: (r) => r.events.rows.map((e, i) => Object.assign(e, { _k: (e as EventRowK)._k ?? `e${i}` })),
    key: (e) => e._k,
    ns: (e) => [e.object.namespace],
    search: (e) => `${e.reason} ${e.message} ${e.object.kind} ${e.object.namespace} ${e.object.name} ${e.source}`,
    facets: [
      { key: 'type', label: 'Type', get: (e) => e.type, order: ['Warning', 'Normal'] },
      { key: 'reason', label: 'Reason', get: (e) => e.reason },
      { key: 'kind', label: 'Object kind', get: (e) => e.object.kind },
      { key: 'source', label: 'Source', get: (e) => e.source || '(unknown)' },
    ],
  },
  namespaces: {
    rows: (r) => r.inventory.namespaces,
    key: (n) => n.name,
    ns: null, // this page is where the namespace scope is chosen, so it lists them all
    search: (n) => n.name,
    facets: [
      { key: 'health', label: 'Health', get: (n) => health(n.problems), order: HEALTH_ORDER },
      { key: 'phase', label: 'Phase', get: (n) => n.phase },
    ],
  },
};

export const isDatasetView = (v: ViewId): v is DatasetView => v in DATASETS;

export interface FacetValueCount {
  value: string;
  count: number;
  selected: boolean;
}

export interface FacetResult {
  key: string;
  label: string;
  global?: boolean;
  values: FacetValueCount[];
}

export interface DatasetResult<R> {
  rows: R[];
  base: R[];
  facets: FacetResult[];
  total: number;
  mutedCount: number;
  activeCount: number;
}

const toArr = (v: FacetValue | FacetValue[]): string[] => (Array.isArray(v) ? v : [v]).filter((x): x is string => x != null && x !== '');

function passes<R>(def: Dataset<R>, row: R, selected: FacetSelection, skip?: string): boolean {
  for (const fd of def.facets) {
    if (fd.key === skip) continue;
    const sel = selected[fd.key];
    if (!sel?.length) continue;
    if (!toArr(fd.get(row)).some((v) => sel.includes(v))) return false;
  }
  return true;
}

const orderIndex = (order: string[], v: string) => {
  const i = order.indexOf(v);
  return i < 0 ? order.length : i;
};

const cache = new Map<DatasetView, { deps: unknown[]; value: DatasetResult<unknown> }>();
const EMPTY: DatasetResult<never> = { rows: [], base: [], facets: [], total: 0, mutedCount: 0, activeCount: 0 };

// Returns the filtered rows and facet counts for a view, memoized on its inputs.
export function useDataset<V extends DatasetView>(view: V): DatasetResult<RowTypes[V]> {
  const def = DATASETS[view] as Dataset<RowTypes[V]>;
  if (!S.report || !S.idx) return EMPTY;
  const selected: FacetSelection = S.facets[view] || {};
  const q = S.query[view] || '';
  const deps: unknown[] = [S.report, selected, q, S.ns, S.mutedVer, S.changes];
  const hit = cache.get(view);
  if (hit && hit.deps.every((d, i) => d === deps[i])) return hit.value as DatasetResult<RowTypes[V]>;

  const all = def.rows(S.report);
  const showMuted = (selected.state || []).includes('Muted');
  const searched = q ? all.filter((r) => matchTokens(def.search(r), q)) : all;
  const mutedCount = def.muted ? searched.filter(def.muted).length : 0;
  const unmuted = def.muted && !showMuted ? searched.filter((r) => !def.muted!(r)) : searched;
  const nsOk = (r: RowTypes[V]) => !def.ns || !S.ns.length || def.ns(r).some((n) => S.ns.includes(n));

  const base = unmuted.filter(nsOk);
  const rows = base.filter((r) => passes(def, r, selected));

  const facets: FacetResult[] = def.facets.map((fd) => {
    const counts = new Map<string, number>();
    const pool = fd.key === 'state' ? searched.filter(nsOk) : base;
    for (const r of pool) {
      if (!passes(def, r, selected, fd.key)) continue;
      for (const v of toArr(fd.get(r))) counts.set(v, (counts.get(v) || 0) + 1);
    }
    const sel = (selected[fd.key] || []).map(String);
    for (const v of sel) if (!counts.has(v)) counts.set(v, 0);
    const values = [...counts.entries()].map(([value, count]) => ({ value, count, selected: sel.includes(value) }));
    values.sort(fd.order ? (a, b) => orderIndex(fd.order!, a.value) - orderIndex(fd.order!, b.value) : (a, b) => b.count - a.count || a.value.localeCompare(b.value));
    return { key: fd.key, label: fd.label, values };
  });

  if (def.ns) {
    const counts = new Map<string, number>();
    for (const r of unmuted) {
      if (!passes(def, r, selected)) continue;
      for (const n of def.ns(r)) if (n) counts.set(n, (counts.get(n) || 0) + 1);
    }
    for (const n of S.ns) if (!counts.has(n)) counts.set(n, 0);
    facets.splice(1, 0, {
      key: 'namespace', label: 'Namespace', global: true,
      values: [...counts.entries()].map(([value, count]) => ({ value, count, selected: S.ns.includes(value) })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
    });
  }

  const value: DatasetResult<RowTypes[V]> = {
    rows, base, facets, total: all.length, mutedCount,
    activeCount: Object.values(selected).filter((v) => v?.length).length + (def.ns && S.ns.length ? 1 : 0) + (q ? 1 : 0),
  };
  cache.set(view, { deps, value });
  return value;
}
