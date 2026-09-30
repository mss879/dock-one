import "server-only";
import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isProduction } from "@/lib/env";
import { isUsableSecret, serverEnv } from "@/lib/env.server";

/**
 * Rate limiting (blueprint §6.4). The counter lives in Postgres (`check_rate_limit`, migration
 * 01_foundation.sql) because serverless instances are short-lived. The public RPC is gated by
 * RATE_LIMIT_SECRET (= app_config.rate_limit) so nobody can pre-fill someone else's bucket.
 *
 * FAILS OPEN on any error (log once per instance): a limiter that blocks when its storage
 * hiccups takes the store offline. An unset secret therefore means NO limits — a deploy error.
 */

const secret = serverEnv.rateLimitSecret;
const secretUsable = isUsableSecret(secret);

if (isProduction && !secretUsable) {
  console.error(
    [
      "",
      "████ RATE LIMITING IS OFF ████",
      "RATE_LIMIT_SECRET is unset or shorter than 20 characters. Every rate limit fails open.",
      "Set it to the value of app_config.rate_limit (see the OPS NOTE in supabase/migrations/01_foundation.sql).",
      "",
    ].join("\n"),
  );
}

let warned = false;
function warnOnce(reason: string) {
  if (warned) return;
  warned = true;
  console.warn(`[rate-limit] Rate limiting unavailable — failing open (${reason}).`);
}

/** HMAC identifiers (IPs, emails) before they become bucket names: the hits table never holds PII. */
export function hashKey(value: string): string {
  return createHmac("sha256", secret || "dev").update(value.trim().toLowerCase()).digest("hex").slice(0, 32);
}

/**
 * The caller's IP, trusted in this order: CLIENT_IP_HEADER (the platform's socket-derived
 * header), then x-real-ip, then the FIRST x-forwarded-for entry (client-writable — last
 * resort). Unknown callers share ONE bucket; they never get unlimited access.
 */
/** Anything with request headers: a Request, or `{ headers: await headers() }` in a server component. */
export type HeaderSource = { headers: { get(name: string): string | null } };

export function clientKey(request: HeaderSource): string {
  const headers = request.headers;
  const configured = headers.get(serverEnv.clientIpHeader)?.split(",")[0]?.trim();
  const realIp = headers.get("x-real-ip")?.trim();
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (configured || realIp || forwarded || "unknown").slice(0, 64);
}

/** `feature:dimension:<hmac>` — e.g. bucket("checkout", "ip", clientKey(request)). */
export function bucket(feature: string, dimension: string, value: string): string {
  return `${feature}:${dimension}:${hashKey(value)}`;
}

/** Shorthand for the per-IP bucket every public route uses. */
export function ipBucket(feature: string, request: Request): string {
  return bucket(feature, "ip", clientKey(request));
}

/**
 * true = allowed. Call it BEFORE any database work. Each call is its own round trip,
 * never batched into one statement (calls in one statement share a snapshot).
 */
export async function checkRateLimit(supabase: SupabaseClient, bucketName: string, max: number, windowSeconds: number): Promise<boolean> {
  if (!secretUsable) {
    warnOnce("RATE_LIMIT_SECRET unset or too short");
    return true;
  }
  try {
    const { data, error } = await supabase.rpc("check_rate_limit", {
      p_secret: secret,
      p_bucket: bucketName,
      p_max: max,
      p_window_seconds: windowSeconds,
    });
    if (error) {
      warnOnce(error.code === "PGRST202" ? "check_rate_limit is missing — apply migration 01_foundation.sql" : error.message);
      return true;
    }
    return data !== false;
  } catch (error) {
    warnOnce(error instanceof Error ? error.message : "transport error");
    return true;
  }
}
