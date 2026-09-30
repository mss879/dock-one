"use client";

import { ArrowUpRight, Check } from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { NEWSLETTER_COPY, type NewsletterSource } from "@/components/growth/newsletter-shared";
import { track } from "@/lib/analytics";

/** = isEmailAddress() in lib/request-guard.ts (the route re-checks). */
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const SLOW_DOWN = "Too many signups from this connection. Please try again later.";

/**
 * Newsletter signup (blueprint §9.11) → POST /api/newsletter { email, source } →
 * subscribe_newsletter(). `source` tags the capture point (home, footer…).
 *
 * The thank-you appears only after the server stored the address (lesson 39: the old form
 * discarded it and thanked the shopper anyway); on failure the typed address stays in the field.
 * The copy says only what is true — nothing is emailed on signup, so it never says "check your
 * inbox". The hidden `company` field is the honeypot.
 */
export function NewsletterForm({ source = "home" }: { source?: NewsletterSource }) {
  const uid = useId().replace(/:/g, "");
  const inputId = `newsletter-email-${uid}`;
  const errorId = `newsletter-error-${uid}`;
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const honeypot = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const address = email.trim();
    if (address.length > 254 || !EMAIL_PATTERN.test(address)) {
      setError("Enter a valid email address, like name@example.com.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/newsletter", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ email: address, source, company: honeypot.current?.value ?? "" }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (response.ok && payload?.ok) {
        setDone(true);
        track("newsletter_signup", { metadata: { source } });
        return;
      }
      setError(response.status === 429 ? SLOW_DOWN : (payload?.error ?? NEWSLETTER_COPY.failed));
    } catch {
      setError(NEWSLETTER_COPY.failed);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p role="status" className="label flex h-12 items-center gap-2.5 bg-lime px-4 font-bold text-ink">
        <Check aria-hidden className="size-4" /> Signal locked — you&apos;re subscribed
      </p>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <div aria-hidden className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor={`newsletter-company-${uid}`}>Company</label>
        <input ref={honeypot} id={`newsletter-company-${uid}`} name="company" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>
      <label htmlFor={inputId} className="sr-only">
        Email address
      </label>
      <div className="flex h-12 items-stretch">
        <input
          id={inputId}
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setError("");
          }}
          placeholder="ENTER EMAIL"
          autoComplete="email"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          className={`min-w-0 flex-1 border border-r-0 bg-surface px-4 font-mono text-[13px] outline-none placeholder:text-mute focus:border-ink ${error ? "border-ink" : "border-line"}`}
        />
        <button
          type="submit"
          disabled={busy}
          aria-busy={busy || undefined}
          className="group label flex items-center gap-2 bg-violet px-4 font-semibold text-white transition-colors hover:bg-ink disabled:cursor-wait disabled:opacity-70 sm:px-5"
        >
          {busy ? "Sending…" : "Subscribe"}{" "}
          <ArrowUpRight aria-hidden className="size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-2 text-xs">
          <span aria-hidden className="mr-1 bg-ink px-1 font-mono text-paper">
            !
          </span>
          {error}
        </p>
      )}
    </form>
  );
}
