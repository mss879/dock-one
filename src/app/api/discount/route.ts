import type { NextRequest } from "next/server";
import { discountRequestSchema, normalizeDiscountCode } from "@/lib/checkout";
import { refusedVerdict, unavailableVerdict, verdictFromSql } from "@/lib/discount-copy";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { isBot, isPlainObject, readJsonBody } from "@/lib/request-guard";
import { logDbError } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/discount — advisory code preview (blueprint §9.6). Calls validate_discount, which
 * never counts a use; place_order re-validates and redeems.
 *
 * Constant response shape on every outcome (refusal, honeypot, throttling, outage):
 *   { ok: true, valid: true | false | null, discountAmount, message, minimum, code }
 * One message for every refusal reason except minimum_not_met (lib/discount-copy.ts), so the
 * answer never tells a prober whether a guessed code exists (P14).
 */

const MIGRATION = "09_order_rpcs.sql";

export async function POST(request: NextRequest) {
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const body = parsed.body;

  const input = discountRequestSchema.safeParse(body);
  const code = input.success ? normalizeDiscountCode(input.data.code) : null;

  // Honeypot: indistinguishable from an ordinary refusal.
  if (isBot(body.company)) return json({ ok: true, ...refusedVerdict(code) });
  if (!isSupabaseConfigured) return json({ ok: true, ...unavailableVerdict(code) });

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("discount", request), 20, 60))) {
    // Same shape as an outage: nothing to adapt to, and the shopper may still enter it at checkout.
    return json({ ok: true, ...unavailableVerdict(code) }, 429);
  }

  if (!input.success || !code) return json({ ok: true, ...refusedVerdict(code) });

  const { data, error } = await supabase.rpc("validate_discount", { p_code: code, p_subtotal: input.data.subtotal ?? 0 });
  if (error) {
    logDbError("api/discount", error, MIGRATION);
    return json({ ok: true, ...unavailableVerdict(code) });
  }
  return json({ ok: true, ...verdictFromSql(data, code) });
}
