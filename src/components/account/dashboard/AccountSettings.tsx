"use client";

import { RotateCw } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ChangePasswordForm } from "@/components/account/ChangePasswordForm";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { Field, Input, Select } from "@/components/ui/form";
import { Notice } from "@/components/ui/Notice";
import { CHECKOUT_COPY, normalizeOrderPhone } from "@/lib/checkout";
import { isSchemaMismatch, MIGRATIONS_PENDING_MESSAGE } from "@/lib/rpc-errors";
import { DISTRICTS, formatLkPhone, isDistrict } from "@/lib/sri-lanka";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { refreshViewer } from "@/lib/viewer";

/**
 * Settings tab (blueprint §9.13): profile and default address, email read-only, password change.
 * The viewer's own `customers` row under RLS (update own). The phone is stored normalised by the
 * checkout's rule (normalizeOrderPhone) and the address follows the checkout's rule, so the saved
 * details always pass place_order when checkout prefills them. The address keys are the checkout
 * `shipping` JSON keys, so checkout prefill needs no mapping (BUILD_SPEC §4.1). Pinned columns
 * (email, admin flag, lifetime value, admin note) are never sent — and 02's trigger restores them
 * anyway. Every save checks `{ error }` AND that exactly one row came back.
 */

const MIGRATION = "02_customers_and_auth.sql";
const PROFILE_FIELDS = "email, first_name, last_name, phone, street, city, district, postal_code, country";

type Profile = { firstName: string; lastName: string; phone: string; street: string; city: string; district: string; postalCode: string };
type Loaded = { email: string; country: string; profile: Profile };
type FieldErrors = Partial<Record<keyof Profile, string>>;

const str = (value: unknown) => (typeof value === "string" ? value : "");

function fromRow(row: Record<string, unknown>): Loaded {
  const phone = str(row.phone);
  return {
    email: str(row.email),
    country: str(row.country) || "Sri Lanka",
    profile: {
      firstName: str(row.first_name),
      lastName: str(row.last_name),
      phone: phone.startsWith("+94") ? formatLkPhone(phone) : phone,
      street: str(row.street),
      city: str(row.city),
      district: isDistrict(row.district) ? row.district : "",
      postalCode: str(row.postal_code),
    },
  };
}

const oneLine = (value: string, max: number) => value.replace(/\s+/g, " ").trim().slice(0, max);

