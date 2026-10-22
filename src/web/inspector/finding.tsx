// Inspector page for one problem: diagnosis, causal chain, impact, evidence, pods, events, YAML.
import type { Finding } from '../../shared/types';
import { Icon } from '../app/icons';
import { S, inspect, inspectFinding, toggleMute, isMuted, isNew, copy, findingMarkdown, setInspectorTab } from '../app/store';
import { ago, dur, plural, truncate } from '../app/fmt';
import { Badge, Button, CommandLine, ConfidenceMeter, FindingLink, KV, NewBadge, ObjRefLink, SevBadge, Disclosure } from '../components/ui';
import { Tree } from '../views/incidents';
import { EventList, Hero, InspSection, NotFound, RawObject, eventsFor, useInspectorTab } from './common';

// Path from the ultimate root cause down to this finding (following the first cause).
function chainTo(f: Finding): Finding[] {
  const chain: Finding[] = [f];
  const seen = new Set([f.id]);
  let cur = f;
  while (cur.causedBy.length) {
    const up = cur.causedBy.map((id) => S.idx!.byId.get(id)).find((x) => x && !seen.has(x.id));
    if (!up) break;
    chain.unshift(up);
    seen.add(up.id);
    cur = up;
  }
  return chain;
}

function countImpacts(id: string, seen = new Set<string>()): number {
  for (const k of S.idx!.effects.get(id) || []) {
    if (seen.has(k)) continue;
    seen.add(k);
    countImpacts(k, seen);
  }
  return seen.size;
}

