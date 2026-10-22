// Node health: readiness, pressure conditions, cordons, kernel OOMs, usage.
import { ageMs, fmtAge, fmtBytes, pct, truncate, eventCount, eventTime } from './util.js';

export function analyzeNodes(snap, out) {
  for (const node of snap.list('nodes')) {
    const name = node.metadata.name;
    const object = { kind: 'Node', namespace: '', name };
    const conds = node.status?.conditions || [];
    const ready = conds.find((c) => c.type === 'Ready');
    const pods = (snap.podsByNode.get(name) || []).filter((p) => !['Succeeded', 'Failed'].includes(p.status?.phase));
    const events = snap.eventsFor('Node', '', name);
    const commands = [snap.cmd(`describe node ${name}`), snap.cmd(`get pods -A -o wide --field-selector spec.nodeName=${name}`)];
    const taints = (node.spec?.taints || []).map((t) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`);
    const base = { object, commands, node: name };

    if (!ready || ready.status !== 'True') {
      const msg = ready?.message || '';
      let summary;
      let fixes;
      if (!ready || ready.status === 'Unknown' || /stopped posting node status/i.test(msg)) {
        summary = `The kubelet on ${name} stopped reporting ${ready?.lastHeartbeatTime ? `${fmtAge(ageMs(ready.lastHeartbeatTime))} ago` : ''}: the machine is down/rebooting, the kubelet crashed, it is starved of CPU/memory, or the network to the control plane is broken.`;
        fixes = ['Check the VM/instance state in your cloud console or hypervisor.', 'On the node: `systemctl status kubelet` and `journalctl -u kubelet`.', 'Pods on an unreachable node are evicted after ~5 minutes (StatefulSet pods are not recreated until the node is confirmed gone).'];
      } else if (/container runtime is down|container runtime status check may not have completed/i.test(msg)) {
        summary = `The container runtime (containerd/CRI-O) on ${name} is down.`;
        fixes = ['Restart/inspect containerd on the node: `systemctl status containerd`.'];
      } else if (/PLEG is not healthy/i.test(msg)) {
        summary = `PLEG is not healthy on ${name}: the kubelet cannot list containers in time (runtime overloaded, too many containers, slow disk).`;
        fixes = ['Check runtime health, disk I/O and the number of containers on the node.'];
      } else if (/network plugin|NetworkReady=false|cni/i.test(msg)) {
        summary = `The CNI network plugin is not ready on ${name}, so pods cannot get network.`;
        fixes = ['Check the CNI DaemonSet pod on this node (calico/cilium/flannel/aws-node…).'];
      } else {
        summary = `Node ${name} reports NotReady: ${msg || ready.reason}`;
        fixes = ['Check kubelet logs on the node.'];
      }
      out.add({
        ...base, category: 'NodeNotReady', severity: 'critical',
        title: `Node ${name} is ${ready?.status === 'Unknown' ? 'unreachable (Unknown)' : 'NotReady'} since ${fmtAge(ageMs(ready?.lastTransitionTime))}`,
        rootCause: { summary, confidence: 'high' },
        evidence: [`Ready=${ready?.status || 'missing'} reason=${ready?.reason || '?'}: ${msg}`, `${pods.length} pod(s) scheduled on it`, taints.length ? `Taints: ${taints.join(', ')}` : null].filter(Boolean),
        fixes, since: Date.parse(ready?.lastTransitionTime) || null,
      });
    }

    const pressures = {
      MemoryPressure: ['memory is running low; the kubelet evicts pods (BestEffort first, then pods exceeding their requests)', 'Set memory requests close to real usage, find the consumers (`kubectl top pods -A --sort-by=memory`), add capacity.'],
      DiskPressure: ['the root or image filesystem is almost full; the kubelet garbage-collects images and evicts pods', 'Free space: container logs, emptyDir usage, unused images; enlarge the disk; set ephemeral-storage limits.'],
      PIDPressure: ['the node is running out of process IDs (fork bomb or thread leak in some pod)', 'Find the pod with a process/thread leak; set podPidsLimit.'],
      NetworkUnavailable: ['the node network is not configured (routes / CNI)', 'Check the CNI and cloud routes for this node.'],
    };
    for (const [type, [why, fix]] of Object.entries(pressures)) {
      const c = conds.find((x) => x.type === type);
      if (c?.status !== 'True') continue;
      out.add({
        ...base, category: 'NodePressure', severity: type === 'NetworkUnavailable' ? 'critical' : 'warning', tags: [type],
        title: `Node ${name} has ${type}`,
        rootCause: { summary: `${type} on ${name}: ${why}.`, confidence: 'high' },
        evidence: [`${type}=True since ${fmtAge(ageMs(c.lastTransitionTime))}: ${c.message || c.reason}`],
        fixes: [fix], since: Date.parse(c.lastTransitionTime) || null,
      });
    }

    const oom = events.filter((e) => /SystemOOM|OOMKilling/i.test(e.reason || ''));
    if (oom.length) {
      const victims = oom.map((e) => (e.message.match(/victim process: ([^,]+)/i) || [])[1]).filter(Boolean);
      out.add({
        ...base, category: 'NodeOOM', severity: 'warning', tags: ['OOMKilled'],
        title: `Kernel OOM killer fired on node ${name} (${oom.reduce((a, e) => a + eventCount(e), 0)}x)`,
        rootCause: { summary: `Node ${name} ran out of memory and the kernel killed processes${victims.length ? ` (${[...new Set(victims)].slice(0, 5).join(', ')})` : ''}. Usually caused by pods without memory limits, or limits much larger than requests (overcommit).`, confidence: 'high' },
        evidence: oom.slice(0, 5).map((e) => truncate(e.message, 200)),
        fixes: ['Give every pod memory requests and limits; keep the sum of limits close to node allocatable.'],
        lastSeen: eventTime(oom[0]),
      });
    }

    if (node.spec?.unschedulable) {
      out.add({
        ...base, category: 'NodeCordoned', severity: 'info',
        title: `Node ${name} is cordoned (SchedulingDisabled)`,
        rootCause: { summary: 'The node was cordoned (maintenance/drain/upgrade); no new pods will be scheduled on it.', confidence: 'high' },
        evidence: [taints.length ? `Taints: ${taints.join(', ')}` : 'spec.unschedulable=true'],
        fixes: ['Uncordon it when maintenance is over (`kubectl uncordon`).'],
      });
    }

    const usage = snap.nodeUsage.get(name);
    const alloc = snap.nodeAllocation(name);
    if (usage && usage.memoryPct >= 90 && !conds.some((c) => c.type === 'MemoryPressure' && c.status === 'True')) {
      out.add({
        ...base, category: 'NodePressure', severity: 'warning', tags: ['HighMemoryUsage'],
        title: `Node ${name} memory usage at ${usage.memoryPct}%`,
        rootCause: { summary: `Node ${name} uses ${fmtBytes(usage.memory)} (${usage.memoryPct}% of allocatable). Evictions and OOM kills start soon.`, confidence: 'medium' },
        evidence: [`Requests ${fmtBytes(alloc.reqMemory)} / limits ${fmtBytes(alloc.limMemory)} / allocatable ${fmtBytes(alloc.memory)}`],
        fixes: ['Rebalance workloads or add capacity; check pods with no memory limits.'],
      });
    }
    if (!alloc.partial && alloc.memory && alloc.limMemory > alloc.memory * 1.5 && usage?.memoryPct >= 75) {
      out.add({
        ...base, category: 'NodePressure', severity: 'info', tags: ['Overcommit'],
        title: `Node ${name} memory limits overcommitted (${pct(alloc.limMemory, alloc.memory)}% of allocatable)`,
        rootCause: { summary: 'The sum of memory limits far exceeds allocatable memory while usage is high: if several pods burst together, the node will OOM-kill or evict.', confidence: 'medium' },
        evidence: [`Limits ${fmtBytes(alloc.limMemory)}, requests ${fmtBytes(alloc.reqMemory)}, allocatable ${fmtBytes(alloc.memory)}, usage ${usage ? fmtBytes(usage.memory) : '?'}`],
        fixes: ['Bring memory requests closer to limits for critical workloads.'],
      });
    }
    if (alloc.maxPods && alloc.pods >= alloc.maxPods) {
      out.add({ ...base, category: 'NodePressure', severity: 'warning', tags: ['TooManyPods'], title: `Node ${name} is at its max pods (${alloc.pods}/${alloc.maxPods})`, rootCause: { summary: 'No more pods can be scheduled on this node regardless of CPU/memory.', confidence: 'high' }, evidence: [], fixes: ['Add nodes or raise maxPods (subject to CNI IP limits).'] });
    }
  }
}

export function nodeSummaries(snap) {
  return snap.list('nodes').map((node) => {
    const name = node.metadata.name;
    const conds = node.status?.conditions || [];
    const ready = conds.find((c) => c.type === 'Ready');
    const labels = node.metadata.labels || {};
    const roles = Object.keys(labels).filter((k) => k.startsWith('node-role.kubernetes.io/')).map((k) => k.split('/')[1] || 'role');
    const alloc = snap.nodeAllocation(name);
    const usage = snap.nodeUsage.get(name) || null;
    return {
      name,
      ready: ready?.status === 'True' ? 'Ready' : ready?.status === 'Unknown' ? 'Unknown' : 'NotReady',
      readySince: ready?.lastTransitionTime,
      roles: roles.length ? roles : ['worker'],
      cordoned: !!node.spec?.unschedulable,
      problems: conds.filter((c) => (c.type === 'Ready' ? c.status !== 'True' : c.status === 'True')).map((c) => ({ type: c.type, reason: c.reason, message: c.message })),
      taints: (node.spec?.taints || []).map((t) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`),
      version: node.status?.nodeInfo?.kubeletVersion,
      os: `${node.status?.nodeInfo?.osImage || ''}`.trim(),
      arch: node.status?.nodeInfo?.architecture,
      runtime: node.status?.nodeInfo?.containerRuntimeVersion,
      instanceType: labels['node.kubernetes.io/instance-type'] || labels['beta.kubernetes.io/instance-type'] || null,
      zone: labels['topology.kubernetes.io/zone'] || null,
      created: node.metadata.creationTimestamp,
      alloc,
      usage,
    };
  });
}
