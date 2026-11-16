import type { NextRequest } from "next/server";
import { getAdminIdentity, identityCan } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/env";
import { serverEnv } from "@/lib/env.server";
import { json, MESSAGES } from "@/lib/http";
import { normalizeOrderRef } from "@/lib/orders";
import { sendCardPaymentEmails } from "@/lib/payments/notify";
import { lookupWebxpayTransactions, webxpayAmount, webxpayStatus, WEBXPAY_RETURN_PATH } from "@/lib/payments/webxpay";
import { isPlainObject, isSameOrigin, readJsonBody } from "@/lib/request-guard";
import { isSchemaMismatch, logDbError, MIGRATIONS_PENDING_MESSAGE } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";
import { createSessionSupabase } from "@/lib/supabase/session";

/**
 * /api/admin/webxpay — the admin side of card payments (49_card_payments.sql).
 *
 * GET  → what the server has: { ready, environment, missing[], lookup, returnPath }. Names of
 *        missing env vars only — never a key. (Settings → Payments, the order drawer.)
 * POST { orderId } → "Check with WebXPay": for a card order still awaiting payment, asks WebXPay's
 *        transaction API about each recent attempt (newest first). An attempt WebXPay reports
 *        "Approved" for a stated amount goes through mark_order_paid exactly like a return — the
 *        database still refuses a short amount — and the first time the order becomes paid the
 *        confirmation and owner emails go out. Needs Orders → edit, and the optional
 *        WEBXPAY_API_* credentials.
 */

const MIGRATION = "49_card_payments.sql";

export async function GET() {
  const admin = await getAdminIdentity();
  if (!admin) return json({ error: MESSAGES.forbidden }, 403);
  const status = webxpayStatus();
  return json({ ready: status.ready, environment: status.environment, missing: status.missing, lookup: status.lookup, returnPath: WEBXPAY_RETURN_PATH });
}

type Line = { reference: string; outcome: "paid" | "review" | "not_found" | "not_approved" | "no_amount"; message: string };

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return json({ error: MESSAGES.forbidden }, 403);
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);
  const admin = await getAdminIdentity();
  if (!admin || !identityCan(admin, "orders")) return json({ error: MESSAGES.forbidden }, 403);

  const parsed = await readJsonBody(request, 4 * 1024);
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const orderId = normalizeOrderRef(parsed.body.orderId);
  if (!orderId) return json({ error: "Unknown order number.", code: "order_not_found" }, 422);

  const status = webxpayStatus();
  if (!status.lookup) return json({ error: "WebXPay's transaction API isn't set up on the server — check the payment in WebXPay's portal instead.", code: "lookup_off" }, 422);
  if (!status.ready) return json({ error: `Card payments aren't set up on the server (missing ${status.missing.join(", ")}).`, code: "card_unavailable" }, 503);

  let session;
  try {
    session = await createSessionSupabase();
  } catch {
    return json({ error: MESSAGES.unavailable }, 503);
  }
  // Read under the admin's own RLS (staff need Orders → view for both tables).
  const order = await session.from("orders").select("id, payment_method, payment_status, status").eq("id", orderId).maybeSingle();
  if (order.error) {
    logDbError("api/admin/webxpay", order.error, MIGRATION);
    return json({ error: MESSAGES.unavailable }, 503);
  }
  if (!order.data) return json({ error: "No order with that number.", code: "order_not_found" }, 404);
  const row = order.data as Record<string, unknown>;
  if (row.payment_method !== "card") return json({ error: "This order isn't paid by card.", code: "not_card_order" }, 409);
  if (row.payment_status !== "awaiting_payment") return json({ ok: true, paid: row.payment_status === "paid", results: [], note: "Nothing to check: the order isn't awaiting payment." });

  const attempts = await session
    .from("payment_attempts")
    .select("reference, amount, status")
    .eq("order_id", orderId)
    .in("status", ["started", "declined", "review"])
    .order("created_at", { ascending: false })
    .limit(5);
  if (attempts.error) {
    logDbError("api/admin/webxpay", attempts.error, MIGRATION);
    if (isSchemaMismatch(attempts.error)) return json({ error: `${MIGRATIONS_PENDING_MESSAGE} Apply ${MIGRATION}.`, code: "migration_pending" }, 503);
    return json({ error: MESSAGES.unavailable }, 503);
  }
  const rows = (attempts.data ?? []) as { reference: string; amount: number | string; status: string }[];
  if (rows.length === 0) return json({ ok: true, paid: false, results: [], note: "The customer hasn't started a card payment for this order yet." });

  const lookup = await lookupWebxpayTransactions(rows.map((attempt) => attempt.reference));
  if (!lookup.ok) return json({ error: lookup.error, code: "lookup_failed" }, 502);

  const results: Line[] = [];
  let paid = false;
  const server = createServerSupabase();
  for (const attempt of rows) {
    const found = lookup.transactions.get(attempt.reference) ?? null;
    if (!found) {
      results.push({ reference: attempt.reference, outcome: "not_found", message: "WebXPay has no payment for this attempt." });
      continue;
    }
    if (!found.approved) {
      results.push({ reference: attempt.reference, outcome: "not_approved", message: `WebXPay says: ${found.status}.` });
      continue;
    }
    if (!found.amount) {
      results.push({ reference: attempt.reference, outcome: "no_amount", message: "WebXPay reports it approved but gave no amount — check it in WebXPay's portal, then mark the order paid by hand." });
      continue;
    }
    const { data, error } = await server.rpc("mark_order_paid", {
      p_secret: serverEnv.paymentsSecret,
      p_reference: attempt.reference,
      p_result: {
        requested_amount: webxpayAmount(Number(attempt.amount)),
        paid_amount: found.amount,
        gateway_ref: found.gatewayRef,
        gateway_status: found.status,
        gateway_message: `${found.status} (WebXPay transaction API)`,
        gateway_time: found.time,
        source: "lookup",
      },
    });
    if (error) {
      logDbError("api/admin/webxpay", error, MIGRATION);
      return json({ error: "WebXPay confirmed a payment, but it couldn't be recorded. Check the server's PAYMENTS_SECRET, or mark the order paid by hand.", code: "record_failed", results }, 503);
    }
    const outcome = isPlainObject(data) ? data.outcome : null;
    if (outcome === "paid") {
      paid = true;
      results.push({ reference: attempt.reference, outcome: "paid", message: `WebXPay approved Rs. ${found.amount} — the order is now marked paid.` });
      if (isPlainObject(data) && data.first === true) await sendCardPaymentEmails(data, "api/admin/webxpay");
      break;
    }
    results.push({ reference: attempt.reference, outcome: "review", message: "WebXPay approved it, but it was held for review — see the attempt's note." });
  }
  return json({ ok: true, paid, results });
}
