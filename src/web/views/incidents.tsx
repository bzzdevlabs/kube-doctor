// Root causes: one collapsible card per independent incident, with its impact tree.
import { useState } from 'preact/hooks';
import type { Finding } from '../../shared/types';
import { Icon } from '../app/icons';
import { S, useStore, inspectFinding, toggleMute, isMuted, isNew, currentTarget } from '../app/store';
import { useDataset, type IncidentRow } from '../app/data';
import { SEV_RANK, SEV_TONE, ago, plural, truncate } from '../app/fmt';
import { Button, ConfidenceMeter, Dot, Empty, IconButton, NewBadge, ObjRefLink, SevBadge, Segmented } from '../components/ui';
import { PageHeader, Toolbar } from './common';

type Group = 'none' | 'namespace' | 'category';
type Sort = 'severity' | 'impact' | 'recent';

export function Tree({ id, depth, seen }: { id: string; depth: number; seen: Set<string> }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const kids = (S.idx!.effects.get(id) || []).filter((k) => !seen.has(k));
  if (!kids.length || depth > 6) return null;
  const limit = showAll ? kids.length : 8;
  for (const k of kids) seen.add(k);
  return (
    <ul class="tree">
      {kids.slice(0, limit).map((k) => {
        const f = S.idx!.byId.get(k)!;
        const hasKids = (S.idx!.effects.get(k) || []).some((x) => !seen.has(x));
        const isCollapsed = collapsed.has(k);
        return (
          <li key={k}>
            <div class={`tree-node${currentTarget()?.type === 'finding' && (currentTarget() as { id: string }).id === k ? ' selected' : ''}`}>
              {hasKids ? (
                <button type="button" class="tree-toggle" onClick={() => { const n = new Set(collapsed); if (isCollapsed) n.delete(k); else n.add(k); setCollapsed(n); }} aria-label={isCollapsed ? 'Expand' : 'Collapse'}>
                  <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={12} />
                </button>
              ) : <span class="tree-toggle-gap" />}
              <button type="button" class="tree-label" onClick={() => inspectFinding(k)}>
                <Dot tone={SEV_TONE[f.severity]} />
                <span class="cat-chip">{f.category}</span>
                <span class="mono muted">{f.object.kind} {f.object.namespace ? `${f.object.namespace}/` : ''}{f.object.name}</span>
                {f.instances.length > 1 && <span class="tag">×{f.instances.length}</span>}
                <span class="tree-title">{truncate(f.title, 110)}</span>
              </button>
            </div>
            {!isCollapsed && hasKids && <Tree id={k} depth={depth + 1} seen={seen} />}
          </li>
        );
      })}
      {kids.length > limit && <li><button type="button" class="link small" onClick={() => setShowAll(true)}>+ {kids.length - limit} more</button></li>}
    </ul>
  );
}

function IncidentCard({ inc, open, onToggle }: { inc: IncidentRow; open: boolean; onToggle: () => void }) {
  const f: Finding = inc.root;
  const selected = currentTarget()?.type === 'finding' && (currentTarget() as { id: string }).id === f.id;
  const muted = isMuted(f.id);
  return (
    <article class={`incident sev-${inc.severity}${open ? ' open' : ''}${selected ? ' selected' : ''}${muted ? ' muted-row' : ''}`}>
      <div class="incident-head" onClick={onToggle}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} className="chev" />
        <SevBadge sev={inc.severity} />
        <div class="incident-main">
          <div class="incident-title">
            <button type="button" class="title-link" onClick={(e) => { e.stopPropagation(); inspectFinding(f.id); }}>{f.title}</button>
            {isNew(f.id) && <NewBadge />}
            {muted && <span class="badge badge-neutral">muted</span>}
          </div>
          <div class="incident-rc">{open ? null : truncate(f.rootCause.summary, 200)}</div>
        </div>
        <div class="incident-meta">
          <span class="cat-chip">{f.category}</span>
          {inc.impacted.length > 0 && <span class="badge badge-neutral" title="Problems caused by this root cause">↳ {plural(inc.impacted.length, 'impact')}</span>}
          {inc.pods > 0 && <span class="muted small">{plural(inc.pods, 'pod')}</span>}
          <span class="muted small ns-list-inline">{inc.namespaces.filter(Boolean).slice(0, 3).join(', ') || 'cluster-wide'}</span>
          <IconButton icon={muted ? 'eye' : 'eyeOff'} title={muted ? 'Unmute' : 'Mute (hide this known issue)'} onClick={(e) => { e.stopPropagation(); toggleMute(f); }} />
        </div>
      </div>
      {open && (
        <div class="incident-body">
          <div class="rc-block">
            <div class="rc-label">Root cause <ConfidenceMeter level={f.rootCause.confidence} />{f.rootCause.fromLogs && <span class="tag">from logs</span>}</div>
            <p class="rc-summary">{f.rootCause.summary}</p>
            <div class="rc-meta"><ObjRefLink obj={f.object} />{f.lastSeen || f.since ? <span class="muted small">· seen {ago(f.lastSeen || f.since)}</span> : null}</div>
            {f.fixes[0] && <div class="rc-fix"><Icon name="wrench" size={14} /><span>{f.fixes[0]}</span></div>}
          </div>
          {inc.impacted.length > 0 && (
            <div class="impact">
              <div class="impact-label">Impact chain — what this breaks</div>
              <Tree id={f.id} depth={0} seen={new Set([f.id])} />
            </div>
          )}
          <div class="incident-actions">
            <Button icon="panelRight" size="sm" onClick={() => inspectFinding(f.id)}>Open details</Button>
          </div>
        </div>
      )}
    </article>
  );
}

