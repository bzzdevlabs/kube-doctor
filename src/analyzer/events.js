// Turns Warning events that no other rule explained into findings, and
// prepares the event list for the UI.
import { eventTime, eventFirstTime, eventCount, objKey, truncate, ageMs, MIN, HOUR } from './util.js';
import * as K from './knowledge.js';

function explainEvent(ev) {
  const m = ev.message || '';
  switch (ev.reason) {
    case 'FailedMount':
    case 'FailedAttachVolume':
    case 'FailedMapVolume':
      return K.explainMountFailure(m);
    case 'FailedScheduling': {
      const p = K.parseSchedulingMessage(m);
      return { summary: p.reasons.length ? `Scheduling failed: ${p.reasons.map((r) => r.text).join('; ')}.` : m, fixes: p.reasons.map((r) => r.fix), confidence: 'medium' };
    }
    case 'Unhealthy':
      return K.explainProbeFailure(m.replace(/^\w+ probe failed:\s*/i, ''), (m.match(/^(\w+) probe/) || [])[1] || 'Readiness');
    case 'FailedCreatePodSandBox':
      return K.explainSandboxFailure(m);
    case 'FailedCreate':
      return K.explainFailedCreate(m);
    case 'ProvisioningFailed':
      return K.explainPvcPending(m);
    case 'Evicted':
      return K.explainEviction(m);
    case 'BackOff':
      return { summary: /pulling image/i.test(m) ? 'Image pull back-off.' : 'A container keeps failing and Kubernetes backs off before restarting it.', fixes: [], confidence: 'low' };
    case 'Failed':
      return /image/i.test(m) ? K.explainImagePull(m) : { summary: m, fixes: [], confidence: 'low' };
    case 'FreeDiskSpaceFailed':
    case 'ImageGCFailed':
      return { summary: 'The kubelet cannot free enough disk space by deleting unused images: the node disk is too small or filled by something else (logs, emptyDirs).', fixes: ['Inspect node disk usage; enlarge the disk.'], confidence: 'high' };
    case 'InvalidDiskCapacity':
      return { summary: 'The kubelet reports invalid image filesystem capacity (often harmless at boot; persistent means a broken runtime/disk).', fixes: [], confidence: 'medium' };
    case 'EvictionThresholdMet':
      return { summary: 'The node crossed an eviction threshold; pods are being evicted to reclaim resources.', fixes: ['Check node memory/disk usage.'], confidence: 'high' };
    case 'Rebooted':
      return { summary: 'The node rebooted — pods on it were restarted.', fixes: ['If unexpected, check kernel panics / maintenance events in the provider console.'], confidence: 'high' };
    case 'NodeNotReady':
      return { summary: 'The node became NotReady (pods on it were marked not ready).', fixes: [], confidence: 'medium' };
    case 'FailedKillPod':
      return { summary: 'The kubelet failed to stop a pod (runtime or network teardown issue).', fixes: ['Check the CNI/runtime on the node.'], confidence: 'medium' };
    case 'FailedComputeMetricsReplicas':
    case 'FailedGetResourceMetric':
    case 'FailedGetPodsMetric':
    case 'FailedGetExternalMetric':
      return { summary: `The HPA cannot read its metrics: ${truncate(m, 240)}`, fixes: ['Check metrics-server / metrics adapter and container requests.'], confidence: 'medium' };
    case 'SyncLoadBalancerFailed':
      return { summary: `The cloud controller could not configure the load balancer: ${truncate(m, 240)}`, fixes: ['Check cloud quotas/permissions/subnet tags.'], confidence: 'high' };
    case 'FailedToUpdateEndpoint':
    case 'FailedToUpdateEndpointSlices':
      return { summary: 'The endpoint controller could not update endpoints (API conflicts or webhooks).', fixes: [], confidence: 'low' };
    case 'Preempted':
      return { summary: `The pod was preempted to make room for a higher-priority pod: ${truncate(m, 200)}`, fixes: ['Use a higher PriorityClass for important workloads or add capacity.'], confidence: 'high' };
    case 'TaintManagerEviction':
      return { summary: 'The pod was deleted because its node got a NoExecute taint (node unreachable/not-ready).', fixes: [], confidence: 'high' };
    case 'DNSConfigForming':
      return { summary: 'The pod DNS configuration exceeded resolver limits (too many nameservers/search domains); some were dropped.', fixes: ['Reduce search domains in the node resolv.conf or the pod dnsConfig.'], confidence: 'high' };
    default:
      return { summary: truncate(m, 300), fixes: [], confidence: 'low' };
  }
}

