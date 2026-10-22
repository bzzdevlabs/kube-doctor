// Side panel: docks into the layout when pinned, floats over the content
// (without dimming or blurring it) when unpinned. Resizable from its inner edge.
import type { ComponentChildren } from 'preact';
import { Icon, type IconName } from '../app/icons';
import { IconButton, ResizeHandle } from './ui';

interface Props {
  side: 'left' | 'right';
  title: string;
  icon?: IconName;
  pinned: boolean;
  width: number;
  min?: number;
  onResize: (w: number) => void;
  onClose: () => void;
  onTogglePin: () => void;
  headerLeft?: ComponentChildren;
  headerRight?: ComponentChildren;
  children: ComponentChildren;
  className?: string;
}

export function SidePanel({ side, title, icon, pinned, width, min = 280, onResize, onClose, onTogglePin, headerLeft, headerRight, children, className = '' }: Props) {
  return (
    <aside class={`sidepanel sidepanel-${side} ${pinned ? 'is-pinned' : 'is-floating'} ${className}`} style={{ width: `${width}px` }} aria-label={title}>
      <ResizeHandle side={side === 'right' ? 'right' : 'left'} width={width} onResize={onResize} min={min} />
      <div class="sidepanel-head">
        {headerLeft}
        <div class="sidepanel-title">{icon && <Icon name={icon} size={15} />}<span>{title}</span></div>
        <div class="sidepanel-actions">
          {headerRight}
          <IconButton icon={pinned ? 'pinOff' : 'pin'} title={pinned ? 'Unpin (float over the page)' : 'Pin (dock next to the page)'} active={pinned} onClick={onTogglePin} />
          <IconButton icon="x" title="Close (Esc)" onClick={onClose} />
        </div>
      </div>
      <div class="sidepanel-body">{children}</div>
    </aside>
  );
}
