// Ctrl+K command palette: jump to any problem, pod, workload, node or namespace, or run an action.
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Severity } from '../../shared/types';
import { Icon, type IconName } from '../app/icons';
import { S, set, useStore, VIEWS, navigate, scan, toggleTheme, toggleFilters, togglePin, inspect, setNamespaces, copy, reportMarkdown, exportJson, setPref, clearFacets, isMuted } from '../app/store';
import { matchTokens, SEV_RANK } from '../app/fmt';
import { SevBadge, Kbd } from './ui';

interface Item {
  group: string;
  label: string;
  sub?: string;
  keywords?: string;
  icon?: IconName;
  sev?: Severity;
  hint?: string;
  run: () => void;
}

function buildItems(q: string): Item[] {
  const out: Item[] = [];
  const take = (group: string, list: Omit<Item, 'group'>[], n: number) => {
    const hits = list.filter((x) => matchTokens(`${x.label} ${x.sub || ''} ${x.keywords || ''}`, q));
    out.push(...hits.slice(0, q ? n : Math.min(n, 5)).map((x) => ({ ...x, group })));
  };
  take('Actions', [
    { label: 'Rescan the cluster', icon: 'refresh', run: () => void scan(), hint: 'R' },
    { label: 'Toggle light / dark theme', icon: 'moon', run: toggleTheme, hint: 'T' },
    { label: 'Toggle the filters panel', icon: 'filter', run: () => toggleFilters(), hint: 'F' },
    { label: 'Pin / unpin the inspector', icon: 'pin', run: () => togglePin('insp'), hint: 'P' },
    { label: `Switch to ${S.density === 'compact' ? 'comfortable' : 'compact'} density`, icon: 'rows', run: () => setPref('density', S.density === 'compact' ? 'comfortable' : 'compact') },
    { label: 'Clear all filters on this page', icon: 'x', run: () => { if (S.view !== 'overview' && S.view !== 'scan') clearFacets(S.view); else setNamespaces([]); } },
    { label: 'Copy report as Markdown', icon: 'copy', run: () => { if (S.report) void copy(reportMarkdown(), 'Report copied'); } },
    { label: 'Download report as JSON', icon: 'download', run: exportJson },
  ], q ? 6 : 3);
  take('Go to', VIEWS.map((v) => ({ label: v.label, icon: v.icon, run: () => navigate(v.id), hint: `g ${v.key}` })), 9);
  const r = S.report;
  if (r) {
    const findings = r.findings.filter((f) => !isMuted(f.id)).sort((a, b) => SEV_RANK[b.severity]! - SEV_RANK[a.severity]! || a.causedBy.length - b.causedBy.length);
    take('Problems', findings.map((f) => ({
      label: f.title, sub: `${f.category} · ${f.object.kind} ${f.object.namespace ? `${f.object.namespace}/` : ''}${f.object.name}`, sev: f.severity,
      keywords: `${f.rootCause.summary} ${f.instances.map((i) => i.pod).join(' ')}`, run: () => inspect({ type: 'finding', id: f.id }),
    })), 8);
    if (q) {
      take('Pods', r.inventory.pods.map((p) => ({ label: p.name, sub: `${p.namespace} · ${p.status} · ${p.node || 'unscheduled'}`, icon: 'pods' as const, run: () => inspect({ type: 'pod', namespace: p.namespace, name: p.name }) })), 8);
      take('Workloads', r.inventory.workloads.map((w) => ({ label: w.name, sub: `${w.kind} · ${w.namespace} · ${w.status}`, icon: 'workloads' as const, run: () => inspect({ type: 'workload', kind: w.kind, namespace: w.namespace, name: w.name }) })), 6);
      take('Nodes', r.nodes.map((n) => ({ label: n.name, sub: `${n.ready} · ${n.roles.join(', ')}`, icon: 'nodes' as const, run: () => inspect({ type: 'node', name: n.name }) })), 5);
      take('Namespaces', r.inventory.namespaces.map((n) => ({ label: n.name, sub: `${n.pods.total} pods · filter every page to this namespace`, icon: 'namespaces' as const, run: () => setNamespaces([n.name]) })), 5);
    }
  }
  return out;
}

export function Palette() {
  const s = useStore();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (s.palette) {
      setQ('');
      setSel(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [s.palette]);
  useEffect(() => { list.current?.querySelector('.pal-item.on')?.scrollIntoView({ block: 'nearest' }); }, [sel]);
  if (!s.palette) return null;
  const items = buildItems(q);
  const close = () => set((x) => { x.palette = false; });
  const run = (it: Item) => {
    close();
    it.run();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(items.length - 1, sel + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(0, sel - 1));
    } else if (e.key === 'Enter' && items[sel]) {
      e.preventDefault();
      run(items[sel]!);
    }
  };
  let lastGroup: string | null = null;
  return (
    <div class="overlay overlay-top" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="palette" role="dialog" aria-label="Command palette">
        <div class="pal-input">
          <Icon name="search" size={17} />
          <input ref={input} value={q} placeholder="Type to search problems, pods, workloads, nodes, namespaces or actions…" onInput={(e) => { setQ(e.currentTarget.value); setSel(0); }} onKeyDown={onKey} />
          <Kbd>Esc</Kbd>
        </div>
        <div class="pal-list" ref={list}>
          {items.length ? items.map((it, i) => {
            const head = it.group !== lastGroup ? <div class="pal-group">{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <div key={`${it.group}:${i}`}>
                {head}
                <button type="button" class={`pal-item${i === sel ? ' on' : ''}`} onMouseMove={() => { if (sel !== i) setSel(i); }} onClick={() => run(it)}>
                  {it.sev ? <SevBadge sev={it.sev} compact /> : <Icon name={it.icon || 'chevronRight'} size={15} />}
                  <span class="pal-label">{it.label}</span>
                  {it.sub && <span class="pal-sub">{it.sub}</span>}
                  {it.hint && <span class="pal-hint">{it.hint}</span>}
                </button>
              </div>
            );
          }) : <div class="pal-empty">No match for “{q}”</div>}
        </div>
        <div class="pal-foot"><span><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span><span><Kbd>Enter</Kbd> open</span><span><Kbd>Esc</Kbd> close</span></div>
      </div>
    </div>
  );
}
