import type { NextRequest } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { isPlainObject, isUuid, readJsonBody } from "@/lib/request-guard";
import { logDbError, mapRpcError } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/newsletter/unsubscribe { token } — the second half of the confirm-then-POST
 * unsubscribe (blueprint §9.11, §6.6: the email link opens /newsletter/unsubscribe, which ASKS
 * first — mail scanners follow GET links).
 *
 *   64 KB body cap → 20 / 10 min per IP → unsubscribe_newsletter(p_token) (12_leads.sql).
 *
 * Every token — real, unknown or malformed — gets the SAME `{ ok: true }` (P14): the function
 * answers TRUE for any UUID, and a malformed token is answered without calling it.
 */

const MIGRATION = "12_leads.sql";

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("newsletter-unsubscribe", request), 20, 600))) {
    return json({ error: MESSAGES.slowDown }, 429);
  }

  const token = parsed.body.token;
  if (!isUuid(token)) return json({ ok: true }); // same answer, nothing to look up

  const { error } = await supabase.rpc("unsubscribe_newsletter", { p_token: token });
  if (error) {
    logDbError("api/newsletter/unsubscribe", error, MIGRATION);
    const mapped = mapRpcError(error, {});
    return json({ error: mapped.message, code: mapped.code }, mapped.status);
  }
  return json({ ok: true });
}
