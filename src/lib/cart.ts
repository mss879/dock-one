"use client";

import { useMemo, useSyncExternalStore } from "react";
import { getProduct, type Product } from "@/data/products";
import { site } from "@/data/site";
import { createPersistentStore, createStore } from "./store";

export type CartLine = { id: string; qty: number };
export type CartItem = { product: Product; qty: number; lineTotal: number };

export const MAX_QTY = 10;
const EMPTY: CartLine[] = [];
const clampQty = (qty: number) => Math.min(MAX_QTY, Math.max(1, Math.round(qty)));

function sanitize(raw: unknown): CartLine[] {
  if (!Array.isArray(raw)) return EMPTY;
  return raw
    .filter((l): l is CartLine => typeof l?.id === "string" && Number.isFinite(l?.qty) && Boolean(getProduct(l.id)))
    .map((l) => ({ id: l.id, qty: clampQty(l.qty) }));
}

const lines = createPersistentStore<CartLine[]>("dockone.cart.v1", EMPTY, sanitize);
const drawer = createStore(false);

export const cart = {
  add(id: string, qty = 1) {
    lines.set((prev) =>
      prev.some((l) => l.id === id)
        ? prev.map((l) => (l.id === id ? { ...l, qty: clampQty(l.qty + qty) } : l))
        : [...prev, { id, qty: clampQty(qty) }],
    );
  },
  setQty(id: string, qty: number) {
    lines.set((prev) => prev.map((l) => (l.id === id ? { ...l, qty: clampQty(qty) } : l)));
  },
  remove(id: string) {
    lines.set((prev) => prev.filter((l) => l.id !== id));
  },
  clear() {
    lines.set(EMPTY);
  },
  open: () => drawer.set(true),
  close: () => drawer.set(false),
};

export function useCartDrawer() {
  return useSyncExternalStore(drawer.subscribe, drawer.getSnapshot, drawer.getServerSnapshot);
}

export function useCart() {
  const current = useSyncExternalStore(lines.subscribe, lines.getSnapshot, lines.getServerSnapshot);
  return useMemo(() => {
    const items: CartItem[] = [];
    for (const line of current) {
      const product = getProduct(line.id);
      if (product) items.push({ product, qty: line.qty, lineTotal: product.price * line.qty });
    }
    const count = items.reduce((n, i) => n + i.qty, 0);
    const subtotal = items.reduce((n, i) => n + i.lineTotal, 0);
    const savings = items.reduce((n, i) => n + ((i.product.compareAt ?? i.product.price) - i.product.price) * i.qty, 0);
    const delivery = count === 0 || subtotal >= site.freeDeliveryThreshold ? 0 : site.deliveryFee;
    const toFreeDelivery = Math.max(0, site.freeDeliveryThreshold - subtotal);
    return { items, count, subtotal, savings, delivery, toFreeDelivery };
  }, [current]);
}
