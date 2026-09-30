import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  HEADLINE_MAX,
  LAUNCH_MAX_HOURS,
  MESSAGE_MAX,
  normalizeAdminSiteLockState,
  type AdminSiteLockState,
} from "@/components/admin/site-lock/types";
import { getAdminIdentity } from "@/lib/auth";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { cleanText, isPlainObject, isSameOrigin, readJsonBody } from "@/lib/request-guard";
import { isMissingFunction, isMissingRelation, logDbError, MIGRATIONS_PENDING_MESSAGE, parseDbError, type DbError } from "@/lib/rpc-errors";
import {
  invalidateSiteLockCache,
  normalizeUnlockToken,
  SITE_LOCK_COOKIE,
  SITE_LOCK_MIGRATION,
  siteLockCookieOptions,
} from "@/lib/site-lock";
import { createSessionSupabase } from "@/lib/supabase/session";

/**
 * GET/POST /api/admin/site-lock — the admin Site lock tab (blueprint §9.15, §11.2, §8).
 *
 * Both: same-origin → getAdminIdentity() (P9.3) → the SESSION client, so admin_site_lock_state /
 * set_site_lock / admin_site_lock_token re-check is_admin() inside (42501).
 *
 * GET  → { state }                                     (admin_site_lock_state()[0])
 * POST { locked?, pin?, headline?, message?, launchAt?: ISO | null, autoUnlock? }
 *      → set_site_lock(...) → refresh THIS operator's bypass cookie from admin_site_lock_token()
 *        (locking — or a new PIN, which rotates the token — never locks out the person who did
 *        it) → invalidateSiteLockCache() → { ok, state, cookieRefreshed }.
 * Errors: 403 not an admin · 422 `code:detail` from set_site_lock (invalid_pin, invalid_launch,
 * invalid_headline, invalid_message, pin_required) · 503 migration pending (code migration_pending).
 */

export const dynamic = "force-dynamic";

const BODY_LIMIT = 8 * 1024;

type Failure = { status: number; body: { error: string; code?: string } };

function failureFor(scope: string, error: DbError): Failure {
  logDbError(scope, error, SITE_LOCK_MIGRATION);
  if (isMissingFunction(error) || isMissingRelation(error)) {
    return { status: 503, body: { error: `${MIGRATIONS_PENDING_MESSAGE} Apply ${SITE_LOCK_MIGRATION}.`, code: "migration_pending" } };
  }
  if (error?.code === "42501") return { status: 403, body: { error: MESSAGES.forbidden, code: "not_authorised" } };
  if (error?.code === "22023") {
    // `code:human text` written for the operator (SQL_NOTES §18).
    const { code, detail } = parseDbError(error.message);
    return { status: 422, body: { error: detail || "That change isn't allowed.", code: code ?? "invalid" } };
  }
  return { status: 500, body: { error: "Couldn't update the site lock. Please try again." } };
}

async function readState(supabase: SupabaseClient): Promise<{ state: AdminSiteLockState } | { failure: Failure }> {
  const { data, error } = await supabase.rpc("admin_site_lock_state");
  if (error) return { failure: failureFor("api/admin/site-lock", error) };
  const state = normalizeAdminSiteLockState(data);
  if (!state) return { failure: { status: 500, body: { error: "The site lock returned no state." } } };
  return { state };
}

async function guard(request: NextRequest): Promise<{ supabase: SupabaseClient } | { response: ReturnType<typeof json> }> {
  if (!isSameOrigin(request)) return { response: json({ error: MESSAGES.forbidden }, 403) };
  if (!isSupabaseConfigured) return { response: json({ error: MESSAGES.notConfigured }, 503) };
  const admin = await getAdminIdentity();
  if (!admin) return { response: json({ error: MESSAGES.forbidden }, 403) };
  try {
    return { supabase: await createSessionSupabase() };
  } catch {
    return { response: json({ error: MESSAGES.unavailable }, 503) };
  }
}

export async function GET(request: NextRequest) {
  const checked = await guard(request);
  if ("response" in checked) return checked.response;
  const result = await readState(checked.supabase);
  if ("failure" in result) return json(result.failure.body, result.failure.status);
  return json({ state: result.state });
}

