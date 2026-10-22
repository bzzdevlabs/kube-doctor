// Inline SVG icon set (24×24, stroke based).
const C = (r: number, cx = 12, cy = 12): string => `M${cx} ${cy}m-${r} 0a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 -${2 * r} 0`;

const PATHS = {
  overview: 'M4 4h6v7H4z M14 4h6v4h-6z M14 12h6v8h-6z M4 15h6v5H4z',
  incidents: `${C(9)} ${C(5)} ${C(1)}`,
  problems: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z M12 9v4 M12 17h.01',
  workloads: 'M12 2 2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5',
  pods: 'M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4a2 2 0 0 0 1-1.7z M3.3 7 12 12l8.7-5 M12 22V12',
  nodes: 'M4 3h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M4 13h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z M7 7h.01 M7 17h.01',
  events: 'M22 12h-4l-3 9L9 3l-3 9H2',
  namespaces: 'M4 4h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
  scan: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z M9 12l2 2 4-4',
  search: `${C(7, 11, 11)} M21 21l-4.3-4.3`,
  filter: 'M3 4h18l-7 8.5V19l-4 2v-8.5z',
  pin: 'M12 17v5 M5 17h14 M7 17l1.5-6V4h7v7l1.5 6 M7 4h10',
  pinOff: 'M12 17v5 M5 17h12 M8.5 11 7 17 M15.5 9.5V4h-7 M2 2l20 20',
  x: 'M18 6 6 18 M6 6l12 12',
  chevronRight: 'M9 18l6-6-6-6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronLeft: 'M15 18l-6-6 6-6',
  arrowLeft: 'M19 12H5 M12 19l-7-7 7-7',
  arrowRight: 'M5 12h14 M12 5l7 7-7 7',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4 M21 3v6h-6',
  sun: `${C(4)} M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4`,
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  sidebar: 'M3 4h18v16H3z M9 4v16',
  panelRight: 'M3 4h18v16H3z M15 4v16',
  copy: 'M9 9h11v11H9z M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3',
  eyeOff: 'M17.9 17.9A10 10 0 0 1 12 20c-7 0-10-8-10-8a18 18 0 0 1 5.1-5.9 M9.9 4.2A9 9 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.2 3.2 M14.1 14.1a3 3 0 1 1-4.2-4.2 M2 2l20 20',
  eye: `M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8z ${C(3)}`,
  keyboard: 'M2 6h20v12H2z M6 10h.01 M10 10h.01 M14 10h.01 M18 10h.01 M7 14h10',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9z',
  clock: `${C(9)} M12 7v5l3 2`,
  check: 'M20 6 9 17l-5-5',
  external: 'M15 3h6v6 M10 14 21 3 M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  more: 'M12 12h.01 M19 12h.01 M5 12h.01',
  expandAll: 'M7 15l5 5 5-5 M7 9l5-5 5 5',
  collapseAll: 'M7 20l5-5 5 5 M7 4l5 5 5-5',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6',
  terminal: 'M4 17l6-6-6-6 M12 19h8',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.9 1.9 0 0 0 3.4 0',
  chain: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  wrench: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z',
  list: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  grid: 'M3 3h8v8H3z M13 3h8v8h-8z M3 13h8v8H3z M13 13h8v8h-8z',
  rows: 'M3 5h18 M3 10h18 M3 15h18 M3 20h18',
  info: `${C(9)} M12 16v-4 M12 8h.01`,
  logo: 'M12 2.5 21 7.6v8.8L12 21.5 3 16.4V7.6z M12 8v8 M8 12h8',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg class={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
