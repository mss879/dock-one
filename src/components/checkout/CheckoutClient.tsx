"use client";

import { useRouter } from "next/navigation";
import { Banknote, Landmark, Store, Truck } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { track } from "@/lib/analytics";
import { cart, useCart } from "@/lib/cart";
import {
  CHECKOUT_COPY,
  CHECKOUT_LIMITS,
  SHIPPING_COUNTRY,
  validateCheckoutForm,
  type CheckoutField,
  type CheckoutFieldErrors,
  type CheckoutFormValues,
} from "@/lib/checkout";
import { resetCheckoutCartId, useCheckoutAutosave, type CheckoutDraft } from "@/lib/checkout-autosave";
import { useCurrency } from "@/lib/currency";
import type { OrderFulfillment, PaymentMethod } from "@/lib/orders";
import { bankAccountFromSettings, bankTransferReady, type PublicStoreSettings } from "@/lib/settings-shared";
import { DISTRICTS, isDistrict } from "@/lib/sri-lanka";
import { SIGNED_OUT_EVENT } from "@/lib/viewer";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field, Input, RadioCard, Select, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/Notice";
import { Price } from "@/components/ui/Price";
import { consumeParkedOfferCode, setQuoteDiscountCode, setQuoteFulfillment, useCartQuote } from "@/components/cart/useCartQuote";
import { useHydrated } from "@/components/cart/useHydrated";
import { BankTransferDetails } from "@/components/order/BankTransferDetails";
import { saveLastOrder, type LastOrderCopy } from "@/components/order/lastOrder";
import { CheckoutSummary } from "./CheckoutSummary";

/** The signed-in viewer's own customers row (read server-side with their session). */
export type CheckoutPrefill = {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  district: string | null;
  postalCode: string | null;
};

const FORM_ID = "checkout-form";

/** Every form control's id — errors focus the first invalid one in page order. */
const FIELD_IDS: Record<CheckoutField, string> = {
  email: "checkout-email",
  firstName: "checkout-first-name",
  lastName: "checkout-last-name",
  phone: "checkout-phone",
  fulfillment: "checkout-fulfillment-delivery",
  "shipping.street": "checkout-street",
  "shipping.city": "checkout-city",
  "shipping.district": "checkout-district",
  "shipping.postal_code": "checkout-postal-code",
  paymentMethod: "checkout-payment-cod",
  note: "checkout-note",
  items: "checkout-summary",
  currency: "checkout-summary",
};
const FIELD_ORDER = Object.keys(FIELD_IDS) as CheckoutField[];

const LOST_CONNECTION =
  "We lost the connection before your order was confirmed. If a confirmation email arrives, your order went through — otherwise please try again.";
const ATTENTION = "Some items in your basket need your attention — see the order summary.";

type CheckoutResponse = {
  ok?: boolean;
  error?: string;
  code?: string | null;
  field?: CheckoutField | "discountCode";
  line?: { label?: string; productId?: number };
  orderId?: string | null;
  viewToken?: string | null;
  createdAt?: string | null;
  firstName?: string | null;
  subtotal?: number;
  shippingFee?: number;
  discountCode?: string | null;
  discountAmount?: number;
  total?: number;
  paymentMethod?: PaymentMethod;
  fulfillment?: OrderFulfillment;
  items?: LastOrderCopy["items"];
};

function StepHeader({ index, title, id }: { index: string; title: string; id: string }) {
  return (
    <h2 id={id} className="label flex items-baseline gap-2 border-b border-ink pb-3 font-semibold">
      <span className="text-violet-ink">/{index}</span> {title}
    </h2>
  );
}

/**
 * /checkout client island (blueprint §9.4): contact, delivery or showroom pickup, address,
 * payment (COD / bank transfer — only what store_settings enables and quote_order says this
 * basket may use), order note, honeypot, the checkout autosave hook (WP-E), the parked offer
 * code, `begin_checkout`. Submits to POST /api/checkout; on success: clear the basket, keep a
 * sessionStorage copy, and go to /order/<id>?t=<view_token>.
 */
