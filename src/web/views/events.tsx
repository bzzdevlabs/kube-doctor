// Events: timeline histogram and a groupable list of every recent event.
import { useState } from 'preact/hooks';
import { useStore, inspect, findingsFor } from '../app/store';
import { useDataset, type EventRowK } from '../app/data';
import { ago, clock, dateTime, truncate } from '../app/fmt';
import { Badge, Section, ObjRefLink, targetFor } from '../components/ui';
import { Histogram, type Bucket } from '../components/charts';
import { DataTable, type Column } from '../components/table';
import { PageHeader, Toolbar } from './common';

type Group = 'none' | 'reason' | 'object' | 'kind' | 'namespace';

const GROUPS: { value: Group; label: string }[] = [
  { value: 'none', label: 'None' }, { value: 'reason', label: 'Reason' }, { value: 'object', label: 'Object' }, { value: 'kind', label: 'Object kind' }, { value: 'namespace', label: 'Namespace' },
];

// Buckets spanning the events' time range (at most the last 6 hours), newest on the right.
function buckets(rows: EventRowK[]): Bucket[] {
  const now = Date.now();
  const times = rows.map((e) => e.last).filter((t): t is number => t != null && t > now - 6 * 3600_000);
  const oldest = times.length ? Math.min(...times) : now - 3600_000;
  const range = Math.max(3600_000, now - oldest);
  const n = 30;
  const span = Math.ceil(range / n);
  const start = now - n * span;
  const out: Bucket[] = Array.from({ length: n }, (_, i) => ({ t: start + i * span, span, values: { warning: 0, normal: 0 } }));
  for (const e of rows) {
    if (!e.last || e.last < start) continue;
    out[Math.min(n - 1, Math.floor((e.last - start) / span))]!.values[e.type === 'Warning' ? 'warning' : 'normal']! += 1;
  }
  return out;
}

function groupOf(g: Group, e: EventRowK): string {
  switch (g) {
    case 'reason': return e.reason;
    case 'object': return `${e.object.kind} ${e.object.namespace ? `${e.object.namespace}/` : ''}${e.object.name}`;
    case 'kind': return e.object.kind;
    case 'namespace': return e.object.namespace || '(cluster-wide)';
    default: return '';
  }
}

export function Events() {
  const s = useStore();
  const ds = useDataset('events');
  const [group, setGroup] = useState<Group>('none');
  const total = s.report?.events.total ?? 0;
  const columns: Column<EventRowK>[] = [
    { key: 'type', label: 'Type', width: '84px', className: 'col-md', sort: (e) => e.type, render: (e) => <Badge tone={e.type === 'Warning' ? 'warn' : 'neutral'}>{e.type}</Badge> },
    { key: 'reason', label: 'Reason', width: '150px', sort: (e) => e.reason, render: (e) => <b class="small">{e.reason}</b> },
    {
      key: 'obj', label: 'Object', width: '26%', sort: (e) => `${e.object.namespace}/${e.object.name}`,
      render: (e) => {
        const linked = findingsFor(e.object.kind, e.object.namespace, e.object.name).length > 0;
        return <span class="cell-obj"><ObjRefLink obj={e.object} />{linked && <span class="tag" title="Kube Doctor reported a problem on this object">problem</span>}{e.container ? <span class="muted small"> [{e.container}]</span> : null}</span>;
      },
    },
    { key: 'msg', label: 'Message', render: (e) => <span class="event-msg" title={e.message}>{truncate(e.message, 240)}</span> },
    { key: 'count', label: 'Count', width: '70px', className: 'num col-lg', sort: (e) => -e.count, render: (e) => (e.count > 1 ? <b>×{e.count}</b> : <span class="muted">1</span>) },
    { key: 'last', label: 'Last seen', width: '104px', className: 'nowrap', sort: (e) => -(e.last || 0), render: (e) => <span title={`first ${dateTime(e.first)}\nlast ${dateTime(e.last)}`}>{e.last ? ago(e.last) : '—'}<div class="cell-sub">{clock(e.last)}</div></span> },
  ];
  const groupBy = group === 'none' ? null : (e: EventRowK) => groupOf(group, e);
  const warnings = ds.rows.filter((e) => e.type === 'Warning').length;
  return (
    <div class="page">
      <PageHeader icon="events" title="Events" subtitle={`${ds.rows.length} shown · ${warnings} warnings${total > (s.report?.events.rows.length ?? 0) ? ` · ${total} events in the cluster, the most recent ${s.report?.events.rows.length} are kept` : ''}`} />
      <Section id="events.hist" title="Activity" icon="clock" subtitle="events by last occurrence">
        <Histogram buckets={buckets(ds.rows)} height={84} series={[{ key: 'warning', tone: 'warn', label: 'warning events' }, { key: 'normal', tone: 'muted', label: 'normal events' }]} />
      </Section>
      <Toolbar view="events" placeholder="Search reasons, messages, objects…" group={group} onGroup={setGroup} groupOptions={GROUPS} />
      <DataTable id="events" columns={columns} rows={ds.rows} rowKey={(e) => e._k} defaultSort={{ key: 'last', dir: 'asc' }}
        onOpen={(e) => { const t = targetFor(e.object); if (t) inspect(t); }}
        groupBy={groupBy} rowClass={(e) => (e.type === 'Warning' ? 'event-warning' : '')}
        groupLabel={(g, list) => <span><b>{g}</b> <span class="muted small">{list.filter((e) => e.type === 'Warning').length} warnings</span></span>}
        emptyTitle={ds.total ? 'No event matches the filters' : 'No recent event'} emptyText="Kubernetes keeps events for about an hour by default." />
    </div>
  );
}
