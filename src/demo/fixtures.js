// A simulated cluster with many interlinked failures, used by `npm run demo`
// and by the tests. Timestamps are relative to "now" so the scenario stays fresh.

const NOW = () => Date.now();
const ago = (min) => new Date(NOW() - min * 60_000).toISOString();
let uidSeq = 0;
const uid = () => `00000000-0000-4000-8000-${String(++uidSeq).padStart(12, '0')}`;

function meta(name, namespace, extra = {}) {
  return { name, ...(namespace ? { namespace } : {}), uid: uid(), creationTimestamp: ago(extra.age ?? 600), labels: extra.labels || {}, annotations: extra.annotations || {}, ...(extra.owner ? { ownerReferences: [{ apiVersion: 'apps/v1', kind: extra.owner.kind, name: extra.owner.name, uid: uid(), controller: true }] } : {}), ...(extra.deletionTimestamp ? { deletionTimestamp: extra.deletionTimestamp, deletionGracePeriodSeconds: 30 } : {}), ...(extra.finalizers ? { finalizers: extra.finalizers } : {}) };
}

function node(name, { ready = 'True', reason = 'KubeletReady', message = 'kubelet is posting ready status', cpu = '4', memory = '16Gi', roles = ['worker'], pressure = {}, unschedulable = false, taints = [], zone = 'eu-west-1a', heartbeat = 0 } = {}) {
  const labels = { 'kubernetes.io/hostname': name, 'kubernetes.io/arch': 'amd64', 'topology.kubernetes.io/zone': zone, 'node.kubernetes.io/instance-type': 'm6i.xlarge' };
  for (const r of roles) labels[`node-role.kubernetes.io/${r}`] = '';
  const c = (type, status, r = '', m = '') => ({ type, status, reason: r, message: m, lastHeartbeatTime: ago(heartbeat), lastTransitionTime: ago(status === 'True' && type === 'Ready' ? 4000 : 40) });
  return {
    kind: 'Node',
    metadata: meta(name, null, { age: 20000, labels }),
    spec: { ...(unschedulable ? { unschedulable: true } : {}), taints },
    status: {
      allocatable: { cpu, memory, pods: '110', 'ephemeral-storage': '95Gi' },
      capacity: { cpu, memory, pods: '110' },
      conditions: [
        c('MemoryPressure', pressure.MemoryPressure ? 'True' : 'False', pressure.MemoryPressure ? 'KubeletHasInsufficientMemory' : 'KubeletHasSufficientMemory', pressure.MemoryPressure ? 'kubelet has insufficient memory available' : ''),
        c('DiskPressure', pressure.DiskPressure ? 'True' : 'False', pressure.DiskPressure ? 'KubeletHasDiskPressure' : 'KubeletHasNoDiskPressure', pressure.DiskPressure ? 'kubelet has disk pressure' : ''),
        c('PIDPressure', 'False', 'KubeletHasSufficientPID'),
        c('Ready', ready, reason, message),
      ],
      nodeInfo: { architecture: 'amd64', kubeletVersion: 'v1.30.4', osImage: 'Ubuntu 22.04.4 LTS', containerRuntimeVersion: 'containerd://1.7.20' },
    },
  };
}

function container(name, image, { resources = {}, ports = [], env = [], command, args, liveness, readiness, startup, volumeMounts } = {}) {
  return { name, image, resources, ports, env, ...(command ? { command } : {}), ...(args ? { args } : {}), ...(liveness ? { livenessProbe: liveness } : {}), ...(readiness ? { readinessProbe: readiness } : {}), ...(startup ? { startupProbe: startup } : {}), ...(volumeMounts ? { volumeMounts } : {}) };
}

const running = (min) => ({ running: { startedAt: ago(min) } });
const waiting = (reason, message) => ({ waiting: { reason, message } });
const terminated = (reason, exitCode, startMin, endMin, extra = {}) => ({ terminated: { reason, exitCode, startedAt: ago(startMin), finishedAt: ago(endMin), containerID: 'containerd://x', ...extra } });

function pod(ns, name, { owner, nodeName, labels = {}, containers = [], initContainers = [], statuses = [], initStatuses = [], phase = 'Running', ready = true, age = 300, conditions, reason, message, volumes = [], nodeSelector, qos = 'Burstable', restartPolicy = 'Always', deletionTimestamp, finalizers, serviceAccountName = 'default', podIP } = {}) {
  return {
    kind: 'Pod',
    metadata: meta(name, ns, { age, labels, owner, deletionTimestamp, finalizers }),
    spec: { nodeName, containers, initContainers, volumes, restartPolicy, serviceAccountName, ...(nodeSelector ? { nodeSelector } : {}) },
    status: {
      phase, qosClass: qos, startTime: ago(age), podIP: podIP || (nodeName ? `10.244.${(name.length * 7) % 250}.${(name.charCodeAt(0) * 3) % 250}` : undefined),
      ...(reason ? { reason } : {}), ...(message ? { message } : {}),
      conditions: conditions || [
        { type: 'PodScheduled', status: nodeName ? 'True' : 'False', lastTransitionTime: ago(age) },
        { type: 'Initialized', status: 'True', lastTransitionTime: ago(age) },
        { type: 'ContainersReady', status: ready ? 'True' : 'False', lastTransitionTime: ago(ready ? age - 1 : Math.min(age, 45)) },
        { type: 'Ready', status: ready ? 'True' : 'False', lastTransitionTime: ago(ready ? age - 1 : Math.min(age, 45)) },
      ],
      containerStatuses: statuses,
      ...(initStatuses.length ? { initContainerStatuses: initStatuses } : {}),
    },
  };
}

function status(name, image, { state, lastState = {}, ready = true, restartCount = 0 } = {}) {
  return { name, image, imageID: `${image}@sha256:abc`, ready, started: !!state?.running, restartCount, state, lastState };
}

