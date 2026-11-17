"use client";

import { Bell, Check } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

/**
 * "Notify me" for an out-of-stock option (50_product_availability · POST /api/stock-alert): the
 * shopper leaves an email; the shop emails everyone waiting from the admin once it is back. The
 * hidden `company` field is the honeypot the route checks.
 */
export function NotifyMe({ variantId, productName, optionName }: { variantId: number; productName: string; optionName: string | null }) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "sending" } | { kind: "done" } | { kind: "error"; message: string }>({ kind: "idle" });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.kind === "sending") return;
    const company = new FormData(event.currentTarget).get("company");
    setState({ kind: "sending" });
    try {
      const response = await fetch("/api/stock-alert", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variantId, email: email.trim(), company }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (response.ok && body?.ok) setState({ kind: "done" });
      else setState({ kind: "error", message: body?.error ?? "We couldn't save that just now. Please try again." });
    } catch {
      setState({ kind: "error", message: "You seem to be offline. Please try again." });
    }
  }

  if (state.kind === "done") {
    return (
      <p role="status" className="mt-4 flex items-start gap-2 border border-line bg-surface px-3 py-2.5 text-sm">
        <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-violet-ink" />
        <span>We&apos;ll email {email.trim()} when {optionName ? `${productName} (${optionName})` : productName} is back.</span>
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-4 border border-line bg-surface p-3" aria-describedby={`${id}-hint`}>
      <p id={`${id}-hint`} className="flex items-center gap-2 text-sm font-medium">
        <Bell aria-hidden className="size-4 text-violet-ink" />
        Get an email when it&apos;s back in stock
      </p>
      <div className="mt-2.5 flex gap-2">
        <label htmlFor={`${id}-email`} className="sr-only">
          Your email address
        </label>
        <input
          id={`${id}-email`}
          type="email"
          required
          autoComplete="email"
          inputMode="email"
          maxLength={254}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          className="h-11 min-w-0 flex-1 border border-line bg-surface px-3 text-sm outline-none placeholder:font-mono placeholder:text-mute focus:border-ink"
        />
        <input type="text" name="company" tabIndex={-1} autoComplete="off" aria-hidden className="hidden" />
        <button
          type="submit"
          disabled={state.kind === "sending"}
          className="label h-11 shrink-0 bg-ink px-4 font-semibold text-paper transition-colors hover:bg-violet disabled:opacity-50"
        >
          {state.kind === "sending" ? "Saving…" : "Notify me"}
        </button>
      </div>
      {state.kind === "error" && (
        <p role="alert" className="mt-2 text-[13px] text-ink-2">
          {state.message}
        </p>
      )}
    </form>
  );
}