const KIND_KEY = { Pod: 'pods', Node: 'nodes', Deployment: 'deployments', ReplicaSet: 'replicasets', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets', Job: 'jobs', CronJob: 'cronjobs', Service: 'services', PersistentVolumeClaim: 'pvcs', Ingress: 'ingresses', HorizontalPodAutoscaler: 'hpas' };

export function analyzeUnexplainedEvents(snap, out) {
  const covered = new Set();
  for (const f of out.findings) {
    covered.add(objKey(f.object.kind, f.object.namespace, f.object.name));
    for (const i of f.instances || []) covered.add(objKey('Pod', i.namespace, i.pod));
  }
  const groups = new Map();
  for (const ev of snap.list('events')) {
    if (ev.type !== 'Warning') continue;
    const io = ev.involvedObject || {};
    const k = objKey(io.kind, io.namespace, io.name);
    if (covered.has(k)) continue;
    const gk = `${k}|${ev.reason}`;
    const g = groups.get(gk) || { io, reason: ev.reason, events: [], count: 0 };
    g.events.push(ev);
    g.count += eventCount(ev);
    groups.set(gk, g);
  }
  for (const g of groups.values()) {
    g.events.sort((a, b) => eventTime(b) - eventTime(a));
    const ev = g.events[0];
    const last = eventTime(ev);
    const recent = ageMs(last) < 30 * MIN;
    const ex = explainEvent(ev);
    const listKey = KIND_KEY[g.io.kind];
    const gone = listKey && snap.has(listKey) && !snap.get(g.io.kind, g.io.namespace, g.io.name);
    // Probe failures and back-offs on healthy, running pods are usually transient noise.
    const noisy = (['Unhealthy', 'BackOff'].includes(g.reason) && !recent) || ['CgroupV1', 'InvalidDiskCapacity'].includes(g.reason);
    out.add({
      object: { kind: g.io.kind || '?', namespace: g.io.namespace || '', name: g.io.name || '?' },
      category: 'WarningEvent', severity: gone || noisy || ageMs(last) > HOUR ? 'info' : g.count >= 3 || recent ? 'warning' : 'info',
      tags: [g.reason, ...(gone ? ['ObjectGone'] : [])],
      title: `${g.reason} on ${g.io.kind} ${g.io.name}${g.count > 1 ? ` (${g.count}x)` : ''}${gone ? ' — object no longer exists' : ''}`,
      rootCause: { summary: ex.summary || truncate(ev.message, 300), confidence: ex.confidence || 'low' },
      evidence: g.events.slice(0, 5).map((e) => `${new Date(eventTime(e)).toISOString()} ${e.reason} (${eventCount(e)}x): ${truncate(e.message, 400)}`),
      fixes: (ex.fixes || []).filter(Boolean),
      commands: g.io.namespace ? [snap.cmd(`get events -n ${g.io.namespace} --field-selector involvedObject.name=${g.io.name}`)] : [snap.cmd(`get events -A --field-selector involvedObject.name=${g.io.name}`)],
      lastSeen: last,
      deep: g.io.kind === 'Pod' && !gone,
    });
  }
}

export function eventRows(snap, limit = 4000) {
  const rows = snap.list('events').map((ev) => ({
    type: ev.type || 'Normal',
    reason: ev.reason,
    message: truncate(ev.message, 2000),
    object: { kind: ev.involvedObject?.kind, namespace: ev.involvedObject?.namespace || '', name: ev.involvedObject?.name },
    container: (ev.involvedObject?.fieldPath || '').match(/\{([^}]+)\}/)?.[1] || null,
    count: eventCount(ev),
    first: eventFirstTime(ev) || null,
    last: eventTime(ev) || null,
    source: ev.source?.component || ev.reportingComponent || ev.reportingController || '',
  }));
  rows.sort((a, b) => (a.type === 'Warning' ? 0 : 1) - (b.type === 'Warning' ? 0 : 1) || (b.last || 0) - (a.last || 0));
  const capped = rows.slice(0, limit);
  capped.sort((a, b) => (b.last || 0) - (a.last || 0));
  return { rows: capped, total: rows.length, warnings: rows.filter((r) => r.type === 'Warning').length };
}
