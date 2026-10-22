// Pod and container level diagnosis.
import {
  MIN, HOUR, ageMs, fmtAge, ts, parseQuantity, parseJavaSize, fmtBytes, fmtCpu, pct, truncate, cond,
  eventContainer, eventCount, eventTime, uniq, objKey,
} from './util.js';
import * as K from './knowledge.js';
import { podResources } from './snapshot.js';

const STUCK_MS = 5 * MIN;
const NOT_READY_MS = 3 * MIN;
const RECENT_MS = 6 * HOUR;
const OLD_MS = 24 * HOUR;

export function analyzePods(snap, out) {
  for (const pod of snap.list('pods')) {
    try {
      analyzePod(pod, snap, out);
    } catch (e) {
      out.internalError(e, `Pod ${pod.metadata?.namespace}/${pod.metadata?.name}`);
    }
  }
}

export function analyzePod(pod, snap, out) {
  const ns = pod.metadata.namespace;
  const name = pod.metadata.name;
  const P = {
    pod, ns, name, snap,
    events: snap.eventsFor('Pod', ns, name),
    owner: snap.topOwner(pod),
    node: pod.spec?.nodeName || null,
    age: ageMs(pod.metadata.creationTimestamp),
  };
  const add = (f) => out.add(podFinding(P, f));
  const phase = pod.status?.phase;

  if (pod.metadata.deletionTimestamp) return checkTerminating(P, add);
  if (pod.status?.reason === 'Evicted') return checkEvicted(P, add);
  if (phase === 'Succeeded') return;
  if (phase === 'Unknown') {
    return add({
      category: 'PodUnknown', severity: 'critical',
      title: `Pod state is Unknown`,
      rootCause: { summary: `The node ${P.node || '?'} stopped reporting the pod status (node unreachable, kubelet down or network partition).`, confidence: 'high' },
      evidence: [`Phase: Unknown`, pod.status?.message].filter(Boolean),
      fixes: ['Check the node status in the Nodes tab; once the node is gone the pod will be rescheduled (StatefulSet pods may need a force delete).'],
      refs: P.node ? [objKey('Node', '', P.node)] : [],
    });
  }
  if (phase === 'Failed' && checkFailedPodReason(P, add)) return;
  if (!P.node) return checkUnscheduled(P, add);

  let reported = false;
  const specs = new Map();
  for (const c of pod.spec?.initContainers || []) specs.set(c.name, { spec: c, init: true });
  for (const c of pod.spec?.containers || []) specs.set(c.name, { spec: c, init: false });
  const statuses = [...(pod.status?.initContainerStatuses || []), ...(pod.status?.containerStatuses || [])];

  // Init containers that block startup for a long time.
  for (const cs of pod.status?.initContainerStatuses || []) {
    const sp = specs.get(cs.name)?.spec;
    if (sp?.restartPolicy === 'Always') continue;
    if (cs.state?.running && phase === 'Pending' && ageMs(cs.state.running.startedAt) > 10 * MIN) {
      add({
        category: 'InitStuck', severity: 'warning', container: cs.name,
        title: `Init container "${cs.name}" has been running for ${fmtAge(ageMs(cs.state.running.startedAt))}`,
        rootCause: { summary: `Init container "${cs.name}" never completes, so the app containers never start. Init containers usually loop waiting for a dependency (database, migration, another service).`, confidence: 'medium' },
        evidence: [`Command: ${[...(sp?.command || []), ...(sp?.args || [])].join(' ') || '(image default)'}`],
        fixes: ['Read the init container logs to see what it waits for and check that dependency.'],
        commands: [snap.cmd(`logs -n ${ns} ${name} -c ${cs.name} --tail=100`)],
        wantsLogs: true,
      });
      reported = true;
    }
  }

  for (const cs of statuses) {
    const { spec, init } = specs.get(cs.name) || {};
    reported = analyzeContainer(P, cs, spec, !!init, add) || reported;
  }

  if (!reported && phase === 'Pending') reported = checkStuckCreating(P, add);
}

// ------------------------------------------------------------------ helpers

function podFinding(P, f) {
  const ownerKey = P.owner ? `${P.owner.kind}/${P.owner.namespace}/${P.owner.name}` : `Pod/${P.ns}/${P.name}`;
  const cs = f.container ? findStatus(P.pod, f.container) : null;
  return {
    object: { kind: 'Pod', namespace: P.ns, name: P.name },
    owner: P.owner,
    node: P.node,
    deep: true,
    groupKey: `${f.category}|${ownerKey}|${f.container || ''}|${(f.tags || []).join(',')}`,
    instances: [{
      pod: P.name, namespace: P.ns, node: P.node, restarts: cs?.restartCount ?? totalRestarts(P.pod),
      age: P.age, phase: P.pod.status?.phase, since: f.since || null,
    }],
    commands: defaultCommands(P, f.container),
    ...f,
    lastSeen: f.lastSeen || f.since || null,
  };
}

function defaultCommands(P, container) {
  const c = container ? ` -c ${container}` : '';
  return [
    P.snap.cmd(`describe pod -n ${P.ns} ${P.name}`),
    P.snap.cmd(`logs -n ${P.ns} ${P.name}${c} --previous --tail=100`),
    P.snap.cmd(`get events -n ${P.ns} --field-selector involvedObject.name=${P.name} --sort-by=.lastTimestamp`),
  ];
}

export function registryHost(image = '') {
  const first = image.split('/')[0];
  return image.includes('/') && (/[.:]/.test(first) || first === 'localhost') ? first : 'docker.io';
}

function findStatus(pod, name) {
  return [...(pod.status?.initContainerStatuses || []), ...(pod.status?.containerStatuses || [])].find((c) => c.name === name);
}

function totalRestarts(pod) {
  return (pod.status?.containerStatuses || []).reduce((a, c) => a + (c.restartCount || 0), 0);
}

