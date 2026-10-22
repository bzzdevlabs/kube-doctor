// Inspector page for one pod: deep analysis (ranked hypotheses), containers, logs, timeline, events, YAML.
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ContainerState, ContainerSummary, DeepAnalysis, Hypothesis, LogEntry } from '../../shared/types';
import { Icon } from '../app/icons';
import { api } from '../app/api';
import { S, useStore, runDeep, findingsFor, copy, isMuted } from '../app/store';
import { SEV_TONE, ago, age, bytes, clock, cpu, dateTime, maxSev, parseQty, plural, type Tone } from '../app/fmt';
import { Badge, Bar, Button, CommandLine, CopyButton, Disclosure, Dot, Empty, KV, ObjRefLink, SearchBox, Segmented, SevBadge, Spinner } from '../components/ui';
import { StatusText } from '../views/common';
import { EventList, Hero, InspSection, ProblemList, RawObject, eventsFor, useInspectorTab } from './common';

const isErr = (e: LogEntry | null | undefined): e is { error: string } => !!e && 'error' in e;

function stateText(s: ContainerState | null): string {
  if (!s) return 'no status yet';
  const bits: string[] = [s.state];
  if (s.reason) bits.push(s.reason);
  if (s.exitCode != null) bits.push(`exit ${s.exitCode}${s.signal ? ` (signal ${s.signal})` : ''}`);
  return bits.join(' · ');
}

function HypothesisCard({ h, rank }: { h: Hypothesis; rank: number }) {
  return (
    <div class={`hyp sev-${h.severity}`}>
      <div class="hyp-head">
        <span class="hyp-rank">#{rank}</span>
        <SevBadge sev={h.severity} compact />
        <b class="hyp-title">{h.title}</b>
        {h.container && <span class="tag mono">{h.container}</span>}
        {h.fromLogs && <span class="tag">from logs</span>}
        <span class="hyp-conf" title={`${h.confidence}% confidence`}><Bar value={h.confidence} max={100} thin tone={h.confidence >= 70 ? 'accent' : 'muted'} /><span class="small muted">{h.confidence}%</span></span>
      </div>
      <p class="hyp-summary">{h.summary}</p>
      {h.link && <div class="small">Related: <ObjRefLink obj={h.link} /></div>}
      {h.details.length > 0 && <Disclosure summary={<span>Details ({h.details.length})</span>} defaultOpen={rank === 1}><ul class="bullets">{h.details.map((d, i) => <li key={i}>{d}</li>)}</ul></Disclosure>}
      {h.evidence.length > 0 && <Disclosure summary={<span>Evidence ({h.evidence.length})</span>}><ul class="evidence">{h.evidence.map((d, i) => <li key={i}>{d}</li>)}</ul></Disclosure>}
      {h.fixes.length > 0 && <Disclosure summary={<span>How to fix</span>} defaultOpen={rank === 1}><ol class="fixes">{h.fixes.map((d, i) => <li key={i}>{d}</li>)}</ol></Disclosure>}
    </div>
  );
}

