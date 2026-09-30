"use client";

import { useRef, useState, type FormEvent } from "react";
import { TRACK_NOT_FOUND_MESSAGE } from "@/lib/checkout";
import { formatOrderDate, isCancelledOrder, orderStatusLabel, paymentMethodLabel, paymentStatusLabel, type OrderView } from "@/lib/orders";
import { bankAccountFromSettings } from "@/lib/settings-shared";
import { useStoreSettings } from "@/components/providers/StoreSettingsProvider";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { Field, Input } from "@/components/ui/form";
import { Notice } from "@/components/ui/Notice";
import { BankTransferDetails } from "./BankTransferDetails";
import { OrderItems } from "./OrderItems";
import { OrderStepper } from "./OrderStepper";
import { OrderTimeline } from "./OrderTimeline";
import { OrderTotals } from "./OrderTotals";

const GENERIC = "We couldn't look that up just now. Please try again in a moment.";

/**
 * Guest tracking (blueprint §9.8): order number + email in a POST body (never the URL) →
 * /api/track → track_guest_order. Wrong and missing orders read the same.
 */
export function TrackClient() {
  const [order, setOrder] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OrderView | null>(null);
  const honeypot = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const bankAccount = bankAccountFromSettings(useStoreSettings());
  const awaitingTransfer = result !== null && result.paymentMethod === "bank_transfer" && result.paymentStatus === "awaiting_transfer" && !isCancelledOrder(result.status);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!order.trim() || !email.trim()) {
      setError("Enter your order number and the email you used at checkout.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/track", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ order: order.trim(), email: email.trim(), company: honeypot.current?.value ?? "" }),
      });
      const payload = (await response.json().catch(() => null)) as { ok?: boolean; order?: OrderView; error?: string } | null;
      if (response.ok && payload?.ok && payload.order) {
        setResult(payload.order);
        window.requestAnimationFrame(() => resultRef.current?.focus());
      } else {
        setResult(null);
        setError(response.status === 404 ? TRACK_NOT_FOUND_MESSAGE : (payload?.error ?? GENERIC));
      }
    } catch {
      setResult(null);
      setError(GENERIC);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid items-start gap-10 lg:grid-cols-[400px_1fr] xl:gap-12">
      <form onSubmit={submit} noValidate className="relative space-y-5 border border-ink bg-surface p-5 sm:p-6">
        <Cross className="-top-[6px] -left-[6px]" />
        <Cross className="-right-[6px] -bottom-[6px]" />
        <div aria-hidden className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label htmlFor="track-company">Company</label>
          <input ref={honeypot} id="track-company" name="company" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
        </div>
        <Field label="Order number" required hint="From your confirmation, e.g. DO-10001">
          <Input name="order" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={40} value={order} onChange={(e) => setOrder(e.target.value)} />
        </Field>
        <Field label="Email" required hint="The address you used at checkout">
          <Input type="email" name="email" autoComplete="email" inputMode="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" size="lg" className="w-full" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Looking it up…" : "Track order"}
        </Button>
      </form>

      <div ref={resultRef} tabIndex={-1} aria-live="polite" className="min-w-0 outline-none">
        {result ? (
          <div className="space-y-10">
            <section aria-labelledby="track-status" className="space-y-6">
              <div className="flex flex-wrap items-end justify-between gap-3 border-b border-ink pb-3">
                <h2 id="track-status" className="display text-3xl">
                  Order {result.orderId}
                </h2>
                <p className="label">
                  <span className="bg-lime px-2 py-1 font-bold text-ink">{orderStatusLabel(result.status, result.fulfillment)}</span>
                </p>
              </div>
              {result.createdAt && <p className="label text-mute">Placed {formatOrderDate(result.createdAt)}</p>}
              <OrderStepper status={result.status} fulfillment={result.fulfillment} />
              {awaitingTransfer && bankAccount && (
                <BankTransferDetails
                  account={bankAccount}
                  reference={result.orderId}
                  amount={result.totalPrice}
                  title="Awaiting your transfer"
                  intro="Transfer the amount below to our bank account, with your order number as the payment reference."
                />
              )}
              {result.trackingNumber && (
                <p className="text-sm text-ink-2">
                  Tracking reference: <span className="font-mono font-semibold text-ink">{result.trackingNumber}</span>
                  {result.trackingUrl && (
                    <>
                      {" · "}
                      <a href={result.trackingUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-violet-ink underline underline-offset-2">
                        Track with the courier
                      </a>
                    </>
                  )}
                </p>
              )}
            </section>
            <section aria-labelledby="track-timeline" className="space-y-4">
              <h3 id="track-timeline" className="label border-b border-line pb-2 font-semibold">
                Updates
              </h3>
              <OrderTimeline entries={result.timeline} />
            </section>
            <section aria-labelledby="track-items" className="space-y-4">
              <h3 id="track-items" className="label border-b border-line pb-2 font-semibold">
                Items
              </h3>
              <OrderItems items={result.items} />
              <div className="max-w-md">
                <OrderTotals
                  subtotal={result.subtotal}
                  discountCode={result.discountCode}
                  discountAmount={result.discountAmount}
                  shippingFee={result.shippingFee}
                  total={result.totalPrice}
                  fulfillment={result.fulfillment}
                />
              </div>
              <p className="text-xs text-ink-2">
                {paymentMethodLabel(result.paymentMethod)} · {paymentStatusLabel(result.paymentStatus, result.fulfillment)}
              </p>
            </section>
          </div>
        ) : (
          <div className="bg-grid border border-dashed border-line p-8 text-sm text-ink-2 [--grid-size:24px]">
            <p className="label font-semibold text-violet-ink">&gt; Awaiting_input</p>
            <p className="mt-2 max-w-md">Enter your order number and the email you used at checkout to see where your order is.</p>
          </div>
        )}
      </div>
    </div>
  );
}