type SetArgs = {
  p_locked: boolean | null;
  p_pin: string | null;
  p_headline: string | null;
  p_message: string | null;
  p_launch_in_hours: number | null;
  p_clear_launch: boolean;
  p_auto_unlock: boolean | null;
};

/** Validate and map the tab's body onto set_site_lock's arguments (the SQL re-validates everything). */
function toArgs(body: Record<string, unknown>, now: number): { args: SetArgs } | { error: string; code: string } {
  const args: SetArgs = {
    p_locked: typeof body.locked === "boolean" ? body.locked : null,
    p_pin: null,
    p_headline: null,
    p_message: null,
    p_launch_in_hours: null,
    p_clear_launch: false,
    p_auto_unlock: typeof body.autoUnlock === "boolean" ? body.autoUnlock : null,
  };

  if (body.pin !== undefined && body.pin !== null) {
    if (typeof body.pin !== "string") return { error: "The PIN must be 6 to 12 digits.", code: "invalid_pin" };
    const pin = body.pin.replace(/\s+/g, "");
    if (pin) args.p_pin = pin.slice(0, 64);
  }
  if (body.headline !== undefined && body.headline !== null) {
    const headline = cleanText(body.headline, HEADLINE_MAX + 1).replace(/\s+/g, " ");
    if (headline.length > HEADLINE_MAX) return { error: `The headline can be at most ${HEADLINE_MAX} characters.`, code: "invalid_headline" };
    args.p_headline = headline || null;
  }
  if (body.message !== undefined && body.message !== null) {
    const message = cleanText(body.message, MESSAGE_MAX + 1);
    if (message.length > MESSAGE_MAX) return { error: `The message can be at most ${MESSAGE_MAX} characters.`, code: "invalid_message" };
    args.p_message = message || null;
  }
  if (body.launchAt === null) {
    args.p_clear_launch = true;
  } else if (body.launchAt !== undefined) {
    const at = typeof body.launchAt === "string" ? Date.parse(body.launchAt) : Number.NaN;
    if (!Number.isFinite(at)) return { error: "Pick a valid launch date and time.", code: "invalid_launch" };
    const hours = (at - now) / 3_600_000;
    if (hours <= 0) return { error: "The launch time must be in the future.", code: "invalid_launch" };
    if (hours > LAUNCH_MAX_HOURS) return { error: "The launch time can be at most a year away.", code: "invalid_launch" };
    // set_site_lock takes "hours from now" (launch_at = now() + hours); keep it precise to the second.
    args.p_launch_in_hours = Math.round(hours * 3600) / 3600;
  }
  return { args };
}

export async function POST(request: NextRequest) {
  const checked = await guard(request);
  if ("response" in checked) return checked.response;
  const { supabase } = checked;

  const parsed = await readJsonBody(request, BODY_LIMIT);
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);

  const mapped = toArgs(parsed.body, Date.now());
  if ("error" in mapped) return json({ error: mapped.error, code: mapped.code }, 422);

  const { error } = await supabase.rpc("set_site_lock", mapped.args);
  if (error) {
    const failure = failureFor("api/admin/site-lock", error);
    return json(failure.body, failure.status);
  }
  invalidateSiteLockCache();

  // Refresh the operator's own bypass cookie (the token rotates with every new PIN).
  let token: string | null = null;
  const tokenResult = await supabase.rpc("admin_site_lock_token");
  if (tokenResult.error) logDbError("api/admin/site-lock token", tokenResult.error, SITE_LOCK_MIGRATION);
  else token = normalizeUnlockToken(tokenResult.data);

  const result = await readState(supabase);
  // The save itself succeeded: report it even if the follow-up read failed.
  const response =
    "failure" in result
      ? json({ ok: true, state: null, cookieRefreshed: Boolean(token) })
      : json({ ok: true, state: result.state, cookieRefreshed: Boolean(token) });
  if (token) response.cookies.set(SITE_LOCK_COOKIE, token, siteLockCookieOptions(request.nextUrl.protocol === "https:"));
  return response;
}
