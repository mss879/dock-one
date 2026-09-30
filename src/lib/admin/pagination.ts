/**
 * Admin pagination maths (blueprint §11.1: every list is paginated — PostgREST silently caps
 * a response at 1,000 rows, so an unpaginated list goes quietly wrong as the store grows).
 * Plain module.
 */

export const ADMIN_PAGE_SIZE = 25;
export const ADMIN_PAGE_SIZES = [25, 50, 100] as const;

/** 1-based page → inclusive `.range(from, to)` bounds. */
export function pageRange(page: number, pageSize: number = ADMIN_PAGE_SIZE): { from: number; to: number } {
  const size = Math.max(1, Math.floor(pageSize));
  const current = Math.max(1, Math.floor(page) || 1);
  const from = (current - 1) * size;
  return { from, to: from + size - 1 };
}

export function pageCount(total: number, pageSize: number = ADMIN_PAGE_SIZE): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.ceil(total / Math.max(1, Math.floor(pageSize)));
}

/** Keep a page inside 1..pageCount (e.g. after deleting the last row of the last page). */
export function clampPage(page: number, total: number, pageSize: number = ADMIN_PAGE_SIZE): number {
  return Math.min(Math.max(1, Math.floor(page) || 1), pageCount(total, pageSize));
}
