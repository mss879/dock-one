"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { resetAnalyticsSession, track } from "@/lib/analytics";
import { SIGNED_OUT_EVENT } from "@/lib/viewer";
import { useConsent } from "./useConsent";

/**
 * `page_view` on every storefront route change (blueprint §12.3), mounted once in
 * src/app/(store)/layout.tsx. Path only — track() and /api/events never send the query string.
 *
 * Nothing is sent before the shopper allows analytics; when they allow it, the page they are on
 * counts as the first view. One view per path change (re-renders and dev double-effects don't
 * repeat it). On sign-out (`dockone:signed-out`, §9.13) the analytics session rotates, so later
 * events can't be tied to the account that was signed in.
 */
export function PageViewTracker() {
  const pathname = usePathname();
  const { ready, choice } = useConsent();
  const allowed = ready && choice === "analytics";
  const lastTracked = useRef<string | null>(null);

  useEffect(() => {
    if (!allowed || !pathname || lastTracked.current === pathname) return;
    lastTracked.current = pathname;
    track("page_view");
  }, [allowed, pathname]);

  useEffect(() => {
    const onSignedOut = () => resetAnalyticsSession();
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  return null;
}
