import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Finding, Report } from '../src/shared/types.js';
import { assertReadOnly } from '../src/server/kubectl.js';
import { collect } from '../src/server/collector.js';
import { analyze } from '../src/server/analyzer/index.js';
import { deepAnalyzePod } from '../src/server/analyzer/deep.js';
import { createDemoKubectl } from '../src/server/demo/kubectl.js';
import { parseSchedulingMessage, explainImagePull, explainFailedCreate } from '../src/server/analyzer/knowledge.js';
import { analyzeLogs } from '../src/server/analyzer/logs.js';
import { parseQuantity } from '../src/server/analyzer/util.js';

test('kubectl guard only allows read-only commands', () => {
  for (const ok of [['get', 'pods', '-A'], ['logs', '-n', 'x', 'p', '--previous'], ['top', 'nodes'], ['version'], ['config', 'view', '--minify'], ['config', 'current-context'], ['get', '--raw', '/readyz?verbose']]) {
    assert.doesNotThrow(() => assertReadOnly(ok), ok.join(' '));
  }
  for (const bad of [['delete', 'pod', 'x'], ['apply', '-f', 'x.yaml'], ['exec', 'p', '--', 'sh'], ['edit', 'deploy/x'], ['patch', 'x'], ['scale', 'deploy/x'], ['rollout', 'restart', 'deploy/x'], ['config', 'use-context', 'prod'], ['config', 'set-context', 'x'], ['port-forward', 'p', '80'], ['cp', 'a', 'b'], ['drain', 'n'], ['cordon', 'n'], ['label', 'pod', 'x', 'a=b'], ['create', 'ns', 'x'], ['get', 'pods', '-w'], ['logs', 'p', '-f'], ['get', 'pods', '--kubeconfig=/tmp/x'], ['get', 'pods', '--as=admin']]) {
    assert.throws(() => assertReadOnly(bad), /Refusing/, bad.join(' '));
  }
});

test('quantity parsing', () => {
  assert.equal(parseQuantity('250m'), 0.25);
  assert.equal(parseQuantity('1Gi'), 1024 ** 3);
  assert.equal(parseQuantity('512Mi'), 512 * 1024 ** 2);
  assert.equal(parseQuantity('2'), 2);
  assert.equal(parseQuantity('1G'), 1e9);
});

test('scheduler message parsing', () => {
  const p = parseSchedulingMessage('0/5 nodes are available: 2 Insufficient memory, 1 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }, 2 node(s) didn\'t match Pod\'s node affinity/selector. preemption: 0/5 nodes are available: 5 Preemption is not helpful for scheduling.');
  assert.equal(p.totalNodes, 5);
  assert.deepEqual(p.reasons.map((r) => r.tag), ['InsufficientResources', 'Taints', 'NodeSelector']);
  assert.equal(p.reasons[0]?.count, 2);
});

test('image pull explanations', () => {
  assert.match(explainImagePull('failed to resolve reference "r.io/a:1": r.io/a:1: not found').summary, /does not exist/);
  assert.match(explainImagePull('pull access denied, repository does not exist or may require authorization: server message: insufficient_scope').summary, /no imagePullSecrets/);
  assert.match(explainImagePull('x509: certificate signed by unknown authority').summary, /TLS/);
  assert.match(explainImagePull('toomanyrequests: You have reached your pull rate limit').summary, /rate-limiting/);
  assert.match(explainImagePull('dial tcp: lookup registry.corp on 10.0.0.2:53: no such host').summary, /cannot resolve/);
});

test('failed create explanations', () => {
  const q = explainFailedCreate('pods "x" is forbidden: exceeded quota: team-q, requested: pods=1, used: pods=10, limited: pods=10');
  assert.equal(q.extracted?.quota, 'team-q');
  assert.match(explainFailedCreate('pods "x" is forbidden: violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false').summary, /Pod Security/);
  assert.equal(explainFailedCreate('admission webhook "check.kyverno.svc" denied the request: image tag latest not allowed').extracted?.webhook, 'check.kyverno.svc');
});

test('log pattern analysis and dependency extraction', () => {
  const a = analyzeLogs('2026-10-22T08:00:00Z starting\n2026-10-22T08:00:01Z Error: connect ECONNREFUSED 10.96.0.15:6379\n2026-10-22T08:00:01Z fatal');
  assert.equal(a.matches[0]?.id, 'conn-refused');
  assert.match(a.matches[0]?.explain ?? '', /10\.96\.0\.15:6379/);
  assert.deepEqual(a.dependencies.map((d) => `${d.host}:${d.port}`), ['10.96.0.15:6379']);
  assert.equal(analyzeLogs('Exception in thread "main" java.lang.OutOfMemoryError: Java heap space').matches[0]?.id, 'java-oom');
  assert.equal(analyzeLogs('Traceback (most recent call last):\n  x\nKeyError: \'DATABASE_URL\'').matches[0]?.id, 'missing-config');
  assert.equal(analyzeLogs('dial tcp: lookup redis.cache.svc.cluster.local: no such host').dependencies[0]?.host, 'redis.cache.svc.cluster.local');
  assert.ok(analyzeLogs('').empty);
});

async function demoReport() {
  const k = createDemoKubectl();
  const collected = await collect(k, {});
  const { report } = await analyze(collected, { kubectl: k, context: collected.info.context });
  return { k, collected, report };
}

