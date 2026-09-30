/**
 * Wishlist id limits shared by the browser store (lib/wishlist.ts), the saved-items grid and
 * GET /api/wishlist/products. Plain module (server and client).
 */

/** = merge_wishlist's cap (100 distinct ids per call, 10_wishlists.sql) and getProductsByIds' cap. */
export const WISHLIST_MAX_ITEMS = 100;

/** "12,7,12,x" → [12, 7] — positive integers, first occurrence kept, at most WISHLIST_MAX_ITEMS. */
export function parseIdList(value: string | null | undefined): number[] {
  if (!value) return [];
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const part of value.split(",")) {
    const token = part.trim();
    if (!/^\d{1,9}$/.test(token)) continue;
    const id = Number(token);
    if (id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === WISHLIST_MAX_ITEMS) break;
  }
  return ids;
}
