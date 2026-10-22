// Inventory of pods, workloads and namespaces for the dashboard views,
// each row linked to the ids of the findings that concern it.
import type { Finding, Inventory, NamespaceRow, PodRow, WorkloadRow } from '../../shared/types.js';
import type { KindMap, PodObj } from '../k8s.js';
import type { Snapshot } from './snapshot.js';
import { podResources } from './snapshot.js';
import { objKey, cond, ts } from './util.js';

// Same STATUS column as `kubectl get pods`.
export function podStatusText(pod: PodObj): string {
  if (pod.metadata?.deletionTimestamp) return 'Terminating';
  if (pod.status?.reason) return pod.status.reason;
  const init = pod.status?.initContainerStatuses || [];
  const initSpecs = pod.spec?.initContainers || [];
  for (let i = 0; i < init.length; i++) {
    const cs = init[i]!;
    const sidecar = (initSpecs.find((c) => c.name === cs.name) as { restartPolicy?: string } | undefined)?.restartPolicy === 'Always';
    if (cs.state?.terminated && cs.state.terminated.exitCode === 0) continue;
    if (sidecar && cs.started) continue;
    if (cs.state?.terminated) return `Init:${cs.state.terminated.reason || `ExitCode:${cs.state.terminated.exitCode}`}`;
    if (cs.state?.waiting?.reason && cs.state.waiting.reason !== 'PodInitializing') return `Init:${cs.state.waiting.reason}`;
    return `Init:${i}/${initSpecs.length}`;
  }
  let status = pod.status?.phase || 'Unknown';
  for (const cs of [...(pod.status?.containerStatuses || [])].reverse()) {
    if (cs.state?.waiting?.reason) status = cs.state.waiting.reason;
    else if (cs.state?.terminated) status = cs.state.terminated.reason || (cs.state.terminated.signal ? `Signal:${cs.state.terminated.signal}` : `ExitCode:${cs.state.terminated.exitCode}`);
  }
  if (status === 'Running' && cond(pod, 'Ready')?.status !== 'True') return 'Running (not ready)';
  return status;
}

type WorkloadKind = WorkloadRow['kind'];
type WorkloadObj = KindMap['deployments'] | KindMap['statefulsets'] | KindMap['daemonsets'] | KindMap['jobs'] | KindMap['cronjobs'];

interface Replicas {
  desired: number | null;
  ready: number;
  updated: number | null;
}

function replicas(kind: WorkloadKind, w: WorkloadObj): Replicas {
  switch (kind) {
    case 'Deployment': {
      const d = w as KindMap['deployments'];
      return { desired: d.spec?.replicas ?? 1, ready: d.status?.availableReplicas || 0, updated: d.status?.updatedReplicas || 0 };
    }
    case 'StatefulSet': {
      const s = w as KindMap['statefulsets'];
      return { desired: s.spec?.replicas ?? 1, ready: s.status?.readyReplicas || 0, updated: s.status?.updatedReplicas ?? null };
    }
    case 'DaemonSet': {
      const d = w as KindMap['daemonsets'];
      return { desired: d.status?.desiredNumberScheduled || 0, ready: d.status?.numberAvailable ?? d.status?.numberReady ?? 0, updated: d.status?.updatedNumberScheduled ?? null };
    }
    case 'Job': {
      const j = w as KindMap['jobs'];
      return { desired: j.spec?.completions ?? 1, ready: j.status?.succeeded || 0, updated: null };
    }
    default:
      return { desired: null, ready: ((w as KindMap['cronjobs']).status?.active || []).length, updated: null };
  }
}

function workloadStatus(kind: WorkloadKind, w: WorkloadObj): string {
  if (kind === 'CronJob') {
    const c = w as KindMap['cronjobs'];
    return c.spec?.suspend ? 'Suspended' : (c.status?.active || []).length ? 'Running' : 'Scheduled';
  }
  if (kind === 'Job') {
    const j = w as KindMap['jobs'];
    if (cond(j, 'Complete')?.status === 'True') return 'Complete';
    if (cond(j, 'Failed')?.status === 'True') return 'Failed';
    if (j.spec?.suspend) return 'Suspended';
    return 'Running';
  }
  const { desired, ready, updated } = replicas(kind, w);
  if (desired === 0) return 'Scaled to 0';
  if (kind === 'Deployment' && cond(w as KindMap['deployments'], 'Progressing')?.reason === 'ProgressDeadlineExceeded') return 'Rollout stuck';
  if (ready === 0) return 'Down';
  if (desired != null && ready < desired) return 'Degraded';
  if (desired != null && updated != null && updated < desired) return 'Rolling out';
  return 'Healthy';
}

function templateOf(kind: WorkloadKind, w: WorkloadObj) {
  return kind === 'CronJob' ? (w as KindMap['cronjobs']).spec?.jobTemplate?.spec?.template : (w as Exclude<WorkloadObj, KindMap['cronjobs']>).spec?.template;
}

