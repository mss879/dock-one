import { createServerClient } from "@supabase/ssr";
import type { User } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from "@/lib/env";

/*
 * Server code, but deliberately WITHOUT `import "server-only"`: this module is bundled into
 * src/proxy.ts, which is compiled outside the React server graph. Never import it from a
 * client component.
 */

export type SessionUpdate = {
  /** Continue response carrying any refreshed auth cookies. Return it (or copy its cookies). */
  response: NextResponse;
  /** The verified user (auth.getUser round trip), or null when signed out / on any doubt. */
  user: User | null;
};

/**
 * Refreshes the Supabase auth cookie for this request and reports who is signed in.
 * It is an OPTIMISTIC check (blueprint §6.1/P9): admin rights are verified again in the
 * layout, the page, the API route, RLS and the RPC.
 */
export async function updateSession(request: NextRequest): Promise<SessionUpdate> {
  let response = NextResponse.next({ request });
  if (!isSupabaseConfigured) return { response, user: null };

  try {
    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
          // Responses that set auth cookies must never be cached by a CDN.
          for (const [key, value] of Object.entries(headers ?? {})) response.headers.set(key, value);
        },
      },
    });
    const { data, error } = await supabase.auth.getUser();
    return { response, user: error ? null : (data.user ?? null) };
  } catch (error) {
    console.error("[proxy] session refresh failed", error instanceof Error ? error.message : error);
    return { response, user: null };
  }
}

/** Copies refreshed auth cookies (and their no-cache headers) onto a redirect/rewrite. */
export function carrySessionCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) to.cookies.set(cookie);
  for (const key of ["cache-control", "expires", "pragma"]) {
    const value = from.headers.get(key);
    if (value) to.headers.set(key, value);
  }
  return to;
}
