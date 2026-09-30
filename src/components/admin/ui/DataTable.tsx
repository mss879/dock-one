"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { AdminButton, type AdminButtonVariant } from "./Button";
import { EmptyState } from "./EmptyState";

/**
 * The admin list. Columns are config; sorting is CONTROLLED (you sort in the query so it spans
 * every page, not just the rows on screen). Loading with no rows → skeleton rows; loading with
 * rows → rows stay (dimmed) under a progress bar, so paging never flashes an empty table.
 *
 *   <DataTable
 *     caption="Discounts"
 *     rows={page?.rows ?? []}
 *     rowKey={(r) => r.id}
 *     loading={query.loading}
 *     columns={[
 *       { key: "code", header: "Code", sortable: true, cell: (r) => <span className="font-mono">{r.code}</span> },
 *       { key: "uses", header: "Uses", align: "right", cell: (r) => r.times_used },
 *     ]}
 *     sort={sort} onSortChange={setSort}
 *     actions={[{ label: "Edit", onClick: openEditor }, { label: "Delete", variant: "danger", onClick: askDelete }]}
 *     empty={{ title: "No discounts yet", description: "Create one to share with customers." }}
 *   />
 */

export type SortDirection = "asc" | "desc";
export type SortState = { key: string; direction: SortDirection } | null;

export type DataColumn<T> = {
  /** Stable id; also the sort key unless `sortKey` is given. */
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  sortable?: boolean;
  /** Column to sort by in the query when it differs from `key`. */
  sortKey?: string;
  align?: "left" | "right" | "center";
  /** CSS width, e.g. "120px" or "20%". */
  width?: string;
  /** Hide on narrow screens (the row stays usable without it). */
  hideBelow?: "sm" | "md" | "lg";
  className?: string;
};

export type RowAction<T> = {
  label: string;
  onClick: (row: T) => void;
  icon?: ReactNode;
  variant?: AdminButtonVariant;
  hidden?: (row: T) => boolean;
  disabled?: (row: T) => boolean;
};

export type DataTableProps<T> = {
  columns: readonly DataColumn<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string | number;
  /** Short human name of a row ("OPENING10", "DO-10042") — makes action buttons unambiguous for screen readers ("Delete OPENING10"). */
  rowLabel?: (row: T) => string;
  /** Accessible name of the table (visually hidden). */
  caption: string;
  loading?: boolean;
  /** Number of skeleton rows on first load (default 6). */
  skeletonRows?: number;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  actions?: readonly RowAction<T>[];
  /** Whole-row click (mouse) + Enter (keyboard) — e.g. open a detail drawer. */
  onRowClick?: (row: T) => void;
  /** Highlight the row whose drawer is open. */
  selectedKey?: string | number | null;
  empty?: { title: string; description?: ReactNode; action?: ReactNode };
  /**
   * The current request failed (pass `Boolean(query.error)` and render <QueryError> above the
   * table). With no rows the body then says nothing loaded, instead of claiming the list is empty.
   */
  failed?: boolean;
  /** Rows that deserve attention (low stock, overdue) get a signal edge. */
  rowTone?: (row: T) => "attention" | "muted" | null;
  className?: string;
};

const hideClass = { sm: "hidden sm:table-cell", md: "hidden md:table-cell", lg: "hidden lg:table-cell" } as const;
const alignClass = { left: "text-left", right: "text-right", center: "text-center" } as const;

/** Next sort state for a header click: asc → desc → off. */
export function nextSort(current: SortState, key: string): SortState {
  if (!current || current.key !== key) return { key, direction: "asc" };
  if (current.direction === "asc") return { key, direction: "desc" };
  return null;
}

