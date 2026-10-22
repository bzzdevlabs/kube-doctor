// Inspector page for one node: conditions, capacity, pods, problems, events, YAML.
import { Icon } from '../app/icons';
import { useStore, findingsFor, copy, drill } from '../app/store';
import { age, bytes, cpu, dateTime, pct } from '../app/fmt';
import { Badge, Bar, Button, KV } from '../components/ui';
import { EventList, Hero, InspSection, NotFound, PodMiniTable, ProblemList, RawObject, eventsFor, useInspectorTab } from './common';

function CapRow({ label, req, lim, use, max, fmt }: { label: string; req: number; lim: number; use: number | null | undefined; max: number | null; fmt: (n: number) => string }) {
  return (
    <div class="cap-block">
      <div class="cap-block-head"><b>{label}</b><span class="muted small">allocatable {max != null ? fmt(max) : '?'}</span></div>
      <div class="cap-line"><span>Requests</span><Bar value={req} max={max} label={`${fmt(req)} · ${pct(req, max)}%`} /></div>
      <div class="cap-line"><span>Limits</span><Bar value={lim} max={max} tone={max && lim > max ? 'warn' : 'muted'} label={`${fmt(lim)} · ${pct(lim, max)}%`} /></div>
      {use != null && <div class="cap-line"><span>Usage</span><Bar value={use} max={max} label={`${fmt(use)} · ${pct(use, max)}%`} /></div>}
    </div>
  );
}

export function NodePage({ name }: { name: string }) {
  const s = useStore();
  const n = s.idx?.nodes.get(name);
  const pods = (s.report?.inventory.pods || []).filter((p) => p.node === name);
  const own = findingsFor('Node', '', name);
  const onNode = (s.report?.findings || []).filter((f) => f.object.kind !== 'Node' && (f.node === name || f.instances.some((i) => i.node === name)));
  const events = eventsFor([{ kind: 'Node', namespace: '', name }]);
  const [tab, tabs] = useInspectorTab('node', [
    { id: 'overview', label: 'Overview', icon: 'nodes' },
    { id: 'pods', label: 'Pods', icon: 'pods', count: pods.length },
    { id: 'problems', label: 'Problems', icon: 'problems', count: own.length + onNode.length },
    { id: 'events', label: 'Events', icon: 'events', count: events.length },
    { id: 'yaml', label: 'YAML', icon: 'file' },
  ], 'overview');
  if (!n) return <NotFound what={`Node ${name}`} />;
  const bad = n.problems.filter((p) => p.type !== 'Ready' || n.ready !== 'Ready');
  return (
    <div class="insp-page">
      <Hero icon={<Icon name="nodes" size={14} />} kind="Node"
        badges={<><span class={`status-text st-${n.ready === 'Ready' ? 'ok' : 'crit'}`}>{n.ready}</span>{n.cordoned && <Badge tone="warn">cordoned</Badge>}</>}
        title={<span class="mono">{n.name}</span>}
        sub={<span class="muted">{n.roles.join(', ') || 'worker'} · {n.version} · {[n.instanceType, n.zone].filter(Boolean).join(' · ')}</span>}
        actions={<>
          <Button icon="pods" size="sm" onClick={() => drill('pods', { node: [n.name] })}>Pods on this node</Button>
          <Button icon="copy" size="sm" onClick={() => void copy(`kubectl describe node ${n.name}`, 'Command copied')}>describe cmd</Button>
        </>} />
      {tabs}
      {tab === 'overview' && (
        <div class="insp-body">
          {bad.length > 0 && (
            <InspSection title="Conditions" icon="problems">
              <ul class="checks">{bad.map((p) => <li key={p.type}><Badge tone="crit">{p.type === 'Ready' ? n.ready : p.type}</Badge><span class="small">{p.reason ? <b>{p.reason}</b> : null} {p.message}</span></li>)}</ul>
            </InspSection>
          )}
          {own.length > 0 && <InspSection title="Problems on this node" icon="problems" count={own.length}><ProblemList findings={own} /></InspSection>}
          <InspSection title="Capacity" icon="overview">
            <CapRow label="CPU" req={n.alloc.reqCpu} lim={n.alloc.limCpu} use={n.usage?.cpu} max={n.alloc.cpu} fmt={cpu} />
            <CapRow label="Memory" req={n.alloc.reqMemory} lim={n.alloc.limMemory} use={n.usage?.memory} max={n.alloc.memory} fmt={bytes} />
            <div class="cap-block"><div class="cap-line"><span>Pods</span><Bar value={n.alloc.pods} max={n.alloc.maxPods} label={`${n.alloc.pods} / ${n.alloc.maxPods ?? '?'}`} /></div></div>
            {n.alloc.partial && <div class="muted small">Totals are partial: not every pod on this node was readable.</div>}
          </InspSection>
          <InspSection title="System" icon="info">
            <KV items={[
              ['Roles', n.roles.join(', ') || 'worker'],
              ['Kubelet', n.version],
              ['OS / arch', `${n.os}${n.arch ? ` / ${n.arch}` : ''}`],
              ['Runtime', n.runtime],
              ['Instance type', n.instanceType],
              ['Zone', n.zone],
              ['Ready since', n.readySince ? `${dateTime(n.readySince)} (${age(n.readySince)})` : null],
              ['Created', `${dateTime(n.created)} (${age(n.created)})`],
              ['Taints', n.taints.length ? <div class="tags">{n.taints.map((t) => <span key={t} class="tag mono">{t}</span>)}</div> : <span class="muted">none</span>],
            ]} />
          </InspSection>
        </div>
      )}
      {tab === 'pods' && <div class="insp-body"><PodMiniTable pods={[...pods].sort((a, b) => b.problems.length - a.problems.length || a.name.localeCompare(b.name))} showNs /></div>}
      {tab === 'problems' && (
        <div class="insp-body">
          <InspSection title="On the node itself" icon="nodes" count={own.length}><ProblemList findings={own} empty="The node itself is healthy." /></InspSection>
          <InspSection title="On pods running here" icon="pods" count={onNode.length}><ProblemList findings={onNode} empty="No pod problem on this node." /></InspSection>
        </div>
      )}
      {tab === 'events' && <div class="insp-body"><EventList events={events} /></div>}
      {tab === 'yaml' && <div class="insp-body"><RawObject obj={{ kind: 'Node', namespace: '', name }} /></div>}
    </div>
  );
}