function find(report: Report, pred: (f: Finding) => boolean): Finding {
  const f = report.findings.find(pred);
  assert.ok(f, 'expected finding not found');
  return f;
}
const byId = (report: Report, id: string): Finding => find(report, (f) => f.id === id);
function rootsOf(report: Report, f: Finding, seen = new Set<string>()): Finding[] {
  if (seen.has(f.id)) return [];
  seen.add(f.id);
  if (!f.causedBy.length) return [f];
  return f.causedBy.flatMap((id) => rootsOf(report, byId(report, id), seen));
}

test('demo cluster: every scenario is detected with the right root cause', async () => {
  const { report } = await demoReport();
  assert.deepEqual(report.internalErrors, []);
  assert.ok(report.coverage.every((c) => c.status === 'ok'));

  // shop/api crashes -> postgres service down -> postgres-0 unschedulable -> PVC with missing StorageClass
  const api = find(report, (f) => f.category === 'CrashLoopBackOff' && f.owner?.name === 'api');
  assert.equal(api.instances.length, 3, 'the 3 api pods are grouped');
  assert.match(api.rootCause.summary, /refused/);
  const apiRoots = rootsOf(report, api);
  assert.equal(apiRoots.length, 1);
  assert.equal(apiRoots[0]?.category, 'PVCPending');
  assert.match(apiRoots[0]?.rootCause.summary ?? '', /fast-ssd/);
  const ingress = find(report, (f) => f.object.kind === 'Ingress' && f.category === 'IngressBackend');
  assert.ok(rootsOf(report, ingress).some((r) => r.category === 'PVCPending'));

  // OOM with JVM heap analysis
  const oom = find(report, (f) => f.owner?.name === 'payment-gateway' && f.tags.includes('OOMKilled'));
  assert.match(oom.rootCause.summary, /-Xmx1g/);

  // liveness probe kills
  const live = find(report, (f) => f.owner?.name === 'fraud-detector');
  assert.ok(live.tags.includes('LivenessProbe'));
  assert.match(live.rootCause.summary, /timed out/);

  // missing secret, missing image tag
  assert.match(find(report, (f) => f.category === 'CreateContainerConfigError').rootCause.summary, /cart-redis-credentials/);
  assert.ok(find(report, (f) => f.category === 'ImagePullBackOff').tags.includes('ImageNotFound'));

  // webhook down blocks checkout; root cause is the expired certificate in the webhook logs
  const checkout = find(report, (f) => f.object.kind === 'Deployment' && f.object.name === 'checkout');
  const cRoots = rootsOf(report, checkout);
  assert.equal(cRoots[0]?.object.namespace, 'policy');
  assert.match(cRoots[0]?.rootCause.summary ?? '', /EXPIRED/);
  const checkoutSvc = find(report, (f) => f.object.kind === 'Service' && f.object.name === 'checkout');
  assert.doesNotMatch(checkoutSvc.rootCause.summary, /mismatch/i, 'pod-less workload is not a label typo');

  // quota
  const ledger = find(report, (f) => f.object.kind === 'Deployment' && f.object.name === 'ledger');
  assert.equal(rootsOf(report, ledger)[0]?.category, 'QuotaExceeded');

  // node failure chain
  const stuck = find(report, (f) => f.category === 'StuckTerminating');
  assert.equal(rootsOf(report, stuck)[0]?.category, 'NodeNotReady');
  const multi = find(report, (f) => f.category === 'VolumeMount');
  assert.ok(multi.tags.includes('MultiAttach'));
  assert.ok(rootsOf(report, multi).some((r) => r.category === 'NodeNotReady'));

  // eviction caused by disk pressure
  const ev = find(report, (f) => f.category === 'Evicted');
  assert.equal(rootsOf(report, ev)[0]?.object.name, 'worker-b');

  // job: logs reveal missing env var
  const job = find(report, (f) => f.category === 'ContainerFailed' && f.owner?.kind === 'CronJob');
  assert.match(job.rootCause.summary, /Missing configuration/);

  // label typo, scheduling impossibility, namespace stuck on aggregated API
  assert.match(find(report, (f) => f.object.name === 'recommendation').rootCause.summary, /Label mismatch/);
  assert.match(find(report, (f) => f.object.name === 'search-0').rootCause.summary, /NEVER/);
  const nsF = find(report, (f) => f.category === 'NamespaceTerminating');
  assert.equal(rootsOf(report, nsF)[0]?.object.name, 'prometheus-adapter');

  // incidents are sorted and root-only
  assert.ok(report.incidents.length >= 10);
  for (const i of report.incidents) assert.equal(byId(report, i.rootId).causedBy.length, 0);
});

test('deep analysis ranks the failing dependency first', async () => {
  const { k, collected } = await demoReport();
  const deep = await deepAnalyzePod(k, { context: 'demo-cluster', namespace: 'shop', name: 'api-7c9d8f-2hxkq', base: collected });
  assert.equal(deep.hypotheses[0]?.title, 'Dependency postgres is down');
  const prev = deep.logs.api?.previous;
  assert.ok(prev && 'text' in prev && prev.text.includes('connection refused'));
  assert.ok(deep.timeline.length > 3);
  const env = deep.containers[0]?.env.find((e) => e.name === 'DATABASE_PASSWORD');
  assert.equal(env?.value, null, 'secret-backed env values are never shown');
});
