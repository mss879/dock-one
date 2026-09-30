"use client";

import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/Notice";
import {
  charCount,
  CONTACT_COPY,
  CONTACT_FIELDS,
  CONTACT_LIMITS,
  normalizeContact,
  validateContact,
  type ContactErrors,
  type ContactField,
  type ContactValues,
} from "./contact-shared";

const IDS: Record<ContactField, string> = { name: "contact-name", email: "contact-email", subject: "contact-subject", message: "contact-message" };
const SLOW_DOWN = "You've sent a few messages already. Please wait a while before sending another.";
const EMPTY: ContactValues = { name: "", email: "", subject: "", message: "" };

/**
 * The contact form (blueprint §9.12): name, email, subject, message — the database's bounds are
 * checked here first (contact-shared.ts) and again by POST /api/contact and submit_contact_inquiry.
 * The hidden `company` field is the honeypot. "Sent" is shown only after the server saved it.
 */
export function ContactClient() {
  const [values, setValues] = useState<ContactValues>(EMPTY);
  const [errors, setErrors] = useState<ContactErrors>({});
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ name: string; email: string } | null>(null);
  const honeypot = useRef<HTMLInputElement>(null);
  const sentRef = useRef<HTMLDivElement>(null);

  function update(field: ContactField, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }

  function focus(field: ContactField) {
    document.getElementById(IDS[field])?.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setSubmitError(null);
    const clean = normalizeContact(values);
    const fieldErrors = validateContact(clean);
    const first = CONTACT_FIELDS.find((field) => fieldErrors[field]);
    if (first) {
      setErrors(fieldErrors);
      focus(first);
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ ...clean, company: honeypot.current?.value ?? "" }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; field?: ContactField } | null;
      if (response.ok && payload?.ok) {
        setSent({ name: clean.name, email: clean.email });
        setValues(EMPTY);
        window.requestAnimationFrame(() => sentRef.current?.focus());
        return;
      }
      if (payload?.field && CONTACT_FIELDS.includes(payload.field) && payload.error) {
        setErrors({ [payload.field]: payload.error });
        focus(payload.field);
      } else {
        setSubmitError(response.status === 429 ? SLOW_DOWN : (payload?.error ?? CONTACT_COPY.failed));
      }
    } catch {
      setSubmitError(CONTACT_COPY.failed);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div ref={sentRef} tabIndex={-1} className="space-y-6 outline-none">
        <Notice tone="success" title="Message sent">
          Thanks, {sent.name} — your message has reached us. Replies come by email to <span className="font-mono">{sent.email}</span>.
        </Notice>
        <Button type="button" variant="light" className="border border-ink" onClick={() => setSent(null)}>
          Write another message
        </Button>
      </div>
    );
  }

  const messageLength = charCount(values.message.trim());
  return (
    <form onSubmit={submit} noValidate className="relative space-y-5 border border-ink bg-surface p-5 sm:p-6">
      <Cross className="-top-[6px] -left-[6px]" />
      <Cross className="-right-[6px] -bottom-[6px]" />
      <div aria-hidden className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor="contact-company">Company</label>
        <input ref={honeypot} id="contact-company" name="company" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" required error={errors.name} id={IDS.name}>
          <Input name="name" autoComplete="name" value={values.name} onChange={(e) => update("name", e.target.value)} />
        </Field>
        <Field label="Email" required error={errors.email} id={IDS.email} hint="We reply to this address">
          <Input type="email" name="email" autoComplete="email" inputMode="email" spellCheck={false} value={values.email} onChange={(e) => update("email", e.target.value)} />
        </Field>
      </div>
      <Field label="Subject" required error={errors.subject} id={IDS.subject}>
        <Input name="subject" value={values.subject} onChange={(e) => update("subject", e.target.value)} />
      </Field>
      <Field
        label="Message"
        required
        error={errors.message}
        id={IDS.message}
        hint={
          <span className="flex justify-between gap-4">
            <span>
              {CONTACT_LIMITS.messageMin} to {CONTACT_LIMITS.messageMax.toLocaleString("en-US")} characters
            </span>
            <span className="font-mono tabular-nums" aria-hidden>
              {messageLength.toLocaleString("en-US")} / {CONTACT_LIMITS.messageMax.toLocaleString("en-US")}
            </span>
          </span>
        }
      >
        <Textarea name="message" rows={7} value={values.message} onChange={(e) => update("message", e.target.value)} />
      </Field>
      {submitError && <Notice tone="error">{submitError}</Notice>}
      <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={busy} aria-busy={busy || undefined}>
        {busy ? "Sending…" : "Send message"}
      </Button>
    </form>
  );
}
