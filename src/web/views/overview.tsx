// Overview dashboard: health at a glance, top root causes, distributions, nodes, changes.
import type { ComponentChildren } from 'preact';
import type { EventRow } from '../../shared/types';
import { Icon, type IconName } from '../app/icons';
import { useStore, inspect, inspectFinding, drill, navigate, setNamespaces, isMuted } from '../app/store';
import { useDataset, rowSeverity, type IncidentRow } from '../app/data';
import { SEV_RANK, SEV_TONE, SEVERITIES, ago, plural, pct, truncate, bytes, cpu, type Tone } from '../app/fmt';
import { SevBadge, Section, Bar, StackBar, Empty, NewBadge, Dot, Badge } from '../components/ui';
import { Donut, Legend, BarList, Histogram, type Bucket } from '../components/charts';
import { PageHeader, StatusText } from './common';

function Kpi({ label, value, total, tone, sub, onClick, icon }: { label: string; value: number; total?: number; tone: Tone; sub: ComponentChildren; onClick?: () => void; icon: IconName }) {
  return (
    <button type="button" class={`kpi kpi-${tone}${onClick ? ' clickable' : ''}`} onClick={onClick} disabled={!onClick}>
      <div class="kpi-top"><span class="kpi-label">{label}</span><Icon name={icon} size={16} /></div>
      <div class="kpi-value">{value}{total != null && <span class="kpi-total">/ {total}</span>}</div>
      {total != null && <Bar value={value} max={total || 1} tone={tone === 'ok' ? 'ok' : tone} thin />}
      <div class="kpi-sub">{sub}</div>
    </button>
  );
}

function HealthBanner({ incidents, nsCount }: { incidents: IncidentRow[]; nsCount: number }) {
  const crit = incidents.filter((i) => i.severity === 'critical');
  const warn = incidents.filter((i) => i.severity === 'warning');
  const tone = crit.length ? 'crit' : warn.length ? 'warn' : 'ok';
  const text = crit.length
    ? `${plural(crit.length, 'root cause')} ${crit.length === 1 ? 'is' : 'are'} breaking workloads${nsCount ? ` across ${plural(nsCount, 'namespace')}` : ''}`
    : warn.length ? `No outage detected, but ${plural(warn.length, 'issue')} ${warn.length === 1 ? 'degrades' : 'degrade'} the cluster` : 'Everything Kube Doctor checks looks healthy';
  return (
    <div class={`health-banner tone-${tone}`}>
      <span class="health-icon"><Icon name={tone === 'ok' ? 'check' : 'problems'} size={20} /></span>
      <div class="health-text"><b>{tone === 'crit' ? 'Attention needed' : tone === 'warn' ? 'Degraded' : 'Healthy'}</b><span>{text}</span></div>
      {incidents.length > 0 && (
        <button type="button" class="btn btn-default" onClick={() => navigate('incidents')}><span>Review root causes</span><Icon name="arrowRight" size={15} /></button>
      )}
    </div>
  );
}

