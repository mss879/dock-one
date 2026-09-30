"use client";

import { ExternalLink } from "lucide-react";
import { AdminLinkButton, DateTime, Drawer, Money, StatusBadge } from "@/components/admin/ui";
import { adminHref } from "@/lib/admin/url";
import { parseRecoveryItems, recoveryStageLabel } from "@/lib/cart-recovery";
import { cartState, shopperName, type AbandonedCart } from "./types";

const ADDRESS_KEYS = ["street", "city", "district", "postal_code", "country"] as const;

function addressLines(address: AbandonedCart["shipping_address"]): string[] {
  if (!address || typeof address !== "object") return [];
  return ADDRESS_KEYS.map((key) => address[key]).filter((value): value is string => typeof value === "string" && value.trim() !== "");
}

/**
 * One captured checkout (read-only): who, what, and where it is in the reminder schedule. The
 * lines are the snapshot capture_abandoned_cart took FROM THE CATALOGUE at the time (names and
 * LKR prices then — the /recover page re-prices them live).
 */
export function AbandonedCartDrawer({ cart, onClose }: { cart: AbandonedCart | null; onClose: () => void }) {
  if (!cart) return null;
  const state = cartState(cart);
  const items = parseRecoveryItems(cart.cart_items);
  const address = addressLines(cart.shipping_address);
  const rate = Number(cart.exchange_rate);
  const name = shopperName(cart);

  return (
    <Drawer
      open
      onClose={onClose}
      title={name || cart.email}
      description={name ? cart.email : undefined}
      headerActions={
        cart.converted_order_id ? (
          <AdminLinkButton href={adminHref({ tab: "orders", order: cart.converted_order_id })} size="sm" icon={<ExternalLink aria-hidden className="size-3.5" />}>
            Order {cart.converted_order_id}
          </AdminLinkButton>
        ) : undefined
      }
    >
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={state.tone} dot>
            {state.label}
          </StatusBadge>
          <StatusBadge tone="neutral">Reminders: {recoveryStageLabel(cart.recovery_stage)}</StatusBadge>
        </div>

        <dl className="grid grid-cols-[130px_minmax(0,1fr)] gap-x-4 gap-y-2 border-y border-adm-line py-4 text-sm">
          <dt className="text-adm-mute">Email</dt>
          <dd className="font-mono text-[13px] break-all">{cart.email}</dd>
          <dt className="text-adm-mute">Phone</dt>
          <dd className="font-mono text-[13px]">{cart.phone ?? <span className="text-adm-mute">—</span>}</dd>
          <dt className="text-adm-mute">Address</dt>
          <dd>{address.length > 0 ? address.join(", ") : <span className="text-adm-mute">—</span>}</dd>
          <dt className="text-adm-mute">Started</dt>
          <dd>
            <DateTime value={cart.created_at} />
          </dd>
          <dt className="text-adm-mute">Last activity</dt>
          <dd>
            <DateTime value={cart.updated_at} />
          </dd>
          <dt className="text-adm-mute">Last reminder</dt>
          <dd>{cart.last_recovery_at ? <DateTime value={cart.last_recovery_at} /> : <span className="text-adm-mute">—</span>}</dd>
          {cart.currency !== "LKR" && (
            <>
              <dt className="text-adm-mute">Shown prices in</dt>
              <dd>
                {cart.currency}
                {Number.isFinite(rate) ? <span className="text-adm-mute"> (rate {rate})</span> : null} — charged in LKR
              </dd>
            </>
          )}
        </dl>

        <div>
          <p className="font-mono text-[10.5px] font-semibold tracking-[0.08em] text-adm-mute uppercase">Items when captured</p>
          {items.length === 0 ? (
            <p className="mt-2 text-sm text-adm-mute">No items were saved with this checkout.</p>
          ) : (
            <table className="mt-2 w-full text-sm">
              <caption className="sr-only">Items in this cart</caption>
              <thead>
                <tr className="border-b border-adm-line text-left font-mono text-[10.5px] tracking-[0.08em] text-adm-mute uppercase">
                  <th scope="col" className="py-2 font-semibold">
                    Item
                  </th>
                  <th scope="col" className="py-2 text-right font-semibold">
                    Qty
                  </th>
                  <th scope="col" className="py-2 text-right font-semibold">
                    Line
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-adm-line">
                {items.map((item) => (
                  <tr key={`${item.variantId}`}>
                    <td className="py-2 pr-3">
                      <span className="block">{item.name}</span>
                      {item.variantName && item.variantName !== "Standard" && <span className="block font-mono text-xs text-adm-mute">{item.variantName}</span>}
                    </td>
                    <td className="py-2 text-right tabular-nums">{item.quantity}</td>
                    <td className="py-2 text-right">
                      <Money amount={item.price * item.quantity} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-adm-line-strong">
                  <th scope="row" colSpan={2} className="py-2 text-left font-semibold">
                    Total
                  </th>
                  <td className="py-2 text-right font-semibold">
                    <Money amount={cart.total_price} />
                  </td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </Drawer>
  );
}
