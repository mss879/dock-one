import { NextResponse, type NextRequest } from "next/server";
import { accountNext, RESET_PASSWORD_PATH } from "@/components/account/auth";
import { isSupabaseConfigured } from "@/lib/env";
import { safeNext } from "@/lib/html";
import { createSessionSupabase } from "@/lib/supabase/session";

/**
 * GET /auth/callback?code=…&next=… — where Supabase confirmation and password-reset links land
 * (blueprint §3.2, §8, §9.13). The browser client is PKCE, so the one-time code is exchanged for a
 * session HERE, in a route handler (it can write the auth cookies), then the shopper continues
 * to the safe `next`.
 *
 * Failures never show internal detail — they go to /signin with an allowlisted `notice` key:
 * - code present but the exchange failed (expired flow, or opened in another browser, so the
 *   PKCE verifier cookie is missing): Supabase only issues the code after verifying the link,
 *   so a confirmation link's address IS confirmed → "confirmed, please sign in"; a reset link
 *   → "request a new link".
 * - no code (Supabase redirects with ?error=…&error_code=otp_expired when the link itself is
 *   invalid or used): nothing was confirmed → "link expired or already used".
 */

function go(request: NextRequest, path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, request.nextUrl.origin), 303);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const requested = safeNext(params.get("next"), "");
  const isReset = requested.split(/[?#]/)[0] === RESET_PASSWORD_PATH;
  const target = isReset ? RESET_PASSWORD_PATH : accountNext(requested || null);
  const failure = isReset ? "/signin?notice=reset_link" : "/signin?notice=link_invalid";

  if (!isSupabaseConfigured) return go(request, "/signin?notice=unavailable");

  const code = params.get("code");
  if (!code || code.length > 512) return go(request, failure);

  try {
    const supabase = await createSessionSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return go(request, target);
    // Codes and emails are never logged.
    console.warn("[auth/callback] code exchange failed:", error.code ?? error.name, error.status ?? "");
  } catch (error) {
    console.error("[auth/callback] code exchange failed:", error instanceof Error ? error.name : "unknown");
  }
  return go(request, isReset ? "/signin?notice=reset_link" : "/signin?notice=confirmed");
}
