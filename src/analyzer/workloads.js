// Controllers: Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs, CronJobs, HPAs, PDBs.
import { ageMs, fmtAge, cond, truncate, eventTime, eventCount, objKey, matchSelector, MIN, HOUR, DAY, ts } from './util.js';
import * as K from './knowledge.js';

const podKeys = (snap, kind, ns, name) => snap.podsOf(kind, ns, name).map((p) => objKey('Pod', ns, p.metadata.name));

// FailedCreate on a controller: quota, PodSecurity, webhooks, missing ServiceAccount, LimitRange…
function failedCreate(snap, obj, out) {
  const ns = obj.metadata.namespace;
  const name = obj.metadata.name;
  const ev = snap.eventsFor(obj.kind, ns, name).filter((e) => e.reason === 'FailedCreate' && ageMs(eventTime(e)) < 2 * HOUR);
  const rf = cond(obj, 'ReplicaFailure');
  const msg = rf?.status === 'True' ? rf.message : ev[0]?.message;
  if (!msg) return null;
  const ex = K.explainFailedCreate(msg);
  const refs = [];
  if (ex.extracted?.quota) refs.push(objKey('ResourceQuota', ns, ex.extracted.quota));
  if (ex.extracted?.webhook) refs.push(objKey('Webhook', '', ex.extracted.webhook));
  out.add({
    object: { kind: obj.kind, namespace: ns, name },
    category: 'FailedCreate', severity: 'critical', tags: ex.tags,
    title: `${obj.kind} ${name} cannot create pods`,
    rootCause: { summary: ex.summary, confidence: ex.confidence },
    evidence: [`${ev[0] ? `FailedCreate (${eventCount(ev[0])}x): ` : 'ReplicaFailure: '}${truncate(msg, 700)}`],
    fixes: ex.fixes, refs,
    commands: [snap.cmd(`describe ${obj.kind.toLowerCase()} -n ${ns} ${name}`)],
    lastSeen: ev[0] ? eventTime(ev[0]) : null,
  });
  return true;
}