export function AccountSettings({ userId, email }: { userId: string; email: string }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "missing" } | { status: "ready"; loaded: Loaded }>({
    status: "loading",
  });
  const [draft, setDraft] = useState<Profile | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    const supabase = getBrowserSupabase();
    if (!supabase) return { status: "error" as const, message: "Accounts aren't available on this site yet." };
    try {
      const { data, error } = await supabase.from("customers").select(PROFILE_FIELDS).eq("id", userId).maybeSingle();
      if (error) {
        console.error(`[dashboard] profile read failed (${MIGRATION})`, error.code, error.message);
        return { status: "error" as const, message: isSchemaMismatch(error) ? MIGRATIONS_PENDING_MESSAGE : "We couldn't load your details just now." };
      }
      if (!data) return { status: "missing" as const };
      return { status: "ready" as const, loaded: fromRow(data as Record<string, unknown>) };
    } catch {
      return { status: "error" as const, message: "We couldn't load your details just now." };
    }
  }, [userId]);

  useEffect(() => {
    let active = true;
    void load().then((next) => {
      if (!active) return;
      setState(next);
      if (next.status === "ready") setDraft(next.loaded.profile);
    });
    return () => {
      active = false;
    };
  }, [load, attempt]);

  const set = (key: keyof Profile) => (value: string) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setResult(null);
  };

  const onSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || saving) return;
    const firstName = oneLine(draft.firstName, 60);
    const lastName = oneLine(draft.lastName, 60);
    const street = oneLine(draft.street, 500);
    const city = oneLine(draft.city, 120);
    const postalCode = oneLine(draft.postalCode, 20);
    const district = draft.district;
    const phoneInput = draft.phone.trim();
    const phone = phoneInput ? normalizeOrderPhone(phoneInput) : null; // place_order's phone rule (lib/checkout.ts)

    // The same address rule checkout applies (place_order: street, city and district; postal code optional).
    const addressStarted = Boolean(street || city || district || postalCode);
    // The checkout's words for the same fields (lib/checkout.ts CHECKOUT_COPY).
    const problems: FieldErrors = {
      firstName: firstName ? undefined : CHECKOUT_COPY.invalidName,
      phone: phoneInput && !phone ? CHECKOUT_COPY.invalidPhone : undefined,
      street: addressStarted && !street ? CHECKOUT_COPY.invalidStreet : undefined,
      city: addressStarted && !city ? CHECKOUT_COPY.invalidCity : undefined,
      district: addressStarted && !isDistrict(district) ? CHECKOUT_COPY.invalidDistrict : undefined,
    };
    setErrors(problems);
    if (Object.values(problems).some(Boolean)) {
      setResult({ tone: "error", text: "Check the highlighted fields." });
      return;
    }
    const supabase = getBrowserSupabase();
    if (!supabase) return;

    setSaving(true);
    setResult(null);
    try {
      const { data, error } = await supabase
        .from("customers")
        .update({
          first_name: firstName,
          last_name: lastName || null,
          phone,
          street: street || null,
          city: city || null,
          district: isDistrict(district) ? district : null,
          postal_code: postalCode || null,
        })
        .eq("id", userId)
        .select(PROFILE_FIELDS);
      if (error) {
        console.error(`[dashboard] profile save failed (${MIGRATION})`, error.code, error.message);
        const message = error.message ?? "";
        setResult({
          tone: "error",
          text: isSchemaMismatch(error)
            ? MIGRATIONS_PENDING_MESSAGE
            : message.includes("customers_district_valid")
              ? "Choose one of the 25 districts."
              : message.includes("customers_field_lengths")
                ? "One of the fields is too long."
                : "Your changes weren't saved. Please try again.",
        });
      } else if (!Array.isArray(data) || data.length !== 1) {
        // RLS turned the update into "0 rows" (e.g. the session ended): nothing was saved.
        setResult({ tone: "error", text: "Your changes weren't saved — your session may have ended. Sign in again and retry." });
      } else {
        const saved = fromRow(data[0] as Record<string, unknown>);
        setState({ status: "ready", loaded: saved });
        setDraft(saved.profile);
        setResult({ tone: "success", text: "Your details are saved. Checkout will fill them in for you." });
        void refreshViewer(); // the menu shows the (new) first name
      }
    } catch {
      setResult({ tone: "error", text: "We couldn't reach the server. Check your connection and try again." });
    }
    setSaving(false);
  };

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)] xl:gap-12">
      <section aria-labelledby="settings-profile" className="relative border border-ink bg-surface">
        <Cross className="-top-[6px] -right-[6px]" />
        <h2 id="settings-profile" className="label bg-ink px-5 py-3 font-semibold text-paper">
          /01 Profile &amp; default address
        </h2>
        <div className="p-5 sm:p-6">
          {state.status === "loading" && (
            <div aria-busy="true" className="space-y-3">
              <p className="sr-only" role="status">
                Loading your details…
              </p>
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} aria-hidden className="h-11 w-full bg-surface-2" />
              ))}
            </div>
          )}
          {state.status === "error" && (
            <Notice tone="error" title="Couldn't load your details">
              <p>{state.message}</p>
              <button type="button" onClick={() => setAttempt((n) => n + 1)} className="label mt-2 inline-flex min-h-10 items-center gap-2 font-semibold text-ink hover:text-violet-ink">
                <RotateCw aria-hidden className="size-3.5" /> Try again
              </button>
            </Notice>
          )}
          {state.status === "missing" && (
            <Notice tone="error" title="Your profile isn't set up">
              We couldn&apos;t find the details for this account. Please sign out and sign in again, or contact us if this keeps happening.
            </Notice>
          )}
          {state.status === "ready" && draft && (
            <form onSubmit={onSave} noValidate className="space-y-5">
              {result && (
                <Notice tone={result.tone} title={result.tone === "success" ? "Saved" : "Not saved"}>
                  {result.text}
                </Notice>
              )}
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="First name" required error={errors.firstName}>
                  <Input autoComplete="given-name" maxLength={60} value={draft.firstName} onChange={(e) => set("firstName")(e.target.value)} disabled={saving} />
                </Field>
                <Field label="Last name" optional>
                  <Input autoComplete="family-name" maxLength={60} value={draft.lastName} onChange={(e) => set("lastName")(e.target.value)} disabled={saving} />
                </Field>
              </div>
              <Field label="Email" hint="The address you sign in with.">
                <Input type="email" value={state.loaded.email || email} readOnly aria-readonly="true" className="bg-paper text-ink-2" />
              </Field>
              <Field label="Phone" optional error={errors.phone} hint="Filled in for you at checkout.">
                <Input type="tel" autoComplete="tel" inputMode="tel" maxLength={24} value={draft.phone} onChange={(e) => set("phone")(e.target.value)} disabled={saving} />
              </Field>

              <fieldset className="space-y-5 border-t border-line pt-5">
                <legend className="label float-left mb-5 w-full font-semibold text-violet-ink">Default delivery address</legend>
                <Field label="Street address" error={errors.street}>
                  <Input autoComplete="street-address" maxLength={500} value={draft.street} onChange={(e) => set("street")(e.target.value)} disabled={saving} />
                </Field>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="City / town" error={errors.city}>
                    <Input autoComplete="address-level2" maxLength={120} value={draft.city} onChange={(e) => set("city")(e.target.value)} disabled={saving} />
                  </Field>
                  <Field label="District" error={errors.district}>
                    <Select value={draft.district} onChange={(e) => set("district")(e.target.value)} disabled={saving}>
                      <option value="">Choose a district</option>
                      {DISTRICTS.map((district) => (
                        <option key={district} value={district}>
                          {district}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="Postal code" optional>
                    <Input autoComplete="postal-code" inputMode="numeric" maxLength={20} value={draft.postalCode} onChange={(e) => set("postalCode")(e.target.value)} disabled={saving} />
                  </Field>
                  <Field label="Country">
                    <Input value={state.loaded.country} readOnly aria-readonly="true" className="bg-paper text-ink-2" />
                  </Field>
                </div>
              </fieldset>

              <Button type="submit" disabled={saving} aria-busy={saving || undefined}>
                {saving ? "Saving…" : "Save changes"}
              </Button>
            </form>
          )}
        </div>
      </section>

      <section aria-labelledby="settings-password" className="relative border border-ink bg-surface">
        <Cross className="-bottom-[6px] -left-[6px]" />
        <h2 id="settings-password" className="label bg-ink px-5 py-3 font-semibold text-paper">
          /02 Password
        </h2>
        <div className="p-5 sm:p-6">
          <ChangePasswordForm />
        </div>
      </section>
    </div>
  );
}
