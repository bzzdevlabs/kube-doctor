// Nodes: capacity, requests vs usage, conditions and taints, as cards or a table.
import { useState } from 'preact/hooks';
import type { NodeSummary } from '../../shared/types';
import { S, useStore, inspect, currentTarget } from '../app/store';
import { useDataset, rowSeverity } from '../app/data';
import * as prefs from '../app/prefs';
import { SEV_TONE, age, bytes, cpu, pct, truncate, type Tone } from '../app/fmt';
import { Badge, Bar, Dot, Segmented } from '../components/ui';
import { DataTable, type Column } from '../components/table';
import { PageHeader, Toolbar, selectedKeyFor } from './common';

type Mode = 'cards' | 'table';

const nodeIds = (n: NodeSummary) => (S.idx?.byObj.get(`Node//${n.name}`) || []).map((f) => f.id);

function nodeTone(n: NodeSummary): Tone {
  if (n.ready !== 'Ready') return 'crit';
  const sev = rowSeverity(nodeIds(n));
  return sev ? SEV_TONE[sev] : 'ok';
}

// Requests (bar), usage (marker) and allocatable for one resource.
function Capacity({ label, req, lim, use, max, fmt }: { label: string; req: number; lim: number; use: number | null | undefined; max: number | null; fmt: (n: number) => string }) {
  return (
    <div class="cap-row">
      <span class="cap-label">{label}</span>
      <Bar value={req} max={max} marker={use} title={`requests ${fmt(req)} · limits ${fmt(lim)}${use != null ? ` · usage ${fmt(use)}` : ''} · allocatable ${max != null ? fmt(max) : '?'}`} />
      <span class="cap-num">{pct(req, max)}%</span>
      <span class="cap-detail muted small">{use != null ? `use ${fmt(use)} · ` : ''}req {fmt(req)} / {max != null ? fmt(max) : '?'}</span>
    </div>
  );
}

function NodeCard({ n }: { n: NodeSummary }) {
  const t = currentTarget();
  const selected = t?.type === 'node' && t.name === n.name;
  const problems = n.problems.filter((p) => p.type !== 'Ready');
  return (
    <button type="button" class={`node-card tone-${nodeTone(n)}${selected ? ' selected' : ''}`} onClick={() => inspect({ type: 'node', name: n.name })}>
      <div class="nc-head">
        <Dot tone={n.ready === 'Ready' ? 'ok' : 'crit'} />
        <span class="mono nc-name">{n.name}</span>
        <span class={`status-text st-${n.ready === 'Ready' ? 'ok' : 'crit'}`}>{n.ready}</span>
        {n.cordoned && <Badge tone="warn">cordoned</Badge>}
      </div>
      <div class="nc-meta muted small">
        {n.roles.join(', ') || 'worker'} · {n.version} · {[n.instanceType, n.zone].filter(Boolean).join(' · ') || n.os} · {age(n.created)}
      </div>
      <Capacity label="CPU" req={n.alloc.reqCpu} lim={n.alloc.limCpu} use={n.usage?.cpu} max={n.alloc.cpu} fmt={cpu} />
      <Capacity label="Memory" req={n.alloc.reqMemory} lim={n.alloc.limMemory} use={n.usage?.memory} max={n.alloc.memory} fmt={bytes} />
      <div class="cap-row">
        <span class="cap-label">Pods</span>
        <Bar value={n.alloc.pods} max={n.alloc.maxPods} />
        <span class="cap-num">{pct(n.alloc.pods, n.alloc.maxPods)}%</span>
        <span class="cap-detail muted small">{n.alloc.pods} / {n.alloc.maxPods ?? '?'}</span>
      </div>
      {(problems.length > 0 || n.taints.length > 0) && (
        <div class="nc-foot">
          {problems.map((p) => <span key={p.type} class="badge badge-crit" title={p.message}>{p.type}</span>)}
          {n.taints.slice(0, 3).map((x) => <span key={x} class="tag mono" title="Taint">{truncate(x, 44)}</span>)}
          {n.taints.length > 3 && <span class="tag">+{n.taints.length - 3} taints</span>}
        </div>
      )}
    </button>
  );
}