function deployment(ns, name, { replicas = 1, available = replicas, updated = replicas, labels, progressing = ['True', 'NewReplicaSetAvailable', 'ReplicaSet has successfully progressed.'] } = {}) {
  const l = labels || { app: name };
  return {
    kind: 'Deployment',
    metadata: meta(name, ns, { age: 5000, labels: l }),
    spec: { replicas, selector: { matchLabels: l }, template: { metadata: { labels: l } }, progressDeadlineSeconds: 600 },
    status: {
      replicas, updatedReplicas: updated, readyReplicas: available, availableReplicas: available, unavailableReplicas: Math.max(0, replicas - available),
      conditions: [
        { type: 'Available', status: available >= replicas ? 'True' : 'False', reason: available >= replicas ? 'MinimumReplicasAvailable' : 'MinimumReplicasUnavailable', message: 'Deployment does not have minimum availability.', lastUpdateTime: ago(30), lastTransitionTime: ago(30) },
        { type: 'Progressing', status: progressing[0], reason: progressing[1], message: progressing[2], lastUpdateTime: ago(20), lastTransitionTime: ago(20) },
      ],
    },
  };
}

function replicaset(ns, name, deploy, { replicas = 1, labels, failure } = {}) {
  return {
    kind: 'ReplicaSet',
    metadata: meta(name, ns, { age: 3000, labels: labels || { app: deploy }, owner: { kind: 'Deployment', name: deploy } }),
    spec: { replicas, selector: { matchLabels: labels || { app: deploy } } },
    status: { replicas, ...(failure ? { conditions: [{ type: 'ReplicaFailure', status: 'True', reason: 'FailedCreate', message: failure, lastTransitionTime: ago(15) }] } : {}) },
  };
}

function service(ns, name, selector, ports, { type = 'ClusterIP', clusterIP } = {}) {
  return { kind: 'Service', metadata: meta(name, ns, { age: 5000 }), spec: { type, selector, ports, clusterIP: clusterIP || `10.96.${name.length * 3}.${name.charCodeAt(0)}` }, status: { loadBalancer: {} } };
}

function event(ns, kind, name, reason, message, { type = 'Warning', count = 1, firstMin = 30, lastMin = 1, fieldPath, component = 'kubelet' } = {}) {
  return {
    kind: 'Event',
    metadata: { name: `${name}.${reason}.${uid().slice(-6)}`, namespace: ns || 'default', creationTimestamp: ago(firstMin) },
    involvedObject: { kind, namespace: ns || undefined, name, ...(fieldPath ? { fieldPath } : {}) },
    reason, message, type, count, firstTimestamp: ago(firstMin), lastTimestamp: ago(lastMin), source: { component },
  };
}

const lim = (cpuReq, memReq, cpuLim, memLim) => ({ requests: { cpu: cpuReq, memory: memReq }, limits: { ...(cpuLim ? { cpu: cpuLim } : {}), ...(memLim ? { memory: memLim } : {}) } });