export function analyzeWorkloads(snap, out) {
  for (const rs of snap.list('replicasets')) {
    if ((rs.spec?.replicas ?? 0) > 0) failedCreate(snap, rs, out);
  }

  for (const d of snap.list('deployments')) {
    const ns = d.metadata.namespace;
    const name = d.metadata.name;
    const desired = d.spec?.replicas ?? 1;
    const object = { kind: 'Deployment', namespace: ns, name };
    const commands = [snap.cmd(`rollout status deployment/${name} -n ${ns} --timeout=1s`), snap.cmd(`describe deployment -n ${ns} ${name}`)];
    if (d.spec?.paused) {
      out.add({ object, category: 'RolloutPaused', severity: 'info', title: `Deployment ${name} rollout is paused`, rootCause: { summary: 'spec.paused is true: template changes are not rolled out.', confidence: 'high' }, evidence: [], fixes: ['`kubectl rollout resume` when ready.'], commands });
    }
    if (desired === 0) continue;
    const avail = d.status?.availableReplicas || 0;
    const updated = d.status?.updatedReplicas || 0;
    const prog = cond(d, 'Progressing');
    const refs = [...podKeys(snap, 'Deployment', ns, name), ...snap.childrenOf('Deployment', ns, name).map((rs) => objKey('ReplicaSet', ns, rs.metadata.name))];
    const evidence = [`Replicas: desired ${desired}, updated ${updated}, ready ${d.status?.readyReplicas || 0}, available ${avail}, unavailable ${d.status?.unavailableReplicas || 0}`];
    if (prog) evidence.push(`Progressing=${prog.status} (${prog.reason}): ${prog.message}`);
    if (prog?.reason === 'ProgressDeadlineExceeded') {
      out.add({
        object, category: 'RolloutStuck', severity: avail === 0 ? 'critical' : 'warning',
        title: `Deployment ${name} rollout is stuck (${updated}/${desired} updated, ${avail} available)`,
        rootCause: { summary: `The new ReplicaSet did not become available within progressDeadlineSeconds (${d.spec?.progressDeadlineSeconds ?? 600}s). The new pods are failing — see the linked causes.`, confidence: 'low', derived: true },
        evidence, fixes: ['Fix the failing new pods, or roll back: `kubectl rollout undo deployment/<name>`.'], refs, commands,
        since: ts(prog.lastTransitionTime),
      });
    } else if (avail < desired) {
      const recent = ageMs(prog?.lastUpdateTime) < 3 * MIN && prog?.status === 'True';
      if (recent && avail > 0) continue;
      out.add({
        object, category: 'WorkloadUnavailable', severity: avail === 0 ? 'critical' : 'warning',
        title: `Deployment ${name}: ${avail}/${desired} replicas available`,
        rootCause: { summary: avail === 0 ? 'The Deployment has no available replica: the application is DOWN.' : 'The Deployment runs below its desired replica count (degraded).', confidence: 'low', derived: true },
        evidence, fixes: ['Fix the linked pod problems.'], refs, commands,
      });
    }
  }

  for (const s of snap.list('statefulsets')) {
    const ns = s.metadata.namespace;
    const name = s.metadata.name;
    const desired = s.spec?.replicas ?? 1;
    if (desired === 0) continue;
    failedCreate(snap, s, out);
    const ready = s.status?.readyReplicas || 0;
    if (ready >= desired) continue;
    const details = [];
    if (s.status?.updateRevision && s.status.updateRevision !== s.status.currentRevision && (s.spec?.podManagementPolicy || 'OrderedReady') === 'OrderedReady') {
      details.push('A rolling update is in progress with OrderedReady: if the updated pod never becomes Ready, the rollout is stuck. After fixing the template you may have to delete the broken pod so it is recreated from the new revision.');
    }
    out.add({
      object: { kind: 'StatefulSet', namespace: ns, name }, category: 'WorkloadUnavailable', severity: ready === 0 ? 'critical' : 'warning',
      title: `StatefulSet ${name}: ${ready}/${desired} replicas ready`,
      rootCause: { summary: ready === 0 ? 'No replica of the StatefulSet is ready: the service is DOWN.' : 'The StatefulSet runs below its desired replica count. StatefulSet pods start one by one, so a single broken pod blocks the next ones.', details, confidence: 'low', derived: true },
      evidence: [`Replicas: desired ${desired}, current ${s.status?.currentReplicas || 0}, ready ${ready}, updated ${s.status?.updatedReplicas || 0}`],
      fixes: ['Fix the linked pod problems.'], refs: podKeys(snap, 'StatefulSet', ns, name),
      commands: [snap.cmd(`describe statefulset -n ${ns} ${name}`)],
    });
  }

  for (const ds of snap.list('daemonsets')) {
    const ns = ds.metadata.namespace;
    const name = ds.metadata.name;
    const st = ds.status || {};
    failedCreate(snap, ds, out);
    const desired = st.desiredNumberScheduled || 0;
    const unavailable = st.numberUnavailable || 0;
    const mis = st.numberMisscheduled || 0;
    if (desired && unavailable === 0 && mis === 0 && (st.numberReady || 0) >= desired) continue;
    if (!desired && !mis) continue;
    out.add({
      object: { kind: 'DaemonSet', namespace: ns, name }, category: 'WorkloadUnavailable',
      severity: (st.numberReady || 0) === 0 && desired > 0 ? 'critical' : 'warning',
      title: `DaemonSet ${name}: ${st.numberReady || 0}/${desired} pods ready${mis ? `, ${mis} misscheduled` : ''}`,
      rootCause: { summary: `The DaemonSet is not running healthily on every eligible node${ns === 'kube-system' ? ' — system DaemonSets (CNI, kube-proxy, CSI) failing on a node break networking or storage for all pods on that node' : ''}.`, confidence: 'low', derived: true },
      evidence: [`desired ${desired}, current ${st.currentNumberScheduled || 0}, ready ${st.numberReady || 0}, available ${st.numberAvailable || 0}, unavailable ${unavailable}, misscheduled ${mis}`],
      fixes: ['Fix the linked pod problems.'], refs: podKeys(snap, 'DaemonSet', ns, name),
      commands: [snap.cmd(`describe daemonset -n ${ns} ${name}`)],
    });
  }

  // Jobs: report the failed ones (only the latest per CronJob).
  const latestByCron = new Map();
  for (const j of snap.list('jobs')) {
    const owner = (j.metadata.ownerReferences || []).find((o) => o.kind === 'CronJob');
    if (!owner) continue;
    const k = objKey('CronJob', j.metadata.namespace, owner.name);
    const cur = latestByCron.get(k);
    if (!cur || ts(j.metadata.creationTimestamp) > ts(cur.metadata.creationTimestamp)) latestByCron.set(k, j);
  }
  for (const j of snap.list('jobs')) {
    const ns = j.metadata.namespace;
    const name = j.metadata.name;
    failedCreate(snap, j, out);
    const failed = cond(j, 'Failed');
    const cronOwner = (j.metadata.ownerReferences || []).find((o) => o.kind === 'CronJob');
    if (failed?.status !== 'True') continue;
    if (cronOwner && latestByCron.get(objKey('CronJob', ns, cronOwner.name)) !== j) continue;
    const old = ageMs(failed.lastTransitionTime) > DAY;
    const reasons = {
      BackoffLimitExceeded: `The Job failed ${j.status?.failed || '?'} time(s) and reached backoffLimit (${j.spec?.backoffLimit ?? 6}). Each attempt crashed — see the pod causes.`,
      DeadlineExceeded: `The Job ran longer than activeDeadlineSeconds (${j.spec?.activeDeadlineSeconds}s) and was terminated.`,
      PodFailurePolicy: 'A podFailurePolicy rule marked the Job as failed.',
    };
    const allCron = cronOwner ? snap.childrenOf('CronJob', ns, cronOwner.name) : [];
    const failedRuns = allCron.filter((x) => cond(x, 'Failed')?.status === 'True').length;
    out.add({
      object: { kind: 'Job', namespace: ns, name }, category: 'JobFailed', severity: old ? 'info' : 'critical', tags: [failed.reason],
      title: `Job ${name} failed (${failed.reason})${cronOwner ? ` — latest run of CronJob ${cronOwner.name}` : ''}`,
      rootCause: { summary: reasons[failed.reason] || `Job failed: ${failed.message}`, confidence: failed.reason === 'DeadlineExceeded' ? 'high' : 'low', derived: failed.reason !== 'DeadlineExceeded' },
      evidence: [`${failed.reason}: ${failed.message}`, `Failed ${fmtAge(ageMs(failed.lastTransitionTime))} ago; succeeded ${j.status?.succeeded || 0}, failed pods ${j.status?.failed || 0}`, cronOwner ? `${failedRuns}/${allCron.length} recent runs of the CronJob failed` : null].filter(Boolean),
      fixes: ['Fix the error shown in the pod logs, then re-run.'], refs: podKeys(snap, 'Job', ns, name),
      commands: [snap.cmd(`describe job -n ${ns} ${name}`), snap.cmd(`logs -n ${ns} job/${name} --tail=100`)],
      since: ts(failed.lastTransitionTime),
    });
  }

  for (const cj of snap.list('cronjobs')) {
    const ns = cj.metadata.namespace;
    const name = cj.metadata.name;
    const object = { kind: 'CronJob', namespace: ns, name };
    if (cj.spec?.suspend) {
      out.add({ object, category: 'CronJob', severity: 'info', tags: ['Suspended'], title: `CronJob ${name} is suspended`, rootCause: { summary: 'spec.suspend is true: no new runs are scheduled.', confidence: 'high' }, evidence: [`Last schedule: ${cj.status?.lastScheduleTime || 'never'}`], fixes: [] });
    }
    const ev = snap.eventsFor('CronJob', ns, name).filter((e) => e.type === 'Warning');
    if (ev.length) {
      const e = ev[0];
      const tooMany = /too many missed start time/i.test(e.message || '');
      out.add({
        object, category: 'CronJob', severity: 'warning', tags: [e.reason],
        title: `CronJob ${name}: ${e.reason}`,
        rootCause: { summary: tooMany ? 'More than 100 schedules were missed (controller down, suspend, or clock skew) so the CronJob stops scheduling.' : truncate(e.message, 300), confidence: tooMany ? 'high' : 'medium' },
        evidence: [truncate(e.message, 500)], fixes: tooMany ? ['Set startingDeadlineSeconds so missed runs are not counted indefinitely.'] : [],
        lastSeen: eventTime(e),
      });
    }
    if (cj.status?.lastScheduleTime && cj.status?.lastSuccessfulTime && ts(cj.status.lastSuccessfulTime) < ts(cj.status.lastScheduleTime) - DAY && !cj.spec?.suspend) {
      out.add({ object, category: 'CronJob', severity: 'warning', tags: ['NoRecentSuccess'], title: `CronJob ${name} has not succeeded for ${fmtAge(ageMs(cj.status.lastSuccessfulTime))}`, rootCause: { summary: 'Recent scheduled runs did not complete successfully.', confidence: 'medium', derived: true }, evidence: [`Last success ${cj.status.lastSuccessfulTime}, last schedule ${cj.status.lastScheduleTime}`], fixes: [], refs: snap.childrenOf('CronJob', ns, name).map((j) => objKey('Job', ns, j.metadata.name)) });
    }
  }

  analyzeHpas(snap, out);
  analyzePdbs(snap, out);
}

