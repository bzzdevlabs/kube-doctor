// Log pattern analysis: recognizes common failure signatures in container logs
// and extracts the dependencies (host:port) an app failed to reach.

const P = (id, weight, re, title, explain, fixes = []) => ({ id, weight, re, title, explain, fixes });

// Higher weight = more specific / more likely to be the actual root cause.
export const LOG_PATTERNS = [
  P('java-oom', 95, /java\.lang\.OutOfMemoryError(?::\s*([^\n]+))?/i, 'JVM OutOfMemoryError', (m) => `The JVM ran out of ${m[1] ? `memory (${m[1].trim()})` : 'heap'}: heap/metaspace too small for the workload, or a memory leak.`, ['Increase heap (-Xmx / MaxRAMPercentage) together with the container memory limit, or analyze a heap dump for leaks.']),
  P('node-oom', 95, /JavaScript heap out of memory|Allocation failed - JavaScript heap|Reached heap limit/i, 'Node.js heap exhausted', () => 'The Node.js process hit its V8 heap limit.', ['Raise --max-old-space-size (and the container limit accordingly) or fix the memory leak.']),
  P('go-oom', 90, /fatal error: runtime: out of memory|cannot allocate memory/i, 'Out of memory', () => 'The process could not allocate memory.', ['Raise the memory limit or reduce memory usage.']),
  P('python-memory', 85, /\bMemoryError\b/, 'Python MemoryError', () => 'The Python process could not allocate memory.', ['Raise the memory limit or process data in smaller chunks.']),
  P('exec-format', 95, /exec format error/i, 'Wrong CPU architecture', () => 'The binary was built for another CPU architecture than the node (e.g. arm64 image on amd64 node).', ['Build a multi-arch image or schedule on matching nodes.']),
  P('cmd-not-found', 90, /(?:exec: |\/bin\/\w+: |sh: )?([\w./-]+): (?:command )?not found|executable file not found in \$PATH|exec ([\w./-]+): no such file or directory/i, 'Command not found', (m) => `A command (${m[1] || m[2] || '?'}) used by the entrypoint does not exist in the image.`, ['Fix the command/entrypoint, or the image (missing package or shell).']),
  P('no-space', 90, /No space left on device|ENOSPC/i, 'Disk full', () => 'The app could not write: its volume or the node filesystem is full.', ['Grow the PVC, clean data, or set ephemeral-storage limits / emptyDir sizeLimit.']),
  P('readonly-fs', 85, /Read-only file system|EROFS/i, 'Read-only filesystem', () => 'The app writes to a read-only path (readOnlyRootFilesystem, ConfigMap/Secret mount, or read-only volume).', ['Mount an emptyDir for writable paths (/tmp, cache dirs) or point the app elsewhere.']),
  P('perm-denied', 75, /permission denied|EACCES|Operation not permitted|AccessDeniedException/i, 'Permission denied', () => 'The process lacks permission on a file, port or syscall: runAsUser/fsGroup mismatch with volume ownership, ports < 1024 as non-root, or dropped capabilities.', ['Check securityContext (runAsUser, fsGroup), volume ownership, and use ports ≥1024 for non-root.']),
  P('addr-in-use', 85, /address already in use|EADDRINUSE|BindException|Port \d+ (?:is )?already in use/i, 'Port already in use', () => 'Another process (often a sidecar or a second server in the same container) already listens on the port.', ['Change one of the ports; check hostNetwork pods on the node.']),
  P('dns', 80, /no such host|Name or service not known|getaddrinfo (?:ENOTFOUND|EAI_AGAIN)|Temporary failure in name resolution|UnknownHostException|Could not resolve host|nodename nor servname provided|could not translate host name/i, 'DNS resolution failure', (m, line) => `The app cannot resolve ${target(line) || 'a hostname'}: the Service name is wrong / in another namespace, the external host does not exist, or cluster DNS (CoreDNS) is unhealthy.`, ['Check the hostname in the app config; use <service>.<namespace> for cross-namespace calls; check CoreDNS pods.']),
  P('conn-refused', 78, /connection refused|ECONNREFUSED|Connection refused|actively refused/i, 'Connection refused', (m, line) => `${target(line) ? `Connection to ${target(line)} is refused` : 'A dependency is not accepting connections'}: it is down, still starting, has no ready endpoints, or the port is wrong.`, ['Check the dependency is running and its Service has ready endpoints; verify the port.']),
  P('timeout', 65, /i\/o timeout|ETIMEDOUT|connect timed out|Connection timed out|context deadline exceeded|SocketTimeoutException|ConnectTimeoutException|timed out after|Read timed out/i, 'Network timeout', (m, line) => `${target(line) ? `Connection to ${target(line)} timed out` : 'A connection timed out'}: firewall/NetworkPolicy dropping packets, wrong IP, or an overloaded dependency.`, ['Check NetworkPolicies and egress firewall rules; test connectivity from a debug pod.']),
  P('tls', 80, /x509:|certificate verify failed|unable to verify the first certificate|SSLHandshakeException|PKIX path building failed|self[- ]signed certificate|CERT_HAS_EXPIRED|certificate has expired|SSL routines/i, 'TLS / certificate error', (m, line) => (/expired|not yet valid/i.test(line) ? 'A TLS certificate has EXPIRED (or is not yet valid). If it is the app\'s own serving certificate, renew it (cert-manager Certificate / the TLS Secret); if it belongs to a dependency, that service must renew it.' : /unknown authority|unable to verify|PKIX|self[- ]signed/i.test(line) ? 'TLS verification failed because the certificate is signed by a CA the container does not trust (private/corporate CA or TLS-intercepting proxy).' : /valid for|doesn\'t match|hostname/i.test(line) ? 'The certificate does not match the hostname the app connects to.' : 'TLS verification failed: untrusted CA, expired certificate, or hostname mismatch.'), ['Renew expired certificates; add the CA to the image or mount it (SSL_CERT_FILE / Java truststore); renew the certificate.']),
  P('db-auth', 88, /password authentication failed|Access denied for user|Login failed for user|authentication failed|SASL authentication|invalid username.password|ORA-01017|NOAUTH|WRONGPASS/i, 'Authentication failed', () => 'The app reached its dependency but the credentials were rejected (wrong/rotated password or user missing).', ['Verify the Secret holding the credentials and that the user exists on the server.']),
  P('db-missing', 80, /database "[^"]+" does not exist|Unknown database|relation "[^"]+" does not exist|Table '[^']+' doesn't exist|no such table/i, 'Database schema missing', () => 'The database/schema is missing: migrations did not run or the app points to the wrong database.', ['Run migrations / check the database name in the configuration.']),
  P('http-auth', 60, /\b401 Unauthorized\b|\b403 Forbidden\b|status code:? 40[13]\b/i, 'HTTP 401/403 from a dependency', () => 'A remote API rejected the app\'s credentials or token.', ['Check API keys/tokens and their expiry.']),
  P('k8s-rbac', 85, /cannot (?:get|list|watch|create|update|patch|delete) resource "[^"]+"|is forbidden: User "system:serviceaccount:/i, 'Kubernetes RBAC forbidden', () => 'The app calls the Kubernetes API with a ServiceAccount that lacks RBAC permissions.', ['Grant a Role/ClusterRole to the pod\'s ServiceAccount with the needed verbs/resources.']),
  P('missing-config', 82, /(?:environment variable|env var|config(?:uration)? (?:key|property|value))\s+["'`]?[\w.]+["'`]?\s+(?:is )?(?:not set|missing|required|undefined)|KeyError: '[A-Z_]{3,}'|required (?:env|environment) variable|Missing required (?:config|configuration|property|parameter)|must be set|is not defined in the environment|Could not resolve placeholder|Failed to bind properties/i, 'Missing configuration', () => 'A required configuration value / environment variable is missing.', ['Add the variable to the Deployment (env/envFrom) or the referenced ConfigMap/Secret.']),
  P('file-missing', 70, /No such file or directory|ENOENT|FileNotFoundException|cannot open .*: No such file|NoSuchFileException/i, 'File not found', () => 'The app expects a file that is not there: config file not mounted, wrong mount path, or wrong working directory.', ['Check volumeMounts paths vs what the app expects; subPath mounts of ConfigMaps.']),
  P('module-missing', 88, /Cannot find module|ModuleNotFoundError|ImportError: |ClassNotFoundException|NoClassDefFoundError|cannot load such file|undefined symbol|error while loading shared libraries/i, 'Missing module / class / library', () => 'Code or a library is missing from the image (bad build, wrong base image, missing dependency).', ['Rebuild the image; verify dependencies are installed in the final stage of the Dockerfile.']),
  P('spring-fail', 70, /APPLICATION FAILED TO START|Application run failed|BeanCreationException|UnsatisfiedDependencyException/i, 'Spring Boot failed to start', () => 'The Spring application context failed to start; the "Description:" / "Caused by:" lines explain why.', ['Read the "Caused by:" chain in the logs.']),
  P('go-panic', 75, /^panic: |goroutine \d+ \[running\]/m, 'Go panic', () => 'The Go program panicked (nil pointer, index out of range, explicit panic).', ['Read the panic message and the first stack frame of your code.']),
  P('segfault', 75, /segmentation fault|SIGSEGV|core dumped/i, 'Segmentation fault', () => 'Native crash in the process or a native library.', ['Check native dependencies and architecture.']),
  P('py-traceback', 55, /Traceback \(most recent call last\)/, 'Python exception', () => 'An uncaught Python exception terminated the program — the last line of the traceback is the cause.', []),
  P('too-many-files', 80, /too many open files|EMFILE/i, 'Too many open files', () => 'The process exhausted file descriptors (leaking connections/files or low ulimit).', ['Fix the descriptor leak; raise the limit in the runtime if needed.']),
  P('migration', 60, /migration (?:failed|error)|Flyway|Liquibase.*(?:error|failed)|alembic.*error/i, 'Database migration failure', () => 'Schema migration failed at startup.', ['Check the migration error and the database state (locks, partial migrations).']),
  P('kafka', 60, /Bootstrap broker .* disconnected|Connection to node -?\d+ .* could not be established|LEADER_NOT_AVAILABLE/i, 'Kafka connectivity', () => 'The Kafka client cannot reach brokers (advertised listeners, network, or brokers down).', ['Check bootstrap servers, advertised.listeners and broker health.']),
  P('generic-fatal', 30, /\b(FATAL|Fatal|PANIC|CRITICAL)\b[:\]\s]/, 'Fatal error', () => 'The application logged a fatal error just before stopping.', []),
];

// host:port of the first connection-type error in a line, e.g. "10.96.40.12:5432".
function target(line) {
  const d = extractDependencies(line || '')[0];
  return d ? `${d.host}${d.port ? `:${d.port}` : ''}` : null;
}

const ERROR_LINE = /\b(error|err|fatal|panic|exception|failed|failure|refused|denied|cannot|can't|unable|traceback|caused by|killed|timeout|timed out)\b/i;

// Extract host[:port] targets from connection-type errors.
const HOST_RES = [
  /dial tcp(?:4|6)? \[?([\w.:-]+?)\]?:(\d+)/gi,
  /(?:connect|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH)\s+([\w.-]+):(\d+)/gi,
  /getaddrinfo (?:ENOTFOUND|EAI_AGAIN) ([\w.-]+)/gi,
  /lookup ([\w.-]+)(?: on [\d.:\[\]]+)?: (?:no such host|server misbehaving|i\/o timeout)/gi,
  /UnknownHostException:\s*([\w.-]+)/gi,
  /Could not resolve host:?\s*([\w.-]+)/gi,
  /could not translate host name "([\w.-]+)"/gi,
  /connection to server at "([\w.-]+)"(?: \([\d.]+\))?, port (\d+)/gi,
  /(?:Connection refused|connection refused)[^\n]*?(?:to|at|for)\s+(?:[a-z]+:\/\/)?([\w.-]+):(\d+)/gi,
  /([a-z][\w-]*(?:\.[\w-]+)*):(\d{2,5})[^\n]{0,40}(?:connection refused|Connection refused|timed out|no such host)/gi,
  /Failed to connect to ([\w.-]+)(?: port |:)(\d+)/gi,
  /Can't connect to (?:MySQL|Redis|server) (?:server )?on '([\w.-]+)'(?: \((\d+)\))?/gi,
  /Error connecting to ([\w.-]+):(\d+)/gi,
];

export function extractDependencies(text) {
  const deps = new Map();
  for (const re of HOST_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const host = m[1].replace(/\.$/, '');
      if (!host || /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/.test(host) && !m[2]) continue;
      if (/^\d+$/.test(host)) continue;
      const k = `${host}:${m[2] || ''}`;
      const cur = deps.get(k) || { host, port: m[2] ? parseInt(m[2], 10) : null, count: 0, sample: m[0] };
      cur.count++;
      deps.set(k, cur);
    }
  }
  return [...deps.values()].sort((a, b) => b.count - a.count).slice(0, 10);
}

// Strips the RFC3339 prefix added by `kubectl logs --timestamps`.
export function splitTimestamp(line) {
  const m = line.match(/^(\d{4}-\d\d-\d\dT[\d:.]+(?:Z|[+-]\d\d:\d\d))\s(.*)$/);
  return m ? { time: m[1], text: m[2] } : { time: null, text: line };
}

export function analyzeLogs(raw) {
  const lines = String(raw || '').split('\n').filter((l, i, a) => l.length || i < a.length - 1);
  const plain = lines.map((l) => splitTimestamp(l).text);
  const text = plain.join('\n');
  const matches = [];
  for (const p of LOG_PATTERNS) {
    const re = new RegExp(p.re.source, p.re.flags.replace('g', ''));
    let idx = -1;
    let count = 0;
    let lastMatch = null;
    for (let i = 0; i < plain.length; i++) {
      const m = plain[i].match(re);
      if (m) {
        count++;
        idx = i;
        lastMatch = m;
      }
    }
    if (!count && re.flags.includes('m')) {
      const m = text.match(re);
      if (m) {
        count = 1;
        lastMatch = m;
        idx = text.slice(0, m.index).split('\n').length - 1;
      }
    }
    if (count) {
      matches.push({ id: p.id, title: p.title, weight: p.weight, explain: p.explain(lastMatch, plain[idx] || ''), fixes: p.fixes, count, line: plain[idx]?.slice(0, 500), lineNo: idx });
    }
  }
  // Prefer the most specific pattern; among equal weights, the one closest to the end of the log.
  matches.sort((a, b) => b.weight - a.weight || b.lineNo - a.lineNo);

  const highlights = new Set(matches.map((m) => m.lineNo));
  plain.forEach((l, i) => {
    if (ERROR_LINE.test(l)) highlights.add(i);
  });
  const errorLines = [...highlights].sort((a, b) => a - b).map((i) => ({ lineNo: i, text: plain[i]?.slice(0, 500) })).filter((l) => l.text);

  // Last exception-ish line for Python/Java style traces.
  let lastException = null;
  for (let i = plain.length - 1; i >= 0 && i >= plain.length - 60; i--) {
    if (/^(?:[\w.]+(?:Error|Exception|Exit)|Caused by: .+|Error: .+|panic: .+)/.test(plain[i].trim())) {
      lastException = plain[i].trim().slice(0, 400);
      break;
    }
  }

  return {
    lineCount: plain.length,
    empty: plain.join('').trim() === '',
    matches: matches.slice(0, 8),
    errorLines: errorLines.slice(-40),
    lastException,
    lastLines: plain.slice(-15),
    dependencies: extractDependencies(text),
  };
}

// Resolves a host seen in logs to an in-cluster Service (by name, FQDN or ClusterIP) or pod IP.
export function resolveDependency(dep, namespace, snap) {
  const host = dep.host.toLowerCase();
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/.test(host)) {
    return { kind: 'Localhost', how: 'loopback', note: 'Inside a pod, localhost is the pod itself: the dependency must run as a container of the same pod, otherwise the app should be configured with the Service name.' };
  }
  const services = snap.list('services');
  const ipMatch = services.find((s) => s.spec?.clusterIP === host || (s.spec?.clusterIPs || []).includes(host));
  if (ipMatch) return { kind: 'Service', namespace: ipMatch.metadata.namespace, name: ipMatch.metadata.name, how: 'ClusterIP' };
  const podMatch = snap.list('pods').find((p) => p.status?.podIP === host);
  if (podMatch) return { kind: 'Pod', namespace: podMatch.metadata.namespace, name: podMatch.metadata.name, how: 'pod IP' };
  const parts = host.replace(/\.svc(\.cluster\.local)?$/, '').replace(/\.cluster\.local$/, '').split('.');
  let svcName;
  let svcNs;
  if (parts.length === 1) [svcName, svcNs] = [parts[0], namespace];
  else if (parts.length === 2) {
    if (!snap.get('Namespace', '', parts[1])) return null;
    [svcName, svcNs] = parts;
  } else if (/\.svc(\.|$)/.test(host)) [svcName, svcNs] = parts;
  else return null;
  const svc = snap.get('Service', svcNs, svcName);
  if (svc) return { kind: 'Service', namespace: svcNs, name: svcName, how: 'DNS name' };
  if (parts.length <= 2 || /\.svc/.test(host)) return { kind: 'Service', namespace: svcNs, name: svcName, missing: true, how: 'DNS name' };
  return null;
}
