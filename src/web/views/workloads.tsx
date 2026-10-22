// Workloads: Deployments, StatefulSets, DaemonSets, Jobs and CronJobs with their health.
import { useState } from 'preact/hooks';
import type { WorkloadRow } from '../../shared/types';
import { useStore, inspect } from '../app/store';
import { useDataset, health, HEALTH_ORDER } from '../app/data';
import { SEV_RANK, age, truncate } from '../app/fmt';
import { Bar } from '../components/ui';
import { DataTable, type Column } from '../components/table';
import { HealthCell, PageHeader, ProblemCounts, StatusText, Toolbar, selectedKeyFor, topProblem } from './common';

type Group = 'none' | 'kind' | 'namespace' | 'status' | 'health';

const GROUPS: { value: Group; label: string }[] = [
  { value: 'none', label: 'None' }, { value: 'health', label: 'Health' }, { value: 'kind', label: 'Kind' }, { value: 'namespace', label: 'Namespace' }, { value: 'status', label: 'Status' },
];

const wkey = (w: { kind: string; namespace: string; name: string }) => `${w.kind}/${w.namespace}/${w.name}`;

function worstRank(ids: string[]): number {
  const f = topProblem(ids);
  return f ? SEV_RANK[f.severity]! : 0;
}

export function Workloads() {
  useStore();
  const ds = useDataset('workloads');
  const [group, setGroup] = useState<Group>('health');
  const columns: Column<WorkloadRow>[] = [
    { key: 'h', label: '', width: '34px', sort: (w) => -worstRank(w.problems), render: (w) => <HealthCell ids={w.problems} /> },
    {
      key: 'name', label: 'Workload', sort: (w) => w.name,
      render: (w) => (
        <div>
          <div class="cell-title mono">{w.name}</div>
          <div class="cell-sub"><span class="kind-chip">{w.kind}</span> {w.namespace}</div>
        </div>
      ),
    },
    { key: 'status', label: 'Status', width: '150px', sort: (w) => w.status, render: (w) => <StatusText status={w.status} /> },
    {
      key: 'ready', label: 'Ready', width: '150px', sort: (w) => (w.desired ? w.ready / w.desired : 1),
      render: (w) => (w.kind === 'CronJob' ? (
        <span class="muted small">{w.schedule}</span>
      ) : w.desired != null ? (
        <Bar value={w.ready} max={w.desired || 1} tone={w.desired === 0 ? 'muted' : w.ready >= w.desired ? 'ok' : w.ready === 0 ? 'crit' : 'warn'} label={`${w.ready}/${w.desired}`} thin />
      ) : <span class="muted">—</span>),
    },
    {
      key: 'problem', label: 'Main problem',
      render: (w) => {
        const f = topProblem(w.problems);
        return f ? <span class="cell-problem">{truncate(f.title, 110)}</span> : <span class="muted">—</span>;
      },
    },
    { key: 'pc', label: 'Problems', width: '96px', className: 'col-lg', sort: (w) => -w.problems.length, render: (w) => <ProblemCounts ids={w.problems} /> },
    { key: 'img', label: 'Images', width: '22%', className: 'col-lg', render: (w) => <span class="mono small muted" title={w.images.join('\n')}>{truncate(w.images[0] || '', 48)}{w.images.length > 1 ? ` +${w.images.length - 1}` : ''}</span> },
    { key: 'age', label: 'Age', width: '70px', className: 'nowrap muted col-md', sort: (w) => -Date.parse(w.created), render: (w) => age(w.created) },
  ];
  const groupBy = group === 'none' ? null : (w: WorkloadRow) => (group === 'health' ? health(w.problems) : group === 'kind' ? w.kind : group === 'namespace' ? w.namespace : w.status);
  return (
    <div class="page">
      <PageHeader icon="workloads" title="Workloads" subtitle={`${ds.rows.length} of ${ds.total} workloads`} />
      <Toolbar view="workloads" placeholder="Search workloads, images, namespaces…" group={group} onGroup={setGroup} groupOptions={GROUPS} />
      <DataTable id="workloads" columns={columns} rows={ds.rows} rowKey={wkey} onOpen={(w) => inspect({ type: 'workload', kind: w.kind, namespace: w.namespace, name: w.name })}
        selectedKey={selectedKeyFor('workload', wkey)} groupBy={groupBy}
        groupOrder={group === 'health' ? (a, _ar, b) => HEALTH_ORDER.indexOf(a as never) - HEALTH_ORDER.indexOf(b as never) : undefined}
        rowClass={(w) => { const f = topProblem(w.problems); return f ? `sevrow-${f.severity}` : ''; }}
        emptyTitle={ds.total ? 'No workload matches the filters' : 'No workload found'} />
    </div>
  );
}
