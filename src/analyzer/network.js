// Services, endpoints, ingresses and admission webhooks.
import { ageMs, fmtAge, matchLabels, objKey, truncate, eventTime, cond, MIN, uniq } from './util.js';

// Typo detector for label values: containment or small edit distance.
function similar(a, b) {
  a = String(a).toLowerCase();
  b = String(b).toLowerCase();
  if (a.includes(b) || b.includes(a)) return true;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length] <= Math.max(2, Math.floor(Math.max(a.length, b.length) / 4));
}

const isReady = (p) => cond(p, 'Ready')?.status === 'True';
const alive = (p) => !p.metadata.deletionTimestamp && !['Succeeded', 'Failed'].includes(p.status?.phase);

// Computes, for every Service, which pods it selects and how many endpoints are ready.
export function serviceHealth(snap) {
  const slices = new Map();
  for (const s of snap.list('endpointslices')) {
    const svc = s.metadata?.labels?.['kubernetes.io/service-name'];
    if (!svc) continue;
    const k = objKey('Service', s.metadata.namespace, svc);
    const cur = slices.get(k) || { ready: 0, notReady: 0 };
    for (const e of s.endpoints || []) {
      if (e.conditions?.ready === false) cur.notReady++;
      else cur.ready++;
    }
    slices.set(k, cur);
  }
  const podsByNs = new Map();
  for (const p of snap.list('pods')) {
    if (!podsByNs.has(p.metadata.namespace)) podsByNs.set(p.metadata.namespace, []);
    podsByNs.get(p.metadata.namespace).push(p);
  }
  const health = new Map();
  for (const svc of snap.list('services')) {
    const ns = svc.metadata.namespace;
    const k = objKey('Service', ns, svc.metadata.name);
    const sel = svc.spec?.selector;
    const hasSelector = sel && Object.keys(sel).length > 0;
    const pods = hasSelector ? (podsByNs.get(ns) || []).filter((p) => alive(p) && matchLabels(sel, p.metadata.labels)) : [];
    const sl = slices.get(k);
    health.set(k, {
      svc, hasSelector, pods,
      readyPods: pods.filter(isReady),
      endpointsReady: sl ? sl.ready : null,
      endpointsNotReady: sl ? sl.notReady : null,
    });
  }
  return health;
}

