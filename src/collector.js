// Gathers a read-only snapshot of the cluster behind a kube context.
import { KubectlError } from './kubectl.js';
import { mapLimit, parseQuantity } from './analyzer/util.js';

// [key, kubectl resource, scope]. Secrets and ConfigMaps are deliberately never read.
const RESOURCES = [
  ['nodes', 'nodes', 'cluster'],
  ['namespaces', 'namespaces', 'cluster'],
  ['pvs', 'persistentvolumes', 'cluster'],
  ['storageclasses', 'storageclasses.storage.k8s.io', 'cluster'],
  ['ingressclasses', 'ingressclasses.networking.k8s.io', 'cluster'],
  ['apiservices', 'apiservices.apiregistration.k8s.io', 'cluster'],
  ['validatingwebhooks', 'validatingwebhookconfigurations.admissionregistration.k8s.io', 'cluster'],
  ['mutatingwebhooks', 'mutatingwebhookconfigurations.admissionregistration.k8s.io', 'cluster'],
  ['pods', 'pods', 'ns'],
  ['events', 'events', 'ns'],
  ['deployments', 'deployments.apps', 'ns'],
  ['replicasets', 'replicasets.apps', 'ns'],
  ['statefulsets', 'statefulsets.apps', 'ns'],
  ['daemonsets', 'daemonsets.apps', 'ns'],
  ['jobs', 'jobs.batch', 'ns'],
  ['cronjobs', 'cronjobs.batch', 'ns'],
  ['services', 'services', 'ns'],
  ['endpointslices', 'endpointslices.discovery.k8s.io', 'ns'],
  ['ingresses', 'ingresses.networking.k8s.io', 'ns'],
  ['pvcs', 'persistentvolumeclaims', 'ns'],
  ['hpas', 'horizontalpodautoscalers.autoscaling', 'ns'],
  ['pdbs', 'poddisruptionbudgets.policy', 'ns'],
  ['resourcequotas', 'resourcequotas', 'ns'],
  ['serviceaccounts', 'serviceaccounts', 'ns'],
];

export const RESOURCE_KEYS = RESOURCES.map((r) => r[0]);

export async function listContexts(kubectl) {
  const [names, current] = await Promise.allSettled([
    kubectl.run(['config', 'get-contexts', '-o', 'name']),
    kubectl.run(['config', 'current-context']),
  ]);
  if (names.status === 'rejected') throw names.reason;
  return {
    contexts: names.value.split('\n').map((s) => s.trim()).filter(Boolean),
    current: current.status === 'fulfilled' ? current.value.trim() : null,
  };
}

export async function contextInfo(kubectl, context) {
  const cfg = await kubectl.json(['config', 'view', '--minify'], { context });
  const ctx = cfg.contexts?.[0];
  const cluster = cfg.clusters?.[0];
  if (!ctx) throw new KubectlError('No current kube context is set. Run "kubectl config use-context <name>" first.', { kind: 'nocontext' });
  return {
    context: ctx.name,
    cluster: ctx.context?.cluster || cluster?.name,
    user: ctx.context?.user,
    namespace: ctx.context?.namespace || 'default',
    server: cluster?.cluster?.server,
  };
}

function errInfo(e) {
  return { kind: e.kind || 'error', message: e.message, detail: e.stderr && e.stderr !== e.message ? e.stderr.slice(0, 2000) : undefined };
}

