import type { NextRequest } from "next/server";
import { isNewsletterSource, NEWSLETTER_COPY } from "@/components/growth/newsletter-shared";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { cleanText, isBot, isEmailAddress, isPlainObject, readJsonBody } from "@/lib/request-guard";
import { logDbError, mapRpcError } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/newsletter { email, source } — the newsletter signup (blueprint §9.11, §8).
 *
 *   64 KB body cap → honeypot (answered exactly like a success) → 10 / hour per IP →
 *   validate → subscribe_newsletter(p_email, p_source) (12_leads.sql).
 *
 * The SAME `{ ok: true }` answers a new and an existing address (the function returns TRUE for
 * both, so the list can't be probed — P14). An explicit signup re-activates an unsubscribed
 * address (fresh consent, decided in SQL). No email is sent from here: the form's success copy
 * says only what is true — the address is on the list.
 */

const MIGRATION = "12_leads.sql";

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);

  const parsed = await readJsonBody(request); // 1. bounded read (64 KB)
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const body = parsed.body;

  if (isBot(body.company)) return json({ ok: true }); // 2. honeypot: indistinguishable from a signup

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("newsletter", request), 10, 3600))) {
    return json({ error: MESSAGES.slowDown }, 429); // 3. throttle before any DB work
  }

  // 4. validate: an over-long value is refused, never cut into a different address
  const email = cleanText(body.email, 1000).toLowerCase();
  if (!isEmailAddress(email)) return json({ error: NEWSLETTER_COPY.invalidEmail, field: "email" }, 422);
  const source = isNewsletterSource(body.source) ? body.source : "footer"; // = the SQL default

  const { data, error } = await supabase.rpc("subscribe_newsletter", { p_email: email, p_source: source }); // 5. ONE write
  if (error) {
    logDbError("api/newsletter", error, MIGRATION);
    // 6. missing function → 503 "migrations pending"; DB unreachable → 503; anything else → 500
    const mapped = mapRpcError(error, {}, { status: 500, message: NEWSLETTER_COPY.failed });
    return json({ error: mapped.message, code: mapped.code }, mapped.status);
  }
  if (data === false) return json({ error: NEWSLETTER_COPY.invalidEmail, field: "email" }, 422);

  return json({ ok: true });
}
