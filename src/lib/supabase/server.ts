import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from "@/lib/env";
import { ROUTE_HEADERS } from "./route-token";

/**
 * Stateless ANON client (blueprint §4): public catalogue reads and anon-granted RPCs.
 * No session is read, persisted or refreshed, so it is safe to share one instance per
 * server process. RLS applies as `anon`. For anything that needs `auth.uid()`, use
 * `createSessionSupabase()` from `./session`.
 *
 * Callers must check `isSupabaseConfigured` first (or catch): an unconfigured project
 * throws `SupabaseNotConfiguredError` here instead of failing somewhere deeper.
 */

export class SupabaseNotConfiguredError extends Error {
  constructor() {
    super("Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.");
    this.name = "SupabaseNotConfiguredError";
  }
}

let anon: SupabaseClient | null = null;

export function createServerSupabase(): SupabaseClient {
  if (!isSupabaseConfigured) throw new SupabaseNotConfiguredError();
  if (!anon) {
    anon = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      // ROUTE_HEADERS: this is the app's own server, not a direct PostgREST caller (01 brake, P3).
      global: { headers: { "x-client-info": "dockone-server", ...ROUTE_HEADERS } },
    });
  }
  return anon;
}
