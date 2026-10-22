// Troubleshooting knowledge: turns raw Kubernetes reasons/messages into
// root-cause explanations and fixes. Every explainer returns
// { summary, details?, fixes[], confidence: 'high'|'medium'|'low', tags?[], extracted? }.

const r = (summary, fixes = [], confidence = 'high', extra = {}) => ({ summary, fixes, confidence, ...extra });

export const SIGNALS = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 9: 'SIGKILL', 11: 'SIGSEGV', 13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM' };

export const EXIT_CODES = {
  0: 'Exit 0: the main process finished successfully. For a Deployment/StatefulSet/DaemonSet container this is a bug: the process must keep running in the foreground.',
  1: 'Exit 1: generic application error. The program detected a problem and stopped; the reason is almost always printed in the logs of the previous container instance.',
  2: 'Exit 2: invalid usage / bad arguments (shell builtin misuse, unknown CLI flag).',
  126: 'Exit 126: the command exists but cannot be executed (no execute permission, a directory, or wrong format).',
  127: 'Exit 127: command not found. The command/entrypoint does not exist in the image (typo, wrong PATH, or e.g. /bin/bash missing in an alpine/distroless image).',
  128: 'Exit 128: invalid exit argument or the container runtime could not start the process.',
  130: 'Exit 130: interrupted (SIGINT).',
  134: 'Exit 134 (SIGABRT): the process aborted itself — failed assertion, C/C++ abort(), or a JVM/native crash.',
  135: 'Exit 135 (SIGBUS): bus error — often memory-mapped files on a full or broken volume.',
  136: 'Exit 136 (SIGFPE): arithmetic error in native code.',
  137: 'Exit 137 (SIGKILL): the process was killed with no chance to clean up — by the kernel OOM killer, by the kubelet after a failed liveness probe, or because it did not stop within terminationGracePeriodSeconds.',
  139: 'Exit 139 (SIGSEGV): segmentation fault in native code (bad native library, binary built for another CPU/libc, or corrupted memory).',
  141: 'Exit 141 (SIGPIPE): wrote to a closed pipe/socket.',
  143: 'Exit 143 (SIGTERM): the container was asked to stop — liveness probe failure, rollout, eviction, preemption or node drain/shutdown.',
  255: 'Exit 255: fatal error with an out-of-range status (often os.Exit(-1) or an exception escaping main).',
};

export function explainExitCode(code) {
  if (code == null) return null;
  if (EXIT_CODES[code]) return EXIT_CODES[code];
  if (code > 128 && code < 160) return `Exit ${code}: killed by signal ${code - 128} (${SIGNALS[code - 128] || 'unknown'}).`;
  return `Exit ${code}: application-specific code — its meaning is defined by the program; check its logs/documentation.`;
}

// ---------------------------------------------------------------- images

