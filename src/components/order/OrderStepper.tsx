import { Check, X } from "lucide-react";
import { ORDER_STEPS, isCancelledOrder, orderStepLabel, stepIndexForStatus, type OrderFulfillment, type OrderStatus } from "@/lib/orders";

/**
 * The shopper's stepper (blueprint §9.7 ORDER_STEPS): placed → preparing → out for delivery /
 * ready for pickup → delivered / collected. A cancelled order shows its state instead of progress.
 * No hooks, no directive: renders in server pages and client islands alike.
 */
export function OrderStepper({ status, fulfillment, tone = "light" }: { status: OrderStatus; fulfillment: OrderFulfillment; tone?: "light" | "dark" }) {
  const dark = tone === "dark";
  if (isCancelledOrder(status)) {
    return (
      <p className={`label inline-flex items-center gap-2 border px-3 py-2 font-semibold ${dark ? "border-night-line text-paper" : "border-ink text-ink"}`}>
        <X aria-hidden className="size-4" /> This order was cancelled
      </p>
    );
  }
  const current = stepIndexForStatus(status);
  return (
    <ol className="grid grid-cols-4" aria-label="Order progress">
      {ORDER_STEPS.map((step, i) => {
        const done = i < current;
        const active = i === current;
        const label = orderStepLabel(step, fulfillment);
        return (
          <li key={step.key} aria-current={active ? "step" : undefined} className="relative flex min-w-0 flex-col gap-2 pr-2">
            <span aria-hidden className={`absolute top-[15px] right-0 left-8 h-px ${i === ORDER_STEPS.length - 1 ? "hidden" : done ? (dark ? "bg-lime" : "bg-ink") : dark ? "bg-night-line" : "bg-line"}`} />
            <span
              aria-hidden
              className={`relative grid size-8 place-items-center border font-mono text-xs font-bold ${
                active ? "border-lime bg-lime text-ink" : done ? (dark ? "border-paper bg-paper text-ink" : "border-ink bg-ink text-paper") : dark ? "border-night-line text-night-mute" : "border-line text-mute"
              }`}
            >
              {done ? <Check className="size-4" /> : String(i + 1).padStart(2, "0")}
            </span>
            <span className={`label leading-snug ${active ? "font-bold" : ""} ${dark ? (active || done ? "text-paper" : "text-night-mute") : active || done ? "text-ink" : "text-mute"}`}>
              {label}
              <span className="sr-only">{done ? " (done)" : active ? " (current)" : " (next)"}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