function LogInsightView({ f }: { f: Finding }) {
  const li = f.logInsight;
  if (!li) return null;
  if (li.error !== undefined) return <InspSection title="Container logs" icon="terminal"><div class="muted small">Logs could not be read: {li.error}</div></InspSection>;
  return (
    <InspSection title={<>What the logs say <span class="muted small">({li.source === 'previous' ? 'previous, crashed instance' : 'current instance'})</span></>} icon="terminal">
      {li.empty && <div class="muted small">The container wrote no log before stopping.</div>}
      {li.matches.map((m) => (
        <div key={m.id} class="log-match">
          <div class="lm-head"><b>{m.title}</b>{m.count > 1 && <span class="muted small">×{m.count}</span>}</div>
          <div class="lm-explain">{m.explain}</div>
          {m.line && <pre class="code code-line">{m.line}</pre>}
        </div>
      ))}
      {li.lastException && <Disclosure summary={<span>Last exception</span>} defaultOpen={!li.matches.length}><pre class="code">{li.lastException}</pre></Disclosure>}
      {li.dependencies.length > 0 && (
        <div class="deps">
          <div class="subhead">Dependencies the container tried to reach</div>
          <table class="mini-table">
            <thead><tr><th>Target</th><th>Resolves to</th><th class="num">Seen</th></tr></thead>
            <tbody>
              {li.dependencies.map((d) => (
                <tr key={`${d.host}:${d.port}`}>
                  <td class="mono small">{d.host}{d.port ? `:${d.port}` : ''}</td>
                  <td>{d.resolved ? (d.resolved.missing ? <Badge tone="crit">missing {d.resolved.kind}</Badge> : d.resolved.kind === 'Localhost' ? <span class="small">this pod (localhost)</span>
                    : <ObjRefLink obj={{ kind: d.resolved.kind, namespace: d.resolved.namespace || '', name: d.resolved.name || '' }} />) : <span class="muted small">external</span>}</td>
                  <td class="num">{d.count}×</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {li.errorLines.length > 0 && !li.matches.length && (
        <Disclosure summary={<span>{plural(li.errorLines.length, 'error line')}</span>}><pre class="code">{li.errorLines.join('\n')}</pre></Disclosure>
      )}
    </InspSection>
  );
}

function Diagnosis({ f }: { f: Finding }) {
  const chain = chainTo(f);
  const impacts = countImpacts(f.id);
  const inh = f.rootCause.inherited;
  return (
    <div class="insp-body">
      {inh && (
        <div class="callout callout-accent">
          <Icon name="chain" size={16} />
          <div>
            <div><b>This is a symptom.</b> The root cause is upstream:</div>
            <button type="button" class="title-link" onClick={() => inspectFinding(inh.id)}>{inh.title}</button>
            <div class="muted small">{inh.summary}</div>
          </div>
        </div>
      )}
      <InspSection title="Root cause" icon="incidents" actions={<span class="rc-flags"><ConfidenceMeter level={f.rootCause.confidence} />{f.rootCause.fromLogs && <span class="tag">from logs</span>}</span>}>
        <p class="rc-summary">{f.rootCause.summary}</p>
        {f.rootCause.details.length > 0 && <ul class="bullets">{f.rootCause.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
      </InspSection>
      <LogInsightView f={f} />
      {f.fixes.length > 0 && (
        <InspSection title="How to fix" icon="wrench">
          <ol class="fixes">{f.fixes.map((x, i) => <li key={i}>{x}</li>)}</ol>
        </InspSection>
      )}
      {chain.length > 1 && (
        <InspSection title="Causal chain" icon="chain" count={chain.length}>
          <ol class="chain">
            {chain.map((c, i) => (
              <li key={c.id} class={c.id === f.id ? 'current' : ''}>
                <span class="chain-step">{i === 0 ? 'root' : i === chain.length - 1 ? 'this' : `↳ ${i}`}</span>
                {c.id === f.id ? <span class="chain-self"><SevBadge sev={c.severity} compact /> {c.title}</span> : <FindingLink f={c} />}
              </li>
            ))}
          </ol>
          {f.causedBy.length > 1 && <div class="muted small">Also caused by: {f.causedBy.slice(1).map((id) => S.idx!.byId.get(id)).filter((x): x is Finding => !!x).map((x) => <button key={x.id} type="button" class="link small" onClick={() => inspectFinding(x.id)}>{truncate(x.title, 60)}</button>)}</div>}
        </InspSection>
      )}
      {impacts > 0 && (
        <InspSection title="Impact — what this breaks" icon="problems" count={impacts}>
          <Tree id={f.id} depth={0} seen={new Set([f.id])} />
        </InspSection>
      )}
      {f.commands.length > 0 && (
        <InspSection title="Investigate (read-only commands)" icon="terminal">
          {f.commands.map((c) => <CommandLine key={c} cmd={c} />)}
        </InspSection>
      )}
    </div>
  );
}

function Evidence({ f }: { f: Finding }) {
  const meta = Object.entries(f.meta || {}).filter(([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v));
  return (
    <div class="insp-body">
      {f.message && <InspSection title="Message" icon="info"><pre class="code wrap">{f.message}</pre></InspSection>}
      <InspSection title="Evidence" icon="list" count={f.evidence.length}>
        {f.evidence.length ? <ul class="evidence">{f.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul> : <div class="muted">No additional evidence.</div>}
      </InspSection>
      <InspSection title="Details" icon="file">
        <KV items={[
          ['Object', <ObjRefLink obj={f.object} />],
          ['Owner', f.owner ? <ObjRefLink obj={f.owner} /> : null],
          ['Node', f.node ? <ObjRefLink obj={{ kind: 'Node', namespace: '', name: f.node }} /> : null],
          ['Container', f.container ? <span class="mono">{f.container}</span> : null],
          ['Type', f.category],
          ['Tags', f.tags.length ? <span class="tags">{f.tags.map((t) => <span key={t} class="tag">{t}</span>)}</span> : null],
          ['Since', f.since ? ago(f.since) : null],
          ['Last seen', f.lastSeen ? ago(f.lastSeen) : null],
          ['First seen by Kube Doctor', S.changes?.firstSeen[f.id] ? ago(S.changes.firstSeen[f.id]) : null],
          ...meta.map(([k, v]): [string, string] => [k, String(v)]),
          ['Finding id', <span class="mono small muted">{f.id}</span>],
        ]} />
      </InspSection>
    </div>
  );
}

function Instances({ f }: { f: Finding }) {
  return (
    <div class="insp-body">
      <table class="mini-table">
        <thead><tr><th>Pod</th><th>Node</th><th>Phase</th><th class="num">Restarts</th><th>Age</th></tr></thead>
        <tbody>
          {f.instances.map((i) => (
            <tr key={`${i.namespace}/${i.pod}`} class="clickable" onClick={() => inspect({ type: 'pod', namespace: i.namespace, name: i.pod })}>
              <td><span class="mono small">{i.pod}</span>{i.namespace !== f.object.namespace && <div class="muted small">{i.namespace}</div>}</td>
              <td class="mono small">{i.node || '—'}</td>
              <td>{i.phase || '—'}</td>
              <td class="num">{i.restarts}</td>
              <td class="muted small">{dur(i.age)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FindingPage({ id }: { id: string }) {
  const f = S.idx?.byId.get(id);
  const events = f ? eventsFor([f.object, ...f.instances.map((i) => ({ kind: 'Pod', namespace: i.namespace, name: i.pod }))]) : [];
  const [tab, tabs] = useInspectorTab('finding', [
    { id: 'diagnosis', label: 'Diagnosis', icon: 'incidents' },
    { id: 'evidence', label: 'Evidence', icon: 'list', count: f?.evidence.length },
    !!f?.instances.length && { id: 'pods', label: 'Pods', icon: 'pods', count: f.instances.length },
    { id: 'events', label: 'Events', icon: 'events', count: events.length },
    { id: 'yaml', label: 'YAML', icon: 'file' },
  ], 'diagnosis');
  if (!f) return <NotFound what="This problem" />;
  const muted = isMuted(f.id);
  const pod = f.object.kind === 'Pod' ? { namespace: f.object.namespace, name: f.object.name } : f.instances[0] ? { namespace: f.instances[0].namespace, name: f.instances[0].pod } : null;
  return (
    <div class="insp-page">
      <Hero icon={<SevBadge sev={f.severity} />} kind={f.category}
        badges={<>{isNew(f.id) && <NewBadge />}{muted && <Badge>muted</Badge>}{f.causedBy.length ? <Badge title="Consequence of another problem">symptom</Badge> : <Badge tone="accent" title="Nothing upstream explains it">root cause</Badge>}</>}
        title={f.title}
        sub={<><ObjRefLink obj={f.object} />{f.owner && <><span class="muted"> · owned by </span><ObjRefLink obj={f.owner} /></>}{f.instances.length > 1 && <span class="muted"> · {plural(f.instances.length, 'pod')}</span>}{f.lastSeen || f.since ? <span class="muted"> · {ago(f.lastSeen || f.since)}</span> : null}</>}
        actions={<>
          {pod && <Button icon="zap" variant="primary" size="sm" onClick={() => { setInspectorTab('pod', 'analysis'); inspect({ type: 'pod', ...pod }); }} title="Fresh state, every container's logs, metrics and ranked hypotheses">Deep-analyze pod</Button>}
          <Button icon={muted ? 'eye' : 'eyeOff'} size="sm" onClick={() => toggleMute(f)}>{muted ? 'Unmute' : 'Mute'}</Button>
          <Button icon="copy" size="sm" onClick={() => void copy(findingMarkdown(f), 'Markdown copied')}>Copy</Button>
        </>} />
      {tabs}
      {tab === 'diagnosis' && <Diagnosis f={f} />}
      {tab === 'evidence' && <Evidence f={f} />}
      {tab === 'pods' && <Instances f={f} />}
      {tab === 'events' && <div class="insp-body"><EventList events={events} showObject={f.instances.length > 0} /></div>}
      {tab === 'yaml' && <div class="insp-body"><RawObject obj={f.object} /></div>}
    </div>
  );
}
