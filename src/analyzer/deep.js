// On-demand deep analysis of one pod: fresh state, events, logs (current and
// previous) of every container, metrics, timeline, and ranked hypotheses.
import { Snapshot, podResources } from './snapshot.js';
import { analyzePod, describeProbe } from './pods.js';
import { analyzeLogs, resolveDependency } from './logs.js';
import { serviceHealth } from './network.js';
import { FindingSet, applyLogInsight } from './index.js';
import { parseTopPods } from '../collector.js';
import { eventTime, eventFirstTime, eventCount, ts, truncate, fmtRef, matchLabels, objKey, SEVERITY_RANK } from './util.js';

const SECRETISH = /pass|secret|token|key|credential|pwd|auth|cert|private/i;
const CONF = { high: 90, medium: 65, low: 35 };

export async function deepAnalyzePod(kubectl, { context, namespace, name, base, cmdContext }) {
  const opts = { context };
  const pod = await kubectl.json(['get', 'pod', name, '-n', namespace], opts);
  pod.kind = 'Pod';
  const nodeName = pod.spec?.nodeName;
  const [evRes, nodeRes, topRes] = await Promise.allSettled([
    kubectl.json(['get', 'events', '-n', namespace, '--field-selector', `involvedObject.name=${name}`], opts),
    nodeName ? kubectl.json(['get', 'node', nodeName], opts) : Promise.resolve(null),
    kubectl.run(['top', 'pod', name, '-n', namespace, '--containers', '--no-headers'], opts),
  ]);

  const containers = [
    ...(pod.spec?.initContainers || []).map((c) => ({ spec: c, init: true })),
    ...(pod.spec?.containers || []).map((c) => ({ spec: c, init: false })),
  ];
  const statuses = new Map([...(pod.status?.initContainerStatuses || []), ...(pod.status?.containerStatuses || [])].map((s) => [s.name, s]));

  // Logs: previous + current instance of every container that has started at least once.
  const logs = {};
  await Promise.all(containers.map(async ({ spec }) => {
    const cs = statuses.get(spec.name);
    const entry = { current: null, previous: null };
    logs[spec.name] = entry;
    const args = ['logs', '-n', namespace, name, '-c', spec.name, '--timestamps', '--tail=500', '--limit-bytes=524288'];
    const tasks = [];
    if (cs?.state?.running || cs?.state?.terminated || cs?.lastState?.terminated) {
      tasks.push(kubectl.run(args, opts).then((t) => { entry.current = { text: t, analysis: analyzeLogs(t) }; }, (e) => { entry.current = { error: e.message, kind: e.kind }; }));
    }
    if ((cs?.restartCount || 0) > 0 || cs?.lastState?.terminated) {
      tasks.push(kubectl.run([...args, '--previous'], opts).then((t) => { entry.previous = { text: t, analysis: analyzeLogs(t) }; }, (e) => { entry.previous = { error: e.message, kind: e.kind }; }));
    }
    await Promise.all(tasks);
  }));

  // Mini snapshot: last full scan (for services, nodes, owners) overlaid with fresh data for this pod.
  const baseData = base?.data || {};
  const isThisPod = (p) => p.metadata?.namespace === namespace && p.metadata?.name === name;
  const freshEvents = evRes.status === 'fulfilled' ? evRes.value.items || [] : (baseData.events || []).filter((e) => e.involvedObject?.namespace === namespace && e.involvedObject?.name === name);
  const data = {
    ...baseData,
    pods: [pod, ...(baseData.pods || []).filter((p) => !isThisPod(p))],
    events: [...freshEvents, ...(baseData.events || []).filter((e) => !(e.involvedObject?.namespace === namespace && e.involvedObject?.name === name && e.involvedObject?.kind === 'Pod'))],
  };
  if (nodeRes.status === 'fulfilled' && nodeRes.value) data.nodes = [nodeRes.value, ...(baseData.nodes || []).filter((n) => n.metadata.name !== nodeName)];
  const podMetrics = topRes.status === 'fulfilled' ? parseTopPods(topRes.value, namespace) : [];
  const snap = new Snapshot({
    ...(base || {}),
    data,
    info: base?.info || {},
    coverage: base?.coverage || [{ key: 'pods', status: 'ok' }, { key: 'events', status: 'ok' }],
    metrics: { nodes: base?.metrics?.nodes, pods: { ok: true, items: [...podMetrics, ...((base?.metrics?.pods?.items || []).filter((m) => !(m.namespace === namespace && m.pod === name)))] } },
  }, { cmdContext });

  const out = new FindingSet();
  analyzePod(pod, snap, out);
  const findings = out.findings.map((f, i) => ({ ...f, id: `deep-${i}` }));

  for (const f of findings) {
    const l = f.container && logs[f.container];
    const src = l?.previous?.analysis && !l.previous.analysis.empty ? 'previous' : 'current';
    const la = l?.[src]?.analysis;
    if (la) applyLogInsight(f, la, src, snap);
  }

  // Dependencies seen in any log, with the health of the Services they map to.
  const health = serviceHealth(snap);
  const dependencies = [];
  for (const [cname, l] of Object.entries(logs)) {
    for (const src of ['previous', 'current']) {
      for (const d of l[src]?.analysis?.dependencies || []) {
        const r = resolveDependency(d, namespace, snap);
        const h = r && r.kind === 'Service' && !r.missing ? health.get(objKey('Service', r.namespace, r.name)) : null;
        dependencies.push({
          container: cname, source: src, host: d.host, port: d.port, count: d.count, sample: d.sample, resolved: r,
          health: h ? { pods: h.pods.length, ready: h.readyPods.length, selector: h.hasSelector } : null,
        });
      }
    }
  }

  const hypotheses = buildHypotheses(findings, dependencies, logs, snap, namespace);

  return {
    pod: podSummary(pod, snap),
    node: nodeSummary(snap.get('Node', '', nodeName)),
    containers: containers.map(({ spec, init }) => containerSummary(pod, spec, init, statuses.get(spec.name), snap)),
    findings,
    hypotheses,
    dependencies,
    services: snap.list('services').filter((s) => s.metadata.namespace === namespace && s.spec?.selector && matchLabels(s.spec.selector, pod.metadata.labels)).map((s) => {
      const h = health.get(objKey('Service', namespace, s.metadata.name));
      return { name: s.metadata.name, type: s.spec.type, ports: (s.spec.ports || []).map((p) => `${p.port}→${p.targetPort}`), ready: h?.readyPods.length ?? null, pods: h?.pods.length ?? null };
    }),
    timeline: buildTimeline(pod, freshEvents, logs),
    events: freshEvents.sort((a, b) => eventTime(b) - eventTime(a)).map((e) => ({ type: e.type, reason: e.reason, message: e.message, count: eventCount(e), first: eventFirstTime(e), last: eventTime(e), container: (e.involvedObject?.fieldPath || '').match(/\{([^}]+)\}/)?.[1] || null })),
    logs: Object.fromEntries(Object.entries(logs).map(([c, l]) => [c, {
      current: l.current && (l.current.error ? { error: l.current.error } : { text: l.current.text, analysis: slimAnalysis(l.current.analysis) }),
      previous: l.previous && (l.previous.error ? { error: l.previous.error } : { text: l.previous.text, analysis: slimAnalysis(l.previous.analysis) }),
    }])),
    metricsAvailable: topRes.status === 'fulfilled',
    commands: [
      snap.cmd(`describe pod -n ${namespace} ${name}`),
      snap.cmd(`get pod -n ${namespace} ${name} -o yaml`),
      ...containers.map(({ spec }) => snap.cmd(`logs -n ${namespace} ${name} -c ${spec.name} --previous --tail=200`)),
    ],
    analyzedAt: new Date().toISOString(),
  };
}

