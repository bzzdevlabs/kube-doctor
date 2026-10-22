// Fake kubectl backed by the demo fixtures. It answers the exact read-only
// commands the real collector issues, so demo mode exercises the real code path.
import type { Kubectl, RunOptions } from '../types.js';
import { assertReadOnly, KubectlError } from '../kubectl.js';
import { buildDemoCluster } from './fixtures.js';

const RESOURCE_KEYS: Record<string, string> = {
  nodes: 'nodes', node: 'nodes', namespaces: 'namespaces', persistentvolumes: 'pvs', 'storageclasses.storage.k8s.io': 'storageclasses',
  'ingressclasses.networking.k8s.io': 'ingressclasses', 'apiservices.apiregistration.k8s.io': 'apiservices',
  'validatingwebhookconfigurations.admissionregistration.k8s.io': 'validatingwebhooks', 'mutatingwebhookconfigurations.admissionregistration.k8s.io': 'mutatingwebhooks',
  pods: 'pods', pod: 'pods', events: 'events', 'deployments.apps': 'deployments', 'replicasets.apps': 'replicasets', 'statefulsets.apps': 'statefulsets',
  'daemonsets.apps': 'daemonsets', 'jobs.batch': 'jobs', 'cronjobs.batch': 'cronjobs', services: 'services', 'endpointslices.discovery.k8s.io': 'endpointslices',
  'ingresses.networking.k8s.io': 'ingresses', persistentvolumeclaims: 'pvcs', 'horizontalpodautoscalers.autoscaling': 'hpas', 'poddisruptionbudgets.policy': 'pdbs',
  resourcequotas: 'resourcequotas', serviceaccounts: 'serviceaccounts',
};

const CONTEXT = 'demo-cluster';

export function createDemoKubectl(): Kubectl {
  let cluster = buildDemoCluster();
  let builtAt = Date.now();

  function opt(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  }

  async function run(argsIn: string[], { context }: RunOptions = {}): Promise<string> {
    assertReadOnly(argsIn);
    if (context && context !== CONTEXT) throw new KubectlError(`context "${context}" does not exist`, { kind: 'nocontext' });
    const args = argsIn.filter((a) => !a.startsWith('--request-timeout') && !a.startsWith('--context'));
    await new Promise((r) => setTimeout(r, 15));
    const [verb, sub] = args;

    if (verb === 'config') {
      if (sub === 'get-contexts') return `${CONTEXT}\n`;
      if (sub === 'current-context') return `${CONTEXT}\n`;
      if (sub === 'view') return JSON.stringify({ contexts: [{ name: CONTEXT, context: { cluster: 'demo', user: 'demo-admin', namespace: 'shop' } }], clusters: [{ name: 'demo', cluster: { server: 'https://demo.k8s.local:6443' } }] });
    }
    if (verb === 'version') {
      if (Date.now() - builtAt > 5 * 60_000) {
        cluster = buildDemoCluster();
        builtAt = Date.now();
      }
      return JSON.stringify({ clientVersion: { gitVersion: 'v1.30.4' }, serverVersion: { gitVersion: 'v1.30.4-demo' } });
    }
    const { data, logs, top } = cluster;

    if (verb === 'get' && sub === '--raw') {
      return '[+]ping ok\n[+]log ok\n[+]etcd ok\n[+]etcd-readiness ok\n[+]informer-sync ok\n[+]poststarthook/start-apiserver-admission-initializer ok\nreadyz check passed\n';
    }
    if (verb === 'get') {
      const key = RESOURCE_KEYS[sub ?? ''];
      if (!key) throw new KubectlError(`error: the server doesn't have a resource type "${sub}"`, { kind: 'unsupported' });
      let items = data[key ?? ''] || [];
      const ns = opt(args, '-n');
      if (ns) items = items.filter((o) => o.metadata.namespace === ns);
      const fs = opt(args, '--field-selector');
      if (fs) {
        const name = (fs.match(/involvedObject\.name=([^,]+)/) || [])[1];
        items = items.filter((e) => e.involvedObject?.name === name);
      }
      const name = args[2] && !args[2].startsWith('-') ? args[2] : null;
      if (name) {
        const o = items.find((x) => x.metadata.name === name);
        if (!o) throw new KubectlError(`Error from server (NotFound): ${sub} "${name}" not found`, { kind: 'notfound' });
        return JSON.stringify(o);
      }
      return JSON.stringify({ apiVersion: 'v1', kind: 'List', items });
    }
    if (verb === 'top') {
      if (sub === 'nodes' || sub === 'node') return top.nodes.map((n) => `${n.name} ${n.cpu} ${n.cpuPct}% ${n.memory} ${n.memoryPct}%`).join('\n');
      const ns = opt(args, '-n');
      const podName = sub === 'pod' && args[2] && !args[2].startsWith('-') ? args[2] : null;
      const rows = top.pods.filter((p) => (!ns || p.namespace === ns) && (!podName || p.pod === podName));
      if (podName && !rows.length) throw new KubectlError('error: metrics not available yet', { kind: 'unsupported' });
      return rows.map((p) => (ns ? `${p.pod} ${p.container} ${p.cpu} ${p.memory}` : `${p.namespace} ${p.pod} ${p.container} ${p.cpu} ${p.memory}`)).join('\n');
    }
    if (verb === 'logs') {
      const ns = opt(args, '-n');
      const podName = args.find((a, i) => i > 0 && !a.startsWith('-') && args[i - 1] !== '-n' && args[i - 1] !== '-c');
      const c = opt(args, '-c');
      const previous = args.includes('--previous');
      const pod = (data.pods || []).find((p) => p.metadata.namespace === ns && p.metadata.name === podName);
      if (!pod) throw new KubectlError(`Error from server (NotFound): pods "${podName}" not found`, { kind: 'notfound' });
      let text = logs[`${ns}/${podName}/${c}/${previous ? 'previous' : 'current'}`];
      if (text == null) {
        const cs = (pod.status.containerStatuses || []).find((s: { name: string }) => s.name === c);
        if (previous) throw new KubectlError(`previous terminated container "${c}" in pod "${podName}" not found`, { kind: 'notfound' });
        if (cs?.state?.waiting && !cs.lastState?.terminated) throw new KubectlError(`container "${c}" in pod "${podName}" is waiting to start: ${cs.state.waiting.reason}`, { kind: 'notready' });
        text = cs?.state?.running ? `${new Date().toISOString()} (demo) ${c} is running normally` : '';
      }
      if (!args.includes('--timestamps')) text = text.split('\n').map((l) => l.replace(/^\S+Z /, '')).join('\n');
      return `${text}\n`;
    }
    throw new KubectlError(`demo kubectl: unsupported command ${args.join(' ')}`, { kind: 'unsupported' });
  }

  async function json<T>(args: string[], opts?: RunOptions): Promise<T> {
    return JSON.parse(await run([...args, '-o', 'json'], opts)) as T;
  }

  return { run, json, bin: 'demo', demo: true };
}
