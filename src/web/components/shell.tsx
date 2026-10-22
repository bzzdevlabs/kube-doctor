// Application chrome: top bar, navigation rail, filters panel, overlays, shortcuts.
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from '../app/icons';
import {
  S, set, useStore, VIEWS, navigate, scan, setContext, setPref, toggleTheme, toggleFilters, togglePin, setPanelWidth, isDark,
  setQuery, toggleFacet, setFacet, clearFacets, setNamespaces, closeInspector, inspectorStep, currentTarget,
  exportJson, reportMarkdown, copy, setCollapsed, type ViewId,
} from '../app/store';
import { useDataset, isDatasetView, rowSeverity, type DatasetView, type FacetResult } from '../app/data';
import { ago, SEV_TONE, type Tone } from '../app/fmt';
import { Button, IconButton, SearchBox, Menu, Kbd, Spinner, Badge, Dot } from './ui';
import { SidePanel } from './panel';
import { activeList } from './table';

// ---------------------------------------------------------------- top bar
export function Topbar() {
  const s = useStore();
  const r = s.report;
  const filt = useDataset(isDatasetView(s.view) ? s.view : 'problems');
  const activeFilters = isDatasetView(s.view) ? filt.activeCount : s.ns.length ? 1 : 0;
  return (
    <header class="topbar">
      <div class="topbar-left">
        <button type="button" class="brand" onClick={() => navigate('overview')} title="Overview">
          <span class="brand-mark"><Icon name="logo" size={18} /></span>
          <span class="brand-name">Kube Doctor</span>
        </button>
        <div class="ctx-picker" title="Kube context (read from your kubeconfig, never modified)">
          <Icon name="nodes" size={14} />
          <select value={s.context || ''} onChange={(e) => setContext(e.currentTarget.value)} aria-label="Kube context">
            {s.contexts.map((c) => <option key={c} value={c}>{c}{c === s.current ? ' (current)' : ''}</option>)}
          </select>
        </div>
        <NamespacePicker />
      </div>
      <button type="button" class="omnibox" onClick={() => set((x) => { x.palette = true; })} title="Search everything and run commands">
        <Icon name="search" size={15} />
        <span>Search problems, pods, workloads, nodes…</span>
        <span class="kbds"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>
      </button>
      <div class="topbar-right">
        <span class="scan-status" title={r ? `Scanned ${new Date(r.meta.scannedAt).toLocaleString()} in ${(r.meta.durationMs / 1000).toFixed(1)}s` : ''}>
          {s.scanning ? <><Spinner size={13} /><span>Scanning…</span></> : r ? <><Dot tone={s.error ? 'warn' : 'ok'} /><span>{s.error ? 'Last refresh failed' : `Updated ${ago(r.meta.scannedAt)}`}</span></> : null}
        </span>
        <select class="auto-select" value={String(s.auto)} onChange={(e) => setPref('auto', Number(e.currentTarget.value))} title="Auto-refresh" aria-label="Auto-refresh">
          <option value="0">Manual</option>
          <option value="30">Every 30s</option>
          <option value="60">Every 1m</option>
          <option value="300">Every 5m</option>
        </select>
        <Button icon="refresh" variant="primary" onClick={() => void scan()} disabled={s.scanning} title="Rescan the cluster (R)">{s.scanning ? 'Scanning' : 'Rescan'}</Button>
        <span class="sep" />
        <button type="button" class={`icon-btn with-badge${s.filt.open ? ' active' : ''}`} onClick={() => toggleFilters()} title="Filters panel (F)" aria-label="Filters">
          <Icon name="filter" size={16} />
          {activeFilters ? <span class="mini-badge">{activeFilters}</span> : null}
        </button>
        <Menu icon="download" title="Export" items={[
          { icon: 'copy', label: 'Copy report as Markdown', onClick: () => { if (s.report) void copy(reportMarkdown(), 'Report copied'); } },
          { icon: 'download', label: 'Download full report (JSON)', onClick: exportJson },
        ]} />
        <IconButton icon={isDark() ? 'sun' : 'moon'} title="Toggle theme (T)" onClick={toggleTheme} />
        <IconButton icon="keyboard" title="Keyboard shortcuts (?)" onClick={() => set((x) => { x.help = true; })} />
      </div>
    </header>
  );
}

