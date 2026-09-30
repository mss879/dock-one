"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { ADMIN_PAGE_SIZE, pageCount } from "@/lib/admin/pagination";
import { AdminButton } from "./Button";

/**
 * Pager under an admin table (state, not links — the tab owns `page`). Shows the honest range
 * "26–50 of 312". When a page is past the end (a delete emptied it), offers "Back to page 1".
 *
 *   <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={data?.total ?? 0} onPageChange={setPage} loading={query.loading} />
 */
export function AdminPagination({
  page,
  total,
  onPageChange,
  pageSize = ADMIN_PAGE_SIZE,
  loading = false,
  noun = "rows",
  className = "",
}: {
  page: number;
  total: number;
  onPageChange: (page: number) => void;
  pageSize?: number;
  loading?: boolean;
  /** "orders", "customers" … */
  noun?: string;
  className?: string;
}) {
  const pages = pageCount(total, pageSize);
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  const pastEnd = page > pages;

  return (
    <nav aria-label="Pagination" className={`flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between ${className}`}>
      <p className="font-mono text-[11.5px] text-adm-mute" aria-live="polite">
        {pastEnd ? (
          "This page is empty."
        ) : total === 0 ? (
          `No ${noun}`
        ) : (
          <>
            <span className="text-adm-ink">
              {first.toLocaleString("en-US")}–{last.toLocaleString("en-US")}
            </span>{" "}
            of {total.toLocaleString("en-US")} {noun}
          </>
        )}
      </p>
      <div className="flex items-center gap-2">
        {pastEnd ? (
          <AdminButton size="sm" onClick={() => onPageChange(1)}>
            Back to page 1
          </AdminButton>
        ) : (
          <>
            <AdminButton size="sm" icon={<ChevronLeft aria-hidden className="size-3.5" />} disabled={loading || page <= 1} onClick={() => onPageChange(page - 1)}>
              Prev
            </AdminButton>
            <span className="font-mono text-[11.5px] text-adm-ink-2">
              Page {page} / {pages}
            </span>
            <AdminButton size="sm" disabled={loading || page >= pages} onClick={() => onPageChange(page + 1)}>
              Next
              <ChevronRight aria-hidden className="size-3.5" />
            </AdminButton>
          </>
        )}
      </div>
    </nav>
  );
}
