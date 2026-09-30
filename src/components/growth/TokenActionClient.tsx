"use client";

import { useRef, useState } from "react";
import { BracketLink, Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { Notice } from "@/components/ui/Notice";

type Props = {
  /** The POST that performs the change (the email link only ever opens this page — blueprint §6.6). */
  endpoint: "/api/newsletter/unsubscribe" | "/api/cart-recovery/unsubscribe";
  token: string;
  question: string;
  detail: string;
  confirmLabel: string;
  /** The "no thanks" link back to the store. */
  cancelLabel: string;
  doneTitle: string;
  doneBody: string;
};

type State = { kind: "idle" } | { kind: "busy" } | { kind: "done" } | { kind: "error"; message: string };

const SLOW_DOWN = "Too many attempts from this connection. Please wait a few minutes and try again.";
const FAILED = "That didn't go through. Please try again in a moment.";

/**
 * Confirm-then-POST for links in emails that change state (blueprint §6.6, lesson 11): mail
 * scanners "click" GET links, so the page only ASKS; the change happens when a person presses the
 * button. Every token gets the same answer from the server (P14), so "done" says the same thing
 * for all of them.
 */
export function TokenActionClient({ endpoint, token, question, detail, confirmLabel, cancelLabel, doneTitle, doneBody }: Props) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const doneRef = useRef<HTMLDivElement>(null);

  async function confirm() {
    if (state.kind === "busy" || state.kind === "done") return;
    setState({ kind: "busy" });
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ token }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (response.ok && payload?.ok) {
        setState({ kind: "done" });
        window.requestAnimationFrame(() => doneRef.current?.focus());
        return;
      }
      setState({ kind: "error", message: response.status === 429 ? SLOW_DOWN : (payload?.error ?? FAILED) });
    } catch {
      setState({ kind: "error", message: FAILED });
    }
  }

  if (state.kind === "done") {
    return (
      <div ref={doneRef} tabIndex={-1} className="max-w-xl space-y-6 outline-none">
        <Notice tone="success" title={doneTitle}>
          {doneBody}
        </Notice>
        <Button href="/shop">Back to the shop</Button>
      </div>
    );
  }

  const busy = state.kind === "busy";
  return (
    <section aria-labelledby="token-action-question" className="relative max-w-xl border border-ink bg-surface p-5 sm:p-6">
      <Cross className="-top-[6px] -left-[6px]" />
      <Cross className="-right-[6px] -bottom-[6px]" />
      <h2 id="token-action-question" className="display text-3xl">
        {question}
      </h2>
      <p className="mt-3 text-[15px] text-ink-2">{detail}</p>
      {state.kind === "error" && (
        <Notice tone="error" className="mt-5">
          {state.message}
        </Notice>
      )}
      <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3">
        <Button type="button" onClick={confirm} disabled={busy} aria-busy={busy || undefined}>
          {busy ? "One moment…" : confirmLabel}
        </Button>
        <BracketLink href="/">{cancelLabel}</BracketLink>
      </div>
    </section>
  );
}
