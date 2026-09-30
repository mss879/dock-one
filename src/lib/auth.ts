import "server-only";
import { redirect } from "next/navigation";
import { cache } from "react";
import { isSupabaseConfigured } from "@/lib/env";
import { safeNext } from "@/lib/html";
import { logDbError } from "@/lib/rpc-errors";
import { createSessionSupabase } from "@/lib/supabase/session";

/**
 * Server-side identity (blueprint §6.2, P9). The ONLY thing that grants admin is
 * customers.is_admin, read with the viewer's own session so RLS applies. `cache()` lets a
 * layout and its page share one round trip per request while BOTH still check.
 *
 * Any doubt → deny (§13 "Admin checks: any doubt → deny"). These read cookies, so every
 * route that calls them is dynamic — use them in account/checkout/order/admin only.
 */

export type AdminIdentity = { id: string; email: string };
export type SessionUser = { id: string; email: string; emailConfirmed: boolean };

export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  if (!isSupabaseConfigured) return null;
  try {
    const supabase = await createSessionSupabase();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? "", emailConfirmed: Boolean(data.user.email_confirmed_at) };
  } catch (error) {
    console.error("[auth] getSessionUser failed", error instanceof Error ? error.message : error);
    return null;
  }
});

export const getAdminIdentity = cache(async (): Promise<AdminIdentity | null> => {
  if (!isSupabaseConfigured) return null;
  try {
    const supabase = await createSessionSupabase();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    const { data: profile, error: profileError } = await supabase.from("customers").select("is_admin").eq("id", data.user.id).maybeSingle();
    if (profileError) {
      logDbError("auth.getAdminIdentity", profileError, "02_customers_and_auth.sql");
      return null;
    }
    if (profile?.is_admin !== true) return null;
    return { id: data.user.id, email: data.user.email ?? "" };
  } catch (error) {
    console.error("[auth] getAdminIdentity failed", error instanceof Error ? error.message : error);
    return null;
  }
});

/** Admin pages/layouts: redirect to /admin/signin?redirect=… unless the viewer is an admin. */
export async function requireAdmin(redirectTo = "/admin"): Promise<AdminIdentity> {
  const admin = await getAdminIdentity();
  if (!admin) redirect(`/admin/signin?redirect=${encodeURIComponent(safeNext(redirectTo, "/admin"))}`);
  return admin;
}

/** Account pages: redirect to /signin?next=… unless someone is signed in. */
export async function requireUser(redirectTo: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(`/signin?next=${encodeURIComponent(safeNext(redirectTo, "/customer/dashboard"))}`);
  return user;
}
