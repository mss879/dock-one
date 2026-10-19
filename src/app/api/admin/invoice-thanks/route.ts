import type { NextRequest } from "next/server";
import { getAdminIdentity, identityCan } from "@/lib/auth";
import { isEmailConfigured, sendEmail, validEmail } from "@/lib/email/send";
import { invoiceThankYouEmail } from "@/lib/email/templates/documents";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { isPlainObject, isSameOrigin, readJsonBody, toInt } from "@/lib/request-guard";
import { logDbError } from "@/lib/rpc-errors";
import { getStoreSettings } from "@/lib/settings";
import { createSessionSupabase } from "@/lib/supabase/session";

/**
 * POST /api/admin/invoice-thanks { invoiceId } — the after-sales thank-you email (with the website
 * link) to the client of an ISSUED invoice that has an email, ONCE per invoice (40_sales_documents ·
 * thank_you_sent_at). Called by the invoice builder right after issuing; fail-soft. The text-message
 * version waits for the client's SMS provider.
 */
export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);
  if (!isSameOrigin(request)) return json({ error: MESSAGES.forbidden }, 403);
  const admin = await getAdminIdentity();
  if (!admin || !identityCan(admin, "invoices")) return json({ error: MESSAGES.forbidden }, 403);
  const parsed = await readJsonBody(request, 1024);
  if (!parsed.ok || !isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const invoiceId = toInt(parsed.body.invoiceId, 1, 2147483647);
  if (invoiceId == null) return json({ error: MESSAGES.invalid }, 422);
  if (!isEmailConfigured) return json({ sent: false, reason: "email_not_configured" });

  const supabase = await createSessionSupabase();
  const { data: invoice, error } = await supabase
    .from("invoices")
    .select("id, number, status, doc_type, bill_to_name, bill_to_email, thank_you_sent_at")
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) {
    logDbError("api/admin/invoice-thanks", error, "40_sales_documents.sql");
    return json({ sent: false });
  }
  const row = invoice as { number: string | null; status: string; doc_type?: string; bill_to_name: string | null; bill_to_email: string | null; thank_you_sent_at?: string | null } | null;
  if (!row || row.status !== "issued" || row.doc_type === "quotation" || row.thank_you_sent_at || !row.number || !validEmail(row.bill_to_email ?? "")) {
    return json({ sent: false });
  }
  // Claim it first (once per invoice), then send.
  const { data: claimed, error: claimError } = await supabase.rpc("admin_mark_thank_you_sent", { p_invoice_id: invoiceId });
  if (claimError || claimed !== true) return json({ sent: false });
  const settings = await getStoreSettings();
  const result = await sendEmail(invoiceThankYouEmail({ to: row.bill_to_email as string, name: row.bill_to_name, number: row.number }, settings));
  return json({ sent: result.ok });
}
