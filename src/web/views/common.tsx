// Page header, toolbar and small cells shared by the list views.
import type { ComponentChildren } from 'preact';
import { Icon, type IconName } from '../app/icons';
import type { Finding } from '../../shared/types';
import { S, useStore, setQuery, currentTarget, isMuted, type Target } from '../app/store';
import { rowSeverity, type DatasetView } from '../app/data';
import { SEV_RANK } from '../app/fmt';
import { Dot, SearchBox, Select, SevBadge } from '../components/ui';
import { FilterChips } from '../components/shell';

export function PageHeader({ icon, title, subtitle, children }: { icon: IconName; title: string; subtitle?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="page-header">
      <div class="page-title">
        <Icon name={icon} size={20} />
        <h1>{title}</h1>
        {subtitle && <span class="page-sub">{subtitle}</span>}
      </div>
      {children && <div class="page-actions">{children}</div>}
    </div>
  );
}

interface ToolbarProps<G extends string> {
  view: DatasetView;
  placeholder: string;
  children?: ComponentChildren;
  groupOptions?: { value: G; label: string }[];
  group?: G;
  onGroup?: (g: G) => void;
}

export function Toolbar<G extends string>({ view, placeholder, children, groupOptions, group, onGroup }: ToolbarProps<G>) {
  const s = useStore();
  return (
    <div class="toolbar-wrap">
      <div class="toolbar">
        <SearchBox id="view-search" value={s.query[view] || ''} onInput={(v) => setQuery(view, v)} placeholder={placeholder} />
        {groupOptions && group != null && onGroup && <Select label="Group by" value={group} onChange={onGroup} options={groupOptions} />}
        {children}
      </div>
      <FilterChips view={view} />
    </div>
  );
}

// Key of the row matching what the inspector currently shows, for highlighting.
export function selectedKeyFor<T extends Target['type']>(type: T, toKey: (t: Extract<Target, { type: T }>) => string): string | null {
  const t = currentTarget();
  if (!t || t.type !== type) return null;
  return toKey(t as Extract<Target, { type: T }>);
}

export function statusTone(status: string): 'ok' | 'warn' | 'crit' {
  if (/^(Running|Completed|Succeeded|Healthy|Complete|Scheduled)$/.test(status)) return 'ok';
  if (/not ready|Pending|ContainerCreating|PodInitializing|Init:\d|Terminating|Rolling out|Scaled to 0|Suspended|Running/.test(status)) return 'warn';
  return 'crit';
}

export const StatusText = ({ status }: { status: string }) => <span class={`status-text st-${statusTone(status)}`}>{status}</span>;

// Worst severity of an inventory row's problems, as a compact badge (or a green dot).
export function HealthCell({ ids }: { ids: string[] }) {
  const sev = rowSeverity(ids);
  return sev ? <SevBadge sev={sev} compact /> : <span class="health-ok" title="No problem detected"><Dot tone="ok" /></span>;
}

// "2 critical · 1 warning" style counts for an inventory row.
export function ProblemCounts({ ids }: { ids: string[] }) {
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const id of ids) {
    if (isMuted(id)) continue;
    const f = S.idx?.byId.get(id);
    if (f) counts[f.severity]++;
  }
  if (!counts.critical && !counts.warning && !counts.info) return <span class="muted">—</span>;
  return (
    <span class="pcounts">
      {counts.critical ? <span class="pc pc-crit" title="critical">{counts.critical}</span> : null}
      {counts.warning ? <span class="pc pc-warn" title="warning">{counts.warning}</span> : null}
      {counts.info ? <span class="pc pc-info" title="info">{counts.info}</span> : null}
    </span>
  );
}

// First problem title of an inventory row, worst first.
export function topProblem(ids: string[]): Finding | null {
  let best: Finding | null = null;
  for (const id of ids) {
    if (isMuted(id)) continue;
    const f = S.idx?.byId.get(id);
    if (f && (!best || SEV_RANK[f.severity]! > SEV_RANK[best.severity]!)) best = f;
  }
  return best;
}