export async function collect(kubectl, { context, namespace } = {}) {
  const startedAt = Date.now();
  const info = await contextInfo(kubectl, context);
  const opts = { context: info.context };

  // Fail fast with a clear message if the API server is unreachable / credentials are bad.
  let version = null;
  try {
    const v = await kubectl.json(['version'], opts);
    version = v.serverVersion?.gitVersion || null;
    if (!v.serverVersion) throw new KubectlError('The API server did not report its version', { kind: 'unreachable' });
  } catch (e) {
    throw e instanceof KubectlError ? e : new KubectlError(String(e.message || e));
  }

  const data = {};
  const coverage = [];

  const fetchList = async ([key, resource, scope]) => {
    const t0 = Date.now();
    const scopeArgs = scope === 'cluster' ? [] : namespace ? ['-n', namespace] : ['-A'];
    try {
      const list = await kubectl.json(['get', resource, ...scopeArgs], opts);
      data[key] = list.items || [];
      coverage.push({ key, resource, status: 'ok', count: data[key].length, scope: scopeArgs.join(' ') || 'cluster', ms: Date.now() - t0 });
    } catch (e) {
      // Cluster-wide list forbidden? Fall back to the context's own namespace.
      if (e.kind === 'forbidden' && scope === 'ns' && !namespace) {
        try {
          const list = await kubectl.json(['get', resource, '-n', info.namespace], opts);
          data[key] = list.items || [];
          coverage.push({ key, resource, status: 'partial', count: data[key].length, scope: `-n ${info.namespace}`, message: `Cluster-wide list is forbidden; only namespace "${info.namespace}" was scanned.`, ms: Date.now() - t0 });
          return;
        } catch (e2) {
          e = e2;
        }
      }
      data[key] = [];
      coverage.push({ key, resource, status: e.kind === 'forbidden' ? 'forbidden' : e.kind === 'unsupported' ? 'unsupported' : 'error', count: 0, ...errInfo(e), ms: Date.now() - t0 });
    }
  };

  const extras = {
    async readyz() {
      try {
        const out = await kubectl.run(['get', '--raw', '/readyz?verbose'], opts);
        return parseHealth(out, true);
      } catch (e) {
        const parsed = parseHealth(e.stderr || '', false);
        if (parsed.checks.length) return parsed;
        return { ok: null, error: errInfo(e), checks: [] };
      }
    },
    async nodeMetrics() {
      try {
        const out = await kubectl.run(['top', 'nodes', '--no-headers'], opts);
        return { ok: true, items: parseTopNodes(out) };
      } catch (e) {
        return { ok: false, error: errInfo(e), items: [] };
      }
    },
    async podMetrics() {
      try {
        const out = await kubectl.run(['top', 'pods', ...(namespace ? ['-n', namespace] : ['-A']), '--containers', '--no-headers'], opts);
        return { ok: true, items: parseTopPods(out, namespace) };
      } catch (e) {
        return { ok: false, error: errInfo(e), items: [] };
      }
    },
  };

  const extraResults = {};
  const tasks = [
    ...RESOURCES.map((r) => () => fetchList(r)),
    ...Object.entries(extras).map(([k, fn]) => async () => { extraResults[k] = await fn(); }),
  ];
  await mapLimit(tasks, 8, (t) => t());

  coverage.sort((a, b) => RESOURCE_KEYS.indexOf(a.key) - RESOURCE_KEYS.indexOf(b.key));
  return {
    info: { ...info, version, scannedNamespace: namespace || null },
    data,
    coverage,
    health: extraResults.readyz,
    metrics: { nodes: extraResults.nodeMetrics, pods: extraResults.podMetrics },
    startedAt,
    durationMs: Date.now() - startedAt,
  };
}

function parseHealth(text, ok) {
  const checks = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\[([+-])\]([^\s]+)\s*(.*)$/);
    if (m) checks.push({ name: m[2], ok: m[1] === '+', message: m[3] });
  }
  return { ok: ok && checks.every((c) => c.ok), checks };
}

export function parseTopNodes(out) {
  return out.split('\n').map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 5).map(([name, cpu, cpuPct, mem, memPct]) => ({
    name,
    cpu: parseQuantity(cpu),
    cpuPct: parseInt(cpuPct, 10),
    memory: parseQuantity(mem),
    memoryPct: parseInt(memPct, 10),
  })).filter((n) => n.cpu != null);
}

export function parseTopPods(out, namespace) {
  const rows = [];
  for (const line of out.split('\n')) {
    const c = line.trim().split(/\s+/);
    if (namespace ? c.length < 4 : c.length < 5) continue;
    const [ns, pod, container, cpu, mem] = namespace ? [namespace, ...c] : c;
    rows.push({ namespace: ns, pod, container, cpu: parseQuantity(cpu), memory: parseQuantity(mem) });
  }
  return rows;
}