function Analysis({ a, ns, name }: { a: DeepAnalysis; ns: string; name: string }) {
  const scanFindings = findingsFor('Pod', ns, name);
  const p = a.pod;
  const nodeBad = a.node?.conditions.filter((c) => (c.type === 'Ready' ? c.status !== 'True' : c.status === 'True')) || [];
  return (
    <div class="insp-body">
      <InspSection title="Hypotheses, most likely first" icon="incidents" count={a.hypotheses.length}>
        {a.hypotheses.map((h, i) => <HypothesisCard key={i} h={h} rank={i + 1} />)}
      </InspSection>
      {scanFindings.length > 0 && <InspSection title="Problems reported by the scan" icon="problems" count={scanFindings.length}><ProblemList findings={scanFindings} /></InspSection>}
      {a.dependencies.length > 0 && (
        <InspSection title="Dependencies found in logs" icon="chain" count={a.dependencies.length}>
          <table class="mini-table">
            <thead><tr><th>Target</th><th>Resolves to</th><th>Health</th><th class="num">Seen</th></tr></thead>
            <tbody>
              {a.dependencies.map((d, i) => (
                <tr key={i}>
                  <td class="mono small">{d.host}{d.port ? `:${d.port}` : ''}</td>
                  <td>{d.resolved ? (d.resolved.missing ? <Badge tone="crit">missing {d.resolved.kind}</Badge> : d.resolved.kind === 'Localhost' ? <span class="small">this pod</span>
                    : <ObjRefLink obj={{ kind: d.resolved.kind, namespace: d.resolved.namespace || '', name: d.resolved.name || '' }} />) : <span class="muted small">external</span>}</td>
                  <td>{d.health ? <span class={d.health.ready ? 'ok-text' : 'crit-text'}>{d.health.ready}/{d.health.pods} ready</span> : <span class="muted">—</span>}</td>
                  <td class="num small">{d.count}× <span class="muted">{d.container}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </InspSection>
      )}
      <InspSection title="Pod" icon="pods">
        <KV items={[
          ['Phase', <span><StatusText status={p.phase} />{p.reason ? ` · ${p.reason}` : ''}</span>],
          ['Message', p.message],
          ['Owner', p.owners.join(' → ') || null],
          ['Node', p.node ? <ObjRefLink obj={{ kind: 'Node', namespace: '', name: p.node }} /> : <span class="warn-text">not scheduled</span>],
          ['Pod IP', p.podIP && <span class="mono">{p.podIP}</span>],
          ['QoS class', p.qos],
          ['Service account', <span class="mono">{p.serviceAccount}</span>],
          ['Priority class', p.priorityClass],
          ['Restart policy', p.restartPolicy],
          ['Requests', `cpu ${cpu(p.requests.cpu)} · memory ${bytes(p.requests.memory)}`],
          ['Limits', `cpu ${p.limits.cpu ? cpu(p.limits.cpu) : 'none'} · memory ${p.limits.memory ? bytes(p.limits.memory) : 'none'}`],
          ['Services', a.services.length ? <span>{a.services.map((s, i) => <span key={s.name}>{i ? ', ' : ''}<ObjRefLink obj={{ kind: 'Service', namespace: p.namespace, name: s.name }} short /> <span class="muted small">({s.ready ?? '?'}/{s.pods ?? '?'} ready)</span></span>)}</span> : <span class="muted">no Service selects this pod</span>],
          ['Created', `${dateTime(p.created)} (${age(p.created)})`],
          ['Deleting', p.deleting ? <span class="warn-text">since {ago(p.deleting)}</span> : null],
        ]} />
        <Disclosure summary={<span>Conditions</span>}>
          <ul class="checks">{p.conditions.map((c) => <li key={c.type}><Dot tone={c.status === 'True' ? 'ok' : 'warn'} /><span class="mono small">{c.type}={c.status}</span><span class="muted small">{c.reason || ''} {c.message || ''}</span></li>)}</ul>
        </Disclosure>
        {p.volumes.length > 0 && <Disclosure summary={<span>Volumes ({p.volumes.length})</span>}><ul class="plain-list mono small">{p.volumes.map((v) => <li key={v.name}>{v.name}: {v.type}{v.source ? ` ${v.source}` : ''}</li>)}</ul></Disclosure>}
        {Object.keys(p.labels).length > 0 && <Disclosure summary={<span>Labels ({Object.keys(p.labels).length})</span>}><div class="tags">{Object.entries(p.labels).map(([k, v]) => <span key={k} class="tag mono">{k}={v}</span>)}</div></Disclosure>}
      </InspSection>
      {a.node && (
        <InspSection title="Node" icon="nodes">
          <div class="node-line">
            <ObjRefLink obj={{ kind: 'Node', namespace: '', name: a.node.name }} />
            {nodeBad.length ? nodeBad.map((c) => <Badge key={c.type} tone="crit">{c.type === 'Ready' ? 'NotReady' : c.type}</Badge>) : <Badge tone="ok">healthy</Badge>}
            {a.node.unschedulable && <Badge tone="warn">cordoned</Badge>}
            <span class="muted small">{a.node.arch} · kubelet {a.node.kubelet}</span>
          </div>
        </InspSection>
      )}
      <InspSection title="Investigate (read-only commands)" icon="terminal">
        {a.commands.map((c) => <CommandLine key={c} cmd={c} />)}
      </InspSection>
    </div>
  );
}

function ContainerCard({ c, metrics }: { c: ContainerSummary; metrics: boolean }) {
  const memLim = parseQty(c.resources.limits?.memory);
  const cpuLim = parseQty(c.resources.limits?.cpu);
  const memReq = parseQty(c.resources.requests?.memory);
  const cpuReq = parseQty(c.resources.requests?.cpu);
  const tone: Tone = c.ready ? 'ok' : c.state?.state === 'terminated' && c.state.exitCode === 0 ? 'muted' : 'crit';
  return (
    <div class={`container-card tone-${tone}`}>
      <Disclosure defaultOpen={!c.ready || c.restarts > 0} summary={
        <span class="cc-head">
          <Dot tone={tone} />
          <b class="mono">{c.name}</b>
          {c.init && <span class="tag">{c.sidecar ? 'sidecar' : 'init'}</span>}
          <span class="muted small">{stateText(c.state)}</span>
          {c.restarts > 0 && <Badge tone={c.restarts >= 5 ? 'crit' : 'warn'}>{plural(c.restarts, 'restart')}</Badge>}
        </span>
      }>
        <KV items={[
          ['Image', <span class="mono small">{c.image}</span>],
          ['State', <span>{stateText(c.state)}{c.state?.since || c.state?.started ? <span class="muted"> · since {ago(c.state.since || c.state.started)}</span> : null}{c.state?.message ? <div class="small">{c.state.message}</div> : null}</span>],
          ['Last termination', c.lastState ? <span>{stateText(c.lastState)}{c.lastState.finished ? <span class="muted"> · {ago(c.lastState.finished)} ({clock(c.lastState.finished)})</span> : null}{c.lastState.message ? <div class="small">{c.lastState.message}</div> : null}</span> : null],
          ['Command', c.command || c.args ? <span class="mono small">{[...(c.command || []), ...(c.args || [])].join(' ')}</span> : null],
          ['CPU', <span>{c.usage?.cpu != null ? <Bar value={c.usage.cpu} max={cpuLim || cpuReq || c.usage.cpu} thin label={`${cpu(c.usage.cpu)} used`} /> : null}<span class="small muted">request {c.resources.requests?.cpu || '—'} · limit {c.resources.limits?.cpu || '—'}</span></span>],
          ['Memory', <span>{c.usage?.memory != null ? <Bar value={c.usage.memory} max={memLim || memReq || c.usage.memory} thin label={`${bytes(c.usage.memory)} used${memLim ? ` (${Math.round((c.usage.memory / memLim) * 100)}% of limit)` : ''}`} /> : null}<span class="small muted">request {c.resources.requests?.memory || '—'} · limit {c.resources.limits?.memory || '—'}</span></span>],
          ['Liveness', c.probes.liveness && <span class="mono small">{c.probes.liveness}</span>],
          ['Readiness', c.probes.readiness && <span class="mono small">{c.probes.readiness}</span>],
          ['Startup', c.probes.startup && <span class="mono small">{c.probes.startup}</span>],
          ['Ports', c.ports.length ? <span class="mono small">{c.ports.join(', ')}</span> : null],
          ['Mounts', c.mounts.length ? <div class="mono small">{c.mounts.map((m) => <div key={m}>{m}</div>)}</div> : null],
        ]} />
        {!metrics && <div class="muted small">Live usage unavailable (metrics-server not reachable).</div>}
        {(c.env.length > 0 || c.envFrom.length > 0) && (
          <Disclosure summary={<span>Environment ({c.env.length + c.envFrom.length})</span>}>
            <div class="env mono small">
              {c.env.map((e) => <div key={e.name}><b>{e.name}</b>={e.value ?? <span class="muted">&lt;{e.from}&gt;</span>}</div>)}
              {c.envFrom.map((x) => <div key={x} class="muted">all keys of {x}</div>)}
            </div>
          </Disclosure>
        )}
        {c.securityContext && <Disclosure summary={<span>Security context</span>}><pre class="code">{JSON.stringify(c.securityContext, null, 2)}</pre></Disclosure>}
      </Disclosure>
    </div>
  );
}

const TS = /^(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d))\s(.*)$/;
const ERRISH = /\b(error|exception|fatal|panic|fail(ed|ure)?|refused|timed? ?out|denied|traceback)\b/i;

interface LogSource { container: string; which: 'previous' | 'current'; entry: LogEntry }

function Logs({ a, ns, name }: { a: DeepAnalysis; ns: string; name: string }) {
  const sources: LogSource[] = [];
  for (const [container, l] of Object.entries(a.logs)) {
    if (l.previous) sources.push({ container, which: 'previous', entry: l.previous });
    if (l.current) sources.push({ container, which: 'current', entry: l.current });
  }
  const best = sources.find((x) => !isErr(x.entry) && x.entry.analysis.matches.length) || sources.find((x) => !isErr(x.entry)) || sources[0];
  const [sel, setSel] = useState<string>(() => (best ? `${best.container}|${best.which}` : ''));
  const [q, setQ] = useState('');
  const [onlyErr, setOnlyErr] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [full, setFull] = useState<Record<string, { loading?: boolean; text?: string; error?: string }>>({});
  const src = sources.find((x) => `${x.container}|${x.which}` === sel) || best;
  const fullState = src ? full[`${src.container}|${src.which}`] : undefined;
  const text = fullState?.text ?? (src && !isErr(src.entry) ? src.entry.text : '');
  const analysis = src && !isErr(src.entry) && !fullState?.text ? src.entry.analysis : null;
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text]);
  if (!sources.length) return <div class="insp-body"><Empty icon="terminal" title="No logs">The containers never started, so there is nothing to read.</Empty></div>;
  const hits = new Set((analysis?.matches || []).map((m) => m.lineNo));
  const errs = new Set((analysis?.errorLines || []).map((m) => m.lineNo));
  const loadFull = async () => {
    if (!src) return;
    const key = `${src.container}|${src.which}`;
    setFull((f) => ({ ...f, [key]: { loading: true } }));
    try {
      const t = await api<string>('/api/logs', { context: S.context, namespace: ns, pod: name, container: src.container, tail: '5000', previous: src.which === 'previous' ? '1' : null });
      setFull((f) => ({ ...f, [key]: { text: typeof t === 'string' ? t : JSON.stringify(t) } }));
    } catch (e) {
      setFull((f) => ({ ...f, [key]: { error: e instanceof Error ? e.message : String(e) } }));
    }
  };
  const ql = q.toLowerCase();
  const rows = lines.map((l, i) => ({ l, i })).filter(({ l, i }) => (!ql || l.toLowerCase().includes(ql)) && (!onlyErr || hits.has(i) || errs.has(i) || (!analysis && ERRISH.test(l))));
  return (
    <div class="insp-body logs-view">
      <div class="log-sources">
        {sources.map((x) => {
          const k = `${x.container}|${x.which}`;
          const n = isErr(x.entry) ? 0 : x.entry.analysis.matches.length;
          return (
            <button key={k} type="button" class={`log-src${k === `${src?.container}|${src?.which}` ? ' on' : ''}`} onClick={() => setSel(k)}>
              <span class="mono">{x.container}</span><span class="muted small">{x.which === 'previous' ? 'previous (crashed)' : 'current'}</span>
              {n > 0 && <Badge tone="crit">{n}</Badge>}
            </button>
          );
        })}
      </div>
      {src && isErr(src.entry) && !fullState?.text ? <div class="muted insp-pad">{src.entry.error}</div> : (
        <>
          {analysis && analysis.matches.length > 0 && (
            <div class="log-findings">
              {analysis.matches.slice(0, 4).map((m) => <div key={m.id} class="log-match compact"><b>{m.title}</b> <span class="muted small">line {m.lineNo + 1}{m.count > 1 ? ` · ×${m.count}` : ''}</span><div class="small">{m.explain}</div></div>)}
            </div>
          )}
          <div class="log-toolbar">
            <SearchBox value={q} onInput={setQ} placeholder="Filter lines" />
            <label class="check-inline"><input type="checkbox" checked={onlyErr} onChange={(e) => setOnlyErr(e.currentTarget.checked)} /> errors only</label>
            <label class="check-inline"><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.currentTarget.checked)} /> wrap</label>
            <span class="muted small">{rows.length}/{lines.length} lines{fullState?.text ? ' (last 5000)' : ' (last 500)'}</span>
            {!fullState?.text && <Button size="sm" variant="ghost" icon="download" onClick={() => void loadFull()} disabled={fullState?.loading}>{fullState?.loading ? 'Loading…' : 'Load 5000 lines'}</Button>}
            <CopyButton text={text} what="Logs copied" />
          </div>
          {fullState?.error && <div class="crit-text small">{fullState.error}</div>}
          <div class={`logbox${wrap ? ' wrap' : ''}`}>
            {rows.length ? rows.map(({ l, i }) => {
              const m = l.match(TS);
              const cls = hits.has(i) ? ' hit' : errs.has(i) || (!analysis && ERRISH.test(l)) ? ' err' : '';
              return <div key={i} class={`ln${cls}`}><span class="no">{i + 1}</span>{m ? <><span class="ts" title={m[1]}>{clock(m[1])}</span><span class="tx">{m[2]}</span></> : <span class="tx">{l || ' '}</span>}</div>;
            }) : <div class="ln"><span class="no" /><span class="tx muted">{text ? 'No line matches' : '(empty)'}</span></div>}
          </div>
        </>
      )}
    </div>
  );
}

