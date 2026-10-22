// Right-hand inspector: shows any problem, pod, node or workload, with back/forward history.
import { useEffect } from 'preact/hooks';
import { useStore, currentTarget, targetKey, closeInspector, inspectorStep, togglePin, setPanelWidth, copy } from '../app/store';
import type { IconName } from '../app/icons';
import { IconButton } from '../components/ui';
import { SidePanel } from '../components/panel';
import { FindingPage } from './finding';
import { PodPage } from './pod';
import { NodePage } from './node';
import { WorkloadPage } from './workload';

export function Inspector() {
  const s = useStore();
  const t = currentTarget();
  const key = targetKey(t);
  useEffect(() => {
    document.querySelector('.sidepanel-right .sidepanel-body')?.scrollTo({ top: 0 });
  }, [key]);
  if (!t) return null;
  const [title, icon]: [string, IconName] = t.type === 'finding' ? ['Problem', 'problems'] : t.type === 'pod' ? ['Pod', 'pods'] : t.type === 'node' ? ['Node', 'nodes'] : [t.kind, 'workloads'];
  return (
    <SidePanel side="right" title={title} icon={icon} pinned={s.insp.pinned} width={s.insp.width} min={380}
      onResize={(w) => setPanelWidth('insp', w)} onClose={closeInspector} onTogglePin={() => togglePin('insp')}
      headerLeft={
        <div class="hist-btns">
          <IconButton icon="arrowLeft" title="Back ([)" size={15} disabled={s.insp.i <= 0} onClick={() => inspectorStep(-1)} />
          <IconButton icon="arrowRight" title="Forward (])" size={15} disabled={s.insp.i >= s.insp.stack.length - 1} onClick={() => inspectorStep(1)} />
        </div>
      }
      headerRight={<IconButton icon="external" title="Copy a link to this page" onClick={() => void copy(location.href, 'Link copied')} />}>
      <div key={key} class="insp-root">
        {t.type === 'finding' && <FindingPage id={t.id} />}
        {t.type === 'pod' && <PodPage namespace={t.namespace} name={t.name} />}
        {t.type === 'node' && <NodePage name={t.name} />}
        {t.type === 'workload' && <WorkloadPage kind={t.kind} namespace={t.namespace} name={t.name} />}
      </div>
    </SidePanel>
  );
}
