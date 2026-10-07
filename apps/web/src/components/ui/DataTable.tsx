import { useMemo, useState, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table';
import { useTranslation } from 'react-i18next';
import s from './ui.module.css';
import { cx } from './cx';
import { Skeleton } from './Skeleton';
import { EmptyState } from './EmptyState';

export interface Column<T> {
  key: string;
  label: string;
  /** 셀 내용. 없으면 row[key] */
  render?: (row: T) => ReactNode;
  /** 정렬 값. 지정하면 정렬 가능 */
  sortValue?: (row: T) => string | number;
  align?: 'left' | 'right';
  width?: number | string;
}

export interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** 선택 기능: 선택된 id 목록과 변경 콜백 */
  selected?: string[];
  onSelectedChange?: (ids: string[]) => void;
  loading?: boolean;
  empty?: ReactNode;
  footer?: ReactNode;
  /** 서버 정렬을 쓰면 외부에서 관리 */
  sorting?: SortingState;
  onSortingChange?: (s: SortingState) => void;
}

/** 화면설계서 4장 · DataTable. 서버 페이징 화면은 rows에 현재 페이지만 넘긴다. */
export function DataTable<T>({ rows, columns, rowId, onRowClick, selected, onSelectedChange, loading, empty, footer, sorting: extSorting, onSortingChange }: DataTableProps<T>) {
  const { t } = useTranslation();
  const [localSorting, setLocalSorting] = useState<SortingState>([]);
  const sorting = extSorting ?? localSorting;
  const selectable = !!onSelectedChange;
  const rowSelection: RowSelectionState = useMemo(() => Object.fromEntries((selected ?? []).map((id) => [id, true])), [selected]);

  const defs = useMemo<ColumnDef<T>[]>(() => {
    const cols: ColumnDef<T>[] = columns.map((c) => ({
      id: c.key,
      header: c.label,
      accessorFn: c.sortValue ?? ((r: T) => (r as Record<string, unknown>)[c.key] as unknown),
      enableSorting: !!c.sortValue,
      cell: (ctx) => (c.render ? c.render(ctx.row.original) : String((ctx.row.original as Record<string, unknown>)[c.key] ?? '—')),
      meta: c,
    }));
    if (selectable) {
      cols.unshift({
        id: '__select',
        enableSorting: false,
        header: ({ table }) => (
          <input
            type="checkbox"
            className={s.check}
            aria-label={t('common.selectAll')}
            checked={table.getIsAllRowsSelected()}
            ref={(el) => {
              if (el) el.indeterminate = table.getIsSomeRowsSelected();
            }}
            onChange={table.getToggleAllRowsSelectedHandler()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            className={s.check}
            aria-label={t('common.selectRow', { id: row.id })}
            checked={row.getIsSelected()}
            onClick={(e) => e.stopPropagation()}
            onChange={row.getToggleSelectedHandler()}
          />
        ),
      });
    }
    return cols;
  }, [columns, selectable, t]);

  const table = useReactTable({
    data: rows,
    columns: defs,
    getRowId: (r) => rowId(r),
    state: { sorting, rowSelection },
    enableRowSelection: selectable,
    onRowSelectionChange: (updater) => {
      const next = typeof updater === 'function' ? updater(rowSelection) : updater;
      onSelectedChange?.(Object.keys(next).filter((k) => next[k]));
    },
    onSortingChange: (updater) => {
      const next = typeof updater === 'function' ? updater(sorting) : updater;
      if (onSortingChange) onSortingChange(next);
      else setLocalSorting(next);
    },
    manualSorting: !!onSortingChange,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const colCount = defs.length;
  return (
    <>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const meta = h.column.columnDef.meta as Column<T> | undefined;
                  const dir = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      className={cx(meta?.align === 'right' && s.alignRight)}
                      style={{ width: meta?.width }}
                      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
                    >
                      {h.column.getCanSort() ? (
                        <button type="button" className={s.sortBtn} onClick={h.column.getToggleSortingHandler()}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          <span aria-hidden="true">{dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}</span>
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 5 }, (_, i) => (
                  <tr key={`sk-${i}`}>
                    {defs.map((d) => (
                      <td key={d.id}>
                        <Skeleton width="70%" />
                      </td>
                    ))}
                  </tr>
                ))
              : table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    className={cx(onRowClick && s.rowClick, row.getIsSelected() && s.rowSelected)}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onKeyDown={onRowClick ? (e) => e.key === 'Enter' && onRowClick(row.original) : undefined}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const meta = cell.column.columnDef.meta as Column<T> | undefined;
                      return (
                        <td key={cell.id} className={cx(meta?.align === 'right' && s.alignRight)}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    })}
                  </tr>
                ))}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={colCount}>{empty ?? <EmptyState message={t('common.noResults')} />}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {footer && <div className={s.tableFoot}>{footer}</div>}
    </>
  );
}
