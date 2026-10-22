// Building blocks shared by the inspector pages.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { EventRow, Finding, ObjRef, PodRow } from '../../shared/types';
import { S, useStore, loadRaw, inspect, setInspectorTab, isMuted } from '../app/store';
import { SEV_RANK, ago, clock, dateTime, toYaml } from '../app/fmt';
import { Icon, type IconName } from '../app/icons';
import { Badge, CopyButton, Empty, FindingLink, Segmented, Spinner, Tabs, type TabDef } from '../components/ui';
import { StatusText } from '../views/common';

// Hero block at the top of every inspector page.
export function Hero({ icon, kind, title, sub, badges, actions }: { icon?: ComponentChildren; kind: string; title: ComponentChildren; sub?: ComponentChildren; badges?: ComponentChildren; actions?: ComponentChildren }) {
  return (
    <div class="insp-hero">
      <div class="insp-kind">{icon}<span>{kind}</span>{badges}</div>
      <h2 class="insp-title">{title}</h2>
      {sub && <div class="insp-sub">{sub}</div>}
      {actions && <div class="insp-actions">{actions}</div>}
    </div>
  );
}

// Tabs whose selection is remembered per inspector type.
export function useInspectorTab(type: string, tabs: (TabDef | false | null | undefined)[], fallback: string): [string, ComponentChildren] {
  const s = useStore();
  const valid = tabs.filter((t): t is TabDef => !!t);
  const wanted = s.insp.tabs[type];
  const active = wanted && valid.some((t) => t.id === wanted) ? wanted : fallback;
  return [active, <div class="insp-tabs"><Tabs tabs={valid} active={active} onChange={(id) => setInspectorTab(type, id)} /></div>];
}

export function InspSection({ title, icon, children, actions, count }: { title: ComponentChildren; icon?: IconName; children: ComponentChildren; actions?: ComponentChildren; count?: number }) {
  return (
    <div class="insp-section">
      <div class="insp-section-head"><span class="insp-section-title">{icon && <Icon name={icon} size={14} />}{title}{count != null && <span class="count">{count}</span>}</span>{actions}</div>
      {children}
    </div>
  );
}

// Raw object from the last scan, as YAML or JSON (secrets are never fetched; env secrets are masked).
export function RawObject({ obj }: { obj: ObjRef }) {
  const s = useStore();
  const [fmt, setFmt] = useState<'yaml' | 'json'>('yaml');
  const key = `${obj.kind}/${obj.namespace || ''}/${obj.name}`;
  useEffect(() => { void loadRaw(obj); }, [key]);
  const st = s.raw[key];
  if (!st || st.loading) return <div class="insp-pad"><Spinner /> Loading {obj.kind} {obj.name}…</div>;
  if (st.error) return <Empty icon="info" title="Object not available">{st.error.message}</Empty>;
  const text = fmt === 'yaml' ? toYaml(st.data) : JSON.stringify(st.data, null, 2);
  return (
    <div class="raw">
      <div class="raw-bar">
        <Segmented value={fmt} onChange={setFmt} options={[{ value: 'yaml', label: 'YAML' }, { value: 'json', label: 'JSON' }]} />
        <span class="muted small">as of the last scan · managedFields stripped</span>
        <CopyButton text={text} what={`${fmt.toUpperCase()} copied`} />
      </div>
      <pre class="code">{text}</pre>
    </div>
  );
}

export function eventsFor(objs: ObjRef[]): EventRow[] {
  const keys = new Set(objs.map((o) => `${o.kind}/${o.namespace || ''}/${o.name}`));
  return (S.report?.events.rows || []).filter((e) => keys.has(`${e.object.kind}/${e.object.namespace || ''}/${e.object.name}`)).sort((a, b) => (b.last || 0) - (a.last || 0));
}

