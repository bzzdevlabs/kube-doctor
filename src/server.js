#!/usr/bin/env node
// Kube Doctor — local, read-only Kubernetes troubleshooting web app.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createKubectl, KubectlError } from './kubectl.js';
import { collect, listContexts } from './collector.js';
import { analyze } from './analyzer/index.js';
import { deepAnalyzePod } from './analyzer/deep.js';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
};

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Kube Doctor — read-only Kubernetes troubleshooting UI

Usage: npm start [-- options]

  --port <n>        Port to listen on (default 7420, env PORT)
  --host <addr>     Address to bind (default 127.0.0.1, env HOST). Keep it local: the UI exposes cluster data.
  --kubectl <path>  kubectl binary (default "kubectl", env KUBECTL)
  --open            Open the browser
  --demo            Run against a built-in simulated cluster (no kubectl needed)

The kube context is the one currently selected in your kubeconfig (KUBECONFIG is honoured).`);
  process.exit(0);
}

const DEMO = argv.includes('--demo') || process.env.KUBE_DOCTOR_DEMO === '1';
const PORT = parseInt(flag('--port') || process.env.PORT || '7420', 10);
const HOST = flag('--host') || process.env.HOST || '127.0.0.1';
const kubectl = DEMO
  ? (await import('./demo/kubectl.js')).createDemoKubectl()
  : createKubectl({ bin: flag('--kubectl') || process.env.KUBECTL || 'kubectl' });

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

const NAME_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const scans = new Map(); // context -> { collected, report }
const inflight = new Map();

const HINTS = {
  nokubectl: 'Install kubectl and make sure it is on your PATH, or start with KUBECTL=/path/to/kubectl npm start.',
  auth: 'Your credentials for this context are missing or expired. Log in again (e.g. `aws sso login`, `az login` / `kubelogin`, `gcloud auth login`, your OIDC login) and rescan. Exec auth plugins must be on the PATH of the terminal running npm.',
  unreachable: 'The API server is unreachable: check VPN, proxy settings (HTTPS_PROXY / NO_PROXY), firewall, and that the cluster is running.',
  nocontext: 'No kube context is selected. Run `kubectl config use-context <name>` (or pick one in the selector) and rescan.',
  forbidden: 'Your user is not allowed to read this. Kube Doctor works with partial permissions; see the Coverage tab.',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(data);
}

function sendError(res, e) {
  if (e instanceof HttpError) return send(res, e.status, { error: e.message });
  if (e instanceof KubectlError) return send(res, 502, { error: e.message, kind: e.kind, hint: HINTS[e.kind] || null, detail: e.stderr && e.stderr !== e.message ? e.stderr.slice(0, 3000) : null });
  console.error(e);
  return send(res, 500, { error: String(e?.message || e) });
}

async function resolveContext(requested) {
  const { contexts, current } = await listContexts(kubectl);
  if (requested) {
    if (!contexts.includes(requested)) throw new HttpError(400, `Unknown kube context "${requested}"`);
    return { context: requested, current };
  }
  if (!current) throw new KubectlError('No current kube context is set in your kubeconfig.', { kind: 'nocontext' });
  return { context: current, current };
}

function validName(v, what, { optional = false } = {}) {
  if (!v && optional) return null;
  if (!v || !NAME_RE.test(v)) throw new HttpError(400, `Invalid ${what}`);
  return v;
}

async function runScan({ context, current, namespace, logs }) {
  const key = `${context}|${namespace || ''}|${logs}`;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const collected = await collect(kubectl, { context, namespace });
    const { report } = await analyze(collected, { kubectl, context, cmdContext: context === current ? null : context, logs });
    scans.set(context, { collected, report, namespace });
    return report;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

const REDACT_ENV = /pass|secret|token|key|credential|pwd|auth|private/i;
function sanitize(obj) {
  const o = structuredClone(obj);
  if (o.metadata) {
    delete o.metadata.managedFields;
    if (o.metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration']) o.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'] = '(omitted)';
  }
  const scrub = (spec) => {
    for (const c of [...(spec?.containers || []), ...(spec?.initContainers || [])]) {
      for (const e of c.env || []) if (e.value != null && REDACT_ENV.test(e.name)) e.value = '••••••';
    }
  };
  scrub(o.spec);
  scrub(o.spec?.template?.spec);
  scrub(o.spec?.jobTemplate?.spec?.template?.spec);
  return o;
}

async function handleApi(req, res, url) {
  const q = url.searchParams;
  switch (url.pathname) {
    case '/api/contexts': {
      const { contexts, current } = await listContexts(kubectl);
      return send(res, 200, { contexts, current, demo: DEMO, kubectl: kubectl.bin });
    }
    case '/api/scan': {
      const { context, current } = await resolveContext(q.get('context'));
      const namespace = validName(q.get('namespace'), 'namespace', { optional: true });
      const report = await runScan({ context, current, namespace, logs: q.get('logs') !== '0' });
      return send(res, 200, { ...report, demo: DEMO });
    }
    case '/api/pod': {
      const { context, current } = await resolveContext(q.get('context'));
      const namespace = validName(q.get('namespace'), 'namespace');
      const name = validName(q.get('name'), 'pod name');
      const base = scans.get(context)?.collected || null;
      const result = await deepAnalyzePod(kubectl, { context, namespace, name, base, cmdContext: context === current ? null : context });
      return send(res, 200, result);
    }
    case '/api/object': {
      const { context } = await resolveContext(q.get('context'));
      const kind = q.get('kind') || '';
      const scan = scans.get(context);
      if (!scan) throw new HttpError(404, 'Run a scan first');
      const ns = q.get('namespace') || '';
      const name = q.get('name') || '';
      for (const list of Object.values(scan.collected.data)) {
        const o = list.find((x) => x.kind === kind && (x.metadata?.namespace || '') === ns && x.metadata?.name === name);
        if (o) return send(res, 200, sanitize(o));
      }
      throw new HttpError(404, `${kind} ${ns}/${name} is not in the last scan`);
    }
    case '/api/logs': {
      const { context } = await resolveContext(q.get('context'));
      const namespace = validName(q.get('namespace'), 'namespace');
      const pod = validName(q.get('pod'), 'pod name');
      const container = validName(q.get('container'), 'container name');
      const tail = Math.min(Math.max(parseInt(q.get('tail') || '1000', 10) || 1000, 10), 10000);
      const args = ['logs', '-n', namespace, pod, '-c', container, `--tail=${tail}`, '--timestamps', '--limit-bytes=4194304'];
      if (q.get('previous') === '1') args.push('--previous');
      const text = await kubectl.run(args, { context });
      return send(res, 200, text, 'text/plain; charset=utf-8');
    }
    default:
      throw new HttpError(404, 'Not found');
  }
}

const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, `${HOST}:${PORT}`]);

const server = http.createServer(async (req, res) => {
  try {
    // DNS-rebinding protection: only answer requests addressed to this local server.
    if (HOST !== '0.0.0.0' && HOST !== '::' && !allowedHosts.has(req.headers.host || '')) throw new HttpError(403, 'Forbidden host');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Read-only: only GET is supported');
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    const entry = STATIC[url.pathname];
    if (!entry) throw new HttpError(404, 'Not found');
    return send(res, 200, await readFile(path.join(PUBLIC, entry[0])), entry[1]);
  } catch (e) {
    return sendError(res, e);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Start with --port <n> or PORT=<n>.`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, async () => {
  const url = `http://${HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST}:${PORT}`;
  let ctx = '';
  try {
    ctx = (await listContexts(kubectl)).current || '(none)';
  } catch (e) {
    ctx = `unavailable — ${e.message}`;
  }
  console.log(`\n  Kube Doctor ${DEMO ? '(DEMO cluster) ' : ''}— read-only Kubernetes diagnostics`);
  console.log(`  ➜  ${url}`);
  console.log(`  kube context: ${ctx}`);
  if (HOST === '0.0.0.0' || HOST === '::') console.log('  ⚠  Listening on all interfaces: anyone on your network can read cluster data.');
  console.log('  Press Ctrl+C to stop.\n');
  if (argv.includes('--open')) openBrowser(url);
});

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // Opening the browser is best effort.
  }
}
