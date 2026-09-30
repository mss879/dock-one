"use client";

import { Tag, X } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { normalizeDiscountCode, type Quote } from "@/lib/checkout";
import { DISCOUNT_REFUSED_MESSAGE, DISCOUNT_UNAVAILABLE_MESSAGE, type DiscountVerdict } from "@/lib/discount-copy";
import { Price } from "@/components/ui/Price";
import { clearParkedOfferCode, setQuoteDiscountCode } from "./useCartQuote";

type Props = {
  /** The applied code (useCartQuote().discountCode). */
  code: string | null;
  /** A code the assistant parked (useCartQuote().parkedCode): prefills the field; the shopper presses Apply. */
  parkedCode?: string | null;
  /** The latest quote — its `discount` verdict is the authority on what the code does. */
  quote: Quote | null;
  /** True while the quote answers exactly the current basket. */
  fresh: boolean;
  /** A quote request is in flight. */
  checking?: boolean;
  /** LKR subtotal sent to /api/discount for the advisory preview. */
  subtotal: number;
  id?: string;
  /** Checkout: the route refused the code — show why. */
  externalError?: string | null;
};

/**
 * Promo code (blueprint §9.6): "Apply" asks POST /api/discount (validate_discount — advisory,
 * never redeems); an accepted code is stored as the applied code in lib/offer-code so every
 * quote, the basket and the checkout use it, and place_order validates and redeems it. One
 * refusal message for every reason except a minimum the shopper can still reach. A code the
 * assistant parked only prefills the input (blueprint §9.4, §10.7): the shopper presses Apply.
 */
export function PromoCodeField({ code, parkedCode = null, quote, fresh, checking = false, subtotal, id, externalError = null }: Props) {
  const autoId = useId();
  const inputId = id ?? `promo${autoId.replace(/:/g, "")}`;
  const errorId = `${inputId}-error`;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DiscountVerdict | null>(null);
  // Prefill once per parked code, and only while nothing is applied and the input is empty
  // (adjusting state during render — no effect, no hydration flash: parkedCode is null on the server).
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(null);
  if (parkedCode && parkedCode !== prefilledFrom && !code) {
    setPrefilledFrom(parkedCode);
    if (!value.trim()) setValue(parkedCode);
  }

  // What the parked code does right now: the quote's verdict once it answers this basket,
  // otherwise the Apply preview.
  const verdict: DiscountVerdict | null = code ? (fresh && quote?.discount?.code === code ? quote.discount : preview?.code === code ? preview : null) : null;

  async function apply(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const entered = normalizeDiscountCode(value);
    if (!entered) {
      setError(value.trim() ? DISCOUNT_REFUSED_MESSAGE : null);
      return;
    }
    setBusy(true);
    setError(null);
    let result: DiscountVerdict;
    try {
      const response = await fetch("/api/discount", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ code: entered, subtotal: Math.max(0, Math.round(subtotal)) }),
      });
      const payload = (await response.json().catch(() => null)) as Partial<DiscountVerdict> | null;
      result =
        payload && (payload.valid === true || payload.valid === false || payload.valid === null) && typeof payload.message === "string"
          ? { valid: payload.valid, discountAmount: Number(payload.discountAmount ?? 0), message: payload.message, minimum: typeof payload.minimum === "number" ? payload.minimum : null, code: entered }
          : { valid: null, discountAmount: 0, message: DISCOUNT_UNAVAILABLE_MESSAGE, minimum: null, code: entered };
    } catch {
      result = { valid: null, discountAmount: 0, message: DISCOUNT_UNAVAILABLE_MESSAGE, minimum: null, code: entered };
    }
    setBusy(false);
    // Refused outright: keep what they typed so they can fix a typo. Anything else is parked:
    // valid → applied; unchecked → "enter it anyway"; a minimum → it applies once they reach it.
    if (result.valid === false && result.minimum === null) {
      setError(result.message);
      return;
    }
    setPreview(result);
    setValue("");
    setQuoteDiscountCode(entered);
    if (parkedCode && normalizeDiscountCode(parkedCode) === entered) clearParkedOfferCode();
  }

  function remove() {
    setPreview(null);
    setError(null);
    setQuoteDiscountCode(null);
  }

  if (code) {
    const applied = verdict?.valid === true;
    const unchecked = verdict === null || verdict.valid === null;
    return (
      <div>
        <p className={`label flex items-center justify-between gap-3 px-3 py-2.5 ${applied ? "bg-lime-soft" : "border border-ink bg-surface"}`}>
          <span className="flex min-w-0 items-center gap-2 font-semibold">
            <Tag aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">
              {code} — {applied ? "applied" : verdict === null && checking ? "checking…" : unchecked ? "checked at checkout" : "not applied"}
            </span>
          </span>
          <button type="button" onClick={remove} aria-label={`Remove promo code ${code}`} className="-my-2 -mr-2 grid size-10 shrink-0 place-items-center hover:bg-lime">
            <X aria-hidden className="size-3.5" />
          </button>
        </p>
        {verdict && !applied && (
          <p role="status" className="mt-2 text-xs text-ink-2">
            {verdict.minimum !== null ? (
              <>
                This code needs a minimum order of <Price amount={verdict.minimum} className="font-mono font-semibold" />.
              </>
            ) : (
              verdict.message
            )}
          </p>
        )}
        {externalError && (
          <p role="alert" className="mt-2 text-xs text-ink">
            <span aria-hidden className="mr-1 bg-ink px-1 font-mono text-paper">
              !
            </span>
            {externalError}
          </p>
        )}
      </div>
    );
  }

  const shownError = error ?? externalError;
  return (
    <form onSubmit={apply} noValidate>
      <label htmlFor={inputId} className="label mb-2 block font-semibold">
        Promo code
      </label>
      <div className="flex h-11 items-stretch">
        <input
          id={inputId}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          placeholder="Enter code"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={40}
          aria-invalid={Boolean(shownError) || undefined}
          aria-describedby={shownError ? errorId : undefined}
          className={`min-w-0 flex-1 border border-r-0 bg-paper px-3 font-mono text-sm uppercase outline-none placeholder:normal-case placeholder:text-mute/70 focus:border-ink ${shownError ? "border-ink" : "border-line"}`}
        />
        <button type="submit" disabled={busy} aria-busy={busy || undefined} className="label bg-ink px-4 font-semibold text-paper transition-colors hover:bg-violet disabled:opacity-60">
          {busy ? "Checking…" : "Apply"}
        </button>
      </div>
      {shownError && (
        <p id={errorId} role="alert" className="mt-2 text-xs text-ink">
          <span aria-hidden className="mr-1 bg-ink px-1 font-mono text-paper">
            !
          </span>
          {shownError}
        </p>
      )}
    </form>
  );
}
