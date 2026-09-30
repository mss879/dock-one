import type { NextRequest } from "next/server";
import { TRACK_NOT_FOUND_MESSAGE, trackRequestSchema } from "@/lib/checkout";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { isThrottledView, normalizeOrderRef, normalizeOrderView } from "@/lib/orders";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { isBot, isPlainObject, readJsonBody } from "@/lib/request-guard";
import { logDbError, mapRpcError } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/track — guest order tracking (blueprint §9.8). The email travels in the BODY, never
 * in a URL (§14 lesson 13). track_guest_order returns the order only when the number AND the
 * email match, and throttles itself in the database (8 / 15 min per order number and per
 * email); this route adds 15 / 15 min per IP in front of it.
 *
 * Wrong number, wrong email, malformed input, a honeypot hit and the in-DB throttle all get the
 * SAME 404 body (P14) — nothing tells a prober which guess was close.
 */

const MIGRATION = "09_order_rpcs.sql";
const notFound = () => json({ error: TRACK_NOT_FOUND_MESSAGE, code: "not_found" }, 404);

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);

  const parsed = await readJsonBody(request, 8 * 1024);
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const body = parsed.body;

  if (isBot(body.company)) return notFound();

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("track", request), 15, 900))) {
    return json({ error: MESSAGES.slowDown }, 429);
  }

  const input = trackRequestSchema.safeParse(body);
  const orderId = input.success ? normalizeOrderRef(input.data.order) : null;
  if (!input.success || !orderId) return notFound();

  const { data, error } = await supabase.rpc("track_guest_order", { p_order_id: orderId, p_email: input.data.email });
  if (error) {
    logDbError("api/track", error, MIGRATION);
    const mapped = mapRpcError(error, {});
    return json({ error: mapped.message, code: mapped.code }, mapped.status);
  }
  if (data === null || isThrottledView(data)) return notFound();

  const order = normalizeOrderView(data);
  if (!order) {
    console.error("[api/track] track_guest_order returned an unexpected shape");
    return json({ error: MESSAGES.generic }, 500);
  }
  return json({ ok: true, order });
}