function TopIncidents({ incidents }: { incidents: IncidentRow[] }) {
  const s = useStore();
  if (!incidents.length) return <Empty icon="check" title="No active root cause">Informational findings are listed under Problems.</Empty>;
  return (
    <ul class="incident-mini">
      {incidents.slice(0, 7).map((i) => (
        <li key={i.id} class="clickable" onClick={() => inspectFinding(i.root.id)}>
          <SevBadge sev={i.severity} compact />
          <div class="im-main">
            <div class="im-title">{i.root.title}{s.changes?.newIds.has(i.root.id) && <> <NewBadge /></>}</div>
            <div class="im-rc">{truncate(i.root.rootCause.summary, 170)}</div>
          </div>
          <div class="im-meta">
            {i.impacted.length > 0 && <span class="badge badge-neutral" title="Problems caused by this root cause">↳ {i.impacted.length}</span>}
            <span class="muted small">{i.namespaces.filter(Boolean).slice(0, 2).join(', ') || 'cluster'}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function eventBuckets(rows: EventRow[]): Bucket[] {
  const span = 5 * 60_000;
  const start = Date.now() - 12 * span;
  const buckets: Bucket[] = Array.from({ length: 12 }, (_, i) => ({ t: start + i * span, span, values: { warning: 0, normal: 0 } }));
  for (const e of rows) {
    if (!e.last || e.last < start) continue;
    const b = buckets[Math.min(11, Math.floor((e.last - start) / span))]!;
    b.values[e.type === 'Warning' ? 'warning' : 'normal']! += 1;
  }
  return buckets;
}

export function Overview() {
  const s = useStore();
  const r = s.report!;
  const idx = s.idx!;
  const incidents = useDataset('incidents').base;
  const problems = useDataset('problems').base;
  const pods = useDataset('pods').base;
  const workloads = useDataset('workloads').base;
  const events = useDataset('events').base;
  const namespaces = useDataset('namespaces').base.filter((n) => !s.ns.length || s.ns.includes(n.name));
  const nodes = r.nodes;

  const sev = Object.fromEntries(SEVERITIES.map((x) => [x, problems.filter((f) => f.severity === x).length])) as Record<'critical' | 'warning' | 'info', number>;
  const bad = (ids: string[]) => ['critical', 'warning'].includes(rowSeverity(ids) ?? '');
  const badPods = pods.filter((p) => bad(p.problems)).length;
  const badWl = workloads.filter((w) => bad(w.problems)).length;
  const readyNodes = nodes.filter((n) => n.ready === 'Ready').length;

  const cats = new Map<string, { label: string; value: number; sev: 'critical' | 'warning' | 'info' }>();
  for (const f of problems) {
    const c = cats.get(f.category) || { label: f.category, value: 0, sev: 'info' as const };
    c.value++;
    if (SEV_RANK[f.severity]! > SEV_RANK[c.sev]!) c.sev = f.severity;
    cats.set(f.category, c);
  }
  const catItems = [...cats.values()].sort((a, b) => b.value - a.value).slice(0, 9).map((c) => ({ label: c.label, value: c.value, tone: SEV_TONE[c.sev], onClick: () => drill('problems', { category: [c.label] }) }));

  const nsRows = namespaces.map((n) => {
    const fs = n.problems.filter((id) => !isMuted(id)).map((id) => idx.byId.get(id)).filter((f) => !!f);
    return { ...n, crit: fs.filter((f) => f.severity === 'critical').length, warn: fs.filter((f) => f.severity === 'warning').length, info: fs.filter((f) => f.severity === 'info').length };
  }).sort((a, b) => b.crit - a.crit || b.warn - a.warn || b.pods.total - a.pods.total);

  const buckets = eventBuckets(events);
  const reasons = new Map<string, number>();
  for (const e of events) if (e.type === 'Warning') reasons.set(e.reason, (reasons.get(e.reason) || 0) + 1);
  const reasonItems = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([label, value]) => ({ label, value, tone: 'warn' as const, onClick: () => drill('events', { reason: [label], type: ['Warning'] }) }));

  const restarting = pods.filter((p) => p.restarts > 0).sort((a, b) => (b.lastRestart || 0) - (a.lastRestart || 0) || b.restarts - a.restarts).slice(0, 8);
  const ch = s.changes;
  const newFindings = problems.filter((f) => ch?.newIds.has(f.id));
  const nsActive = new Set(incidents.filter((i) => i.severity === 'critical').flatMap((i) => i.namespaces.filter(Boolean)));
  const sevSegments = SEVERITIES.map((x) => ({ label: x, value: sev[x], tone: SEV_TONE[x], onClick: () => drill('problems', { severity: [x] }) }));

  return (
    <div class="page overview">
      <PageHeader icon="overview" title="Overview" subtitle={`${r.meta.context} · Kubernetes ${r.meta.version}${s.ns.length ? ` · filtered to ${s.ns.join(', ')}` : ''}`} />
      <HealthBanner incidents={incidents} nsCount={nsActive.size} />
      <div class="kpis">
        <Kpi label="Critical problems" value={sev.critical} tone={sev.critical ? 'crit' : 'ok'} icon="problems" sub="breaking a workload now" onClick={() => drill('problems', { severity: ['critical'] })} />
        <Kpi label="Warnings" value={sev.warning} tone={sev.warning ? 'warn' : 'ok'} icon="info" sub="degraded or at risk" onClick={() => drill('problems', { severity: ['warning'] })} />
        <Kpi label="Root causes" value={incidents.length} tone={incidents.length ? 'accent' : 'ok'} icon="incidents" sub="independent incidents" onClick={() => navigate('incidents')} />
        <Kpi label="Healthy pods" value={pods.length - badPods} total={pods.length} tone={badPods ? 'warn' : 'ok'} icon="pods" sub={`${badPods} with problems`} onClick={() => drill('pods', { health: ['Critical', 'Warning'] })} />
        <Kpi label="Healthy workloads" value={workloads.length - badWl} total={workloads.length} tone={badWl ? 'warn' : 'ok'} icon="workloads" sub={`${badWl} degraded or down`} onClick={() => drill('workloads', { health: ['Critical', 'Warning'] })} />
        <Kpi label="Nodes ready" value={readyNodes} total={nodes.length} tone={readyNodes < nodes.length ? 'crit' : 'ok'} icon="nodes" sub={`${nodes.filter((n) => n.cordoned).length} cordoned`} onClick={() => navigate('nodes')} />
      </div>

      <div class="grid-2">
        <Section id="ov.top" title="Top root causes" icon="incidents" count={incidents.length} actions={<button type="button" class="link" onClick={() => navigate('incidents')}>View all →</button>}>
          <TopIncidents incidents={incidents} />
        </Section>
        <Section id="ov.dist" title="Problems" icon="problems" count={problems.length}>
          <div class="dist">
            <Donut segments={sevSegments} center={<><div class="donut-num">{problems.length}</div><div class="donut-cap">problems</div></>} />
            <Legend items={sevSegments} />
          </div>
          <div class="subhead">By type</div>
          <BarList items={catItems} empty="No problems" />
        </Section>
      </div>

      <div class="grid-2">
        <Section id="ov.ns" title="Namespaces" icon="namespaces" count={nsRows.length} flush actions={<button type="button" class="link" onClick={() => navigate('namespaces')}>All namespaces →</button>}>
          <table class="mini-table">
            <thead><tr><th>Namespace</th><th>Problems</th><th class="num">Pods</th><th class="num">Restarts</th></tr></thead>
            <tbody>
              {nsRows.slice(0, 10).map((n) => (
                <tr key={n.name} class="clickable" onClick={() => setNamespaces([n.name])} title="Filter every page to this namespace">
                  <td><span class="mono">{n.name}</span></td>
                  <td>
                    <div class="ns-health">
                      {n.crit + n.warn + n.info ? <StackBar parts={[{ value: n.crit, tone: 'crit', label: 'critical' }, { value: n.warn, tone: 'warn', label: 'warning' }, { value: n.info, tone: 'info', label: 'info' }]} /> : <span class="ok-text">healthy</span>}
                      <span class="muted small">{n.crit ? <b class="crit-text">{n.crit} </b> : null}{n.warn ? <b class="warn-text">{n.warn}</b> : null}</span>
                    </div>
                  </td>
                  <td class="num">{n.pods.running}/{n.pods.total}</td>
                  <td class="num">{n.restarts || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        <Section id="ov.events" title="Events — last hour" icon="events" count={events.filter((e) => e.type === 'Warning').length} subtitle="warnings"
          actions={<button type="button" class="link" onClick={() => drill('events', { type: ['Warning'] })}>Warning events →</button>}>
          <Histogram buckets={buckets} series={[{ key: 'warning', tone: 'warn', label: 'warning events' }, { key: 'normal', tone: 'muted', label: 'normal events' }]} />
          <div class="subhead">Top warning reasons</div>
          <BarList items={reasonItems} empty="No warning events" />
        </Section>
      </div>

      <Section id="ov.nodes" title="Nodes" icon="nodes" count={nodes.length} actions={<button type="button" class="link" onClick={() => navigate('nodes')}>Details →</button>}>
        <div class="node-tiles">
          {nodes.map((n) => {
            const worst = rowSeverity((idx.byObj.get(`Node//${n.name}`) || []).map((f) => f.id));
            const tone: Tone = n.ready !== 'Ready' ? 'crit' : worst ? SEV_TONE[worst] : 'ok';
            return (
              <button key={n.name} type="button" class={`node-tile tone-${tone}`} onClick={() => inspect({ type: 'node', name: n.name })}>
                <div class="nt-head"><Dot tone={n.ready === 'Ready' ? 'ok' : 'crit'} /><span class="mono nt-name">{n.name}</span>{n.cordoned && <Badge>cordoned</Badge>}</div>
                <div class="nt-row"><span>CPU</span><Bar value={n.alloc.reqCpu} max={n.alloc.cpu} marker={n.usage?.cpu} thin title={`requests ${cpu(n.alloc.reqCpu)} / ${cpu(n.alloc.cpu)}${n.usage ? `, usage ${cpu(n.usage.cpu)}` : ''}`} /><span class="num">{pct(n.alloc.reqCpu, n.alloc.cpu)}%</span></div>
                <div class="nt-row"><span>Mem</span><Bar value={n.alloc.reqMemory} max={n.alloc.memory} marker={n.usage?.memory} thin title={`requests ${bytes(n.alloc.reqMemory)} / ${bytes(n.alloc.memory)}${n.usage ? `, usage ${bytes(n.usage.memory)}` : ''}`} /><span class="num">{pct(n.alloc.reqMemory, n.alloc.memory)}%</span></div>
                <div class="nt-foot muted small">
                  {n.alloc.pods} pods · {n.roles.join(', ')}
                  {n.problems.filter((p) => p.type !== 'Ready').map((p) => <span key={p.type}> · <span class="warn-text">{p.type}</span></span>)}
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      <div class="grid-2">
        <Section id="ov.changes" title="Changes" icon="bell" subtitle={ch?.previousScan ? `since ${ago(ch.previousScan)}` : 'first scan of this context'}>
          {!ch?.previousScan ? (
            <div class="muted">Kube Doctor remembers what it saw on each scan (in this browser). New and resolved problems will appear here on the next scans.</div>
          ) : (
            <div class="changes">
              <div class="changes-col">
                <div class="subhead">New in the last 30 min <span class="count">{newFindings.length}</span></div>
                {newFindings.length ? (
                  <ul class="plain-list">{newFindings.slice(0, 8).map((f) => <li key={f.id} class="clickable" onClick={() => inspectFinding(f.id)}><SevBadge sev={f.severity} compact /> {f.title}</li>)}</ul>
                ) : <div class="muted small">Nothing new.</div>}
              </div>
              <div class="changes-col">
                <div class="subhead">Resolved <span class="count">{ch.resolved.length}</span></div>
                {ch.resolved.length ? (
                  <ul class="plain-list">{ch.resolved.slice(0, 8).map((x) => <li key={x.id}><Icon name="check" size={13} className="ok-text" /> <span class="strike">{x.t}</span> <span class="muted small">{ago(x.at)}</span></li>)}</ul>
                ) : <div class="muted small">Nothing resolved yet.</div>}
              </div>
            </div>
          )}
        </Section>
        <Section id="ov.restarts" title="Recently restarted pods" icon="refresh" count={pods.filter((p) => p.restarts > 0).length} flush
          actions={<button type="button" class="link" onClick={() => drill('pods', { restarts: ['1–4', '5–19', '20+'] })}>All →</button>}>
          {restarting.length ? (
            <table class="mini-table">
              <thead><tr><th>Pod</th><th>Status</th><th class="num">Restarts</th><th>Last</th></tr></thead>
              <tbody>
                {restarting.map((p) => (
                  <tr key={`${p.namespace}/${p.name}`} class="clickable" onClick={() => inspect({ type: 'pod', namespace: p.namespace, name: p.name })}>
                    <td><span class="mono">{truncate(p.name, 38)}</span><div class="muted small">{p.namespace}</div></td>
                    <td><StatusText status={p.status} /></td>
                    <td class="num">{p.restarts}</td>
                    <td class="muted small">{p.lastRestart ? ago(p.lastRestart) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div class="section-pad muted">No container restarted.</div>}
        </Section>
      </div>
    </div>
  );
}
