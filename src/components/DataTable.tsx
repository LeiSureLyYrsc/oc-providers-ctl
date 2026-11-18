import type { KeyboardEvent, ReactNode } from 'react';
import { useRef } from 'react';
import type { Density } from '../lib/store';
import { Icon } from './Icon';

export interface Column<T> {
  key: string;
  label: string;
  hint?: string;
  width?: string;
  /** Names a `--col-<class>` width/min-width forced by the CSS priority mode. */
  cssClass?: string;
  align?: 'left' | 'right';
  mono?: boolean;
  className?: string;
  render: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  selectedKey: string | null;
  onSelect: (row: T) => void;
  density: Density;
  label: string;
  empty: ReactNode;
  onActivate?: (row: T) => void;
}

function domId(key: string, index: number): string {
  return `row-${index}-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  selectedKey,
  onSelect,
  density,
  label,
  empty,
  onActivate,
}: DataTableProps<T>) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  if (rows.length === 0) {
    return <div className="table-empty">{empty}</div>;
  }

  const move = (delta: number) => {
    let current = rows.findIndex((row) => rowKey(row) === selectedKey);
    if (current < 0) current = delta > 0 ? -1 : rows.length;
    const next = Math.min(Math.max(current + delta, 0), rows.length - 1);
    onSelect(rows[next]);
    const target = wrapperRef.current?.querySelector<HTMLElement>(`[data-row-index="${next}"]`);
    target?.scrollIntoView({ block: 'nearest' });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select')) return;
    if (event.key === 'ArrowDown' || event.key === 'j') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp' || event.key === 'k') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      onSelect(rows[0]);
    } else if (event.key === 'End') {
      event.preventDefault();
      onSelect(rows[rows.length - 1]);
    } else if (event.key === 'Enter' && onActivate) {
      const row = rows.find((entry) => rowKey(entry) === selectedKey);
      if (row) {
        event.preventDefault();
        onActivate(row);
      }
    }
  };

  return (
    <div
      className="table-scroll"
      ref={wrapperRef}
      tabIndex={0}
      role="grid"
      aria-label={label}
      aria-rowcount={rows.length + 1}
      onKeyDown={onKeyDown}
      data-density={density}
    >
      <table className="data-table" data-density={density}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`${column.align === 'right' ? 'align-right' : ''} ${column.className ?? ''}`}
                style={
                  column.cssClass
                    ? { width: `var(--col-${column.cssClass})`, minWidth: `var(--col-${column.cssClass})` }
                    : column.width
                      ? { width: column.width }
                      : undefined
                }
              >
                <span className="th-label">{column.label}</span>
                {column.hint ? <span className="th-hint">{column.hint}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key = rowKey(row);
            const selected = key === selectedKey;
            return (
              <tr
                key={key}
                id={domId(key, index)}
                data-row-index={index}
                data-row-key={key}
                aria-selected={selected}
                className={selected ? 'is-selected' : undefined}
                onClick={() => onSelect(row)}
                onDoubleClick={() => onActivate?.(row)}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={`${column.align === 'right' ? 'align-right' : ''} ${column.mono ? 'mono' : ''} ${column.className ?? ''}`}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface PaneHeaderProps {
  title: string;
  eyebrow: string;
  count: number;
  query: string;
  onQuery: (value: string) => void;
  searchPlaceholder: string;
  children?: ReactNode;
  primaryAction?: ReactNode;
}

export function PaneHeader({
  title,
  eyebrow,
  count,
  query,
  onQuery,
  searchPlaceholder,
  children,
  primaryAction,
}: PaneHeaderProps) {
  return (
    <header className="pane-header">
      <div className="pane-title">
        <div className="eyebrow">{eyebrow}</div>
        <h1 data-view-title tabIndex={-1}>
          {title}
          <span className="count">{String(count).padStart(2, '0')}</span>
        </h1>
      </div>
      <div className="pane-tools">
        <label className="search-box">
          <Icon name="search" size={14} />
          <input
            type="search"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            data-filter-input
          />
          {query ? (
            <button
              type="button"
              className="search-clear"
              onClick={() => onQuery('')}
              aria-label="清除筛选"
            >
              <Icon name="close" size={12} />
            </button>
          ) : (
            <span className="key-hint">/</span>
          )}
        </label>
        {children}
        {primaryAction}
      </div>
    </header>
  );
}
