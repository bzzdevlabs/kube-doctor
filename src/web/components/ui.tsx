// Small reusable UI building blocks.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Confidence, Finding, ObjRef, Severity } from '../../shared/types';
import { Icon, type IconName } from '../app/icons';
import { S, setCollapsed, copy, inspect, inspectFinding, findingsFor, type Target } from '../app/store';
import type { Tone } from '../app/fmt';

export function SevBadge({ sev, label, compact }: { sev: Severity | 'ok' | null | undefined; label?: string; compact?: boolean }) {
  if (!sev) return null;
  return <span class={`sev sev-${sev}${compact ? ' compact' : ''}`} title={sev}>{compact ? '' : label || sev}</span>;
}

export function Dot({ tone }: { tone?: Tone }) {
  return <span class={`dot dot-${tone || 'neutral'}`} />;
}

export function Badge({ tone = 'neutral', children, title, onClick }: { tone?: Tone | 'new'; children: ComponentChildren; title?: string; onClick?: () => void }) {
  return <span class={`badge badge-${tone}${onClick ? ' clickable' : ''}`} title={title} onClick={onClick}>{children}</span>;
}

export const NewBadge = () => <span class="badge badge-new" title="First seen within the last 30 minutes">NEW</span>;

export const Kbd = ({ children }: { children: ComponentChildren }) => <kbd>{children}</kbd>;

interface ButtonProps {
  icon?: IconName;
  children?: ComponentChildren;
  onClick?: (e: MouseEvent) => void;
  variant?: 'default' | 'primary' | 'ghost';
  title?: string;
  disabled?: boolean;
  size?: 'sm';
  active?: boolean;
}

export function Button({ icon, children, onClick, variant = 'default', title, disabled, size, active }: ButtonProps) {
  return (
    <button type="button" class={`btn btn-${variant}${size ? ` btn-${size}` : ''}${active ? ' active' : ''}`} onClick={onClick} title={title} disabled={disabled}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children != null && children !== '' && <span>{children}</span>}
    </button>
  );
}

export function IconButton({ icon, title, onClick, active, disabled, size = 16, className = '' }: { icon: IconName; title: string; onClick?: (e: MouseEvent) => void; active?: boolean; disabled?: boolean; size?: number; className?: string }) {
  return (
    <button type="button" class={`icon-btn${active ? ' active' : ''} ${className}`} onClick={onClick} title={title} aria-label={title} disabled={disabled}>
      <Icon name={icon} size={size} />
    </button>
  );
}

export const Spinner = ({ size = 16 }: { size?: number }) => <span class="spinner" style={{ width: `${size}px`, height: `${size}px` }} />;

export function Empty({ icon = 'check', title, children, tone }: { icon?: IconName; title: ComponentChildren; children?: ComponentChildren; tone?: Tone }) {
  return (
    <div class={`empty${tone ? ` empty-${tone}` : ''}`}>
      <div class="empty-icon"><Icon name={icon} size={28} /></div>
      <div class="empty-title">{title}</div>
      {children && <div class="empty-body">{children}</div>}
    </div>
  );
}

interface SectionProps {
  id?: string;
  title: ComponentChildren;
  icon?: IconName;
  count?: number | null;
  actions?: ComponentChildren;
  defaultOpen?: boolean;
  children: ComponentChildren;
  className?: string;
  flush?: boolean;
  subtitle?: ComponentChildren;
}

// Card with a header that collapses its body; the state is remembered per id.
export function Section({ id, title, icon, count, actions, defaultOpen = true, children, className = '', flush, subtitle }: SectionProps) {
  const [local, setLocal] = useState(!defaultOpen);
  const collapsed = id ? (S.collapsed[id] ?? !defaultOpen) : local;
  const toggle = () => (id ? setCollapsed(id, !collapsed) : setLocal(!collapsed));
  return (
    <section class={`section ${collapsed ? 'is-collapsed' : ''} ${className}`}>
      <header class="section-head">
        <button type="button" class="section-toggle" onClick={toggle} aria-expanded={!collapsed}>
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={14} className="chev" />
          {icon && <Icon name={icon} size={15} />}
          <span class="section-title">{title}</span>
          {count != null && <span class="count">{count}</span>}
          {subtitle && <span class="section-sub">{subtitle}</span>}
        </button>
        {actions && <div class="section-actions">{actions}</div>}
      </header>
      {!collapsed && <div class={`section-body${flush ? ' flush' : ''}`}>{children}</div>}
    </section>
  );
}

