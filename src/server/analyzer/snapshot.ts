// Indexed, read-only view over a collected cluster snapshot.
import type { NodeAllocation, NodeUsage, ObjRef } from '../../shared/types.js';
import type { OwnerReference } from 'kubernetes-types/meta/v1.js';
import type { Collected, CollectedData, CollectedInfo, PodMetric } from '../types.js';
import type { AnyObj, EventObj, KindByName, KindMap, PodObj, ResourceKey } from '../k8s.js';
import { objKey, eventTime, parseQuantity } from './util.js';

const KINDS: Record<ResourceKey, string> = {
  pods: 'Pod', nodes: 'Node', namespaces: 'Namespace', deployments: 'Deployment', replicasets: 'ReplicaSet',
  statefulsets: 'StatefulSet', daemonsets: 'DaemonSet', jobs: 'Job', cronjobs: 'CronJob', services: 'Service',
  endpointslices: 'EndpointSlice', ingresses: 'Ingress', ingressclasses: 'IngressClass', pvcs: 'PersistentVolumeClaim',
  pvs: 'PersistentVolume', storageclasses: 'StorageClass', hpas: 'HorizontalPodAutoscaler', pdbs: 'PodDisruptionBudget',
  resourcequotas: 'ResourceQuota', serviceaccounts: 'ServiceAccount', apiservices: 'APIService',
  validatingwebhooks: 'ValidatingWebhookConfiguration', mutatingwebhooks: 'MutatingWebhookConfiguration', events: 'Event',
};

export interface PodResources {
  reqCpu: number;
  reqMemory: number;
  limCpu: number;
  limMemory: number;
}

export class Snapshot {
  readonly collected: Collected;
  readonly data: CollectedData;
  readonly info: CollectedInfo;
  readonly now = Date.now();
  readonly cmdContext: string | null;
  readonly podUsage = new Map<string, PodMetric>();
  readonly nodeUsage = new Map<string, NodeUsage>();
  readonly podsByNode = new Map<string, PodObj[]>();
  private readonly index = new Map<string, AnyObj>();
  private readonly children = new Map<string, AnyObj[]>();
  private readonly events = new Map<string, EventObj[]>();

  constructor(collected: Collected, { cmdContext = null }: { cmdContext?: string | null } = {}) {
    this.collected = collected;
    this.data = collected.data || {};
    this.info = collected.info;
    this.cmdContext = cmdContext;

    for (const [key, kind] of Object.entries(KINDS) as [ResourceKey, string][]) {
      for (const o of this.list(key) as AnyObj[]) {
        o.kind = kind;
        if (key !== 'events') this.index.set(objKey(kind, o.metadata?.namespace, o.metadata?.name), o);
      }
    }
    for (const key of ['pods', 'replicasets', 'jobs'] as const) {
      for (const o of this.list(key)) {
        const ctrl = controllerRef(o);
        if (!ctrl) continue;
        push(this.children, objKey(ctrl.kind, o.metadata.namespace, ctrl.name), o as AnyObj);
      }
    }

    for (const ev of this.list('events')) {
      const io = ev.involvedObject || {};
      push(this.events, objKey(io.kind, io.namespace, io.name), ev);
    }
    for (const list of this.events.values()) list.sort((a, b) => eventTime(b) - eventTime(a));

    for (const m of collected.metrics?.pods?.items || []) this.podUsage.set(`${m.namespace}/${m.pod}/${m.container}`, m);
    for (const m of collected.metrics?.nodes?.items || []) this.nodeUsage.set(m.name, m);

    for (const p of this.list('pods')) {
      const n = p.spec?.nodeName;
      if (n) push(this.podsByNode, n, p);
    }
  }

  list<K extends ResourceKey>(key: K): KindMap[K][] {
    return (this.data[key] || []) as KindMap[K][];
  }

  get<K extends keyof KindByName>(kind: K, namespace: string | null | undefined, name: string | null | undefined): KindByName[K] | undefined;
  get(kind: string, namespace: string | null | undefined, name: string | null | undefined): AnyObj | undefined;
  get(kind: string, namespace: string | null | undefined, name: string | null | undefined): AnyObj | undefined {
    return this.index.get(objKey(kind, namespace, name ?? undefined));
  }

  has(key: string): boolean {
    return (this.collected.coverage || []).some((c) => c.key === key && (c.status === 'ok' || c.status === 'partial'));
  }

