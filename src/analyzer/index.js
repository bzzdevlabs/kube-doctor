// Orchestrates the analyzers, groups duplicates, enriches with logs,
// links symptoms to causes and builds root-cause incidents.
import { Snapshot } from './snapshot.js';
import { analyzePods } from './pods.js';
import { analyzeNodes, nodeSummaries } from './nodes.js';
import { analyzeWorkloads } from './workloads.js';
import { analyzeNetwork } from './network.js';
import { analyzeStorage } from './storage.js';
import { analyzeCluster } from './cluster.js';
import { analyzeUnexplainedEvents, eventRows } from './events.js';
import { analyzeLogs, resolveDependency } from './logs.js';
import { objKey, refKey, fmtRef, uniq, SEVERITY_RANK, maxSeverity, mapLimit, truncate, cond } from './util.js';

const CONF_RANK = { high: 3, medium: 2, low: 1 };

export class FindingSet {
  constructor() {
    this.findings = [];
    this.errors = [];
  }

  add(f) {
    this.findings.push({
      severity: 'warning', tags: [], evidence: [], fixes: [], commands: [], refs: [], causedBy: [], instances: [],
      ...f,
      tags: uniq(f.tags || []),
      rootCause: { details: [], confidence: 'low', ...(f.rootCause || {}) },
    });
  }

  internalError(e, where) {
    this.errors.push({ where, message: String(e?.stack || e).slice(0, 600) });
  }
}

const slug = (s) => s.replace(/[^\w.:/|,-]+/g, '_');

// Same problem on several pods of the same workload -> one finding with N instances.
function groupFindings(findings) {
  const out = [];
  const groups = new Map();
  for (const f of findings) {
    if (!f.groupKey) {
      f.id = slug(`${f.category}:${refKey(f.object)}:${f.tags.slice(0, 2).join(',')}`);
      out.push(f);
      continue;
    }
    const g = groups.get(f.groupKey);
    if (!g) {
      f.id = slug(f.groupKey);
      groups.set(f.groupKey, f);
      out.push(f);
      continue;
    }
    g.instances.push(...f.instances);
    g.refs = uniq([...g.refs, ...f.refs]);
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[g.severity]) g.severity = f.severity;
  }
  for (const f of out) {
    if (f.instances.length > 1) {
      f.instances.sort((a, b) => (b.restarts || 0) - (a.restarts || 0));
      f.evidence = [`Affects ${f.instances.length} pods of ${fmtRef(f.owner)}: ${f.instances.slice(0, 6).map((i) => i.pod).join(', ')}${f.instances.length > 6 ? ', …' : ''}`, ...f.evidence];
    }
  }
  // De-duplicate ids defensively.
  const seen = new Map();
  for (const f of out) {
    const n = seen.get(f.id) || 0;
    seen.set(f.id, n + 1);
    if (n) f.id = `${f.id}#${n}`;
  }
  return out;
}

// Fetches the logs of crashing containers and upgrades their diagnosis.
async function enrichWithLogs(findings, snap, kubectl, context, { limit = 30 } = {}) {
  const targets = findings.filter((f) => f.wantsLogs && f.object.kind === 'Pod' && f.container).slice(0, limit);
  await mapLimit(targets, 6, async (f) => {
    const { namespace, name } = f.object;
    const base = ['logs', '-n', namespace, name, '-c', f.container, '--tail=200', '--limit-bytes=262144'];
    let text = '';
    let source = 'previous';
    try {
      text = await kubectl.run([...base, '--previous'], { context });
    } catch {
      text = '';
    }
    if (!text.trim()) {
      source = 'current';
      try {
        text = await kubectl.run(base, { context });
      } catch (e) {
        f.logInsight = { error: e.message };
        return;
      }
    }
    applyLogInsight(f, analyzeLogs(text), source, snap);
  });
}

