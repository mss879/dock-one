import type { NextRequest } from "next/server";
import { charCount, INQUIRY_REPLY_MAX } from "@/components/growth/contact-shared";
import { getAdminIdentity } from "@/lib/auth";
import { isEmailConfigured, sendEmail, validEmail } from "@/lib/email/send";
import { inquiryReply, inquiryReplyEmail } from "@/lib/email/templates/inquiries";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { cleanText, isPlainObject, isSameOrigin, isUuid, readJsonBody } from "@/lib/request-guard";
import { isSchemaMismatch, logDbError, MIGRATIONS_PENDING_MESSAGE } from "@/lib/rpc-errors";
import { getStoreSettings } from "@/lib/settings";
import { createSessionSupabase } from "@/lib/supabase/session";

/**
 * POST /api/admin/inquiry-reply — the inquiry desk's only way to answer (blueprint §9.12, §8).
 * A route, not a browser write, because it sends email (§8 "which admin actions get a route").
 *
 *   { id, mode: "email", reply }  → send the reply FIRST; mark the inquiry answered (status,
 *                                    answered_at, admin_reply, replied_by) ONLY if it sent.
 *                                    Send failed → 502 and the inquiry stays new. Sent but the
 *                                    update failed → 200 { ok, warning } so nobody sends it twice.
 *   { id, mode: "phone" }         → answered without an email (admin_reply NULL).
 *
 * Gate (P9.3): same-origin + getAdminIdentity(); the writes use the admin's SESSION client, so the
 * contact_inquiries admin RLS policy (all four verbs, 12_leads.sql) applies as well. The recipient
 * is always the inquiry's stored address — never one from the request body.
 */

const MIGRATION = "12_leads.sql";
const REPLY_MAX = INQUIRY_REPLY_MAX;
const FIELDS = "id, name, email, subject, message, status, answered_at, admin_reply, replied_by, created_at";

type InquiryRow = { id: string; name: string; email: string; status: string };

export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) return json({ error: MESSAGES.forbidden }, 403);
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);
  const admin = await getAdminIdentity();
  if (!admin) return json({ error: MESSAGES.forbidden }, 403);

  const parsed = await readJsonBody(request);
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const body = parsed.body;

  const id = isUuid(body.id) ? body.id : null;
  if (!id) return json({ error: "Unknown inquiry.", code: "inquiry_not_found" }, 422);
  const mode = body.mode === "email" || body.mode === "phone" ? body.mode : null;
  if (!mode) return json({ error: "Choose to reply by email or mark it answered.", code: "invalid_mode" }, 422);

  let reply = "";
  if (mode === "email") {
    reply = cleanText(body.reply, REPLY_MAX * 4).replace(/\r\n?/g, "\n");
    const length = charCount(reply);
    if (length === 0 || length > REPLY_MAX) {
      return json({ error: `Write a reply of up to ${REPLY_MAX.toLocaleString("en-GB")} characters.`, code: "invalid_reply" }, 422);
    }
    if (!isEmailConfigured) {
      return json(
        { error: "Email isn't set up (RESEND_API_KEY and RESEND_FROM_EMAIL), so nothing was sent. Mark it answered by phone instead, or set up email first.", code: "email_not_configured" },
        503,
      );
    }
  }

  let supabase;
  try {
    supabase = await createSessionSupabase();
  } catch {
    return json({ error: MESSAGES.unavailable }, 503);
  }

  const { data: found, error: readError } = await supabase.from("contact_inquiries").select("id, name, email, status").eq("id", id).maybeSingle();
  if (readError) {
    logDbError("api/admin/inquiry-reply", readError, MIGRATION);
    if (isSchemaMismatch(readError)) return json({ error: `${MIGRATIONS_PENDING_MESSAGE} Apply ${MIGRATION}.`, code: "migration_pending" }, 503);
    return json({ error: MESSAGES.generic }, 500);
  }
  const inquiry = found as InquiryRow | null;
  if (!inquiry) return json({ error: "That inquiry no longer exists — it may have been deleted.", code: "inquiry_not_found" }, 404);
  if (inquiry.status === "answered") return json({ error: "This inquiry has already been answered.", code: "already_answered" }, 409);

  // Stamped when the answer happened (after the send, for email replies).
  const answered = () => ({ status: "answered", answered_at: new Date().toISOString(), replied_by: admin.email.slice(0, 255) || null });

  if (mode === "phone") {
    const { data, error } = await supabase
      .from("contact_inquiries")
      .update({ ...answered(), admin_reply: null })
      .eq("id", id)
      .eq("status", "new") // someone else answering meanwhile → 0 rows, not a silent overwrite
      .select(FIELDS);
    if (error) {
      logDbError("api/admin/inquiry-reply", error, MIGRATION);
      return json({ error: "Couldn't mark the inquiry answered. Please try again." }, 500);
    }
    if (!Array.isArray(data) || data.length === 0) {
      return json({ error: "The inquiry changed meanwhile (answered or deleted). Refresh and check.", code: "no_rows" }, 409);
    }
    return json({ ok: true, emailed: false, inquiry: data[0] });
  }

  // mode === "email": 1. send FIRST, to the stored address only
  if (!validEmail(inquiry.email)) return json({ error: "This inquiry's email address can't receive mail. Mark it answered by phone instead.", code: "undeliverable" }, 422);
  const settings = await getStoreSettings();
  const result = await sendEmail(inquiryReplyEmail(inquiryReply({ to: inquiry.email, name: inquiry.name, reply }), settings));
  if (!result.ok) {
    console.error(`[api/admin/inquiry-reply] the reply to inquiry ${id} was not sent`);
    return json({ error: "The reply could not be sent, so the inquiry is still marked new. Please try again in a moment.", code: "send_failed" }, 502);
  }

  // 2. only now mark it answered, with the text that was sent
  const { data, error } = await supabase.from("contact_inquiries").update({ ...answered(), admin_reply: reply }).eq("id", id).select(FIELDS);
  if (error || !Array.isArray(data) || data.length === 0) {
    if (error) logDbError("api/admin/inquiry-reply", error, MIGRATION);
    else console.error(`[api/admin/inquiry-reply] reply to ${id} sent, but the update matched no row`);
    return json({
      ok: true,
      emailed: true,
      warning: "The reply was emailed, but the inquiry couldn't be marked answered. Don't send it again — refresh the desk first.",
    });
  }
  return json({ ok: true, emailed: true, inquiry: data[0] });
}
