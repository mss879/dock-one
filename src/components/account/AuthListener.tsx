"use client";

import { useEffect } from "react";
import { resetFinderSession } from "@/components/finder/session";
import { resetCheckoutCartId } from "@/lib/checkout-autosave";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { refreshViewer, SIGNED_OUT_EVENT } from "@/lib/viewer";
import { wishlist } from "@/lib/wishlist";

/**
 * Per-person client state follows the auth session (blueprint §9.13, BUILD_SPEC §5):
 * - signed in (a new sign-in, or a page load with a session): fold the local wishlist into the
 *   account (merge_wishlist) and re-read the viewer;
 * - signed out: forget the wishlist copies, the checkout draft id and the finder session, then dispatch
 *   `dockone:signed-out` so other per-person state (the assistant transcript, WP-I) clears too —
 *   on a shared phone the next person must not see any of it.
 *
 * Mounted once by src/app/(store)/layout.tsx. Every auth call is guarded: a broken or missing
 * auth client must never take a page down (blueprint §14 lesson 30).
 */
export function AuthListener() {
  useEffect(() => {
    const supabase = getBrowserSupabase();
    if (!supabase) return;

    let lastUserId: string | null = null;
    const signedIn = (userId: string, freshSignIn: boolean) => {
      void wishlist.syncAccount(userId);
      if (freshSignIn) void refreshViewer();
    };
    const signedOut = () => {
      lastUserId = null;
      try {
        wishlist.resetForSignOut();
      } catch (error) {
        console.error("[auth] clearing the wishlist failed", error);
      }
      try {
        resetCheckoutCartId();
      } catch (error) {
        console.error("[auth] resetting the checkout draft id failed", error);
      }
      try {
        // Always here, not only while /discover is mounted: the next person's finder answers must
        // never land on the previous person's row (which is linked to their account).
        resetFinderSession();
      } catch (error) {
        console.error("[auth] resetting the finder session failed", error);
      }
      try {
        window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
      } catch (error) {
        console.error("[auth] signed-out event failed", error);
      }
    };

    let unsubscribe: (() => void) | null = null;
    try {
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        // Never await Supabase calls inside the auth callback (it holds the auth lock): defer.
        const userId = session?.user?.id ?? null;
        if (event === "SIGNED_OUT") {
          window.setTimeout(signedOut, 0);
          return;
        }
        if (!userId || (event !== "INITIAL_SESSION" && event !== "SIGNED_IN")) return;
        // SIGNED_IN also fires when a tab regains focus: only a new account is a fresh sign-in.
        const fresh = event === "SIGNED_IN" && userId !== lastUserId;
        if (event === "SIGNED_IN" && !fresh) return;
        lastUserId = userId;
        window.setTimeout(() => signedIn(userId, fresh), 0);
      });
      unsubscribe = () => data.subscription.unsubscribe();
    } catch (error) {
      console.error("[auth] auth listener unavailable", error);
    }

    return () => {
      try {
        unsubscribe?.();
      } catch {
        // already unsubscribed
      }
    };
  }, []);

  return null;
}
