"use client";

import type { CacheTag } from "@/lib/cache-tags";

export type RevalidateResult = { ok: true; revalidated: CacheTag[] } | { ok: false; error: string };

/**
 * Admin helper: call AFTER a confirmed write (`{ error }` checked and the affected row count
 * verified) so the storefront shows the change on the next request. Never throws — a failed
 * refresh is reported, and the time-based revalidate (5 min) is the safety net.
 *
 *   const { error, data } = await supabase.from("products").update(patch).eq("id", id).select("id");
 *   if (!error && data?.length) await revalidateStorefront(["catalogue"]);
 */
export async function revalidateStorefront(tags: CacheTag[]): Promise<RevalidateResult> {
  try {
    const response = await fetch("/api/admin/revalidate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ tags }),
    });
    const body = (await response.json().catch(() => null)) as { revalidated?: CacheTag[]; error?: string } | null;
    if (!response.ok) return { ok: false, error: body?.error ?? `Refresh failed (${response.status}).` };
    return { ok: true, revalidated: body?.revalidated ?? tags };
  } catch {
    return { ok: false, error: "Couldn't reach the server to refresh the storefront." };
  }
}
