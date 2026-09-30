import "server-only";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { isSupabaseConfigured, supabaseAnonKey, supabaseUrl } from "@/lib/env";
import { ROUTE_HEADERS } from "./route-token";
import { SupabaseNotConfiguredError } from "./server";

/**
 * Cookie-bound client for the signed-in viewer (`auth.uid()`): admin checks, owner-scoped
 * reads, RPCs that read the session. Create one per request — never share it.
 *
 * Reading cookies makes the calling route dynamic, so never call this from a shared
 * storefront layout (BUILD_SPEC §2.5: storefront auth state is read client-side).
 *
 * Server components cannot write cookies: `setAll` is wrapped in try/catch and the
 * proxy (src/proxy.ts → lib/supabase/proxy.ts) refreshes the session instead.
 * Route handlers CAN write cookies, so a refresh there lands on the response.
 */
export async function createSessionSupabase(): Promise<SupabaseClient> {
  if (!isSupabaseConfigured) throw new SupabaseNotConfiguredError();
  const store = await cookies();
  return createServerClient(supabaseUrl, supabaseAnonKey, {
    // ROUTE_HEADERS: this is the app's own server, not a direct PostgREST caller (01 brake, P3).
    global: { headers: { ...ROUTE_HEADERS } },
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) store.set(name, value, options);
        } catch {
          // Called from a server component: cookies are read-only there. The proxy refreshes them.
        }
      },
    },
  });
}