const TL_TONE: Record<string, Tone> = { ok: 'ok', info: 'info', warning: 'warn', critical: 'crit' };
const TL_ICON = { pod: 'pods', condition: 'check', container: 'terminal', event: 'events', log: 'file' } as const;

function Timeline({ a }: { a: DeepAnalysis }) {
  const [kinds, setKinds] = useState<'all' | 'problems'>('all');
  const items = [...a.timeline].sort((x, y) => y.time - x.time).filter((t) => kinds === 'all' || t.severity === 'warning' || t.severity === 'critical');
  return (
    <div class="insp-body">
      <div class="log-toolbar"><Segmented value={kinds} onChange={setKinds} options={[{ value: 'all', label: 'Everything' }, { value: 'problems', label: 'Problems only' }]} /><span class="muted small">newest first</span></div>
      <ol class="timeline">
        {items.map((t, i) => (
          <li key={i} class={`tl-${t.severity}`}>
            <span class="tl-time" title={dateTime(t.time)}>{clock(t.time)}<span class="muted small">{ago(t.time)}</span></span>
            <span class={`tl-dot bg-${TL_TONE[t.severity]}`}><Icon name={TL_ICON[t.kind]} size={11} /></span>
            <span class="tl-text">{t.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function PodPage({ namespace, name }: { namespace: string; name: string }) {
  const s = useStore();
  const key = `${namespace}/${name}`;
  const row = s.idx?.pods.get(key);
  const deep = s.deep[key];
  // Debounced so that skimming through pods with j/k does not query every one of them.
  useEffect(() => {
    const t = setTimeout(() => void runDeep(namespace, name), 250);
    return () => clearTimeout(t);
  }, [key]);
  const a = deep?.data;
  const events = a ? a.events.map((e) => ({ ...e, object: undefined })) : eventsFor([{ kind: 'Pod', namespace, name }]);
  const problems = findingsFor('Pod', namespace, name);
  const [tab, tabs] = useInspectorTab('pod', [
    { id: 'analysis', label: 'Analysis', icon: 'zap', dot: a?.hypotheses[0] && a.hypotheses[0].severity !== 'info' ? SEV_TONE[a.hypotheses[0].severity] : undefined },
    { id: 'containers', label: 'Containers', icon: 'workloads', count: a?.containers.length },
    { id: 'logs', label: 'Logs', icon: 'terminal' },
    { id: 'timeline', label: 'Timeline', icon: 'clock', count: a?.timeline.length },
    { id: 'events', label: 'Events', icon: 'events', count: events.length },
    { id: 'yaml', label: 'YAML', icon: 'file' },
  ], 'analysis');
  const worst = maxSev(problems.filter((f) => !isMuted(f.id)).map((f) => f.severity));
  const owner = row?.owner ? { kind: row.owner.kind, namespace, name: row.owner.name } : null;
  const needsDeep = tab !== 'yaml' && tab !== 'events';
  return (
    <div class="insp-page">
      <Hero icon={<Icon name="pods" size={14} />} kind="Pod"
        badges={<>{row && <StatusText status={row.status} />}{worst && <SevBadge sev={worst} />}</>}
        title={<span class="mono">{name}</span>}
        sub={<>{namespace}{owner && <><span class="muted"> · </span><ObjRefLink obj={owner} short /></>}{row?.node && <><span class="muted"> · on </span><ObjRefLink obj={{ kind: 'Node', namespace: '', name: row.node }} short /></>}</>}
        actions={<>
          <Button icon="refresh" size="sm" onClick={() => void runDeep(namespace, name, { force: true })} disabled={deep?.loading}>{deep?.loading ? 'Analyzing…' : 'Re-analyze'}</Button>
          <Button icon="copy" size="sm" onClick={() => void copy(`kubectl describe pod -n ${namespace} ${name}`, 'Command copied')}>describe cmd</Button>
          {a && <span class="muted small">analyzed {ago(a.analyzedAt)}</span>}
        </>} />
      {row && (
        <div class="stat-strip">
          <div><span>Ready</span><b>{row.ready}</b></div>
          <div><span>Restarts</span><b class={row.restarts ? 'warn-text' : ''}>{row.restarts}</b>{row.lastRestart ? <em>{ago(row.lastRestart)}</em> : null}</div>
          <div><span>CPU</span><b>{cpu(row.cpu)}</b><em>req {cpu(row.reqCpu)}</em></div>
          <div><span>Memory</span><b>{bytes(row.memory)}</b><em>{row.limMemory ? `limit ${bytes(row.limMemory)}` : `req ${bytes(row.reqMemory)}`}</em></div>
          <div><span>Age</span><b>{age(row.created)}</b></div>
          <div><span>QoS</span><b>{row.qos || '—'}</b></div>
        </div>
      )}
      {tabs}
      {needsDeep && !a && (
        deep?.error ? (
          <div class="insp-body">
            <div class="callout callout-crit"><Icon name="problems" size={16} /><div><b>Deep analysis failed</b><div>{deep.error.message}</div>{'hint' in deep.error && deep.error.hint ? <div class="muted small">{deep.error.hint}</div> : null}</div></div>
            <Button icon="refresh" onClick={() => void runDeep(namespace, name, { force: true })}>Retry</Button>
            {problems.length > 0 && <InspSection title="Problems reported by the scan" icon="problems"><ProblemList findings={problems} /></InspSection>}
          </div>
        ) : (
          <div class="insp-body">
            <div class="analyzing"><Spinner size={18} /><div><b>Analyzing {name}…</b><div class="muted small">Fetching fresh pod state, events, every container's current and previous logs, metrics and the node.</div></div></div>
            {problems.length > 0 && <InspSection title="Problems reported by the scan" icon="problems"><ProblemList findings={problems} /></InspSection>}
          </div>
        )
      )}
      {a && tab === 'analysis' && <Analysis a={a} ns={namespace} name={name} />}
      {a && tab === 'containers' && <div class="insp-body">{a.containers.map((c) => <ContainerCard key={c.name} c={c} metrics={a.metricsAvailable} />)}</div>}
      {a && tab === 'logs' && <Logs key={key} a={a} ns={namespace} name={name} />}
      {a && tab === 'timeline' && <Timeline a={a} />}
      {tab === 'events' && <div class="insp-body"><EventList events={events} /></div>}
      {tab === 'yaml' && <div class="insp-body"><RawObject obj={{ kind: 'Pod', namespace, name }} /></div>}
    </div>
  );
}
