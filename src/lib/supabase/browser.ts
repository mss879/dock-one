"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from "@/lib/env";

/**
 * Browser singleton for client islands (sign in/out, wishlist, dashboard reads).
 * PKCE flow: confirmation and reset links land on /auth/callback?code=… and are
 * exchanged in a route handler (blueprint §3.2).
 *
 * Returns null when Supabase isn't configured (local design preview) — every caller must
 * handle that, and wrap auth calls in try/catch (blueprint §14 lesson 30).
 */
let client: SupabaseClient | null = null;

export function getBrowserSupabase(): SupabaseClient | null {
  if (!isSupabaseConfigured || typeof window === "undefined") return null;
  if (!client) {
    client = createBrowserClient(supabaseUrl, supabaseAnonKey, {
      auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  return client;
}
