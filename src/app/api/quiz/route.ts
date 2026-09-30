import type { NextRequest } from "next/server";
import { isEmailConfigured, sendEmail } from "@/lib/email/send";
import { finderResultsEmail, finderResultsFrom } from "@/lib/email/templates/finder";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { answersRecord, parseAnswers, profileFor, recommend } from "@/lib/quiz";
import { fetchCatalogueForFinder } from "@/lib/quiz-catalogue";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { cleanLine, isBot, isEmailAddress, isPlainObject, isUuid, readJsonBody } from "@/lib/request-guard";
import { logDbError, mapRpcError, parseDbError, type ErrorTable } from "@/lib/rpc-errors";
import { getStoreSettings } from "@/lib/settings";
import { createServerSupabase } from "@/lib/supabase/server";
import { createSessionSupabase } from "@/lib/supabase/session";

/**
 * POST /api/quiz — guided-finder capture (blueprint §9.14 step 8, §8; contract: SQL_NOTES →
 * 14_finder.sql). Called by /discover when the results appear (answers only) and again if the
 * shopper asks for their picks by email:
 *
 *   { sessionId: uuid, answers: { category, use?, budget?, portability?, avoid[] }, email?, company }
 *   → { ok: true }                      (answers only)
 *   → { ok: true, emailed: boolean }    (with an email)
 *
 * Blueprint §6.7 order: 64 KB body cap → honeypot (answered exactly like a success) → 20/h per
 * IP BEFORE any database work → validate: the session id is a UUID, the answers are allowlisted
 * against the question definitions (`parseAnswers`), the email is well-formed → the picks and the
 * profile are RE-DERIVED here from the answers with the same `recommend()` over the same catalogue
 * the page used (never ids, reasons or prose from the body; at most the 3 shown) → ONE RPC,
 * `record_finder_response`, with the SESSION client so `customer_id` comes only from the cookie
 * session (the SQL attaches it only when it equals auth.uid()) → mapped error codes → the results
 * email as a fail-soft side effect. The function itself subscribes a supplied email with source
 * 'finder' — this route never calls subscribe_newsletter.
 */

const MIGRATION = "14_finder.sql";
const LIMIT = { max: 20, windowSeconds: 3600 };

const COPY = {
  stale: "Your answers couldn't be read. Please run the finder again.",
  invalidEmail: "Enter a valid email address, like name@example.com.",
  emailUnavailable: "We can't email results just now.",
  failed: "We couldn't save that just now. Please try again in a moment.",
} as const;

const ERRORS: ErrorTable = {
  invalid_session: { status: 422, message: COPY.stale },
  invalid_answers: { status: 422, message: COPY.stale },
  invalid_recommendations: { status: 422, message: COPY.stale },
};

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);

  const parsed = await readJsonBody(request); // 1. bounded read (64 KB)
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const body = parsed.body;
  const wantsEmail = typeof body.email === "string" && body.email.trim() !== "";

  if (isBot(body.company)) return json(wantsEmail ? { ok: true, emailed: true } : { ok: true }); // 2. honeypot

  if (!(await checkRateLimit(createServerSupabase(), ipBucket("quiz", request), LIMIT.max, LIMIT.windowSeconds))) {
    return json({ error: MESSAGES.slowDown }, 429); // 3. throttle BEFORE db work
  }

  // 4. validate + allowlist
  if (!isUuid(body.sessionId)) return json({ error: COPY.stale }, 422);
  const sessionId = body.sessionId.toLowerCase();
  let email: string | null = null;
  if (wantsEmail) {
    const candidate = cleanLine(body.email, 254).toLowerCase();
    if (!isEmailAddress(candidate)) return json({ error: COPY.invalidEmail, field: "email" }, 422);
    // Never collect an address for a promise we can't keep (P15): no email service, no email.
    if (!isEmailConfigured) return json({ error: COPY.emailUnavailable }, 503);
    email = candidate;
  }

  const catalogue = await fetchCatalogueForFinder();
  if (catalogue.products.length === 0) return json({ error: MESSAGES.unavailable }, 503);
  const answers = parseAnswers(body.answers, catalogue);
  if (!answers) return json({ error: COPY.stale }, 422);

  // Re-derived server-side (P4): the same engine and catalogue as the page, capped to the 3 shown.
  const picks = recommend(answers, catalogue);
  const profile = profileFor(answers);

  // 5. ONE trusted write, with the viewer's session (customer id from the cookie session only)
  const supabase = await createSessionSupabase();
  let customerId: string | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    customerId = data.user?.id ?? null;
  } catch {
    customerId = null;
  }
  const { error } = await supabase.rpc("record_finder_response", {
    p_session_id: sessionId,
    p_answers: answersRecord(answers),
    p_email: email,
    p_recommended: picks.map((p) => p.productId),
    p_profile: profile,
    p_customer_id: customerId,
  });
  if (error) {
    const mapped = mapRpcError(error, ERRORS, { status: 500, message: COPY.failed }); // 6. code → copy + status
    const { code } = parseDbError(error.message);
    if (!code || !Object.prototype.hasOwnProperty.call(ERRORS, code)) logDbError("api.quiz", error, MIGRATION);
    return json({ error: mapped.message }, mapped.status);
  }

  if (!email) return json({ ok: true });

  // 7. fail-soft side effect: the results email, built only from server-derived facts
  let emailed = false;
  try {
    const results = finderResultsFrom(email, answers, picks, catalogue);
    if (results) {
      const settings = await getStoreSettings();
      const sent = await sendEmail(finderResultsEmail(results, settings));
      emailed = sent.ok;
    }
  } catch (sendError) {
    console.error("[api.quiz] results email failed", sendError instanceof Error ? sendError.message : sendError);
  }
  return json({ ok: true, emailed });
}
