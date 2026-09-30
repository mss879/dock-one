"use client";

import { getBrowserSupabase } from "@/lib/supabase/browser";
import { toast } from "@/lib/toast";

/** Pages that show one person's details: after signing out, leave them for the homepage. */
const PRIVATE_AREAS = ["/customer", "/checkout", "/reset-password"];

export function isPrivatePath(pathname: string): boolean {
  return PRIVATE_AREAS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * Sign out on THIS device (scope "local", like the admin). AuthListener then clears the
 * per-person client state and dispatches `dockone:signed-out`. Returns false (and says so)
 * when the auth service couldn't be reached — the session is still there in that case.
 */
export async function signOutHere(): Promise<boolean> {
  const supabase = getBrowserSupabase();
  if (!supabase) return true;
  try {
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (!error) return true;
    console.error("[auth] sign-out failed", error.code ?? error.status, error.message);
  } catch (error) {
    console.error("[auth] sign-out failed", error instanceof Error ? error.message : error);
  }
  toast({ title: "Couldn't sign you out", description: "Check your connection and try again." });
  return false;
}
