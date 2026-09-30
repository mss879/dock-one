import { isAuthRetryableFetchError, type AuthError } from "@supabase/supabase-js";
import { absoluteUrl } from "@/lib/env";
import { safeNext } from "@/lib/html";

/**
 * Shared bits of the storefront auth flows (blueprint §9.13): where confirmation/reset links
 * land, the `next` rules, password rules and the one place Supabase auth errors become copy.
 * Plain module — imported by the /signin and /reset-password islands, the dashboard and the
 * callback route.
 */

/** Where a sign-in / confirmation lands when no (safe) `next` was given. */
export const DEFAULT_ACCOUNT_PATH = "/customer/dashboard";
export const RESET_PASSWORD_PATH = "/reset-password";

/** The forms ask for at least this many characters (set the same minimum in Supabase Auth — docs/build/AUTH_SETUP.md). */
export const MIN_PASSWORD_LENGTH = 8;
/** Supabase Auth refuses passwords over 72 bytes (bcrypt); keep the field below that. */
export const MAX_PASSWORD_LENGTH = 72;

/** Pages a `next` must never point back to (they would loop or strand the shopper). */
const NO_RETURN = ["/signin", "/auth", RESET_PASSWORD_PATH];

/** Open-redirect-safe `next` (blueprint §6.6) that is also not an auth page. */
export function accountNext(value: unknown, fallback = DEFAULT_ACCOUNT_PATH): string {
  const path = safeNext(value, fallback);
  const bare = path.split(/[?#]/)[0];
  return NO_RETURN.some((prefix) => bare === prefix || bare.startsWith(`${prefix}/`)) ? fallback : path;
}

/**
 * Absolute callback URL for emailRedirectTo / redirectTo: SITE_URL/auth/callback?next=… — the
 * link lands in the route handler, which exchanges the PKCE code for a session (blueprint §3.2).
 */
export function authCallbackUrl(next: string): string {
  return absoluteUrl(`/auth/callback?next=${encodeURIComponent(next)}`);
}

/** A light shape check before calling Supabase Auth (which validates the address itself). */
export function looksLikeEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/.test(value);
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (new TextEncoder().encode(password).length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  return null;
}

export const SERVICE_UNREACHABLE = "We couldn't reach the sign-in service. Check your connection and try again.";
export const NOT_CONFIGURED = "Accounts aren't available on this site yet.";

type Flow = "signin" | "signup" | "resend" | "reset" | "update";

/** Supabase AuthError → shopper copy. Never echoes the server's own message. */
export function authErrorMessage(error: AuthError, flow: Flow): string {
  if (isAuthRetryableFetchError(error)) return SERVICE_UNREACHABLE;
  switch (error.code) {
    case "invalid_credentials":
      return "That email and password don't match. Check them and try again.";
    case "email_not_confirmed":
      return "Confirm your email address first — open the link we sent you. Need a new one? Use the button below.";
    case "user_banned":
      return "This account can't sign in. Please contact us.";
    case "signup_disabled":
    case "email_provider_disabled":
      return "New accounts can't be created right now. Please try again later.";
    case "email_address_invalid":
    case "validation_failed":
      return "Enter a valid email address.";
    case "weak_password":
      return `Choose a stronger password — at least ${MIN_PASSWORD_LENGTH} characters, harder to guess.`;
    case "same_password":
      return "Your new password must be different from your current one.";
    case "reauthentication_needed":
    case "reauthentication_not_valid":
      return "For your security, sign out and sign in again, then change your password.";
    case "session_not_found":
    case "session_expired":
    case "refresh_token_not_found":
    case "refresh_token_already_used":
      return flow === "update" ? "Your session has expired. Sign in again (or request a new reset link) and try once more." : "Your session has expired. Please sign in again.";
    case "over_email_send_rate_limit":
      return "We've sent several emails to this address just now. Please wait a minute and try again.";
    case "over_request_rate_limit":
      return "Too many attempts. Please wait a minute and try again.";
    default:
      break;
  }
  if (error.status === 429) return "Too many attempts. Please wait a minute and try again.";
  if (flow === "signup" && error.status === 500) {
    // e.g. the customers trigger refused the row (customer_email_conflict — SQL_NOTES §02)
    return "We couldn't create your account. Please contact us.";
  }
  if (flow === "resend" || flow === "reset") return "We couldn't send the email just now. Please try again in a few minutes.";
  if (flow === "update") return "We couldn't update your password. Please try again.";
  return "Something went wrong. Please try again.";
}