function containerEvents(P, cname) {
  return P.events.filter((e) => !eventContainer(e) || eventContainer(e) === cname);
}

export function describeProbe(p) {
  if (!p) return null;
  const target = p.httpGet
    ? `HTTP GET ${(p.httpGet.scheme || 'HTTP').toLowerCase()}://:${p.httpGet.port}${p.httpGet.path || '/'}`
    : p.tcpSocket ? `TCP :${p.tcpSocket.port}` : p.grpc ? `gRPC :${p.grpc.port}` : p.exec ? `exec "${(p.exec.command || []).join(' ')}"` : 'unknown';
  const d = p.initialDelaySeconds ?? 0;
  const per = p.periodSeconds ?? 10;
  const to = p.timeoutSeconds ?? 1;
  const ft = p.failureThreshold ?? 3;
  return { target, text: `${target} — initialDelay ${d}s, period ${per}s, timeout ${to}s, failureThreshold ${ft}`, budgetS: d + per * ft, timeoutS: to, port: p.httpGet?.port ?? p.tcpSocket?.port ?? p.grpc?.port };
}

function probePortIssue(spec, probe) {
  const port = probe?.httpGet?.port ?? probe?.tcpSocket?.port;
  if (port == null) return null;
  const ports = spec?.ports || [];
  if (typeof port === 'string' && !/^\d+$/.test(port)) {
    if (!ports.some((p) => p.name === port)) return `The probe uses named port "${port}" but the container declares no port with that name — the probe can never succeed.`;
    return null;
  }
  if (ports.length && !ports.some((p) => String(p.containerPort) === String(port))) {
    return `The probe targets port ${port} but the container declares port(s) ${ports.map((p) => p.containerPort).join(', ')}.`;
  }
  return null;
}

// ------------------------------------------------------------- pod states

function checkTerminating(P, add) {
  const overdue = ageMs(P.pod.metadata.deletionTimestamp);
  if (overdue == null || overdue < STUCK_MS) return;
  const finalizers = P.pod.metadata.finalizers || [];
  const node = P.node ? P.snap.get('Node', '', P.node) : null;
  const nodeReady = node ? (node.status?.conditions || []).find((c) => c.type === 'Ready')?.status === 'True' : null;
  let summary;
  let confidence = 'medium';
  if (node && nodeReady === false) {
    summary = `The pod sits on node ${P.node} which is NotReady; the kubelet cannot confirm the deletion, so the pod stays Terminating until the node comes back or is removed.`;
    confidence = 'high';
  } else if (finalizers.length) {
    summary = `Finalizers ${finalizers.join(', ')} are blocking deletion — the controller responsible for them is not removing them.`;
    confidence = 'high';
  } else if (P.node && !node && P.snap.has('nodes')) {
    summary = `The pod is bound to node ${P.node}, which no longer exists. Nothing can confirm its termination.`;
    confidence = 'high';
  } else {
    summary = 'The kubelet has not confirmed termination: a container ignores SIGTERM beyond its grace period, a preStop hook hangs, or volume unmount is stuck.';
  }
  add({
    category: 'StuckTerminating', severity: 'warning',
    title: `Pod stuck in Terminating for ${fmtAge(overdue)}`,
    rootCause: { summary, confidence },
    evidence: [`Deletion requested ${fmtAge(overdue)} ago`, finalizers.length ? `Finalizers: ${finalizers.join(', ')}` : null, P.node ? `Node: ${P.node} (${nodeReady === false ? 'NotReady' : node ? 'Ready' : 'not found'})` : null].filter(Boolean),
    fixes: ['Fix the underlying node/controller. As a last resort the pod can be force-deleted (`kubectl delete pod --grace-period=0 --force`) — this tool never does it for you.'],
    refs: P.node ? [objKey('Node', '', P.node)] : [],
  });
}

function checkEvicted(P, add) {
  const ex = K.explainEviction(P.pod.status?.message);
  const evictedAt = ts(cond(P.pod, 'Ready')?.lastTransitionTime) || ts(P.pod.status?.startTime);
  const old = ageMs(evictedAt) > OLD_MS;
  add({
    category: 'Evicted', severity: old ? 'info' : 'warning', tags: ex.tags,
    title: `Pod was evicted${P.node ? ` from node ${P.node}` : ''}`,
    rootCause: { summary: ex.summary, confidence: ex.confidence },
    evidence: [P.pod.status?.message, `QoS class: ${P.pod.status?.qosClass || '?'}`].filter(Boolean),
    fixes: [...ex.fixes, 'Evicted pods are not deleted automatically; they are kept for inspection.'],
    refs: P.node ? [objKey('Node', '', P.node)] : [],
    since: evictedAt || null,
  });
}

function checkFailedPodReason(P, add) {
  const reason = P.pod.status?.reason;
  const message = P.pod.status?.message || '';
  if (!reason) return false;
  const known = {
    Shutdown: 'The node was shut down gracefully (spot/preemptible instance reclaim, upgrade, or scale-down).',
    Terminated: 'The node was shut down gracefully (spot/preemptible instance reclaim, upgrade, or scale-down).',
    NodeShutdown: 'The node was shut down gracefully (spot/preemptible instance reclaim, upgrade, or scale-down).',
    NodeLost: 'The node was lost; the pod could not keep running.',
    OutOfcpu: 'The kubelet rejected the pod at admission: not enough CPU on the node (scheduler and kubelet disagreed, often due to static pods or changed allocatable).',
    OutOfmemory: 'The kubelet rejected the pod at admission: not enough memory on the node.',
    OutOfpods: 'The kubelet rejected the pod: node max-pods reached.',
    NodeAffinity: 'The kubelet rejected the pod because the node no longer matches its node affinity/selector (node labels changed).',
    UnexpectedAdmissionError: 'The kubelet failed to admit the pod (device plugin / GPU allocation or topology manager error).',
    Preempting: 'The pod was preempted by a higher-priority pod.',
    DeadlineExceeded: 'The pod ran longer than activeDeadlineSeconds.',
  };
  const summary = known[reason] || `Pod failed with reason ${reason}: ${message}`;
  const old = P.age > OLD_MS;
  add({
    category: 'PodFailed', severity: old || /Shutdown|Terminated/.test(reason) ? 'info' : 'warning', tags: [reason],
    title: `Pod failed: ${reason}`,
    rootCause: { summary, confidence: known[reason] ? 'high' : 'medium' },
    evidence: [message].filter(Boolean),
    fixes: reason.startsWith('Out') ? ['Usually transient: the controller creates a replacement pod. Delete the failed pod objects once understood.'] : ['Check the node and the controller that owns the pod.'],
    refs: P.node ? [objKey('Node', '', P.node)] : [],
  });
  return true;
}

