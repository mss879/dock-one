import type { NextRequest } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { isPlainObject, isUuid, readJsonBody } from "@/lib/request-guard";
import { logDbError, mapRpcError } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/cart-recovery/unsubscribe { token } — "stop these reminders" (blueprint §9.10, §8).
 * The reminder email links to /recover/stop, which ASKS and then posts here (§6.6).
 *
 *   64 KB body cap → 20 / 10 min per IP → stop_cart_recovery(p_token) (13_abandoned_carts.sql),
 *   which suppresses the PERSON (their address), so the choice survives future carts.
 *
 * Unknown, malformed and real tokens all get the SAME `{ ok: true }` (P14).
 */

const MIGRATION = "13_abandoned_carts.sql";

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("recovery-stop", request), 20, 600))) {
    return json({ error: MESSAGES.slowDown }, 429);
  }

  const token = parsed.body.token;
  if (!isUuid(token)) return json({ ok: true }); // same answer, nothing to look up

  const { error } = await supabase.rpc("stop_cart_recovery", { p_token: token });
  if (error) {
    logDbError("api/cart-recovery/unsubscribe", error, MIGRATION);
    const mapped = mapRpcError(error, {});
    return json({ error: mapped.message, code: mapped.code }, mapped.status);
  }
  return json({ ok: true });
}