function NamespacePicker() {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const list = s.report?.inventory.namespaces || [];
  const shown = list.filter((n) => !q || n.name.includes(q.toLowerCase()));
  const label = !s.ns.length ? 'All namespaces' : s.ns.length === 1 ? s.ns[0] : `${s.ns[0]} +${s.ns.length - 1}`;
  const pick = (name: string, multi: boolean) => {
    const on = s.ns.includes(name);
    if (multi) setNamespaces(on ? s.ns.filter((x) => x !== name) : [...s.ns, name]);
    else {
      setNamespaces(on && s.ns.length === 1 ? [] : [name]);
      setOpen(false);
    }
  };
  return (
    <div class="ns-picker" ref={ref}>
      <button type="button" class={`ns-button${s.ns.length ? ' filtered' : ''}`} onClick={() => setOpen(!open)} title="Namespace filter (applies to every page)">
        <Icon name="namespaces" size={14} /><span>{label}</span><Icon name="chevronDown" size={13} />
      </button>
      {open && (
        <div class="popover ns-popover">
          <div class="popover-search"><SearchBox value={q} onInput={setQ} placeholder="Find namespace" /></div>
          <button type="button" class={`ns-item${!s.ns.length ? ' on' : ''}`} onClick={() => { setNamespaces([]); setOpen(false); }}>
            <span class="check">{!s.ns.length ? '✓' : ''}</span><span>All namespaces</span>
          </button>
          <div class="ns-list">
            {shown.map((n) => {
              const sev = rowSeverity(n.problems);
              return (
                <button key={n.name} type="button" class={`ns-item${s.ns.includes(n.name) ? ' on' : ''}`} onClick={(e) => pick(n.name, e.shiftKey || e.ctrlKey || e.metaKey)}>
                  <span class="check">{s.ns.includes(n.name) ? '✓' : ''}</span>
                  <span class="ns-name">{n.name}</span>
                  {sev && <Dot tone={SEV_TONE[sev]} />}
                  <span class="muted small">{n.pods.total} pods</span>
                </button>
              );
            })}
          </div>
          <div class="popover-foot muted small">Click to select one · Ctrl/Shift+click for several</div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------- nav rail
export function NavRail() {
  const s = useStore();
  const bad = (sev: string | null) => sev === 'critical' || sev === 'warning';
  const counts: Partial<Record<ViewId, number>> = {
    incidents: useDataset('incidents').rows.length,
    problems: useDataset('problems').rows.filter((f) => f.severity !== 'info').length,
    pods: useDataset('pods').base.filter((p) => bad(rowSeverity(p.problems))).length,
    workloads: useDataset('workloads').base.filter((w) => bad(rowSeverity(w.problems))).length,
    nodes: (s.report?.nodes || []).filter((n) => n.ready !== 'Ready').length,
    events: useDataset('events').base.filter((e) => e.type === 'Warning').length,
  };
  const tone: Partial<Record<ViewId, Tone>> = { incidents: 'crit', problems: 'crit', pods: 'warn', workloads: 'warn', nodes: 'crit', events: 'neutral' };
  const collapsed = s.navCollapsed;
  return (
    <nav class={`navrail${collapsed ? ' collapsed' : ''}`} aria-label="Views">
      <div class="nav-items">
        {VIEWS.map((v) => {
          const n = counts[v.id];
          return (
            <button key={v.id} type="button" class={`nav-item${s.view === v.id ? ' active' : ''}`} onClick={() => navigate(v.id)} title={`${v.label} (g ${v.key})`}>
              <Icon name={v.icon} size={18} />
              <span class="nav-label">{v.label}</span>
              {n ? <span class={`nav-count tone-${tone[v.id]}`}>{n > 999 ? '999+' : n}</span> : null}
            </button>
          );
        })}
      </div>
      <div class="nav-foot">
        {s.demo && <Badge tone="warn" title="Simulated cluster">{collapsed ? 'D' : 'DEMO'}</Badge>}
        <Badge tone="ok" title="Kube Doctor only reads: get/list/logs/top. Nothing is ever modified.">{collapsed ? 'RO' : 'READ-ONLY'}</Badge>
        <button type="button" class="nav-item nav-collapse" onClick={() => setPref('navCollapsed', !collapsed)} title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={16} />
          <span class="nav-label">Collapse</span>
        </button>
      </div>
    </nav>
  );
}

// ------------------------------------------------------------ filters panel
const VALUE_TONE: Record<string, Tone> = { critical: 'crit', warning: 'warn', info: 'info', Critical: 'crit', Warning: 'warn', 'Info only': 'info', Healthy: 'ok', Ready: 'ok', NotReady: 'crit', Unknown: 'crit' };

function FacetGroup({ view, facet }: { view: DatasetView; facet: FacetResult }) {
  const s = useStore();
  const id = `facet.${view}.${facet.key}`;
  const collapsed = s.collapsed[id] ?? false;
  const [showAll, setShowAll] = useState(false);
  const [q, setQ] = useState('');
  const sel = facet.values.filter((v) => v.selected).length;
  const max = Math.max(1, ...facet.values.map((v) => v.count));
  let values = q ? facet.values.filter((v) => v.value.toLowerCase().includes(q.toLowerCase())) : facet.values;
  const hidden = values.length > 8 && !showAll ? values.length - 8 : 0;
  if (hidden) values = [...values.slice(0, 8), ...values.slice(8).filter((v) => v.selected)];
  return (
    <div class={`facet${collapsed ? ' is-collapsed' : ''}`}>
      <div class="facet-head">
        <button type="button" class="facet-toggle" onClick={() => setCollapsed(id, !collapsed)}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={13} className="chev" />
          <span>{facet.label}</span>
          {sel ? <span class="mini-badge">{sel}</span> : null}
        </button>
        {sel ? <button type="button" class="link small" onClick={() => setFacet(view, facet.key, [])}>clear</button> : null}
      </div>
      {!collapsed && (
        <div class="facet-body">
          {facet.values.length > 12 && <input class="facet-search" type="search" placeholder={`Filter ${facet.label.toLowerCase()}…`} value={q} onInput={(e) => setQ(e.currentTarget.value)} />}
          {values.map((v) => (
            <label key={v.value} class={`facet-row${v.selected ? ' on' : ''}${v.count === 0 && !v.selected ? ' zero' : ''}`}>
              <input type="checkbox" checked={v.selected} onChange={() => toggleFacet(view, facet.key, v.value)} />
              {VALUE_TONE[v.value] && <Dot tone={VALUE_TONE[v.value]} />}
              <span class="facet-value" title={v.value}>{v.value}</span>
              <span class="facet-count">{v.count}</span>
              <span class="facet-bar" style={{ width: `${(v.count / max) * 100}%` }} />
            </label>
          ))}
          {!facet.values.length && <div class="muted small">No values</div>}
          {(hidden > 0 || showAll) && <button type="button" class="link small facet-more" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show less' : `Show ${hidden} more`}</button>}
        </div>
      )}
    </div>
  );
}

export function FiltersPanel() {
  const s = useStore();
  const view: DatasetView | null = isDatasetView(s.view) ? s.view : null;
  const ds = useDataset(view || 'problems');
  const facets = view ? ds.facets : ds.facets.filter((f) => f.key === 'namespace');
  const label = (VIEWS.find((v) => v.id === s.view)?.label || '').toLowerCase();
  const target: DatasetView = view || 'problems';
  return (
    <SidePanel side="left" title="Filters" icon="filter" pinned={s.filt.pinned} width={s.filt.width} min={220}
      onResize={(w) => setPanelWidth('filt', w)} onClose={() => toggleFilters(false)} onTogglePin={() => togglePin('filt')}
      headerRight={(view ? ds.activeCount : s.ns.length) ? <button type="button" class="link small" onClick={() => (view ? clearFacets(view) : setNamespaces([]))} title="Clear all filters">Clear all</button> : null}>
      <div class="filters">
        {view ? (
          <>
            <SearchBox value={s.query[view] || ''} onInput={(v) => setQuery(view, v)} placeholder={`Search ${label}`} />
            <div class="filters-summary">
              {ds.rows.length} of {ds.total} {label} shown
              {ds.mutedCount ? <> · <button type="button" class="link" onClick={() => toggleFacet(view, 'state', 'Muted')}>{ds.mutedCount} muted</button></> : null}
            </div>
          </>
        ) : <div class="filters-summary">On this page only the namespace filter applies.</div>}
        {facets.map((f) => <FacetGroup key={f.key} view={target} facet={f} />)}
      </div>
    </SidePanel>
  );
}

// Active filters, shown above lists so they are visible with the panel closed.
export function FilterChips({ view }: { view: DatasetView }) {
  const s = useStore();
  const ds = useDataset(view);
  const chips: { key: string; label: string; value: string }[] = [];
  for (const f of ds.facets) for (const v of f.values.filter((x) => x.selected)) chips.push({ key: f.key, label: f.label, value: v.value });
  const q = s.query[view];
  if (!chips.length && !q) return null;
  return (
    <div class="chips-row">
      <Icon name="filter" size={13} />
      {q && <span class="chip">“{q}”<button type="button" onClick={() => setQuery(view, '')} aria-label="Remove search"><Icon name="x" size={11} /></button></span>}
      {chips.map((c) => (
        <span key={`${c.key}:${c.value}`} class="chip">
          <span class="muted">{c.label}:</span> {c.value}
          <button type="button" onClick={() => toggleFacet(view, c.key, c.value)} aria-label="Remove filter"><Icon name="x" size={11} /></button>
        </span>
      ))}
      <button type="button" class="link small" onClick={() => clearFacets(view)}>Clear all</button>
    </div>
  );
}

// ---------------------------------------------------------------- overlays
export function Toasts() {
  const s = useStore();
  return <div class="toasts" aria-live="polite">{s.toasts.map((t) => <div class={`toast toast-${t.tone}`} key={t.id}>{t.message}</div>)}</div>;
}

const SHORTCUTS: [string, string][] = [
  ['Ctrl K', 'Search everything / run a command'],
  ['/', 'Search in the current page'],
  ['j / k', 'Next / previous row (opens it in the inspector)'],
  ['Enter', 'Open the selected row'],
  ['Esc', 'Close the inspector, palette or this help'],
  ['[ / ]', 'Back / forward in the inspector history'],
  ['p', 'Pin / unpin the inspector'],
  ['f', 'Toggle the filters panel'],
  ['r', 'Rescan the cluster'],
  ['t', 'Toggle light / dark theme'],
  ...VIEWS.map((v): [string, string] => [`g ${v.key}`, `Go to ${v.label}`]),
];

export function Help() {
  const s = useStore();
  if (!s.help) return null;
  const close = () => set((x) => { x.help = false; });
  return (
    <div class="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="dialog" role="dialog" aria-label="Keyboard shortcuts">
        <div class="dialog-head"><Icon name="keyboard" size={16} /><b>Keyboard shortcuts</b><IconButton icon="x" title="Close" onClick={close} className="ml-auto" /></div>
        <div class="shortcuts">
          {SHORTCUTS.map(([k, d]) => <div key={k} class="shortcut"><span>{k.split(' ').map((x) => <Kbd key={x}>{x}</Kbd>)}</span><span>{d}</span></div>)}
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- hotkeys
let gPending = false;

function moveCursor(delta: number): void {
  const { keys, open, selected } = activeList;
  if (!keys.length || !open) return;
  const i = selected ? keys.indexOf(selected) : -1;
  const next = keys[i < 0 ? (delta > 0 ? 0 : keys.length - 1) : Math.max(0, Math.min(keys.length - 1, i + delta))]!;
  open(next);
  requestAnimationFrame(() => document.querySelector(`[data-key="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' }));
}

export function installHotkeys(): void {
  document.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      set((x) => { x.palette = !x.palette; });
      return;
    }
    if (e.key === 'Escape') {
      if (S.palette || S.help) set((x) => { x.palette = false; x.help = false; });
      else if (typing) el.blur();
      else if (currentTarget()) closeInspector();
      else if (S.filt.open && !S.filt.pinned) toggleFilters(false);
      return;
    }
    if (typing || e.altKey || e.ctrlKey || e.metaKey || S.palette) return;
    if (gPending) {
      gPending = false;
      const v = VIEWS.find((x) => x.key === e.key);
      if (v) navigate(v.id);
      return;
    }
    switch (e.key) {
      case 'g':
        gPending = true;
        setTimeout(() => { gPending = false; }, 1200);
        break;
      case '/': {
        const input = document.getElementById('view-search');
        if (input) {
          e.preventDefault();
          input.focus();
        }
        break;
      }
      case '?': set((x) => { x.help = !x.help; }); break;
      case 'j': moveCursor(1); break;
      case 'k': moveCursor(-1); break;
      case 'Enter': if (activeList.selected && activeList.open) activeList.open(activeList.selected); break;
      case '[': inspectorStep(-1); break;
      case ']': inspectorStep(1); break;
      case 'p': if (currentTarget()) togglePin('insp'); break;
      case 'f': toggleFilters(); break;
      case 'r': void scan(); break;
      case 't': toggleTheme(); break;
      default: break;
    }
  });
}
