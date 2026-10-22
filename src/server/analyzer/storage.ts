// PersistentVolumeClaims and PersistentVolumes.
import type { Snapshot } from './snapshot.js';
import type { FindingSink } from '../types.js';
import { ageMs, fmtAge, truncate, eventTime, MIN } from './util.js';
import * as K from './knowledge.js';

export function analyzeStorage(snap: Snapshot, out: FindingSink): void {
  const classes = snap.list('storageclasses');
  const classNames = classes.map((c) => c.metadata.name);
  const isDefault = (c: (typeof classes)[number]) => c.metadata.annotations?.['storageclass.kubernetes.io/is-default-class'] === 'true' || c.metadata.annotations?.['storageclass.beta.kubernetes.io/is-default-class'] === 'true';
  const defaultClass = classes.find(isDefault);

  for (const pvc of snap.list('pvcs')) {
    const ns = pvc.metadata.namespace ?? '';
    const name = pvc.metadata.name;
    const object = { kind: 'PersistentVolumeClaim', namespace: ns, name };
    const phase = pvc.status?.phase;
    const commands = [snap.cmd(`describe pvc -n ${ns} ${name}`)];
    const consumers = snap.list('pods').filter((p) => p.metadata.namespace === ns && (p.spec?.volumes || []).some((v) => v.persistentVolumeClaim?.claimName === name));
    if (phase === 'Pending') {
      const age = ageMs(pvc.metadata.creationTimestamp);
      const events = snap.eventsFor('PersistentVolumeClaim', ns, name);
      const warn = events.find((e) => e.type === 'Warning');
      if ((age ?? 0) < 2 * MIN && !warn) continue;
      const ev = warn || events[0];
      const sc = pvc.spec?.storageClassName;
      const scObj = sc ? classes.find((c) => c.metadata.name === sc) : defaultClass;
      const wffc = scObj?.volumeBindingMode === 'WaitForFirstConsumer' || /waiting for first consumer/i.test(ev?.message || '');
      if (wffc && consumers.length) continue; // the consumer pod's scheduling problem is the real issue
      const ex = K.explainPvcPending(ev?.message || '', { storageClassName: sc, classes: snap.has('storageclasses') ? classNames : [], defaultClass: defaultClass?.metadata.name });
      const refs: string[] = [];
      const provisioner = (ev?.message || '').match(/external provisioner "([^"]+)"/)?.[1] || scObj?.provisioner;
      out.add({
        object, category: 'PVCPending', severity: wffc && !consumers.length ? 'info' : consumers.length ? 'critical' : 'warning', tags: ex.tags,
        title: `PVC ${name} is Pending for ${fmtAge(age)}${consumers.length ? ` (blocks ${consumers.length} pod(s))` : ''}`,
        rootCause: { summary: ex.summary, confidence: ex.confidence },
        evidence: [
          `storageClassName: ${sc ?? '(unset → default)'}; default class: ${defaultClass?.metadata.name || 'none'}; provisioner: ${provisioner || '?'}`,
          `Requested ${pvc.spec?.resources?.requests?.storage || '?'} ${(pvc.spec?.accessModes || []).join(',')}`,
          ev ? `${ev.reason}: ${truncate(ev.message, 500)}` : 'No events',
          consumers.length ? `Used by: ${consumers.map((p) => p.metadata.name).join(', ')}` : 'Not used by any pod',
        ],
        fixes: ex.fixes, refs, commands, lastSeen: ev ? eventTime(ev) : null,
      });
    } else if (phase === 'Lost') {
      out.add({
        object, category: 'PVCLost', severity: 'critical',
        title: `PVC ${name} is Lost`,
        rootCause: { summary: `The PersistentVolume ${pvc.spec?.volumeName || ''} bound to this claim was deleted or is unreachable; the data may be gone.`, confidence: 'high' },
        evidence: [`volumeName: ${pvc.spec?.volumeName}`, consumers.length ? `Used by: ${consumers.map((p) => p.metadata.name).join(', ')}` : ''].filter(Boolean),
        fixes: ['Restore the PV (from backup/snapshot) or recreate the claim.'], commands,
      });
    }
    const resize = (pvc.status?.conditions || []).find((c) => ['Resizing', 'FileSystemResizePending', 'ControllerResizeError', 'NodeResizeError'].includes(c.type) && c.status === 'True');
    if (resize) {
      out.add({ object, category: 'PVCResize', severity: /Error/.test(resize.type) ? 'warning' : 'info', title: `PVC ${name}: ${resize.type}`, rootCause: { summary: resize.type === 'FileSystemResizePending' ? 'The disk was expanded; the filesystem grows when a pod (re)mounts the volume.' : truncate(resize.message || resize.type, 300), confidence: 'medium' }, evidence: [truncate(resize.message, 300)].filter(Boolean), fixes: [], commands });
    }
  }

  for (const pv of snap.list('pvs')) {
    const name = pv.metadata.name;
    const phase = pv.status?.phase;
    const object = { kind: 'PersistentVolume', namespace: '', name };
    if (phase === 'Failed') {
      out.add({ object, category: 'PVFailed', severity: 'warning', title: `PersistentVolume ${name} is Failed`, rootCause: { summary: `Automatic reclamation failed: ${pv.status?.message || 'unknown reason'}.`, confidence: 'medium' }, evidence: [`reclaimPolicy ${pv.spec?.persistentVolumeReclaimPolicy}`, pv.status?.message].filter(Boolean), fixes: ['Clean the volume manually and delete/recreate the PV.'], commands: [snap.cmd(`describe pv ${name}`)] });
    } else if (phase === 'Released' && pv.spec?.persistentVolumeReclaimPolicy === 'Retain') {
      out.add({ object, category: 'PVReleased', severity: 'info', title: `PersistentVolume ${name} is Released (Retain)`, rootCause: { summary: `Its claim ${pv.spec?.claimRef?.namespace}/${pv.spec?.claimRef?.name} was deleted; the volume and data are kept but cannot be bound again until claimRef is cleared.`, confidence: 'high' }, evidence: [`capacity ${pv.spec?.capacity?.storage}`], fixes: ['Delete the PV and its backing disk if the data is not needed, or clear spec.claimRef to reuse it.'], commands: [snap.cmd(`describe pv ${name}`)] });
    }
  }
}