export function buildDemoCluster() {
  uidSeq = 0;
  const d = {
    nodes: [], namespaces: [], pvs: [], storageclasses: [], ingressclasses: [], apiservices: [], validatingwebhooks: [], mutatingwebhooks: [],
    pods: [], events: [], deployments: [], replicasets: [], statefulsets: [], daemonsets: [], jobs: [], cronjobs: [], services: [], endpointslices: [],
    ingresses: [], pvcs: [], hpas: [], pdbs: [], resourcequotas: [], serviceaccounts: [],
  };
  const logs = {};
  const top = { nodes: [], pods: [] };

  // ------------------------------------------------------------------ nodes
  d.nodes.push(
    node('cp-1', { roles: ['control-plane'], taints: [{ key: 'node-role.kubernetes.io/control-plane', effect: 'NoSchedule' }] }),
    node('worker-a'),
    node('worker-b', { pressure: { DiskPressure: true }, taints: [{ key: 'node.kubernetes.io/disk-pressure', effect: 'NoSchedule' }] }),
    node('worker-c', { ready: 'Unknown', reason: 'NodeStatusUnknown', message: 'Kubelet stopped posting node status.', heartbeat: 22, taints: [{ key: 'node.kubernetes.io/unreachable', effect: 'NoExecute' }, { key: 'node.kubernetes.io/unreachable', effect: 'NoSchedule' }] }),
    node('worker-d', { unschedulable: true, taints: [{ key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' }] }),
  );
  top.nodes.push(
    { name: 'cp-1', cpu: '310m', cpuPct: 8, memory: '2900Mi', memoryPct: 18 },
    { name: 'worker-a', cpu: '2900m', cpuPct: 72, memory: '14900Mi', memoryPct: 93 },
    { name: 'worker-b', cpu: '1200m', cpuPct: 30, memory: '8100Mi', memoryPct: 51 },
    { name: 'worker-d', cpu: '150m', cpuPct: 4, memory: '1100Mi', memoryPct: 7 },
  );
  d.events.push(
    event(null, 'Node', 'worker-a', 'SystemOOM', 'System OOM encountered, victim process: python3, pid: 48211', { count: 3, firstMin: 50, lastMin: 6 }),
    event(null, 'Node', 'worker-b', 'FreeDiskSpaceFailed', 'Failed to garbage collect required amount of images. Attempted to free 4123456789 bytes, but only found 0 bytes eligible to free.', { count: 12, firstMin: 90, lastMin: 3 }),
    event(null, 'Node', 'worker-c', 'NodeNotReady', 'Node worker-c status is now: NodeNotReady', { type: 'Normal', count: 1, firstMin: 22, lastMin: 22, component: 'node-controller' }),
  );

  for (const n of ['default', 'kube-system', 'shop', 'payments', 'data', 'monitoring', 'policy', 'batch', 'ingress-nginx', 'legacy']) {
    d.namespaces.push({ kind: 'Namespace', metadata: meta(n, null, { age: 20000 }), status: { phase: 'Active' } });
  }
  const legacy = d.namespaces.find((n) => n.metadata.name === 'legacy');
  legacy.metadata.deletionTimestamp = ago(95);
  legacy.spec = { finalizers: ['kubernetes'] };
  legacy.status = { phase: 'Terminating', conditions: [{ type: 'NamespaceDeletionDiscoveryFailure', status: 'True', reason: 'DiscoveryFailed', message: 'Discovery failed for some groups, 1 failing: unable to retrieve the complete list of server APIs: custom.metrics.k8s.io/v1beta1: stale GroupVersion discovery: custom.metrics.k8s.io/v1beta1', lastTransitionTime: ago(94) }] };

  d.storageclasses.push({ kind: 'StorageClass', metadata: meta('gp3', null, { age: 20000, annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }), provisioner: 'ebs.csi.aws.com', volumeBindingMode: 'WaitForFirstConsumer' });
  d.ingressclasses.push({ kind: 'IngressClass', metadata: meta('nginx', null, { age: 20000, annotations: { 'ingressclass.kubernetes.io/is-default-class': 'true' } }), spec: { controller: 'k8s.io/ingress-nginx' } });

  // ------------------------------------------------------- healthy system pods
  const healthy = (ns, name, ownerKind, ownerName, nodeName, labels, image, extra = {}) => {
    d.pods.push(pod(ns, name, { owner: { kind: ownerKind, name: ownerName }, nodeName, labels, containers: [container(name.split('-')[0], image, { resources: lim('100m', '128Mi', null, '256Mi'), ports: extra.ports || [] })], statuses: [status(name.split('-')[0], image, { state: running(3000) })], age: 3000 }));
    top.pods.push({ namespace: ns, pod: name, container: name.split('-')[0], cpu: '12m', memory: '61Mi' });
  };
  d.deployments.push(deployment('kube-system', 'coredns', { replicas: 2, labels: { 'k8s-app': 'kube-dns' } }));
  d.replicasets.push(replicaset('kube-system', 'coredns-5d78c9869d', 'coredns', { replicas: 2, labels: { 'k8s-app': 'kube-dns' } }));
  healthy('kube-system', 'coredns-5d78c9869d-x2b7k', 'ReplicaSet', 'coredns-5d78c9869d', 'worker-a', { 'k8s-app': 'kube-dns' }, 'registry.k8s.io/coredns/coredns:v1.11.1', { ports: [{ name: 'dns', containerPort: 53, protocol: 'UDP' }] });
  healthy('kube-system', 'coredns-5d78c9869d-q9m4z', 'ReplicaSet', 'coredns-5d78c9869d', 'worker-d', { 'k8s-app': 'kube-dns' }, 'registry.k8s.io/coredns/coredns:v1.11.1', { ports: [{ name: 'dns', containerPort: 53, protocol: 'UDP' }] });
  d.services.push(service('kube-system', 'kube-dns', { 'k8s-app': 'kube-dns' }, [{ name: 'dns', port: 53, targetPort: 53, protocol: 'UDP' }], { clusterIP: '10.96.0.10' }));
  d.deployments.push(deployment('kube-system', 'metrics-server'));
  d.replicasets.push(replicaset('kube-system', 'metrics-server-7f9c', 'metrics-server'));
  healthy('kube-system', 'metrics-server-7f9c-hh2kd', 'ReplicaSet', 'metrics-server-7f9c', 'worker-a', { app: 'metrics-server' }, 'registry.k8s.io/metrics-server/metrics-server:v0.7.1', { ports: [{ name: 'https', containerPort: 10250 }] });
  d.services.push(service('kube-system', 'metrics-server', { app: 'metrics-server' }, [{ name: 'https', port: 443, targetPort: 'https' }]));
  d.deployments.push(deployment('ingress-nginx', 'ingress-nginx-controller'));
  d.replicasets.push(replicaset('ingress-nginx', 'ingress-nginx-controller-6b4f', 'ingress-nginx-controller'));
  healthy('ingress-nginx', 'ingress-nginx-controller-6b4f-7xk2p', 'ReplicaSet', 'ingress-nginx-controller-6b4f', 'worker-a', { app: 'ingress-nginx-controller' }, 'registry.k8s.io/ingress-nginx/controller:v1.11.2', { ports: [{ name: 'http', containerPort: 80 }] });
  d.daemonsets.push({ kind: 'DaemonSet', metadata: meta('kube-proxy', 'kube-system', { age: 20000 }), spec: {}, status: { desiredNumberScheduled: 5, currentNumberScheduled: 5, numberReady: 4, numberAvailable: 4, numberUnavailable: 1, numberMisscheduled: 0 } });
  for (const n of ['cp-1', 'worker-a', 'worker-b', 'worker-d']) healthy('kube-system', `kube-proxy-${n}`, 'DaemonSet', 'kube-proxy', n, { 'k8s-app': 'kube-proxy' }, 'registry.k8s.io/kube-proxy:v1.30.4');
  d.pods.push(pod('kube-system', 'kube-proxy-worker-c', { owner: { kind: 'DaemonSet', name: 'kube-proxy' }, nodeName: 'worker-c', labels: { 'k8s-app': 'kube-proxy' }, containers: [container('kube-proxy', 'registry.k8s.io/kube-proxy:v1.30.4')], statuses: [status('kube-proxy', 'registry.k8s.io/kube-proxy:v1.30.4', { state: running(3000), ready: false })], ready: false, age: 3000 }));

  d.apiservices.push(
    { kind: 'APIService', metadata: meta('v1beta1.metrics.k8s.io', null, { age: 20000 }), spec: { group: 'metrics.k8s.io', version: 'v1beta1', service: { namespace: 'kube-system', name: 'metrics-server' } }, status: { conditions: [{ type: 'Available', status: 'True', reason: 'Passed' }] } },
    { kind: 'APIService', metadata: meta('v1beta1.custom.metrics.k8s.io', null, { age: 20000 }), spec: { group: 'custom.metrics.k8s.io', version: 'v1beta1', service: { namespace: 'monitoring', name: 'prometheus-adapter' } }, status: { conditions: [{ type: 'Available', status: 'False', reason: 'MissingEndpoints', message: 'endpoints for service/prometheus-adapter in "monitoring" have no addresses with port name "https"', lastTransitionTime: ago(100) }] } },
    { kind: 'APIService', metadata: meta('v1.apps', null, { age: 20000 }), spec: { group: 'apps', version: 'v1' }, status: { conditions: [{ type: 'Available', status: 'True', reason: 'Local' }] } },
  );
  // monitoring/prometheus-adapter scaled to zero during a cost-cutting change
  d.deployments.push(deployment('monitoring', 'prometheus-adapter', { replicas: 0, available: 0 }));
  d.services.push(service('monitoring', 'prometheus-adapter', { app: 'prometheus-adapter' }, [{ name: 'https', port: 443, targetPort: 6443 }]));

  // -------------------------------------------- data/postgres: PVC with bad class
  d.statefulsets.push({ kind: 'StatefulSet', metadata: meta('postgres', 'data', { age: 200 }), spec: { replicas: 1, serviceName: 'postgres', podManagementPolicy: 'OrderedReady' }, status: { replicas: 1, readyReplicas: 0, currentReplicas: 1, updatedReplicas: 1, currentRevision: 'postgres-6d9', updateRevision: 'postgres-6d9' } });
  d.pods.push(pod('data', 'postgres-0', { owner: { kind: 'StatefulSet', name: 'postgres' }, labels: { app: 'postgres' }, phase: 'Pending', ready: false, age: 180, containers: [container('postgres', 'postgres:16.4', { resources: lim('500m', '1Gi', null, '1Gi'), ports: [{ containerPort: 5432 }] })], volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'data-postgres-0' } }], conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/5 nodes are available: pod has unbound immediate PersistentVolumeClaims. preemption: 0/5 nodes are available: 5 Preemption is not helpful for scheduling.', lastTransitionTime: ago(180) }] }));
  d.pvcs.push({ kind: 'PersistentVolumeClaim', metadata: meta('data-postgres-0', 'data', { age: 180, labels: { app: 'postgres' } }), spec: { storageClassName: 'fast-ssd', accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '50Gi' } } }, status: { phase: 'Pending' } });
  d.events.push(event('data', 'PersistentVolumeClaim', 'data-postgres-0', 'ProvisioningFailed', 'storageclass.storage.k8s.io "fast-ssd" not found', { count: 14, firstMin: 180, lastMin: 2, component: 'persistentvolume-controller' }));
  d.events.push(event('data', 'Pod', 'postgres-0', 'FailedScheduling', '0/5 nodes are available: pod has unbound immediate PersistentVolumeClaims. preemption: 0/5 nodes are available: 5 Preemption is not helpful for scheduling.', { count: 37, firstMin: 180, lastMin: 1, component: 'default-scheduler' }));
  d.services.push(service('data', 'postgres', { app: 'postgres' }, [{ name: 'pg', port: 5432, targetPort: 5432 }], { clusterIP: '10.96.40.12' }));

  // --------------------------- shop/api: crashloop because postgres is down
  const apiImg = 'registry.example.com/shop/api:4.2.0';
  const apiEnv = [{ name: 'DATABASE_URL', value: 'postgres://shop@postgres.data.svc.cluster.local:5432/shop' }, { name: 'DATABASE_PASSWORD', valueFrom: { secretKeyRef: { name: 'shop-db', key: 'password' } } }];
  d.deployments.push(deployment('shop', 'api', { replicas: 3, available: 0 }));
  d.replicasets.push(replicaset('shop', 'api-7c9d8f', 'api', { replicas: 3 }));
  for (const [i, n] of ['api-7c9d8f-2hxkq', 'api-7c9d8f-9lmzp', 'api-7c9d8f-wq4rt'].entries()) {
    d.pods.push(pod('shop', n, { owner: { kind: 'ReplicaSet', name: 'api-7c9d8f' }, nodeName: i === 2 ? 'worker-d' : 'worker-a', labels: { app: 'api' }, ready: false, age: 170, containers: [container('api', apiImg, { resources: lim('250m', '256Mi', '1', '512Mi'), ports: [{ name: 'http', containerPort: 8080 }], env: apiEnv, readiness: { httpGet: { path: '/ready', port: 'http' }, periodSeconds: 5 } })], statuses: [status('api', apiImg, { state: waiting('CrashLoopBackOff', 'back-off 5m0s restarting failed container=api pod=' + n), lastState: terminated('Error', 1, 4, 3.9), ready: false, restartCount: 23 + i })] }));
    d.events.push(event('shop', 'Pod', n, 'BackOff', 'Back-off restarting failed container api in pod ' + n, { count: 410 + i, firstMin: 165, lastMin: 0.5, fieldPath: 'spec.containers{api}' }));
    logs[`shop/${n}/api/previous`] = [
      `${ago(4.05)} {"level":"info","msg":"starting shop-api","version":"4.2.0"}`,
      `${ago(4.04)} {"level":"info","msg":"loading configuration from env"}`,
      `${ago(4.0)} {"level":"warn","msg":"database not reachable, retrying","attempt":1,"error":"dial tcp 10.96.40.12:5432: connect: connection refused"}`,
      `${ago(3.95)} {"level":"warn","msg":"database not reachable, retrying","attempt":2,"error":"dial tcp 10.96.40.12:5432: connect: connection refused"}`,
      `${ago(3.9)} {"level":"error","msg":"could not connect to database","error":"failed to connect to \`host=postgres.data.svc.cluster.local user=shop database=shop\`: dial error (dial tcp 10.96.40.12:5432: connect: connection refused)"}`,
      `${ago(3.9)} {"level":"fatal","msg":"startup failed, exiting"}`,
    ].join('\n');
  }
  d.services.push(service('shop', 'api', { app: 'api' }, [{ name: 'http', port: 80, targetPort: 'http' }]));
  d.hpas.push({ kind: 'HorizontalPodAutoscaler', metadata: meta('api', 'shop', { age: 4000 }), spec: { scaleTargetRef: { kind: 'Deployment', name: 'api', apiVersion: 'apps/v1' }, minReplicas: 3, maxReplicas: 10 }, status: { currentReplicas: 3, desiredReplicas: 3, conditions: [{ type: 'AbleToScale', status: 'True', reason: 'SucceededGetScale' }, { type: 'ScalingActive', status: 'False', reason: 'FailedGetResourceMetric', message: 'the HPA was unable to compute the replica count: failed to get cpu utilization: did not receive metrics for targeted pods (pods might be unready)' }] } });

  // -------------------------------------- shop/frontend: rollout stuck on bad tag
  const feOld = 'registry.example.com/shop/frontend:2.3.0';
  const feNew = 'registry.example.com/shop/frontend:2.3.1';
  d.deployments.push(deployment('shop', 'frontend', { replicas: 2, available: 2, updated: 1, progressing: ['False', 'ProgressDeadlineExceeded', 'ReplicaSet "frontend-58bd7" has timed out progressing.'] }));
  d.replicasets.push(replicaset('shop', 'frontend-6f7c', 'frontend', { replicas: 2 }), replicaset('shop', 'frontend-58bd7', 'frontend', { replicas: 1 }));
  for (const n of ['frontend-6f7c-abcde', 'frontend-6f7c-fghij']) {
    d.pods.push(pod('shop', n, { owner: { kind: 'ReplicaSet', name: 'frontend-6f7c' }, nodeName: 'worker-a', labels: { app: 'frontend' }, age: 4000, containers: [container('web', feOld, { resources: lim('50m', '64Mi', null, '128Mi'), ports: [{ name: 'http', containerPort: 8080 }] })], statuses: [status('web', feOld, { state: running(4000) })] }));
  }
  d.pods.push(pod('shop', 'frontend-58bd7-kq2mw', { owner: { kind: 'ReplicaSet', name: 'frontend-58bd7' }, nodeName: 'worker-d', labels: { app: 'frontend' }, ready: false, phase: 'Pending', age: 25, containers: [container('web', feNew, { resources: lim('50m', '64Mi', null, '128Mi'), ports: [{ name: 'http', containerPort: 8080 }] })], statuses: [status('web', feNew, { state: waiting('ImagePullBackOff', `Back-off pulling image "${feNew}"`), ready: false })] }));
  d.events.push(event('shop', 'Pod', 'frontend-58bd7-kq2mw', 'Failed', `Failed to pull image "${feNew}": rpc error: code = NotFound desc = failed to pull and unpack image "${feNew}": failed to resolve reference "${feNew}": ${feNew}: not found`, { count: 7, firstMin: 25, lastMin: 2, fieldPath: 'spec.containers{web}' }));
  d.events.push(event('shop', 'Pod', 'frontend-58bd7-kq2mw', 'BackOff', `Back-off pulling image "${feNew}"`, { count: 98, firstMin: 25, lastMin: 0.3, fieldPath: 'spec.containers{web}' }));
  d.services.push(service('shop', 'frontend', { app: 'frontend' }, [{ name: 'http', port: 80, targetPort: 'http' }]));

  // ---------------------------------- shop/cart: missing secret
  const cartImg = 'registry.example.com/shop/cart:1.8.2';
  d.deployments.push(deployment('shop', 'cart', { replicas: 2, available: 0 }));
  d.replicasets.push(replicaset('shop', 'cart-5b6d', 'cart', { replicas: 2 }));
  for (const n of ['cart-5b6d-7tq2x', 'cart-5b6d-p0o9i']) {
    d.pods.push(pod('shop', n, { owner: { kind: 'ReplicaSet', name: 'cart-5b6d' }, nodeName: 'worker-a', labels: { app: 'cart' }, phase: 'Pending', ready: false, age: 40, containers: [container('cart', cartImg, { env: [{ name: 'REDIS_PASSWORD', valueFrom: { secretKeyRef: { name: 'cart-redis-credentials', key: 'password' } } }] })], statuses: [status('cart', cartImg, { state: waiting('CreateContainerConfigError', 'secret "cart-redis-credentials" not found'), ready: false })] }));
    d.events.push(event('shop', 'Pod', n, 'Failed', 'Error: secret "cart-redis-credentials" not found', { count: 180, firstMin: 40, lastMin: 0.5, fieldPath: 'spec.containers{cart}' }));
  }
  d.services.push(service('shop', 'cart', { app: 'cart' }, [{ port: 80, targetPort: 8080 }]));

  // ---------------------------------- shop/recommendations: selector typo
  d.deployments.push(deployment('shop', 'recommendations', { replicas: 1, labels: { app: 'recommendations' } }));
  d.replicasets.push(replicaset('shop', 'recommendations-77f', 'recommendations', { labels: { app: 'recommendations' } }));
  d.pods.push(pod('shop', 'recommendations-77f-zz81k', { owner: { kind: 'ReplicaSet', name: 'recommendations-77f' }, nodeName: 'worker-a', labels: { app: 'recommendations' }, age: 2000, containers: [container('reco', 'registry.example.com/shop/reco:3.0.0', { ports: [{ containerPort: 5000 }], resources: lim('100m', '256Mi', null, '512Mi') })], statuses: [status('reco', 'registry.example.com/shop/reco:3.0.0', { state: running(2000) })] }));
  d.services.push(service('shop', 'recommendation', { app: 'recommendation' }, [{ port: 80, targetPort: 5000 }]));

  d.ingresses.push({ kind: 'Ingress', metadata: meta('shop', 'shop', { age: 5000 }), spec: { ingressClassName: 'nginx', rules: [{ host: 'shop.example.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'frontend', port: { number: 80 } } } }, { path: '/api', pathType: 'Prefix', backend: { service: { name: 'api', port: { number: 80 } } } }, { path: '/reco', pathType: 'Prefix', backend: { service: { name: 'recommendation', port: { number: 80 } } } }, { path: '/checkout', pathType: 'Prefix', backend: { service: { name: 'checkout', port: { name: 'http' } } } }] } }] }, status: { loadBalancer: { ingress: [{ hostname: 'lb-123.elb.amazonaws.com' }] } } });

  // ------------------- policy webhook down (x509 in logs) -> checkout cannot create pods
  const polImg = 'registry.example.com/platform/policy-engine:0.9.0';
  d.deployments.push(deployment('policy', 'policy-webhook', { replicas: 1, available: 0 }));
  d.replicasets.push(replicaset('policy', 'policy-webhook-6c8', 'policy-webhook'));
  d.pods.push(pod('policy', 'policy-webhook-6c8-mm2pl', { owner: { kind: 'ReplicaSet', name: 'policy-webhook-6c8' }, nodeName: 'worker-a', labels: { app: 'policy-webhook' }, ready: false, age: 400, containers: [container('webhook', polImg, { ports: [{ name: 'https', containerPort: 9443 }], resources: lim('100m', '128Mi', null, '256Mi') })], statuses: [status('webhook', polImg, { state: waiting('CrashLoopBackOff', 'back-off 5m0s restarting failed container'), lastState: terminated('Error', 1, 2.1, 2.0), restartCount: 9, ready: false })] }));
  logs['policy/policy-webhook-6c8-mm2pl/webhook/previous'] = [
    `${ago(2.1)} I1022 08:10:02.112 main.go:41] policy-engine 0.9.0 starting`,
    `${ago(2.05)} I1022 08:10:02.230 certs.go:88] loading serving certificate from /tls/tls.crt`,
    `${ago(2.0)} E1022 08:10:02.451 main.go:77] failed to start webhook server: tls: failed to verify certificate: x509: certificate has expired or is not yet valid: current time 2026-10-22T08:10:02Z is after 2026-10-20T00:00:00Z`,
  ].join('\n');
  d.services.push(service('policy', 'policy-webhook', { app: 'policy-webhook' }, [{ name: 'https', port: 443, targetPort: 'https' }]));
  d.validatingwebhooks.push({ kind: 'ValidatingWebhookConfiguration', metadata: meta('policy-engine', null, { age: 9000 }), webhooks: [{ name: 'validate.policy.example.com', failurePolicy: 'Fail', clientConfig: { service: { namespace: 'policy', name: 'policy-webhook', path: '/validate' } }, rules: [{ operations: ['CREATE', 'UPDATE'], apiGroups: [''], apiVersions: ['v1'], resources: ['pods'] }], namespaceSelector: { matchExpressions: [{ key: 'kubernetes.io/metadata.name', operator: 'NotIn', values: ['kube-system', 'policy'] }] } }] });
  d.deployments.push(deployment('shop', 'checkout', { replicas: 2, available: 0, updated: 0 }));
  d.replicasets.push(replicaset('shop', 'checkout-84c', 'checkout', { replicas: 2, failure: 'Internal error occurred: failed calling webhook "validate.policy.example.com": failed to call webhook: Post "https://policy-webhook.policy.svc:443/validate?timeout=10s": no endpoints available for service "policy-webhook"' }));
  d.events.push(event('shop', 'ReplicaSet', 'checkout-84c', 'FailedCreate', 'Error creating: Internal error occurred: failed calling webhook "validate.policy.example.com": failed to call webhook: Post "https://policy-webhook.policy.svc:443/validate?timeout=10s": no endpoints available for service "policy-webhook"', { count: 31, firstMin: 60, lastMin: 1, component: 'replicaset-controller' }));
  d.services.push(service('shop', 'checkout', { app: 'checkout' }, [{ name: 'http', port: 80, targetPort: 8080 }]));

  // ---------------------------------- payments: OOM (JVM), liveness, quota
  const pgImg = 'registry.example.com/payments/gateway:7.1.3';
  d.deployments.push(deployment('payments', 'payment-gateway', { replicas: 2, available: 0 }));
  d.replicasets.push(replicaset('payments', 'payment-gateway-9d7', 'payment-gateway', { replicas: 2 }));
  for (const [i, n] of ['payment-gateway-9d7-4kq8s', 'payment-gateway-9d7-v7cxw'].entries()) {
    d.pods.push(pod('payments', n, { owner: { kind: 'ReplicaSet', name: 'payment-gateway-9d7' }, nodeName: 'worker-a', labels: { app: 'payment-gateway' }, ready: false, age: 300, containers: [container('gateway', pgImg, { resources: lim('500m', '768Mi', '2', '1Gi'), ports: [{ name: 'http', containerPort: 8080 }], env: [{ name: 'JAVA_OPTS', value: '-Xms512m -Xmx1g -XX:+UseG1GC' }, { name: 'SPRING_PROFILES_ACTIVE', value: 'prod' }] })], statuses: [status('gateway', pgImg, { state: waiting('CrashLoopBackOff', 'back-off 2m40s restarting failed container'), lastState: terminated('OOMKilled', 137, 3.2, 2.4), restartCount: 14 + i, ready: false })] }));
    d.events.push(event('payments', 'Pod', n, 'BackOff', 'Back-off restarting failed container gateway', { count: 66, firstMin: 290, lastMin: 1, fieldPath: 'spec.containers{gateway}' }));
    logs[`payments/${n}/gateway/previous`] = [
      `${ago(3.2)} 2026-10-22 08:07:31.002  INFO 1 --- [main] c.e.payments.GatewayApplication : Starting GatewayApplication v7.1.3 using Java 17.0.12`,
      `${ago(3.0)} 2026-10-22 08:07:44.881  INFO 1 --- [main] o.s.b.w.embedded.tomcat.TomcatWebServer : Tomcat started on port(s): 8080 (http)`,
      `${ago(2.6)} 2026-10-22 08:08:12.410  INFO 1 --- [batch-1] c.e.payments.SettlementLoader : loading 1843221 pending settlements into memory`,
    ].join('\n');
    top.pods.push({ namespace: 'payments', pod: n, container: 'gateway', cpu: '890m', memory: '930Mi' });
  }
  d.pdbs.push({ kind: 'PodDisruptionBudget', metadata: meta('payment-gateway', 'payments', { age: 9000 }), spec: { minAvailable: 1, selector: { matchLabels: { app: 'payment-gateway' } } }, status: { expectedPods: 2, currentHealthy: 0, desiredHealthy: 1, disruptionsAllowed: 0 } });

  const fdImg = 'registry.example.com/payments/fraud-detector:2.0.4';
  d.deployments.push(deployment('payments', 'fraud-detector', { replicas: 1, available: 1 }));
  d.replicasets.push(replicaset('payments', 'fraud-detector-55b', 'fraud-detector'));
  d.pods.push(pod('payments', 'fraud-detector-55b-n2kd8', { owner: { kind: 'ReplicaSet', name: 'fraud-detector-55b' }, nodeName: 'worker-a', labels: { app: 'fraud-detector' }, age: 900, containers: [container('detector', fdImg, { resources: lim('200m', '512Mi', '250m', '1Gi'), ports: [{ name: 'http', containerPort: 8080 }], liveness: { httpGet: { path: '/health', port: 8080 }, initialDelaySeconds: 10, periodSeconds: 10, timeoutSeconds: 1, failureThreshold: 3 } })], statuses: [status('detector', fdImg, { state: running(6), lastState: terminated('Error', 137, 13, 6.2), restartCount: 8 })] }));
  d.events.push(event('payments', 'Pod', 'fraud-detector-55b-n2kd8', 'Unhealthy', 'Liveness probe failed: Get "http://10.244.3.17:8080/health": context deadline exceeded (Client.Timeout exceeded while awaiting headers)', { count: 27, firstMin: 120, lastMin: 6.3, fieldPath: 'spec.containers{detector}' }));
  d.events.push(event('payments', 'Pod', 'fraud-detector-55b-n2kd8', 'Killing', 'Container detector failed liveness probe, will be restarted', { type: 'Normal', count: 8, firstMin: 110, lastMin: 6.25, fieldPath: 'spec.containers{detector}' }));
  top.pods.push({ namespace: 'payments', pod: 'fraud-detector-55b-n2kd8', container: 'detector', cpu: '249m', memory: '610Mi' });

  d.resourcequotas.push({ kind: 'ResourceQuota', metadata: meta('payments-quota', 'payments', { age: 9000 }), spec: { hard: { pods: '6', 'requests.memory': '6Gi' } }, status: { hard: { pods: '6', 'requests.memory': '6Gi' }, used: { pods: '6', 'requests.memory': '5632Mi' } } });
  d.deployments.push(deployment('payments', 'ledger', { replicas: 3, available: 1 }));
  d.replicasets.push(replicaset('payments', 'ledger-7aa', 'ledger', { replicas: 3, failure: 'pods "ledger-7aa-x1" is forbidden: exceeded quota: payments-quota, requested: pods=1, used: pods=6, limited: pods=6' }));
  d.pods.push(pod('payments', 'ledger-7aa-q8w2e', { owner: { kind: 'ReplicaSet', name: 'ledger-7aa' }, nodeName: 'worker-d', labels: { app: 'ledger' }, age: 3000, containers: [container('ledger', 'registry.example.com/payments/ledger:1.4.0', { resources: lim('100m', '512Mi', null, '512Mi') })], statuses: [status('ledger', 'registry.example.com/payments/ledger:1.4.0', { state: running(3000) })] }));

  // ---------------------------------- data/elasticsearch: can never fit
  d.statefulsets.push({ kind: 'StatefulSet', metadata: meta('search', 'data', { age: 300 }), spec: { replicas: 1, serviceName: 'search' }, status: { replicas: 1, readyReplicas: 0 } });
  d.pods.push(pod('data', 'search-0', { owner: { kind: 'StatefulSet', name: 'search' }, labels: { app: 'search' }, phase: 'Pending', ready: false, age: 280, containers: [container('elasticsearch', 'docker.elastic.co/elasticsearch/elasticsearch:8.15.0', { resources: lim('6', '24Gi', '6', '24Gi') })], conditions: [{ type: 'PodScheduled', status: 'False', reason: 'Unschedulable', message: '0/5 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 1 node(s) had untolerated taint {node.kubernetes.io/disk-pressure: }, 1 node(s) had untolerated taint {node.kubernetes.io/unreachable: }, 1 node(s) were unschedulable, 1 Insufficient cpu, 1 Insufficient memory. preemption: 0/5 nodes are available: 1 No preemption victims found for incoming pod, 4 Preemption is not helpful for scheduling.', lastTransitionTime: ago(280) }] }));
  d.events.push(event('data', 'Pod', 'search-0', 'FailedScheduling', '0/5 nodes are available: 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 1 node(s) had untolerated taint {node.kubernetes.io/disk-pressure: }, 1 node(s) had untolerated taint {node.kubernetes.io/unreachable: }, 1 node(s) were unschedulable, 1 Insufficient cpu, 1 Insufficient memory.', { count: 52, firstMin: 280, lastMin: 2, component: 'default-scheduler' }));

  // ---------------------------------- monitoring/grafana: on the dead node
  d.deployments.push(deployment('monitoring', 'grafana', { replicas: 1, available: 0 }));
  d.replicasets.push(replicaset('monitoring', 'grafana-6dd', 'grafana'));
  d.pods.push(pod('monitoring', 'grafana-6dd-r5t6y', { owner: { kind: 'ReplicaSet', name: 'grafana-6dd' }, nodeName: 'worker-c', labels: { app: 'grafana' }, ready: false, age: 6000, deletionTimestamp: ago(16), volumes: [{ name: 'storage', persistentVolumeClaim: { claimName: 'grafana' } }], containers: [container('grafana', 'grafana/grafana:11.2.0', { volumeMounts: [{ name: 'storage', mountPath: '/var/lib/grafana' }] })], statuses: [status('grafana', 'grafana/grafana:11.2.0', { state: running(6000), ready: false })] }));
  d.pods.push(pod('monitoring', 'grafana-6dd-b9n3m', { owner: { kind: 'ReplicaSet', name: 'grafana-6dd' }, nodeName: 'worker-a', labels: { app: 'grafana' }, ready: false, phase: 'Pending', age: 16, volumes: [{ name: 'storage', persistentVolumeClaim: { claimName: 'grafana' } }], containers: [container('grafana', 'grafana/grafana:11.2.0', { volumeMounts: [{ name: 'storage', mountPath: '/var/lib/grafana' }] })], statuses: [status('grafana', 'grafana/grafana:11.2.0', { state: waiting('ContainerCreating'), ready: false })] }));
  d.events.push(event('monitoring', 'Pod', 'grafana-6dd-b9n3m', 'FailedAttachVolume', 'Multi-Attach error for volume "pvc-1f2e3d4c" Volume is already exclusively attached to one node and can\'t be attached to another', { count: 1, firstMin: 15, lastMin: 15, component: 'attachdetach-controller' }));
  d.events.push(event('monitoring', 'Pod', 'grafana-6dd-b9n3m', 'FailedMount', 'Unable to attach or mount volumes: unmounted volumes=[storage], unattached volumes=[storage kube-api-access-8s7bv]: timed out waiting for the condition', { count: 6, firstMin: 14, lastMin: 2 }));
  d.pvcs.push({ kind: 'PersistentVolumeClaim', metadata: meta('grafana', 'monitoring', { age: 9000 }), spec: { storageClassName: 'gp3', accessModes: ['ReadWriteOnce'], volumeName: 'pvc-1f2e3d4c', resources: { requests: { storage: '10Gi' } } }, status: { phase: 'Bound' } });

  // ---------------------------------- shop/image-resizer: evicted from worker-b
  d.deployments.push(deployment('shop', 'image-resizer', { replicas: 1, available: 1 }));
  d.replicasets.push(replicaset('shop', 'image-resizer-4f2', 'image-resizer'));
  for (const n of ['image-resizer-4f2-aa111', 'image-resizer-4f2-bb222', 'image-resizer-4f2-cc333']) {
    d.pods.push(pod('shop', n, { owner: { kind: 'ReplicaSet', name: 'image-resizer-4f2' }, nodeName: 'worker-b', labels: { app: 'image-resizer' }, phase: 'Failed', reason: 'Evicted', message: 'The node was low on resource: ephemeral-storage. Threshold quantity: 10Gi, available: 6982236Ki. Container resizer was using 41Gi, request is 0, has larger consumption of ephemeral-storage. ', ready: false, age: 200, containers: [container('resizer', 'registry.example.com/shop/resizer:0.3.1')], statuses: [] }));
  }
  d.pods.push(pod('shop', 'image-resizer-4f2-dd444', { owner: { kind: 'ReplicaSet', name: 'image-resizer-4f2' }, nodeName: 'worker-a', labels: { app: 'image-resizer' }, age: 30, containers: [container('resizer', 'registry.example.com/shop/resizer:0.3.1')], statuses: [status('resizer', 'registry.example.com/shop/resizer:0.3.1', { state: running(30) })] }));

  // ---------------------------------- batch: failing CronJob (missing env)
  d.cronjobs.push({ kind: 'CronJob', metadata: meta('nightly-report', 'batch', { age: 30000 }), spec: { schedule: '0 2 * * *' }, status: { lastScheduleTime: ago(400), lastSuccessfulTime: ago(4700) } });
  const job = { kind: 'Job', metadata: meta('nightly-report-29312', 'batch', { age: 400 }), spec: { backoffLimit: 2 }, status: { failed: 3, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit', lastTransitionTime: ago(380) }] } };
  job.metadata.ownerReferences = [{ kind: 'CronJob', name: 'nightly-report', controller: true, uid: uid() }];
  d.jobs.push(job);
  for (const [i, n] of ['nightly-report-29312-7d2kx', 'nightly-report-29312-m3n4b', 'nightly-report-29312-zx9q1'].entries()) {
    const p = pod('batch', n, { owner: { kind: 'Job', name: 'nightly-report-29312' }, nodeName: 'worker-a', labels: { 'job-name': 'nightly-report-29312' }, phase: 'Failed', ready: false, restartPolicy: 'Never', age: 400 - i * 5, containers: [container('report', 'registry.example.com/batch/report:5.2.0', { command: ['python', '-m', 'report.main'] })], statuses: [status('report', 'registry.example.com/batch/report:5.2.0', { state: terminated('Error', 1, 399 - i * 5, 398.8 - i * 5), ready: false })] });
    d.pods.push(p);
    logs[`batch/${n}/report/current`] = [
      `${ago(399 - i * 5)} INFO report.main: generating nightly report for 2026-10-21`,
      `${ago(398.9 - i * 5)} Traceback (most recent call last):`,
      `${ago(398.9 - i * 5)}   File "/app/report/main.py", line 12, in <module>`,
      `${ago(398.9 - i * 5)}     bucket = os.environ["REPORT_BUCKET"]`,
      `${ago(398.9 - i * 5)}   File "/usr/local/lib/python3.12/os.py", line 714, in __getitem__`,
      `${ago(398.9 - i * 5)}     raise KeyError(key) from None`,
      `${ago(398.8 - i * 5)} KeyError: 'REPORT_BUCKET'`,
    ].join('\n');
  }

  // ---------------------------------- legacy namespace stuck (see APIService)
  d.events.push(event('shop', 'Pod', 'api-7c9d8f-0ldp0d', 'FailedKillPod', 'error killing pod: failed to "KillPodSandbox" for "a1b2" with KillPodSandboxError: "rpc error: code = Unknown desc = networkPlugin cni failed to teardown pod"', { count: 2, firstMin: 50, lastMin: 40 }));

  // ---------------------------------- demo log for a healthy pod
  logs['shop/frontend-6f7c-abcde/web/current'] = `${ago(3)} 10.244.0.5 - - [22/Oct/2026:08:10:01 +0000] "GET / HTTP/1.1" 200 5123\n${ago(2)} 10.244.0.5 - - [22/Oct/2026:08:11:01 +0000] "GET /api/products HTTP/1.1" 502 157`;

  // EndpointSlices mirror pod readiness for services.
  for (const svc of d.services) {
    const pods = d.pods.filter((p) => p.metadata.namespace === svc.metadata.namespace && svc.spec.selector && Object.entries(svc.spec.selector).every(([k, v]) => p.metadata.labels[k] === v) && !['Failed', 'Succeeded'].includes(p.status.phase));
    d.endpointslices.push({ kind: 'EndpointSlice', metadata: meta(`${svc.metadata.name}-abc12`, svc.metadata.namespace, { labels: { 'kubernetes.io/service-name': svc.metadata.name } }), endpoints: pods.filter((p) => p.status.podIP).map((p) => ({ addresses: [p.status.podIP], conditions: { ready: p.status.conditions.find((c) => c.type === 'Ready')?.status === 'True' } })) });
  }
  d.serviceaccounts.push({ kind: 'ServiceAccount', metadata: meta('default', 'shop', {}) });

  return { data: d, logs, top };
}