const WORKLOAD_LISTS: [keyof KindMap, WorkloadKind][] = [['deployments', 'Deployment'], ['statefulsets', 'StatefulSet'], ['daemonsets', 'DaemonSet'], ['cronjobs', 'CronJob'], ['jobs', 'Job']];

export function buildInventory(snap: Snapshot, findings: Finding[]): Inventory {
  const problems = new Map<string, Set<string>>();
  const add = (k: string, id: string) => {
    const set = problems.get(k);
    if (set) set.add(id);
    else problems.set(k, new Set([id]));
  };
  for (const f of findings) {
    add(objKey(f.object.kind, f.object.namespace, f.object.name), f.id);
    for (const i of f.instances || []) add(objKey('Pod', i.namespace, i.pod), f.id);
    if (f.owner) add(objKey(f.owner.kind, f.owner.namespace, f.owner.name), f.id);
  }
  const ids = (kind: string, ns: string, name: string) => [...(problems.get(objKey(kind, ns, name)) || [])];

  const pods: PodRow[] = snap.list('pods').map((p) => {
    const ns = p.metadata.namespace ?? '';
    const name = p.metadata.name;
    const statuses = p.status?.containerStatuses || [];
    const top = snap.topOwner(p);
    let cpu: number | null = null;
    let memory: number | null = null;
    for (const c of p.spec?.containers || []) {
      const u = snap.containerUsage(ns, name, c.name);
      if (u) {
        cpu = (cpu || 0) + (u.cpu || 0);
        memory = (memory || 0) + (u.memory || 0);
      }
    }
    const lastRestart = Math.max(0, ...statuses.map((s) => ts(s.lastState?.terminated?.finishedAt) || 0));
    const r = podResources(p);
    return {
      namespace: ns, name, phase: p.status?.phase || 'Unknown', status: podStatusText(p),
      ready: `${statuses.filter((s) => s.ready).length}/${(p.spec?.containers || []).length}`,
      restarts: statuses.reduce((a, s) => a + (s.restartCount || 0), 0),
      lastRestart: lastRestart || null,
      node: p.spec?.nodeName || null, ip: p.status?.podIP || null, qos: p.status?.qosClass || null,
      created: p.metadata.creationTimestamp ?? '', owner: top ? { kind: top.kind, name: top.name } : null,
      cpu, memory, reqCpu: r.reqCpu, reqMemory: r.reqMemory, limMemory: r.limMemory,
      images: (p.spec?.containers || []).map((c) => c.image ?? ''),
      problems: ids('Pod', ns, name),
    };
  });

  const workloads: WorkloadRow[] = [];
  for (const [key, kind] of WORKLOAD_LISTS) {
    for (const w of snap.list(key) as WorkloadObj[]) {
      const ns = w.metadata.namespace ?? '';
      const name = w.metadata.name;
      if (kind === 'Job' && (w.metadata.ownerReferences || []).some((o) => o.kind === 'CronJob')) continue;
      const r = replicas(kind, w);
      const tpl = templateOf(kind, w);
      const cron = kind === 'CronJob' ? (w as KindMap['cronjobs']) : null;
      const conditions = ((w.status as { conditions?: { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }[] } | undefined)?.conditions || []);
      workloads.push({
        kind, namespace: ns, name, status: workloadStatus(kind, w),
        desired: r.desired, ready: r.ready, updated: r.updated,
        images: [...new Set((tpl?.spec?.containers || []).map((c) => c.image ?? ''))],
        created: w.metadata.creationTimestamp ?? '',
        schedule: cron?.spec?.schedule || null,
        lastSchedule: cron?.status?.lastScheduleTime || null,
        lastSuccess: cron?.status?.lastSuccessfulTime || null,
        conditions: conditions.map((c) => ({ type: c.type, status: c.status, reason: c.reason, message: c.message, since: c.lastTransitionTime })),
        pods: snap.podsOf(kind, ns, name).map((p) => p.metadata.name),
        problems: ids(kind, ns, name),
      });
    }
  }

  const nsNames = new Set([...snap.list('namespaces').map((n) => n.metadata.name), ...pods.map((p) => p.namespace)]);
  const namespaces: NamespaceRow[] = [...nsNames].sort().map((name) => {
    const nsObj = snap.get('Namespace', '', name);
    const nsPods = pods.filter((p) => p.namespace === name);
    const phase = (ph: string) => nsPods.filter((x) => x.phase === ph).length;
    const nsFindings = findings.filter((f) => f.object.namespace === name || (f.instances || []).some((i) => i.namespace === name));
    return {
      name, phase: nsObj?.status?.phase || 'Active', created: nsObj?.metadata?.creationTimestamp || null,
      pods: { total: nsPods.length, running: phase('Running'), pending: phase('Pending'), failed: phase('Failed'), succeeded: phase('Succeeded') },
      restarts: nsPods.reduce((a, p) => a + p.restarts, 0),
      workloads: workloads.filter((w) => w.namespace === name).length,
      problems: nsFindings.map((f) => f.id),
    };
  });

  return { pods, workloads, namespaces };
}