export function Incidents() {
  const s = useStore();
  const ds = useDataset('incidents');
  const [group, setGroup] = useState<Group>('none');
  const [sort, setSort] = useState<Sort>('severity');
  const [open, setOpen] = useState<Set<string> | null>(null);
  const rows = [...ds.rows].sort((a, b) => {
    if (sort === 'impact') return b.impacted.length - a.impacted.length || SEV_RANK[b.severity]! - SEV_RANK[a.severity]!;
    if (sort === 'recent') return (s.changes?.firstSeen[b.rootId] ?? 0) - (s.changes?.firstSeen[a.rootId] ?? 0);
    return SEV_RANK[b.severity]! - SEV_RANK[a.severity]! || b.impacted.length - a.impacted.length;
  });
  // By default the first card is expanded.
  const openSet = open ?? new Set(rows.slice(0, 1).map((i) => i.id));
  const toggle = (id: string) => {
    const n = new Set(openSet);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setOpen(n);
  };
  const groups = new Map<string, IncidentRow[]>();
  for (const i of rows) {
    const keys = group === 'namespace' ? (i.namespaces.filter(Boolean).length ? i.namespaces.filter(Boolean) : ['(cluster-wide)']) : group === 'category' ? [i.root.category] : [''];
    for (const k of keys) {
      const list = groups.get(k);
      if (list) list.push(i);
      else groups.set(k, [i]);
    }
  }
  const allOpen = rows.length > 0 && rows.every((i) => openSet.has(i.id));
  return (
    <div class="page">
      <PageHeader icon="incidents" title="Root causes" subtitle="Each card is an independent problem; everything listed under it is a consequence. Fix the card, and its impacts should clear." />
      <Toolbar view="incidents" placeholder="Search root causes and their impacts…" group={group} onGroup={setGroup}
        groupOptions={[{ value: 'none', label: 'None' }, { value: 'namespace', label: 'Namespace' }, { value: 'category', label: 'Root cause type' }]}>
        <Segmented value={sort} onChange={setSort} title="Sort" options={[{ value: 'severity', label: 'Severity' }, { value: 'impact', label: 'Impact' }, { value: 'recent', label: 'Newest' }]} />
        <Button icon={allOpen ? 'collapseAll' : 'expandAll'} size="sm" variant="ghost" onClick={() => setOpen(allOpen ? new Set() : new Set(rows.map((i) => i.id)))}>{allOpen ? 'Collapse all' : 'Expand all'}</Button>
      </Toolbar>
      {!rows.length ? (
        <Empty icon="check" title={ds.total ? 'No root cause matches the filters' : 'No active problem'}>
          {ds.mutedCount ? `${ds.mutedCount} muted root cause(s) are hidden. ` : ''}Informational findings are listed under Problems.
        </Empty>
      ) : (
        [...groups.entries()].map(([g, list]) => (
          <div key={g} class="incident-group">
            {group !== 'none' && <div class="group-title"><span>{g}</span><span class="count">{list.length}</span></div>}
            <div class="incidents">{list.map((i) => <IncidentCard key={`${g}:${i.id}`} inc={i} open={openSet.has(i.id)} onToggle={() => toggle(i.id)} />)}</div>
          </div>
        ))
      )}
    </div>
  );
}
