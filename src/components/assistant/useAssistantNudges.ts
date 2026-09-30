"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCart } from "@/lib/cart";
import { formatLKR } from "@/lib/format";
import { getViewedProductIds } from "@/lib/viewed";

/**
 * Proactive nudges (blueprint §10.14) — pure client observation: no request until the shopper
 * opens the chat, and accepting a nudge costs no model call (each carries a canned opener + chips).
 *
 *   rule            trigger                                   delay
 *   checkout        on /checkout                              25 s
 *   cant_decide     ≥ 5 product pages viewed this session      4 s
 *   free_delivery   bag > 0 and below the free-delivery line  40 s
 *   idle_browsing   on /shop with an empty bag                60 s
 *
 * Caps (these ARE the feature): one nudge at a time; 3 min between nudges; each rule once per
 * session; a dismissal silences that rule for 24 h; nothing in the first 20 s of a session; the
 * teaser lives 12 s; quiet once the panel has been opened on this page view.
 *
 * Bookkeeping is browser-only (blueprint §12.2): sessionStorage for the session's history,
 * localStorage for 24 h dismissals. Every storage access is guarded.
 */

export type NudgeRule = "checkout" | "cant_decide" | "free_delivery" | "idle_browsing";

export type Nudge = {
  rule: NudgeRule;
  /** Canned opener (LKR amounts via formatLKR — the teaser renders the amount through <Price>). */
  opener: string;
  chips: string[];
  /** free_delivery: LKR still needed. */
  amount?: number;
};

const SESSION_KEY = "dockone.assistant.nudges.v1";
const DISMISS_KEY = "dockone.assistant.nudge-off.v1";
const FIRST_QUIET_MS = 20_000;
const GAP_MS = 3 * 60_000;
export const TEASER_MS = 12_000;
const DISMISS_MS = 24 * 60 * 60_000;
const CANT_DECIDE_VIEWS = 5;

const DELAYS: Record<NudgeRule, number> = { checkout: 25_000, cant_decide: 4_000, free_delivery: 40_000, idle_browsing: 60_000 };

type SessionBook = { start: number; shown: NudgeRule[]; last: number };

function readSession(): SessionBook {
  const fresh: SessionBook = { start: Date.now(), shown: [], last: 0 };
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SessionBook>;
      if (typeof parsed.start === "number") {
        return {
          start: parsed.start,
          shown: Array.isArray(parsed.shown) ? (parsed.shown.filter((r) => typeof r === "string") as NudgeRule[]) : [],
          last: typeof parsed.last === "number" ? parsed.last : 0,
        };
      }
    }
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(fresh));
  } catch {
    // storage blocked: the caps still hold for this page view
  }
  return fresh;
}

function writeSession(book: SessionBook) {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(book));
  } catch {
    // ignore
  }
}

function dismissedRecently(rule: NudgeRule): boolean {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    const at = map[rule];
    return typeof at === "number" && Date.now() - at < DISMISS_MS;
  } catch {
    return false;
  }
}

