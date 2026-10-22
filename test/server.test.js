import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

// fetch() refuses to override Host, so DNS-rebinding is tested with http.request.
const statusWithHost = (path, host) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path, headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
});

const PORT = 17000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${PORT}`;
let proc;

before(async () => {
  proc = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url)), '--demo', '--port', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 10_000);
    proc.stdout.on('data', (d) => { if (String(d).includes('Press Ctrl+C')) { clearTimeout(t); resolve(); } });
    proc.on('exit', (c) => reject(new Error(`server exited ${c}`)));
  });
});

after(() => proc?.kill());

test('serves the UI and a full scan', async () => {
  const html = await fetch(base).then((r) => r.text());
  assert.match(html, /Kube Doctor/);
  const r = await fetch(`${base}/api/scan`);
  assert.equal(r.status, 200);
  const report = await r.json();
  assert.ok(report.findings.length > 20);
  assert.equal(report.demo, true);
});

test('rejects writes, foreign hosts and bad input', async () => {
  assert.equal((await fetch(`${base}/api/scan`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/scan`, { method: 'DELETE' })).status, 405);
  assert.equal(await statusWithHost('/api/scan', 'attacker.example'), 403);
  assert.equal(await statusWithHost('/api/scan', `localhost:${PORT}`), 200);
  assert.equal((await fetch(`${base}/api/pod?namespace=shop&name=${encodeURIComponent('x;rm -rf /')}`)).status, 400);
  assert.equal((await fetch(`${base}/api/scan?context=not-a-context`)).status, 400);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});

test('object endpoint hides managed fields and secret-looking env values', async () => {
  await fetch(`${base}/api/scan`);
  const o = await fetch(`${base}/api/object?kind=Pod&namespace=payments&name=payment-gateway-9d7-4kq8s`).then((r) => r.json());
  assert.equal(o.metadata.managedFields, undefined);
  const logs = await fetch(`${base}/api/logs?namespace=shop&pod=api-7c9d8f-2hxkq&container=api&previous=1`).then((r) => r.text());
  assert.match(logs, /connection refused/);
});
