import type { NextRequest } from "next/server";
import { CONTACT_COPY, CONTACT_FIELDS, normalizeContact, validateContact } from "@/components/growth/contact-shared";
import { getOwnerNotificationAddress, sendEmail } from "@/lib/email/send";
import { inquiryAlert, inquiryOwnerAlertEmail } from "@/lib/email/templates/inquiries";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { cleanText, isBot, isPlainObject, readJsonBody } from "@/lib/request-guard";
import { logDbError, mapRpcError, type ErrorTable } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/contact { name, email, subject, message, company } — the contact form (blueprint
 * §9.12, §8).
 *
 *   64 KB body cap → honeypot (a FAKE SUCCESS, so a bot has nothing to adapt to) → 3 / hour per
 *   IP → validate (the database's bounds, mirrored in contact-shared.ts) →
 *   submit_contact_inquiry() (12_leads.sql) → owner alert email (fail-soft: the inquiry is saved
 *   whether or not mail works, P5).
 *
 * Errors are the SQL contract: invalid_name · invalid_email · invalid_subject · invalid_message
 * → 422 with the field, so the form can point at it.
 */

const MIGRATION = "12_leads.sql";

const ERRORS: ErrorTable = {
  invalid_name: { status: 422, message: CONTACT_COPY.invalid_name },
  invalid_email: { status: 422, message: CONTACT_COPY.invalid_email },
  invalid_subject: { status: 422, message: CONTACT_COPY.invalid_subject },
  invalid_message: { status: 422, message: CONTACT_COPY.invalid_message },
};
const FIELD_OF_CODE: Record<string, string> = { invalid_name: "name", invalid_email: "email", invalid_subject: "subject", invalid_message: "message" };

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);

  const parsed = await readJsonBody(request); // 1. bounded read (64 KB)
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const body = parsed.body;

  if (isBot(body.company)) return json({ ok: true }); // 2. honeypot: fake success

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("contact", request), 3, 3600))) {
    return json({ error: MESSAGES.slowDown }, 429); // 3. throttle before any DB work
  }

  // 4. validate: control characters stripped, trimmed like the database, never truncated
  const values = normalizeContact({
    name: cleanText(body.name, 2000),
    email: cleanText(body.email, 1000),
    subject: cleanText(body.subject, 2000),
    message: cleanText(body.message, 20000),
  });
  const errors = validateContact(values);
  const first = CONTACT_FIELDS.find((field) => errors[field]);
  if (first) return json({ error: errors[first], field: first, errors }, 422);

  const { error } = await supabase.rpc("submit_contact_inquiry", {
    p_name: values.name,
    p_email: values.email,
    p_subject: values.subject,
    p_message: values.message,
  }); // 5. ONE trusted write
  if (error) {
    logDbError("api/contact", error, MIGRATION);
    const mapped = mapRpcError(error, ERRORS, { status: 500, message: CONTACT_COPY.failed }); // 6. code → copy
    const field = mapped.code ? FIELD_OF_CODE[mapped.code] : undefined;
    return json({ error: mapped.message, code: mapped.code, ...(field ? { field } : {}) }, mapped.status);
  }

  // 7. fail-soft side effect: tell the owner (the inquiry is already saved)
  const owner = getOwnerNotificationAddress();
  if (owner) {
    try {
      const result = await sendEmail(inquiryOwnerAlertEmail(inquiryAlert(values), owner));
      if (!result.ok && !result.skipped) console.error("[api/contact] the owner alert was not sent");
    } catch (e) {
      console.error("[api/contact] owner alert failed", e instanceof Error ? e.message : e);
    }
  }
  return json({ ok: true });
}
