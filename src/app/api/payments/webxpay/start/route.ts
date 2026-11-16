import type { NextRequest } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { serverEnv } from "@/lib/env.server";
import { json, MESSAGES } from "@/lib/http";
import { isOrderId } from "@/lib/orders";
import { buildWebxpayForm, isWebxpayReady } from "@/lib/payments/webxpay";
import { bucket, checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { isPlainObject, isSameOrigin, isUuid, readJsonBody } from "@/lib/request-guard";
import { logDbError, mapRpcError, type ErrorTable } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/payments/webxpay/start — the order page's Pay button (49_card_payments.sql).
 * Body: { orderId, token } (the order page's view token — the shopper's credential).
 *   1. same origin · WebXPay keys on the server · rate limits per IP and per order
 *   2. begin_card_payment(PAYMENTS_SECRET, order, token) opens an attempt with a fresh,
 *      unguessable reference and returns the payer's details
 *   3. answers { ok, action, fields }: the form the browser POSTs to WebXPay. Built here because
 *      `payment` is encrypted with the merchant's WebXPay key and `secret_key` is the merchant's.
 * The order page itself must submit the form: its CSP is the only one that lets a form leave
 * the site (next.config.ts, form-action on /order/*).
 */

const MIGRATION = "49_card_payments.sql";

const COPY = {
  unavailable: "Card payment isn't available right now. Please try again later or contact us.",
  notFound: "We couldn't find that order. Please open it again from your confirmation email.",
  alreadyPaid: "This order is already paid — thank you!",
  cancelled: "This order was cancelled, so there's nothing to pay.",
  notDue: "There's nothing to pay on this order.",
  tooMany: "Too many payment attempts for this order. Please wait an hour or contact us.",
} as const;

const ERRORS: ErrorTable = {
  already_paid: { status: 409, message: COPY.alreadyPaid },
  order_cancelled: { status: 409, message: COPY.cancelled },
  payment_not_due: { status: 409, message: COPY.notDue },
  not_card_order: { status: 409, message: COPY.notDue },
  amount_too_small: { status: 409, message: COPY.notDue },
  card_unavailable: { status: 503, message: COPY.unavailable },
  too_many_attempts: { status: 429, message: COPY.tooMany },
  unauthorized: { status: 503, message: COPY.unavailable },
};

function fail(message: string, status: number, code: string | null) {
  return json({ ok: false, error: message, code }, status);
}

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return fail(MESSAGES.forbidden, 403, "forbidden");
  if (!isSupabaseConfigured || !isWebxpayReady()) return fail(COPY.unavailable, 503, "card_unavailable");

  const parsed = await readJsonBody(request, 4 * 1024);
  if (!parsed.ok) return fail(parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid, parsed.status, null);
  if (!isPlainObject(parsed.body)) return fail(MESSAGES.invalid, 422, "invalid");
  const orderId = typeof parsed.body.orderId === "string" ? parsed.body.orderId.trim().toUpperCase() : "";
  const token = typeof parsed.body.token === "string" ? parsed.body.token.trim() : "";
  if (!isOrderId(orderId) || !isUuid(token)) return fail(COPY.notFound, 404, "not_found");

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("card-start", request), 12, 600))) return fail(MESSAGES.slowDown, 429, "rate_limited");
  if (!(await checkRateLimit(supabase, bucket("card-start", "order", orderId), 8, 600))) return fail(MESSAGES.slowDown, 429, "rate_limited");

  const { data, error } = await supabase.rpc("begin_card_payment", { p_secret: serverEnv.paymentsSecret, p_order_id: orderId, p_token: token });
  if (error) {
    logDbError("api/payments/webxpay/start", error, MIGRATION);
    const mapped = mapRpcError(error, ERRORS, { status: 503, message: COPY.unavailable });
    if (mapped.code === "unauthorized") console.error("[webxpay] PAYMENTS_SECRET does not match app_config.payments — card payments cannot start (see 49's OPS NOTE).");
    return fail(mapped.message, mapped.status, mapped.code);
  }
  if (!isPlainObject(data)) return fail(COPY.notFound, 404, "not_found");

  const reference = typeof data.reference === "string" ? data.reference : "";
  const amount = Number(data.amount);
  const address = isPlainObject(data.shipping_address) ? data.shipping_address : {};
  const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
  try {
    const form = buildWebxpayForm({
      reference,
      amount,
      payer: {
        email: str(data.email) ?? "",
        firstName: str(data.first_name),
        lastName: str(data.last_name),
        phone: str(data.phone) ?? "",
        fulfillment: data.fulfillment === "pickup" ? "pickup" : "delivery",
        address: { street: str(address.street), city: str(address.city), district: str(address.district), postalCode: str(address.postal_code) },
      },
    });
    return json({ ok: true, action: form.action, fields: form.fields });
  } catch (error_) {
    console.error("[webxpay] could not build the payment form", error_ instanceof Error ? error_.message : error_);
    return fail(COPY.unavailable, 503, "card_unavailable");
  }
}
