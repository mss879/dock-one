"use client";

import { ArrowUpRight, Check } from "lucide-react";
import { useState, type FormEvent } from "react";

export function NewsletterForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address, like name@example.com.");
      return;
    }
    // No mailing backend yet — confirm locally so the flow can be demoed.
    setDone(true);
  }

  if (done) {
    return (
      <p role="status" className="label flex h-12 items-center gap-2.5 bg-lime px-4 font-bold text-ink">
        <Check aria-hidden className="size-4" /> Signal locked — check your inbox
      </p>
    );
  }

  return (
    <form onSubmit={submit} noValidate>
      <label htmlFor="newsletter-email" className="sr-only">
        Email address
      </label>
      <div className="flex h-12 items-stretch">
        <input
          id="newsletter-email"
          type="email"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setError("");
          }}
          placeholder="ENTER EMAIL"
          autoComplete="email"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? "newsletter-error" : undefined}
          className={`min-w-0 flex-1 border border-r-0 bg-surface px-4 font-mono text-[13px] outline-none placeholder:text-mute focus:border-ink ${error ? "border-ink" : "border-line"}`}
        />
        <button type="submit" className="group label flex items-center gap-2 bg-violet px-4 font-semibold text-white transition-colors hover:bg-ink sm:px-5">
          Subscribe <ArrowUpRight aria-hidden className="size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </button>
      </div>
      {error && (
        <p id="newsletter-error" role="alert" className="mt-2 text-xs">
          <span aria-hidden className="mr-1 bg-ink px-1 font-mono text-paper">
            !
          </span>
          {error}
        </p>
      )}
    </form>
  );
}
