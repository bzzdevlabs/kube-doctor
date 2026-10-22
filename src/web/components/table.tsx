// Data table with sortable columns, collapsible groups, paging and j/k navigation.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Icon } from '../app/icons';
import * as prefs from '../app/prefs';
import { Empty } from './ui';

// The table currently on screen, for keyboard navigation (j/k/Enter).
export const activeList: { keys: string[]; open: ((key: string) => void) | null; selected: string | null } = { keys: [], open: null, selected: null };

type Sortable = string | number | null | undefined;

export interface Column<R> {
  key: string;
  label: ComponentChildren;
  render: (row: R) => ComponentChildren;
  sort?: (row: R) => Sortable;
  width?: string;
  className?: string;
}

function compare(a: Sortable, b: Sortable): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

interface Props<R> {
  id: string;
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  onOpen?: (row: R) => void;
  selectedKey?: string | null;
  groupBy?: ((row: R) => string) | null;
  groupLabel?: (group: string, rows: R[]) => ComponentChildren;
  groupOrder?: (a: string, ar: R[], b: string, br: R[]) => number;
  emptyTitle?: string;
  emptyText?: ComponentChildren;
  pageSize?: number;
  rowClass?: (row: R) => string;
  defaultSort?: { key: string; dir: 'asc' | 'desc' } | null;
}

export function DataTable<R>({ id, columns, rows, rowKey, onOpen, selectedKey, groupBy, groupLabel, groupOrder, emptyTitle = 'Nothing to show', emptyText, pageSize = 150, rowClass, defaultSort = null }: Props<R>) {
  const [sort, setSortState] = useState(() => prefs.load<{ key: string; dir: 'asc' | 'desc' } | null>(`sort.${id}`, defaultSort));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [limits, setLimits] = useState<Record<string, number>>({});

  const setSort = (key: string) => {
    const next = sort?.key === key ? (sort.dir === 'asc' ? { key, dir: 'desc' as const } : null) : { key, dir: 'asc' as const };
    setSortState(next);
    prefs.save(`sort.${id}`, next);
  };

  let sorted = rows;
  const col = sort && columns.find((c) => c.key === sort.key && c.sort);
  if (sort && col?.sort) {
    const by = col.sort;
    sorted = [...rows].sort((a, b) => compare(by(a), by(b)) * (sort.dir === 'desc' ? -1 : 1));
  }

  const NONE = '\u0000';
  let groups: [string, R[]][];
  if (groupBy) {
    const map = new Map<string, R[]>();
    for (const r of sorted) {
      const g = groupBy(r);
      const list = map.get(g);
      if (list) list.push(r);
      else map.set(g, [r]);
    }
    groups = [...map.entries()];
    if (groupOrder) groups.sort((a, b) => groupOrder(a[0], a[1], b[0], b[1]));
    else groups.sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  } else {
    groups = [[NONE, sorted]];
  }

  const visibleKeys: string[] = [];
  const byKey = new Map<string, R>();
  for (const [g, list] of groups) {
    if (g !== NONE && collapsed.has(g)) continue;
    for (const r of list.slice(0, limits[g] || pageSize)) {
      const k = rowKey(r);
      visibleKeys.push(k);
      byKey.set(k, r);
    }
  }
  activeList.keys = visibleKeys;
  activeList.open = (k) => {
    const r = byKey.get(k);
    if (r && onOpen) onOpen(r);
  };
  activeList.selected = selectedKey ?? null;

  useEffect(() => () => {
    activeList.keys = [];
    activeList.open = null;
  }, []);

  if (!rows.length) return <div class="table-card"><Empty icon="check" title={emptyTitle}>{emptyText}</Empty></div>;

  const toggleGroup = (g: string) => {
    const n = new Set(collapsed);
    if (n.has(g)) n.delete(g);
    else n.add(g);
    setCollapsed(n);
  };
  const allCollapsed = !!groupBy && groups.every(([g]) => collapsed.has(g));

  return (
    <div class="table-card">
      {groupBy && (
        <div class="table-groupbar">
          <span class="muted">{groups.length} groups · {rows.length} rows</span>
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groups.map(([g]) => g)))}>
            <Icon name={allCollapsed ? 'expandAll' : 'collapseAll'} size={14} />
            <span>{allCollapsed ? 'Expand all' : 'Collapse all'}</span>
          </button>
        </div>
      )}
      <div class="table-scroll">
        <table class="dt">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} class={`${c.className || ''}${c.sort ? ' sortable' : ''}${sort?.key === c.key ? ' sorted' : ''}`} style={c.width ? { width: c.width } : undefined} onClick={c.sort ? () => setSort(c.key) : undefined} title={c.sort ? 'Sort' : undefined}>
                  <span class="th-inner">{c.label}{sort?.key === c.key && <span class="sort-ind">{sort.dir === 'asc' ? '▲' : '▼'}</span>}</span>
                </th>
              ))}
            </tr>
          </thead>
          {groups.map(([g, list]) => {
            const isCollapsed = g !== NONE && collapsed.has(g);
            const limit = limits[g] || pageSize;
            return (
              <tbody key={g}>
                {g !== NONE && (
                  <tr class="group-row" onClick={() => toggleGroup(g)}>
                    <td colSpan={columns.length}>
                      <span class="group-head">
                        <Icon name={isCollapsed ? 'chevronRight' : 'chevronDown'} size={14} className="chev" />
                        {groupLabel ? groupLabel(g, list) : <b>{g}</b>}
                        <span class="count">{list.length}</span>
                      </span>
                    </td>
                  </tr>
                )}
                {!isCollapsed && list.slice(0, limit).map((r) => {
                  const k = rowKey(r);
                  return (
                    <tr key={k} data-key={k} class={`${onOpen ? 'clickable' : ''}${k === selectedKey ? ' selected' : ''} ${rowClass ? rowClass(r) : ''}`} onClick={onOpen ? () => onOpen(r) : undefined}>
                      {columns.map((c) => <td key={c.key} class={c.className || ''}>{c.render(r)}</td>)}
                    </tr>
                  );
                })}
                {!isCollapsed && list.length > limit && (
                  <tr class="more-row">
                    <td colSpan={columns.length}>
                      <button type="button" class="btn btn-ghost btn-sm" onClick={() => setLimits({ ...limits, [g]: limit + pageSize })}>
                        Show {Math.min(pageSize, list.length - limit)} more of {list.length - limit} remaining
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            );
          })}
        </table>
      </div>
    </div>
  );
}
