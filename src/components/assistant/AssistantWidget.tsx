"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
// Imported on every storefront page on purpose (wave-A contract, WP-A): lib/viewed registers the
// `dockone:signed-out` listener that clears the browse trail the assistant reads.
import "@/lib/viewed";
import { SIGNED_OUT_EVENT } from "@/lib/viewer";
import { AssistantNudge } from "./AssistantNudge";
import { addLocalMessage, resetConversation, sendMessage, trackAssistantOpen, useAssistantChat } from "./useAssistantChat";
import { useAssistantNudges } from "./useAssistantNudges";

/**
 * The AI shopping assistant — "the Dock One tech desk" (blueprint §10, BUILD_SPEC §1 persona).
 * Mounted once by src/app/(store)/layout.tsx on every storefront page. This module stays small:
 * the launcher, the nudge teaser and the sign-out listener. The panel (conversation, display zone,
 * photo input, order form) is split into its own chunk and loaded the first time it's opened.
 *
 * - Hidden on /admin, /launching-soon, /signin, /register, /auth, /reset-password,
 *   /forgot-password and /recover (blueprint §10.14 + the store's auth pages).
 * - Sign-out (`dockone:signed-out`, dispatched by AuthListener): the transcript is cleared, the
 *   session id rotated and any parked offer code dropped — the next person on a shared device
 *   inherits nothing (blueprint §9.13).
 * - Opening it fires `assistant_open` (analytics, consent-gated inside track()).
 * - The first open shows a LOCAL greeting with three starter chips (no model call).
 */

const AssistantPanel = dynamic(() => import("./AssistantPanel"), { ssr: false });
const loadPanel = () => void import("./AssistantPanel");

const HIDDEN_PREFIXES = ["/admin", "/launching-soon", "/signin", "/register", "/auth", "/reset-password", "/forgot-password", "/recover"];

function isHiddenPath(pathname: string): boolean {
  return HIDDEN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

const GREETING = "Hi, this is the Dock One tech desk. Ask me about specs, compatibility, stock or offers — or tell me what you need and I'll help you choose.";
const STARTERS = ["Help me choose", "Any offers right now?", "Where's my order?"];

export function AssistantWidget() {
  const pathname = usePathname() ?? "/";
  const hidden = isHiddenPath(pathname);
  const [open, setOpen] = useState(false);
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const { conversation } = useAssistantChat();

  // Per-person state follows the account: sign-out wipes the conversation and parked code.
  useEffect(() => {
    const onSignedOut = () => {
      resetConversation();
      setOpen(false);
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  // Quiet once the panel has been opened on this page view.
  const nudges = useAssistantNudges({ enabled: !hidden && !open && openedOn !== pathname, pathname });

  if (hidden) return null;

  const openPanel = (seed?: { opener: string; chips: readonly string[] } | null, chip?: string) => {
    if (seed) addLocalMessage(seed.opener, seed.chips);
    else if (conversation.messages.length === 0) addLocalMessage(GREETING, STARTERS);
    setOpen(true);
    setOpenedOn(pathname);
    trackAssistantOpen();
    if (chip) sendMessage(chip);
  };

  const closePanel = () => {
    setOpen(false);
    window.setTimeout(() => launcherRef.current?.focus(), 0);
  };

  return (
    <>
      {!open && (
        <button
          ref={launcherRef}
          type="button"
          onClick={() => openPanel()}
          onPointerEnter={loadPanel}
          onFocus={loadPanel}
          onTouchStart={loadPanel}
          aria-haspopup="dialog"
          aria-label="Ask the tech desk"
          className="group fixed right-4 bottom-4 z-[60] flex h-14 items-stretch border border-ink bg-ink text-paper shadow-[4px_4px_0_0_var(--color-violet)] transition-transform duration-150 ease-brut hover:-translate-y-0.5 active:translate-y-px sm:right-6 sm:bottom-6"
        >
          <span aria-hidden className="grid w-14 place-items-center bg-lime font-mono text-base font-bold text-ink">
            &gt;_
          </span>
          <span aria-hidden className="label hidden items-center px-4 font-semibold sm:flex">
            Ask the tech desk
          </span>
        </button>
      )}
      {!open && nudges.nudge && (
        <AssistantNudge
          nudge={nudges.nudge}
          onDismiss={nudges.dismiss}
          onAccept={(chip) => {
            const accepted = nudges.accept();
            openPanel(accepted, chip);
          }}
        />
      )}
      {open && <AssistantPanel onClose={closePanel} />}
    </>
  );
}
