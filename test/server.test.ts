// End-to-end tests of the built server (dist/) in demo mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { Report } from '../src/shared/types.js';

const PORT = 17000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess | undefined;

// fetch() normalizes paths and refuses to override Host, so those cases use http.get.
function rawGet(path: string, host = `127.0.0.1:${PORT}`): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path, headers: { Host: host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on('error', reject);
  });
}

before(async () => {
  const server = fileURLToPath(new URL('../dist/server/server.js', import.meta.url));
  const child = spawn(process.execPath, [server, '--demo', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc = child;
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 10_000);
    child.stdout?.on('data', (d: Buffer) => {
      if (String(d).includes('Press Ctrl+C')) {
        clearTimeout(t);
        resolve();
      }
    });
    child.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});

after(() => proc?.kill());

test('serves the built UI with a strict CSP', async () => {
  const r = await fetch(base);
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  const html = await r.text();
  assert.match(html, /<title>Kube Doctor<\/title>/);
  assert.doesNotMatch(html, /<script>(?!<\/script>)/, 'no inline script');
  const asset = html.match(/src="\/(assets\/[^"]+\.js)"/)?.[1];
  assert.ok(asset, 'index.html references a bundled script');
  const js = await fetch(`${base}/${asset}`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type') || '', /javascript/);
  assert.match(js.headers.get('cache-control') || '', /immutable/);
});

test('returns a full scan with inventory', async () => {
  const r = await fetch(`${base}/api/scan`);
  assert.equal(r.status, 200);
  const report = await r.json() as Report;
  assert.equal(report.demo, true);
  assert.ok(report.findings.length > 20);
  assert.ok(report.incidents.length > 5);
  assert.ok(report.inventory.pods.length > 10);
  assert.ok(report.inventory.workloads.some((w) => w.kind === 'Deployment' && w.problems.length > 0));
  assert.ok(report.inventory.namespaces.some((n) => n.name === 'shop'));
  const ids = new Set(report.findings.map((f) => f.id));
  for (const p of report.inventory.pods) for (const id of p.problems) assert.ok(ids.has(id), `pod problem ${id} exists`);
});

test('rejects writes, foreign hosts and bad input', async () => {
  assert.equal((await fetch(`${base}/api/scan`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/scan`, { method: 'DELETE' })).status, 405);
  assert.equal((await rawGet('/api/scan', 'attacker.example')).status, 403);
  assert.equal((await rawGet('/api/scan', `localhost:${PORT}`)).status, 200);
  assert.equal((await fetch(`${base}/api/pod?namespace=shop&name=${encodeURIComponent('x;rm -rf /')}`)).status, 400);
  assert.equal((await fetch(`${base}/api/scan?context=not-a-context`)).status, 400);
});

test('static files cannot escape the UI directory', async () => {
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/assets/../../package.json', '/assets/%2e%2e%2f%2e%2e%2fpackage.json', '/..%2f..%2fpackage.json', '/%00', '/index.html%00.js', '/server/server.js']) {
    const r = await rawGet(p);
    assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
    assert.doesNotMatch(r.body, /"devDependencies"/, `${p} leaked a file`);
  }
});

test('object endpoint hides managed fields and secret-looking env values', async () => {
  await fetch(`${base}/api/scan`);
  const o = await fetch(`${base}/api/object?kind=Pod&namespace=payments&name=payment-gateway-9d7-4kq8s`).then((r) => r.json()) as { metadata: { managedFields?: unknown } };
  assert.equal(o.metadata.managedFields, undefined);
  assert.equal((await fetch(`${base}/api/object?kind=Secret&namespace=shop&name=anything`)).status, 404);
  const logs = await fetch(`${base}/api/logs?namespace=shop&pod=api-7c9d8f-2hxkq&container=api&previous=1`).then((r) => r.text());
  assert.match(logs, /connection refused/);
});

test('deep pod analysis ranks hypotheses', async () => {
  const a = await fetch(`${base}/api/pod?namespace=shop&name=api-7c9d8f-2hxkq`).then((r) => r.json()) as { hypotheses: { confidence: number }[]; containers: unknown[]; timeline: unknown[] };
  assert.ok(a.hypotheses.length > 0);
  for (let i = 1; i < a.hypotheses.length; i++) assert.ok(a.hypotheses[i - 1]!.confidence >= a.hypotheses[i]!.confidence);
  assert.ok(a.containers.length > 0);
  assert.ok(a.timeline.length > 0);
});
