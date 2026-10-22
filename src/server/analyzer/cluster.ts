// Cluster-wide checks: API server health, aggregated APIs, namespaces, quotas.
import type { Snapshot } from './snapshot.js';
import type { FindingSink } from '../types.js';
import { ageMs, fmtAge, objKey, truncate, parseQuantity, cond, MIN } from './util.js';

export function analyzeCluster(snap: Snapshot, out: FindingSink): void {
  const health = snap.collected.health;
  const failing = (health?.checks || []).filter((c) => !c.ok);
  if (failing.length) {
    out.add({
      object: { kind: 'APIServer', namespace: '', name: 'kube-apiserver' }, category: 'ControlPlane', severity: 'critical',
      title: `API server readiness checks failing: ${failing.map((c) => c.name).join(', ')}`,
      rootCause: { summary: failing.some((c) => /etcd/.test(c.name)) ? 'The API server cannot reach etcd reliably: cluster state reads/writes fail or are slow.' : `The API server reports failing readiness checks (${failing.map((c) => c.name).join(', ')}).`, confidence: 'high' },
      evidence: failing.map((c) => `[-]${c.name} ${c.message}`),
      fixes: ['Managed clusters: check the provider status page / support. Self-managed: check etcd and control-plane pods.'],
      commands: [snap.cmd('get --raw "/readyz?verbose"')],
    });
  }

  for (const api of snap.list('apiservices')) {
    const c = cond(api, 'Available');
    if (!c || c.status === 'True') continue;
    const svc = api.spec?.service;
    const name = api.metadata.name;
    const isMetrics = /metrics\.k8s\.io$/.test(api.spec?.group || '');
    out.add({
      object: { kind: 'APIService', namespace: '', name }, category: 'APIServiceUnavailable', severity: isMetrics || svc ? 'critical' : 'warning',
      title: `Aggregated API ${name} is unavailable (${c.reason})`,
      rootCause: {
        summary: `${name} is served by ${svc ? `Service ${svc.namespace}/${svc.name}` : 'an extension API server'} which is not responding (${c.reason}). ${isMetrics ? 'Consequences: HPAs cannot scale and `kubectl top` fails. ' : ''}Unavailable aggregated APIs also block namespace deletion and slow down every kubectl discovery.`,
        details: [truncate(c.message, 400)], confidence: svc ? 'low' : 'medium', derived: !!svc,
      },
      evidence: [`Available=False ${c.reason}: ${truncate(c.message, 500)}`],
      fixes: [svc ? `Fix the pods behind Service ${svc.namespace}/${svc.name}.` : '', 'If the extension was uninstalled, its APIService object is stale and should be removed by an admin.'].filter(Boolean),
      refs: svc ? [objKey('Service', svc.namespace, svc.name)] : [],
      commands: [snap.cmd(`get apiservice ${name} -o yaml`)],
    });
  }

  for (const ns of snap.list('namespaces')) {
    if (ns.status?.phase !== 'Terminating') continue;
    const since = ageMs(ns.metadata.deletionTimestamp);
    if (since == null || since < 5 * MIN) continue;
    const conds = (ns.status?.conditions || []).filter((c) => c.status === 'True');
    const discovery = conds.find((c) => c.type === 'NamespaceDeletionDiscoveryFailure');
    const remaining = conds.find((c) => c.type === 'NamespaceContentRemaining');
    const finalizers = conds.find((c) => c.type === 'NamespaceFinalizersRemaining');
    let summary = 'The namespace deletion is blocked.';
    const refs = [];
    if (discovery) {
      summary = `Deletion is blocked because some aggregated APIs are unavailable, so the namespace controller cannot list all resources: ${truncate(discovery.message, 250)}`;
      for (const api of snap.list('apiservices')) if (cond(api, 'Available')?.status === 'False') refs.push(objKey('APIService', '', api.metadata.name));
    } else if (finalizers) {
      summary = `Objects inside the namespace still carry finalizers whose controller is gone or failing: ${truncate(finalizers.message, 250)}`;
    } else if (remaining) {
      summary = `Resources remain in the namespace: ${truncate(remaining.message, 250)}`;
    } else if ((ns.spec?.finalizers || []).length) {
      summary = `Namespace finalizers ${(ns.spec?.finalizers ?? []).join(', ')} have not been removed.`;
    }
    out.add({
      object: { kind: 'Namespace', namespace: '', name: ns.metadata.name }, category: 'NamespaceTerminating', severity: 'warning',
      title: `Namespace ${ns.metadata.name} stuck Terminating for ${fmtAge(since)}`,
      rootCause: { summary, confidence: discovery || finalizers ? 'high' : 'medium', derived: !!refs.length },
      evidence: conds.map((c) => `${c.type}: ${truncate(c.message, 300)}`),
      fixes: ['Fix the unavailable APIService or the controller owning the finalizers. Removing finalizers by hand can leave orphaned cloud resources.'],
      refs, commands: [snap.cmd(`get namespace ${ns.metadata.name} -o yaml`)],
    });
  }

  for (const q of snap.list('resourcequotas')) {
    const hard = q.status?.hard || {};
    const used = q.status?.used || {};
    const full = [];
    const near = [];
    for (const [k, v] of Object.entries(hard)) {
      const h = parseQuantity(v);
      const u = parseQuantity(used[k]);
      if (h == null || u == null) continue;
      if (h === 0 ? u > 0 : u >= h) full.push(`${k}: ${used[k]}/${v}`);
      else if (h > 0 && u / h >= 0.9) near.push(`${k}: ${used[k]}/${v} (${Math.round((u / h) * 100)}%)`);
    }
    if (!full.length && !near.length) continue;
    out.add({
      object: { kind: 'ResourceQuota', namespace: q.metadata.namespace ?? '', name: q.metadata.name }, category: 'QuotaExceeded', severity: full.length ? 'warning' : 'info', tags: full.length ? ['QuotaFull'] : ['QuotaNear'],
      title: `ResourceQuota ${q.metadata.name} ${full.length ? 'is exhausted' : 'is almost exhausted'} (${[...full, ...near][0]})`,
      rootCause: { summary: full.length ? `Namespace ${q.metadata.namespace} reached its quota for ${full.map((f) => f.split(':')[0]).join(', ')}: new pods/objects that need more are rejected (FailedCreate), which blocks scale-ups and rollouts.` : 'The namespace is close to its quota; the next scale-up or rollout (surge pods) may be rejected.', confidence: 'high' },
      evidence: [...full.map((f) => `FULL ${f}`), ...near.map((n) => `NEAR ${n}`)],
      fixes: ['Raise the quota, lower requests/limits, or remove unused objects (completed pods, old ReplicaSets, PVCs).', 'Rolling updates need headroom for surge pods.'],
      commands: [snap.cmd(`describe resourcequota -n ${q.metadata.namespace} ${q.metadata.name}`)],
    });
  }
}
