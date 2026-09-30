"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { closeConsentSettings, setConsent, type ConsentChoice } from "@/lib/analytics";
import { useConsent } from "./useConsent";

/**
 * The storage/analytics consent banner (blueprint §12.1.7). Mounted once in
 * src/app/(store)/layout.tsx; renders nothing on the server or during hydration.
 *
 * - Essential storage (basket, display currency, sign-in session) is always on — the store needs
 *   it. Analytics events (page and product views, searches, basket and checkout steps) are sent
 *   only after "Allow analytics"; "Essential only" keeps them off. The choice is remembered in
 *   localStorage `dockone.consent.v1` and can be changed any time from the footer's
 *   "Cookie settings" (openConsentSettings() in lib/analytics.ts).
 * - It is placed FIRST in the document (a portal at the start of <body>), so keyboard and
 *   screen-reader users meet it before the page, while it sits at the bottom of the screen.
 *   Non-modal: the page stays usable. Reopened from the footer it takes focus, Escape closes it,
 *   and focus returns to the button that opened it.
 */

const CHOICE_LABEL: Record<ConsentChoice, string> = {
  analytics: "Analytics allowed",
  essential: "Essential only",
};

export function ConsentBanner() {
  const { ready, choice, settingsOpen } = useConsent();
  const visible = ready && (choice === null || settingsOpen);
  // The portal container: a detached <div> (none on the server), attached at the very start of
  // <body> only while the banner shows.
  const [host] = useState<HTMLElement | null>(() => (typeof document === "undefined" ? null : document.createElement("div")));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!visible || !host) return;
    host.setAttribute("data-consent-banner", "");
    document.body.prepend(host);
    return () => host.remove();
  }, [visible, host]);

  // Reopened from "Cookie settings": remember who opened it, move focus in; give it back after.
  useLayoutEffect(() => {
    if (!settingsOpen || !visible || !host) return;
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
    headingRef.current?.focus();
    return () => {
      const target = returnFocusRef.current;
      returnFocusRef.current = null;
      if (target && target.isConnected) target.focus();
    };
  }, [settingsOpen, visible, host]);

  useEffect(() => {
    if (!settingsOpen || choice === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeConsentSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [settingsOpen, choice]);

  if (!visible || !host) return null;

  const reopened = settingsOpen && choice !== null;

  return createPortal(
    <section
      aria-labelledby="consent-title"
      aria-describedby="consent-text"
      className="fixed inset-x-3 bottom-3 z-[60] flex max-h-[calc(100dvh-1.5rem)] items-stretch overflow-y-auto bg-ink text-paper shadow-[6px_6px_0_0_var(--color-violet)] sm:inset-x-auto sm:bottom-6 sm:left-6 sm:w-[460px]"
    >
      <span aria-hidden className="label hidden w-10 shrink-0 place-items-start justify-center bg-lime pt-4 font-bold text-ink sm:grid">
        &gt;_
      </span>
      <div className="min-w-0 flex-1 p-4 sm:p-5">
        <h2 id="consent-title" ref={headingRef} tabIndex={-1} className="label font-semibold text-lime outline-none">
          Cookies &amp; storage
        </h2>
        <p id="consent-text" className="mt-2 text-sm leading-6 text-paper/90">
          Your basket, display currency and sign-in session are kept in this browser because the store needs them to work. With your permission we
          also record page views, searches and basket steps in our own database to improve the store.
        </p>

        <details className="group mt-3 border-t border-night-line pt-3" open={reopened || undefined}>
          <summary className="label flex min-h-10 cursor-pointer list-none items-center gap-2 font-semibold text-paper hover:text-lime [&::-webkit-details-marker]:hidden">
            <span aria-hidden className="inline-block transition-transform duration-150 group-open:rotate-90">
              ›
            </span>
            What is stored
          </summary>
          <dl className="mt-2 space-y-3 text-sm leading-6">
            <div>
              <dt className="label font-semibold text-paper">Essential · always on</dt>
              <dd className="text-night-mute">Basket, display currency and your sign-in session.</dd>
            </div>
            <div>
              <dt className="label font-semibold text-paper">Analytics · optional</dt>
              <dd className="text-night-mute">
                Pages, products, categories and collections you view, searches, basket and checkout steps, saves to your wishlist, and when you finish the
                product finder, open the assistant or join the newsletter — with a random session id, linked to your account only while you are signed in.
              </dd>
            </div>
          </dl>
        </details>

        {reopened && (
          <p className="label mt-3 text-night-mute">
            Current choice: <span className="text-paper">{CHOICE_LABEL[choice]}</span>
          </p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setConsent("analytics")}
            aria-pressed={reopened ? choice === "analytics" : undefined}
            className="label min-h-11 bg-lime px-3 font-semibold text-ink transition-colors duration-150 hover:bg-paper focus-visible:outline-offset-2"
          >
            Allow analytics
          </button>
          <button
            type="button"
            onClick={() => setConsent("essential")}
            aria-pressed={reopened ? choice === "essential" : undefined}
            className="label min-h-11 bg-paper px-3 font-semibold text-ink transition-colors duration-150 hover:bg-lime focus-visible:outline-offset-2"
          >
            Essential only
          </button>
        </div>
        <p className="mt-3 text-xs text-night-mute">
          <Link href="/privacy" className="inline-flex min-h-10 items-center underline underline-offset-2 hover:text-lime">
            Privacy policy
          </Link>
        </p>
      </div>
      {reopened && (
        <button
          type="button"
          onClick={closeConsentSettings}
          aria-label="Close cookie settings"
          className="grid w-11 shrink-0 place-items-start justify-center border-l border-night-line pt-3 hover:bg-night-2"
        >
          <X aria-hidden className="size-4" />
        </button>
      )}
    </section>,
    host,
  );
}