export function analyzeNetwork(snap, out) {
  const health = serviceHealth(snap);

  // Who depends on which service (for severity and impact).
  const ingressUsers = new Map();
  for (const ing of snap.list('ingresses')) {
    for (const b of ingressBackends(ing)) {
      const k = objKey('Service', ing.metadata.namespace, b.service);
      if (!ingressUsers.has(k)) ingressUsers.set(k, []);
      ingressUsers.get(k).push(ing.metadata.name);
    }
  }

  for (const [k, h] of health) {
    const { svc } = h;
    const ns = svc.metadata.namespace;
    const name = svc.metadata.name;
    const object = { kind: 'Service', namespace: ns, name };
    const type = svc.spec?.type || 'ClusterIP';
    const commands = [snap.cmd(`get endpointslices -n ${ns} -l kubernetes.io/service-name=${name}`), snap.cmd(`describe service -n ${ns} ${name}`)];
    if (type === 'ExternalName' || !h.hasSelector) continue;
    const users = ingressUsers.get(k) || [];
    const usedBy = users.length ? ` It is exposed by Ingress ${users.join(', ')}.` : '';
    const selText = Object.entries(svc.spec.selector).map(([a, b]) => `${a}=${b}`).join(',');

    if (!h.pods.length) {
      if (ageMs(svc.metadata.creationTimestamp) < 2 * MIN) continue;
      // Near-miss analysis: pods that have the selector keys but other values.
      const nsPods = snap.list('pods').filter((p) => p.metadata.namespace === ns && alive(p));
      const keys = Object.keys(svc.spec.selector);
      const hints = [];
      for (const key of keys) {
        const want = svc.spec.selector[key];
        const values = uniq(nsPods.filter((p) => p.metadata.labels?.[key] != null && p.metadata.labels[key] !== want).map((p) => p.metadata.labels[key])).filter((v) => similar(v, want));
        if (values.length) hints.push(`Pods in ${ns} have ${key}=${values.slice(0, 5).join(' | ')} (service wants ${key}=${svc.spec.selector[key]}).`);
      }
      const workloads = [...snap.list('deployments'), ...snap.list('statefulsets'), ...snap.list('daemonsets')].filter((d) => d.metadata.namespace === ns && matchLabels(svc.spec.selector, d.spec?.template?.metadata?.labels));
      const scaledToZero = workloads.filter((d) => d.kind !== 'DaemonSet' && (d.spec?.replicas ?? 1) === 0);
      const podless = workloads.filter((d) => !scaledToZero.includes(d));
      let summary = `The selector ${selText} matches no running pod, so the Service has no endpoints and every connection to it fails.${usedBy}`;
      let confidence = 'medium';
      let derived = false;
      if (podless.length) {
        summary = `The selector matches ${podless.map((d) => `${d.kind} ${d.metadata.name}`).join(', ')}, but it currently has no pods, so the Service has no endpoints.${usedBy}`;
        confidence = 'low';
        derived = true;
        hints.length = 0;
      } else if (scaledToZero.length) {
        summary = `The pods behind this Service belong to ${scaledToZero.map((d) => `${d.kind} ${d.metadata.name}`).join(', ')}, which is scaled to 0 replicas.${usedBy}`;
        confidence = 'high';
      } else if (hints.length) {
        summary = `Label mismatch: the selector ${selText} matches no pod, but similar pods exist with different label values — most likely a typo in the Service selector or in the pod labels.${usedBy}`;
        confidence = 'high';
      }
      out.add({
        object, category: 'ServiceNoEndpoints', severity: users.length ? 'critical' : 'warning',
        title: `Service ${name} selects no pods (selector ${selText})`,
        rootCause: { summary, details: hints, confidence, derived },
        evidence: [`Type ${type}, selector ${selText}`],
        fixes: podless.length ? ['Fix the workload that cannot create its pods (see causes).'] : ['Align the Service selector with the pod template labels, or start the backing workload.'],
        commands, refs: workloads.map((d) => objKey(d.kind, ns, d.metadata.name)),
        meta: { ingress: users },
      });
      continue;
    }

    if (!h.readyPods.length) {
      out.add({
        object, category: 'ServiceNoEndpoints', severity: 'critical',
        title: `Service ${name} has no ready endpoints (0/${h.pods.length} pods ready)`,
        rootCause: { summary: `All ${h.pods.length} pod(s) selected by the Service are not Ready, so traffic to ${name} fails (connection refused / 503).${usedBy}`, confidence: 'low', derived: true },
        evidence: [`Selector ${selText}`, `Pods: ${h.pods.slice(0, 8).map((p) => `${p.metadata.name} (${p.status?.phase})`).join(', ')}`],
        fixes: ['Fix the pods behind the Service (see causes).'],
        commands, refs: h.pods.map((p) => objKey('Pod', ns, p.metadata.name)),
        meta: { ingress: users },
      });
    }

    // targetPort checks against the selected pods' container ports.
    const containers = h.pods.flatMap((p) => p.spec?.containers || []);
    for (const port of svc.spec?.ports || []) {
      const tp = port.targetPort ?? port.port;
      if (typeof tp === 'string' && !/^\d+$/.test(tp)) {
        if (!containers.some((c) => (c.ports || []).some((cp) => cp.name === tp))) {
          out.add({
            object, category: 'ServicePortMismatch', severity: 'critical',
            title: `Service ${name}: targetPort "${tp}" is not a named port of its pods`,
            rootCause: { summary: `Port ${port.port} targets the named port "${tp}", but no selected container declares a port with that name, so the endpoint has no port and traffic fails.`, confidence: 'high' },
            evidence: [`Container ports: ${uniq(containers.flatMap((c) => (c.ports || []).map((cp) => `${cp.name || '(unnamed)'}:${cp.containerPort}`))).join(', ') || 'none declared'}`],
            fixes: ['Name the container port accordingly or use a numeric targetPort.'], commands,
          });
        }
      } else {
        const declared = uniq(containers.flatMap((c) => (c.ports || []).map((cp) => cp.containerPort)));
        if (declared.length && !declared.includes(Number(tp))) {
          out.add({
            object, category: 'ServicePortMismatch', severity: 'warning',
            title: `Service ${name}: targetPort ${tp} is not declared by its pods`,
            rootCause: { summary: `Port ${port.port} forwards to ${tp}, but the selected containers declare ${declared.join(', ')}. If the app does not listen on ${tp}, connections are refused.`, confidence: 'medium' },
            evidence: [`Service port ${port.name || ''} ${port.port} → ${tp}`, `Declared containerPorts: ${declared.join(', ')}`],
            fixes: ['Set targetPort to the port the app really listens on.'], commands,
          });
        }
      }
    }

    if (type === 'LoadBalancer' && !(svc.status?.loadBalancer?.ingress || []).length && ageMs(svc.metadata.creationTimestamp) > 5 * MIN) {
      const ev = snap.eventsFor('Service', ns, name).find((e) => e.type === 'Warning');
      out.add({
        object, category: 'LoadBalancerPending', severity: 'warning',
        title: `LoadBalancer Service ${name} has no external address after ${fmtAge(ageMs(svc.metadata.creationTimestamp))}`,
        rootCause: { summary: ev ? `The cloud controller failed to provision the load balancer: ${truncate(ev.message, 300)}` : 'No load-balancer controller provisioned an address (no cloud controller / MetalLB on this cluster, quota exhausted, or missing annotations/subnet tags).', confidence: ev ? 'high' : 'medium' },
        evidence: ev ? [`${ev.reason}: ${truncate(ev.message, 500)}`] : [], fixes: ['Check the cloud-controller-manager / load balancer controller logs.'], commands,
        lastSeen: ev ? eventTime(ev) : null,
      });
    }
  }

  analyzeIngresses(snap, out, health);
  analyzeWebhooks(snap, out, health);
}