/** Client-side sort for small, fully loaded lists. */
export function sortRows<T>(rows: readonly T[], sort: SortState, accessor: (row: T, key: string) => unknown): T[] {
  if (!sort) return [...rows];
  const factor = sort.direction === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = accessor(a, sort.key);
    const y = accessor(b, sort.key);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    if (typeof x === "number" && typeof y === "number") return (x - y) * factor;
    return String(x).localeCompare(String(y), "en", { numeric: true, sensitivity: "base" }) * factor;
  });
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowLabel,
  caption,
  loading = false,
  skeletonRows = 6,
  sort = null,
  onSortChange,
  actions,
  onRowClick,
  selectedKey = null,
  empty,
  failed = false,
  rowTone,
  className = "",
}: DataTableProps<T>) {
  const hasActions = Boolean(actions?.length);
  const colCount = columns.length + (hasActions ? 1 : 0);
  const showSkeleton = loading && rows.length === 0;
  const showEmpty = !loading && rows.length === 0;

  const onRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (!onRowClick || event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onRowClick(row);
    }
  };

  return (
    <div className={`relative border border-adm-line bg-adm-panel ${className}`}>
      {loading && rows.length > 0 && (
        <div aria-hidden className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-adm-accent-soft">
          <div className="adm-progress h-full w-2/5 bg-adm-accent" />
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-[13.5px]" aria-busy={loading || undefined}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-adm-line bg-adm-panel-2">
              {columns.map((column) => {
                const sortKey = column.sortKey ?? column.key;
                const active = sort?.key === sortKey;
                const ariaSort = active ? (sort?.direction === "asc" ? "ascending" : "descending") : column.sortable ? "none" : undefined;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={ariaSort}
                    style={column.width ? { width: column.width } : undefined}
                    className={`h-9 px-3 font-mono text-[10.5px] font-semibold tracking-[0.07em] whitespace-nowrap text-adm-ink-2 uppercase ${alignClass[column.align ?? "left"]} ${column.hideBelow ? hideClass[column.hideBelow] : ""}`}
                  >
                    {column.sortable && onSortChange ? (
                      <button
                        type="button"
                        onClick={() => onSortChange(nextSort(sort, sortKey))}
                        className={`inline-flex items-center gap-1 uppercase hover:text-adm-ink ${active ? "text-adm-ink" : ""} ${column.align === "right" ? "flex-row-reverse" : ""}`}
                      >
                        {column.header}
                        {active ? (
                          sort?.direction === "asc" ? (
                            <ArrowUp aria-hidden className="size-3" />
                          ) : (
                            <ArrowDown aria-hidden className="size-3" />
                          )
                        ) : (
                          <ChevronsUpDown aria-hidden className="size-3 opacity-50" />
                        )}
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
              {hasActions && (
                <th scope="col" className="h-9 px-3 text-right">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className={loading && rows.length > 0 ? "opacity-60 transition-opacity" : "transition-opacity"}>
            {showSkeleton &&
              Array.from({ length: skeletonRows }, (_, i) => (
                <tr key={`skeleton-${i}`} className="border-b border-adm-line last:border-b-0">
                  {Array.from({ length: colCount }, (__, j) => (
                    <td key={j} className={`px-3 py-3 ${columns[j]?.hideBelow ? hideClass[columns[j].hideBelow as "sm" | "md" | "lg"] : ""}`}>
                      <span aria-hidden className="adm-skeleton block h-3.5" style={{ width: `${45 + ((i * 7 + j * 13) % 45)}%` }} />
                    </td>
                  ))}
                </tr>
              ))}
            {showSkeleton && (
              <tr className="sr-only">
                <td colSpan={colCount}>Loading…</td>
              </tr>
            )}
            {showEmpty && (
              <tr>
                <td colSpan={colCount}>
                  {failed ? (
                    <EmptyState title="Nothing loaded" description="This list couldn't be loaded — see the message above." compact />
                  ) : (
                    <EmptyState title={empty?.title ?? "Nothing here yet"} description={empty?.description} action={empty?.action} compact />
                  )}
                </td>
              </tr>
            )}
            {rows.map((row, index) => {
              const key = rowKey(row);
              const tone = rowTone?.(row) ?? null;
              const selected = selectedKey != null && selectedKey === key;
              return (
                <tr
                  key={key}
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-current={selected || undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={onRowClick ? (event) => onRowKeyDown(event, row) : undefined}
                  className={`border-b border-adm-line last:border-b-0 ${onRowClick ? "cursor-pointer hover:bg-adm-hover focus-visible:bg-adm-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-adm-accent" : ""} ${
                    selected ? "bg-adm-accent-soft" : ""
                  } ${tone === "muted" ? "text-adm-mute" : ""} ${tone === "attention" ? "shadow-[inset_3px_0_0_0_var(--adm-signal-ink)]" : ""}`}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={`px-3 py-2.5 align-middle ${alignClass[column.align ?? "left"]} ${column.align === "right" ? "tabular-nums" : ""} ${column.hideBelow ? hideClass[column.hideBelow] : ""} ${column.className ?? ""}`}
                    >
                      {column.cell(row, index)}
                    </td>
                  ))}
                  {hasActions && (
                    <td className="px-2 py-1.5 text-right whitespace-nowrap">
                      <span className="inline-flex items-center gap-1">
                        {actions
                          ?.filter((action) => !action.hidden?.(row))
                          .map((action) => (
                            <AdminButton
                              key={action.label}
                              size="sm"
                              // Row actions stay quiet; a destructive one only turns ink on hover (its ConfirmDialog is the loud part).
                              variant={action.variant === "danger" ? "ghost" : (action.variant ?? "ghost")}
                              className={action.variant === "danger" ? "hover:bg-adm-ink hover:text-white" : ""}
                              icon={action.icon}
                              disabled={action.disabled?.(row)}
                              aria-label={rowLabel ? `${action.label} ${rowLabel(row)}` : undefined}
                              onClick={(event) => {
                                event.stopPropagation();
                                action.onClick(row);
                              }}
                            >
                              {action.label}
                            </AdminButton>
                          ))}
                      </span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
