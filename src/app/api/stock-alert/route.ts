import type { NextRequest } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { cleanText, isBot, isEmailAddress, isPlainObject, readJsonBody, toInt } from "@/lib/request-guard";
import { logDbError, mapRpcError } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/stock-alert { variantId, email } — "Notify me" for an out-of-stock option
 * (50_product_availability.sql · request_stock_alert).
 *
 *   64 KB body cap → honeypot (answered like a success) → 10 / hour per IP → validate → ONE write.
 *
 * The same `{ ok: true }` answers a new request and one already waiting (nothing about other
 * people's requests can be learned). The shop emails everyone waiting from admin → Inventory once
 * the option is back.
 */

const MIGRATION = "50_product_availability.sql";
const INVALID_EMAIL = "Enter a valid email address.";

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const body = parsed.body;
  if (isBot(body.company)) return json({ ok: true });

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("stock-alert", request), 10, 3600))) {
    return json({ error: MESSAGES.slowDown }, 429);
  }

  const variantId = toInt(body.variantId, 1, 2147483647);
  if (variantId === null) return json({ error: MESSAGES.invalid }, 422);
  const email = cleanText(body.email, 1000).toLowerCase();
  if (!isEmailAddress(email)) return json({ error: INVALID_EMAIL, field: "email" }, 422);

  const { error } = await supabase.rpc("request_stock_alert", { p_variant_id: variantId, p_email: email });
  if (error) {
    logDbError("api/stock-alert", error, MIGRATION);
    const mapped = mapRpcError(
      error,
      { invalid_email: { status: 422, message: INVALID_EMAIL }, invalid_variant: { status: 404, message: "This product option is no longer available." } },
      { status: 500, message: "We couldn't save that just now. Please try again." },
    );
    return json({ error: mapped.message, code: mapped.code }, mapped.status);
  }
  return json({ ok: true });
}
