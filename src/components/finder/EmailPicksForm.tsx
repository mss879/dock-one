"use client";

import { useRef, useState, type FormEvent } from "react";
import { useStoreSettings } from "@/components/providers/StoreSettingsProvider";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { Field, FieldError, Input } from "@/components/ui/form";
import { Notice } from "@/components/ui/Notice";
import { answersRecord, type FinderAnswers } from "@/lib/quiz";
import { getFinderSessionId } from "./session";

type Props = {
  answers: FinderAnswers;
  /** How many picks are on screen (the email re-derives the same ones on the server). */
  count: number;
};

type Status =
  | { kind: "idle" }
  | { kind: "sent" }
  | { kind: "not_sent" }
  | { kind: "error"; message: string };

const GENERIC = "We couldn't send your picks just now. Please try again in a moment.";
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

/**
 * "Email me my picks" — asked only AFTER the results (blueprint §9.14 step 8). The request
 * carries the allowlisted answers and the address only; the server re-derives the picks and the
 * reasons before it sends anything. The copy says plainly that asking also subscribes the
 * address to the newsletter (record_finder_response does that, source 'finder' — P15).
 */
export function EmailPicksForm({ answers, count }: Props) {
  const { storeName } = useStoreSettings();
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const honeypot = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const address = email.trim();
    if (!EMAIL_PATTERN.test(address) || address.length > 254) {
      setFieldError("Enter a valid email address, like name@example.com.");
      return;
    }
    setBusy(true);
    setFieldError(null);
    setStatus({ kind: "idle" });
    try {
      const response = await fetch("/api/quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ sessionId: getFinderSessionId(), answers: answersRecord(answers), email: address, company: honeypot.current?.value ?? "" }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; emailed?: boolean; error?: string; field?: string } | null;
      if (response.ok && payload?.ok) {
        setStatus(payload.emailed ? { kind: "sent" } : { kind: "not_sent" });
      } else if (payload?.field === "email" && payload.error) {
        setFieldError(payload.error);
      } else {
        setStatus({ kind: "error", message: payload?.error ?? GENERIC });
      }
    } catch {
      setStatus({ kind: "error", message: GENERIC });
    } finally {
      setBusy(false);
    }
  }

  const picksWord = count === 1 ? "pick" : `${count} picks`;

  return (
    <section aria-labelledby="finder-email" className="relative mt-10 border border-ink bg-surface p-5 sm:p-6">
      <Cross className="-top-[6px] -left-[6px]" />
      <Cross className="-right-[6px] -bottom-[6px]" />
      <p className="label font-semibold text-violet-ink">/Email</p>
      <h2 id="finder-email" className="display mt-2 text-[clamp(1.6rem,3vw,2.25rem)]">
        Email me my picks
      </h2>

      {status.kind === "sent" ? (
        <Notice tone="success" className="mt-4" title="Sent">
          Your {picksWord} and the reasons are on their way to {email.trim()}.
        </Notice>
      ) : (
        <>
          <p className="mt-3 max-w-2xl text-sm text-ink-2">
            We&apos;ll email you {count === 1 ? "this pick" : `these ${count} picks`} with the reason for each. Asking for them also subscribes you to the {storeName} newsletter.
          </p>
          <form onSubmit={submit} noValidate className="mt-5">
            <div aria-hidden className="absolute -left-[10000px] h-px w-px overflow-hidden">
              <label htmlFor="finder-company">Company</label>
              <input ref={honeypot} id="finder-company" name="company" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field label="Email" required className="min-w-0 flex-1 sm:max-w-md">
                <Input
                  type="email"
                  name="email"
                  autoComplete="email"
                  inputMode="email"
                  maxLength={254}
                  value={email}
                  invalid={Boolean(fieldError)}
                  aria-describedby={fieldError ? "finder-email-error" : undefined}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setFieldError(null);
                  }}
                />
              </Field>
              <Button type="submit" disabled={busy} aria-busy={busy || undefined}>
                {busy ? "Sending…" : "Send my picks"}
              </Button>
            </div>
            {fieldError && <FieldError id="finder-email-error">{fieldError}</FieldError>}
          </form>
          {status.kind === "not_sent" && (
            <Notice tone="error" className="mt-4">
              We saved your picks but couldn&apos;t send the email just now. Please try again in a moment.
            </Notice>
          )}
          {status.kind === "error" && (
            <Notice tone="error" className="mt-4">
              {status.message}
            </Notice>
          )}
        </>
      )}
    </section>
  );
}