function rememberDismissal(rule: NudgeRule) {
  try {
    const raw = window.localStorage.getItem(DISMISS_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    map[rule] = Date.now();
    window.localStorage.setItem(DISMISS_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

function nudgeFor(rule: NudgeRule, amount: number | null): Nudge {
  switch (rule) {
    case "checkout":
      return {
        rule,
        opener: "Any questions before you place your order? I can help with delivery, payment or anything about your items.",
        chips: ["How does delivery work?", "What payment options are there?", "Any offers right now?"],
      };
    case "cant_decide":
      return {
        rule,
        opener: "Comparing a few? Tell me what matters most and I'll help you narrow it down.",
        chips: ["Compare what I've looked at", "Help me choose", "Which is the best value?"],
      };
    case "free_delivery":
      return {
        rule,
        opener: amount !== null ? `You're ${formatLKR(amount)} away from free delivery. Want a suggestion that fits?` : "Want a suggestion for your basket?",
        chips: ["Suggest something to add", "What goes with my basket?"],
        ...(amount !== null ? { amount } : {}),
      };
    case "idle_browsing":
      return {
        rule,
        opener: "Looking for something specific? Tell me what it's for and I'll point you to the right one.",
        chips: ["Help me choose", "What's new?", "Any offers right now?"],
      };
  }
}

export type NudgeState = {
  nudge: Nudge | null;
  /** The shopper closed the teaser: silence this rule for 24 h. */
  dismiss: () => void;
  /** The shopper accepted: returns the nudge (to seed the panel) and hides the teaser. */
  accept: () => Nudge | null;
};

type Shown = Nudge & { pathname: string; at: number };

export function useAssistantNudges({ enabled, pathname }: { enabled: boolean; pathname: string }): NudgeState {
  const { count, toFreeDelivery } = useCart();
  const [shown, setShown] = useState<Shown | null>(null);
  // A teaser belongs to the page it appeared on, and hides while the widget is quiet.
  const visible = enabled && shown && shown.pathname === pathname ? shown : null;
  const visibleRef = useRef<Shown | null>(null);
  useEffect(() => {
    visibleRef.current = visible;
  });

  const onCheckout = pathname === "/checkout" || pathname.startsWith("/checkout/");
  const onProduct = pathname.startsWith("/product/");
  const onShop = pathname === "/shop";
  const belowFree = count > 0 && toFreeDelivery !== null && toFreeDelivery > 0;

  // Start the session clock on the first page view (so "the first 20 s" is measured from here).
  useEffect(() => {
    readSession();
  }, []);

  // Schedule the rules whose trigger holds; the first to fire (and pass the caps) wins.
  useEffect(() => {
    if (!enabled) return;
    const candidates: NudgeRule[] = [];
    if (onCheckout) candidates.push("checkout");
    if (onProduct) candidates.push("cant_decide");
    if (belowFree) candidates.push("free_delivery");
    if (onShop && count === 0) candidates.push("idle_browsing");
    if (candidates.length === 0) return;

    const timers = candidates.map((rule) =>
      window.setTimeout(() => {
        if (visibleRef.current) return; // one at a time
        if (rule === "cant_decide" && getViewedProductIds().length < CANT_DECIDE_VIEWS) return;
        const book = readSession();
        const now = Date.now();
        if (now - book.start < FIRST_QUIET_MS) return; // nothing in the first 20 s of a session
        if (book.last && now - book.last < GAP_MS) return; // 3 min between nudges
        if (book.shown.includes(rule)) return; // each rule once per session
        if (dismissedRecently(rule)) return; // a dismissal silences the rule for 24 h
        writeSession({ ...book, shown: [...book.shown, rule], last: now });
        setShown({ ...nudgeFor(rule, rule === "free_delivery" ? toFreeDelivery : null), pathname, at: now });
      }, DELAYS[rule]),
    );
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [enabled, onCheckout, onProduct, onShop, belowFree, count, toFreeDelivery, pathname]);

  // The teaser lives 12 s.
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown((current) => (current === shown ? null : current)), Math.max(0, shown.at + TEASER_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [shown]);

  const dismiss = useCallback(() => {
    const current = visibleRef.current;
    if (current) rememberDismissal(current.rule);
    setShown(null);
  }, []);

  const accept = useCallback((): Nudge | null => {
    const current = visibleRef.current;
    setShown(null);
    if (!current) return null;
    const { rule, opener, chips, amount } = current;
    return { rule, opener, chips, ...(amount !== undefined ? { amount } : {}) };
  }, []);

  const nudge = useMemo<Nudge | null>(
    () => (visible ? { rule: visible.rule, opener: visible.opener, chips: visible.chips, ...(visible.amount !== undefined ? { amount: visible.amount } : {}) } : null),
    [visible],
  );
  return { nudge, dismiss, accept };
}
