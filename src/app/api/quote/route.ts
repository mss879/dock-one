import type { NextRequest } from "next/server";
import { CHECKOUT_COPY, CHECKOUT_MAX_LINES, normalizeDiscountCode, quoteFromSql, quoteRequestSchema } from "@/lib/checkout";
import { refusedVerdict } from "@/lib/discount-copy";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { isBot, isPlainObject, readJsonBody, toInt } from "@/lib/request-guard";
import { logDbError, mapRpcError, type ErrorTable } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/quote — the authoritative basket quote (BUILD_SPEC §2(e), §4.6): every total the
 * shopper sees in the drawer, the basket and the checkout summary comes from `quote_order`
 * (read-only twin of place_order). Blueprint §6.7 order: body cap → honeypot → per-IP limit
 * (60/min) → validate → ONE RPC → mapped errors.
 *
 * Body: { items: [{ productId, variantId, qty }], discountCode?, fulfillment? }
 * The discount verdict is collapsed to the one refusal copy (P14), like /api/discount.
 */

const MIGRATION = "09_order_rpcs.sql";

const ERRORS: ErrorTable = {
  store_unavailable: { status: 503, message: CHECKOUT_COPY.storeUnavailable },
};

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const body = parsed.body;

  // No form posts here; a filled honeypot is a bot — answer like any malformed body.
  if (isBot(body.company)) return json({ error: MESSAGES.invalid }, 422);

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("quote", request), 60, 60))) {
    return json({ error: MESSAGES.slowDown }, 429);
  }

  const input = quoteRequestSchema.safeParse(body);
  if (!input.success) return json({ error: MESSAGES.invalid }, 422);

  // Keep every line in its position (quote_order reports per line); malformed ids become null
  // and read as unknown_product. SQL quotes at most 50 lines.
  const items = input.data.items.slice(0, CHECKOUT_MAX_LINES).map((raw) => {
    const line = isPlainObject(raw) ? raw : {};
    return {
      product_id: toInt(line.productId, 1, 2_147_483_647),
      variant_id: toInt(line.variantId, 1, 2_147_483_647),
      quantity: toInt(line.qty, 0, 9999),
    };
  });

  const sentCode = typeof input.data.discountCode === "string" && input.data.discountCode.trim() ? input.data.discountCode : null;
  const code = sentCode ? normalizeDiscountCode(sentCode) : null;

  const { data, error } = await supabase.rpc("quote_order", {
    p_items: items,
    // A malformed code can't match anything: ask SQL about no code, answer "refused" below.
    p_discount_code: code,
    p_fulfillment: input.data.fulfillment ?? "delivery",
  });
  if (error) {
    logDbError("api/quote", error, MIGRATION);
    const mapped = mapRpcError(error, ERRORS);
    return json({ error: mapped.message, code: mapped.code }, mapped.status);
  }

  const quote = quoteFromSql(data, code);
  if (!quote) {
    console.error("[api/quote] quote_order returned an unexpected shape");
    return json({ error: MESSAGES.generic }, 500);
  }
  if (sentCode && !code) quote.discount = refusedVerdict(null);
  return json(quote);
}