export function CheckoutClient({ settings, prefill }: { settings: PublicStoreSettings; prefill: CheckoutPrefill | null }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const { lines, subtotal: localSubtotal, delivery: localDelivery } = useCart();
  const quote = useCartQuote(hydrated);
  const { currency, rate } = useCurrency();

  const [values, setValues] = useState<CheckoutFormValues>(() => ({
    email: prefill?.email ?? "",
    firstName: prefill?.firstName ?? "",
    lastName: prefill?.lastName ?? "",
    phone: prefill?.phone ?? "",
    fulfillment: "delivery",
    shipping: {
      street: prefill?.street ?? "",
      city: prefill?.city ?? "",
      district: prefill?.district && isDistrict(prefill.district) ? prefill.district : "",
      postal_code: prefill?.postalCode ?? "",
      country: SHIPPING_COUNTRY,
    },
    paymentMethod: "",
    note: "",
  }));
  const [errors, setErrors] = useState<CheckoutFieldErrors>({});

  // Signed out (in this tab or another): the next person on a shared device must not see the
  // previous shopper's prefilled details (blueprint §9.13). The basket stays; the form empties.
  useEffect(() => {
    const clear = () => {
      setValues((prev) => ({
        ...prev,
        email: "",
        firstName: "",
        lastName: "",
        phone: "",
        note: "",
        shipping: { street: "", city: "", district: "", postal_code: "", country: SHIPPING_COUNTRY },
      }));
      setErrors({});
    };
    window.addEventListener(SIGNED_OUT_EVENT, clear);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, clear);
  }, []);
  const [submitting, setSubmitting] = useState(false);
  /** null · "redirecting" (going to /order/<id>) · "placed" (committed, but no confirmation link came back). */
  const [placed, setPlaced] = useState<null | "redirecting" | "placed">(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const honeypot = useRef<HTMLInputElement>(null);
  const tracked = useRef(false);

  // What the store offers for THIS basket right now (quote_order), falling back to the settings.
  const q = quote.quote;
  const pickupAvailable = q ? q.pickupAvailable : settings.pickupEnabled && Boolean(settings.pickupAddress);
  const codAvailable = q ? q.codAvailable : settings.codEnabled;
  const bankAvailable = q ? q.bankTransferAvailable : bankTransferReady(settings);
  const bankAccount = bankAccountFromSettings(settings);
  const fulfillment: OrderFulfillment = values.fulfillment === "pickup" && pickupAvailable ? "pickup" : "delivery";
  const paymentMethod: PaymentMethod | "" =
    values.paymentMethod === "cod" && codAvailable
      ? "cod"
      : values.paymentMethod === "bank_transfer" && bankAvailable
        ? "bank_transfer"
        : codAvailable
          ? "cod"
          : bankAvailable
            ? "bank_transfer"
            : "";
  const codCapped = settings.codEnabled && settings.codMaxTotal !== null && !codAvailable;

  // Blueprint §9.4: on mount, a code the assistant parked is taken (read-and-clear) to PREFILL the
  // promo field — the shopper still presses Apply. A code the shopper already applied in the basket
  // stays applied. The quote store keeps listening for OFFER_CODE_EVENT while the page is open.
  useEffect(() => {
    consumeParkedOfferCode();
    quote.refresh(); // stock and prices may have moved since the basket was last quoted
    return () => setQuoteFulfillment("delivery");
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setQuoteFulfillment(fulfillment);
  }, [fulfillment]);

  useEffect(() => {
    if (tracked.current || !hydrated || lines.length === 0) return;
    tracked.current = true;
    track("begin_checkout", { value: Math.round(localSubtotal), metadata: { lines: lines.length } });
  }, [hydrated, lines.length, localSubtotal]);

  // Checkout autosave (WP-E): only once there is an email and a first name, never after placing.
  const draft = useMemo<CheckoutDraft | null>(() => {
    if (placed || lines.length === 0 || !values.email.trim() || !values.firstName.trim()) return null;
    return {
      email: values.email.trim(),
      firstName: values.firstName.trim(),
      lastName: values.lastName.trim(),
      phone: values.phone.trim(),
      fulfillment,
      shipping: { ...values.shipping },
      items: lines.map((line) => ({ productId: line.productId, variantId: line.variantId, qty: line.qty, name: line.name, variantName: line.variantName, price: line.price })),
      subtotal: q ? q.subtotal : localSubtotal,
      currency,
      exchangeRate: rate,
    };
  }, [placed, lines, values, fulfillment, q, localSubtotal, currency, rate]);
  const { cartId } = useCheckoutAutosave(draft);

  function update<K extends keyof CheckoutFormValues>(key: K, value: CheckoutFormValues[K], field?: CheckoutField) {
    setValues((prev) => ({ ...prev, [key]: value }));
    const clear = field ?? (key as CheckoutField);
    setErrors((prev) => (prev[clear] ? { ...prev, [clear]: undefined } : prev));
  }

  function updateShipping(key: keyof CheckoutFormValues["shipping"], value: string) {
    setValues((prev) => ({ ...prev, shipping: { ...prev.shipping, [key]: value } }));
    const field = `shipping.${key}` as CheckoutField;
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }

  function focusFirst(fieldErrors: CheckoutFieldErrors) {
    const first = FIELD_ORDER.find((field) => fieldErrors[field]);
    if (!first) return;
    const element = document.getElementById(FIELD_IDS[first]);
    element?.focus();
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function highlightLine(line: CheckoutResponse["line"]) {
    if (!line) return;
    const current = cart.getLines();
    const match =
      (line.productId ? current.find((l) => l.productId === line.productId) : undefined) ??
      (line.label ? current.find((l) => l.name === line.label || `${l.name} (${l.variantName})` === line.label) : undefined) ??
      (line.label ? current.find((l) => line.label?.startsWith(l.name)) : undefined);
    if (match) setHighlight(match.variantId);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting || placed) return;
    setSubmitError(null);
    setPromoError(null);
    setHighlight(null);

    const form: CheckoutFormValues = { ...values, fulfillment, paymentMethod };
    const fieldErrors = validateCheckoutForm(form);
    if (!paymentMethod) fieldErrors.paymentMethod = CHECKOUT_COPY.unsupportedPayment;
    if (Object.values(fieldErrors).some(Boolean)) {
      setErrors(fieldErrors);
      focusFirst(fieldErrors);
      return;
    }
    const current = cart.getLines();
    if (current.length === 0) {
      setSubmitError(CHECKOUT_COPY.invalidItems);
      return;
    }
    if (quote.fresh && q && !q.orderable) {
      setSubmitError(ATTENTION);
      return;
    }
    // Only a code the latest quote didn't refuse travels (a refused code would fail the order).
    const discountCode = quote.discountCode && !(quote.fresh && q?.discount?.valid === false) ? quote.discountCode : null;

    setSubmitting(true);
    let response: Response;
    let payload: CheckoutResponse | null;
    try {
      response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          email: form.email,
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone,
          fulfillment,
          shipping: fulfillment === "delivery" ? form.shipping : undefined,
          paymentMethod,
          note: form.note,
          items: current.map((line) => ({ productId: line.productId, variantId: line.variantId, qty: line.qty })),
          discountCode,
          abandonedCartId: cartId || null,
          currency,
          exchangeRate: rate,
          company: honeypot.current?.value ?? "",
        }),
      });
      payload = (await response.json().catch(() => null)) as CheckoutResponse | null;
    } catch {
      setSubmitting(false);
      setSubmitError(LOST_CONNECTION);
      return;
    }

    if (response.ok && payload?.ok) {
      setPlaced(payload.orderId && payload.viewToken ? "redirecting" : "placed");
      if (payload.orderId) {
        saveLastOrder({
          orderId: payload.orderId,
          createdAt: payload.createdAt ?? null,
          firstName: payload.firstName ?? null,
          fulfillment: payload.fulfillment === "pickup" ? "pickup" : "delivery",
          paymentMethod: payload.paymentMethod ?? null,
          subtotal: Number(payload.subtotal ?? 0),
          shippingFee: Number(payload.shippingFee ?? 0),
          discountCode: payload.discountCode ?? null,
          discountAmount: Number(payload.discountAmount ?? 0),
          total: Number(payload.total ?? 0),
          items: Array.isArray(payload.items) ? payload.items : [],
          savedAt: Date.now(),
        });
      }
      cart.clear();
      setQuoteDiscountCode(null);
      resetCheckoutCartId();
      if (payload.orderId && payload.viewToken) {
        router.replace(`/order/${encodeURIComponent(payload.orderId)}?t=${encodeURIComponent(payload.viewToken)}`);
      }
      return;
    }

    setSubmitting(false);
    const message = payload?.error ?? CHECKOUT_COPY.failed;
    if (payload?.field === "discountCode") setPromoError(message);
    else if (payload?.field && payload.field !== "items" && payload.field !== "currency") {
      const next = { [payload.field]: message } as CheckoutFieldErrors;
      setErrors(next);
      focusFirst(next);
    }
    highlightLine(payload?.line);
    if (response.status === 409) quote.refresh(); // stock moved: show the fresh notices
    setSubmitError(message);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  if (placed) {
    return (
      <Notice tone="success" title="Order placed">
        {placed === "redirecting" ? "Taking you to your order confirmation…" : "Thank you — your order is in. Your confirmation email has the details."}
      </Notice>
    );
  }

  if (!hydrated) {
    return (
      <div aria-busy className="grid items-start gap-8 lg:grid-cols-[1fr_400px] xl:gap-12">
        <div className="h-96 border border-line bg-surface" />
        <div className="h-80 border border-line bg-surface" />
      </div>
    );
  }

  if (lines.length === 0) {
    return (
      <div className="border border-line bg-surface">
        <EmptyState code="Basket_empty" title="Nothing to check out" description="Your basket is empty — add a few things first." action={{ label: "Browse products", href: "/shop" }} />
      </div>
    );
  }

  const noPayment = !codAvailable && !bankAvailable;
  const canSubmit = !noPayment && !(quote.fresh && q !== null && !q.orderable);

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[1fr_400px] xl:gap-12">
      <form id={FORM_ID} onSubmit={submit} noValidate className="min-w-0 space-y-10">
        {/* Honeypot: people never see or reach it; bots fill it in (blueprint §6.3). */}
        <div aria-hidden className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label htmlFor="checkout-company">Company</label>
          <input ref={honeypot} id="checkout-company" name="company" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
        </div>

        <section aria-labelledby="checkout-contact" className="space-y-5">
          <StepHeader index="01" title="Contact" id="checkout-contact" />
          <Field label="Email" required error={errors.email} id={FIELD_IDS.email} hint="With your order number, it lets you track this order.">
            <Input type="email" name="email" autoComplete="email" inputMode="email" maxLength={CHECKOUT_LIMITS.email} value={values.email} onChange={(e) => update("email", e.target.value)} />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="First name" required error={errors.firstName} id={FIELD_IDS.firstName}>
              <Input name="given-name" autoComplete="given-name" maxLength={CHECKOUT_LIMITS.name} value={values.firstName} onChange={(e) => update("firstName", e.target.value)} />
            </Field>
            <Field label="Last name" optional error={errors.lastName} id={FIELD_IDS.lastName}>
              <Input name="family-name" autoComplete="family-name" maxLength={CHECKOUT_LIMITS.name} value={values.lastName} onChange={(e) => update("lastName", e.target.value)} />
            </Field>
          </div>
          <Field label="Phone" required error={errors.phone} id={FIELD_IDS.phone} hint="e.g. 077 123 4567. For a number abroad, start with + and the country code.">
            <Input type="tel" name="tel" autoComplete="tel" inputMode="tel" maxLength={CHECKOUT_LIMITS.phone} value={values.phone} onChange={(e) => update("phone", e.target.value)} />
          </Field>
        </section>

        <section aria-labelledby="checkout-delivery" className="space-y-5">
          <StepHeader index="02" title="Delivery" id="checkout-delivery" />
          <fieldset aria-describedby={errors.fulfillment ? "checkout-fulfillment-error" : undefined}>
            <legend className="sr-only">Delivery or showroom pickup</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <RadioCard
                id={FIELD_IDS.fulfillment}
                name="fulfillment"
                value="delivery"
                checked={fulfillment === "delivery"}
                onChange={() => update("fulfillment", "delivery")}
                icon={<Truck className="size-4" />}
                title="Home delivery"
                description="Island-wide, to your address"
                meta={q && fulfillment === "delivery" ? q.shippingFee === 0 ? "Free" : <Price amount={q.shippingFee} /> : undefined}
              />
              {pickupAvailable && (
                <RadioCard
                  id="checkout-fulfillment-pickup"
                  name="fulfillment"
                  value="pickup"
                  checked={fulfillment === "pickup"}
                  onChange={() => update("fulfillment", "pickup")}
                  icon={<Store className="size-4" />}
                  title="Showroom pickup"
                  description="Collect it yourself — no delivery fee"
                  meta="Free"
                />
              )}
            </div>
            {errors.fulfillment && (
              <p id="checkout-fulfillment-error" role="alert" className="mt-2 text-xs text-ink">
                <span aria-hidden className="mr-1 bg-ink px-1 font-mono text-paper">
                  !
                </span>
                {errors.fulfillment}
              </p>
            )}
          </fieldset>

          {fulfillment === "pickup" ? (
            <Notice tone="info" title="Pickup address">
              <span className="block whitespace-pre-line">{settings.pickupAddress}</span>
              {settings.pickupNote && <span className="mt-1 block whitespace-pre-line">{settings.pickupNote}</span>}
              {settings.openingHours && <span className="mt-1 block whitespace-pre-line">{settings.openingHours}</span>}
            </Notice>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Street address" required error={errors["shipping.street"]} id={FIELD_IDS["shipping.street"]} className="sm:col-span-2">
                <Input name="street-address" autoComplete="street-address" maxLength={CHECKOUT_LIMITS.street} value={values.shipping.street} onChange={(e) => updateShipping("street", e.target.value)} />
              </Field>
              <Field label="City / town" required error={errors["shipping.city"]} id={FIELD_IDS["shipping.city"]}>
                <Input name="address-level2" autoComplete="address-level2" maxLength={CHECKOUT_LIMITS.city} value={values.shipping.city} onChange={(e) => updateShipping("city", e.target.value)} />
              </Field>
              <Field label="District" required error={errors["shipping.district"]} id={FIELD_IDS["shipping.district"]}>
                <Select name="district" value={values.shipping.district} onChange={(e) => updateShipping("district", e.target.value)}>
                  <option value="">Choose a district</option>
                  {DISTRICTS.map((district) => (
                    <option key={district} value={district}>
                      {district}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Postal code" optional error={errors["shipping.postal_code"]} id={FIELD_IDS["shipping.postal_code"]}>
                <Input name="postal-code" autoComplete="postal-code" inputMode="numeric" maxLength={CHECKOUT_LIMITS.postalCode} value={values.shipping.postal_code} onChange={(e) => updateShipping("postal_code", e.target.value)} />
              </Field>
              <div className="self-end pb-2 text-sm text-ink-2">
                <span className="label text-mute">Country</span>
                <p className="font-medium">{SHIPPING_COUNTRY}</p>
              </div>
            </div>
          )}
        </section>

        <section aria-labelledby="checkout-payment" className="space-y-5">
          <StepHeader index="03" title="Payment" id="checkout-payment" />
          {noPayment ? (
            <Notice tone="error" title="No payment method available">
              We can&apos;t take orders online right now. Please try again later{settings.phone ? ` or call ${settings.phone}` : ""}.
            </Notice>
          ) : (
            <fieldset aria-describedby={errors.paymentMethod ? "checkout-payment-error" : undefined}>
              <legend className="sr-only">Payment method</legend>
              <div className="grid gap-3">
                {codAvailable && (
                  <RadioCard
                    id={FIELD_IDS.paymentMethod}
                    name="paymentMethod"
                    value="cod"
                    checked={paymentMethod === "cod"}
                    onChange={() => update("paymentMethod", "cod")}
                    icon={<Banknote className="size-4" />}
                    title="Cash on delivery"
                    description={
                      <>
                        {fulfillment === "pickup" ? "Pay in cash when you collect your order." : "Pay in cash when your order arrives."}
                        {settings.codMaxTotal !== null && (
                          <>
                            {" "}
                            Available for orders up to <Price amount={settings.codMaxTotal} className="font-mono" />.
                          </>
                        )}
                      </>
                    }
                  />
                )}
                {bankAvailable && (
                  <RadioCard
                    id={codAvailable ? "checkout-payment-bank" : FIELD_IDS.paymentMethod}
                    name="paymentMethod"
                    value="bank_transfer"
                    checked={paymentMethod === "bank_transfer"}
                    onChange={() => update("paymentMethod", "bank_transfer")}
                    icon={<Landmark className="size-4" />}
                    title="Bank transfer"
                    description={
                      bankAccount
                        ? `Pay into our ${bankAccount.bankName} account after you place the order, using your order number as the reference.`
                        : "Transfer the total to our bank account, using your order number as the reference."
                    }
                  />
                )}
              </div>
              {errors.paymentMethod && (
                <p id="checkout-payment-error" role="alert" className="mt-2 text-xs text-ink">
                  <span aria-hidden className="mr-1 bg-ink px-1 font-mono text-paper">
                    !
                  </span>
                  {errors.paymentMethod}
                </p>
              )}
            </fieldset>
          )}
          {codCapped && settings.codMaxTotal !== null && (
            <Notice tone="info" title="Cash on delivery limit">
              Cash on delivery is available for orders up to <Price amount={settings.codMaxTotal} className="font-mono font-semibold" />.
              {bankAvailable ? " Please pay by bank transfer for this order." : ""}
            </Notice>
          )}
          {paymentMethod === "bank_transfer" &&
            (bankAccount ? (
              <BankTransferDetails
                account={bankAccount}
                intro={
                  <>
                    Place your order first, then transfer the total to this account. Use your{" "}
                    <strong className="font-semibold text-ink">order number</strong> as the payment reference — you&apos;ll see it, with these details, on the next page and in
                    your confirmation email.
                  </>
                }
              />
            ) : (
              <Notice tone="info" title="Bank transfer">
                Place your order first — the next page shows our bank details, the amount and your order number to use as the payment reference.
              </Notice>
            ))}
        </section>

        <section aria-labelledby="checkout-note" className="space-y-5">
          <StepHeader index="04" title="Order note" id="checkout-note" />
          <Field label="Note for our team" optional error={errors.note} id={FIELD_IDS.note} hint="Anything we should know about delivery — up to 1,000 characters.">
            <Textarea name="note" rows={4} maxLength={CHECKOUT_LIMITS.note} value={values.note} onChange={(e) => update("note", e.target.value)} />
          </Field>
        </section>
      </form>

      <div id="checkout-summary" tabIndex={-1} className="min-w-0 outline-none">
        <CheckoutSummary
          formId={FORM_ID}
          lines={lines}
          localSubtotal={localSubtotal}
          localDelivery={localDelivery}
          quote={quote}
          fulfillment={fulfillment}
          submitting={submitting}
          canSubmit={canSubmit}
          submitError={submitError}
          promoError={promoError}
          highlightVariantId={highlight}
        />
      </div>
    </div>
  );
}