export function applyLogInsight(f, la, source, snap) {
  const ns = f.object.namespace;
  const deps = la.dependencies.map((d) => ({ ...d, resolved: resolveDependency(d, ns, snap) }));
  f.logInsight = {
    source, empty: la.empty, lastException: la.lastException,
    matches: la.matches.slice(0, 3).map(({ id, title, explain, line, count }) => ({ id, title, explain, line, count })),
    errorLines: la.errorLines.slice(-8).map((l) => l.text),
    dependencies: deps,
  };
  const top = la.matches[0];
  const own = f.rootCause;
  if (top && CONF_RANK[own.confidence] < 3) {
    f.rootCause = {
      summary: `${top.title} — ${top.explain}`,
      details: [`Log evidence (${source} container): ${truncate(top.line, 300)}`, ...(la.lastException && la.lastException !== top.line ? [`Last exception: ${la.lastException}`] : []), `Container-level diagnosis: ${own.summary}`, ...(own.details || [])],
      confidence: top.weight >= 75 ? 'high' : 'medium',
      fromLogs: true,
    };
    f.fixes = uniq([...(top.fixes || []), ...f.fixes]);
    f.tags = uniq([...f.tags, `Log:${top.title}`]);
  } else if (top) {
    own.details = [...(own.details || []), `Logs show: ${top.title} — ${truncate(top.line, 240)}`];
  } else if (la.empty && CONF_RANK[own.confidence] < 3) {
    own.details = [...(own.details || []), `The ${source} container wrote no logs at all: it dies before logging (wrong command/entrypoint, missing config file, or crash during runtime init).`];
  } else if (la.lastException && CONF_RANK[own.confidence] < 3) {
    own.summary = `${own.summary} Last error in logs: ${truncate(la.lastException, 240)}`;
  }
  for (const d of deps) {
    const r = d.resolved;
    if (!r) continue;
    if (r.kind === 'Localhost') {
      f.rootCause.details.push(`The app connects to ${d.host}${d.port ? `:${d.port}` : ''}. ${r.note}`);
    } else if (r.missing) {
      f.rootCause.details.push(`"${d.host}" is not a Service in namespace ${r.namespace}: the DNS name cannot resolve. Check the hostname/namespace in the app configuration.`);
      if (top?.id === 'dns') f.rootCause.confidence = 'high';
    } else {
      f.refs = uniq([...f.refs, objKey(r.kind, r.namespace, r.name)]);
      f.evidence.push(`Dependency from logs: ${d.host}${d.port ? `:${d.port}` : ''} → ${r.kind} ${r.namespace}/${r.name} (matched by ${r.how})`);
    }
  }
}