function analyzeHpas(snap, out) {
  for (const h of snap.list('hpas')) {
    const ns = h.metadata.namespace;
    const name = h.metadata.name;
    const object = { kind: 'HorizontalPodAutoscaler', namespace: ns, name };
    const target = h.spec?.scaleTargetRef || {};
    const commands = [snap.cmd(`describe hpa -n ${ns} ${name}`)];
    if (['Deployment', 'StatefulSet', 'ReplicaSet'].includes(target.kind) && snap.has(`${target.kind.toLowerCase()}s`) && !snap.get(target.kind, ns, target.name)) {
      out.add({ object, category: 'HPA', severity: 'warning', tags: ['MissingTarget'], title: `HPA ${name} targets missing ${target.kind} ${target.name}`, rootCause: { summary: `The scale target ${target.kind} ${target.name} does not exist.`, confidence: 'high' }, evidence: [], fixes: ['Fix scaleTargetRef or delete the HPA.'], commands });
      continue;
    }
    const active = cond(h, 'ScalingActive');
    const able = cond(h, 'AbleToScale');
    const limited = cond(h, 'ScalingLimited');
    if (active?.status === 'False' || able?.status === 'False') {
      const c = active?.status === 'False' ? active : able;
      const msg = c.message || '';
      let summary = `The HPA cannot scale: ${c.reason}: ${truncate(msg, 300)}`;
      let confidence = 'medium';
      const refs = [];
      const fixes = [];
      let m;
      if ((m = msg.match(/missing request for (\w+)(?: in container ([\w-]+))?/i))) {
        summary = `The HPA scales on ${m[1]} utilization, but container ${m[2] ? `"${m[2]}" ` : ''}has no ${m[1]} request, so utilization cannot be computed.`;
        confidence = 'high';
        fixes.push(`Set resources.requests.${m[1]} on every container of the target (sidecars included).`);
      } else if (/metrics\.k8s\.io|resource metrics API|unable to fetch metrics/i.test(msg)) {
        summary = 'The HPA cannot read CPU/memory metrics: the metrics API (metrics-server) is missing or unavailable.';
        confidence = 'high';
        refs.push(objKey('APIService', '', 'v1beta1.metrics.k8s.io'));
        fixes.push('Install/repair metrics-server (see the APIService v1beta1.metrics.k8s.io).');
      } else if (/custom\.metrics|external\.metrics/i.test(msg)) {
        summary = 'The HPA uses custom/external metrics but the metrics adapter (Prometheus adapter, KEDA…) does not serve them.';
        refs.push(objKey('APIService', '', 'v1beta1.custom.metrics.k8s.io'), objKey('APIService', '', 'v1beta1.external.metrics.k8s.io'));
        fixes.push('Check the metrics adapter and the metric name/selector.');
      } else if (/did not receive metrics for targeted pods|no metrics returned/i.test(msg)) {
        summary = 'metrics-server returns no metrics for the target pods (pods not running/ready yet, or metrics-server cannot scrape the kubelets).';
        refs.push(...podKeys(snap, target.kind, ns, target.name));
      }
      out.add({ object, category: 'HPA', severity: 'warning', tags: [c.reason], title: `HPA ${name} cannot scale (${c.reason})`, rootCause: { summary, confidence }, evidence: [`${c.type}=False ${c.reason}: ${truncate(msg, 500)}`], fixes, refs, commands });
    }
    const cur = h.status?.currentReplicas;
    if (limited?.status === 'True' && limited.reason === 'TooManyReplicas' && cur >= h.spec?.maxReplicas) {
      out.add({ object, category: 'HPA', severity: 'warning', tags: ['AtMaxReplicas'], title: `HPA ${name} is pinned at maxReplicas (${cur})`, rootCause: { summary: 'Load requires more replicas than maxReplicas allows: the workload is likely saturated (higher latency, CPU throttling).', confidence: 'medium' }, evidence: [truncate(limited.message, 300)], fixes: ['Raise maxReplicas or optimize the workload.'], commands });
    }
  }
}

