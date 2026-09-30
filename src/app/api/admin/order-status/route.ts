import type { NextRequest } from "next/server";
import { getAdminIdentity } from "@/lib/auth";
import { sendEmail } from "@/lib/email/send";
import { deliveredEmail, orderStatusNoticeFromRpc, outForDeliveryEmail } from "@/lib/email/templates/orders";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { isAssignableOrderStatus, normalizeOrderRef } from "@/lib/orders";
import { cleanLine, cleanText, isPlainObject, isSameOrigin, readJsonBody, toFiniteNumber } from "@/lib/request-guard";
import { isMissingFunction, isMissingRelation, logDbError, MIGRATIONS_PENDING_MESSAGE, parseDbError } from "@/lib/rpc-errors";
import { getStoreSettings } from "@/lib/settings";
import { createSessionSupabase } from "@/lib/supabase/session";

/**
 * POST /api/admin/order-status — the ONLY path that changes an order's status (blueprint §9.7,
 * §8: it sends email, so it is a route, not a browser write). Also where tracking details are
 * saved (same status + new tracking → an "Update" timeline row) so tracking can never skip the
 * timeline.
 *
 *   1. same-origin + getAdminIdentity() → 403 (P9.3; the RPC re-checks is_admin() too)
 *   2. validate: status ∈ ASSIGNABLE_ORDER_STATUSES; tracking/packing/note bounded
 *   3. admin_set_order_status with the SESSION client (in one transaction: status, timeline row,
 *      and on cancel: restock + discount use returned + lifetime value reversed)
 *   4. email the customer on out_for_delivery and delivered — only when the status really
 *      changed — and answer `emailed: <address> | null` so the admin toast can say so.
 *
 * Body: { orderId, status, trackingNumber?, trackingUrl?, packingCharges?, note? }
 */

const MIGRATION = "09_order_rpcs.sql";

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return json({ error: MESSAGES.forbidden }, 403);
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);
  const admin = await getAdminIdentity();
  if (!admin) return json({ error: MESSAGES.forbidden }, 403);

  const parsed = await readJsonBody(request, 8 * 1024);
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const body = parsed.body;

  const orderId = normalizeOrderRef(body.orderId);
  if (!orderId) return json({ error: "Unknown order number.", code: "order_not_found" }, 422);
  const status = typeof body.status === "string" ? body.status.trim().toLowerCase() : "";
  if (!isAssignableOrderStatus(status)) return json({ error: "Unsupported order status.", code: "invalid_status" }, 422);

  const trackingNumber = cleanLine(body.trackingNumber, 101);
  if (trackingNumber.length > 100) return json({ error: "Tracking numbers can be up to 100 characters.", code: "invalid_tracking_number" }, 422);
  const trackingUrl = cleanText(body.trackingUrl, 501);
  if (trackingUrl && (trackingUrl.length > 500 || !/^https:\/\/[^\s\\]+$/.test(trackingUrl))) {
    return json({ error: "Use a full https:// tracking link (up to 500 characters).", code: "invalid_tracking_url" }, 422);
  }
  let packingCharges: number | null = null;
  if (body.packingCharges !== undefined && body.packingCharges !== null && body.packingCharges !== "") {
    packingCharges = toFiniteNumber(body.packingCharges, 0, 100000);
    if (packingCharges === null) return json({ error: "Packing charges must be between Rs. 0 and Rs. 100,000.", code: "invalid_packing_charges" }, 422);
  }
  const note = cleanText(body.note, 501);
  if (note.length > 500) return json({ error: "Notes can be up to 500 characters.", code: "invalid_note" }, 422);

  let supabase;
  try {
    supabase = await createSessionSupabase();
  } catch {
    return json({ error: MESSAGES.unavailable }, 503);
  }
  const { data, error } = await supabase.rpc("admin_set_order_status", {
    p_order_id: orderId,
    p_status: status,
    p_tracking_number: trackingNumber || null,
    p_tracking_url: trackingUrl || null,
    p_packing_charges: packingCharges,
    p_note: note || null,
  });

  if (error) {
    logDbError("api/admin/order-status", error, MIGRATION);
    if (isMissingFunction(error) || isMissingRelation(error)) {
      return json({ error: `${MIGRATIONS_PENDING_MESSAGE} Apply ${MIGRATION}.`, code: "migration_pending" }, 503);
    }
    if (error.code === "42501") return json({ error: MESSAGES.forbidden, code: "not_authorised" }, 403);
    if (error.code === "22023") {
      // `code:human detail` — written for the operator (SQL_NOTES admin_set_order_status errors).
      const { code, detail } = parseDbError(error.message);
      return json({ error: detail || "That change isn't allowed.", code }, 422);
    }
    return json({ error: "Couldn't update the order. Please try again." }, 500);
  }

  const result = isPlainObject(data) ? data : {};
  const changed = result.changed === true;
  const previousStatus = typeof result.previous_status === "string" ? result.previous_status : null;
  const newStatus = typeof result.status === "string" ? result.status : status;

  // Customer email: only for a real move INTO out_for_delivery / delivered (blueprint §9.7 step 5).
  // emailStatus: "sent" | "skipped" (email not configured / no address) | "failed" | "none" (no email for this change)
  let emailed: string | null = null;
  let emailStatus: "sent" | "skipped" | "failed" | "none" = "none";
  if (changed && newStatus !== previousStatus && (newStatus === "out_for_delivery" || newStatus === "delivered")) {
    const notice = orderStatusNoticeFromRpc(data);
    emailStatus = "skipped";
    if (notice) {
      try {
        const settings = await getStoreSettings();
        const message = newStatus === "out_for_delivery" ? outForDeliveryEmail(notice, settings) : deliveredEmail(notice, settings);
        const sent = await sendEmail(message);
        if (sent.ok) {
          emailed = notice.email;
          emailStatus = "sent";
        } else if (!sent.skipped) {
          emailStatus = "failed";
          console.error(`[api/admin/order-status] ${newStatus} email for ${notice.orderId} was not sent`);
        }
      } catch (e) {
        emailStatus = "failed";
        console.error(`[api/admin/order-status] ${newStatus} email for ${notice.orderId} failed`, e instanceof Error ? e.message : e);
      }
    }
  }

  return json({
    ok: true,
    order: {
      orderId: result.order_id ?? orderId,
      status: newStatus,
      previousStatus,
      changed,
      timelineLabel: result.timeline_label ?? null,
      fulfillment: result.fulfillment ?? null,
      paymentMethod: result.payment_method ?? null,
      paymentStatus: result.payment_status ?? null,
      amountDue: Number(result.amount_due ?? 0),
      trackingNumber: result.tracking_number ?? null,
      trackingUrl: result.tracking_url ?? null,
      packingCharges: Number(result.packing_charges ?? 0),
    },
    emailed,
    emailStatus,
  });
}
