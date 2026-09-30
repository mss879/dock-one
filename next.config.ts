import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants";

/*
 * Security headers, pinned image host and the production env guard (blueprint §3.3, §6.5, §13).
 * cacheComponents stays OFF (BUILD_SPEC §2.5) — storefront caching is lib/cache.ts.
 */

function supabaseOrigin(): URL | null {
  const raw = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export default function config(phase: string): NextConfig {
  const isDev = process.env.NODE_ENV === "development";
  const supabase = supabaseOrigin();
  const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim();

  // Never serve a silent mock store: a production build or `next start` without Supabase fails loudly.
  if ((phase === PHASE_PRODUCTION_BUILD || phase === PHASE_PRODUCTION_SERVER) && (!supabase || !anonKey)) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set for a production build/server (see .env.example). " +
        "Refusing to build a storefront with no backend.",
    );
  }

  const supabaseHttp = supabase ? supabase.origin : "";
  const supabaseWs = supabase ? supabase.origin.replace(/^http/, "ws") : "";
  const supabaseIsLocal = supabase ? LOOPBACK.has(supabase.hostname) : false;
  const siteIsHttps = (process.env.NEXT_PUBLIC_SITE_URL ?? "").trim().startsWith("https://");

  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // Next's bootstrap and inline JSON-LD need 'unsafe-inline'; React needs eval only in development.
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${supabaseHttp ? ` ${supabaseHttp}` : ""}`,
    "font-src 'self' data:",
    `connect-src 'self'${supabaseHttp ? ` ${supabaseHttp} ${supabaseWs}` : ""}`,
    "manifest-src 'self'",
    "worker-src 'self' blob:",
    ...(isDev || !siteIsHttps || supabaseIsLocal ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  const securityHeaders = [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
    ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]),
  ];

  return {
    poweredByHeader: false,
    images: {
      formats: ["image/avif", "image/webp"],
      // Next 16 only serves qualities on this allowlist (default is [75]).
      qualities: [75, 90],
      // Pinned to OUR project's public storage — never a wildcard (the optimiser would become a free proxy).
      remotePatterns: supabase
        ? [
            {
              protocol: supabase.protocol === "https:" ? "https" : "http",
              hostname: supabase.hostname,
              port: supabase.port,
              pathname: "/storage/v1/object/public/**",
            },
          ]
        : [],
      // Only for a local Supabase stack (127.0.0.1:54321); the pattern above still pins host, port and path.
      dangerouslyAllowLocalIP: supabaseIsLocal,
    },
    experimental: {
      // Proxy buffers request bodies up to this size (10 MB default). Just above the largest
      // route cap (assistant 512 KB incl. a base64 photo) so our own streaming caps stay meaningful.
      proxyClientMaxBodySize: "650kb",
    },
    async headers() {
      return [
        { source: "/(.*)", headers: securityHeaders },
        { source: "/admin/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
        { source: "/api/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex" }] },
      ];
    },
  };
}
