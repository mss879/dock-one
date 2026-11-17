import type { NextRequest } from "next/server";
import { getAdminIdentity, identityCan } from "@/lib/auth";
import { isEmailConfigured, sendEmail } from "@/lib/email/send";
import { stockAlertEmail } from "@/lib/email/templates/stock-alerts";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { isPlainObject, isSameOrigin, readJsonBody, toInt } from "@/lib/request-guard";
import { logDbError, mapRpcError } from "@/lib/rpc-errors";
import { getStoreSettings } from "@/lib/settings";
import { createSessionSupabase } from "@/lib/supabase/session";

/**
 * POST /api/admin/stock-alerts { variantId } — email everyone waiting on an option that is back
 * (50_product_availability · "Notify me"). A route, not a browser write, because it sends email.
 *
 * Gate: same-origin + an admin, or staff with Inventory → edit; the database checks again
 * (admin_take_stock_alerts through the SESSION client). The waiting requests are taken (marked
 * told) first, then each email is sent; any that could not be sent go back to waiting
 * (admin_return_stock_alerts) so nobody is lost — and nobody is told twice.
 */

const MIGRATION = "50_product_availability.sql";

type Taken = { product_id: number; product_name: string; variant_name: string | null; emails: { id: number; email: string }[] };

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return json({ error: MESSAGES.forbidden }, 403);
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);
  const admin = await getAdminIdentity();
  if (!admin || !identityCan(admin, "inventory")) return json({ error: MESSAGES.forbidden }, 403);
  if (!isEmailConfigured) {
    return json({ error: "Email isn't set up (RESEND_API_KEY and RESEND_FROM_EMAIL), so nothing was sent.", code: "email_not_configured" }, 503);
  }

  const parsed = await readJsonBody(request, 1024);
  if (!parsed.ok || !isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const variantId = toInt(parsed.body.variantId, 1, 2147483647);
  if (variantId === null) return json({ error: MESSAGES.invalid }, 422);

  let supabase;
  try {
    supabase = await createSessionSupabase();
  } catch {
    return json({ error: MESSAGES.unavailable }, 503);
  }
  const { data, error } = await supabase.rpc("admin_take_stock_alerts", { p_variant_id: variantId });
  if (error) {
    logDbError("api/admin/stock-alerts", error, MIGRATION);
    const mapped = mapRpcError(error, { variant_not_found: { status: 404, message: "That product option no longer exists." } });
    return json({ error: mapped.message, code: mapped.code }, mapped.status);
  }
  const taken = data as Taken;
  const emails = Array.isArray(taken?.emails) ? taken.emails : [];
  if (emails.length === 0) return json({ ok: true, sent: 0, failed: 0 });

  const settings = await getStoreSettings();
  const failed: number[] = [];
  for (const entry of emails) {
    const result = await sendEmail(
      stockAlertEmail({ to: entry.email, productName: taken.product_name, variantName: taken.variant_name, productId: taken.product_id, variantId }, settings),
    );
    if (!result.ok) failed.push(entry.id);
  }
  if (failed.length) {
    const back = await supabase.rpc("admin_return_stock_alerts", { p_ids: failed });
    if (back.error) logDbError("api/admin/stock-alerts.return", back.error, MIGRATION);
  }
  return json({ ok: true, sent: emails.length - failed.length, failed: failed.length });
}
