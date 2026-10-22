// Namespaces: health per namespace; clicking one scopes every page to it.
import type { NamespaceRow } from '../../shared/types';
import { S, useStore, setNamespaces, drill } from '../app/store';
import { useDataset, health, HEALTH_ORDER } from '../app/data';
import { SEV_RANK, age } from '../app/fmt';
import { StackBar } from '../components/ui';
import { DataTable, type Column } from '../components/table';
import { HealthCell, PageHeader, ProblemCounts, Toolbar, topProblem } from './common';

export function Namespaces() {
  const s = useStore();
  const ds = useDataset('namespaces');
  const columns: Column<NamespaceRow>[] = [
    { key: 'h', label: '', width: '34px', sort: (n) => { const f = topProblem(n.problems); return f ? -SEV_RANK[f.severity]! : 0; }, render: (n) => <HealthCell ids={n.problems} /> },
    { key: 'name', label: 'Namespace', sort: (n) => n.name, render: (n) => <div><span class="cell-title mono">{n.name}</span>{n.phase !== 'Active' && <div class="cell-sub warn-text">{n.phase}</div>}</div> },
    {
      key: 'pods', label: 'Pods', width: '220px', sort: (n) => -n.pods.total,
      render: (n) => (
        <div class="ns-pods">
          <StackBar total={n.pods.total} parts={[
            { value: n.pods.running, tone: 'ok', label: 'running' }, { value: n.pods.succeeded, tone: 'muted', label: 'succeeded' },
            { value: n.pods.pending, tone: 'warn', label: 'pending' }, { value: n.pods.failed, tone: 'crit', label: 'failed' },
          ]} />
          <span class="small">{n.pods.running}/{n.pods.total}{n.pods.pending ? <span class="warn-text"> · {n.pods.pending} pending</span> : null}{n.pods.failed ? <span class="crit-text"> · {n.pods.failed} failed</span> : null}</span>
        </div>
      ),
    },
    { key: 'wl', label: 'Workloads', width: '96px', className: 'num col-md', sort: (n) => -n.workloads, render: (n) => n.workloads },
    { key: 'restarts', label: 'Restarts', width: '90px', className: 'num', sort: (n) => -n.restarts, render: (n) => n.restarts || <span class="muted">0</span> },
    { key: 'pc', label: 'Problems', width: '110px', sort: (n) => -n.problems.length, render: (n) => <ProblemCounts ids={n.problems} /> },
    {
      key: 'main', label: 'Main problem', className: 'col-lg',
      render: (n) => {
        const f = topProblem(n.problems);
        return f ? <span class="cell-problem">{f.title}</span> : <span class="muted">—</span>;
      },
    },
    { key: 'age', label: 'Age', width: '70px', className: 'nowrap muted col-md', sort: (n) => -(n.created ? Date.parse(n.created) : 0), render: (n) => (n.created ? age(n.created) : '—') },
    {
      key: 'go', label: '', width: '150px', className: 'col-lg',
      render: (n) => (
        <span class="row-links">
          <button type="button" class="link small" onClick={(e) => { e.stopPropagation(); setNamespaces([n.name]); drill('incidents'); }}>Root causes</button>
          <button type="button" class="link small" onClick={(e) => { e.stopPropagation(); setNamespaces([n.name]); drill('pods'); }}>Pods</button>
        </span>
      ),
    },
  ];
  const toggle = (n: NamespaceRow) => setNamespaces(S.ns.includes(n.name) ? S.ns.filter((x) => x !== n.name) : [...S.ns, n.name]);
  return (
    <div class="page">
      <PageHeader icon="namespaces" title="Namespaces" subtitle={s.ns.length ? `Scoped to ${s.ns.join(', ')} — click a row to add or remove it` : 'Click a row to scope every page to that namespace'} />
      <Toolbar view="namespaces" placeholder="Search namespaces…" />
      <DataTable id="namespaces" columns={columns} rows={ds.rows} rowKey={(n) => n.name} onOpen={toggle}
        selectedKey={null} groupBy={null} defaultSort={{ key: 'h', dir: 'asc' }}
        rowClass={(n) => `${s.ns.includes(n.name) ? 'selected' : ''} ${health(n.problems) === HEALTH_ORDER[0] ? 'sevrow-critical' : ''}`}
        emptyTitle="No namespace matches the filters" />
    </div>
  );
}
