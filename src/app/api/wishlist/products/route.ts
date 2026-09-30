import type { NextRequest } from "next/server";
import { parseIdList } from "@/components/account/wishlist-ids";
import { getProductsByIds } from "@/lib/catalogue";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";

/**
 * GET /api/wishlist/products?ids=12,7,31 — product cards for a saved list (guests' local list,
 * members' account list). Server-resolved presentation (P4): the browser names ids only; names,
 * prices and images come from the catalogue (cached, tag `catalogue`). Unknown or hidden ids
 * resolve to nothing. Read-only: no body, no writes.
 */

const MAX_QUERY_LENGTH = 1200; // 100 ids × up to 9 digits + commas, with room to spare

export async function GET(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);

  const raw = request.nextUrl.searchParams.get("ids") ?? "";
  if (raw.length > MAX_QUERY_LENGTH) return json({ error: MESSAGES.invalid }, 400);

  const ids = parseIdList(raw); // positive integers, de-duplicated, capped at WISHLIST_MAX_ITEMS
  if (ids.length === 0) return json({ items: [] });

  // Requested order kept; readers fail soft (a database error logs and yields no cards).
  const items = await getProductsByIds(ids);
  return json({ items });
}
