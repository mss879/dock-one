import type { NextRequest } from "next/server";
import { fetchAvailability, toProductId } from "@/lib/catalogue";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { logDbError, mapRpcError } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * GET /api/availability?ids=1,2,3 — live stock bands for the product page (and anything else
 * that shows availability), from get_product_availability (05_inventory.sql). Live data: never
 * cached (json() sends private, no-store).
 *
 * Response: { items: [{ productId, variantId, state: "in" | "low" | "out", left? }] }
 *   - only TRACKED, active variants of visible products appear; a variant that is absent is
 *     untracked and always available ("in stock");
 *   - `left` (the exact level) is sent ONLY for the "low" band ("Only N left") — the level of a
 *     well-stocked variant is nobody's business (it mirrors quote_order's rule);
 *   - on any error the client shows "availability is confirmed at checkout" and never blocks.
 *
 * Guards: ≤ 24 distinct ids (the RPC's own window), a light per-IP limit before the database.
 */

const MAX_IDS = 24;
const RATE_LIMIT = { max: 120, windowSeconds: 60 };

function parseIds(raw: string | null): number[] | null {
  if (!raw || raw.length > 400) return null;
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_IDS * 2) return null;
  const ids: number[] = [];
  for (const part of parts) {
    const id = toProductId(part);
    if (id === null) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids.length <= MAX_IDS ? ids : null;
}

export async function GET(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);

  const ids = parseIds(request.nextUrl.searchParams.get("ids"));
  if (!ids) return json({ error: MESSAGES.invalid }, 422);

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("availability", request), RATE_LIMIT.max, RATE_LIMIT.windowSeconds))) {
    return json({ error: MESSAGES.slowDown }, 429);
  }

  const result = await fetchAvailability(ids);
  if (!result.ok) {
    logDbError("api.availability", result.error, "05_inventory.sql");
    const mapped = mapRpcError(result.error, {});
    return json({ error: mapped.message, code: mapped.code }, mapped.status);
  }

  return json({
    items: result.rows.map((row) =>
      row.stockLevel <= 0
        ? { productId: row.productId, variantId: row.variantId, state: "out" as const }
        : row.low
          ? { productId: row.productId, variantId: row.variantId, state: "low" as const, left: row.stockLevel }
          : { productId: row.productId, variantId: row.variantId, state: "in" as const },
    ),
  });
}