export function explainImagePull(message, { image, pullSecrets = [], nodeArch } = {}) {
  const m = message || '';
  const img = image ? `"${image}"` : 'the image';
  if (/InvalidImageName|invalid reference format|couldn't parse image|failed to parse image/i.test(m)) {
    return r(`The image reference ${img} is not a valid image name.`, ['Fix the image field (lowercase repository, a single ":tag" or "@sha256:digest", no spaces or "https://").'], 'high', { tags: ['InvalidImageName'] });
  }
  if (/ErrImageNeverPull|pull policy of Never|imagePullPolicy is "Never"/i.test(m)) {
    return r(`imagePullPolicy is "Never" but ${img} is not present on the node.`, ['Set imagePullPolicy to IfNotPresent/Always, or pre-load the image on every node.']);
  }
  if (/no match for platform in manifest|no matching manifest for|does not provide the specified platform/i.test(m)) {
    return r(`${img} has no build for the node's CPU architecture${nodeArch ? ` (${nodeArch})` : ''}.`, ['Publish a multi-arch image (docker buildx --platform linux/amd64,linux/arm64) or pin the pod to nodes of a matching architecture (nodeSelector kubernetes.io/arch).'], 'high', { tags: ['Architecture'] });
  }
  if (/toomanyrequests|rate limit|429 Too Many Requests/i.test(m)) {
    return r('The registry is rate-limiting pulls (typically Docker Hub anonymous pull limits).', ['Authenticate pulls with an imagePullSecret, use a registry mirror / pull-through cache, or copy the image to your own registry.'], 'high', { tags: ['RateLimited'] });
  }
  if (/manifest unknown|manifest for \S+ not found|not found: manifest|: not found$|: not found\b|failed to resolve reference .*not found|repository name not known|name unknown|NAME_UNKNOWN|MANIFEST_UNKNOWN/i.test(m) && !/pull access denied|insufficient_scope/i.test(m)) {
    return r(`The tag or digest of ${img} does not exist in the registry.`, ['Check the image tag for typos and that the CI pipeline actually pushed it (e.g. `crane ls <repo>` / registry UI).', 'If the tag was deleted by a retention policy, rebuild or pin an existing tag.'], 'high', { tags: ['ImageNotFound'] });
  }
  if (/unauthorized|authentication required|access denied|denied:|403 Forbidden|401|pull access denied|requested access to the resource is denied|insufficient_scope|may require .?(docker login|authorization)|no basic auth credentials|authorization failed/i.test(m)) {
    if (!pullSecrets.length) {
      return r(`The registry refused the pull of ${img} (authentication required) and the pod has no imagePullSecrets (neither on the pod nor on its ServiceAccount). Registries also answer this way when the repository does not exist.`, ['Create a docker-registry secret and reference it in spec.imagePullSecrets (or attach it to the ServiceAccount).', 'Verify the repository path is correct — a typo in the repository name produces the same error.'], 'high', { tags: ['RegistryAuth'] });
    }
    return r(`The registry rejected the credentials for ${img} although imagePullSecrets (${pullSecrets.join(', ')}) are configured: the secret may be expired, for another registry host, or lack pull rights. A non-existent repository produces the same error.`, ['Check the secret targets the exact registry host of the image and that the token is still valid (ECR tokens expire after 12h).', 'Verify the repository path and that the account has pull permission.'], 'medium', { tags: ['RegistryAuth'] });
  }
  if (/x509|certificate signed by unknown authority|tls: failed to verify|certificate has expired|certificate is valid for/i.test(m)) {
    return r('The node does not trust the registry TLS certificate (private CA, TLS-intercepting proxy, or expired certificate).', ['Install the registry/proxy CA on the nodes (containerd certs.d hosts.toml) or fix the registry certificate.'], 'high', { tags: ['TLS'] });
  }
  if (/no such host|server misbehaving|lookup \S+ on|Temporary failure in name resolution/i.test(m)) {
    return r(`The node cannot resolve the registry host of ${img} (DNS).`, ['Check the registry hostname for typos and that nodes can resolve it (corporate DNS, private endpoints, air-gapped clusters need a mirror).'], 'high', { tags: ['RegistryUnreachable'] });
  }
  if (/i\/o timeout|dial tcp|connection refused|context deadline exceeded|TLS handshake timeout|net\/http: request canceled|connection reset|proxyconnect/i.test(m)) {
    return r('The node cannot reach the registry over the network (firewall, missing egress/NAT, proxy not configured for containerd, or registry down).', ['From a node, test `crictl pull <image>`; check egress rules, NAT gateway, and containerd HTTP(S)_PROXY settings.'], 'medium', { tags: ['RegistryUnreachable'] });
  }
  if (/no space left on device/i.test(m)) {
    return r('The node ran out of disk space while extracting the image.', ['Free disk space on the node (image GC thresholds), use bigger root volumes, or reduce image size.'], 'high', { tags: ['DiskFull'] });
  }
  if (/Back-off pulling image/i.test(m)) {
    return r(`Kubernetes is backing off after earlier failed pulls of ${img}; the original error is in the pod's "Failed" events.`, ['Run `kubectl describe pod` and read the first "Failed to pull image" event.'], 'low');
  }
  return r(`The image ${img} could not be pulled.`, ['Read the "Failed to pull image" events of the pod for the registry error.'], 'low');
}

// ---------------------------------------------------- container config/start

