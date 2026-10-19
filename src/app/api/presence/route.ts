import type { NextRequest } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { json } from "@/lib/http";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { isPlainObject, isUuid, readJsonBody, toInt } from "@/lib/request-guard";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/presence { productId, sessionId } → { others } — how many OTHER browsers have this
 * product page open right now (42_storefront_extras · ping_product_view). The product page pings
 * every 30 s while visible. A random per-tab id only; nothing about the visitor is stored. Any
 * problem answers { others: 0 } — the note simply doesn't show.
 */
export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ others: 0 });
  const parsed = await readJsonBody(request, 1024);
  if (!parsed.ok || !isPlainObject(parsed.body)) return json({ others: 0 });
  const productId = toInt(parsed.body.productId, 1, 2147483647);
  const sessionId = parsed.body.sessionId;
  if (productId == null || !isUuid(sessionId)) return json({ others: 0 });
  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("presence", request), 60, 600))) return json({ others: 0 });
  const { data, error } = await supabase.rpc("ping_product_view", { p_product_id: productId, p_session: sessionId });
  if (error) return json({ others: 0 });
  const others = typeof data === "number" && Number.isFinite(data) ? Math.max(0, Math.min(99, data)) : 0;
  return json({ others });
}
