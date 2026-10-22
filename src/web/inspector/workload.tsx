// Inspector page for one workload: rollout status, conditions, pods, problems, events, YAML.
import type { WorkloadRow } from '../../shared/types';
import { Icon } from '../app/icons';
import { useStore, findingsFor, copy } from '../app/store';
import { age, ago, dateTime } from '../app/fmt';
import { Bar, Button, Dot, KV } from '../components/ui';
import { StatusText } from '../views/common';
import { EventList, Hero, InspSection, NotFound, PodMiniTable, ProblemList, RawObject, eventsFor, useInspectorTab } from './common';

const CMD_KIND: Record<WorkloadRow['kind'], string> = { Deployment: 'deployment', StatefulSet: 'statefulset', DaemonSet: 'daemonset', Job: 'job', CronJob: 'cronjob' };

export function WorkloadPage({ kind, namespace, name }: { kind: WorkloadRow['kind']; namespace: string; name: string }) {
  const s = useStore();
  const w = s.idx?.workloads.get(`${kind}/${namespace}/${name}`);
  const pods = (w?.pods || []).map((p) => s.idx?.pods.get(`${namespace}/${p}`)).filter((p) => !!p);
  const own = findingsFor(kind, namespace, name);
  const all = (w?.problems || []).map((id) => s.idx?.byId.get(id)).filter((f) => !!f);
  const events = eventsFor([{ kind, namespace, name }]);
  const [tab, tabs] = useInspectorTab('workload', [
    { id: 'overview', label: 'Overview', icon: 'workloads' },
    { id: 'pods', label: 'Pods', icon: 'pods', count: pods.length },
    { id: 'problems', label: 'Problems', icon: 'problems', count: all.length },
    { id: 'events', label: 'Events', icon: 'events', count: events.length },
    { id: 'yaml', label: 'YAML', icon: 'file' },
  ], 'overview');
  if (!w) return <NotFound what={`${kind} ${namespace}/${name}`} />;
  const scaled = w.desired != null;
  return (
    <div class="insp-page">
      <Hero icon={<Icon name="workloads" size={14} />} kind={kind} badges={<StatusText status={w.status} />}
        title={<span class="mono">{name}</span>} sub={<span class="muted">{namespace} · created {ago(w.created)}</span>}
        actions={<Button icon="copy" size="sm" onClick={() => void copy(`kubectl describe ${CMD_KIND[kind]} -n ${namespace} ${name}`, 'Command copied')}>describe cmd</Button>} />
      {tabs}
      {tab === 'overview' && (
        <div class="insp-body">
          {all.length > 0 && <InspSection title="Problems" icon="problems" count={all.length}><ProblemList findings={all.slice(0, 6)} />{all.length > 6 && <div class="muted small insp-pad">…and {all.length - 6} more in the Problems tab.</div>}</InspSection>}
          <InspSection title="Status" icon="workloads">
            {scaled && kind !== 'Job' && (
              <div class="cap-block">
                <div class="cap-line"><span>Ready</span><Bar value={w.ready} max={w.desired || 1} tone={w.desired === 0 ? 'muted' : w.ready >= (w.desired ?? 0) ? 'ok' : w.ready === 0 ? 'crit' : 'warn'} label={`${w.ready} / ${w.desired}`} /></div>
                {w.updated != null && <div class="cap-line"><span>Up to date</span><Bar value={w.updated} max={w.desired || 1} tone="accent" label={`${w.updated} / ${w.desired}`} /></div>}
              </div>
            )}
            <KV items={[
              ['Status', <StatusText status={w.status} />],
              kind === 'Job' ? ['Completions', `${w.ready}${w.desired != null ? ` / ${w.desired}` : ''}`] : null,
              ['Schedule', w.schedule && <span class="mono">{w.schedule}</span>],
              ['Last scheduled', w.lastSchedule ? `${ago(w.lastSchedule)} (${dateTime(w.lastSchedule)})` : null],
              ['Last success', w.lastSuccess ? `${ago(w.lastSuccess)} (${dateTime(w.lastSuccess)})` : null],
              ['Images', <div class="mono small">{w.images.map((i) => <div key={i}>{i}</div>)}</div>],
              ['Created', `${dateTime(w.created)} (${age(w.created)})`],
            ]} />
          </InspSection>
          {w.conditions.length > 0 && (
            <InspSection title="Conditions" icon="check">
              <ul class="checks">
                {w.conditions.map((c) => (
                  <li key={c.type}>
                    <Dot tone={(c.type === 'ReplicaFailure' || c.type === 'Failed') === (c.status === 'True') ? 'crit' : 'ok'} />
                    <span class="mono small">{c.type}={c.status}</span>
                    <span class="small">{c.reason ? <b>{c.reason}</b> : null} {c.message}</span>
                    {c.since && <span class="muted small">{ago(c.since)}</span>}
                  </li>
                ))}
              </ul>
            </InspSection>
          )}
          {pods.length > 0 && <InspSection title="Pods" icon="pods" count={pods.length}><PodMiniTable pods={pods.slice(0, 8)} showNode />{pods.length > 8 && <div class="muted small insp-pad">…see the Pods tab for all {pods.length}.</div>}</InspSection>}
        </div>
      )}
      {tab === 'pods' && <div class="insp-body"><PodMiniTable pods={pods} showNode /></div>}
      {tab === 'problems' && (
        <div class="insp-body">
          <InspSection title={`On the ${kind}`} icon="workloads" count={own.length}><ProblemList findings={own} empty={`The ${kind} itself reports no problem.`} /></InspSection>
          <InspSection title="On its pods" icon="pods" count={all.length - own.length}><ProblemList findings={all.filter((f) => !own.includes(f))} empty="No pod problem." /></InspSection>
        </div>
      )}
      {tab === 'events' && <div class="insp-body"><EventList events={events} /></div>}
      {tab === 'yaml' && <div class="insp-body"><RawObject obj={{ kind, namespace, name }} /></div>}
    </div>
  );
}