export function ingressBackends(ing) {
  const list = [];
  const d = ing.spec?.defaultBackend?.service;
  if (d) list.push({ service: d.name, port: d.port?.number ?? d.port?.name, host: '*', path: '(default)' });
  for (const rule of ing.spec?.rules || []) {
    for (const p of rule.http?.paths || []) {
      const s = p.backend?.service;
      if (s) list.push({ service: s.name, port: s.port?.number ?? s.port?.name, host: rule.host || '*', path: p.path || '/' });
    }
  }
  return list;
}

function analyzeIngresses(snap, out, health) {
  const classes = snap.list('ingressclasses');
  const defaultClass = classes.find((c) => c.metadata.annotations?.['ingressclass.kubernetes.io/is-default-class'] === 'true');
  for (const ing of snap.list('ingresses')) {
    const ns = ing.metadata.namespace;
    const name = ing.metadata.name;
    const object = { kind: 'Ingress', namespace: ns, name };
    const commands = [snap.cmd(`describe ingress -n ${ns} ${name}`)];
    const broken = [];
    const down = [];
    for (const b of ingressBackends(ing)) {
      const svc = snap.get('Service', ns, b.service);
      if (!svc) {
        if (snap.has('services')) broken.push(`${b.host}${b.path} → Service "${b.service}" does not exist`);
        continue;
      }
      const ports = svc.spec?.ports || [];
      if (b.port != null && !ports.some((p) => p.port === b.port || p.name === b.port)) {
        broken.push(`${b.host}${b.path} → Service "${b.service}" has no port ${b.port} (ports: ${ports.map((p) => p.name ? `${p.name}/${p.port}` : p.port).join(', ')})`);
        continue;
      }
      const h = health.get(objKey('Service', ns, b.service));
      if (h?.hasSelector && !h.readyPods.length) down.push(b);
    }
    if (broken.length) {
      out.add({
        object, category: 'IngressBackend', severity: 'critical',
        title: `Ingress ${name} routes to missing backends`,
        rootCause: { summary: `The ingress controller cannot route ${broken.length} path(s): ${broken[0]}. Requests get 503/404.`, confidence: 'high' },
        evidence: broken, fixes: ['Fix the backend service name/port in the Ingress.'], commands,
      });
    }
    if (down.length) {
      const hosts = uniq(down.map((b) => b.host));
      out.add({
        object, category: 'IngressBackend', severity: 'critical',
        title: `Ingress ${name} (${hosts.join(', ')}) serves errors: backend has no ready pods`,
        rootCause: { summary: `Service(s) ${uniq(down.map((b) => b.service)).join(', ')} behind this Ingress have no ready endpoints; users get 502/503.`, confidence: 'low', derived: true },
        evidence: down.map((b) => `${b.host}${b.path} → ${b.service}:${b.port}`), fixes: ['Fix the backend pods (see causes).'], commands,
        refs: uniq(down.map((b) => objKey('Service', ns, b.service))),
      });
    }
    const cls = ing.spec?.ingressClassName || ing.metadata.annotations?.['kubernetes.io/ingress.class'];
    if (snap.has('ingressclasses')) {
      if (cls && ing.spec?.ingressClassName && !classes.some((c) => c.metadata.name === cls)) {
        out.add({ object, category: 'IngressBackend', severity: 'warning', tags: ['IngressClass'], title: `Ingress ${name} uses unknown IngressClass "${cls}"`, rootCause: { summary: `No IngressClass "${cls}" exists, so no controller serves this Ingress.`, confidence: 'high' }, evidence: [`Available: ${classes.map((c) => c.metadata.name).join(', ') || 'none'}`], fixes: ['Fix ingressClassName.'], commands });
      } else if (!cls && !defaultClass) {
        out.add({ object, category: 'IngressBackend', severity: 'warning', tags: ['IngressClass'], title: `Ingress ${name} has no ingress class and there is no default class`, rootCause: { summary: 'Without ingressClassName and without a default IngressClass, most controllers ignore the Ingress.', confidence: 'medium' }, evidence: [`IngressClasses: ${classes.map((c) => c.metadata.name).join(', ') || 'none'}`], fixes: ['Set spec.ingressClassName.'], commands });
      }
    }
  }
}

