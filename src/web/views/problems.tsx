// Problems: every finding in a sortable, groupable table.
import { useState } from 'preact/hooks';
import type { Finding } from '../../shared/types';
import { S, useStore, inspectFinding, toggleMute, isMuted, isNew } from '../app/store';
import { useDataset } from '../app/data';
import { SEV_RANK, ago, truncate } from '../app/fmt';
import { IconButton, NewBadge, SevBadge } from '../components/ui';
import { DataTable, type Column } from '../components/table';
import { PageHeader, Toolbar, selectedKeyFor } from './common';

type Group = 'none' | 'severity' | 'category' | 'namespace' | 'kind' | 'root' | 'owner';

const GROUPS: { value: Group; label: string }[] = [
  { value: 'none', label: 'None' }, { value: 'root', label: 'Root cause' }, { value: 'severity', label: 'Severity' }, { value: 'category', label: 'Type' },
  { value: 'namespace', label: 'Namespace' }, { value: 'kind', label: 'Object kind' }, { value: 'owner', label: 'Owner' },
];

function groupKey(g: Group, f: Finding): string {
  switch (g) {
    case 'severity': return f.severity;
    case 'category': return f.category;
    case 'namespace': return f.object.namespace || '(cluster-wide)';
    case 'kind': return f.object.kind;
    case 'owner': return f.owner ? `${f.owner.kind} ${f.owner.namespace}/${f.owner.name}` : '(no owner)';
    case 'root': return f.rootCause.inherited?.id ?? (f.causedBy.length ? f.causedBy[0]! : f.id);
    default: return '';
  }
}

export function Problems() {
  useStore();
  const ds = useDataset('problems');
  const [group, setGroup] = useState<Group>('none');
  const columns: Column<Finding>[] = [
    { key: 'sev', label: 'Severity', width: '96px', sort: (f) => -SEV_RANK[f.severity]!, render: (f) => <SevBadge sev={f.severity} /> },
    {
      key: 'title', label: 'Problem', className: 'col-main', sort: (f) => f.title,
      render: (f) => (
        <div>
          <div class="cell-title">{f.title}{isNew(f.id) && <> <NewBadge /></>}{isMuted(f.id) && <> <span class="badge badge-neutral">muted</span></>}</div>
          <div class="cell-sub"><span class="cat-chip">{f.category}</span>{f.tags.filter((t) => t !== f.category).slice(0, 3).map((t) => <span key={t} class="tag">{t}</span>)}</div>
        </div>
      ),
    },
    {
      key: 'object', label: 'Object', className: 'col-md', sort: (f) => `${f.object.kind}/${f.object.name}`,
      render: (f) => (
        <div>
          <div class="mono small"><span class="muted">{f.object.kind}</span> {f.object.name}</div>
          <div class="cell-sub">{f.object.namespace || 'cluster'}{f.instances.length > 1 ? ` · ${f.instances.length} pods` : ''}</div>
        </div>
      ),
    },
    {
      key: 'rc', label: 'Root cause', className: 'col-lg',
      render: (f) => (
        <div class="cell-rc">
          {f.causedBy.length ? <span class="badge badge-neutral" title="This is a consequence of another problem">symptom</span> : <span class="badge badge-accent" title="Nothing upstream: this is a root cause">root</span>}
          <span>{truncate(f.rootCause.inherited ? f.rootCause.inherited.title : f.rootCause.summary, 150)}</span>
        </div>
      ),
    },
    { key: 'seen', label: 'Last seen', width: '110px', className: 'nowrap muted col-md', sort: (f) => -(f.lastSeen || f.since || 0), render: (f) => (f.lastSeen || f.since ? ago(f.lastSeen || f.since) : '—') },
    {
      key: 'act', label: '', width: '44px',
      render: (f) => <IconButton icon={isMuted(f.id) ? 'eye' : 'eyeOff'} title={isMuted(f.id) ? 'Unmute' : 'Mute this known issue'} className="row-action" onClick={(e) => { e.stopPropagation(); toggleMute(f); }} />,
    },
  ];
  const groupBy = group === 'none' ? null : (f: Finding) => groupKey(group, f);
  return (
    <div class="page">
      <PageHeader icon="problems" title="Problems" subtitle={`${ds.rows.length} of ${ds.total} findings${ds.mutedCount ? ` · ${ds.mutedCount} muted` : ''}`} />
      <Toolbar view="problems" placeholder="Search problems, objects, pods, root causes…" group={group} onGroup={setGroup} groupOptions={GROUPS} />
      <DataTable id="problems" columns={columns} rows={ds.rows} rowKey={(f) => f.id} onOpen={(f) => inspectFinding(f.id)}
        selectedKey={selectedKeyFor('finding', (t) => t.id)} groupBy={groupBy}
        groupLabel={(g, list) => {
          if (group === 'root') {
            const root = S.idx!.byId.get(g);
            return root ? <span class="group-root"><SevBadge sev={root.severity} compact /><b>{root.title}</b></span> : <b>{g}</b>;
          }
          if (group === 'severity') return <SevBadge sev={list[0]!.severity} />;
          return <b>{g}</b>;
        }}
        groupOrder={(_a, ar, _b, br) => SEV_RANK[br[0]!.severity]! - SEV_RANK[ar[0]!.severity]! || br.length - ar.length}
        rowClass={(f) => `sevrow-${f.severity}${isMuted(f.id) ? ' muted-row' : ''}`}
        emptyTitle={ds.total ? 'No problem matches the filters' : 'No problem found'} />
    </div>
  );
}
