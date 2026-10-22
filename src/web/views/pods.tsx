// Pods: every pod with its status, restarts, placement and resource usage.
import { useState } from 'preact/hooks';
import type { PodRow } from '../../shared/types';
import { useStore, inspect } from '../app/store';
import { useDataset, health, HEALTH_ORDER } from '../app/data';
import { SEV_RANK, age, ago, bytes, cpu, truncate } from '../app/fmt';
import { Bar } from '../components/ui';
import { DataTable, type Column } from '../components/table';
import { HealthCell, PageHeader, ProblemCounts, StatusText, Toolbar, selectedKeyFor, topProblem } from './common';

type Group = 'none' | 'health' | 'namespace' | 'node' | 'status' | 'owner';

const GROUPS: { value: Group; label: string }[] = [
  { value: 'none', label: 'None' }, { value: 'health', label: 'Health' }, { value: 'namespace', label: 'Namespace' }, { value: 'node', label: 'Node' },
  { value: 'status', label: 'Status' }, { value: 'owner', label: 'Owner' },
];

const pkey = (p: { namespace: string; name: string }) => `${p.namespace}/${p.name}`;

function groupOf(g: Group, p: PodRow): string {
  switch (g) {
    case 'health': return health(p.problems);
    case 'namespace': return p.namespace;
    case 'node': return p.node || '(unscheduled)';
    case 'status': return p.status;
    case 'owner': return p.owner ? `${p.owner.kind} ${p.namespace}/${p.owner.name}` : '(no owner)';
    default: return '';
  }
}

// Usage against the request (or the limit for memory when there is no request).
function Usage({ value, req, lim, fmt }: { value: number | null; req: number; lim?: number; fmt: (n: number) => string }) {
  if (value == null) return <span class="muted small">{req ? `req ${fmt(req)}` : '—'}</span>;
  const max = lim || req;
  return max ? (
    <Bar value={value} max={max} thin label={fmt(value)} title={`${fmt(value)} used${req ? ` · request ${fmt(req)}` : ''}${lim ? ` · limit ${fmt(lim)}` : ''}`} />
  ) : <span class="small" title="No request or limit set">{fmt(value)}</span>;
}

export function Pods() {
  const s = useStore();
  const ds = useDataset('pods');
  const [group, setGroup] = useState<Group>('none');
  const metrics = !!s.report?.meta.metricsAvailable;
  const cols: (Column<PodRow> | false)[] = [
    { key: 'h', label: '', width: '34px', sort: (p) => { const f = topProblem(p.problems); return f ? -SEV_RANK[f.severity]! : 0; }, render: (p) => <HealthCell ids={p.problems} /> },
    {
      key: 'name', label: 'Pod', sort: (p) => p.name,
      render: (p) => (
        <div>
          <div class="cell-title mono">{p.name}</div>
          <div class="cell-sub">{p.namespace}{p.owner ? <> · <span class="muted">{p.owner.kind}</span> {p.owner.name}</> : null}</div>
        </div>
      ),
    },
    {
      key: 'status', label: 'Status', width: '170px', sort: (p) => p.status,
      render: (p) => {
        const f = topProblem(p.problems);
        return <div><StatusText status={p.status} />{f && <div class="cell-sub" title={f.title}>{truncate(f.category, 30)}</div>}</div>;
      },
    },
    { key: 'ready', label: 'Ready', width: '64px', className: 'num', sort: (p) => p.ready, render: (p) => p.ready },
    {
      key: 'restarts', label: 'Restarts', width: '92px', className: 'num', sort: (p) => -p.restarts,
      render: (p) => (p.restarts ? <div><b class={p.restarts >= 5 ? 'crit-text' : 'warn-text'}>{p.restarts}</b>{p.lastRestart && <div class="cell-sub">{ago(p.lastRestart)}</div>}</div> : <span class="muted">0</span>),
    },
    metrics && { key: 'cpu', label: 'CPU', width: '120px', className: 'col-lg', sort: (p) => -(p.cpu ?? -1), render: (p) => <Usage value={p.cpu} req={p.reqCpu} fmt={cpu} /> },
    metrics && { key: 'mem', label: 'Memory', width: '120px', className: 'col-lg', sort: (p) => -(p.memory ?? -1), render: (p) => <Usage value={p.memory} req={p.reqMemory} lim={p.limMemory} fmt={bytes} /> },
    { key: 'node', label: 'Node', width: '160px', className: 'col-md', sort: (p) => p.node, render: (p) => (p.node ? <span class="mono small">{truncate(p.node, 28)}</span> : <span class="muted small">unscheduled</span>) },
    { key: 'pc', label: 'Problems', width: '90px', className: 'col-lg', sort: (p) => -p.problems.length, render: (p) => <ProblemCounts ids={p.problems} /> },
    { key: 'age', label: 'Age', width: '64px', className: 'nowrap muted col-md', sort: (p) => -Date.parse(p.created), render: (p) => age(p.created) },
  ];
  const columns = cols.filter((c): c is Column<PodRow> => !!c);
  const groupBy = group === 'none' ? null : (p: PodRow) => groupOf(group, p);
  return (
    <div class="page">
      <PageHeader icon="pods" title="Pods" subtitle={`${ds.rows.length} of ${ds.total} pods${metrics ? '' : ' · live usage unavailable (metrics-server not reachable)'}`} />
      <Toolbar view="pods" placeholder="Search pods, nodes, owners, images, IPs…" group={group} onGroup={setGroup} groupOptions={GROUPS} />
      <DataTable id="pods" columns={columns} rows={ds.rows} rowKey={pkey} onOpen={(p) => inspect({ type: 'pod', namespace: p.namespace, name: p.name })}
        selectedKey={selectedKeyFor('pod', pkey)} groupBy={groupBy}
        groupOrder={group === 'health' ? (a, _ar, b) => HEALTH_ORDER.indexOf(a as never) - HEALTH_ORDER.indexOf(b as never) : undefined}
        rowClass={(p) => { const f = topProblem(p.problems); return f ? `sevrow-${f.severity}` : ''; }}
        emptyTitle={ds.total ? 'No pod matches the filters' : 'No pod found'} />
    </div>
  );
}