// -------------------------------------------------------------- scheduling

function tolerates(tols = [], taint) {
  return tols.some((t) => {
    if (t.effect && t.effect !== taint.effect) return false;
    if (t.operator === 'Exists') return !t.key || t.key === taint.key;
    return t.key === taint.key && (t.value || '') === (taint.value || '');
  });
}

function matchExpr(e, labels) {
  const has = Object.prototype.hasOwnProperty.call(labels, e.key);
  const v = labels[e.key];
  switch (e.operator) {
    case 'In': return has && (e.values || []).includes(v);
    case 'NotIn': return !has || !(e.values || []).includes(v);
    case 'Exists': return has;
    case 'DoesNotExist': return !has;
    case 'Gt': return has && +v > +(e.values || [])[0];
    case 'Lt': return has && +v < +(e.values || [])[0];
    default: return false;
  }
}

export function nodeMatchesPod(node, pod) {
  const labels = node.metadata?.labels || {};
  for (const [k, v] of Object.entries(pod.spec?.nodeSelector || {})) if (labels[k] !== v) return false;
  const terms = pod.spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms;
  if (terms?.length) {
    return terms.some((t) => (t.matchExpressions || []).every((e) => matchExpr(e, labels))
      && (t.matchFields || []).every((e) => matchExpr(e, { 'metadata.name': node.metadata.name })));
  }
  return true;
}