  eventsFor(kind: string, namespace: string | null | undefined, name: string): EventObj[] {
    return this.events.get(objKey(kind, namespace, name)) || [];
  }

  // Walks ownerReferences up to the top-level controller (Pod -> ReplicaSet -> Deployment, Pod -> Job -> CronJob).
  ownerChain(obj: AnyObj): ObjRef[] {
    const chain: ObjRef[] = [];
    let cur: AnyObj | undefined = obj;
    for (let i = 0; i < 5 && cur; i++) {
      const ctrl = controllerRef(cur);
      if (!ctrl) break;
      const ns: string = cur.metadata?.namespace || '';
      chain.push({ kind: ctrl.kind, namespace: ns, name: ctrl.name });
      cur = this.get(ctrl.kind, ns, ctrl.name);
    }
    return chain;
  }

  topOwner(obj: AnyObj): ObjRef | null {
    const chain = this.ownerChain(obj);
    return chain.length ? chain[chain.length - 1]! : null;
  }

  childrenOf(kind: string, namespace: string, name: string): AnyObj[] {
    return this.children.get(objKey(kind, namespace, name)) || [];
  }

  // Pods belonging to a workload, following Deployment -> ReplicaSet and CronJob -> Job.
  podsOf(kind: string, namespace: string, name: string): PodObj[] {
    let list: AnyObj[];
    if (kind === 'Deployment') list = this.childrenOf(kind, namespace, name).flatMap((rs) => this.childrenOf('ReplicaSet', namespace, rs.metadata.name));
    else if (kind === 'CronJob') list = this.childrenOf(kind, namespace, name).flatMap((j) => this.childrenOf('Job', namespace, j.metadata.name));
    else list = this.childrenOf(kind, namespace, name);
    return list.filter((o) => o.kind === 'Pod') as PodObj[];
  }

  containerUsage(namespace: string, pod: string, container: string): PodMetric | null {
    return this.podUsage.get(`${namespace}/${pod}/${container}`) || null;
  }

  // Requested/allocatable resources on a node, from the pods we can see.
  nodeAllocation(nodeName: string): NodeAllocation {
    const node = this.get('Node', '', nodeName);
    const alloc = node?.status?.allocatable || {};
    const pods = (this.podsByNode.get(nodeName) || []).filter((p) => !['Succeeded', 'Failed'].includes(p.status?.phase ?? ''));
    const out: NodeAllocation = {
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

  cmd(s: string): string {
    const c = this.cmdContext;
    return `kubectl ${s}${c ? ` --context ${/^[\w@%+=:,./-]+$/.test(c) ? c : `'${c.replace(/'/g, `'\\''`)}'`}` : ''}`;
  }
}

function push<V>(map: Map<string, V[]>, key: string, v: V): void {
  const list = map.get(key);
  if (list) list.push(v);
  else map.set(key, [v]);
}

export function controllerRef(obj: AnyObj | null | undefined): OwnerReference | null {
  const refs = obj?.metadata?.ownerReferences || [];
  return refs.find((r) => r.controller) || refs[0] || null;
}

interface ContainerSpecLike {
  restartPolicy?: string;
  resources?: { requests?: { [res: string]: string }; limits?: { [res: string]: string } };
}

// Effective pod requests/limits (max of init containers vs. sum of app containers + sidecars).
export function podResources(pod: PodObj): PodResources {
  const app: ContainerSpecLike[] = pod.spec?.containers || [];
  const init: ContainerSpecLike[] = pod.spec?.initContainers || [];
  const sidecars = init.filter((c) => c.restartPolicy === 'Always');
  const q = (c: ContainerSpecLike, kind: 'requests' | 'limits', res: string) => parseQuantity(c.resources?.[kind]?.[res]) || 0;
  const eff = (kind: 'requests' | 'limits', res: string) => {
    const sum = [...app, ...sidecars].reduce((a, c) => a + q(c, kind, res), 0);
    const maxInit = Math.max(0, ...init.filter((c) => c.restartPolicy !== 'Always').map((c) => q(c, kind, res)));
    return Math.max(sum, maxInit) + (parseQuantity(pod.spec?.overhead?.[res]) || 0);
  };
  return { reqCpu: eff('requests', 'cpu'), reqMemory: eff('requests', 'memory'), limCpu: eff('limits', 'cpu'), limMemory: eff('limits', 'memory') };
}
