// Gathers a read-only snapshot of the cluster behind a kube context.
import type { ApiHealth, ContextInfo, CoverageEntry, HealthCheck, NodeUsage } from '../shared/types.js';
import type { Collected, CollectedData, ErrorInfo, Kubectl, MetricsResult, PodMetric, ResourceKey } from './types.js';
import { KubectlError } from './kubectl.js';
import { mapLimit, parseQuantity } from './analyzer/util.js';

type Scope = 'cluster' | 'ns';

// [key, kubectl resource, scope]. Secrets and ConfigMaps are deliberately never read.
const RESOURCES: [ResourceKey, string, Scope][] = [
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

export const RESOURCE_KEYS: string[] = RESOURCES.map((r) => r[0]);

export async function listContexts(kubectl: Kubectl): Promise<{ contexts: string[]; current: string | null }> {
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

interface KubeconfigView {
  contexts?: { name: string; context?: { cluster?: string; user?: string; namespace?: string } }[];
  clusters?: { name: string; cluster?: { server?: string } }[];
}

export async function contextInfo(kubectl: Kubectl, context?: string): Promise<ContextInfo> {
  const cfg = await kubectl.json<KubeconfigView>(['config', 'view', '--minify'], { context });
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

function errInfo(e: unknown): ErrorInfo {
  const err = e as Partial<KubectlError>;
  return { kind: err.kind || 'error', message: err.message ?? String(e), detail: err.stderr && err.stderr !== err.message ? err.stderr.slice(0, 2000) : undefined };
}

export async function collect(kubectl: Kubectl, { context, namespace }: { context?: string; namespace?: string | null } = {}): Promise<Collected> {
  const startedAt = Date.now();
  const info = await contextInfo(kubectl, context);
  const opts = { context: info.context };

  // Fail fast with a clear message if the API server is unreachable / credentials are bad.
  let version: string | null = null;
  try {
    const v = await kubectl.json<{ serverVersion?: { gitVersion?: string } }>(['version'], opts);
    version = v.serverVersion?.gitVersion || null;
    if (!v.serverVersion) throw new KubectlError('The API server did not report its version', { kind: 'unreachable' });
  } catch (e) {
    throw e instanceof KubectlError ? e : new KubectlError(String((e as Error)?.message || e));
  }

  const data: CollectedData = {};
  const store = (key: ResourceKey, items: unknown[]) => { (data as Record<string, unknown[]>)[key] = items; };
  const coverage: CoverageEntry[] = [];

  const fetchList = async ([key, resource, scope]: [ResourceKey, string, Scope]) => {
    const t0 = Date.now();
    const scopeArgs = scope === 'cluster' ? [] : namespace ? ['-n', namespace] : ['-A'];
    try {
      const list = await kubectl.json<{ items?: unknown[] }>(['get', resource, ...scopeArgs], opts);
      store(key, list.items || []);
      coverage.push({ key, resource, status: 'ok', count: (list.items || []).length, scope: scopeArgs.join(' ') || 'cluster', ms: Date.now() - t0 });
    } catch (e) {
      let err = e;
      // Cluster-wide list forbidden? Fall back to the context's own namespace.
      if ((e as KubectlError).kind === 'forbidden' && scope === 'ns' && !namespace) {
        try {
          const list = await kubectl.json<{ items?: unknown[] }>(['get', resource, '-n', info.namespace], opts);
          store(key, list.items || []);
          coverage.push({ key, resource, status: 'partial', count: (list.items || []).length, scope: `-n ${info.namespace}`, message: `Cluster-wide list is forbidden; only namespace "${info.namespace}" was scanned.`, ms: Date.now() - t0 });
          return;
        } catch (e2) {
          err = e2;
        }
      }
      store(key, []);
      const kind = (err as KubectlError).kind;
      coverage.push({ key, resource, status: kind === 'forbidden' ? 'forbidden' : kind === 'unsupported' ? 'unsupported' : 'error', count: 0, ...errInfo(err), ms: Date.now() - t0 });
    }
  };

  let health: ApiHealth | undefined;
  let nodeMetrics: MetricsResult<NodeUsage> | undefined;
  let podMetrics: MetricsResult<PodMetric> | undefined;

  const extras: (() => Promise<void>)[] = [
    async () => {
      try {
        health = parseHealth(await kubectl.run(['get', '--raw', '/readyz?verbose'], opts), true);
      } catch (e) {
        const parsed = parseHealth((e as KubectlError).stderr || '', false);
        health = parsed.checks.length ? parsed : { ok: null, error: errInfo(e), checks: [] };
      }
    },
    async () => {
      try {
        nodeMetrics = { ok: true, items: parseTopNodes(await kubectl.run(['top', 'nodes', '--no-headers'], opts)) };
      } catch (e) {
        nodeMetrics = { ok: false, error: errInfo(e), items: [] };
      }
    },
    async () => {
      try {
        const out = await kubectl.run(['top', 'pods', ...(namespace ? ['-n', namespace] : ['-A']), '--containers', '--no-headers'], opts);
        podMetrics = { ok: true, items: parseTopPods(out, namespace) };
      } catch (e) {
        podMetrics = { ok: false, error: errInfo(e), items: [] };
      }
    },
  ];

  const tasks: (() => Promise<void>)[] = [...RESOURCES.map((r) => () => fetchList(r)), ...extras];
  await mapLimit(tasks, 8, (t) => t());

  coverage.sort((a, b) => RESOURCE_KEYS.indexOf(a.key) - RESOURCE_KEYS.indexOf(b.key));
  return {
    info: { ...info, version, scannedNamespace: namespace || null },
    data,
    coverage,
    health,
    metrics: { nodes: nodeMetrics, pods: podMetrics },
    startedAt,
    durationMs: Date.now() - startedAt,
  };
}

function parseHealth(text: string, ok: boolean): ApiHealth {
  const checks: HealthCheck[] = [];
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\[([+-])\]([^\s]+)\s*(.*)$/);
    if (m) checks.push({ name: m[2]!, ok: m[1] === '+', message: m[3] ?? '' });
  }
  return { ok: ok && checks.every((c) => c.ok), checks };
}

export function parseTopNodes(out: string): NodeUsage[] {
  const rows: NodeUsage[] = [];
  for (const line of out.split('\n')) {
    const [name, cpu, cpuPct, mem, memPct] = line.trim().split(/\s+/);
    if (!name || memPct === undefined) continue;
    const row = { name, cpu: parseQuantity(cpu), cpuPct: parseInt(cpuPct ?? '', 10), memory: parseQuantity(mem), memoryPct: parseInt(memPct, 10) };
    if (row.cpu != null) rows.push(row);
  }
  return rows;
}

export function parseTopPods(out: string, namespace?: string | null): PodMetric[] {
  const rows: PodMetric[] = [];
  for (const line of out.split('\n')) {
    const c = line.trim().split(/\s+/);
    if (namespace ? c.length < 4 : c.length < 5) continue;
    const [ns, pod, container, cpu, mem] = namespace ? [namespace, ...c] : c;
    rows.push({ namespace: ns!, pod: pod!, container: container!, cpu: parseQuantity(cpu), memory: parseQuantity(mem) });
  }
  return rows;
}
