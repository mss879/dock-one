"use client";

import { ArrowUpRight, Check } from "lucide-react";
import { Notice } from "@/components/ui/Notice";
import { formatDateTime } from "@/lib/admin/dates";
import { isCancelledOrder, ORDER_STEPS, orderStatusLabel, orderStepLabel, stepIndexForStatus, type OrderView } from "@/lib/orders";
import { statusChipClass } from "./OrderHistory";

/**
 * Tracking tab (blueprint §9.13): the shopper stepper from lib/orders.ts ORDER_STEPS plus the
 * order's own `order_tracking` timeline (oldest first, the labels the database wrote).
 */

function Stepper({ order }: { order: OrderView }) {
  const current = stepIndexForStatus(order.status);
  return (
    <ol aria-label="Order progress" className="grid gap-px border border-line bg-line sm:grid-cols-4">
      {ORDER_STEPS.map((step, index) => {
        const done = index < current || (index === current && index === ORDER_STEPS.length - 1);
        const active = index === current && !done;
        return (
          <li
            key={step.key}
            aria-current={index === current ? "step" : undefined}
            className={`flex items-center gap-3 px-4 py-3.5 sm:flex-col sm:items-start sm:gap-2.5 ${active ? "bg-violet-soft" : "bg-surface"}`}
          >
            <span
              aria-hidden
              className={`grid size-7 shrink-0 place-items-center border text-[11px] font-bold ${
                done ? "border-ink bg-ink text-lime" : active ? "border-violet bg-violet text-white" : "border-line bg-paper text-mute"
              }`}
            >
              {done ? <Check className="size-3.5" /> : `0${index + 1}`}
            </span>
            <span className={`label font-semibold ${done || active ? "text-ink" : "text-mute"}`}>
              {orderStepLabel(step, order.fulfillment)}
              <span className="sr-only">{done ? " — done" : active ? " — current step" : " — not yet"}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function TrackingPanel({ order }: { order: OrderView }) {
  const cancelled = isCancelledOrder(order.status);
  return (
    <section aria-labelledby={`track-${order.orderId}`} className="border border-line bg-surface">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div>
          <h3 id={`track-${order.orderId}`} className="label font-semibold">
            Order <span className="font-mono text-[13px] tracking-normal">{order.orderId}</span>
          </h3>
          <p className="label mt-0.5 text-mute">Placed {order.createdAt ? formatDateTime(order.createdAt) : "—"}</p>
        </div>
        <span className={`label px-2 py-1 font-bold ${statusChipClass(order.status)}`}>{orderStatusLabel(order.status, order.fulfillment)}</span>
      </header>

      <div className="space-y-6 p-4 sm:p-5">
        {cancelled ? (
          <Notice tone="info" title="This order was cancelled" />
        ) : (
          <Stepper order={order} />
        )}

        {order.trackingNumber && (
          <div className="flex flex-wrap items-center justify-between gap-3 border border-line bg-paper px-4 py-3">
            <p className="text-sm">
              <span className="label mr-2 text-mute">Tracking reference</span>
              <span className="font-mono font-semibold break-all">{order.trackingNumber}</span>
            </p>
            {order.trackingUrl && (
              <a
                href={order.trackingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="label inline-flex min-h-10 items-center gap-1.5 font-semibold text-violet-ink hover:text-ink"
              >
                Courier tracking <ArrowUpRight aria-hidden className="size-3.5" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            )}
          </div>
        )}

        <div>
          <h4 className="label mb-3 border-b border-ink pb-2 font-semibold">/ Timeline</h4>
          {order.timeline.length === 0 ? (
            <p className="text-sm text-ink-2">No updates yet.</p>
          ) : (
            <ol className="relative space-y-5 border-l border-line pl-5">
              {order.timeline.map((entry, index) => (
                <li key={`${entry.at ?? "t"}-${index}`} className="relative">
                  <span
                    aria-hidden
                    className={`absolute top-1 -left-[25px] size-2.5 border ${index === order.timeline.length - 1 ? "border-violet bg-violet" : "border-ink bg-surface"}`}
                  />
                  <p className="label text-mute">{entry.at ? formatDateTime(entry.at) : ""}</p>
                  <p className="mt-0.5 text-sm font-semibold">{entry.status}</p>
                  {entry.location && <p className="text-sm text-ink-2">{entry.location}</p>}
                  {entry.description && <p className="text-sm text-ink-2">{entry.description}</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}