export function EventList({ events, showObject = false, empty = 'No recent event for this object.' }: { events: { type: string; reason: string; message: string; count: number; last: number | null; first?: number | null; object?: ObjRef; container?: string | null }[]; showObject?: boolean; empty?: string }) {
  const [all, setAll] = useState(false);
  if (!events.length) return <div class="muted insp-pad">{empty}</div>;
  const shown = all ? events : events.slice(0, 40);
  return (
    <div>
      <ul class="event-list">
        {shown.map((e, i) => (
          <li key={i} class={e.type === 'Warning' ? 'ev-warn' : ''}>
            <div class="ev-head">
              <Badge tone={e.type === 'Warning' ? 'warn' : 'neutral'}>{e.reason}</Badge>
              {e.count > 1 && <span class="muted small">×{e.count}</span>}
              {showObject && e.object && <span class="mono small muted">{e.object.kind} {e.object.name}</span>}
              {e.container && <span class="tag">{e.container}</span>}
              <span class="ev-time muted small" title={`first ${dateTime(e.first)}\nlast ${dateTime(e.last)}`}>{e.last ? `${ago(e.last)} · ${clock(e.last)}` : ''}</span>
            </div>
            <div class="ev-msg">{e.message}</div>
          </li>
        ))}
      </ul>
      {events.length > shown.length && <button type="button" class="link small insp-pad" onClick={() => setAll(true)}>Show {events.length - shown.length} more</button>}
    </div>
  );
}

export function ProblemList({ ids, findings, empty = 'No problem detected.' }: { ids?: string[]; findings?: Finding[]; empty?: string }) {
  const list = (findings || (ids || []).map((id) => S.idx?.byId.get(id)).filter((f): f is Finding => !!f))
    .slice().sort((a, b) => Number(isMuted(a.id)) - Number(isMuted(b.id)) || SEV_RANK[b.severity]! - SEV_RANK[a.severity]! || a.causedBy.length - b.causedBy.length);
  if (!list.length) return <div class="ok-text insp-pad">{empty}</div>;
  return (
    <ul class="problem-list">
      {list.map((f) => (
        <li key={f.id} class={isMuted(f.id) ? 'muted-row' : ''}>
          <FindingLink f={f} />
          <div class="pl-rc muted small">{f.causedBy.length ? 'symptom — ' : ''}{f.rootCause.inherited ? f.rootCause.inherited.title : f.rootCause.summary}</div>
        </li>
      ))}
    </ul>
  );
}

export function PodMiniTable({ pods, showNode = false, showNs = false }: { pods: PodRow[]; showNode?: boolean; showNs?: boolean }) {
  const [all, setAll] = useState(false);
  if (!pods.length) return <div class="muted insp-pad">No pod.</div>;
  const shown = all ? pods : pods.slice(0, 50);
  return (
    <div class="mini-scroll">
      <table class="mini-table">
        <thead><tr><th>Pod</th><th>Status</th><th class="num">Ready</th><th class="num">Restarts</th>{showNode && <th>Node</th>}<th>Age</th></tr></thead>
        <tbody>
          {shown.map((p) => {
            const sev = p.problems.map((id) => S.idx?.byId.get(id)?.severity).filter(Boolean);
            return (
              <tr key={`${p.namespace}/${p.name}`} class={`clickable${sev.includes('critical') ? ' sevrow-critical' : sev.includes('warning') ? ' sevrow-warning' : ''}`} onClick={() => inspect({ type: 'pod', namespace: p.namespace, name: p.name })}>
                <td><span class="mono small">{p.name}</span>{showNs && <div class="muted small">{p.namespace}</div>}</td>
                <td><StatusText status={p.status} /></td>
                <td class="num">{p.ready}</td>
                <td class="num">{p.restarts || <span class="muted">0</span>}</td>
                {showNode && <td class="mono small">{p.node || '—'}</td>}
                <td class="muted small">{ago(p.created).replace(' ago', '')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {pods.length > shown.length && <button type="button" class="link small insp-pad" onClick={() => setAll(true)}>Show {pods.length - shown.length} more</button>}
    </div>
  );
}

export const NotFound = ({ what }: { what: string }) => (
  <Empty icon="info" title={`${what} is not in the last scan`}>It may have been deleted or renamed since. Rescan to refresh.</Empty>
);