function slimAnalysis(a) {
  return a && { matches: a.matches, errorLines: a.errorLines, lastException: a.lastException, empty: a.empty, lineCount: a.lineCount };
}

function buildHypotheses(findings, dependencies, logs, snap, namespace) {
  const hyps = [];
  for (const f of findings) {
    hyps.push({
      title: f.title,
      summary: f.rootCause.summary,
      details: f.rootCause.details || [],
      confidence: CONF[f.rootCause.confidence] ?? 35,
      severity: f.severity,
      evidence: f.evidence,
      fixes: f.fixes,
      category: f.category,
      tags: f.tags,
      container: f.container || null,
      fromLogs: !!f.rootCause.fromLogs,
    });
  }
  // A dependency that is itself down is the most likely root cause of connection errors.
  const seen = new Set();
  for (const d of dependencies) {
    const r = d.resolved;
    if (!r || r.kind !== 'Service' || seen.has(`${r.namespace}/${r.name}`)) continue;
    seen.add(`${r.namespace}/${r.name}`);
    if (r.missing) {
      hyps.push({ title: `Dependency "${d.host}" does not exist`, summary: `The app tries to reach "${d.host}" but there is no Service "${r.name}" in namespace ${r.namespace}. Fix the hostname in the app configuration (use <service>.<namespace> across namespaces).`, details: [d.sample], confidence: 80, severity: 'critical', evidence: [`Seen ${d.count}x in ${d.container} (${d.source} logs)`], fixes: ['Correct the host in the configuration, or deploy the missing service.'], category: 'Dependency', tags: ['Dependency'] });
    } else if (d.health && d.health.selector && d.health.ready === 0) {
      hyps.push({ title: `Dependency ${r.name} is down`, summary: `The app fails to reach ${d.host}${d.port ? `:${d.port}` : ''}, which is Service ${r.namespace}/${r.name} — and that Service has 0/${d.health.pods} ready pods. The failure of this pod is a CONSEQUENCE of ${r.name} being down: fix ${r.name} first.`, details: [d.sample], confidence: 92, severity: 'critical', evidence: [`Seen ${d.count}x in ${d.container} (${d.source} logs)`], fixes: [`Investigate Service ${r.name} and its pods.`], category: 'Dependency', tags: ['Dependency'], link: { kind: 'Service', namespace: r.namespace, name: r.name } });
    } else if (d.health) {
      const svc = snap.get('Service', r.namespace, r.name);
      const portOk = !d.port || (svc?.spec?.ports || []).some((p) => p.port === d.port);
      if (!portOk) {
        hyps.push({ title: `Wrong port for ${r.name}`, summary: `The app connects to ${d.host}:${d.port} but Service ${r.name} exposes ${(svc.spec.ports || []).map((p) => p.port).join(', ')}.`, details: [d.sample], confidence: 85, severity: 'critical', evidence: [], fixes: ['Fix the port in the app configuration.'], category: 'Dependency', tags: ['Dependency'] });
      } else {
        hyps.push({ title: `Dependency ${r.name} looks healthy`, summary: `${d.host} resolves to Service ${r.namespace}/${r.name} with ${d.health.ready}/${d.health.pods} ready pods. If errors persist, check NetworkPolicies, credentials, or whether the app talks to it too early (no retry at startup).`, details: [d.sample], confidence: 30, severity: 'info', evidence: [], fixes: [], category: 'Dependency', tags: ['Dependency'] });
      }
    }
  }
  if (!findings.length) {
    const anyLogs = Object.values(logs).some((l) => l.current?.analysis?.matches?.length || l.previous?.analysis?.matches?.length);
    hyps.push({ title: 'No failure detected on this pod', summary: anyLogs ? 'The pod is healthy from Kubernetes\' point of view, but its logs contain error signatures (see Logs below).' : 'The pod is healthy from Kubernetes\' point of view.', details: [], confidence: 50, severity: 'info', evidence: [], fixes: [], category: 'Healthy', tags: [] });
  }
  hyps.sort((a, b) => b.confidence - a.confidence || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return hyps;
}

function buildTimeline(pod, events, logs) {
  const items = [];
  const add = (time, kind, text, severity = 'info') => {
    const t = ts(time);
    if (Number.isFinite(t)) items.push({ time: t, kind, text, severity });
  };
  add(pod.metadata.creationTimestamp, 'pod', 'Pod created');
  for (const c of pod.status?.conditions || []) add(c.lastTransitionTime, 'condition', `${c.type} = ${c.status}${c.reason ? ` (${c.reason})` : ''}${c.message ? `: ${truncate(c.message, 160)}` : ''}`, c.status === 'True' ? 'ok' : 'warning');
  for (const cs of [...(pod.status?.initContainerStatuses || []), ...(pod.status?.containerStatuses || [])]) {
    const r = cs.state?.running;
    const t = cs.state?.terminated;
    const l = cs.lastState?.terminated;
    if (l) {
      add(l.startedAt, 'container', `${cs.name}: previous instance started`);
      add(l.finishedAt, 'container', `${cs.name}: previous instance terminated — ${l.reason || '?'} (exit ${l.exitCode})`, l.exitCode === 0 ? 'info' : 'critical');
    }
    if (t) {
      add(t.startedAt, 'container', `${cs.name}: started`);
      add(t.finishedAt, 'container', `${cs.name}: terminated — ${t.reason || '?'} (exit ${t.exitCode})`, t.exitCode === 0 ? 'ok' : 'critical');
    }
    if (r) add(r.startedAt, 'container', `${cs.name}: running (restart #${cs.restartCount})`, 'ok');
  }
  for (const e of events) {
    const n = eventCount(e);
    add(eventTime(e), 'event', `${e.reason}${n > 1 ? ` (${n}x, first ${new Date(eventFirstTime(e)).toISOString().slice(11, 19)})` : ''}: ${truncate(e.message, 240)}`, e.type === 'Warning' ? 'warning' : 'info');
  }
  for (const [cname, l] of Object.entries(logs)) {
    for (const src of ['previous', 'current']) {
      const a = l[src]?.analysis;
      const text = l[src]?.text;
      if (!a?.matches?.length || !text) continue;
      const m = a.matches[0];
      const raw = text.split('\n')[m.lineNo] || '';
      const time = raw.match(/^(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d))/)?.[1];
      if (time) add(time, 'log', `${cname} (${src}) log: ${m.title} — ${truncate(m.line, 200)}`, 'critical');
    }
  }
  return items.sort((a, b) => a.time - b.time).slice(-200);
}

