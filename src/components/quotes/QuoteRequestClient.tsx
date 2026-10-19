"use client";

import { Minus, Plus, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/Notice";
import { Price } from "@/components/ui/Price";
import { cart } from "@/lib/cart";

/**
 * The quotation request form (/quote): the products (from the basket, or the one chosen on a
 * product page) and the customer's details. POST /api/quotation prices and numbers it
 * (40_sales_documents) and returns the private link, which opens straight away. Prices shown here
 * are indicative — the quotation uses the store's current prices.
 */

export type QuoteItem = { variantId: number; name: string; brand: string; variantName: string | null; price: number; imageUrl: string | null; quantity: number };

type Values = { name: string; company: string; email: string; phone: string; address: string; city: string; note: string };
type FieldKey = "name" | "email" | "phone";
const EMPTY: Values = { name: "", company: "", email: "", phone: "", address: "", city: "", note: "" };

export function QuoteRequestClient({ initialItems, fromBasket }: { initialItems: QuoteItem[]; fromBasket: boolean }) {
  const [items, setItems] = useState<QuoteItem[]>(initialItems);
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const honeypot = useRef<HTMLInputElement>(null);

  // From the basket: its lines become the quotation's lines (read once, in the browser).
  useEffect(() => {
    if (!fromBasket || initialItems.length > 0) return;
    const lines = cart.getLines();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the basket lives in localStorage, readable only after mount
    setItems(
      lines.map((l) => ({
        variantId: l.variantId,
        name: l.name,
        brand: l.brand,
        variantName: l.variantName && l.variantName.toLowerCase() !== "standard" ? l.variantName : null,
        price: l.price,
        imageUrl: l.imageUrl,
        quantity: Math.min(l.qty, 1000),
      })),
    );
  }, [fromBasket, initialItems.length]);

  const set = (key: keyof Values, value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }));
  };
  const setQty = (variantId: number, quantity: number) =>
    setItems((list) => list.map((i) => (i.variantId === variantId ? { ...i, quantity: Math.min(Math.max(quantity, 1), 1000) } : i)));
  const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const next: Partial<Record<FieldKey, string>> = {};
    if (!values.name.trim()) next.name = "Please enter your name.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.email.trim())) next.email = "Please enter a valid email address.";
    if (values.phone.replace(/\D/g, "").length < 9) next.phone = "Please enter a phone number we can call.";
    setErrors(next);
    if (Object.keys(next).length) return;
    if (items.length === 0) return setError("Add at least one product — open a product page and choose “Request a quotation”, or add items to your basket.");
    setBusy(true);
    try {
      const res = await fetch("/api/quotation", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          contact: { ...values },
          items: items.map((i) => ({ variantId: i.variantId, quantity: i.quantity })),
          website: honeypot.current?.value ?? "",
        }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; path?: string; error?: string; field?: FieldKey } | null;
      if (res.ok && body?.ok && body.path) {
        window.location.assign(body.path);
        return;
      }
      if (body?.field) setErrors({ [body.field]: body.error });
      setError(res.status === 429 ? "You've requested a few quotations already. Please wait a while, or call us." : (body?.error ?? "We couldn't prepare your quotation. Please try again."));
    } catch {
      setError("We couldn't reach the store. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_400px] xl:gap-12">
      <div className="relative space-y-5 border border-ink bg-surface p-5 sm:p-6">
        <Cross className="-top-[6px] -left-[6px]" />
        <Cross className="-right-[6px] -bottom-[6px]" />
        <div aria-hidden className="absolute -left-[10000px] h-px w-px overflow-hidden">
          <label htmlFor="quote-website">Website</label>
          <input ref={honeypot} id="quote-website" name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
        </div>
        <h2 className="label font-semibold">Your details</h2>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Your name" required error={errors.name} id="quote-name">
            <Input autoComplete="name" value={values.name} maxLength={120} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Company" optional id="quote-company">
            <Input autoComplete="organization" value={values.company} maxLength={200} onChange={(e) => set("company", e.target.value)} />
          </Field>
          <Field label="Email" required error={errors.email} id="quote-email" hint="We email you the quotation link">
            <Input type="email" autoComplete="email" inputMode="email" spellCheck={false} value={values.email} maxLength={254} onChange={(e) => set("email", e.target.value)} />
          </Field>
          <Field label="Phone" required error={errors.phone} id="quote-phone">
            <Input type="tel" autoComplete="tel" value={values.phone} maxLength={40} onChange={(e) => set("phone", e.target.value)} />
          </Field>
          <Field label="Address" optional id="quote-address" className="sm:col-span-2">
            <Input autoComplete="street-address" value={values.address} maxLength={500} onChange={(e) => set("address", e.target.value)} />
          </Field>
          <Field label="City" optional id="quote-city">
            <Input autoComplete="address-level2" value={values.city} maxLength={120} onChange={(e) => set("city", e.target.value)} />
          </Field>
        </div>
        <Field label="Anything we should know?" optional id="quote-note" hint="Delivery date, quantities you may add, specifications…">
          <Textarea rows={4} value={values.note} maxLength={1000} onChange={(e) => set("note", e.target.value)} />
        </Field>
        {error && <Notice tone="error">{error}</Notice>}
        <Button type="submit" size="lg" className="w-full sm:w-auto" disabled={busy} aria-busy={busy || undefined}>
          {busy ? "Preparing your quotation…" : "Get my quotation"}
        </Button>
      </div>

      <aside className="border border-ink bg-surface">
        <div className="border-b border-ink px-5 py-3.5">
          <h2 className="label font-semibold">Products ({items.length})</h2>
        </div>
        {items.length === 0 ? (
          <div className="space-y-3 p-5 text-sm text-ink-2">
            <p>No products yet.</p>
            <p>
              Open a product and choose <span className="font-semibold">“Request a quotation”</span>, or{" "}
              <Link href="/shop" className="font-semibold underline underline-offset-4">
                browse the shop
              </Link>{" "}
              and add items to your basket, then request a quotation from the basket.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.variantId} className="flex gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink">{item.name.toLowerCase().startsWith(item.brand.toLowerCase()) ? item.name : `${item.brand} ${item.name}`}</p>
                  {item.variantName && <p className="text-xs text-mute">{item.variantName}</p>}
                  <p className="mt-1 text-xs text-ink-2">
                    <Price amount={item.price} /> each
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <div className="flex h-9 border border-line">
                    <button type="button" aria-label="Fewer" className="grid w-8 place-items-center hover:bg-ink hover:text-paper" onClick={() => setQty(item.variantId, item.quantity - 1)}>
                      <Minus aria-hidden className="size-3" />
                    </button>
                    <input
                      aria-label={`Quantity of ${item.name}`}
                      inputMode="numeric"
                      value={item.quantity}
                      onChange={(e) => setQty(item.variantId, Number(e.target.value.replace(/\D/g, "")) || 1)}
                      className="w-12 border-x border-line text-center font-mono text-sm"
                    />
                    <button type="button" aria-label="More" className="grid w-8 place-items-center hover:bg-ink hover:text-paper" onClick={() => setQty(item.variantId, item.quantity + 1)}>
                      <Plus aria-hidden className="size-3" />
                    </button>
                  </div>
                  <button type="button" onClick={() => setItems((l) => l.filter((x) => x.variantId !== item.variantId))} className="label inline-flex items-center gap-1 text-mute hover:text-ink">
                    <X aria-hidden className="size-3" /> Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {items.length > 0 && (
          <div className="flex items-baseline justify-between border-t border-ink px-5 py-3.5">
            <span className="label font-semibold">Estimated total</span>
            <span className="font-mono text-lg font-bold">
              <Price amount={total} />
            </span>
          </div>
        )}
        <p className="px-5 pb-4 text-xs text-mute">Prices are confirmed on the quotation itself, from our current price list.</p>
      </aside>
    </form>
  );
}
