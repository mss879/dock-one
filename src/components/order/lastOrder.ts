"use client";

import { useSyncExternalStore } from "react";

/**
 * The copy of the last confirmation kept in sessionStorage (blueprint §9.4: "Keep a copy of the
 * last confirmation in sessionStorage so a reload doesn't lose the thank-you screen"). Written
 * by the checkout right after /api/checkout succeeds; read by /order/[id] only when the live
 * order can't be loaded (a DB blip). Never holds the view token, the address or the phone.
 */

const KEY = "dockone.order.v1";

export type LastOrderItem = { name: string; variantName: string | null; quantity: number; unitPrice: number; lineTotal: number };

export type LastOrderCopy = {
  orderId: string;
  createdAt: string | null;
  firstName: string | null;
  fulfillment: "delivery" | "pickup";
  paymentMethod: "cod" | "bank_transfer" | null;
  subtotal: number;
  shippingFee: number;
  discountCode: string | null;
  discountAmount: number;
  total: number;
  items: LastOrderItem[];
  savedAt: number;
};

export function saveLastOrder(copy: LastOrderCopy): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(copy));
    cached = null;
  } catch {
    // storage blocked: the live page (view token) still works
  }
}

let cached: { raw: string | null; value: LastOrderCopy | null } | null = null;

function read(): LastOrderCopy | null {
  let raw: string | null = null;
  try {
    raw = window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (cached && cached.raw === raw) return cached.value;
  let value: LastOrderCopy | null = null;
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<LastOrderCopy>) : null;
    if (parsed && typeof parsed.orderId === "string" && /^DO-\d{1,12}$/.test(parsed.orderId) && Array.isArray(parsed.items) && typeof parsed.total === "number") {
      value = {
        orderId: parsed.orderId,
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : null,
        firstName: typeof parsed.firstName === "string" ? parsed.firstName.slice(0, 60) : null,
        fulfillment: parsed.fulfillment === "pickup" ? "pickup" : "delivery",
        paymentMethod: parsed.paymentMethod === "cod" || parsed.paymentMethod === "bank_transfer" ? parsed.paymentMethod : null,
        subtotal: Number(parsed.subtotal) || 0,
        shippingFee: Number(parsed.shippingFee) || 0,
        discountCode: typeof parsed.discountCode === "string" ? parsed.discountCode : null,
        discountAmount: Number(parsed.discountAmount) || 0,
        total: parsed.total,
        items: parsed.items
          .filter((item): item is LastOrderItem => Boolean(item) && typeof item === "object" && typeof (item as LastOrderItem).name === "string")
          .slice(0, 50)
          .map((item) => ({
            name: item.name.slice(0, 200),
            variantName: typeof item.variantName === "string" ? item.variantName.slice(0, 120) : null,
            quantity: Number(item.quantity) || 0,
            unitPrice: Number(item.unitPrice) || 0,
            lineTotal: Number(item.lineTotal) || 0,
          })),
        savedAt: Number(parsed.savedAt) || 0,
      };
    }
  } catch {
    value = null;
  }
  cached = { raw, value };
  return value;
}

const subscribe = () => () => {};

/** The stored copy for `orderId` (null on the server, during hydration, or when it's another order). */
export function useLastOrder(orderId: string): LastOrderCopy | null {
  const copy = useSyncExternalStore(subscribe, read, () => null);
  return copy && copy.orderId === orderId ? copy : null;
}
