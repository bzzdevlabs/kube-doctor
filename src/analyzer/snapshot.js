// Indexed, read-only view over a collected cluster snapshot.
import { objKey, eventTime, parseQuantity } from './util.js';

const KINDS = {
  pods: 'Pod', nodes: 'Node', namespaces: 'Namespace', deployments: 'Deployment', replicasets: 'ReplicaSet',
  statefulsets: 'StatefulSet', daemonsets: 'DaemonSet', jobs: 'Job', cronjobs: 'CronJob', services: 'Service',
  endpointslices: 'EndpointSlice', ingresses: 'Ingress', ingressclasses: 'IngressClass', pvcs: 'PersistentVolumeClaim',
  pvs: 'PersistentVolume', storageclasses: 'StorageClass', hpas: 'HorizontalPodAutoscaler', pdbs: 'PodDisruptionBudget',
  resourcequotas: 'ResourceQuota', serviceaccounts: 'ServiceAccount', apiservices: 'APIService',
  validatingwebhooks: 'ValidatingWebhookConfiguration', mutatingwebhooks: 'MutatingWebhookConfiguration',
};

export class Snapshot {
  constructor(collected, { cmdContext = null } = {}) {
    this.collected = collected;
    this.data = collected.data || {};
    this.info = collected.info || {};
    this.now = Date.now();
    this.cmdContext = cmdContext;
    this.index = new Map();
    this.byUid = new Map();
    this.children = new Map();

    for (const [key, kind] of Object.entries(KINDS)) {
      for (const o of this.list(key)) {
        o.kind = kind;
        this.index.set(objKey(kind, o.metadata?.namespace, o.metadata?.name), o);
        if (o.metadata?.uid) this.byUid.set(o.metadata.uid, o);
      }
    }
    for (const key of ['pods', 'replicasets', 'jobs']) {
      for (const o of this.list(key)) {
        const ctrl = controllerRef(o);
        if (!ctrl) continue;
        const k = objKey(ctrl.kind, o.metadata.namespace, ctrl.name);
        if (!this.children.has(k)) this.children.set(k, []);
        this.children.get(k).push(o);
      }
    }

    this.events = new Map();
    for (const ev of this.list('events')) {
      const io = ev.involvedObject || {};
      const k = objKey(io.kind, io.namespace, io.name);
      if (!this.events.has(k)) this.events.set(k, []);
      this.events.get(k).push(ev);
    }
    for (const list of this.events.values()) list.sort((a, b) => eventTime(b) - eventTime(a));

    this.podUsage = new Map();
    for (const m of collected.metrics?.pods?.items || []) this.podUsage.set(`${m.namespace}/${m.pod}/${m.container}`, m);
    this.nodeUsage = new Map();
    for (const m of collected.metrics?.nodes?.items || []) this.nodeUsage.set(m.name, m);

    this.podsByNode = new Map();
    for (const p of this.list('pods')) {
      const n = p.spec?.nodeName;
      if (!n) continue;
      if (!this.podsByNode.has(n)) this.podsByNode.set(n, []);
      this.podsByNode.get(n).push(p);
    }
  }

  list(key) {
    return this.data[key] || [];
  }

  get(kind, namespace, name) {
    return this.index.get(objKey(kind, namespace, name));
  }

  has(key) {
    return (this.collected.coverage || []).some((c) => c.key === key && (c.status === 'ok' || c.status === 'partial'));
  }

  eventsFor(kind, namespace, name) {
    return this.events.get(objKey(kind, namespace, name)) || [];
  }

  // Walks ownerReferences up to the top-level controller (Pod -> ReplicaSet -> Deployment, Pod -> Job -> CronJob).
  ownerChain(obj) {
    const chain = [];
    let cur = obj;
    for (let i = 0; i < 5; i++) {
      const ctrl = controllerRef(cur);
      if (!ctrl) break;
      const ns = cur.metadata?.namespace || '';
      const ref = { kind: ctrl.kind, namespace: ns, name: ctrl.name };
      chain.push(ref);
      cur = this.get(ctrl.kind, ns, ctrl.name);
      if (!cur) break;
    }
    return chain;
  }

  topOwner(obj) {
    const chain = this.ownerChain(obj);
    return chain.length ? chain[chain.length - 1] : null;
  }

  childrenOf(kind, namespace, name) {
    return this.children.get(objKey(kind, namespace, name)) || [];
  }

  // Pods belonging to a workload, following Deployment -> ReplicaSet and CronJob -> Job.
  podsOf(kind, namespace, name) {
    if (kind === 'Deployment') return this.childrenOf(kind, namespace, name).flatMap((rs) => this.childrenOf('ReplicaSet', namespace, rs.metadata.name));
    if (kind === 'CronJob') return this.childrenOf(kind, namespace, name).flatMap((j) => this.childrenOf('Job', namespace, j.metadata.name));
    return this.childrenOf(kind, namespace, name).filter((o) => o.kind === 'Pod');
  }

  containerUsage(namespace, pod, container) {
    return this.podUsage.get(`${namespace}/${pod}/${container}`) || null;
  }

  // Requested/allocatable resources on a node, from the pods we can see.
  nodeAllocation(nodeName) {
    const node = this.get('Node', '', nodeName);
    const alloc = node?.status?.allocatable || {};
    const pods = (this.podsByNode.get(nodeName) || []).filter((p) => !['Succeeded', 'Failed'].includes(p.status?.phase));
    const out = {
      cpu: parseQuantity(alloc.cpu), memory: parseQuantity(alloc.memory), maxPods: parseQuantity(alloc.pods),
      reqCpu: 0, reqMemory: 0, limCpu: 0, limMemory: 0, pods: pods.length,
      partial: !!this.info.scannedNamespace || !this.has('pods'),
    };
    for (const p of pods) {
      const r = podResources(p);
      out.reqCpu += r.reqCpu;
      out.reqMemory += r.reqMemory;
      out.limCpu += r.limCpu;
      out.limMemory += r.limMemory;
    }
    return out;
  }

  cmd(s) {
    return `kubectl ${s}${this.cmdContext ? ` --context ${/^[\w@%+=:,./-]+$/.test(this.cmdContext) ? this.cmdContext : `'${this.cmdContext.replace(/'/g, `'\\''`)}'`}` : ''}`;
  }
}

export function controllerRef(obj) {
  const refs = obj?.metadata?.ownerReferences || [];
  return refs.find((r) => r.controller) || refs[0] || null;
}

// Effective pod requests/limits (max of init containers vs. sum of app containers + sidecars).
export function podResources(pod) {
  const app = pod.spec?.containers || [];
  const init = pod.spec?.initContainers || [];
  const sidecars = init.filter((c) => c.restartPolicy === 'Always');
  const q = (c, kind, res) => parseQuantity(c.resources?.[kind]?.[res]) || 0;
  const eff = (kind, res) => {
    const sum = [...app, ...sidecars].reduce((a, c) => a + q(c, kind, res), 0);
    const maxInit = Math.max(0, ...init.filter((c) => c.restartPolicy !== 'Always').map((c) => q(c, kind, res)));
    return Math.max(sum, maxInit) + (parseQuantity(pod.spec?.overhead?.[res]) || 0);
  };
  return { reqCpu: eff('requests', 'cpu'), reqMemory: eff('requests', 'memory'), limCpu: eff('limits', 'cpu'), limMemory: eff('limits', 'memory') };
}

export function qosClass(pod) {
  return pod.status?.qosClass || null;
}
