/**
 * Public, client-safe configuration. Every value here is either a NEXT_PUBLIC_* variable
 * (inlined into both bundles at build time — which is why each one is read with a literal
 * `process.env.NEXT_PUBLIC_…` expression) or derived from one.
 *
 * Server secrets live in `env.server.ts` (server-only). Never add a secret here.
 *
 * Boot/build guard: a production build or `next start` without the Supabase URL/key throws
 * in `next.config.ts` (blueprint §3.3 / §13 "never serve a silent mock store"). This module
 * only reports the state; data readers use `isSupabaseConfigured` to fail soft in development.
 */

const rawSupabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
const rawSupabaseAnonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();
const rawSiteUrl = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim();

/** The live domain, used when NEXT_PUBLIC_SITE_URL is unset (BUILD_SPEC §1). */
export const FALLBACK_SITE_URL = "https://dockonesolutions.com";

function parseHttpUrl(value: string): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

const supabaseUrlParsed = parseHttpUrl(rawSupabaseUrl);

/** `https://<ref>.supabase.co` (no trailing slash), or "" when unset/invalid. */
export const supabaseUrl = supabaseUrlParsed ? supabaseUrlParsed.origin : "";
export const supabaseAnonKey = rawSupabaseAnonKey;

/** True when both public Supabase values are present and the URL parses. */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

/** Public storage prefix: every product/content image uploaded by the admin starts with this. */
export const supabaseStoragePublicPrefix = supabaseUrl ? `${supabaseUrl}/storage/v1/object/public/` : "";

/** Canonical origin, no trailing slash. Used for metadataBase, sitemap, email links. */
export const siteUrl = (parseHttpUrl(rawSiteUrl)?.origin ?? FALLBACK_SITE_URL).replace(/\/+$/, "");

/** Absolute URL on the canonical origin for a path like `/order/DO-10001`. */
export function absoluteUrl(path = "/"): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `${siteUrl}${clean}`;
}

export const isProduction = process.env.NODE_ENV === "production";
