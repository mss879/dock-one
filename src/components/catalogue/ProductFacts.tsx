import { BadgeCheck, Banknote, RotateCcw, Store, Truck } from "lucide-react";
import type { ReactNode } from "react";
import { Price } from "@/components/ui/Price";
import type { StoreSettings } from "@/lib/settings";
import { bankTransferReady } from "@/lib/settings-shared";

type Fact = { key: string; icon: typeof Truck; title: string; body?: ReactNode };

/**
 * Delivery / pickup / payment / returns / warranty — every line read from the store_settings
 * row (the same row place_order reads, P6/P7) or the product's own warranty; a fact that isn't
 * set is not shown (P15: no "free delivery" without its condition, no promise we can't keep).
 */
export function ProductFacts({ settings, warrantyMonths }: { settings: StoreSettings; warrantyMonths: number | null }) {
  const facts: Fact[] = [];

  // Delivery: mirror of place_order's rule (fee, free at or above the threshold when one is set).
  facts.push({
    key: "delivery",
    icon: Truck,
    title: "Island-wide delivery",
    body:
      settings.deliveryFee === 0 ? (
        "Free delivery"
      ) : (
        <>
          <Price amount={settings.deliveryFee} /> delivery
          {settings.freeDeliveryThreshold !== null && (
            <>
              {" "}
              · free on orders of <Price amount={settings.freeDeliveryThreshold} /> or more
            </>
          )}
        </>
      ),
  });

  // Pickup: only when it is enabled AND an address is set (quote_order's pickup_available).
  if (settings.pickupEnabled && settings.pickupAddress) {
    facts.push({
      key: "pickup",
      icon: Store,
      title: "Showroom pickup",
      body: (
        <>
          {settings.pickupAddress}
          {settings.pickupNote && <span className="block text-mute">{settings.pickupNote}</span>}
        </>
      ),
    });
  }

  // Payment: the methods the checkout will actually offer.
  const payments: ReactNode[] = [];
  if (settings.codEnabled) {
    payments.push(
      settings.codMaxTotal !== null ? (
        <span key="cod">
          Cash on delivery (orders up to <Price amount={settings.codMaxTotal} />)
        </span>
      ) : (
        <span key="cod">Cash on delivery</span>
      ),
    );
  }
  if (bankTransferReady(settings)) payments.push(<span key="bank">Bank transfer</span>);
  if (payments.length > 0) {
    facts.push({
      key: "payment",
      icon: Banknote,
      title: "Payment",
      body: payments.map((item, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {item}
        </span>
      )),
    });
  }

  if (settings.returnsWindowDays > 0) {
    facts.push({ key: "returns", icon: RotateCcw, title: `${settings.returnsWindowDays}-day returns` });
  }

  if (warrantyMonths !== null && warrantyMonths > 0) {
    facts.push({ key: "warranty", icon: BadgeCheck, title: `${warrantyMonths}-month warranty`, body: settings.warrantyNote ?? undefined });
  } else if (settings.warrantyNote) {
    facts.push({ key: "warranty", icon: BadgeCheck, title: "Warranty", body: settings.warrantyNote });
  }

  return (
    <ul aria-label="Delivery, payment and returns" className="mt-6 divide-y divide-line border-y border-line">
      {facts.map(({ key, icon: Icon, title, body }) => (
        <li key={key} className="flex gap-3 py-3.5">
          <span aria-hidden className="grid size-8 shrink-0 place-items-center bg-ink text-lime">
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 text-sm leading-6">
            <p className="font-semibold">{title}</p>
            {body && <div className="text-ink-2">{body}</div>}
          </div>
        </li>
      ))}
    </ul>
  );
}
