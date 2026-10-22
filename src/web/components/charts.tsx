// Dependency-free SVG/HTML charts.
import type { ComponentChildren } from 'preact';
import { clock, type Tone } from '../app/fmt';

export interface Segment {
  label: string;
  value: number;
  tone: Tone;
  onClick?: () => void;
}

export function Donut({ segments, size = 128, thickness = 15, center }: { segments: Segment[]; size?: number; thickness?: number; center?: ComponentChildren }) {
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((a, s) => a + s.value, 0);
  const visible = segments.filter((s) => s.value > 0);
  let offset = 0;
  const mid = size / 2;
  return (
    <div class="donut" style={{ width: `${size}px`, height: `${size}px` }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img">
        <circle class="donut-track" cx={mid} cy={mid} r={r} stroke-width={thickness} fill="none" />
        {visible.map((s) => {
          const len = total ? (s.value / total) * c : 0;
          const gap = visible.length > 1 ? Math.min(2, len / 3) : 0;
          const dash = Math.max(0, len - gap);
          const el = (
            <circle key={s.label} class={`donut-seg s-${s.tone}${s.onClick ? ' clickable' : ''}`} cx={mid} cy={mid} r={r} fill="none" stroke-width={thickness}
              stroke-dasharray={`${dash} ${c - dash}`} stroke-dashoffset={-offset} transform={`rotate(-90 ${mid} ${mid})`} onClick={s.onClick}>
              <title>{s.label}: {s.value}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      </svg>
      <div class="donut-center">{center}</div>
    </div>
  );
}

export function Legend({ items }: { items: Segment[] }) {
  return (
    <ul class="legend">
      {items.map((i) => (
        <li key={i.label} class={i.onClick ? 'clickable' : ''} onClick={i.onClick}>
          <span class={`swatch bg-${i.tone}`} /><span class="legend-label">{i.label}</span><span class="legend-value">{i.value}</span>
        </li>
      ))}
    </ul>
  );
}

export interface BarItem {
  label: string;
  value: number;
  tone?: Tone;
  title?: string;
  onClick?: () => void;
}

export function BarList({ items, max, empty = 'No data' }: { items: BarItem[]; max?: number; empty?: string }) {
  if (!items.length) return <div class="muted small">{empty}</div>;
  const m = max || Math.max(...items.map((i) => i.value), 1);
  return (
    <ul class="barlist">
      {items.map((i) => (
        <li key={i.label} class={i.onClick ? 'clickable' : ''} onClick={i.onClick} title={i.title || `${i.label}: ${i.value}`}>
          <span class="barlist-label">{i.label}</span>
          <span class="barlist-track"><span class={`barlist-fill bg-${i.tone || 'accent'}`} style={{ width: `${Math.max(2, (i.value / m) * 100)}%` }} /></span>
          <span class="barlist-value">{i.value}</span>
        </li>
      ))}
    </ul>
  );
}

export interface Bucket {
  t: number;
  span: number;
  values: Record<string, number>;
}

// Stacked column chart over time.
export function Histogram({ buckets, series, height = 96, onBucket }: { buckets: Bucket[]; series: { key: string; tone: Tone; label: string }[]; height?: number; onBucket?: (b: Bucket) => void }) {
  const w = 100 / Math.max(1, buckets.length);
  const max = Math.max(1, ...buckets.map((b) => series.reduce((a, s) => a + (b.values[s.key] || 0), 0)));
  return (
    <div class="histogram">
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img">
        {[0.25, 0.5, 0.75].map((f) => <line key={f} class="grid-line" x1="0" x2="100" y1={height * f} y2={height * f} />)}
        {buckets.map((b, i) => {
          let y = height;
          return series.map((s) => {
            const v = b.values[s.key] || 0;
            const h = (v / max) * (height - 4);
            y -= h;
            return v ? (
              <rect key={`${i}-${s.key}`} class={`s-fill-${s.tone}${onBucket ? ' clickable' : ''}`} x={i * w + w * 0.12} y={y} width={w * 0.76} height={h} onClick={onBucket ? () => onBucket(b) : undefined}>
                <title>{clock(b.t)} – {clock(b.t + b.span)}: {v} {s.label}</title>
              </rect>
            ) : null;
          });
        })}
      </svg>
      <div class="histogram-axis"><span>{buckets.length ? clock(buckets[0]!.t) : ''}</span><span>max {max}</span><span>{buckets.length ? 'now' : ''}</span></div>
    </div>
  );
}
