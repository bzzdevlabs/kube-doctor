'use strict';

// ------------------------------------------------------------------ helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const SEV_RANK = { critical: 3, warning: 2, info: 1 };

const store = {
  get(k, d) { try { const v = localStorage.getItem(`kd.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`kd.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const state = {
  contexts: [], current: null, context: null, demo: false,
  report: null, byId: new Map(), effects: new Map(), loading: false, error: null,
  tab: (location.hash.replace('#', '') || store.get('tab', 'incidents')),
  ns: store.get('ns', ''), q: '', sev: store.get('sev', { critical: true, warning: true, info: false }), cat: '',
  ev: { q: '', warningsOnly: true, reason: '' },
  selected: null, deep: {}, deepPod: {}, raw: {}, logView: {}, expanded: new Set(),
  timer: null,
};

async function api(path, params = {}) {
  const u = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  const res = await fetch(u, { headers: { Accept: 'application/json' } });
  const type = res.headers.get('content-type') || '';
  const body = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const e = new Error((body && body.error) || body || res.statusText);
    if (body && typeof body === 'object') Object.assign(e, body);
    throw e;
  }
  return body;
}

function toMs(t) { return t == null ? NaN : typeof t === 'number' ? t : Date.parse(t); }
function dur(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
function ago(t) { const ms = Date.now() - toMs(t); return Number.isFinite(ms) ? `${dur(ms)} ago` : '—'; }
function clock(t) { const d = new Date(toMs(t)); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function bytes(b) {
  if (b == null || !Number.isFinite(b)) return '—';
  const u = ['B', 'Ki', 'Mi', 'Gi', 'Ti'];
  let i = 0;
  while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1).replace(/\.0$/, '')}${u[i]}`;
}
function cpu(c) { return c == null || !Number.isFinite(c) ? '—' : c < 1 ? `${Math.round(c * 1000)}m` : `${+c.toFixed(2)}`; }
function plural(n, w) { return `${n} ${w}${n === 1 ? '' : 's'}`; }

const sevPill = (s) => `<span class="sev ${esc(s)}">${esc(s)}</span>`;
const catChip = (c) => `<span class="cat">${esc(c)}</span>`;
const confPill = (c) => (c ? `<span class="conf ${esc(c)}" title="Confidence of the root-cause diagnosis">${esc(c)} confidence</span>` : '');
const dot = (s) => `<span class="dot ${esc(s)}"></span>`;
function objLabel(o, extra = '') {
  if (!o) return '';
  return `<span class="obj"><span class="kind">${esc(o.kind)}</span> ${o.namespace ? `${esc(o.namespace)}/` : ''}${esc(o.name)}${extra}</span>`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 1800);
}

// Widths/percentages are applied through the CSSOM (CSP forbids inline style attributes).
function applyWidths(root = document) {
  for (const el of $$('[data-w]', root)) el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w) || 0))}%`;
}

// ------------------------------------------------------------- data access
function findingNamespaces(f) { return [f.object.namespace, ...(f.instances || []).map((i) => i.namespace)]; }
function inNs(f) { return !state.ns || findingNamespaces(f).includes(state.ns); }
function matchesQuery(f, q) {
  if (!q) return true;
  const hay = [f.title, f.category, (f.tags || []).join(' '), f.object.kind, f.object.namespace, f.object.name, f.rootCause?.summary, (f.instances || []).map((i) => i.pod).join(' '), f.node].join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}
function visibleFindings() {
  return state.report.findings.filter((f) => inNs(f) && state.sev[f.severity] && (!state.cat || f.category === state.cat || (f.tags || []).includes(state.cat)) && matchesQuery(f, state.q));
}

function setReport(r) {
  state.report = r;
  state.byId = new Map(r.findings.map((f) => [f.id, f]));
  state.effects = new Map();
  for (const f of r.findings) for (const c of f.causedBy || []) {
    if (!state.effects.has(c)) state.effects.set(c, []);
    state.effects.get(c).push(f.id);
  }
  for (const list of state.effects.values()) list.sort((a, b) => SEV_RANK[state.byId.get(b).severity] - SEV_RANK[state.byId.get(a).severity]);
  state.raw = {};
  const nsSel = $('#ns');
  const namespaces = r.namespaces || [];
  if (state.ns && !namespaces.includes(state.ns)) namespaces.unshift(state.ns);
  nsSel.innerHTML = `<option value="">All namespaces</option>${namespaces.map((n) => `<option value="${esc(n)}"${n === state.ns ? ' selected' : ''}>${esc(n)}</option>`).join('')}`;
  $('#demo-badge').hidden = !r.demo;
  if (state.selected && !state.byId.has(state.selected)) closeDrawer();
}

// ------------------------------------------------------------------- scan
async function loadContexts() {
  try {
    const c = await api('/api/contexts');
    state.contexts = c.contexts;
    state.current = c.current;
    state.demo = c.demo;
    if (!state.context || !c.contexts.includes(state.context)) state.context = c.current || c.contexts[0] || null;
    $('#ctx').innerHTML = c.contexts.length
      ? c.contexts.map((n) => `<option value="${esc(n)}"${n === state.context ? ' selected' : ''}>${esc(n)}${n === c.current ? ' (current)' : ''}</option>`).join('')
      : '<option value="">(no contexts)</option>';
  } catch (e) {
    state.error = e;
  }
}

async function scan({ quiet = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  if (!quiet) state.error = null;
  updateBusy();
  try {
    const report = await api('/api/scan', { context: state.context, logs: $('#logs').checked ? '1' : '0' });
    state.error = null;
    setReport(report);
  } catch (e) {
    state.error = e;
  } finally {
    state.loading = false;
    updateBusy();
    render();
    if (state.selected) renderDrawer();
  }
}

function updateBusy() {
  $('#progress').hidden = !state.loading;
  const b = $('#scan');
  b.disabled = state.loading;
  b.textContent = state.loading ? 'Scanning…' : 'Rescan';
}

function setAuto(sec) {
  clearInterval(state.timer);
  state.timer = null;
  if (sec > 0) state.timer = setInterval(() => { if (!document.hidden) scan({ quiet: true }); }, sec * 1000);
}

// ----------------------------------------------------------------- render
function render() {
  renderStrip();
  if (!state.report) {
    $('#summary').innerHTML = '';
    $('#tabs').innerHTML = '';
    $('#view').innerHTML = state.error ? renderError(state.error) : state.loading ? '<div class="loading-big"><div class="spinner"></div><div>Reading the cluster (read-only)…</div></div>' : '';
    return;
  }
  renderSummary();
  renderTabs();
  const view = $('#view');
  const errorBanner = state.error ? renderError(state.error, true) : '';
  const fn = { incidents: renderIncidents, findings: renderFindings, events: renderEvents, nodes: renderNodes, coverage: renderCoverage }[state.tab] || renderIncidents;
  view.innerHTML = errorBanner + fn();
  applyWidths(view);
}

function renderError(e, compact = false) {
  return `<div class="notice error">
    <h3>${compact ? 'Last refresh failed' : 'Could not scan the cluster'}</h3>
    <p>${esc(e.message)}</p>
    ${e.hint ? `<p class="muted">${esc(e.hint)}</p>` : ''}
    ${e.detail ? `<details><summary>kubectl output</summary><pre class="block">${esc(e.detail)}</pre></details>` : ''}
    <p><button class="btn small" data-action="scan" type="button">Retry</button></p>
  </div>`;
}

function renderStrip() {
  const r = state.report;
  const el = $('#strip');
  if (!r) {
    el.innerHTML = state.context ? `<span>Context <b>${esc(state.context)}</b></span>` : '';
    return;
  }
  const m = r.meta;
  const s = r.summary;
  const health = m.health?.checks?.length ? (m.health.ok ? '<span>API server <b>healthy</b></span>' : '<span class="warnline">API server <b>degraded</b></span>') : '';
  el.innerHTML = [
    `<span>Context <b>${esc(m.context)}</b></span>`,
    `<span>Cluster <b>${esc(m.cluster || '?')}</b> <span class="faint mono">${esc(m.server || '')}</span></span>`,
    `<span>Kubernetes <b>${esc(m.version || '?')}</b></span>`,
    `<span>Nodes <b>${s.nodes.ready}/${s.nodes.total}</b> ready</span>`,
    `<span>Pods <b>${s.pods.total}</b> (${s.pods.running} running, ${s.pods.pending} pending, ${s.pods.failed} failed)</span>`,
    health,
    m.metricsAvailable ? '<span>Metrics <b>available</b></span>' : `<span class="faint" title="${esc(m.metricsError || '')}">Metrics unavailable</span>`,
    `<span>Scanned <b>${esc(clock(m.scannedAt))}</b> in ${(m.durationMs / 1000).toFixed(1)}s</span>`,
  ].filter(Boolean).join('');
}

function renderSummary() {
  const r = state.report;
  const fs = r.findings.filter(inNs);
  const count = (sev) => fs.filter((f) => f.severity === sev).length;
  const incidents = r.incidents.filter((i) => !state.ns || i.namespaces.includes(state.ns));
  const pods = r.summary.pods;
  const healthyPods = Math.max(0, pods.total - pods.succeeded - pods.withProblems);
  const warnEvents = r.events.rows.filter((e) => e.type === 'Warning' && (!state.ns || e.object.namespace === state.ns)).length;
  const cats = new Map();
  for (const f of fs) {
    for (const label of new Set([f.category, ...(f.tags || []).filter((t) => r.summary.categories.some((c) => c.name === t))])) {
      const c = cats.get(label) || { name: label, n: 0, sev: 'info' };
      c.n++;
      if (SEV_RANK[f.severity] > SEV_RANK[c.sev]) c.sev = f.severity;
      cats.set(label, c);
    }
  }
  const chips = [...cats.values()].sort((a, b) => SEV_RANK[b.sev] - SEV_RANK[a.sev] || b.n - a.n);
  $('#summary').innerHTML = `
    <div class="tiles">
      <div class="tile crit clickable" data-sevonly="critical"><div class="k">Critical</div><div class="v">${count('critical')}</div><div class="s">problems breaking workloads</div></div>
      <div class="tile warn clickable" data-sevonly="warning"><div class="k">Warnings</div><div class="v">${count('warning')}</div><div class="s">degraded or at risk</div></div>
      <div class="tile info clickable" data-tab="incidents"><div class="k">Root causes</div><div class="v">${incidents.length}</div><div class="s">independent incidents</div></div>
      <div class="tile ${pods.withProblems ? 'warn' : 'ok'}"><div class="k">Pods with problems</div><div class="v">${pods.withProblems}<span class="faint"> / ${pods.total}</span></div><div class="s">${healthyPods} healthy, ${pods.succeeded} completed</div></div>
      <div class="tile ${r.summary.nodes.ready < r.summary.nodes.total ? 'crit' : 'ok'} clickable" data-tab="nodes"><div class="k">Nodes ready</div><div class="v">${r.summary.nodes.ready}<span class="faint"> / ${r.summary.nodes.total}</span></div><div class="s">${r.summary.nodes.cordoned} cordoned</div></div>
      <div class="tile clickable" data-tab="events"><div class="k">Warning events</div><div class="v">${warnEvents}</div><div class="s">${r.events.total} events total</div></div>
    </div>
    <div class="chips">${chips.slice(0, state.allChips ? chips.length : 14).map((c) => `<button type="button" class="chip ${esc(c.sev)}${state.cat === c.name ? ' active' : ''}" data-cat="${esc(c.name)}">${esc(c.name)} <span class="n">${c.n}</span></button>`).join('')}${chips.length > 14 ? `<button type="button" class="chip" data-action="chips">${state.allChips ? 'show less' : `+${chips.length - 14} more types`}</button>` : ''}${state.cat ? '<button type="button" class="chip" data-cat="">✕ clear filter</button>' : ''}</div>`;
}

function renderTabs() {
  const r = state.report;
  const tabs = [
    ['incidents', 'Root causes', r.incidents.filter((i) => !state.ns || i.namespaces.includes(state.ns)).length],
    ['findings', 'All problems', r.findings.filter(inNs).length],
    ['events', 'Events', r.events.rows.filter((e) => e.type === 'Warning' && (!state.ns || e.object.namespace === state.ns)).length],
    ['nodes', 'Nodes', r.nodes.length],
    ['coverage', 'Scan coverage', r.coverage.filter((c) => c.status !== 'ok').length || ''],
  ];
  $('#tabs').innerHTML = tabs.map(([id, label, n]) => `<button type="button" role="tab" class="tab${state.tab === id ? ' active' : ''}" data-tab="${id}">${label}${n !== '' ? `<span class="count">${n}</span>` : ''}</button>`).join('');
}

// ------------------------------------------------------------- incidents
function renderTree(id, seen, depth) {
  const kids = (state.effects.get(id) || []).filter((k) => !seen.has(k));
  if (!kids.length || depth > 6) return '';
  const key = `${id}@${depth}`;
  const limit = state.expanded.has(key) ? kids.length : 6;
  const items = kids.slice(0, limit).map((k) => {
    seen.add(k);
    const f = state.byId.get(k);
    const sub = renderTree(k, seen, depth + 1);
    return `<li><span class="node" data-open="${esc(k)}">${dot(f.severity)}${catChip(f.category)} ${objLabel(f.object, f.instances.length > 1 ? ` <span class="tag">×${f.instances.length}</span>` : '')} <span class="muted">${esc(shortTitle(f))}</span></span>${sub ? `<ul>${sub}</ul>` : ''}</li>`;
  }).join('');
  const more = kids.length > limit ? `<li><a class="more-toggle" data-expand="${esc(key)}">+ ${kids.length - limit} more</a></li>` : '';
  return items + more;
}

function shortTitle(f) {
  const t = f.title || '';
  return t.length > 110 ? `${t.slice(0, 108)}…` : t;
}

function renderIncidents() {
  const r = state.report;
  let incs = r.incidents.filter((i) => !state.ns || i.namespaces.includes(state.ns));
  if (state.q) incs = incs.filter((i) => [i.rootId, ...i.impacted].some((id) => matchesQuery(state.byId.get(id), state.q)));
  const toolbar = `<div class="toolbar"><input type="search" id="q" placeholder="Search problems, pods, namespaces… (press /)" value="${esc(state.q)}"><span class="muted">Problems are grouped by root cause: fix the top item of each card and its dependent problems should clear.</span></div>`;
  if (!incs.length) {
    return `${toolbar}<div class="notice"><div class="empty"><div class="big">✅</div><b>No active problem${state.ns ? ` in namespace ${esc(state.ns)}` : ''}.</b><div class="muted">Informational findings are listed under “All problems”.</div></div></div>`;
  }
  return `${toolbar}<div class="incidents">${incs.map((i) => {
    const f = state.byId.get(i.rootId);
    const seen = new Set([f.id]);
    const tree = renderTree(f.id, seen, 0);
    return `<article class="incident ${esc(i.severity)}">
      <div class="head">${sevPill(i.severity)}${catChip(f.category)}${(f.tags || []).filter((t) => t !== f.category).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}${objLabel(f.object, f.instances.length > 1 ? ` <span class="tag">×${f.instances.length} pods</span>` : '')}
        <span class="impact">${i.impacted.length ? `${plural(i.impacted.length, 'dependent problem')}` : 'isolated'}${i.pods ? ` · ${plural(i.pods, 'pod')}` : ''}</span></div>
      <h3 data-open="${esc(f.id)}">${esc(f.title)}</h3>
      <p class="rc-line"><b>Root cause:</b>${esc(f.rootCause.summary)} ${confPill(f.rootCause.confidence)}</p>
      ${tree ? `<div class="muted">Impact chain:</div><ul class="tree">${tree}</ul>` : ''}
    </article>`;
  }).join('')}</div>`;
}

// -------------------------------------------------------------- findings
function renderFindings() {
  const r = state.report;
  const list = visibleFindings();
  const cats = [...new Set(r.findings.flatMap((f) => [f.category]))].sort();
  const seg = ['critical', 'warning', 'info'].map((s) => `<button type="button" class="${state.sev[s] ? 'on' : ''}" data-sev="${s}">${s}</button>`).join('');
  const toolbar = `<div class="toolbar">
    <input type="search" id="q" placeholder="Search… (press /)" value="${esc(state.q)}">
    <span class="seg">${seg}</span>
    <select id="cat"><option value="">All categories</option>${cats.map((c) => `<option${c === state.cat ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>
    <span class="muted">${plural(list.length, 'problem')}</span>
  </div>`;
  if (!list.length) return `${toolbar}<div class="notice"><div class="empty">Nothing matches these filters.</div></div>`;
  return `${toolbar}<div class="table-wrap"><table>
    <thead><tr><th>Severity</th><th>Type</th><th>Object</th><th>Problem &amp; root cause</th><th class="nowrap">Last seen</th></tr></thead>
    <tbody>${list.slice(0, 1500).map((f) => `<tr class="clickable" data-open="${esc(f.id)}">
      <td class="nowrap">${sevPill(f.severity)}</td>
      <td>${catChip(f.category)}<div class="sub">${(f.tags || []).filter((t) => t !== f.category).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join(' ')}</div></td>
      <td>${objLabel(f.object)}${f.instances.length > 1 ? `<div class="sub">+${f.instances.length - 1} more pod(s)</div>` : ''}${f.owner ? `<div class="sub">${esc(f.owner.kind)} ${esc(f.owner.name)}</div>` : ''}</td>
      <td><div class="title">${esc(f.title)}</div><div class="sub">${f.causedBy.length ? '↳ symptom of another problem · ' : ''}${esc((f.rootCause.inherited ? `Root cause: ${f.rootCause.inherited.title}` : f.rootCause.summary || '').slice(0, 260))}</div></td>
      <td class="nowrap muted">${f.lastSeen || f.since ? esc(ago(f.lastSeen || f.since)) : ''}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------- events
function renderEvents() {
  const rows0 = state.report.events.rows.filter((e) => !state.ns || e.object.namespace === state.ns);
  const reasons = [...new Set(rows0.filter((e) => !state.ev.warningsOnly || e.type === 'Warning').map((e) => e.reason))].sort();
  const q = state.ev.q.toLowerCase();
  const rows = rows0.filter((e) => (!state.ev.warningsOnly || e.type === 'Warning') && (!state.ev.reason || e.reason === state.ev.reason) && (!q || `${e.reason} ${e.message} ${e.object.kind} ${e.object.namespace} ${e.object.name}`.toLowerCase().includes(q)));
  const toolbar = `<div class="toolbar">
    <input type="search" id="evq" placeholder="Filter events…" value="${esc(state.ev.q)}">
    <label class="ctl check"><input type="checkbox" id="evwarn"${state.ev.warningsOnly ? ' checked' : ''}> Warnings only</label>
    <select id="evreason"><option value="">All reasons</option>${reasons.map((r) => `<option${r === state.ev.reason ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select>
    <span class="muted">${plural(rows.length, 'event')} · Kubernetes keeps events ~1 hour</span>
  </div>`;
  if (!rows.length) return `${toolbar}<div class="notice"><div class="empty">No events match.</div></div>`;
  return `${toolbar}<div class="table-wrap"><table>
    <thead><tr><th>Type</th><th>Reason</th><th>Object</th><th>Message</th><th>Count</th><th class="nowrap">Last seen</th></tr></thead>
    <tbody>${rows.slice(0, 1500).map((e) => {
      const f = findingFor(e.object);
      return `<tr class="${e.type === 'Warning' ? 'ev-warning' : ''}${f ? ' clickable' : ''}"${f ? ` data-open="${esc(f.id)}"` : ''}>
      <td class="nowrap">${esc(e.type)}</td><td class="nowrap"><b>${esc(e.reason)}</b></td>
      <td>${objLabel(e.object)}${e.container ? `<div class="sub">container ${esc(e.container)}</div>` : ''}</td>
      <td class="msg">${esc(e.message)}</td><td class="nowrap">${e.count}</td><td class="nowrap muted">${esc(ago(e.last))}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function findingFor(o) {
  for (const f of state.report.findings) {
    if (f.object.kind === o.kind && f.object.namespace === o.namespace && f.object.name === o.name) return f;
    if (o.kind === 'Pod' && (f.instances || []).some((i) => i.pod === o.name && i.namespace === o.namespace)) return f;
  }
  return null;
}

// ----------------------------------------------------------------- nodes
function bar(label, req, use, total, fmt) {
  const rp = total ? (req / total) * 100 : 0;
  const up = total && use != null ? (use / total) * 100 : null;
  const cls = Math.max(rp, up || 0) >= 95 ? 'hot' : (up || 0) >= 80 ? 'warm' : '';
  return `<div class="bar-row"><span class="muted">${label}</span><div class="bar ${cls}"><span class="req" data-w="${rp.toFixed(1)}"></span>${up != null ? `<span class="use" data-w="${up.toFixed(1)}"></span>` : ''}</div><span class="num" title="requested ${esc(fmt(req))} of ${esc(fmt(total))} allocatable${up != null ? `, using ${esc(fmt(use))}` : ''}">req ${Math.round(rp)}%${up != null ? ` · used ${Math.round(up)}%` : ''}</span></div>`;
}

function renderNodes() {
  const nodes = state.report.nodes;
  if (!nodes.length) return '<div class="notice"><div class="empty">No nodes visible (listing nodes may be forbidden — see Scan coverage).</div></div>';
  const partial = nodes[0]?.alloc?.partial;
  return `<div class="legend">Bars: <i class="lg-req"></i>requested by pods <i class="lg-use"></i>actual usage${partial ? ' · requests are partial (not all namespaces readable)' : ''}</div>
  <div class="nodes">${nodes.map((n) => {
    const bad = n.ready !== 'Ready' || n.problems.some((p) => p.type !== 'Ready');
    const f = state.report.findings.find((x) => x.object.kind === 'Node' && x.object.name === n.name && x.severity !== 'info');
    return `<div class="node-card${bad ? ' bad' : ''}">
      <div class="nh"><span class="nn">${esc(n.name)}</span>${sevPill(n.ready === 'Ready' ? 'ok' : 'critical').replace(/>(ok|critical)</, `>${esc(n.ready)}<`)}${n.cordoned ? '<span class="tag">cordoned</span>' : ''}${n.roles.map((r) => `<span class="tag">${esc(r)}</span>`).join('')}${f ? `<a data-open="${esc(f.id)}">details</a>` : ''}</div>
      <div class="meta">${esc(n.version || '')} · ${esc(n.arch || '')}${n.instanceType ? ` · ${esc(n.instanceType)}` : ''}${n.zone ? ` · ${esc(n.zone)}` : ''} · ${esc(n.runtime || '')} · age ${esc(dur(Date.now() - toMs(n.created)))}</div>
      ${bar('CPU', n.alloc.reqCpu, n.usage?.cpu, n.alloc.cpu, cpu)}
      ${bar('Memory', n.alloc.reqMemory, n.usage?.memory, n.alloc.memory, bytes)}
      <div class="bar-row"><span class="muted">Pods</span><div class="bar ${n.alloc.pods >= n.alloc.maxPods ? 'hot' : ''}"><span class="req" data-w="${n.alloc.maxPods ? (n.alloc.pods / n.alloc.maxPods) * 100 : 0}"></span></div><span class="num">${n.alloc.pods} / ${n.alloc.maxPods ?? '?'}</span></div>
      ${n.problems.length ? `<ul class="plain">${n.problems.map((p) => `<li><b class="warnline">${esc(p.type)}</b> ${esc(p.reason || '')} <span class="muted">${esc(p.message || '')}</span></li>`).join('')}</ul>` : ''}
      ${n.taints.length ? `<div class="sub muted">Taints: <span class="mono">${n.taints.map(esc).join(', ')}</span></div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

// -------------------------------------------------------------- coverage
function renderCoverage() {
  const r = state.report;
  const m = r.meta;
  const statusPill = (s) => sevPill(s === 'ok' ? 'ok' : s === 'partial' || s === 'unsupported' ? 'warning' : 'critical').replace(/>(ok|warning|critical)</, `>${esc(s)}<`);
  return `<div class="two">
    <div class="card"><h4>How Kube Doctor reads your cluster</h4>
      <ul class="clean">
        <li>Only <b>read</b> kubectl commands are issued (<code>get</code>, <code>logs</code>, <code>top</code>, <code>version</code>, <code>config view</code>). An allowlist in the server refuses anything else.</li>
        <li>Your kubeconfig is never modified; picking a context only adds <code>--context</code> to the commands.</li>
        <li>Secrets and ConfigMaps are never read. Missing references are detected from Kubernetes error messages.</li>
        <li>Everything stays on this machine: the web server listens on ${esc(location.host)} only.</li>
      </ul>
    </div>
    <div class="card"><h4>Scan</h4><dl class="kv">
      <dt>Context</dt><dd>${esc(m.context)}</dd><dt>User</dt><dd>${esc(m.user || '?')}</dd><dt>API server</dt><dd class="mono">${esc(m.server || '?')}</dd>
      <dt>Version</dt><dd>${esc(m.version || '?')}</dd><dt>Duration</dt><dd>${(m.durationMs / 1000).toFixed(1)}s</dd>
      <dt>Metrics</dt><dd>${m.metricsAvailable ? 'available (kubectl top)' : esc(m.metricsError || 'unavailable')}</dd>
      <dt>API health</dt><dd>${m.health?.checks?.length ? `${m.health.checks.filter((c) => c.ok).length}/${m.health.checks.length} readyz checks OK` : esc(m.health?.error?.message || 'not readable')}</dd>
    </dl></div>
  </div>
  <div class="table-wrap mt"><table><thead><tr><th>Resource</th><th>Status</th><th>Items</th><th>Scope</th><th>Note</th></tr></thead>
  <tbody>${r.coverage.map((c) => `<tr><td class="mono">${esc(c.resource)}</td><td>${statusPill(c.status)}</td><td>${c.count}</td><td class="mono">${esc(c.scope || '')}</td><td class="msg muted">${esc(c.message || '')}</td></tr>`).join('')}</tbody></table></div>
  ${r.internalErrors?.length ? `<div class="card"><h4>Analyzer errors</h4><pre class="block">${esc(r.internalErrors.map((e) => `${e.where}: ${e.message}`).join('\n\n'))}</pre></div>` : ''}`;
}

// ---------------------------------------------------------------- drawer
function openFinding(id) {
  if (!state.byId.has(id)) return;
  state.selected = id;
  renderDrawer();
  const d = $('#drawer');
  d.classList.add('open');
  d.setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  d.scrollTop = 0;
  d.focus();
}

function closeDrawer() {
  state.selected = null;
  const d = $('#drawer');
  d.classList.remove('open');
  d.setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
}

function linkRow(id) {
  const f = state.byId.get(id);
  if (!f) return '';
  return `<div class="link-row" data-open="${esc(id)}">${dot(f.severity)}${catChip(f.category)}${objLabel(f.object)} <span class="muted">${esc(shortTitle(f))}</span></div>`;
}

function cmdBlock(c) {
  return `<div class="cmd"><code>${esc(c)}</code><button class="btn small" type="button" data-copy="${esc(c)}">Copy</button></div>`;
}

function renderDrawer() {
  const f = state.byId.get(state.selected);
  const d = $('#drawer');
  if (!f) { d.innerHTML = ''; return; }
  const rc = f.rootCause || {};
  const effects = state.effects.get(f.id) || [];
  const objEvents = state.report.events.rows.filter((e) => (e.object.kind === f.object.kind && e.object.namespace === f.object.namespace && e.object.name === f.object.name) || (e.object.kind === 'Pod' && (f.instances || []).some((i) => i.pod === e.object.name && i.namespace === e.object.namespace))).slice(0, 40);
  const podTarget = f.deep ? (state.deepPod[f.id] || (f.object.kind === 'Pod' ? f.object.name : null)) : null;
  const li = f.logInsight;

  d.innerHTML = `
  <div class="d-head">
    <div class="row">${sevPill(f.severity)}${catChip(f.category)}${(f.tags || []).filter((t) => t !== f.category).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}<span class="close">${podTarget ? '<button type="button" class="btn small primary" data-action="deepnow">Deep analysis ↓</button> ' : ''}<button type="button" class="btn small" data-action="close">Close ✕</button></span></div>
    <h2>${esc(f.title)}</h2>
    <div class="row">${objLabel(f.object)}${f.owner ? `<span class="muted">· owned by ${esc(f.owner.kind)} ${esc(f.owner.name)}</span>` : ''}${f.node ? `<span class="muted">· node ${esc(f.node)}</span>` : ''}${f.lastSeen || f.since ? `<span class="faint">· ${esc(ago(f.lastSeen || f.since))}</span>` : ''}</div>
  </div>
  <div class="d-body">
    <div class="card rootcause ${esc(f.severity)}">
      <h4>${f.causedBy.length ? 'Diagnosis' : 'Root cause'} ${confPill(rc.confidence)}${rc.fromLogs ? '<span class="tag">from container logs</span>' : ''}</h4>
      <p class="summary">${esc(rc.summary)}</p>
      ${rc.inherited ? `<div class="inherit">This is a <b>symptom</b>. Root cause → <a data-open="${esc(rc.inherited.id)}">${esc(rc.inherited.title)}</a><div>${esc(rc.inherited.summary)}</div></div>` : ''}
      ${rc.details?.length ? `<ul class="clean">${rc.details.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    </div>

    ${f.causedBy.length || effects.length ? `<div class="two">
      <div class="card"><h4>Caused by</h4>${f.causedBy.length ? `<div class="links">${f.causedBy.map(linkRow).join('')}</div>` : '<span class="muted">Nothing upstream — this is a root cause.</span>'}</div>
      <div class="card"><h4>Impacts</h4>${effects.length ? `<div class="links">${effects.map(linkRow).join('')}</div>` : '<span class="muted">No dependent problem detected.</span>'}</div>
    </div>` : ''}

    ${li && !li.error ? `<div class="card"><h4>Log analysis <span class="right muted">${esc(li.source)} container instance</span></h4>
      ${li.matches?.length ? li.matches.map((m) => `<div class="hyp"><div class="hh"><span class="ht">${esc(m.title)}</span><span class="tag">${m.count}×</span></div><p>${esc(m.explain)}</p>${m.line ? `<pre class="block">${esc(m.line)}</pre>` : ''}</div>`).join('') : `<p class="muted">${li.empty ? 'The container produced no output before stopping.' : 'No known failure signature in the last 200 lines.'}</p>`}
      ${li.lastException ? `<p><b>Last exception:</b> <code>${esc(li.lastException)}</code></p>` : ''}
      ${li.dependencies?.length ? `<p><b>Dependencies seen in logs</b></p><ul class="plain">${li.dependencies.map((x) => `<li><code>${esc(x.host)}${x.port ? `:${x.port}` : ''}</code> ${x.resolved ? (x.resolved.kind === 'Localhost' ? `<span class="muted">${esc(x.resolved.note)}</span>` : x.resolved.missing ? '<span class="sev critical">no such Service</span>' : `→ ${objLabel(x.resolved)} <span class="faint">(${esc(x.resolved.how)})</span>`) : '<span class="faint">external / unresolved</span>'} <span class="faint">${x.count}×</span></li>`).join('')}</ul>` : ''}
      ${li.errorLines?.length ? `<details><summary>Error lines (${li.errorLines.length})</summary><pre class="block">${esc(li.errorLines.join('\n'))}</pre></details>` : ''}
    </div>` : li?.error ? `<div class="card"><h4>Log analysis</h4><p class="muted">Logs unavailable: ${esc(li.error)}</p></div>` : ''}

    <div class="two">
      <div class="card"><h4>Evidence</h4>${f.evidence.length ? `<ul class="plain">${f.evidence.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : '<span class="muted">—</span>'}</div>
      <div class="card"><h4>How to fix</h4>${f.fixes.length ? `<ul class="clean">${f.fixes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<span class="muted">Fix the root cause linked above.</span>'}
        <p class="faint">Kube Doctor never changes your cluster — apply fixes through your usual deployment process.</p></div>
    </div>

    ${f.commands.length ? `<div class="card"><h4>Investigate (read-only commands)</h4>${f.commands.map(cmdBlock).join('')}</div>` : ''}

    ${f.instances.length > 1 ? `<div class="card"><h4>Affected pods (${f.instances.length})</h4><div class="table-wrap"><table><thead><tr><th>Pod</th><th>Node</th><th>Restarts</th><th>Age</th><th></th></tr></thead><tbody>
      ${f.instances.map((i) => `<tr><td class="mono">${esc(i.namespace)}/${esc(i.pod)}</td><td>${esc(i.node || '—')}</td><td>${i.restarts ?? ''}</td><td>${esc(dur(i.age))}</td><td>${f.deep ? `<button type="button" class="btn small" data-deep="${esc(i.namespace)}/${esc(i.pod)}" data-for="${esc(f.id)}">Deep analysis</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div></div>` : ''}

    <div id="deep-anchor"></div>
    ${podTarget ? renderDeep(f, podTarget) : ''}

    <div class="card"><h4>Events for this object <span class="right muted">${objEvents.length}</span></h4>${objEvents.length ? `<ul class="plain">${objEvents.map((e) => `<li><b class="${e.type === 'Warning' ? 'warnline' : ''}">${esc(e.reason)}</b> <span class="faint">${esc(ago(e.last))} · ${e.count}×${f.instances.length > 1 ? ` · ${esc(e.object.name)}` : ''}${e.container ? ` · ${esc(e.container)}` : ''}</span><div>${esc(e.message)}</div></li>`).join('')}</ul>` : '<span class="muted">No events (Kubernetes only keeps them for about an hour).</span>'}</div>

    ${f.object.kind !== 'Registry' && f.category !== 'SharedCause' ? `<div class="card"><h4>Raw object</h4>${renderRaw(f.object)}</div>` : ''}
  </div>`;
  applyWidths(d);
  const lb = $('.logs-box', d);
  if (lb) lb.scrollTop = lb.scrollHeight;
}

function rawKey(o) { return `${o.kind}/${o.namespace}/${o.name}`; }
function renderRaw(o) {
  const r = state.raw[rawKey(o)];
  if (!r) return `<button type="button" class="btn small" data-raw="${esc(rawKey(o))}">Show ${esc(o.kind)} JSON</button> <span class="faint">(from the last scan, managedFields and secret-looking env values hidden)</span>`;
  if (r.loading) return '<span class="spinner"></span>';
  if (r.error) return `<span class="muted">${esc(r.error)}</span>`;
  return `<pre class="block">${esc(JSON.stringify(r.data, null, 2))}</pre>`;
}

async function loadRaw(key) {
  const [kind, namespace, ...rest] = key.split('/');
  state.raw[key] = { loading: true };
  renderDrawer();
  try {
    state.raw[key] = { data: await api('/api/object', { context: state.context, kind, namespace, name: rest.join('/') }) };
  } catch (e) {
    state.raw[key] = { error: e.message };
  }
  renderDrawer();
}

// ---------------------------------------------------------- deep analysis
async function runDeep(ns, pod, fid) {
  const key = `${ns}/${pod}`;
  if (fid) state.deepPod[fid] = pod;
  state.deep[key] = { loading: true };
  renderDrawer();
  try {
    state.deep[key] = { data: await api('/api/pod', { context: state.context, namespace: ns, name: pod }) };
  } catch (e) {
    state.deep[key] = { error: e };
  }
  if (state.selected) renderDrawer();
}

function renderDeep(f, podName) {
  const ns = f.object.kind === 'Pod' ? f.object.namespace : (f.instances.find((i) => i.pod === podName) || {}).namespace || f.object.namespace;
  const key = `${ns}/${podName}`;
  const st = state.deep[key];
  if (!st) {
    return `<div class="card"><h4>Deep analysis</h4><p>Fetches fresh state, all events, the logs of every container (current and previous instance), metrics and the node of <code>${esc(key)}</code>, then ranks root-cause hypotheses.</p>
      <button type="button" class="btn primary" data-deep="${esc(key)}" data-for="${esc(f.id)}">Run deep analysis</button></div>`;
  }
  if (st.loading) return `<div class="card"><h4>Deep analysis</h4><span class="spinner"></span> Analyzing ${esc(key)}…</div>`;
  if (st.error) return `<div class="card"><h4>Deep analysis</h4><p class="warnline">${esc(st.error.message)}</p>${st.error.hint ? `<p class="muted">${esc(st.error.hint)}</p>` : ''}<button type="button" class="btn small" data-deep="${esc(key)}" data-for="${esc(f.id)}">Retry</button></div>`;
  const a = st.data;
  const p = a.pod;
  const hyps = a.hypotheses.map((h) => `<div class="hyp"><div class="hh">${sevPill(h.severity)}<span class="ht">${esc(h.title)}</span>${h.container ? `<span class="tag">${esc(h.container)}</span>` : ''}${h.fromLogs ? '<span class="tag">logs</span>' : ''}<div class="meter" title="${h.confidence}% confidence"><span data-w="${h.confidence}"></span></div><span class="faint">${h.confidence}%</span></div>
      <p>${esc(h.summary)}</p>
      ${h.details?.length ? `<ul class="clean">${h.details.slice(0, 6).map((x) => `<li class="muted">${esc(x)}</li>`).join('')}</ul>` : ''}
      ${h.link ? `<p>${(() => { const lf = findingFor(h.link); return lf ? `<a data-open="${esc(lf.id)}">Open ${esc(h.link.kind)} ${esc(h.link.name)} →</a>` : ''; })()}</p>` : ''}
      ${h.fixes?.length ? `<details><summary>How to fix</summary><ul class="clean">${h.fixes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
    </div>`).join('');

  const containers = a.containers.map((c) => {
    const memLim = parseQty(c.resources?.limits?.memory);
    const cpuLim = parseQty(c.resources?.limits?.cpu);
    const state1 = c.state ? `${c.state.state}${c.state.reason ? ` (${c.state.reason})` : ''}${c.state.exitCode != null ? ` exit ${c.state.exitCode}` : ''}` : 'no status';
    const last = c.lastState ? `${c.lastState.reason || c.lastState.state} exit ${c.lastState.exitCode ?? '?'} at ${clock(c.lastState.finished)}` : '—';
    return `<div class="ctr"><div class="ch"><span class="cn">${esc(c.name)}</span>${c.init ? `<span class="tag">${c.sidecar ? 'sidecar' : 'init'}</span>` : ''}${sevPill(c.ready ? 'ok' : c.state?.state === 'terminated' && c.state.exitCode === 0 ? 'info' : 'critical').replace(/>(ok|info|critical)</, `>${c.ready ? 'ready' : 'not ready'}<`)}<span class="muted">${esc(state1)} · ${c.restarts} restarts</span></div>
      <dl class="kv"><dt>Image</dt><dd class="mono">${esc(c.image)}</dd><dt>Last termination</dt><dd>${esc(last)}</dd>
      ${c.command || c.args ? `<dt>Command</dt><dd class="mono">${esc([...(c.command || []), ...(c.args || [])].join(' '))}</dd>` : ''}
      <dt>Requests</dt><dd>cpu ${esc(c.resources?.requests?.cpu || '—')} · memory ${esc(c.resources?.requests?.memory || '—')}</dd>
      <dt>Limits</dt><dd>cpu ${esc(c.resources?.limits?.cpu || '—')} · memory ${esc(c.resources?.limits?.memory || '—')}</dd>
      ${c.usage ? `<dt>Usage now</dt><dd>cpu ${cpu(c.usage.cpu)}${cpuLim ? ` (${Math.round((c.usage.cpu / cpuLim) * 100)}% of limit)` : ''} · memory ${bytes(c.usage.memory)}${memLim ? ` (${Math.round((c.usage.memory / memLim) * 100)}% of limit)` : ''}</dd>` : ''}
      ${c.probes.liveness ? `<dt>Liveness</dt><dd class="mono">${esc(c.probes.liveness)}</dd>` : ''}
      ${c.probes.readiness ? `<dt>Readiness</dt><dd class="mono">${esc(c.probes.readiness)}</dd>` : ''}
      ${c.probes.startup ? `<dt>Startup</dt><dd class="mono">${esc(c.probes.startup)}</dd>` : ''}
      ${c.ports.length ? `<dt>Ports</dt><dd class="mono">${esc(c.ports.join(', '))}</dd>` : ''}
      ${c.env.length || c.envFrom.length ? `<dt>Environment</dt><dd class="mono">${[...c.env.map((e) => `${e.name}=${e.value ?? `<${e.from}>`}`), ...c.envFrom.map((x) => `(all keys of ${x})`)].map(esc).join('<br>')}</dd>` : ''}
      ${c.mounts.length ? `<dt>Mounts</dt><dd class="mono">${c.mounts.map(esc).join('<br>')}</dd>` : ''}
      </dl></div>`;
  }).join('');

  const timeline = a.timeline.map((t) => `<li><span class="t">${esc(clock(t.time))}</span><span class="d ${esc(t.severity)}"></span><span>${esc(t.text)}</span></li>`).join('');

  const deps = a.dependencies.length ? `<div class="card"><h4>Dependencies found in logs</h4><div class="table-wrap"><table><thead><tr><th>Target</th><th>Resolves to</th><th>Health</th><th>Seen</th></tr></thead><tbody>${a.dependencies.map((x) => `<tr><td class="mono">${esc(x.host)}${x.port ? `:${x.port}` : ''}</td><td>${x.resolved ? (x.resolved.kind === 'Localhost' ? 'this pod (localhost)' : x.resolved.missing ? '<span class="sev critical">missing Service</span>' : objLabel(x.resolved)) : '<span class="faint">external</span>'}</td><td>${x.health ? `${x.health.ready}/${x.health.pods} pods ready` : '—'}</td><td>${x.count}× in ${esc(x.container)} (${esc(x.source)})</td></tr>`).join('')}</tbody></table></div></div>` : '';

  return `<div class="card"><h4>Deep analysis — ${esc(key)} <span class="right"><span class="faint">${esc(clock(a.analyzedAt))}</span> <button type="button" class="btn small" data-deep="${esc(key)}" data-for="${esc(f.id)}">Re-run</button></span></h4>
      <p class="muted">Hypotheses ranked by confidence:</p>${hyps}</div>
    <div class="two">
      <div class="card"><h4>Pod</h4><dl class="kv">
        <dt>Phase</dt><dd>${esc(p.phase)}${p.reason ? ` (${esc(p.reason)})` : ''}</dd>
        <dt>Node</dt><dd>${esc(p.node || 'not scheduled')}</dd><dt>Pod IP</dt><dd>${esc(p.podIP || '—')}</dd>
        <dt>QoS</dt><dd>${esc(p.qos || '?')}</dd><dt>Owner</dt><dd>${esc(p.owners.join(' → ') || '—')}</dd>
        <dt>ServiceAccount</dt><dd>${esc(p.serviceAccount)}</dd><dt>Created</dt><dd>${esc(ago(p.created))}</dd>
        <dt>Requests</dt><dd>cpu ${cpu(p.requests.cpu)} · memory ${bytes(p.requests.memory)}</dd>
        <dt>Services</dt><dd>${a.services.length ? a.services.map((s) => `${esc(s.name)} (${s.ready ?? '?'}/${s.pods ?? '?'} ready)`).join(', ') : 'none select this pod'}</dd>
        ${p.volumes.length ? `<dt>Volumes</dt><dd>${p.volumes.map((v) => `${esc(v.name)}: ${esc(v.type)}${v.source ? ` ${esc(v.source)}` : ''}`).join('<br>')}</dd>` : ''}
        <dt>Conditions</dt><dd>${p.conditions.map((c) => `${esc(c.type)}=${esc(c.status)}${c.reason ? ` (${esc(c.reason)})` : ''}`).join(', ')}</dd>
      </dl>
      ${a.node ? `<p><b>Node ${esc(a.node.name)}</b>: ${a.node.conditions.filter((c) => (c.type === 'Ready' ? c.status !== 'True' : c.status === 'True')).map((c) => `<span class="sev critical">${esc(c.type)}</span>`).join(' ') || '<span class="sev ok">healthy</span>'} <span class="faint">${esc(a.node.arch || '')} · ${esc(a.node.kubelet || '')}</span></p>` : ''}
      </div>
      <div class="card"><h4>Timeline</h4><ul class="timeline">${timeline}</ul></div>
    </div>
    <div class="card"><h4>Containers</h4>${containers}${a.metricsAvailable ? '' : '<p class="faint">Live usage unavailable (metrics-server not reachable).</p>'}</div>
    ${deps}
    <div class="card"><h4>Logs</h4>${renderLogs(a, key)}</div>
    <div class="card"><h4>Commands</h4>${a.commands.map(cmdBlock).join('')}</div>`;
}

function parseQty(q) {
  if (q == null) return null;
  const m = String(q).match(/^([\d.]+)([a-zA-Z]*)$/);
  if (!m) return null;
  const mult = { '': 1, m: 1e-3, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, k: 1e3, M: 1e6, G: 1e9 }[m[2]];
  return mult == null ? null : parseFloat(m[1]) * mult;
}

function renderLogs(a, key) {
  const options = [];
  for (const [c, l] of Object.entries(a.logs)) {
    if (l.previous) options.push([c, 'previous', l.previous]);
    if (l.current) options.push([c, 'current', l.current]);
  }
  if (!options.length) return '<p class="muted">No logs available (containers never started).</p>';
  let sel = state.logView[key];
  if (!sel || !options.some(([c, s]) => `${c}|${s}` === sel)) {
    const withHits = options.find(([, , l]) => l.analysis?.matches?.length);
    sel = withHits ? `${withHits[0]}|${withHits[1]}` : `${options[0][0]}|${options[0][1]}`;
  }
  const [cname, src] = sel.split('|');
  const entry = options.find(([c, s]) => c === cname && s === src)[2];
  const tabs = options.map(([c, s, l]) => `<button type="button" class="${`${c}|${s}` === sel ? 'on' : ''}" data-logview="${esc(key)}" data-sel="${esc(`${c}|${s}`)}">${esc(c)} · ${s}${l.analysis?.matches?.length ? ' ⚠' : ''}</button>`).join('');
  if (entry.error) return `<div class="subtabs">${tabs}</div><p class="muted">${esc(entry.error)}</p>`;
  const hits = new Set((entry.analysis?.matches || []).map((m) => m.lineNo));
  const errs = new Set((entry.analysis?.errorLines || []).map((m) => m.lineNo));
  const lines = entry.text.replace(/\n$/, '').split('\n');
  const body = lines.map((l, i) => {
    const m = l.match(/^(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d))\s(.*)$/);
    const cls = hits.has(i) ? ' hit' : errs.has(i) ? ' err' : '';
    return `<div class="ln${cls}"><span class="no">${i + 1}</span><span>${m ? `<span class="ts">${esc(clock(m[1]))}</span> ${esc(m[2])}` : esc(l)}</span></div>`;
  }).join('');
  const summary = entry.analysis?.matches?.length ? `<p>${entry.analysis.matches.slice(0, 3).map((m) => `<span class="tag">${esc(m.title)}</span>`).join(' ')} <span class="faint">highlighted in red; other error-looking lines in amber</span></p>` : '';
  return `<div class="subtabs">${tabs}</div>${summary}<div class="logs-box">${body || '<div class="ln"><span class="no"></span><span class="faint">(empty)</span></div>'}</div>`;
}

// ------------------------------------------------------------------ events
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-open],[data-tab],[data-cat],[data-sev],[data-sevonly],[data-copy],[data-deep],[data-raw],[data-expand],[data-logview],[data-action]');
  if (!t) return;
  if (t.dataset.copy != null) {
    const text = t.dataset.copy;
    (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => toast('Copied'), () => toast('Copy failed — select the text manually'));
    return;
  }
  if (t.dataset.action === 'close') return closeDrawer();
  if (t.dataset.action === 'scan') return scan();
  if (t.dataset.action === 'chips') {
    state.allChips = !state.allChips;
    return render();
  }
  if (t.dataset.action === 'deepnow') {
    const f = state.byId.get(state.selected);
    const pod = state.deepPod[f.id] || f.object.name;
    const ns = (f.instances.find((i) => i.pod === pod) || f.object).namespace;
    runDeep(ns, pod, f.id).then(() => $('#deep-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return $('#deep-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  if (t.dataset.open != null) return openFinding(t.dataset.open);
  if (t.dataset.deep) {
    const [ns, pod] = t.dataset.deep.split('/');
    return runDeep(ns, pod, t.dataset.for);
  }
  if (t.dataset.raw) return loadRaw(t.dataset.raw);
  if (t.dataset.logview) {
    state.logView[t.dataset.logview] = t.dataset.sel;
    return renderDrawer();
  }
  if (t.dataset.expand) {
    state.expanded.add(t.dataset.expand);
    return render();
  }
  if (t.dataset.tab) return switchTab(t.dataset.tab);
  if (t.dataset.cat != null) {
    state.cat = state.cat === t.dataset.cat ? '' : t.dataset.cat;
    if (state.cat) state.sev = { critical: true, warning: true, info: true };
    return switchTab('findings');
  }
  if (t.dataset.sevonly) {
    state.sev = { critical: false, warning: false, info: false, [t.dataset.sevonly]: true };
    state.cat = '';
    return switchTab('findings');
  }
  if (t.dataset.sev) {
    state.sev[t.dataset.sev] = !state.sev[t.dataset.sev];
    store.set('sev', state.sev);
    return render();
  }
});

document.addEventListener('input', (ev) => {
  const id = ev.target.id;
  if (id === 'q') {
    state.q = ev.target.value;
    rerenderKeepingFocus('q');
  } else if (id === 'evq') {
    state.ev.q = ev.target.value;
    rerenderKeepingFocus('evq');
  }
});

document.addEventListener('change', (ev) => {
  const id = ev.target.id;
  if (id === 'cat') { state.cat = ev.target.value; render(); }
  if (id === 'evwarn') { state.ev.warningsOnly = ev.target.checked; render(); }
  if (id === 'evreason') { state.ev.reason = ev.target.value; render(); }
});

function rerenderKeepingFocus(id) {
  const el = $(`#${id}`);
  const pos = el?.selectionStart;
  render();
  const n = $(`#${id}`);
  if (n) {
    n.focus();
    if (pos != null) n.setSelectionRange(pos, pos);
  }
}

function switchTab(tab) {
  state.tab = tab;
  store.set('tab', tab);
  history.replaceState(null, '', `#${tab}`);
  render();
}

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.selected) closeDrawer();
  if (ev.key === '/' && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) {
    const q = $('#q') || $('#evq');
    if (q) { ev.preventDefault(); q.focus(); }
  }
});

function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

async function init() {
  applyTheme(store.get('theme', null));
  $('#theme').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    store.set('theme', next);
  });
  $('#scrim').addEventListener('click', closeDrawer);
  $('#scan').addEventListener('click', () => scan());
  $('#ctx').addEventListener('change', (e) => {
    state.context = e.target.value;
    state.report = null;
    state.deep = {};
    closeDrawer();
    render();
    scan();
  });
  $('#ns').addEventListener('change', (e) => {
    state.ns = e.target.value;
    store.set('ns', state.ns);
    render();
  });
  $('#auto').value = String(store.get('auto', 0));
  $('#auto').addEventListener('change', (e) => {
    store.set('auto', Number(e.target.value));
    setAuto(Number(e.target.value));
  });
  $('#logs').checked = store.get('logs', true);
  $('#logs').addEventListener('change', (e) => store.set('logs', e.target.checked));
  setAuto(store.get('auto', 0));

  state.loading = true;
  updateBusy();
  render();
  state.loading = false;
  await loadContexts();
  if (state.error && !state.contexts.length) {
    updateBusy();
    render();
    return;
  }
  await scan();
}

init();