// Builds causedBy edges from the refs every analyzer declared.
function correlate(findings, snap) {
  const byKey = new Map();
  const reg = (k, f) => {
    if (!byKey.has(k)) byKey.set(k, []);
    if (!byKey.get(k).includes(f)) byKey.get(k).push(f);
  };
  for (const f of findings) {
    reg(refKey(f.object), f);
    for (const i of f.instances || []) reg(objKey('Pod', i.namespace, i.pod), f);
    for (const a of f.aliases || []) reg(a, f);
  }
  const byId = new Map(findings.map((f) => [f.id, f]));
  const link = (effect, cause) => {
    if (cause === effect || effect.causedBy.includes(cause.id)) return;
    effect.causedBy.push(cause.id);
  };

  const nodeDown = new Map();
  for (const f of findings) if (f.object.kind === 'Node' && ['NodeNotReady', 'NodePressure'].includes(f.category) && f.severity !== 'info') nodeDown.set(f.object.name, f);

  for (const f of findings) {
    for (const r of f.refs || []) {
      for (const c of byKey.get(r) || []) {
        // Node findings only explain pod problems that are node-related.
        if (c.object.kind === 'Node' && f.object.kind === 'Pod' && !['NodeNotReady', 'NodePressure', 'NodeOOM', 'SharedCause'].includes(c.category)) continue;
        if (c.category === 'WarningEvent') continue;
        link(f, c);
      }
    }
    // Every pod problem on a NotReady node is first a node problem.
    if (f.object.kind === 'Pod' && f.node && nodeDown.get(f.node)?.category === 'NodeNotReady' && !['ImagePullBackOff', 'CreateContainerConfigError'].includes(f.category)) {
      link(f, nodeDown.get(f.node));
    }
  }

  // Many pods failing for the same node/registry reason -> synthetic shared root cause.
  const shared = new Map();
  for (const f of findings) {
    if (!f.sharedCause) continue;
    if (!shared.has(f.sharedCause)) shared.set(f.sharedCause, []);
    shared.get(f.sharedCause).push(f);
  }
  for (const [key, members] of shared) {
    const first = members[0];
    const pods = members.reduce((a, m) => a + Math.max(1, m.instances.length), 0);
    if (pods < 2) continue;
    const [kind, scope] = key.split('|');
    const object = kind === 'sandbox' ? { kind: 'Node', namespace: '', name: scope } : { kind: 'Registry', namespace: '', name: scope };
    const sf = {
      id: slug(`shared:${key}`), category: 'SharedCause', severity: maxSeverity(members.map((m) => m.severity)),
      object, tags: first.tags, causedBy: [], refs: [], instances: [], commands: first.commands.slice(0, 1),
      title: kind === 'sandbox' ? `Node ${scope}: no pod can start (${pods} pods affected)` : `Registry ${scope}: image pulls fail for ${pods} pods`,
      rootCause: { ...first.rootCause, details: [...(first.rootCause.details || [])] },
      evidence: [`${pods} pod(s) fail with the same error:`, ...members.slice(0, 10).map((m) => `${m.object.namespace}/${m.object.name}${m.instances.length > 1 ? ` (+${m.instances.length - 1})` : ''}`), ...first.evidence.filter((e) => /:/.test(e)).slice(0, 2)],
      fixes: first.fixes,
    };
    if (kind === 'sandbox') {
      const nodeF = findings.find((x) => x.object.kind === 'Node' && x.object.name === scope && x.category === 'NodeNotReady');
      if (nodeF) sf.causedBy.push(nodeF.id);
    }
    findings.push(sf);
    byId.set(sf.id, sf);
    for (const m of members) link(m, sf);
  }

  breakCycles(findings, byId);

  // Workload/service findings whose own explanation is just "see causes" inherit the cause text.
  for (const f of findings) {
    if (!f.rootCause.derived || !f.causedBy.length) continue;
    const roots = rootsOf(f, byId);
    const best = roots.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || CONF_RANK[b.rootCause.confidence] - CONF_RANK[a.rootCause.confidence])[0];
    if (best) {
      f.rootCause = {
        ...f.rootCause,
        confidence: best.rootCause.confidence,
        inherited: { id: best.id, title: best.title, summary: best.rootCause.summary, object: best.object },
      };
    }
  }
  return byId;
}

function breakCycles(findings, byId) {
  const state = new Map();
  const visit = (f) => {
    state.set(f.id, 1);
    f.causedBy = f.causedBy.filter((cid) => {
      const c = byId.get(cid);
      if (!c) return false;
      const s = state.get(cid);
      if (s === 1) return false; // back edge -> drop
      if (!s) visit(c);
      return true;
    });
    state.set(f.id, 2);
  };
  for (const f of findings) if (!state.get(f.id)) visit(f);
}

function rootsOf(f, byId, seen = new Set()) {
  if (seen.has(f.id)) return [];
  seen.add(f.id);
  if (!f.causedBy.length) return [f];
  return uniq(f.causedBy.flatMap((id) => (byId.get(id) ? rootsOf(byId.get(id), byId, seen) : [])));
}

function buildIncidents(findings, byId) {
  const effects = new Map();
  for (const f of findings) for (const c of f.causedBy) {
    if (!effects.has(c)) effects.set(c, []);
    effects.get(c).push(f.id);
  }
  const incidents = [];
  for (const f of findings) {
    if (f.causedBy.length) continue;
    const impacted = [];
    const stack = [...(effects.get(f.id) || [])];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      impacted.push(id);
      stack.push(...(effects.get(id) || []));
    }
    const sev = maxSeverity([f.severity, ...impacted.map((id) => byId.get(id).severity)]);
    if (sev === 'info') continue;
    f.rootCauseOf = impacted;
    const pods = f.instances.length + impacted.reduce((a, id) => a + (byId.get(id).instances?.length || 0), 0);
    incidents.push({
      id: f.id, rootId: f.id, severity: sev, impacted, pods,
      namespaces: uniq([f.object.namespace, ...impacted.map((id) => byId.get(id).object.namespace)]),
    });
  }
  incidents.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.impacted.length - a.impacted.length || b.pods - a.pods);
  return incidents;
}

