import type { NextRequest } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { serverEnv } from "@/lib/env.server";
import { sendCardPaymentEmails } from "@/lib/payments/notify";
import { attemptResult, readWebxpayReturn } from "@/lib/payments/webxpay";
import { isPlainObject } from "@/lib/request-guard";
import { logDbError, parseDbError } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST (or GET) /api/payments/webxpay/webhook — WebXPay's Return URL (set in WebXPay's portal →
 * Settings → Website integration). Blueprint §9.4: the gateway's signature-verified route that
 * calls the secret-gated mark_order_paid. WebXPay sends the SHOPPER'S BROWSER here with
 * `payment` + `signature` (+ `custom_fields`, unsigned and ignored), so this route:
 *
 *   1. verifies WebXPay's signature over `payment` (lib/payments/webxpay.ts) — before any
 *      database work, so an unsigned request costs nothing and needs no rate limit (a limit here
 *      could drop a real payment);
 *   2. approved → mark_order_paid; anything else → record_card_payment_failure, both with
 *      PAYMENTS_SECRET. The database applies an approval only for a reference it issued and the
 *      exact amount it asked for (49);
 *   3. the first time an order becomes paid, sends the confirmation + owner emails (fail-soft);
 *   4. 303 → the shopper's order page (/order/<id>?t=<view token>), which shows the outcome and,
 *      after a decline, "Try again". The reference in a signed answer is unguessable (49), so
 *      only the payer can be sent there.
 * Anything it cannot verify goes to /track?payment=unverified (an honest "we couldn't confirm
 * it here" note). Exempt from the site lock (proxy.ts): the browser arrives from WebXPay
 * without our cookies.
 */

const MIGRATION = "49_card_payments.sql";
const UNVERIFIED = "/track?payment=unverified";
const MAX_BODY = 64 * 1024;

/** A relative 303: the browser resolves it against whatever origin it came in on (localhost too). */
function seeOther(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "private, no-store, max-age=0" } });
}

type Params = { get(name: string): unknown };

async function readBody(request: NextRequest): Promise<Params | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) return null;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  try {
    if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) return await request.formData();
    const text = await request.text();
    return text.length <= MAX_BODY ? new URLSearchParams(text) : null;
  } catch {
    return null;
  }
}

const field = (params: Params | null, name: string): string => {
  const value = params?.get(name);
  return typeof value === "string" ? value : "";
};

async function handle(params: Params | null): Promise<Response> {
  const payment = field(params, "payment");
  const signature = field(params, "signature");
  if (!payment || !signature) return seeOther(UNVERIFIED);

  const read = readWebxpayReturn(payment, signature);
  if (!read.ok) {
    console.warn(`[webxpay] return refused (${read.reason})`);
    return seeOther(UNVERIFIED);
  }
  const { answer } = read;
  if (!isSupabaseConfigured) {
    console.error(`[webxpay] ${answer.reference}: Supabase is not configured — the answer was not recorded`);
    return seeOther(UNVERIFIED);
  }

  const rpc = answer.approved ? "mark_order_paid" : "record_card_payment_failure";
  const { data, error } = await createServerSupabase().rpc(rpc, {
    p_secret: serverEnv.paymentsSecret,
    p_reference: answer.reference,
    p_result: attemptResult(answer, "return"),
  });
  if (error) {
    logDbError("api/payments/webxpay/webhook", error, MIGRATION);
    if (parseDbError(error.message).code === "unauthorized") {
      console.error("[webxpay] PAYMENTS_SECRET does not match app_config.payments — WebXPay's answer was NOT recorded (see 49's OPS NOTE).");
    }
    console.error(`[webxpay] ${answer.reference}: ${answer.approved ? "APPROVED" : "declined"} answer not recorded (WebXPay ref ${answer.gatewayRef || "—"})`);
    return seeOther(UNVERIFIED);
  }

  const row = isPlainObject(data) ? data : {};
  if (row.outcome === "unknown_reference") {
    console.warn(`[webxpay] a signed answer for a reference this store never issued (${answer.reference})`);
    return seeOther(UNVERIFIED);
  }
  if (row.outcome === "review") {
    console.warn(`[webxpay] ${answer.reference}: WebXPay ${answer.approved ? "approved" : "answered"}, held for the owner's review (see the order's WebXPay attempts)`);
  }
  if (row.outcome === "paid" && row.first === true) {
    await sendCardPaymentEmails(data, "api/payments/webxpay/webhook");
  }

  const orderId = typeof row.order_id === "string" ? row.order_id : "";
  const token = typeof row.view_token === "string" ? row.view_token : "";
  if (!orderId || !token) return seeOther(UNVERIFIED);
  return seeOther(`/order/${encodeURIComponent(orderId)}?t=${encodeURIComponent(token)}`);
}

export async function POST(request: NextRequest) {
  return handle(await readBody(request));
}

/** Some gateways send the shopper back with a GET and the same parameters in the query. */
export async function GET(request: NextRequest) {
  return handle(request.nextUrl.searchParams);
}