function podSummary(pod, snap) {
  const owners = snap.ownerChain(pod);
  const r = podResources(pod);
  return {
    name: pod.metadata.name,
    namespace: pod.metadata.namespace,
    phase: pod.status?.phase,
    reason: pod.status?.reason || null,
    message: pod.status?.message || null,
    node: pod.spec?.nodeName || null,
    podIP: pod.status?.podIP || null,
    qos: pod.status?.qosClass,
    serviceAccount: pod.spec?.serviceAccountName || 'default',
    restartPolicy: pod.spec?.restartPolicy,
    priorityClass: pod.spec?.priorityClassName || null,
    created: pod.metadata.creationTimestamp,
    deleting: pod.metadata.deletionTimestamp || null,
    owners: owners.map(fmtRef),
    labels: pod.metadata.labels || {},
    conditions: (pod.status?.conditions || []).map((c) => ({ type: c.type, status: c.status, reason: c.reason, message: c.message, since: c.lastTransitionTime })),
    requests: { cpu: r.reqCpu, memory: r.reqMemory },
    limits: { cpu: r.limCpu, memory: r.limMemory },
    volumes: (pod.spec?.volumes || []).map((v) => ({ name: v.name, type: Object.keys(v).find((k) => k !== 'name'), source: v.persistentVolumeClaim?.claimName || v.configMap?.name || v.secret?.secretName || v.hostPath?.path || null })),
  };
}