// Lightweight inline disclosure (no card chrome).
export function Disclosure({ summary, children, defaultOpen = false, className = '' }: { summary: ComponentChildren; children: ComponentChildren; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div class={`disclosure ${open ? 'open' : ''} ${className}`}>
      <button type="button" class="disclosure-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} className="chev" />
        {summary}
      </button>
      {open && <div class="disclosure-body">{children}</div>}
    </div>
  );
}

export interface TabDef {
  id: string;
  label: string;
  icon?: IconName;
  count?: number;
  dot?: Tone;
}

export function Tabs({ tabs, active, onChange }: { tabs: (TabDef | false | null | undefined)[]; active: string; onChange: (id: string) => void }) {
  return (
    <div class="tabs" role="tablist">
      {tabs.filter((t): t is TabDef => !!t).map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === active} class={`tab${t.id === active ? ' active' : ''}`} onClick={() => onChange(t.id)}>
          {t.icon && <Icon name={t.icon} size={14} />}
          <span>{t.label}</span>
          {t.count != null && <span class="count">{t.count}</span>}
          {t.dot && <Dot tone={t.dot} />}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange, title }: { options: { value: T; label: string; icon?: IconName; iconOnly?: boolean; title?: string }[]; value: T; onChange: (v: T) => void; title?: string }) {
  return (
    <div class="segmented" role="radiogroup" title={title}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} class={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} title={o.title || o.label}>
          {o.icon && <Icon name={o.icon} size={14} />}
          {!o.iconOnly && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string>({ value, options, onChange, label, title }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string; title?: string }) {
  return (
    <label class="select" title={title}>
      {label && <span class="select-label">{label}</span>}
      <select value={value} onChange={(e) => onChange(e.currentTarget.value as T)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function SearchBox({ value, onInput, placeholder = 'Search…', id }: { value: string; onInput: (v: string) => void; placeholder?: string; id?: string }) {
  return (
    <div class="searchbox">
      <Icon name="search" size={15} />
      <input id={id} type="search" value={value} placeholder={placeholder} onInput={(e) => onInput(e.currentTarget.value)} />
      {value ? (
        <button type="button" class="clear" onClick={() => onInput('')} title="Clear"><Icon name="x" size={13} /></button>
      ) : id === 'view-search' ? <Kbd>/</Kbd> : null}
    </div>
  );
}

export function Bar({ value, max, tone, title, label, thin, marker }: { value: number; max: number | null | undefined; tone?: Tone; title?: string; label?: ComponentChildren; thin?: boolean; marker?: number | null }) {
  const p = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const t = tone || (p >= 95 ? 'crit' : p >= 80 ? 'warn' : 'accent');
  return (
    <div class={`bar${thin ? ' thin' : ''}`} title={title}>
      <div class="bar-track">
        <div class={`bar-fill tone-${t}`} style={{ width: `${p}%` }} />
        {marker != null && max ? <div class="bar-marker" style={{ left: `${Math.min(100, (marker / max) * 100)}%` }} /> : null}
      </div>
      {label != null && <span class="bar-label">{label}</span>}
    </div>
  );
}

export function StackBar({ parts, total, title }: { parts: { value: number; tone: Tone; label: string }[]; total?: number; title?: string }) {
  const sum = total || parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <div class="stackbar" title={title}>
      {parts.filter((p) => p.value > 0).map((p) => <span key={p.label} class={`seg tone-${p.tone}`} style={{ width: `${(p.value / sum) * 100}%` }} title={`${p.label}: ${p.value}`} />)}
    </div>
  );
}

export function KV({ items, className = '' }: { items: ([ComponentChildren, ComponentChildren] | false | null | undefined)[]; className?: string }) {
  const rows = items.filter((x): x is [ComponentChildren, ComponentChildren] => !!x && x[1] != null && x[1] !== '' && x[1] !== false);
  return (
    <dl class={`kv ${className}`}>
      {rows.map(([k, v], i) => [<dt key={`k${i}`}>{k}</dt>, <dd key={`v${i}`}>{v}</dd>])}
    </dl>
  );
}

export function CopyButton({ text, label = 'Copy', what }: { text: string; label?: string; what?: string }) {
  return (
    <button type="button" class="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); void copy(text, what); }} title="Copy to clipboard">
      <Icon name="copy" size={13} />{label && <span>{label}</span>}
    </button>
  );
}

export const CommandLine = ({ cmd }: { cmd: string }) => (
  <div class="cmdline"><code>{cmd}</code><CopyButton text={cmd} label="" what="Command copied" /></div>
);

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob']);

// Best inspector target for any Kubernetes object reference.
export function targetFor(obj: ObjRef | null | undefined): Target | null {
  if (!obj || !S.idx) return null;
  if (obj.kind === 'Pod' && S.idx.pods.has(`${obj.namespace}/${obj.name}`)) return { type: 'pod', namespace: obj.namespace, name: obj.name };
  if (obj.kind === 'Node' && S.idx.nodes.has(obj.name)) return { type: 'node', name: obj.name };
  if (WORKLOAD_KINDS.has(obj.kind) && S.idx.workloads.has(`${obj.kind}/${obj.namespace}/${obj.name}`)) {
    return { type: 'workload', kind: obj.kind as 'Deployment', namespace: obj.namespace, name: obj.name };
  }
  const f = findingsFor(obj.kind, obj.namespace, obj.name)[0];
  return f ? { type: 'finding', id: f.id } : null;
}

export function ObjRefLink({ obj, plain, short }: { obj: ObjRef | null | undefined; plain?: boolean; short?: boolean }) {
  if (!obj) return null;
  const t = plain ? null : targetFor(obj);
  const body = (
    <>
      <span class="kind">{obj.kind}</span>{' '}
      <span class="objname">{!short && obj.namespace ? <span class="ns">{obj.namespace}/</span> : null}{obj.name}</span>
    </>
  );
  return t ? (
    <button type="button" class="objref" onClick={(e) => { e.stopPropagation(); inspect(t); }} title="Open in inspector">{body}</button>
  ) : (
    <span class="objref static">{body}</span>
  );
}

export function FindingLink({ f, showObj = true }: { f: Finding; showObj?: boolean }) {
  return (
    <button type="button" class="finding-link" onClick={(e) => { e.stopPropagation(); inspectFinding(f.id); }}>
      <SevBadge sev={f.severity} compact />
      <span class="cat-chip">{f.category}</span>
      {showObj && <span class="mono muted">{f.object.kind} {f.object.namespace ? `${f.object.namespace}/` : ''}{f.object.name}</span>}
      <span class="finding-link-title">{f.title}</span>
    </button>
  );
}

export function ConfidenceMeter({ level }: { level: Confidence | undefined }) {
  if (!level) return null;
  const n = { high: 3, medium: 2, low: 1 }[level];
  return (
    <span class={`confidence conf-${level}`} title={`${level} confidence in this diagnosis`}>
      <span class="conf-bars">{[1, 2, 3].map((i) => <i key={i} class={i <= n ? 'on' : ''} />)}</span>
      {level}
    </span>
  );
}

export interface MenuItem {
  icon?: IconName;
  label: string;
  hint?: string;
  onClick: () => void;
}

// Dropdown menu anchored to a button; closes on outside click or Escape.
export function Menu({ label, icon, items, align = 'right', title }: { label?: string; icon?: IconName; items: (MenuItem | '-')[]; align?: 'left' | 'right'; title?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div class="menu-wrap" ref={ref}>
      <Button icon={icon} onClick={() => setOpen(!open)} title={title} active={open}>{label}</Button>
      {open && (
        <div class={`menu menu-${align}`} role="menu">
          {items.map((it, i) => (it === '-' ? <div key={i} class="menu-sep" /> : (
            <button key={i} type="button" role="menuitem" class="menu-item" onClick={() => { setOpen(false); it.onClick(); }}>
              {it.icon ? <Icon name={it.icon} size={15} /> : <span class="menu-icon-gap" />}
              <span>{it.label}</span>
              {it.hint && <span class="menu-hint">{it.hint}</span>}
            </button>
          )))}
        </div>
      )}
    </div>
  );
}

// Resize handle for side panels (drag to change width).
export function ResizeHandle({ side, width, onResize, min = 300, max = 1200 }: { side: 'left' | 'right'; width: number; onResize: (w: number) => void; min?: number; max?: number }) {
  const onDown = (e: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const limit = Math.min(max, window.innerWidth * 0.8);
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      onResize(Math.round(Math.max(min, Math.min(limit, side === 'right' ? startW - dx : startW + dx))));
    };
    const up = () => {
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div class={`resize-handle resize-${side}`} onPointerDown={onDown} title="Drag to resize" role="separator" aria-orientation="vertical" />;
}
