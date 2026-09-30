"use client";

import { useRef, useState, type FormEvent } from "react";
import { PIN_PATTERN } from "@/components/admin/site-lock/types";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { Field, Input } from "@/components/ui/form";
import { Notice } from "@/components/ui/Notice";

const GENERIC = "Something went wrong. Please try again.";

/**
 * The preview PIN form (blueprint §9.15). POSTs to /api/site-lock/unlock, which sets the httpOnly
 * bypass cookie on a match; then the page the visitor asked for is simply reloaded (the proxy
 * rewrote it here, so the address bar still shows it). Every failure — wrong PIN, no PIN set,
 * cooling off — comes back as the same message.
 */
export function UnlockForm() {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const honeypot = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const clean = pin.replace(/\s+/g, "");
    if (!PIN_PATTERN.test(clean)) {
      setError("Enter the 6 to 12 digit PIN.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/site-lock/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin",
        body: JSON.stringify({ pin: clean, company: honeypot.current?.value ?? "" }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (response.ok && payload?.ok) {
        // Unlocked: a FULL load of the page they came for (or the storefront when they opened this
        // page directly), so the proxy sees the new cookie and the store's own layout renders.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full document load is the point here
        if (window.location.pathname === "/launching-soon") window.location.href = "/";
        else window.location.reload();
        return;
      }
      setError(payload?.error ?? GENERIC);
      setPin("");
      setBusy(false);
    } catch {
      setError(GENERIC);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby="unlock-title" className="relative space-y-5 border border-ink bg-surface p-5 sm:p-6">
      <Cross className="-top-[6px] -left-[6px]" />
      <Cross className="-right-[6px] -bottom-[6px]" />
      <div aria-hidden className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor="unlock-company">Company</label>
        <input ref={honeypot} id="unlock-company" name="company" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>
      <h2 id="unlock-title" className="label font-semibold">
        Preview access
      </h2>
      <Field label="PIN" required hint="6 to 12 digits">
        <Input
          type="password"
          name="pin"
          inputMode="numeric"
          autoComplete="off"
          maxLength={12}
          spellCheck={false}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/[^0-9]/g, ""))}
        />
      </Field>
      {error && <Notice tone="error">{error}</Notice>}
      <Button type="submit" size="lg" className="w-full" disabled={busy} aria-busy={busy || undefined}>
        {busy ? "Checking…" : "Unlock"}
      </Button>
    </form>
  );
}