function nodeSummary(node) {
  if (!node) return null;
  return {
    name: node.metadata.name,
    conditions: (node.status?.conditions || []).map((c) => ({ type: c.type, status: c.status, reason: c.reason, message: c.message })),
    arch: node.status?.nodeInfo?.architecture,
    kubelet: node.status?.nodeInfo?.kubeletVersion,
    allocatable: node.status?.allocatable,
    taints: (node.spec?.taints || []).map((t) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`),
    unschedulable: !!node.spec?.unschedulable,
  };
}

function containerSummary(pod, spec, init, cs, snap) {
  const usage = snap.containerUsage(pod.metadata.namespace, pod.metadata.name, spec.name);
  const stateOf = (s) => {
    if (!s) return null;
    if (s.running) return { state: 'running', since: s.running.startedAt };
    if (s.waiting) return { state: 'waiting', reason: s.waiting.reason, message: s.waiting.message };
    if (s.terminated) return { state: 'terminated', reason: s.terminated.reason, exitCode: s.terminated.exitCode, signal: s.terminated.signal, message: s.terminated.message, started: s.terminated.startedAt, finished: s.terminated.finishedAt };
    return null;
  };
  return {
    name: spec.name,
    init,
    sidecar: init && spec.restartPolicy === 'Always',
    image: spec.image,
    imageID: cs?.imageID || null,
    ready: cs?.ready ?? false,
    started: cs?.started ?? null,
    restarts: cs?.restartCount || 0,
    state: stateOf(cs?.state),
    lastState: stateOf(cs?.lastState),
    command: spec.command || null,
    args: spec.args || null,
    ports: (spec.ports || []).map((p) => `${p.name ? `${p.name}:` : ''}${p.containerPort}/${p.protocol || 'TCP'}`),
    resources: spec.resources || {},
    usage: usage ? { cpu: usage.cpu, memory: usage.memory } : null,
    probes: {
      liveness: describeProbe(spec.livenessProbe)?.text || null,
      readiness: describeProbe(spec.readinessProbe)?.text || null,
      startup: describeProbe(spec.startupProbe)?.text || null,
    },
    env: (spec.env || []).map((e) => ({
      name: e.name,
      value: e.value != null ? (SECRETISH.test(e.name) ? '••••••' : truncate(e.value, 200)) : null,
      from: e.valueFrom ? Object.keys(e.valueFrom)[0] + (e.valueFrom.secretKeyRef ? ` ${e.valueFrom.secretKeyRef.name}/${e.valueFrom.secretKeyRef.key}` : e.valueFrom.configMapKeyRef ? ` ${e.valueFrom.configMapKeyRef.name}/${e.valueFrom.configMapKeyRef.key}` : e.valueFrom.fieldRef ? ` ${e.valueFrom.fieldRef.fieldPath}` : '') : null,
    })),
    envFrom: (spec.envFrom || []).map((e) => (e.secretRef ? `secret ${e.secretRef.name}` : e.configMapRef ? `configmap ${e.configMapRef.name}` : '?')),
    mounts: (spec.volumeMounts || []).map((m) => `${m.name} → ${m.mountPath}${m.subPath ? ` (subPath ${m.subPath})` : ''}${m.readOnly ? ' (ro)' : ''}`),
    securityContext: spec.securityContext || null,
  };
}

