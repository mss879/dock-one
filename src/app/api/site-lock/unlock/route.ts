import type { NextRequest } from "next/server";
import { PIN_PATTERN } from "@/components/admin/site-lock/types";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { cleanLine, isBot, isPlainObject, readJsonBody } from "@/lib/request-guard";
import { isMissingFunction, logDbError, MIGRATIONS_PENDING_MESSAGE } from "@/lib/rpc-errors";
import { normalizeUnlockToken, SITE_LOCK_COOKIE, SITE_LOCK_MIGRATION, siteLockCookieOptions } from "@/lib/site-lock";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/site-lock/unlock { pin, company? } — the holding page's PIN form (blueprint §9.15, §8).
 *
 * 2 KB cap → honeypot (answered exactly like a wrong PIN) → 10 attempts per minute per IP →
 * verify_site_lock_pin (bcrypt in the database, which also keeps the 10-strikes-then-15-minute
 * cool-off and checks it BEFORE comparing) → on a match, the httpOnly, sameSite=lax, 30-day bypass
 * cookie. ONE message covers a wrong PIN, no PIN set and a cool-off (P14: nothing tells a prober
 * which guess was close or whether the counter tripped).
 */

export const dynamic = "force-dynamic";

const BODY_LIMIT = 2 * 1024;
const WRONG_PIN_MESSAGE = "That PIN didn't work. Check it and try again.";

function refused() {
  return json({ ok: false, error: WRONG_PIN_MESSAGE }, 401);
}

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ ok: false, error: MESSAGES.notConfigured }, 503);

  const parsed = await readJsonBody(request, BODY_LIMIT);
  if (!parsed.ok) return json({ ok: false, error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ ok: false, error: MESSAGES.invalid }, 422);
  const body = parsed.body;

  if (isBot(body.company)) return refused();

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("site-lock", request), 10, 60))) {
    return json({ ok: false, error: "Too many attempts. Wait a minute and try again." }, 429);
  }

  // PINs are 6–12 digits (set_site_lock's rule, PIN_PATTERN); anything else can never match, so it
  // gets the same answer without spending a database compare.
  const pin = cleanLine(body.pin, 64).replace(/\s+/g, "");
  if (!PIN_PATTERN.test(pin)) return refused();

  const { data, error } = await supabase.rpc("verify_site_lock_pin", { p_pin: pin });
  if (error) {
    logDbError("api/site-lock/unlock", error, SITE_LOCK_MIGRATION);
    if (isMissingFunction(error)) return json({ ok: false, error: MIGRATIONS_PENDING_MESSAGE, code: "migration_pending" }, 503);
    return json({ ok: false, error: MESSAGES.unavailable }, 503);
  }

  const token = normalizeUnlockToken(data);
  if (!token) return refused();

  const response = json({ ok: true });
  response.cookies.set(SITE_LOCK_COOKIE, token, siteLockCookieOptions(request.nextUrl.protocol === "https:"));
  return response;
}