const SPECIAL_TAGS = new Set(['OOMKilled', 'LivenessProbe', 'ErrImagePull', 'InvalidImageName', 'MissingSecret', 'MissingConfigMap', 'QuotaExceeded', 'PodSecurity', 'MultiAttach']);

function summarize(snap, findings, incidents) {
  const severity = { critical: 0, warning: 0, info: 0 };
  const categories = new Map();
  const badPods = new Set();
  for (const f of findings) {
    severity[f.severity]++;
    const pods = Math.max(f.instances.length, f.object.kind === 'Pod' ? 1 : 0);
    for (const label of uniq([f.category, ...f.tags.filter((t) => SPECIAL_TAGS.has(t))])) {
      const c = categories.get(label) || { name: label, findings: 0, pods: 0, severity: 'info' };
      c.findings++;
      c.pods += pods;
      c.severity = maxSeverity([c.severity, f.severity]);
      categories.set(label, c);
    }
    if (f.severity !== 'info') for (const i of f.instances) badPods.add(`${i.namespace}/${i.pod}`);
  }
  const pods = snap.list('pods');
  const phase = (p) => pods.filter((x) => x.status?.phase === p).length;
  const nodes = snap.list('nodes');
  return {
    severity,
    categories: [...categories.values()].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.findings - a.findings),
    incidents: incidents.length,
    nodes: {
      total: nodes.length,
      ready: nodes.filter((n) => cond(n, 'Ready')?.status === 'True').length,
      cordoned: nodes.filter((n) => n.spec?.unschedulable).length,
    },
    pods: {
      total: pods.length, running: phase('Running'), pending: phase('Pending'), failed: phase('Failed'), succeeded: phase('Succeeded'),
      withProblems: badPods.size,
    },
    namespaces: snap.list('namespaces').length || uniq(pods.map((p) => p.metadata.namespace)).length,
    namespacesWithProblems: uniq(findings.filter((f) => f.severity !== 'info').map((f) => f.object.namespace)).filter(Boolean),
  };
}

export async function analyze(collected, { kubectl, context, cmdContext = null, logs = true } = {}) {
  const snap = new Snapshot(collected, { cmdContext });
  const out = new FindingSet();
  for (const [name, fn] of [['nodes', analyzeNodes], ['pods', analyzePods], ['workloads', analyzeWorkloads], ['network', analyzeNetwork], ['storage', analyzeStorage], ['cluster', analyzeCluster]]) {
    try {
      fn(snap, out);
    } catch (e) {
      out.internalError(e, name);
    }
  }
  try {
    analyzeUnexplainedEvents(snap, out);
  } catch (e) {
    out.internalError(e, 'events');
  }

  const findings = groupFindings(out.findings);
  if (logs && kubectl) await enrichWithLogs(findings, snap, kubectl, context);
  const byId = correlate(findings, snap);
  const incidents = buildIncidents(findings, byId);

  for (const f of findings) {
    delete f.groupKey;
    delete f.wantsLogs;
    delete f.sharedCause;
    f.rootCause.details = uniq(f.rootCause.details || []);
    f.fixes = uniq(f.fixes);
    f.commands = uniq(f.commands);
    f.causedBy = uniq(f.causedBy);
    f.rootCauseOf ||= [];
  }
  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (b.lastSeen || b.since || 0) - (a.lastSeen || a.since || 0));

  return {
    snapshot: snap,
    report: {
      meta: {
        ...collected.info,
        scannedAt: new Date(collected.startedAt).toISOString(),
        durationMs: Date.now() - collected.startedAt,
        metricsAvailable: !!collected.metrics?.pods?.ok,
        metricsError: collected.metrics?.pods?.ok ? null : collected.metrics?.pods?.error?.message,
        health: collected.health,
      },
      summary: summarize(snap, findings, incidents),
      incidents,
      findings,
      events: eventRows(snap),
      nodes: nodeSummaries(snap),
      namespaces: uniq([...snap.list('namespaces').map((n) => n.metadata.name), ...snap.list('pods').map((p) => p.metadata.namespace)]).sort(),
      coverage: collected.coverage,
      internalErrors: out.errors,
    },
  };
}
