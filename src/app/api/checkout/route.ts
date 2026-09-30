import type { NextRequest } from "next/server";
import {
  CHECKOUT_COPY,
  checkoutRequestSchema,
  codLimitMessage,
  fieldErrorsFrom,
  invalidVariantMessage,
  normalizeDiscountCode,
  outOfStockMessage,
  parseCheckoutItems,
  shippingSchema,
  type CheckoutField,
} from "@/lib/checkout";
import { DISCOUNT_REFUSED_MESSAGE, discountMinimumMessage } from "@/lib/discount-copy";
import { getOwnerNotificationAddress, sendEmail, type EmailMessage } from "@/lib/email/send";
import { orderConfirmationEmail, ownerOrderAlertEmail, placedOrderFromRpc } from "@/lib/email/templates/orders";
import { isSupabaseConfigured } from "@/lib/env";
import { formatLKR } from "@/lib/format";
import { json, MESSAGES } from "@/lib/http";
import { getPaymentProvider } from "@/lib/payments";
import { bucket, checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { cleanLine, isBot, isEmailAddress, isPlainObject, isUuid, readJsonBody } from "@/lib/request-guard";
import { logDbError, mapRpcError, parseDbError, type ErrorTable } from "@/lib/rpc-errors";
import { getStoreSettings } from "@/lib/settings";
import { createServerSupabase } from "@/lib/supabase/server";
import { createSessionSupabase } from "@/lib/supabase/session";

/**
 * POST /api/checkout — the only way an order is created (blueprint §9.4, §6.7; SQL_NOTES
 * "/api/checkout must"):
 *   1. 64 KB body cap · honeypot `company` (answered exactly like invalid items)
 *   2. rate limits BEFORE any DB work: 5 / 10 min per IP AND 3 / hour per email
 *   3. validate (lib/checkout.ts — the same schema the form uses) · payment provider
 *   4. ONE RPC: place_order with the SESSION client, so a signed-in buyer's auth.uid() links it
 *   5. the full error map (409 stock/product, 422 validation, 503 unavailable / migration)
 *   6. fail-soft emails AFTER the commit: confirmation to the shopper + owner alert, each isolated
 * The client sends WHAT it wants (ids, quantities, a code, a payment METHOD); SQL decides every
 * price, fee, discount, payment status and the order number (P1).
 */

const MIGRATION = "09_order_rpcs.sql";

type Detail = { field?: CheckoutField | "discountCode"; minimum?: number; codMax?: number; line?: { label?: string; productId?: number } };

const money = (detail: string): number | null => {
  const n = Number(detail);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** place_order's machine codes → status + copy (SQL_NOTES route error map). Only listed details are interpolated. */
const ERRORS: ErrorTable = {
  out_of_stock: { status: 409, message: (label) => outOfStockMessage(label || "An item") },
  unknown_product: { status: 409, message: CHECKOUT_COPY.unknownProduct },
  invalid_variant: { status: 409, message: (name) => invalidVariantMessage(name || "an item") },
  discount_minimum_not_met: {
    status: 422,
    message: (min) => {
      const minimum = money(min);
      return minimum === null ? DISCOUNT_REFUSED_MESSAGE : discountMinimumMessage(minimum);
    },
  },
  invalid_discount_code: { status: 422, message: DISCOUNT_REFUSED_MESSAGE },
  discount_exhausted: { status: 422, message: DISCOUNT_REFUSED_MESSAGE },
  cod_limit_exceeded: {
    status: 422,
    message: (max) => {
      const cap = money(max);
      return cap === null ? CHECKOUT_COPY.unsupportedPayment : codLimitMessage(formatLKR(cap));
    },
  },
  unsupported_payment_method: { status: 422, message: CHECKOUT_COPY.unsupportedPayment },
  pickup_unavailable: { status: 422, message: CHECKOUT_COPY.pickupUnavailable },
  invalid_fulfillment: { status: 422, message: CHECKOUT_COPY.invalidFulfillment },
  invalid_email: { status: 422, message: CHECKOUT_COPY.invalidEmail },
  invalid_name: { status: 422, message: CHECKOUT_COPY.invalidName },
  invalid_phone: { status: 422, message: CHECKOUT_COPY.invalidPhone },
  invalid_shipping_address: { status: 422, message: CHECKOUT_COPY.invalidAddress },
  invalid_note: { status: 422, message: CHECKOUT_COPY.invalidNote },
  invalid_items: { status: 422, message: CHECKOUT_COPY.invalidItems },
  invalid_quantity: { status: 422, message: CHECKOUT_COPY.invalidQuantity },
  invalid_currency: { status: 422, message: CHECKOUT_COPY.invalidCurrency },
  invalid_exchange_rate: { status: 422, message: CHECKOUT_COPY.invalidCurrency },
  store_unavailable: { status: 503, message: CHECKOUT_COPY.storeUnavailable },
  // SQLSTATEs (should not happen — the whole order rolled back, so one retry is safe)
  "40P01": { status: 503, message: CHECKOUT_COPY.retry },
  "40001": { status: 503, message: CHECKOUT_COPY.retry },
  "22P02": { status: 422, message: CHECKOUT_COPY.refresh },
};

const FIELD_BY_CODE: Partial<Record<string, CheckoutField | "discountCode">> = {
  invalid_email: "email",
  invalid_name: "firstName",
  invalid_phone: "phone",
  invalid_shipping_address: "shipping.street",
  invalid_note: "note",
  invalid_items: "items",
  invalid_quantity: "items",
  unsupported_payment_method: "paymentMethod",
  cod_limit_exceeded: "paymentMethod",
  pickup_unavailable: "fulfillment",
  invalid_fulfillment: "fulfillment",
  invalid_discount_code: "discountCode",
  discount_exhausted: "discountCode",
  discount_minimum_not_met: "discountCode",
};

function fail(message: string, status: number, code: string | null, detail: Detail = {}) {
  return json({ ok: false, error: message, code, ...detail }, status);
}

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return fail(MESSAGES.notConfigured, 503, "not_configured");

  // 1. bounded read · honeypot
  const parsed = await readJsonBody(request);
  if (!parsed.ok) return fail(parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid, parsed.status, null);
  if (!isPlainObject(parsed.body)) return fail(CHECKOUT_COPY.invalidItems, 422, "invalid_items", { field: "items" });
  const body = parsed.body;
  if (isBot(body.company)) return fail(CHECKOUT_COPY.invalidItems, 422, "invalid_items", { field: "items" });

  // 2. throttle BEFORE any DB work (orders decrement stock and redeem codes)
  const limiter = createServerSupabase();
  if (!(await checkRateLimit(limiter, ipBucket("checkout", request), 5, 600))) return fail(MESSAGES.slowDown, 429, "rate_limited");
  const email = cleanLine(body.email, 254).toLowerCase();
  if (!isEmailAddress(email)) return fail(CHECKOUT_COPY.invalidEmail, 422, "invalid_email", { field: "email" });
  if (!(await checkRateLimit(limiter, bucket("checkout", "email", email), 3, 3600))) return fail(MESSAGES.slowDown, 429, "rate_limited");

  // 3. validate, trim, clamp, allowlist
  const input = checkoutRequestSchema.safeParse(body);
  if (!input.success) {
    const fields = fieldErrorsFrom(input.error.issues);
    const [field, message] = (Object.entries(fields)[0] ?? ["items", CHECKOUT_COPY.invalidItems]) as [CheckoutField, string];
    return fail(message, 422, "invalid_input", { field });
  }
  const order = input.data;

  const provider = getPaymentProvider(order.paymentMethod);
  if (!provider) return fail(CHECKOUT_COPY.unsupportedPayment, 422, "unsupported_payment_method", { field: "paymentMethod" });

  const items = parseCheckoutItems(order.items);
  if (items.length === 0) return fail(CHECKOUT_COPY.invalidItems, 422, "invalid_items", { field: "items" });

  const rawCode = typeof order.discountCode === "string" ? order.discountCode.trim() : "";
  const discountCode = rawCode ? normalizeDiscountCode(rawCode) : null;
  if (rawCode && !discountCode) return fail(DISCOUNT_REFUSED_MESSAGE, 422, "invalid_discount_code", { field: "discountCode" });

  let shipping: Record<string, string> = {};
  if (order.fulfillment === "delivery") {
    const address = shippingSchema.safeParse(order.shipping ?? {});
    if (!address.success) return fail(CHECKOUT_COPY.invalidAddress, 422, "invalid_shipping_address", { field: "shipping.street" });
    shipping = { street: address.data.street, city: address.data.city, district: address.data.district, country: address.data.country };
    if (address.data.postal_code) shipping.postal_code = address.data.postal_code;
  }

  const exchangeRate = order.currency === "LKR" ? 1 : Math.round(order.exchangeRate * 1e6) / 1e6;
  if (!(exchangeRate > 0)) return fail(CHECKOUT_COPY.invalidCurrency, 422, "invalid_exchange_rate", { field: "currency" });

  // The seam: offline methods authorise nothing online — SQL assigns the starting status.
  const payment = await provider.begin();

  // 4. ONE trusted write, as the viewer (auth.uid() links a signed-in buyer; guests stay NULL).
  let supabase;
  try {
    supabase = await createSessionSupabase();
  } catch (error) {
    console.error("[api/checkout] session client unavailable", error instanceof Error ? error.message : error);
    return fail(CHECKOUT_COPY.storeUnavailable, 503, "unavailable");
  }
  const { data, error } = await supabase.rpc("place_order", {
    p_email: order.email,
    p_first_name: order.firstName,
    p_last_name: order.lastName || null,
    p_phone: order.phone,
    p_shipping: shipping,
    p_items: items.map((item) => ({ product_id: item.productId, variant_id: item.variantId, quantity: item.qty })),
    p_discount_code: discountCode,
    p_abandoned_cart_id: isUuid(order.abandonedCartId) ? order.abandonedCartId : null,
    p_currency: order.currency,
    p_exchange_rate: exchangeRate,
    p_payment_method: provider.method,
    p_fulfillment: order.fulfillment,
    p_customer_note: order.note,
  });

  // 5. errors are a contract
  if (error) {
    logDbError("api/checkout", error, MIGRATION);
    const mapped = mapRpcError(error, ERRORS, { status: 500, message: CHECKOUT_COPY.failed });
    const { detail } = parseDbError(error.message);
    const extra: Detail = {};
    const field = mapped.code ? FIELD_BY_CODE[mapped.code] : undefined;
    if (field) extra.field = field;
    if (mapped.code === "out_of_stock" && detail) extra.line = { label: detail };
    if (mapped.code === "invalid_variant" && detail) extra.line = { label: detail };
    if (mapped.code === "unknown_product" && /^\d{1,9}$/.test(detail)) extra.line = { productId: Number(detail) };
    if (mapped.code === "discount_minimum_not_met") extra.minimum = money(detail) ?? undefined;
    if (mapped.code === "cod_limit_exceeded") extra.codMax = money(detail) ?? undefined;
    return fail(mapped.message, mapped.status, mapped.code, extra);
  }

  const row = isPlainObject(data) ? data : {};
  const orderId = typeof row.order_id === "string" ? row.order_id : null;
  const viewToken = typeof row.view_token === "string" ? row.view_token : null;
  if (!orderId || !viewToken) {
    // The transaction committed (no error) — never tell the shopper it failed.
    console.error("[api/checkout] place_order returned an unexpected shape");
  }
  if (row.payment_status !== payment.paymentStatus) {
    console.error(`[api/checkout] payment seam mismatch: SQL set ${String(row.payment_status)}, provider expected ${payment.paymentStatus}`);
  }

  // 6. fail-soft side effects, each isolated: the order exists whether or not mail works (P5).
  const placed = placedOrderFromRpc(data);
  if (placed) {
    const settings = await getStoreSettings();
    const owner = getOwnerNotificationAddress();
    const send = async (label: string, build: () => EmailMessage) => {
      try {
        const result = await sendEmail(build());
        // sendEmail already logged the provider's reason; never log the recipient here.
        if (!result.ok && !result.skipped) console.error(`[api/checkout] ${label} email for ${placed.orderId} was not sent`);
      } catch (e) {
        console.error(`[api/checkout] ${label} email for ${placed.orderId} failed`, e instanceof Error ? e.message : e);
      }
    };
    await Promise.all([
      send("confirmation", () => orderConfirmationEmail(placed, settings)),
      owner ? send("owner alert", () => ownerOrderAlertEmail(placed, settings, owner)) : Promise.resolve(),
    ]);
  } else {
    console.error("[api/checkout] order placed but the email payload could not be built — no emails sent");
  }

  return json({
    ok: true,
    orderId,
    viewToken,
    createdAt: row.created_at ?? null,
    firstName: placed?.firstName ?? null,
    subtotal: Number(row.subtotal ?? 0),
    shippingFee: Number(row.shipping_fee ?? 0),
    discountCode: typeof row.discount_code === "string" ? row.discount_code : null,
    discountAmount: Number(row.discount_amount ?? 0),
    total: Number(row.total ?? 0),
    paymentMethod: row.payment_method ?? provider.method,
    paymentStatus: row.payment_status ?? null,
    fulfillment: row.fulfillment ?? order.fulfillment,
    items: (placed?.items ?? []).map((item) => ({ name: item.name, variantName: item.variantName, quantity: item.quantity, unitPrice: item.unitPrice, lineTotal: item.lineTotal })),
  });
}
