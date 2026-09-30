"use client";

import { Lock } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { OrderStepper } from "@/components/order/OrderStepper";
import { OrderTimeline } from "@/components/order/OrderTimeline";
import { Field, Input } from "@/components/ui/form";
import { Notice } from "@/components/ui/Notice";
import type { AssistantOrderLookupResponse, AssistantOrderView } from "@/lib/assistant/types";
import { formatOrderDate, normalizeOrderStatus, orderStatusLabel, safeTrackingUrl } from "@/lib/orders";

/**
 * The private order lookup (blueprint §10.8): the order number and email are typed HERE and posted
 * straight to POST /api/assistant/order — they never enter the model or the transcript (P10). The
 * model is only told that the form is on display. When an order is found, the widget remembers its
 * ITEMS (not the number, not the email) so "what goes with what I bought?" still works.
 */

type State =
  | { status: "idle" }
  | { status: "busy" }
  | { status: "found"; order: AssistantOrderView }
  | { status: "error"; message: string };

const GENERIC = "We couldn't look that up just now. Please try again in a moment.";

export function StageOrderLookup({ sessionId, prefill, onFound }: { sessionId: string; prefill?: string; onFound: (order: AssistantOrderView) => void }) {
  const [orderRef, setOrderRef] = useState(prefill ?? "");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>({ status: "idle" });
  const honeypot = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.status === "busy") return;
    if (!orderRef.trim() || !email.trim()) {
      setState({ status: "error", message: "Enter your order number and the email you used at checkout." });
      return;
    }
    setState({ status: "busy" });
    try {
      const res = await fetch("/api/assistant/order", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId, orderRef: orderRef.trim(), email: email.trim(), company: honeypot.current?.value ?? "" }),
      });
      const data = (await res.json().catch(() => null)) as AssistantOrderLookupResponse | null;
      if (res.ok && data?.ok) {
        setState({ status: "found", order: data.order });
        setEmail("");
        onFound(data.order);
        return;
      }
      setState({ status: "error", message: data && !data.ok && data.error ? data.error : GENERIC });
    } catch {
      setState({ status: "error", message: GENERIC });
    }
  }

  if (state.status === "found") {
    const { order } = state;
    const status = normalizeOrderStatus(order.status);
    const trackingUrl = safeTrackingUrl(order.trackingUrl);
    return (
      <div aria-live="polite" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink pb-2">
          <p className="display text-xl">Order {order.orderId}</p>
          <span className="label bg-lime px-2 py-1 font-bold text-ink">{orderStatusLabel(status, order.fulfillment)}</span>
        </div>
        {order.placedAt && <p className="label text-mute">Placed {formatOrderDate(order.placedAt)}</p>}
        <OrderStepper status={status} fulfillment={order.fulfillment} />
        {order.trackingNumber && (
          <p className="text-sm text-ink-2">
            Tracking reference: <span className="font-mono font-semibold text-ink">{order.trackingNumber}</span>
            {trackingUrl && (
              <>
                {" · "}
                <a href={trackingUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-violet-ink underline underline-offset-2">
                  Track with the courier
                </a>
              </>
            )}
          </p>
        )}
        {order.items.length > 0 && (
          <div>
            <p className="label mb-1 font-semibold">Items</p>
            <ul className="divide-y divide-line border-y border-line text-sm">
              {order.items.map((item, i) => (
                <li key={`${item.variantId ?? item.name}-${i}`} className="flex justify-between gap-3 py-1.5">
                  <span className="min-w-0">
                    {item.name}
                    {item.variant && item.variant !== "Standard" && <span className="text-mute"> · {item.variant}</span>}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums">× {item.quantity}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <p className="label mb-2 font-semibold">Updates</p>
          <OrderTimeline entries={order.events.map((event) => ({ status: event.status, location: event.location, description: event.description, at: event.updatedAt }))} />
        </div>
        <button type="button" onClick={() => setState({ status: "idle" })} className="label min-h-10 font-semibold text-ink-2 hover:text-ink">
          [ Look up another order ]
        </button>
      </div>
    );
  }

  const busy = state.status === "busy";
  return (
    <form onSubmit={submit} noValidate className="relative space-y-3">
      <p className="flex items-start gap-2 text-xs leading-5 text-ink-2">
        <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0 text-violet-ink" />
        Private: what you type here goes straight to our order system. The tech desk can&apos;t see it.
      </p>
      <div aria-hidden className="absolute -left-[10000px] h-px w-px overflow-hidden">
        <label htmlFor={`assistant-order-company-${sessionId}`}>Company</label>
        <input ref={honeypot} id={`assistant-order-company-${sessionId}`} name="company" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>
      <Field label="Order number" required hint="From your confirmation, e.g. DO-10001">
        <Input name="order" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={40} value={orderRef} onChange={(e) => setOrderRef(e.target.value)} />
      </Field>
      <Field label="Email" required hint="The address you used at checkout">
        <Input type="email" name="email" autoComplete="email" inputMode="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>
      {state.status === "error" && <Notice tone="error">{state.message}</Notice>}
      <button
        type="submit"
        disabled={busy}
        aria-busy={busy || undefined}
        className="label flex h-11 w-full items-center justify-center bg-ink font-semibold text-paper transition-colors duration-150 hover:bg-violet disabled:pointer-events-none disabled:opacity-40"
      >
        {busy ? "Looking it up…" : "Find my order"}
      </button>
    </form>
  );
}