export function Nodes() {
  const s = useStore();
  const ds = useDataset('nodes');
  const [mode, setModeState] = useState<Mode>(() => prefs.load<Mode>('nodes.mode', 'cards'));
  const setMode = (m: Mode) => {
    setModeState(m);
    prefs.save('nodes.mode', m);
  };
  const metrics = !!s.report?.meta.metricsAvailable;
  const cols: (Column<NodeSummary> | false)[] = [
    { key: 'h', label: '', width: '34px', render: (n) => <Dot tone={nodeTone(n)} /> },
    { key: 'name', label: 'Node', sort: (n) => n.name, render: (n) => <div><div class="cell-title mono">{n.name}</div><div class="cell-sub">{n.roles.join(', ') || 'worker'}{n.zone ? ` · ${n.zone}` : ''}</div></div> },
    { key: 'status', label: 'Status', width: '130px', sort: (n) => n.ready, render: (n) => <span><span class={`status-text st-${n.ready === 'Ready' ? 'ok' : 'crit'}`}>{n.ready}</span>{n.cordoned && <> <Badge tone="warn">cordoned</Badge></>}</span> },
    { key: 'cpu', label: 'CPU requests', width: '150px', sort: (n) => -pct(n.alloc.reqCpu, n.alloc.cpu), render: (n) => <Bar value={n.alloc.reqCpu} max={n.alloc.cpu} marker={n.usage?.cpu} thin label={`${pct(n.alloc.reqCpu, n.alloc.cpu)}%`} /> },
    { key: 'mem', label: 'Memory requests', width: '150px', sort: (n) => -pct(n.alloc.reqMemory, n.alloc.memory), render: (n) => <Bar value={n.alloc.reqMemory} max={n.alloc.memory} marker={n.usage?.memory} thin label={`${pct(n.alloc.reqMemory, n.alloc.memory)}%`} /> },
    metrics && { key: 'ucpu', label: 'CPU use', width: '84px', className: 'num col-lg', sort: (n) => -(n.usage?.cpuPct ?? -1), render: (n) => (n.usage ? `${n.usage.cpuPct}%` : '—') },
    metrics && { key: 'umem', label: 'Mem use', width: '84px', className: 'num col-lg', sort: (n) => -(n.usage?.memoryPct ?? -1), render: (n) => (n.usage ? `${n.usage.memoryPct}%` : '—') },
    { key: 'pods', label: 'Pods', width: '80px', className: 'num', sort: (n) => -n.alloc.pods, render: (n) => `${n.alloc.pods}/${n.alloc.maxPods ?? '?'}` },
    { key: 'cond', label: 'Conditions', className: 'col-md', render: (n) => n.problems.filter((p) => p.type !== 'Ready').map((p) => <span key={p.type} class="badge badge-crit">{p.type}</span>) },
    { key: 'ver', label: 'Version', width: '110px', className: 'muted small col-lg', sort: (n) => n.version, render: (n) => n.version },
    { key: 'age', label: 'Age', width: '64px', className: 'nowrap muted col-md', sort: (n) => -Date.parse(n.created), render: (n) => age(n.created) },
  ];
  const columns = cols.filter((c): c is Column<NodeSummary> => !!c);
  const notReady = ds.rows.filter((n) => n.ready !== 'Ready').length;
  return (
    <div class="page">
      <PageHeader icon="nodes" title="Nodes" subtitle={`${ds.rows.length - notReady}/${ds.rows.length} ready${metrics ? '' : ' · live usage unavailable'}`} />
      <Toolbar view="nodes" placeholder="Search nodes, roles, zones, versions…">
        <Segmented value={mode} onChange={setMode} title="Display" options={[{ value: 'cards', label: 'Cards', icon: 'grid' }, { value: 'table', label: 'Table', icon: 'list' }]} />
      </Toolbar>
      {mode === 'cards' ? (
        ds.rows.length ? <div class="node-cards">{[...ds.rows].sort((a, b) => (a.ready === 'Ready' ? 1 : 0) - (b.ready === 'Ready' ? 1 : 0) || a.name.localeCompare(b.name)).map((n) => <NodeCard key={n.name} n={n} />)}</div>
          : <div class="table-card"><div class="empty"><div class="empty-title">No node matches the filters</div></div></div>
      ) : (
        <DataTable id="nodes" columns={columns} rows={ds.rows} rowKey={(n) => n.name} onOpen={(n) => inspect({ type: 'node', name: n.name })}
          selectedKey={selectedKeyFor('node', (t) => t.name)} rowClass={(n) => (n.ready !== 'Ready' ? 'sevrow-critical' : '')}
          emptyTitle={ds.total ? 'No node matches the filters' : 'No node visible'} />
      )}
      <p class="footnote muted small">Bars show resource <b>requests</b> against allocatable capacity; the tick marks live usage when metrics-server is available.</p>
    </div>
  );
}