export function explainContainerConfigError(message) {
  const m = message || '';
  let x;
  if ((x = m.match(/secret "([^"]+)" not found/i))) {
    return r(`The pod references Secret "${x[1]}" which does not exist in this namespace.`, [`Create Secret "${x[1]}" in the pod's namespace (or fix the name in env/envFrom/volumes), or mark the reference optional: true.`], 'high', { tags: ['MissingSecret'], extracted: { secret: x[1] } });
  }
  if ((x = m.match(/configmaps? "([^"]+)" not found/i))) {
    return r(`The pod references ConfigMap "${x[1]}" which does not exist in this namespace.`, [`Create ConfigMap "${x[1]}" (often forgotten when deploying to a new namespace/environment), fix the name, or mark it optional: true.`], 'high', { tags: ['MissingConfigMap'], extracted: { configmap: x[1] } });
  }
  if ((x = m.match(/couldn't find key (\S+) in (Secret|ConfigMap) ([\w./-]+)/i))) {
    return r(`Key "${x[1]}" is missing from ${x[2]} ${x[3]}.`, [`Add key "${x[1]}" to ${x[2]} ${x[3]} or fix the key name in valueFrom.${x[2] === 'Secret' ? 'secretKeyRef' : 'configMapKeyRef'}.`], 'high', { tags: [x[2] === 'Secret' ? 'MissingSecret' : 'MissingConfigMap'] });
  }
  if (/runAsNonRoot and image will run as root|image has non-numeric user .* cannot verify user is non-root/i.test(m)) {
    return r('securityContext.runAsNonRoot is true but the image runs as root (or as a non-numeric user).', ['Set securityContext.runAsUser to a numeric non-root UID, or build the image with `USER 10001`.'], 'high', { tags: ['SecurityContext'] });
  }
  if (/failed to sync (secret|configmap) cache|timed out waiting for the condition/i.test(m)) {
    return r('The kubelet could not fetch referenced Secrets/ConfigMaps in time (API server slow or node authorizer issue).', ['Usually transient; if persistent check API-server health and kubelet logs on the node.'], 'medium');
  }
  if (/failed to prepare subPath|subPath/i.test(m)) {
    return r('A volume subPath could not be prepared (the path does not exist in the volume or is invalid).', ['Check volumeMounts[].subPath and that the key/path exists in the source volume.'], 'medium');
  }
  return r('The kubelet could not build the container configuration.', ['Read `kubectl describe pod` events for the exact reference that is missing.'], 'low');
}

export function explainContainerStartError(message) {
  const m = message || '';
  let x;
  if ((x = m.match(/exec: "([^"]+)": (?:executable file not found in \$PATH|stat [^:]+: no such file or directory)/i)) || (x = m.match(/exec ([^:\s]+): no such file or directory/i))) {
    return r(`The command "${x[1]}" does not exist in the image.`, ['Fix spec.containers[].command/args, or use a shell that exists in the image (e.g. /bin/sh instead of /bin/bash on alpine; distroless images have no shell).'], 'high', { tags: ['BadCommand'] });
  }
  if (/exec format error/i.test(m)) {
    return r('The binary was built for a different CPU architecture than the node (or a script lacks a #! line).', ['Build a multi-arch image or schedule on matching nodes (kubernetes.io/arch); add a shebang to scripts.'], 'high', { tags: ['Architecture'] });
  }
  if (/permission denied/i.test(m)) {
    return r('The entrypoint is not executable for the container user (missing +x, or noexec/readOnly mount).', ['chmod +x the entrypoint in the image, check runAsUser/fsGroup and readOnlyRootFilesystem.'], 'high', { tags: ['Permissions'] });
  }
  if (/no command specified/i.test(m)) {
    return r('The image has no ENTRYPOINT/CMD and the pod does not set command.', ['Set spec.containers[].command, or fix the Dockerfile.'], 'high', { tags: ['BadCommand'] });
  }
  if (/not a directory|Are you trying to mount a directory onto a file|is a directory/i.test(m)) {
    return r('A volumeMount targets a path of the wrong type (file vs directory), usually a ConfigMap/Secret mounted without subPath over an existing file.', ['Use subPath to mount a single file, or mount into an empty directory.'], 'high', { tags: ['VolumeMount'] });
  }
  if (/read-only file system/i.test(m)) {
    return r('The container writes to a read-only filesystem at startup.', ['Mount an emptyDir for writable paths (e.g. /tmp) when readOnlyRootFilesystem is true.'], 'medium');
  }
  if (/memory|cgroup|oom/i.test(m)) {
    return r('The runtime could not start the container because of memory/cgroup limits (limit set too low for the runtime to even start the process).', ['Increase the memory limit; check that it is not a typo like "128" (bytes) instead of "128Mi".'], 'medium', { tags: ['OOMKilled'] });
  }
  return r('The container runtime failed to create or start the container.', ['Read the full message in `kubectl describe pod`; check the node\'s containerd/kubelet logs.'], 'low');
}

// ---------------------------------------------------------------- scheduling

const SCHED_REASONS = [
  [/Insufficient (\S+)/i, (x) => ({ key: `Insufficient ${x[1]}`, text: `not enough free ${x[1]} for the pod's requests`, fix: `Lower resources.requests.${x[1]}, free capacity, or add nodes (cluster autoscaler).`, tag: 'InsufficientResources' })],
  [/untolerated taint \{?([^}]*)\}?|had taint \{([^}]*)\}, that the pod didn't tolerate|had untolerated taint/i, (x) => ({ key: 'Taint', text: `nodes have a taint the pod does not tolerate${x[1] || x[2] ? ` (${x[1] || x[2]})` : ''}`, fix: 'Add a matching toleration, or remove the taint if the nodes should accept this workload.', tag: 'Taints' })],
  [/didn't match Pod's node affinity\/selector|node\(s\) didn't match node selector|didn't match Pod's node affinity/i, () => ({ key: 'NodeSelector', text: "no node has the labels required by the pod's nodeSelector / node affinity", fix: 'Fix nodeSelector/affinity labels or label the intended nodes.', tag: 'NodeSelector' })],
  [/didn't match pod anti-affinity|didn't satisfy existing pods anti-affinity|didn't match pod affinity/i, () => ({ key: 'PodAffinity', text: 'pod (anti-)affinity rules cannot be satisfied (e.g. more replicas than nodes with required anti-affinity)', fix: 'Use preferredDuringScheduling anti-affinity, or add nodes/zones.', tag: 'Affinity' })],
  [/didn't match pod topology spread constraints/i, () => ({ key: 'TopologySpread', text: 'topology spread constraints cannot be met', fix: 'Relax maxSkew or use whenUnsatisfiable: ScheduleAnyway.', tag: 'Affinity' })],
  [/volume node affinity conflict|had volume node affinity conflict/i, () => ({ key: 'VolumeZone', text: 'the pod\'s PersistentVolume is pinned to a zone/node where the pod cannot run', fix: 'Use a StorageClass with volumeBindingMode: WaitForFirstConsumer, or ensure nodes exist in the volume\'s zone.', tag: 'VolumeZone' })],
  [/unbound immediate PersistentVolumeClaims|persistentvolumeclaim "[^"]+" not found|unbound PersistentVolumeClaims/i, () => ({ key: 'UnboundPVC', text: 'a PersistentVolumeClaim used by the pod is not bound', fix: 'Fix the PVC (see its events): missing StorageClass, provisioner failing, or no matching PV.', tag: 'PVCPending' })],
  [/node\(s\) were unschedulable|unschedulable: true/i, () => ({ key: 'Cordoned', text: 'nodes are cordoned (unschedulable)', fix: 'Uncordon the nodes when maintenance is done.', tag: 'Cordoned' })],
  [/Too many pods/i, () => ({ key: 'TooManyPods', text: 'nodes reached their max-pods limit', fix: 'Add nodes or raise max pods per node (CNI IP limits apply on cloud).', tag: 'InsufficientResources' })],
  [/didn't have free ports/i, () => ({ key: 'HostPort', text: 'the requested hostPort is already used on every node', fix: 'Avoid hostPort, or ensure at most one such pod per node.', tag: 'HostPort' })],
  [/exceed max volume count|max volume count|node\(s\) had volume count limit/i, () => ({ key: 'VolumeLimit', text: 'nodes reached their attachable volume limit', fix: 'Add nodes or use bigger instance types (more attachable volumes).', tag: 'InsufficientResources' })],
  [/node\(s\) had taint \{node\.kubernetes\.io\/(not-ready|unreachable)|node\(s\) were not ready|not-ready/i, () => ({ key: 'NotReady', text: 'nodes are NotReady/unreachable', fix: 'Fix the NotReady nodes (see the Nodes tab).', tag: 'NodeNotReady' })],
  [/node\(s\) had disk pressure|disk-pressure/i, () => ({ key: 'DiskPressure', text: 'nodes have DiskPressure', fix: 'Free disk on nodes.', tag: 'NodePressure' })],
  [/node\(s\) had memory pressure|memory-pressure/i, () => ({ key: 'MemoryPressure', text: 'nodes have MemoryPressure', fix: 'Reduce memory usage or add nodes.', tag: 'NodePressure' })],
  [/no nodes available to schedule pods|0\/0 nodes are available/i, () => ({ key: 'NoNodes', text: 'the cluster has no schedulable nodes at all', fix: 'Add worker nodes / check node pools.', tag: 'NoNodes' })],
  [/node\(s\) didn't have enough resource|exceeds the capacity/i, () => ({ key: 'Capacity', text: 'requests exceed node capacity', fix: 'Lower requests or use larger nodes.', tag: 'InsufficientResources' })],
];

// Parses "0/5 nodes are available: 2 Insufficient memory, 3 node(s) had untolerated taint {...}. preemption: ..."
export function parseSchedulingMessage(message) {
  const m = String(message || '');
  const total = (m.match(/(\d+)\/(\d+) nodes are available/) || [])[2];
  const main = m.split(/preemption:/i)[0];
  const body = main.replace(/^.*?nodes are available:\s*/i, '');
  const parts = body.split(/,\s*(?=\d+\s)/).map((s) => s.trim().replace(/\.$/, '')).filter(Boolean);
  const reasons = [];
  for (const part of parts.length ? parts : [m]) {
    const count = parseInt((part.match(/^(\d+)\s/) || [])[1] || '0', 10) || null;
    for (const [re, fn] of SCHED_REASONS) {
      const x = part.match(re);
      if (x) {
        reasons.push({ count, raw: part, ...fn(x) });
        break;
      }
    }
  }
  return { totalNodes: total ? parseInt(total, 10) : null, reasons, preemptionHelps: /preemption:.*(?!not helpful)/i.test(m) && !/No preemption victims found|Preemption is not helpful/i.test(m) };
}

// ------------------------------------------------------------------- probes

export function explainProbeFailure(message, probeType = 'Readiness') {
  const m = message || '';
  let x;
  if ((x = m.match(/statuscode: (\d+)/i))) {
    const code = +x[1];
    if (code === 404) return r(`${probeType} probe gets HTTP 404: the probe path does not exist in the app.`, ['Fix probe httpGet.path (e.g. /actuator/health, /healthz) and port.'], 'high', { tags: ['ProbeMisconfig'] });
    if (code === 401 || code === 403) return r(`${probeType} probe gets HTTP ${code}: the health endpoint requires authentication.`, ['Expose an unauthenticated health endpoint for probes.'], 'high', { tags: ['ProbeMisconfig'] });
    if (code >= 500) return r(`${probeType} probe gets HTTP ${code}: the app reports itself unhealthy (often a failing dependency such as a database included in the health check).`, ['Check the app logs; avoid including external dependencies in liveness checks.'], 'medium', { tags: ['AppUnhealthy'] });
    return r(`${probeType} probe gets unexpected HTTP ${code}.`, ['Probes succeed only on 200-399; adjust the endpoint or path.'], 'medium');
  }
  if (/connection refused/i.test(m)) {
    return r(`${probeType} probe: connection refused — nothing listens on the probed port yet (app still starting, crashed, listens on a different port, or binds only to 127.0.0.1).`, ['Check the port the app listens on matches the probe port; bind to 0.0.0.0; add a startupProbe for slow starts.'], 'medium', { tags: ['ProbeFailure'] });
  }
  if (/context deadline exceeded|Client\.Timeout|timeout|timed out/i.test(m)) {
    return r(`${probeType} probe timed out: the endpoint answers slower than timeoutSeconds (default 1s) — app overloaded, CPU-throttled, GC pauses, or a slow dependency in the health check.`, ['Raise timeoutSeconds, make the health endpoint cheap, check CPU limits/throttling.'], 'medium', { tags: ['ProbeFailure'] });
  }
  if (/no route to host|i\/o timeout|network is unreachable/i.test(m)) {
    return r(`${probeType} probe cannot reach the pod IP (CNI/network problem on the node).`, ['Check the CNI pods on the node and NetworkPolicies are not blocking kubelet.'], 'low', { tags: ['Network'] });
  }
  if (/connection reset by peer|EOF/i.test(m)) {
    return r(`${probeType} probe: connection reset — the app accepts and drops the connection (wrong protocol, e.g. HTTP probe on an HTTPS/gRPC port).`, ['Set scheme: HTTPS for TLS ports, or use a grpc/tcpSocket probe.'], 'medium', { tags: ['ProbeMisconfig'] });
  }
  if (/OCI runtime exec failed|executable file not found|not found/i.test(m)) {
    return r(`${probeType} exec probe command does not exist in the image.`, ['Fix the probe command (distroless images have no shell/curl).'], 'high', { tags: ['ProbeMisconfig'] });
  }
  return r(`${probeType} probe is failing: ${m.slice(0, 200)}`, ['Run the probe manually against the pod and compare with the probe configuration.'], 'low', { tags: ['ProbeFailure'] });
}

// --------------------------------------------------------------- volumes

export function explainMountFailure(message) {
  const m = message || '';
  let x;
  if (/Multi-Attach error/i.test(m)) {
    return r('Multi-Attach error: the ReadWriteOnce volume is still attached to another node (typically the old pod during a rolling update, or a pod on a dead node).', ['Use strategy: Recreate for Deployments with RWO volumes, or a StatefulSet; if the old node is dead, wait for the attach-detach timeout (~6 min) or remove the stale VolumeAttachment.'], 'high', { tags: ['MultiAttach'] });
  }
  if ((x = m.match(/secret "([^"]+)" not found/i))) return explainContainerConfigError(m);
  if ((x = m.match(/configmaps? "([^"]+)" not found/i))) return explainContainerConfigError(m);
  if ((x = m.match(/persistentvolumeclaim "([^"]+)" not found/i))) {
    return r(`PersistentVolumeClaim "${x[1]}" does not exist.`, ['Create the PVC or fix claimName.'], 'high', { tags: ['PVCMissing'] });
  }
  if ((x = m.match(/driver name (\S+) not found in the list of registered CSI drivers/i))) {
    return r(`CSI driver ${x[1]} is not running on this node (its node plugin DaemonSet pod is missing or crashing).`, [`Check the ${x[1]} node-plugin pods (kube-system) on that node.`], 'high', { tags: ['CSIDriver'] });
  }
  if (/mount\.nfs|nfs: server|exit status 32|Connection timed out.*mount|mount failed/i.test(m)) {
    return r('The network filesystem (NFS/SMB/CephFS…) could not be mounted: server unreachable, export missing, or client tools missing on the node.', ['Test the mount from the node; check firewall, export path, and nfs-utils/cifs-utils on nodes.'], 'medium', { tags: ['MountFailed'] });
  }
  if (/AttachVolume\.Attach failed|attachdetach|FailedAttachVolume|rpc error: code = (Internal|Unavailable|ResourceExhausted)/i.test(m)) {
    return r('The cloud/CSI provider failed to attach the disk to the node (attach limit reached, disk in another zone, or provider API error).', ['Check the CSI controller logs and the cloud console for the disk state.'], 'medium', { tags: ['AttachFailed'] });
  }
  if (/Unable to attach or mount volumes|timed out waiting for the condition/i.test(m)) {
    const um = m.match(/unmounted volumes=\[([^\]]*)\]/);
    return r(`Volumes could not be mounted in time${um ? `: ${um[1]}` : ''}. The underlying error is usually in another FailedMount/FailedAttachVolume event.`, ['Read all volume events of the pod; check the PVC is Bound and the CSI driver pods are healthy.'], 'low', { tags: ['MountFailed'] });
  }
  return r(`Volume mount failed: ${m.slice(0, 200)}`, ['Inspect the pod events and the CSI driver logs.'], 'low', { tags: ['MountFailed'] });
}

export function explainSandboxFailure(message) {
  const m = message || '';
  if (/network plugin is not ready|cni config uninitialized|NetworkPluginNotReady|failed to find plugin|no networks found/i.test(m)) {
    return r('The CNI network plugin is not ready on the node, so no pod network can be created.', ['Check the CNI DaemonSet pods (calico/cilium/aws-node/flannel…) on that node.'], 'high', { tags: ['CNI'] });
  }
  if (/no IP addresses available|failed to assign an IP address|InsufficientFreeAddresses|ipam|IP address.*exhausted|failed to allocate/i.test(m)) {
    return r('The node/subnet ran out of pod IP addresses.', ['Free IPs (delete Completed pods), enlarge the pod CIDR/subnet, or enable prefix delegation (AWS VPC CNI).'], 'high', { tags: ['IPExhaustion'] });
  }
  if (/pause|sandbox image/i.test(m) && /pull|not found|unauthorized/i.test(m)) {
    return r('The node cannot pull the pod sandbox ("pause") image.', ['Make the pause image reachable (private mirror in air-gapped clusters).'], 'high', { tags: ['CNI'] });
  }
  if (/OCI runtime create failed|runc create failed|failed to create shim|failed to start shim|can't get final child's PID|cgroup/i.test(m)) {
    return r('The low-level container runtime (runc/crun) fails to start any container on this node: cgroup, seccomp/AppArmor, kernel or nested-virtualization problem, or a broken containerd/runc install.', ['Check `journalctl -u containerd` / kubelet logs on the node, runc version, and cgroup configuration; drain and replace the node if it persists.'], 'medium', { tags: ['Runtime'] });
  }
  return r('The container runtime could not create the pod sandbox (network namespace).', ['Check CNI and containerd logs on the node.'], 'low', { tags: ['Sandbox'] });
}

// ----------------------------------------------------- controllers: create

export function explainFailedCreate(message) {
  const m = message || '';
  let x;
  if ((x = m.match(/exceeded quota: ([\w.-]+), requested: ([^,]+(?:,[^,]+)*?), used: (.+?), limited: (.+?)$/im)) || (x = m.match(/exceeded quota: ([\w.-]+)/i))) {
    return r(`ResourceQuota "${x[1]}" is exhausted${x[2] ? ` (requested ${x[2]}, used ${x[3]}, limited ${x[4]})` : ''}, so new pods are rejected.`, ['Raise the quota, scale down other workloads in the namespace, or lower requests/limits.'], 'high', { tags: ['QuotaExceeded'], extracted: { quota: x[1] } });
  }
  if ((x = m.match(/failed quota: ([\w.-]+): must specify ([\w.,]+)/i)) || (x = m.match(/must specify (limits|requests)[\w., ]*/i))) {
    return r(`A ResourceQuota requires every pod to declare ${x[2] || x[1]}, and this pod template doesn't.`, ['Add resources.requests/limits to every container (init containers too) or define a LimitRange with defaults.'], 'high', { tags: ['QuotaExceeded'], extracted: x[2] ? { quota: x[1] } : undefined });
  }
  if ((x = m.match(/violates PodSecurity "([\w-]+):([\w.]+)": (.+)$/im))) {
    return r(`Pod Security Admission (${x[1]}) rejected the pod: ${x[3]}`, ['Make the pod comply (runAsNonRoot, drop capabilities, no hostPath/privileged, seccompProfile RuntimeDefault) or relabel the namespace pod-security level if justified.'], 'high', { tags: ['PodSecurity'] });
  }
  if ((x = m.match(/admission webhook "([^"]+)" denied the request:?\s*(.*)$/im))) {
    return r(`Admission webhook "${x[1]}" (a policy engine such as Kyverno/Gatekeeper) denied the pod: ${x[2] || 'no reason given'}`, ['Adjust the pod spec to satisfy the policy, or ask the policy owners for an exception.'], 'high', { tags: ['WebhookDenied'], extracted: { webhook: x[1] } });
  }
  if ((x = m.match(/failed calling webhook "([^"]+)":?\s*(.*)$/im))) {
    return r(`Admission webhook "${x[1]}" is unreachable (${(x[2] || '').slice(0, 160)}), and its failurePolicy rejects requests when it is down.`, ['Fix the webhook\'s backend pods/service, or temporarily set failurePolicy: Ignore (requires admin).'], 'high', { tags: ['WebhookDown'], extracted: { webhook: x[1] } });
  }
  if ((x = m.match(/serviceaccount "([^"]+)" not found|error looking up service account [\w-]+\/([\w.-]+)/i))) {
    return r(`ServiceAccount "${x[1] || x[2]}" does not exist in the namespace.`, ['Create the ServiceAccount or fix serviceAccountName.'], 'high', { tags: ['MissingServiceAccount'] });
  }
  if (/unable to validate against any security context constraint/i.test(m)) {
    return r('OpenShift SecurityContextConstraints reject the pod.', ['Grant an appropriate SCC to the ServiceAccount or make the pod comply with restricted-v2.'], 'high', { tags: ['PodSecurity'] });
  }
  if ((x = m.match(/(maximum|minimum) (cpu|memory|ephemeral-storage) usage per (Container|Pod) is (\S+)/i))) {
    return r(`A LimitRange forbids this pod: ${x[0]}.`, ['Adjust container resources to fit the namespace LimitRange.'], 'high', { tags: ['LimitRange'] });
  }
  if (/no PriorityClass with name|PriorityClass .* not found/i.test(m)) {
    return r('The pod references a PriorityClass that does not exist.', ['Create the PriorityClass or fix priorityClassName.'], 'high');
  }
  return r(`The controller cannot create pods: ${m.slice(0, 220)}`, ['Read the controller events for the full API error.'], 'low');
}

// --------------------------------------------------------------- storage

export function explainPvcPending(message, { storageClassName, classes = [], defaultClass } = {}) {
  const m = message || '';
  let x;
  if (storageClassName && classes.length && !classes.includes(storageClassName)) {
    return r(`StorageClass "${storageClassName}" does not exist in the cluster (available: ${classes.join(', ') || 'none'}).`, ['Fix storageClassName or create the StorageClass.'], 'high', { tags: ['StorageClass'] });
  }
  if ((x = m.match(/storageclass\.storage\.k8s\.io "([^"]+)" not found/i))) {
    return r(`StorageClass "${x[1]}" does not exist.`, ['Fix storageClassName or create the StorageClass.'], 'high', { tags: ['StorageClass'] });
  }
  if (/no persistent volumes available for this claim and no storage class is set/i.test(m) || (storageClassName === undefined && !defaultClass && !m)) {
    return r('The claim has no storageClassName and the cluster has no default StorageClass, so nothing will provision a volume.', ['Set storageClassName, or mark a StorageClass as default (storageclass.kubernetes.io/is-default-class=true), or create a matching PV.'], 'high', { tags: ['StorageClass'] });
  }
  if (/waiting for first consumer/i.test(m)) {
    return r('The StorageClass uses WaitForFirstConsumer: the volume is only provisioned once a pod using the claim is scheduled.', ['Normal if no pod uses it yet; otherwise look at why the consuming pod is not scheduled.'], 'medium', { tags: ['WaitForFirstConsumer'] });
  }
  if ((x = m.match(/waiting for a volume to be created,? either by (?:the )?external provisioner "([^"]+)"/i))) {
    return r(`The external provisioner "${x[1]}" has not created the volume: its controller is missing, crashing, or failing (cloud quota/permissions).`, [`Check the ${x[1]} CSI controller pods and their logs.`], 'medium', { tags: ['Provisioner'] });
  }
  if (/ProvisioningFailed|failed to provision volume/i.test(m) || m) {
    return r(`Volume provisioning failed: ${m.slice(0, 240)}`, ['Check the CSI controller logs; common causes are cloud quota, invalid parameters, or missing IAM permissions.'], 'medium', { tags: ['Provisioner'] });
  }
  return r('The claim is waiting for a matching PersistentVolume.', ['Check capacity/accessModes/selector match an available PV, or use dynamic provisioning.'], 'low', { tags: ['PVCPending'] });
}

// --------------------------------------------------------------- eviction

export function explainEviction(message) {
  const m = message || '';
  let x;
  if ((x = m.match(/low on resource: ([\w-]+)/i))) {
    const res = x[1];
    const users = [...m.matchAll(/Container ([\w.-]+) was using (\S+?), request is (\S+?)(?:,|\.|\s|$)/g)].map((c) => `${c[1]} used ${c[2]} (request ${c[3]})`);
    return r(`Evicted because node ${res === 'memory' ? 'memory' : res} was running low${users.length ? `; ${users.join('; ')}` : ''}. Pods using more than their requests are evicted first.`, [res === 'memory' ? 'Set memory requests close to real usage (or requests=limits for Guaranteed QoS) and add node capacity.' : 'Limit log/emptyDir/ephemeral usage (resources.limits.ephemeral-storage), clean node disks, enlarge root volumes.'], 'high', { tags: ['NodePressure', res === 'memory' ? 'MemoryPressure' : 'DiskPressure'] });
  }
  if (/ephemeral local storage usage exceeds|exceeded its local ephemeral storage limit|Usage of EmptyDir volume/i.test(m)) {
    return r(`Evicted for exceeding its ephemeral-storage limit: ${m.slice(0, 200)}`, ['Raise ephemeral-storage limits/emptyDir sizeLimit, or write less to the container filesystem (logs, temp files).'], 'high', { tags: ['EphemeralStorage'] });
  }
  if (/taint|NoExecute/i.test(m)) {
    return r('Evicted because the node received a NoExecute taint (node unreachable/not-ready or maintenance).', ['Check the node status; add tolerations with tolerationSeconds if needed.'], 'medium', { tags: ['Taints'] });
  }
  return r(`Evicted by the kubelet: ${m.slice(0, 200)}`, ['Check node conditions at the time of eviction.'], 'low');
}

// ---------------------------------------------------------- runtime hints

// Infers memory-relevant runtime settings (JVM heap, Node.js heap) from the container spec.
export function runtimeHints(spec = {}) {
  const env = {};
  for (const e of spec.env || []) if (e.value != null) env[e.name] = e.value;
  const cmd = [...(spec.command || []), ...(spec.args || [])].join(' ');
  const javaOpts = [env.JAVA_OPTS, env.JAVA_TOOL_OPTIONS, env.JDK_JAVA_OPTIONS, env._JAVA_OPTIONS, env.CATALINA_OPTS, env.ES_JAVA_OPTS, env.KAFKA_HEAP_OPTS, cmd].filter(Boolean).join(' ');
  const xmx = javaOpts.match(/-Xmx(\d+[kKmMgG]?)\b/);
  const maxRam = javaOpts.match(/-XX:MaxRAMPercentage=([\d.]+)/);
  const isJava = /(java|jdk|jre|temurin|corretto|openjdk|zulu|spring|tomcat|wildfly|jboss|keycloak|elasticsearch|opensearch|kafka|zookeeper|solr|quarkus|jenkins|sonarqube|nexus|cassandra|liferay)/i.test(spec.image || '') || !!xmx || !!maxRam || /\bjava\b/.test(cmd);
  const nodeOpts = `${env.NODE_OPTIONS || ''} ${cmd}`;
  const oldSpace = nodeOpts.match(/--max-old-space-size=(\d+)/);
  const isNode = /(^|\/)(node|nodejs)(:|$)|node:|nodejs/i.test(spec.image || '') || !!oldSpace;
  return {
    isJava,
    xmx: xmx ? xmx[1] : null,
    maxRamPercentage: maxRam ? parseFloat(maxRam[1]) : null,
    isNode,
    maxOldSpaceMb: oldSpace ? parseInt(oldSpace[1], 10) : null,
    isPython: /python|django|flask|uvicorn|gunicorn/i.test(`${spec.image} ${cmd}`),
    isGo: /golang|distroless\/static/i.test(spec.image || ''),
  };
}
