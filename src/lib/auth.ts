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

export type AdminIdentity = {
  id: string;
  email: string;
  /** "admin" = the owner (everything); "staff" = only `permissions` (39_staff_accounts). */
  role: "admin" | "staff";
  name: string;
  permissions: Record<string, "view" | "edit">;
};
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
    const email = data.user.email ?? "";
    // 39: admins AND active staff, with their sections. Before 39 is applied the function is
    // missing (PGRST202 / 42883): fall back to the owner flag so the owner is never locked out.
    const { data: access, error: accessError } = await supabase.rpc("my_admin_access");
    if (!accessError) {
      const row = access && typeof access === "object" ? (access as Record<string, unknown>) : null;
      const role = row?.role === "admin" || row?.role === "staff" ? row.role : null;
      if (!role) return null;
      const raw = row?.permissions && typeof row.permissions === "object" ? (row.permissions as Record<string, unknown>) : {};
      const permissions: AdminIdentity["permissions"] = {};
      for (const [area, level] of Object.entries(raw)) if (level === "view" || level === "edit") permissions[area] = level;
      return { id: data.user.id, email, role, name: typeof row?.name === "string" ? row.name : email, permissions };
    }
    if (accessError.code !== "PGRST202" && accessError.code !== "42883") {
      logDbError("auth.getAdminIdentity", accessError, "39_staff_accounts.sql");
      return null;
    }
    const { data: profile, error: profileError } = await supabase.from("customers").select("is_admin").eq("id", data.user.id).maybeSingle();
    if (profileError) {
      logDbError("auth.getAdminIdentity", profileError, "02_customers_and_auth.sql");
      return null;
    }
    if (profile?.is_admin !== true) return null;
    return { id: data.user.id, email, role: "admin", name: email, permissions: {} };
  } catch (error) {
    console.error("[auth] getAdminIdentity failed", error instanceof Error ? error.message : error);
    return null;
  }
});

/** Server routes: may this admin / staff identity use `area` at `level`? (the database re-checks) */
export function identityCan(identity: AdminIdentity, area: string, level: "view" | "edit" = "edit"): boolean {
  if (identity.role === "admin") return true;
  const have = identity.permissions[area];
  return level === "view" ? have === "view" || have === "edit" : have === "edit";
}

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