function checkUnscheduled(P, add) {
  const { pod, snap } = P;
  const sched = cond(pod, 'PodScheduled');
  const failEvents = P.events.filter((e) => e.reason === 'FailedScheduling');
  const message = sched?.message || failEvents[0]?.message || '';
  if (!message && (P.age ?? 0) < 2 * MIN) return;

  const evidence = [];
  const fixes = [];
  const refs = [];
  const tags = [];
  let summary;
  let confidence = 'high';

  if (message) evidence.push(`Scheduler: ${truncate(message, 500)}`);
  const parsed = K.parseSchedulingMessage(message);
  for (const r of parsed.reasons) {
    tags.push(r.tag);
    if (r.fix && !fixes.includes(r.fix)) fixes.push(r.fix);
  }

  // Our own reasoning on top of the scheduler message.
  const nodes = snap.list('nodes');
  const insights = [];
  if (nodes.length) {
    const sel = pod.spec?.nodeSelector || {};
    for (const [k, v] of Object.entries(sel)) {
      const n = nodes.filter((nd) => nd.metadata?.labels?.[k] === v).length;
      if (n === 0) insights.push(`nodeSelector ${k}=${v} matches NO node in the cluster.`);
    }
    const matching = nodes.filter((nd) => nodeMatchesPod(nd, pod));
    if (!matching.length && !insights.length) insights.push('No node satisfies the pod\'s required node affinity / selector.');

    const req = podResources(pod);
    const schedulable = matching.filter((nd) => !nd.spec?.unschedulable && (nd.status?.conditions || []).find((c) => c.type === 'Ready')?.status === 'True');
    const untolerated = schedulable.filter((nd) => (nd.spec?.taints || []).some((t) => ['NoSchedule', 'NoExecute'].includes(t.effect) && !tolerates(pod.spec?.tolerations, t)));
    if (untolerated.length && untolerated.length === schedulable.length && schedulable.length) {
      const taints = uniq(untolerated.flatMap((nd) => (nd.spec?.taints || []).filter((t) => !tolerates(pod.spec?.tolerations, t)).map((t) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`)));
      insights.push(`Every eligible node carries a taint the pod does not tolerate: ${taints.join(', ')}.`);
    }
    const candidates = schedulable.filter((nd) => !untolerated.includes(nd));
    if (candidates.length) {
      const allocs = candidates.map((nd) => ({ nd, a: snap.nodeAllocation(nd.metadata.name) }));
      const maxAllocCpu = Math.max(...allocs.map((x) => x.a.cpu || 0));
      const maxAllocMem = Math.max(...allocs.map((x) => x.a.memory || 0));
      if (req.reqCpu > maxAllocCpu) insights.push(`The pod requests ${fmtCpu(req.reqCpu)} CPU but the largest eligible node only has ${fmtCpu(maxAllocCpu)} allocatable — it can NEVER be scheduled.`);
      if (req.reqMemory > maxAllocMem) insights.push(`The pod requests ${fmtBytes(req.reqMemory)} memory but the largest eligible node only has ${fmtBytes(maxAllocMem)} allocatable — it can NEVER be scheduled.`);
      if (!allocs[0].a.partial && req.reqCpu <= maxAllocCpu && req.reqMemory <= maxAllocMem) {
        const best = allocs.map((x) => ({ name: x.nd.metadata.name, cpu: (x.a.cpu || 0) - x.a.reqCpu, mem: (x.a.memory || 0) - x.a.reqMemory }));
        const fitCpu = best.filter((b) => b.cpu >= req.reqCpu).length;
        const fitMem = best.filter((b) => b.mem >= req.reqMemory).length;
        if (req.reqCpu && !fitCpu) insights.push(`No node has ${fmtCpu(req.reqCpu)} CPU unrequested (most free: ${fmtCpu(Math.max(...best.map((b) => b.cpu)))}) — the cluster is full on CPU requests.`);
        if (req.reqMemory && !fitMem) insights.push(`No node has ${fmtBytes(req.reqMemory)} memory unrequested (most free: ${fmtBytes(Math.max(...best.map((b) => b.mem)))}) — the cluster is full on memory requests.`);
      }
    } else if (schedulable.length === 0 && matching.length) {
      insights.push(`All ${matching.length} eligible node(s) are cordoned or NotReady.`);
    }
  }

  for (const v of pod.spec?.volumes || []) {
    const claim = v.persistentVolumeClaim?.claimName;
    if (!claim) continue;
    const pvc = snap.get('PersistentVolumeClaim', P.ns, claim);
    if (!pvc && snap.has('pvcs')) insights.push(`PersistentVolumeClaim "${claim}" does not exist.`);
    else if (pvc && pvc.status?.phase !== 'Bound') {
      insights.push(`PersistentVolumeClaim "${claim}" is ${pvc.status?.phase || 'not bound'}.`);
      refs.push(objKey('PersistentVolumeClaim', P.ns, claim));
    }
  }

  const scaleUp = P.events.find((e) => e.reason === 'TriggeredScaleUp');
  const noScaleUp = P.events.find((e) => e.reason === 'NotTriggerScaleUp');
  if (scaleUp) insights.push(`Cluster autoscaler is adding capacity: ${truncate(scaleUp.message, 200)}`);
  if (noScaleUp) insights.push(`Cluster autoscaler cannot help: ${truncate(noScaleUp.message, 300)}`);

  if (!message) {
    const schedName = pod.spec?.schedulerName;
    summary = schedName && schedName !== 'default-scheduler'
      ? `The pod requests scheduler "${schedName}" which has not acted on it (not installed or crashing).`
      : 'The pod has not been scheduled and the scheduler left no events (events may have expired; check the scheduler).';
    confidence = 'low';
  } else if (insights.length) {
    summary = insights[0];
  } else if (parsed.reasons.length) {
    summary = `No node can run the pod: ${parsed.reasons.map((r) => `${r.count ? `${r.count} node(s): ` : ''}${r.text}`).join('; ')}.`;
  } else {
    summary = `The scheduler cannot place the pod: ${truncate(message, 300)}`;
    confidence = 'medium';
  }

  add({
    category: 'Unschedulable',
    severity: scaleUp && (P.age ?? 0) < 10 * MIN ? 'info' : 'critical',
    tags: uniq(tags),
    title: `Cannot be scheduled for ${fmtAge(P.age)}: ${truncate(summary.replace(/\s—.*$/, '').replace(/\.$/, ''), 110)}`,
    rootCause: { summary, details: insights.slice(1), confidence },
    evidence: [...evidence, `Pod requests: cpu ${fmtCpu(podResources(pod).reqCpu)}, memory ${fmtBytes(podResources(pod).reqMemory)}`],
    fixes: fixes.length ? fixes : ['Compare the pod requirements (requests, nodeSelector, affinity, tolerations, volumes) with the nodes.'],
    refs,
    since: ts(pod.metadata.creationTimestamp),
    lastSeen: failEvents[0] ? eventTime(failEvents[0]) : null,
  });
}

// ------------------------------------------------------------ containers

function analyzeContainer(P, cs, spec, init, add) {
  const w = cs.state?.waiting;
  const t = cs.state?.terminated;
  const last = cs.lastState?.terminated;
  const cname = cs.name;
  const cEv = containerEvents(P, cname);
  const kind = init ? 'Init container' : 'Container';
  const restartPolicy = P.pod.spec?.restartPolicy || 'Always';

  if (w) {
    const reason = w.reason || '';
    if (reason === 'CrashLoopBackOff') {
      const d = diagnoseTermination(P, spec, cs, last || t);
      add({
        category: 'CrashLoopBackOff', severity: 'critical', container: cname, tags: d.tags,
        title: `${kind} "${cname}" is in CrashLoopBackOff (${cs.restartCount} restarts)`,
        rootCause: d.rootCause, evidence: d.evidence, fixes: d.fixes, refs: d.refs,
        wantsLogs: d.wantsLogs, since: ts(last?.finishedAt), message: w.message,
      });
      return true;
    }
    if (/ImagePull|ErrImage|InvalidImageName|ImageInspectError|RegistryUnavailable/.test(reason)) {
      const messages = [w.message, ...cEv.filter((e) => /^Failed/.test(e.reason) && /image/i.test(e.message || '')).map((e) => e.message)];
      const best = messages.find((m) => m && !/^Back-off pulling image/i.test(m) && !/^Error: \w+$/.test(m)) || w.message || '';
      const sa = P.snap.get('ServiceAccount', P.ns, P.pod.spec?.serviceAccountName || 'default');
      const pullSecrets = uniq([...(P.pod.spec?.imagePullSecrets || []), ...(sa?.imagePullSecrets || [])].map((s) => s.name));
      const node = P.snap.get('Node', '', P.node);
      const ex = K.explainImagePull(best, { image: spec?.image || cs.image, pullSecrets, nodeArch: node?.status?.nodeInfo?.architecture });
      add({
        category: 'ImagePullBackOff', severity: 'critical', container: cname, tags: uniq([reason, ...(ex.tags || [])]),
        title: `${kind} "${cname}" cannot pull image ${spec?.image || cs.image}`,
        rootCause: { summary: ex.summary, confidence: ex.confidence },
        evidence: [`Image: ${spec?.image || cs.image}`, `State: ${reason}`, best ? `Error: ${truncate(best, 600)}` : null, `Pull secrets: ${pullSecrets.join(', ') || 'none'}`, node ? `Node: ${P.node} (${node.status?.nodeInfo?.architecture})` : null].filter(Boolean),
        fixes: ex.fixes,
        message: best,
        lastSeen: cEv[0] ? eventTime(cEv[0]) : null,
        sharedCause: (ex.tags || []).some((t) => ['TLS', 'RegistryUnreachable', 'RateLimited'].includes(t)) ? `registry|${registryHost(spec?.image || cs.image)}|${ex.tags.join(',')}` : undefined,
      });
      return true;
    }
    if (reason === 'CreateContainerConfigError') {
      const msg = w.message || cEv.find((e) => e.reason === 'Failed')?.message || '';
      const ex = K.explainContainerConfigError(msg);
      add({
        category: 'CreateContainerConfigError', severity: 'critical', container: cname, tags: ex.tags,
        title: `${kind} "${cname}" cannot be configured: ${truncate(msg, 120)}`,
        rootCause: { summary: ex.summary, confidence: ex.confidence },
        evidence: [`Message: ${msg}`], fixes: ex.fixes, message: msg,
      });
      return true;
    }
    if (/CreateContainerError|RunContainerError|StartError|ContainerCannotRun|PreStartHookError|PostStartHookError/.test(reason)) {
      const msg = w.message || cEv.find((e) => e.reason === 'Failed')?.message || '';
      const ex = /HookError/.test(reason)
        ? { summary: `The ${reason.startsWith('Pre') ? 'preStart' : 'postStart'} lifecycle hook failed, so the container was killed.`, fixes: ['Fix or remove the lifecycle hook command; it must exist in the image and exit 0.'], confidence: 'high', tags: ['LifecycleHook'] }
        : K.explainContainerStartError(msg);
      add({
        category: 'ContainerStartError', severity: 'critical', container: cname, tags: uniq([reason, ...(ex.tags || [])]),
        title: `${kind} "${cname}" fails to start (${reason})`,
        rootCause: { summary: ex.summary, confidence: ex.confidence },
        evidence: [`Message: ${truncate(msg, 600)}`, `Command: ${[...(spec?.command || []), ...(spec?.args || [])].join(' ') || '(image default ENTRYPOINT/CMD)'}`],
        fixes: ex.fixes, message: msg,
      });
      return true;
    }
    if (reason === 'ContainerCreating' || reason === 'PodInitializing') return false;
    if (reason) {
      add({
        category: 'ContainerWaiting', severity: 'warning', container: cname, tags: [reason],
        title: `${kind} "${cname}" is waiting: ${reason}`,
        rootCause: { summary: w.message || `The container is waiting with reason ${reason}.`, confidence: 'low' },
        evidence: [w.message].filter(Boolean), fixes: ['Inspect the pod events.'],
      });
      return true;
    }
    return false;
  }

  if (t) {
    if (t.exitCode === 0 && (init || restartPolicy !== 'Always')) return false;
    if (t.exitCode === 0 && restartPolicy === 'Always' && !init) {
      const d = diagnoseTermination(P, spec, cs, t);
      add({ category: 'CrashLoopBackOff', severity: 'warning', container: cname, tags: d.tags, title: `${kind} "${cname}" exited (code 0) and will be restarted`, rootCause: d.rootCause, evidence: d.evidence, fixes: d.fixes, wantsLogs: true, since: ts(t.finishedAt) });
      return true;
    }
    const d = diagnoseTermination(P, spec, cs, t);
    const job = P.owner && ['Job', 'CronJob'].includes(P.owner.kind);
    const old = ageMs(t.finishedAt) > OLD_MS;
    add({
      category: d.tags.includes('OOMKilled') ? 'OOMKilled' : 'ContainerFailed',
      severity: old ? 'info' : job ? 'warning' : 'critical', container: cname, tags: d.tags,
      title: `${kind} "${cname}" terminated with ${t.reason || 'error'} (exit code ${t.exitCode})`,
      rootCause: d.rootCause, evidence: d.evidence, fixes: d.fixes, refs: d.refs, wantsLogs: d.wantsLogs,
      since: ts(t.finishedAt),
    });
    return true;
  }

  if (cs.state?.running) {
    let reported = false;
    if (last && cs.restartCount > 0 && ageMs(last.finishedAt) < RECENT_MS) {
      const d = diagnoseTermination(P, spec, cs, last);
      if (last.reason === 'OOMKilled') {
        add({ category: 'OOMKilled', severity: 'warning', container: cname, tags: d.tags, title: `${kind} "${cname}" was OOMKilled ${fmtAge(ageMs(last.finishedAt))} ago (running again, ${cs.restartCount} restarts)`, rootCause: d.rootCause, evidence: d.evidence, fixes: d.fixes, refs: d.refs, since: ts(last.finishedAt) });
        reported = true;
      } else if (cs.restartCount >= 3 || d.tags.includes('LivenessProbe')) {
        add({ category: 'Restarting', severity: 'warning', container: cname, tags: d.tags, title: `${kind} "${cname}" keeps restarting (${cs.restartCount} restarts, last ${fmtAge(ageMs(last.finishedAt))} ago)`, rootCause: d.rootCause, evidence: d.evidence, fixes: d.fixes, refs: d.refs, wantsLogs: d.wantsLogs, since: ts(last.finishedAt) });
        reported = true;
      }
    }
    if (!cs.ready && !init) {
      const readyCond = cond(P.pod, 'Ready');
      const notReadyFor = ageMs(readyCond?.lastTransitionTime || cs.state.running.startedAt);
      if (notReadyFor > NOT_READY_MS) {
        const probeEvents = cEv.filter((e) => e.reason === 'Unhealthy' && /^(Readiness|Startup) probe/i.test(e.message || ''));
        const lastProbe = probeEvents[0];
        const probeType = lastProbe && /^Startup/i.test(lastProbe.message) ? 'Startup' : 'Readiness';
        const probe = probeType === 'Startup' ? spec?.startupProbe : spec?.readinessProbe;
        const ex = lastProbe ? K.explainProbeFailure(lastProbe.message.replace(/^\w+ probe failed:\s*/i, ''), probeType) : null;
        const portIssue = probePortIssue(spec, probe);
        add({
          category: 'NotReady', severity: 'warning', container: cname, tags: ex?.tags || ['ProbeFailure'],
          title: `Container "${cname}" is running but not Ready for ${fmtAge(notReadyFor)}`,
          rootCause: {
            summary: portIssue || ex?.summary || (probe ? `The ${probeType.toLowerCase()} probe keeps failing (no recent probe events to say why).` : 'The container is not ready (readiness gate or startup in progress).'),
            confidence: portIssue ? 'high' : ex?.confidence || 'low',
          },
          evidence: [
            probe ? `${probeType} probe: ${describeProbe(probe).text}` : null,
            lastProbe ? `Last probe failure (${eventCount(lastProbe)}x): ${truncate(lastProbe.message, 300)}` : null,
            'Not-ready pods are removed from Service endpoints and receive no traffic.',
          ].filter(Boolean),
          fixes: ex?.fixes || ['Check the probe endpoint manually and the app logs.'],
          wantsLogs: true,
          since: ts(readyCond?.lastTransitionTime),
        });
        reported = true;
      }
    }
    return reported;
  }
  return false;
}

// Explains why a container terminated (last or current termination state).
export function diagnoseTermination(P, spec, cs, term) {
  const evidence = [];
  const fixes = [];
  const tags = [];
  const refs = [];
  const details = [];
  const cname = cs.name;
  const code = term?.exitCode;
  const reason = term?.reason;
  const lim = spec?.resources?.limits || {};
  const req = spec?.resources?.requests || {};
  const memLimit = parseQuantity(lim.memory);
  const memReq = parseQuantity(req.memory);
  const usage = P.snap.containerUsage(P.ns, P.name, cname);
  const cEv = containerEvents(P, cname);
  const ran = term ? ts(term.finishedAt) - ts(term.startedAt) : NaN;

  if (term) {
    evidence.push(`Last termination: reason=${reason || '?'}, exit code ${code}${term.signal ? `, signal ${term.signal}` : ''}, finished ${fmtAge(ageMs(term.finishedAt))} ago${Number.isFinite(ran) ? ` after running ${fmtAge(ran)}` : ''}`);
    if (term.message) evidence.push(`Termination message: ${truncate(term.message, 400)}`);
  }
  evidence.push(`Restarts: ${cs.restartCount ?? 0}`);
  evidence.push(`Resources: requests cpu=${req.cpu || '—'} mem=${req.memory || '—'} / limits cpu=${lim.cpu || '—'} mem=${lim.memory || '—'}${usage ? ` / usage now cpu=${fmtCpu(usage.cpu)} mem=${fmtBytes(usage.memory)}` : ''}`);

  const probeFails = cEv.filter((e) => e.reason === 'Unhealthy' && /^(Liveness|Startup) probe/i.test(e.message || ''));
  const probeKill = cEv.find((e) => e.reason === 'Killing' && /failed (liveness|startup) probe/i.test(e.message || ''));
  const out = (summary, confidence, extra = {}) => ({
    rootCause: { summary, details, confidence },
    evidence, fixes, tags: uniq(tags), refs, wantsLogs: extra.wantsLogs ?? false,
  });

  if (!term) {
    tags.push('NoTerminationState');
    return out('The container keeps crashing but its last termination state is not available.', 'low', { wantsLogs: true });
  }

  if (reason === 'OOMKilled') {
    tags.push('OOMKilled');
    const hints = K.runtimeHints(spec);
    let summary;
    if (memLimit) {
      summary = `Container "${cname}" used more memory than its limit (${fmtBytes(memLimit)}) and was killed by the kernel OOM killer.`;
      if (usage?.memory) details.push(`Memory right now (after restart): ${fmtBytes(usage.memory)} = ${pct(usage.memory, memLimit)}% of the limit.`);
      if (hints.isJava) {
        tags.push('JVM');
        if (hints.xmx) {
          const x = parseJavaSize(hints.xmx);
          const ratio = x / memLimit;
          if (ratio >= 0.85) {
            summary += ` The JVM heap alone (-Xmx${hints.xmx}) is ${Math.round(ratio * 100)}% of the limit: heap + metaspace + threads + direct buffers cannot fit.`;
            fixes.push(`Lower -Xmx to ≤75% of the limit (≈${fmtBytes(memLimit * 0.75)}) or raise the limit to ≈${fmtBytes(x / 0.75)}.`);
          } else {
            details.push(`JVM heap -Xmx${hints.xmx} is ${Math.round(ratio * 100)}% of the limit, leaving ${fmtBytes(memLimit - x)} for off-heap memory (metaspace, threads, direct/NIO buffers, native libs).`);
          }
        } else if (hints.maxRamPercentage) {
          if (hints.maxRamPercentage > 80) {
            summary += ` -XX:MaxRAMPercentage=${hints.maxRamPercentage} leaves too little room for off-heap memory.`;
            fixes.push('Use MaxRAMPercentage=70-75.');
          }
        } else {
          details.push('Java app without -Xmx/MaxRAMPercentage: recent JVMs size the heap to 25% of the limit, so the kill usually comes from off-heap memory, many threads, or an old JVM that is not container-aware (Java 8 < 8u191).');
          fixes.push('Set -XX:MaxRAMPercentage=75 (JAVA_TOOL_OPTIONS) and size the limit for the real footprint.');
        }
      }
      if (hints.isNode && hints.maxOldSpaceMb) {
        const heap = hints.maxOldSpaceMb * 2 ** 20;
        if (heap >= memLimit * 0.85) {
          summary += ` Node.js --max-old-space-size=${hints.maxOldSpaceMb} is too close to the limit.`;
          fixes.push(`Set --max-old-space-size to ≈${Math.round((memLimit * 0.75) / 2 ** 20)} MB.`);
        }
      }
      if (memReq && memReq < memLimit) details.push(`The memory request (${fmtBytes(memReq)}) is lower than the limit (${fmtBytes(memLimit)}): the scheduler only reserves the request.`);
      if (Number.isFinite(ran) && ran < 60_000) details.push(`It was killed only ${fmtAge(ran)} after starting: the limit is too low even for startup.`);
      fixes.push(`Raise resources.limits.memory (e.g. to ${fmtBytes(memLimit * 1.5)}) and set requests.memory to the same value for Guaranteed QoS.`);
      fixes.push('If memory grows steadily until the kill, it is a leak: take a heap profile (heap dump, pprof, tracemalloc, --inspect).');
      return out(summary, 'high');
    }
    const nodeOOM = P.node ? P.snap.eventsFor('Node', '', P.node).filter((e) => /OOM/i.test(e.reason || '') || /OOM/i.test(e.message || '')) : [];
    if (nodeOOM.length) evidence.push(`Node ${P.node} reported ${nodeOOM.length} OOM event(s): ${truncate(nodeOOM[0].message, 200)}`);
    if (P.node) refs.push(objKey('Node', '', P.node));
    fixes.push('Set memory requests and limits on this container (and on the other workloads of the node).', 'Find the biggest consumers: `kubectl top pods -A --sort-by=memory`.');
    return out(`Container "${cname}" was OOM-killed although it has NO memory limit: node ${P.node || '?'} ran out of memory and the kernel killed it.`, 'high');
  }

  if (probeKill || (probeFails.length && [137, 143, 0, 2].includes(code))) {
    tags.push('LivenessProbe');
    const isStartup = /startup/i.test(probeKill?.message || probeFails[0]?.message || '');
    const probe = isStartup ? spec?.startupProbe : spec?.livenessProbe;
    const pd = describeProbe(probe);
    const lastFail = probeFails[0]?.message?.replace(/^\w+ probe failed:\s*/i, '');
    const ex = K.explainProbeFailure(lastFail, isStartup ? 'Startup' : 'Liveness');
    if (pd) evidence.push(`${isStartup ? 'Startup' : 'Liveness'} probe: ${pd.text}`);
    if (probeFails[0]) evidence.push(`Probe failed ${probeFails.reduce((a, e) => a + eventCount(e), 0)}x, last: ${truncate(probeFails[0].message, 300)}`);
    const portIssue = probePortIssue(spec, probe);
    if (portIssue) details.push(portIssue);
    if (!isStartup && pd && !spec?.startupProbe && pd.budgetS < 60) {
      details.push(`The app gets only ~${pd.budgetS}s (initialDelay + period × failureThreshold) to become healthy before being killed, and there is no startupProbe.`);
      fixes.push('Add a startupProbe (e.g. failureThreshold 30 × period 10s) so slow starts are not killed.');
    }
    if (pd && pd.timeoutS <= 1) details.push('timeoutSeconds is 1s: any GC pause or CPU throttling makes the probe fail.');
    if (lim.cpu && usage?.cpu && usage.cpu >= parseQuantity(lim.cpu) * 0.9) details.push(`CPU usage is at the limit (${fmtCpu(usage.cpu)} / ${lim.cpu}): throttling slows the health endpoint.`);
    fixes.push(...ex.fixes, 'Liveness checks must not depend on external systems (DB, other services) or a dependency outage restarts every pod.');
    return out(`The kubelet kills container "${cname}" because its ${isStartup ? 'startup' : 'liveness'} probe fails. ${portIssue || ex.summary}`, portIssue ? 'high' : 'medium');
  }

  if (reason === 'ContainerCannotRun' || reason === 'StartError') {
    const ex = K.explainContainerStartError(term.message);
    tags.push(...(ex.tags || []), 'StartError');
    fixes.push(...ex.fixes);
    return out(ex.summary, ex.confidence);
  }

  const cmd = [...(spec?.command || []), ...(spec?.args || [])].join(' ');
  details.push(K.explainExitCode(code));
  tags.push(`Exit${code}`);
  switch (code) {
    case 0:
      if (cmd) evidence.push(`Command: ${truncate(cmd, 300)}`);
      fixes.push('Run the main process in the foreground (no `&`, no daemon mode such as `nginx -g "daemon off;"`).', 'If the container is meant to run once, use a Job instead of a Deployment.');
      return out(`Container "${cname}" exits successfully (code 0) right after starting, but the pod's restartPolicy is Always, so Kubernetes restarts it in a loop. The main process is not long-running.`, 'high', { wantsLogs: true });
    case 126:
    case 127:
      evidence.push(`Command: ${cmd || '(image default ENTRYPOINT/CMD)'}`);
      tags.push('BadCommand');
      fixes.push('Fix command/args or the image entrypoint; check the shell exists in the image (`sh` vs `bash`).');
      return out(code === 127 ? `The command of container "${cname}" was not found in the image (exit 127).` : `The command of container "${cname}" is not executable (exit 126).`, 'high', { wantsLogs: true });
    case 139:
    case 134:
    case 132:
      tags.push('NativeCrash');
      fixes.push('Check the image architecture matches the node, native library versions, and look for a core dump / stack trace in the logs.');
      return out(`Container "${cname}" crashed in native code (${K.SIGNALS[code - 128] || `exit ${code}`}).`, 'medium', { wantsLogs: true });
    case 137: {
      const nodeOOM = P.node ? P.snap.eventsFor('Node', '', P.node).filter((e) => /OOM/i.test(`${e.reason} ${e.message}`)) : [];
      if (nodeOOM.length) {
        tags.push('OOMKilled');
        if (P.node) refs.push(objKey('Node', '', P.node));
        evidence.push(`Node ${P.node} reported OOM: ${truncate(nodeOOM[0].message, 200)}`);
        fixes.push('Set memory limits/requests that match real usage.');
        return out(`Container "${cname}" was SIGKILLed (137) while node ${P.node} reported an out-of-memory condition: most likely killed by the node OOM killer.`, 'medium');
      }
      fixes.push('If the app ignores SIGTERM, handle it or raise terminationGracePeriodSeconds.', 'Compare memory usage with the limit (kubectl top) — a cgroup OOM is sometimes reported as Error/137.');
      return out(`Container "${cname}" was killed with SIGKILL (137) without an OOMKilled reason or failing liveness probe: most likely it did not stop within terminationGracePeriodSeconds, or memory was exhausted.`, 'low', { wantsLogs: true });
    }
    case 143:
      fixes.push('Check what stopped it: rollout, eviction, node drain, preemption (see events).');
      return out(`Container "${cname}" was stopped with SIGTERM (143) — something asked it to stop (rollout, preemption, drain), or it does not handle SIGTERM gracefully.`, 'low', { wantsLogs: true });
    default:
      fixes.push('Read the logs of the previous instance: `kubectl logs --previous`.');
      if (Number.isFinite(ran) && ran < 30_000) details.push(`It crashed ${fmtAge(ran)} after starting, i.e. during initialization (configuration, missing dependency, failed connection).`);
      return out(`The application in container "${cname}" exits with code ${code} (error). The cause is in its logs.`, 'low', { wantsLogs: true });
  }
}

// ------------------------------------------------------ creating / volumes

function checkStuckCreating(P, add) {
  if ((P.age ?? 0) < STUCK_MS) return false;
  const ev = P.events.filter((e) => e.type === 'Warning');
  const CONF_RANK = { high: 3, medium: 2, low: 1 };
  const mount = ev.filter((e) => /FailedMount|FailedAttachVolume|FailedMapVolume/.test(e.reason))
    .sort((a, b) => CONF_RANK[K.explainMountFailure(b.message).confidence] - CONF_RANK[K.explainMountFailure(a.message).confidence])[0];
  const sandbox = ev.find((e) => /FailedCreatePodSandBox|NetworkNotReady|FailedKillPod/.test(e.reason));
  const pulling = P.events.find((e) => e.reason === 'Pulling');
  const pulled = P.events.find((e) => e.reason === 'Pulled');

  if (mount) {
    const ex = K.explainMountFailure(mount.message);
    const refs = [];
    const evidence = [`${mount.reason} (${eventCount(mount)}x): ${truncate(mount.message, 600)}`];
    for (const v of P.pod.spec?.volumes || []) {
      const claim = v.persistentVolumeClaim?.claimName;
      if (!claim) continue;
      refs.push(objKey('PersistentVolumeClaim', P.ns, claim));
      if (/Multi-Attach/i.test(mount.message)) {
        // Whoever else mounts this RWO claim on another node is holding the volume.
        for (const other of P.snap.list('pods')) {
          if (other === P.pod || other.metadata.namespace !== P.ns || !other.spec?.nodeName || other.spec.nodeName === P.node) continue;
          if (!(other.spec.volumes || []).some((ov) => ov.persistentVolumeClaim?.claimName === claim)) continue;
          refs.push(objKey('Pod', P.ns, other.metadata.name), objKey('Node', '', other.spec.nodeName));
          evidence.push(`Volume "${claim}" is still used by pod ${other.metadata.name} on node ${other.spec.nodeName}${other.metadata.deletionTimestamp ? ' (Terminating)' : ''}.`);
        }
      }
    }
    add({
      category: 'VolumeMount', severity: 'critical', tags: ex.tags,
      title: `Pod stuck in ContainerCreating: volume cannot be mounted (${fmtAge(P.age)})`,
      rootCause: { summary: ex.summary, confidence: ex.confidence },
      evidence,
      fixes: ex.fixes, refs, lastSeen: eventTime(mount),
    });
    return true;
  }
  if (sandbox) {
    let ex = K.explainSandboxFailure(sandbox.message);
    if (/failed to (get sandbox image|pull)/i.test(sandbox.message)) {
      const img = K.explainImagePull(sandbox.message, { image: (sandbox.message.match(/sandbox image "([^"]+)"/) || [])[1] });
      ex = { ...img, summary: `The node cannot pull the pod sandbox ("pause") image, so no pod can start on it. ${img.summary}`, tags: ['Sandbox', ...(img.tags || [])] };
    }
    add({
      category: 'StuckCreating', severity: 'critical', tags: ex.tags,
      title: `Pod stuck in ContainerCreating: sandbox cannot be created (${fmtAge(P.age)})`,
      rootCause: { summary: ex.summary, confidence: ex.confidence },
      evidence: [`${sandbox.reason} (${eventCount(sandbox)}x): ${truncate(sandbox.message, 600)}`, `Node: ${P.node}`],
      fixes: ex.fixes, refs: P.node ? [objKey('Node', '', P.node)] : [], lastSeen: eventTime(sandbox),
      sharedCause: `sandbox|${P.node}|${(ex.tags || []).join(',')}`,
    });
    return true;
  }
  if (pulling && (!pulled || eventTime(pulled) < eventTime(pulling))) {
    add({
      category: 'StuckCreating', severity: 'warning', tags: ['SlowPull'],
      title: `Pod still pulling its image after ${fmtAge(P.age)}`,
      rootCause: { summary: `The image is still being pulled (${truncate(pulling.message, 160)}): very large image or slow registry link.`, confidence: 'medium' },
      evidence: [pulling.message], fixes: ['Reduce image size, use a closer registry mirror, or pre-pull images.'],
    });
    return true;
  }
  add({
    category: 'StuckCreating', severity: 'warning',
    title: `Pod stuck in ${P.pod.status?.phase} for ${fmtAge(P.age)}`,
    rootCause: { summary: 'The pod is scheduled but its containers never started, and no explanatory event is left (events expire after ~1h). Check the kubelet on the node.', confidence: 'low' },
    evidence: [`Node: ${P.node}`], fixes: ['Run kubectl describe pod and check kubelet/containerd logs on the node.'],
    refs: P.node ? [objKey('Node', '', P.node)] : [],
  });
  return true;
}
