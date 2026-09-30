import type { NextRequest } from "next/server";
import { isCurrencyCode } from "@/lib/currency-shared";
import { isSupabaseConfigured } from "@/lib/env";
import { json } from "@/lib/http";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { cleanLine, cleanText, isEmailAddress, isPlainObject, isUuid, readJsonBody, toFiniteNumber, toInt } from "@/lib/request-guard";
import { isSchemaMismatch, logDbError, parseDbError } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/abandoned-cart — the checkout autosave (blueprint §9.10, §8), called by
 * useCheckoutAutosave() 2 s after the shopper stops typing.
 *
 *   64 KB body cap → 60 / 10 min per IP → validate → capture_abandoned_cart() (13_abandoned_carts.sql)
 *
 * Body: { id, email, firstName, lastName, phone, shipping, items: [{ productId, variantId, qty }],
 * subtotal, currency, exchangeRate }. The browser only NAMES the lines: the function re-reads
 * names, prices and images from the catalogue, recomputes the total (subtotal is ignored there),
 * keeps only the five address keys and binds the cart to the first address it saw.
 *
 * Best-effort and silent (§13): the answer is `{ ok }` only — the client never shows it.
 */

const MIGRATION = "13_abandoned_carts.sql";
const MAX_LINES = 50; // = capture_abandoned_cart
const SHIPPING_KEYS = { street: 500, city: 120, district: 60, postal_code: 20, country: 80 } as const;

type Line = { product_id: number; variant_id: number; quantity: number };

/** The place_order line shape, or null when `items` isn't a list of ≤ 50 entries. Malformed lines are dropped. */
function linesFrom(value: unknown): Line[] | null {
  if (!Array.isArray(value) || value.length > MAX_LINES) return null;
  const lines: Line[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const productId = toInt(item.productId, 1, 2147483647);
    const variantId = toInt(item.variantId, 1, 2147483647);
    const qty = toInt(item.qty, 1, 1000);
    if (productId !== null && variantId !== null && qty !== null) lines.push({ product_id: productId, variant_id: variantId, quantity: qty });
  }
  return lines;
}

function shippingFrom(value: unknown): Record<string, string> | null {
  if (!isPlainObject(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, max] of Object.entries(SHIPPING_KEYS)) {
    const text = cleanLine(value[key], max);
    if (text) out[key] = text;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ ok: false }, 503);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ ok: false }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ ok: false }, 422);
  const body = parsed.body;

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("abandoned-cart", request), 60, 600))) return json({ ok: false }, 429);

  const email = cleanText(body.email, 1000).toLowerCase();
  const items = linesFrom(body.items);
  if (!isUuid(body.id) || !isEmailAddress(email) || items === null) return json({ ok: false }, 422);
  const currency = isCurrencyCode(body.currency) ? body.currency : "LKR";

  const { error } = await supabase.rpc("capture_abandoned_cart", {
    p_id: body.id,
    p_email: email,
    p_first_name: cleanLine(body.firstName, 255) || null,
    p_last_name: cleanLine(body.lastName, 255) || null,
    p_phone: cleanLine(body.phone, 50) || null,
    p_shipping: shippingFrom(body.shipping),
    p_cart_items: items,
    p_total: toFiniteNumber(body.subtotal, 0, 1_000_000_000) ?? 0, // kept for the signature; SQL recomputes
    p_currency: currency,
    p_exchange_rate: currency === "LKR" ? 1 : (toFiniteNumber(body.exchangeRate, 0.000001, 1000) ?? 1),
  });
  if (error) {
    const { code } = parseDbError(error.message);
    if (code === "invalid_input") return json({ ok: false }, 422);
    if (code === "too_many_carts") return json({ ok: false }, 429);
    logDbError("api/abandoned-cart", error, MIGRATION);
    return json({ ok: false }, isSchemaMismatch(error) ? 503 : 500);
  }
  return json({ ok: true });
}
