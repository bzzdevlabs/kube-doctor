#!/usr/bin/env node
// Kube Doctor — local, read-only Kubernetes troubleshooting web app.
import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ContextsResponse, Report } from '../shared/types.js';
import type { Collected, Kubectl } from './types.js';
import { createKubectl, KubectlError, type KubectlErrorKind } from './kubectl.js';
import { collect, listContexts } from './collector.js';
import { analyze } from './analyzer/index.js';
import { deepAnalyzePod } from './analyzer/deep.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(path.resolve(HERE, '..', '..', 'package.json'), 'utf8')) as { version: string };

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  const next = argv[i + 1];
  if (i >= 0 && next && !next.startsWith('--')) return next;
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
};

if (argv.includes('--version') || argv.includes('-v')) {
  console.log(pkg.version);
  process.exit(0);
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Kube Doctor ${pkg.version} — read-only Kubernetes troubleshooting UI

Usage: kube-doctor [options]      (from a source checkout: npm start -- [options])

  --port <n>        Port to listen on (default 7420, env PORT)
  --host <addr>     Address to bind (default 127.0.0.1, env HOST). Keep it local: the UI exposes cluster data.
  --kubectl <path>  kubectl binary (default "kubectl", env KUBECTL)
  --open            Open the browser
  --demo            Run against a built-in simulated cluster (no kubectl needed)
  --version         Print the version

The kube context is the one currently selected in your kubeconfig (KUBECONFIG is honoured).`);
  process.exit(0);
}

const DEMO = argv.includes('--demo') || process.env.KUBE_DOCTOR_DEMO === '1';
const PORT = parseInt(flag('--port') || process.env.PORT || '7420', 10);
const HOST = flag('--host') || process.env.HOST || '127.0.0.1';
const kubectl: Kubectl = DEMO
  ? (await import('./demo/kubectl.js')).createDemoKubectl()
  : createKubectl({ bin: flag('--kubectl') || process.env.KUBECTL || 'kubectl' });

// The built UI: dist/web next to dist/server, or <repo>/dist/web when running from sources.
const WEB = [process.env.KUBE_DOCTOR_WEB_DIR, path.resolve(HERE, '..', 'web'), path.resolve(HERE, '..', '..', 'dist', 'web')]
  .filter((d): d is string => !!d)
  .map((d) => path.resolve(d))
  .find((d) => existsSync(path.join(d, 'index.html')) && existsSync(path.join(d, 'assets'))) ?? null;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

const NAME_RE = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const scans = new Map<string, { collected: Collected; report: Report; namespace: string | null }>();
const inflight = new Map<string, Promise<Report>>();

const HINTS: Partial<Record<KubectlErrorKind, string>> = {
  nokubectl: 'Install kubectl and make sure it is on your PATH, or start with KUBECTL=/path/to/kubectl.',
  auth: 'Your credentials for this context are missing or expired. Log in again (e.g. `aws sso login`, `az login` / `kubelogin`, `gcloud auth login`, your OIDC login) and rescan. Exec auth plugins must be on the PATH of the terminal running Kube Doctor.',
  unreachable: 'The API server is unreachable: check VPN, proxy settings (HTTPS_PROXY / NO_PROXY), firewall, and that the cluster is running.',
  nocontext: 'No kube context is selected. Run `kubectl config use-context <name>` (or pick one in the selector) and rescan.',
  forbidden: 'Your user is not allowed to read this. Kube Doctor works with partial permissions; see Scan & settings.',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function send(res: http.ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8', cache = 'no-store'): void {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': CSP,
  });
  res.end(data);
}

function sendError(res: http.ServerResponse, e: unknown): void {
  if (e instanceof HttpError) return send(res, e.status, { error: e.message });
  if (e instanceof KubectlError) return send(res, 502, { error: e.message, kind: e.kind, hint: HINTS[e.kind] || null, detail: e.stderr && e.stderr !== e.message ? e.stderr.slice(0, 3000) : null });
  console.error(e);
  return send(res, 500, { error: e instanceof Error ? e.message : String(e) });
}

async function resolveContext(requested: string | null): Promise<{ context: string; current: string | null }> {
  const { contexts, current } = await listContexts(kubectl);
  if (requested) {
    if (!contexts.includes(requested)) throw new HttpError(400, `Unknown kube context "${requested}"`);
    return { context: requested, current };
  }
  if (!current) throw new KubectlError('No current kube context is set in your kubeconfig.', { kind: 'nocontext' });
  return { context: current, current };
}

function validName(v: string | null, what: string): string {
  if (!v || !NAME_RE.test(v)) throw new HttpError(400, `Invalid ${what}`);
  return v;
}

function runScan({ context, current, namespace, logs }: { context: string; current: string | null; namespace: string | null; logs: boolean }): Promise<Report> {
  const key = `${context}|${namespace || ''}|${logs}`;
  const running = inflight.get(key);
  if (running) return running;
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

interface PodSpecLike {
  containers?: { env?: { name: string; value?: string }[] }[];
  initContainers?: { env?: { name: string; value?: string }[] }[];
}

// Removes noise and secret-looking values before showing an object in the UI.
function sanitize(obj: { metadata?: { managedFields?: unknown; annotations?: Record<string, string> }; spec?: unknown }): unknown {
  const o = structuredClone(obj);
  if (o.metadata) {
    delete o.metadata.managedFields;
    if (o.metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration']) o.metadata.annotations['kubectl.kubernetes.io/last-applied-configuration'] = '(omitted)';
  }
  const scrub = (spec: PodSpecLike | undefined) => {
    for (const c of [...(spec?.containers || []), ...(spec?.initContainers || [])]) {
      for (const e of c.env || []) if (e.value != null && REDACT_ENV.test(e.name)) e.value = '••••••';
    }
  };
  const spec = o.spec as { template?: { spec?: PodSpecLike }; jobTemplate?: { spec?: { template?: { spec?: PodSpecLike } } } } & PodSpecLike | undefined;
  scrub(spec);
  scrub(spec?.template?.spec);
  scrub(spec?.jobTemplate?.spec?.template?.spec);
  return o;
}

async function handleApi(res: http.ServerResponse, url: URL): Promise<void> {
  const q = url.searchParams;
  switch (url.pathname) {
    case '/api/contexts': {
      const { contexts, current } = await listContexts(kubectl);
      const body: ContextsResponse = { contexts, current, demo: DEMO, kubectl: kubectl.bin };
      return send(res, 200, body);
    }
    case '/api/scan': {
      const { context, current } = await resolveContext(q.get('context'));
      const namespace = q.get('namespace') ? validName(q.get('namespace'), 'namespace') : null;
      const report = await runScan({ context, current, namespace, logs: q.get('logs') !== '0' });
      return send(res, 200, { ...report, demo: DEMO });
    }
    case '/api/pod': {
      const { context, current } = await resolveContext(q.get('context'));
      const namespace = validName(q.get('namespace'), 'namespace');
      const name = validName(q.get('name'), 'pod name');
      const base = scans.get(context)?.collected || null;
      return send(res, 200, await deepAnalyzePod(kubectl, { context, namespace, name, base, cmdContext: context === current ? null : context }));
    }
    case '/api/object': {
      const { context } = await resolveContext(q.get('context'));
      const kind = q.get('kind') || '';
      const scan = scans.get(context);
      if (!scan) throw new HttpError(404, 'Run a scan first');
      const ns = q.get('namespace') || '';
      const name = q.get('name') || '';
      for (const list of Object.values(scan.collected.data) as { kind: string; metadata?: { namespace?: string; name?: string; managedFields?: unknown; annotations?: Record<string, string> } }[][]) {
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
      return send(res, 200, await kubectl.run(args, { context }), 'text/plain; charset=utf-8');
    }
    case '/api/version':
      return send(res, 200, { version: pkg.version, demo: DEMO });
    default:
      throw new HttpError(404, 'Not found');
  }
}

const NOT_BUILT = `<!doctype html><meta charset="utf-8"><title>Kube Doctor</title><body style="font:15px system-ui;margin:40px">
<h1>The UI is not built yet</h1><p>Run <code>npm run build</code> (or <code>npm start</code>, which builds when needed) and reload.</p>
<p>The API is available: <a href="/api/contexts">/api/contexts</a>.</p></body>`;

// Files of the built UI only, by extension allowlist; no directory listing, no traversal.
async function serveStatic(res: http.ServerResponse, pathname: string): Promise<void> {
  if (!WEB) {
    if (pathname === '/') return send(res, 200, NOT_BUILT, 'text/html; charset=utf-8');
    throw new HttpError(404, 'Not found');
  }
  let rel: string;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  const file = path.resolve(WEB, rel);
  const type = MIME[path.extname(file)];
  if (!file.startsWith(WEB + path.sep) || !type || rel.includes('\0')) throw new HttpError(404, 'Not found');
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch {
    throw new HttpError(404, 'Not found');
  }
  return send(res, 200, data, type, rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
}

const allowedHosts = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`, `${HOST}:${PORT}`]);

const server = http.createServer(async (req, res) => {
  try {
    // DNS-rebinding protection: only answer requests addressed to this local server.
    if (HOST !== '0.0.0.0' && HOST !== '::' && !allowedHosts.has(req.headers.host || '')) throw new HttpError(403, 'Forbidden host');
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Read-only: only GET is supported');
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(res, url);
    return await serveStatic(res, url.pathname);
  } catch (e) {
    return sendError(res, e);
  }
});

server.on('error', (e: NodeJS.ErrnoException) => {
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
    ctx = `unavailable — ${e instanceof Error ? e.message : String(e)}`;
  }
  console.log(`\n  Kube Doctor ${pkg.version}${DEMO ? ' (DEMO cluster)' : ''} — read-only Kubernetes diagnostics`);
  console.log(`  ➜  ${url}`);
  console.log(`  kube context: ${ctx}`);
  if (!WEB) console.log('  ⚠  UI not built: run `npm run build`.');
  if (HOST === '0.0.0.0' || HOST === '::') console.log('  ⚠  Listening on all interfaces: anyone on your network can read cluster data.');
  console.log('  Press Ctrl+C to stop.\n');
  if (argv.includes('--open')) openBrowser(url);
});

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // Opening the browser is best effort.
  }
}
