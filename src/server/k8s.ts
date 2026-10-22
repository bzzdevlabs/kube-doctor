// Kubernetes API types used by the analyzers (types only, from `kubernetes-types`).
// Objects coming from `kubectl get` always carry kind and metadata.name, which
// the upstream types leave optional; Obj<> makes that explicit.
import type { ObjectMeta } from 'kubernetes-types/meta/v1.js';
import type {
  Pod, Node, Namespace, Service, Event, PersistentVolumeClaim, PersistentVolume, ServiceAccount, ResourceQuota,
} from 'kubernetes-types/core/v1.js';
import type { Deployment, ReplicaSet, StatefulSet, DaemonSet } from 'kubernetes-types/apps/v1.js';
import type { Job, CronJob } from 'kubernetes-types/batch/v1.js';
import type { Ingress, IngressClass } from 'kubernetes-types/networking/v1.js';
import type { EndpointSlice } from 'kubernetes-types/discovery/v1.js';
import type { StorageClass } from 'kubernetes-types/storage/v1.js';
import type { HorizontalPodAutoscaler } from 'kubernetes-types/autoscaling/v2.js';
import type { PodDisruptionBudget } from 'kubernetes-types/policy/v1.js';
import type { ValidatingWebhookConfiguration, MutatingWebhookConfiguration } from 'kubernetes-types/admissionregistration/v1.js';

export type {
  Container, ContainerStatus, ContainerState, Probe, Toleration, Taint, NodeSelectorRequirement, Volume, EnvVar,
} from 'kubernetes-types/core/v1.js';

export type Meta = ObjectMeta & { name: string };
export type Obj<T> = Omit<T, 'kind' | 'metadata'> & { kind: string; metadata: Meta };

// apiregistration.k8s.io/v1 is not part of kubernetes-types.
export interface APIServiceType {
  spec?: { group?: string; version?: string; service?: { namespace?: string; name?: string } };
  status?: { conditions?: { type: string; status: string; reason?: string; message?: string; lastTransitionTime?: string }[] };
}

export interface KindMap {
  pods: Obj<Pod>;
  nodes: Obj<Node>;
  namespaces: Obj<Namespace>;
  events: Obj<Event>;
  deployments: Obj<Deployment>;
  replicasets: Obj<ReplicaSet>;
  statefulsets: Obj<StatefulSet>;
  daemonsets: Obj<DaemonSet>;
  jobs: Obj<Job>;
  cronjobs: Obj<CronJob>;
  services: Obj<Service>;
  endpointslices: Obj<EndpointSlice>;
  ingresses: Obj<Ingress>;
  ingressclasses: Obj<IngressClass>;
  pvcs: Obj<PersistentVolumeClaim>;
  pvs: Obj<PersistentVolume>;
  storageclasses: Obj<StorageClass>;
  hpas: Obj<HorizontalPodAutoscaler>;
  pdbs: Obj<PodDisruptionBudget>;
  resourcequotas: Obj<ResourceQuota>;
  serviceaccounts: Obj<ServiceAccount>;
  apiservices: Obj<APIServiceType>;
  validatingwebhooks: Obj<ValidatingWebhookConfiguration>;
  mutatingwebhooks: Obj<MutatingWebhookConfiguration>;
}

export type ResourceKey = keyof KindMap;

export interface KindByName {
  Pod: Obj<Pod>;
  Node: Obj<Node>;
  Namespace: Obj<Namespace>;
  Deployment: Obj<Deployment>;
  ReplicaSet: Obj<ReplicaSet>;
  StatefulSet: Obj<StatefulSet>;
  DaemonSet: Obj<DaemonSet>;
  Job: Obj<Job>;
  CronJob: Obj<CronJob>;
  Service: Obj<Service>;
  Ingress: Obj<Ingress>;
  PersistentVolumeClaim: Obj<PersistentVolumeClaim>;
  PersistentVolume: Obj<PersistentVolume>;
  ServiceAccount: Obj<ServiceAccount>;
  ResourceQuota: Obj<ResourceQuota>;
  HorizontalPodAutoscaler: Obj<HorizontalPodAutoscaler>;
  APIService: Obj<APIServiceType>;
}

export type PodObj = KindMap['pods'];
export type NodeObj = KindMap['nodes'];
export type EventObj = KindMap['events'];
export type ServiceObj = KindMap['services'];
/** Any object with metadata (used by generic helpers). */
export type AnyObj = { kind: string; metadata: Meta; status?: unknown; spec?: unknown };