function analyzeWebhooks(snap, out, health) {
  for (const cfg of [...snap.list('validatingwebhooks'), ...snap.list('mutatingwebhooks')]) {
    for (const wh of cfg.webhooks || []) {
      const ref = wh.clientConfig?.service;
      if (!ref) continue;
      const policy = wh.failurePolicy || 'Fail';
      const svcKey = objKey('Service', ref.namespace, ref.name);
      const svc = snap.get('Service', ref.namespace, ref.name);
      const h = health.get(svcKey);
      const scope = (wh.rules || []).map((r) => `${(r.operations || []).join('/')} ${(r.resources || []).join(',')}`).join('; ');
      let problem = null;
      if (!svc && snap.has('services') && (!snap.info.scannedNamespace || snap.info.scannedNamespace === ref.namespace)) problem = `its Service ${ref.namespace}/${ref.name} does not exist`;
      else if (h?.hasSelector && !h.readyPods.length) problem = `its Service ${ref.namespace}/${ref.name} has no ready endpoints`;
      if (!problem) continue;
      const blocking = policy === 'Fail';
      out.add({
        object: { kind: cfg.kind, namespace: '', name: cfg.metadata.name }, aliases: [objKey('Webhook', '', wh.name)],
        category: 'WebhookUnavailable', severity: blocking ? 'critical' : 'warning',
        title: `Admission webhook "${wh.name}" is down (${problem.replace(/^its /, '')})`,
        rootCause: {
          summary: blocking
            ? `The API server must call webhook "${wh.name}" for ${scope || 'matching requests'} but ${problem}. With failurePolicy=Fail every such request is REJECTED${/\bpods\b|\*/.test(scope) ? ' — new pods cannot be created, so deployments cannot scale or roll out' : ''}.`
            : `Webhook "${wh.name}" is unavailable (${problem}); failurePolicy=Ignore so requests pass without its validation/mutation.`,
          confidence: 'high',
        },
        evidence: [`${cfg.kind} ${cfg.metadata.name}`, `failurePolicy=${policy}`, `Rules: ${scope || 'n/a'}`, wh.namespaceSelector ? `namespaceSelector: ${truncate(JSON.stringify(wh.namespaceSelector), 200)}` : null].filter(Boolean),
        fixes: ['Repair the webhook backend pods.', blocking ? 'In an emergency an admin can set failurePolicy: Ignore or delete the webhook configuration of an uninstalled tool.' : ''].filter(Boolean),
        refs: [svcKey],
        commands: [snap.cmd(`get ${cfg.kind === 'MutatingWebhookConfiguration' ? 'mutatingwebhookconfiguration' : 'validatingwebhookconfiguration'} ${cfg.metadata.name} -o yaml`), snap.cmd(`get pods -n ${ref.namespace}`)],
      });
    }
  }
}
