"use client";

import { CreditCard } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { formatLKRExact } from "@/lib/format";
import type { CardPaymentAttempt } from "@/lib/orders";

type StartResponse = { ok?: boolean; action?: string; fields?: Record<string, string>; error?: string; code?: string | null };

/** Answers that mean the page is out of date (paid / cancelled meanwhile): show the latest state. */
const STALE_CODES = new Set(["already_paid", "order_cancelled", "payment_not_due", "not_card_order"]);

/**
 * The order page's card payment (49_card_payments.sql, lib/payments/webxpay.ts): "Pay now" asks
 * POST /api/payments/webxpay/start for a fresh attempt and the WebXPay form, then submits that form
 * from THIS page — the only page whose CSP lets a form leave the site (next.config.ts). WebXPay
 * sends the shopper back through /api/payments/webxpay/webhook to this page, which then shows the
 * outcome: paid, or the decline with "Try again".
 *
 * `autoStart` (the checkout's `pay=1`): start at once, after dropping the flag from the URL so Back
 * from WebXPay returns here without starting again.
 */
export function CardPaymentPanel({
  orderId,
  token,
  amount,
  attempt,
  ready,
  autoStart,
}: {
  orderId: string;
  token: string;
  /** LKR — the order total WebXPay will be asked for. */
  amount: number;
  /** The latest WebXPay attempt (view_order), or null before the first. */
  attempt: CardPaymentAttempt | null;
  /** The store can take card payments right now (owner's switch + server keys). */
  ready: boolean;
  autoStart: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "starting" | "leaving">("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const autoStarted = useRef(false);

  async function start() {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setState("starting");
    let payload: StartResponse | null = null;
    try {
      const response = await fetch("/api/payments/webxpay/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ orderId, token }),
      });
      payload = (await response.json().catch(() => null)) as StartResponse | null;
    } catch {
      payload = null;
    }

    let action: URL | null = null;
    try {
      action = payload?.ok && payload.action ? new URL(payload.action) : null;
    } catch {
      action = null;
    }
    if (!payload?.ok || !action || action.protocol !== "https:" || !payload.fields) {
      busy.current = false;
      setState("idle");
      setError(payload?.error ?? "We couldn't open the card payment. Check your connection and try again.");
      if (payload?.code && STALE_CODES.has(payload.code)) router.refresh();
      return;
    }

    setState("leaving");
    const form = document.createElement("form");
    form.method = "POST";
    form.action = action.toString();
    form.acceptCharset = "UTF-8";
    form.hidden = true;
    for (const [name, value] of Object.entries(payload.fields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  }

  // Back from WebXPay can restore this page from the back/forward cache mid-"leaving": reset it.
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      busy.current = false;
      setState("idle");
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete("pay");
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    // From a callback, not the effect body: start() sets state as it goes.
    if (ready) queueMicrotask(() => void start());
    // once, on mount (the checkout's hand-off)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const declined = attempt?.status === "declined";
  const review = attempt?.status === "review";

  return (
    <div className="space-y-4">
      {review ? (
        <Notice tone="info" title="We're checking your payment">
          WebXPay told us about a payment for this order that our team needs to check. We&apos;ll be in touch — please don&apos;t pay again in the meantime.
        </Notice>
      ) : declined ? (
        <Notice tone="error" title="Your payment didn't go through">
          {attempt?.message ? <>WebXPay said: &ldquo;{attempt.message}&rdquo;. </> : null}
          Your order is saved — you can try again with the same card or another one.
        </Notice>
      ) : null}

      <div className="flex items-start gap-3 border border-ink bg-surface p-5">
        <span aria-hidden className="grid size-9 shrink-0 place-items-center bg-ink text-lime">
          <CreditCard className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{review ? "Card payment being checked" : declined ? "Try your card payment again" : "Complete your card payment"}</p>
          <p className="mt-1 text-sm text-ink-2">
            {review ? (
              <>
                Order total <span className="font-mono font-semibold text-ink">{formatLKRExact(amount)}</span>. We&apos;ll confirm your order once we&apos;ve checked the payment.
              </>
            ) : (
              <>
                Pay <span className="font-mono font-semibold text-ink">{formatLKRExact(amount)}</span> on WebXPay&apos;s payment page. Your order is confirmed as soon as the payment
                goes through, and we&apos;ll email you the confirmation.
              </>
            )}
          </p>
          {review ? null : ready ? (
            <Button type="button" className="mt-4" onClick={() => void start()} disabled={state !== "idle"} aria-busy={state !== "idle" || undefined}>
              {state === "starting" ? "Opening the payment…" : state === "leaving" ? "Taking you to WebXPay…" : declined ? "Try again" : "Pay now"}
            </Button>
          ) : (
            <p className="mt-3 text-sm text-ink-2">Card payment isn&apos;t available right now. Please contact us to complete this order.</p>
          )}
          {error && (
            <Notice tone="error" className="mt-4">
              {error}
            </Notice>
          )}
        </div>
      </div>
    </div>
  );
}