function analyzePdbs(snap, out) {
  for (const pdb of snap.list('pdbs')) {
    const ns = pdb.metadata.namespace;
    const name = pdb.metadata.name;
    const st = pdb.status || {};
    if (st.expectedPods === 0 || st.expectedPods == null) continue;
    if (st.disruptionsAllowed > 0) continue;
    const pods = snap.list('pods').filter((p) => p.metadata.namespace === ns && matchSelector(pdb.spec?.selector, p.metadata.labels));
    const unhealthy = st.currentHealthy < st.desiredHealthy;
    out.add({
      object: { kind: 'PodDisruptionBudget', namespace: ns, name }, category: 'PDB', severity: unhealthy ? 'warning' : 'info',
      title: `PDB ${name} allows 0 disruptions (${st.currentHealthy}/${st.expectedPods} healthy, needs ${st.desiredHealthy})`,
      rootCause: unhealthy
        ? { summary: 'Some protected pods are unhealthy, so the PDB blocks all voluntary evictions: node drains and cluster upgrades will hang.', confidence: 'medium', derived: true }
        : { summary: `The PDB is configured so that no pod may ever be evicted (${pdb.spec?.minAvailable != null ? `minAvailable=${pdb.spec.minAvailable}` : `maxUnavailable=${pdb.spec?.maxUnavailable}`} with ${st.expectedPods} pod(s)): node drains will hang.`, confidence: 'high' },
      evidence: [`expectedPods ${st.expectedPods}, currentHealthy ${st.currentHealthy}, desiredHealthy ${st.desiredHealthy}`],
      fixes: unhealthy ? ['Fix the unhealthy pods.'] : ['Use maxUnavailable: 1 or run more replicas.'],
      refs: pods.map((p) => objKey('Pod', ns, p.metadata.name)),
    });
  }
}
