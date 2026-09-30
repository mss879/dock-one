/**
 * THE order vocabulary (blueprint §9.7, P6). One module for every surface: checkout, the
 * confirmation page, guest tracking, the customer dashboard (WP-D), the admin Orders tab,
 * reports and emails. Plain module (no directive): safe on the server and in client islands.
 *
 * Mirrors supabase/migrations/07_orders.sql (CHECK orders_status_valid / payment vocabularies)
 * and 09_order_rpcs.sql (`_order_status_label`, the assignable statuses of
 * `admin_set_order_status`, the payment transitions of `admin_set_payment_status`).
 * Change the SQL and this file together.
 */

import { safeImageUrl } from "@/lib/catalogue-shared";
import { PAYMENT_METHODS, PAYMENT_STATUSES, type PaymentMethod, type PaymentStatus } from "@/lib/payments/types";
import { normalizeBankAccount, type BankAccount } from "@/lib/settings-shared";

export { PAYMENT_METHODS, PAYMENT_STATUSES, type PaymentMethod, type PaymentStatus };

// ── Order status ─────────────────────────────────────────────────────────────

/** = CHECK orders_status_valid. `processing` / `shipped` exist for the blueprint vocabulary but are never assigned. */
export const ORDER_STATUSES = ["pending", "processing", "accepted", "fulfilled", "shipped", "out_for_delivery", "delivered", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** place_order always starts here. */
export const INITIAL_ORDER_STATUS: OrderStatus = "pending";

/** The operator dropdown — exactly what admin_set_order_status accepts. */
export const ASSIGNABLE_ORDER_STATUSES = ["pending", "accepted", "fulfilled", "out_for_delivery", "delivered", "cancelled"] as const satisfies readonly OrderStatus[];
export type AssignableOrderStatus = (typeof ASSIGNABLE_ORDER_STATUSES)[number];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function isAssignableOrderStatus(value: unknown): value is AssignableOrderStatus {
  return typeof value === "string" && (ASSIGNABLE_ORDER_STATUSES as readonly string[]).includes(value);
}

/** Unknown/blank → "pending" (the safest reading: nothing has happened yet). */
export function normalizeOrderStatus(value: unknown): OrderStatus {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  return isOrderStatus(status) ? status : INITIAL_ORDER_STATUS;
}

// ── Fulfilment ───────────────────────────────────────────────────────────────

/** = CHECK orders_fulfillment_valid. Pickup = showroom collection (no delivery fee, no address). */
export const FULFILLMENTS = ["delivery", "pickup"] as const;
export type OrderFulfillment = (typeof FULFILLMENTS)[number];

export function normalizeFulfillment(value: unknown): OrderFulfillment {
  return value === "pickup" ? "pickup" : "delivery";
}

export const FULFILLMENT_LABELS: Record<OrderFulfillment, string> = {
  delivery: "Home delivery",
  pickup: "Showroom pickup",
};

// ── Labels (the SAME words as _order_status_label in 09_order_rpcs.sql) ──────

const STATUS_LABELS: Record<OrderStatus, string> = {
  pending: "Order placed",
  processing: "Processing",
  accepted: "Accepted",
  fulfilled: "Packed",
  shipped: "Shipped",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

/** Human label, pickup-aware ("Ready for pickup", "Collected") — the words the timeline uses. */
export function orderStatusLabel(status: unknown, fulfillment: unknown = "delivery"): string {
  const s = normalizeOrderStatus(status);
  if (normalizeFulfillment(fulfillment) === "pickup") {
    if (s === "out_for_delivery") return "Ready for pickup";
    if (s === "delivered") return "Collected";
  }
  return STATUS_LABELS[s];
}

// ── Shopper stepper (blueprint §9.7) ─────────────────────────────────────────

export type OrderStepKey = "placed" | "preparing" | "in_transit" | "delivered";
export type OrderStep = { key: OrderStepKey; label: string; pickupLabel: string };

export const ORDER_STEPS: readonly OrderStep[] = [
  { key: "placed", label: "Order placed", pickupLabel: "Order placed" },
  { key: "preparing", label: "Preparing", pickupLabel: "Preparing" },
  { key: "in_transit", label: "Out for delivery", pickupLabel: "Ready for pickup" },
  { key: "delivered", label: "Delivered", pickupLabel: "Collected" },
];

/** Blueprint STEP_BY_STATUS. A cancelled order shows step 0 — render the cancelled state instead of progress. */
export const STEP_BY_STATUS: Record<OrderStatus, number> = {
  pending: 0,
  processing: 0,
  accepted: 1,
  fulfilled: 1,
  shipped: 2,
  out_for_delivery: 2,
  delivered: 3,
  cancelled: 0,
};

export function stepIndexForStatus(status: unknown): number {
  return STEP_BY_STATUS[normalizeOrderStatus(status)];
}

export function orderStepLabel(step: OrderStep, fulfillment: unknown = "delivery"): string {
  return normalizeFulfillment(fulfillment) === "pickup" ? step.pickupLabel : step.label;
}

/** Open = not delivered and not cancelled (the admin metric definition, blueprint §11.3.6). */
export function isOpenOrder(status: unknown): boolean {
  const s = normalizeOrderStatus(status);
  return s !== "delivered" && s !== "cancelled";
}

export function isCompletedOrder(status: unknown): boolean {
  return normalizeOrderStatus(status) === "delivered";
}

export function isCancelledOrder(status: unknown): boolean {
  return normalizeOrderStatus(status) === "cancelled";
}

// ── Payment ──────────────────────────────────────────────────────────────────

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}

export function isPaymentStatus(value: unknown): value is PaymentStatus {
  return typeof value === "string" && (PAYMENT_STATUSES as readonly string[]).includes(value);
}

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cod: "Cash on delivery",
  bank_transfer: "Bank transfer",
};

export function paymentMethodLabel(method: unknown): string {
  return isPaymentMethod(method) ? PAYMENT_METHOD_LABELS[method] : "—";
}

const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending_collection: "Pay on delivery",
  awaiting_transfer: "Awaiting transfer",
  paid: "Paid",
  refunded: "Refunded",
  void: "No payment due",
};

/**
 * Shopper/admin wording of the payment status. A COD order that is collected at the showroom
 * is still "pending_collection" — say "Pay on collection" for pickup orders.
 */
export function paymentStatusLabel(status: unknown, fulfillment: unknown = "delivery"): string {
  if (!isPaymentStatus(status)) return "—";
  if (status === "pending_collection" && normalizeFulfillment(fulfillment) === "pickup") return "Pay on collection";
  return PAYMENT_STATUS_LABELS[status];
}

/** Money is still owed on the order (what the out-for-delivery email calls "amount due"). */
export function isPaymentDue(status: unknown): boolean {
  return status === "pending_collection" || status === "awaiting_transfer";
}

/** What admin_set_payment_status allows from `current` (void only once the order is cancelled). */
export function allowedPaymentTargets(current: unknown, orderStatus: unknown): ("paid" | "refunded" | "void")[] {
  const targets: ("paid" | "refunded" | "void")[] = [];
  if (current === "pending_collection" || current === "awaiting_transfer") targets.push("paid");
  if (current === "paid") targets.push("refunded");
  if (current !== "void" && isCancelledOrder(orderStatus)) targets.push("void");
  return targets;
}

// ── Admin badge tones (one map per vocabulary, ADMIN_KIT §4) ─────────────────

/** = StatusTone in components/admin/ui/StatusBadge (kept as a plain union so this module stays UI-free). */
export type OrderTone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

const STATUS_TONES: Record<OrderStatus, OrderTone> = {
  pending: "warning",
  processing: "info",
  accepted: "info",
  fulfilled: "accent",
  shipped: "accent",
  out_for_delivery: "accent",
  delivered: "success",
  cancelled: "neutral",
};

export function orderStatusTone(status: unknown): OrderTone {
  return STATUS_TONES[normalizeOrderStatus(status)];
}

const PAYMENT_TONES: Record<PaymentStatus, OrderTone> = {
  pending_collection: "warning",
  awaiting_transfer: "warning",
  paid: "success",
  refunded: "neutral",
  void: "neutral",
};

export function paymentStatusTone(status: unknown): OrderTone {
  return isPaymentStatus(status) ? PAYMENT_TONES[status] : "neutral";
}

// ── Order references ─────────────────────────────────────────────────────────

/**
 * What a shopper types → "DO-10001" (mirror of `_normalize_order_ref` for the order-number
 * shapes: "DO-10001", "do-10001", "#10001", "10001", "DO 10001"). Null when it isn't one.
 */
export function normalizeOrderRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase();
  const match = /^#?(?:DO)?[-\s]?([0-9]{1,12})$/.exec(v);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) && n > 0 ? `DO-${n}` : null;
}

/** "DO-10001" — the id format of orders.id (CHECK orders_id_format). */
export function isOrderId(value: unknown): value is string {
  return typeof value === "string" && /^DO-[0-9]{1,12}$/.test(value);
}

// ── The shopper-safe order view (`_order_view` in 09_order_rpcs.sql) ─────────

export type OrderViewItem = {
  productId: number | null;
  variantId: number | null;
  productName: string;
  brand: string | null;
  variantName: string | null;
  sku: string | null;
  imageUrl: string | null;
  quantity: number;
  /** LKR charged per unit. */
  unitPrice: number;
  lineTotal: number;
};

export type OrderTimelineEntry = { status: string; location: string | null; description: string | null; at: string | null };

/** track_guest_order / view_order payload, normalised (never the street, phone, email or view token). */
export type OrderView = {
  orderId: string;
  status: OrderStatus;
  createdAt: string | null;
  fulfillment: OrderFulfillment;
  subtotal: number;
  shippingFee: number;
  discountCode: string | null;
  discountAmount: number;
  totalPrice: number;
  currency: string;
  exchangeRate: number;
  paymentMethod: PaymentMethod | null;
  paymentStatus: PaymentStatus | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  items: OrderViewItem[];
  timeline: OrderTimelineEntry[];
};

/** view_order extras (the confirmation page). */
export type OrderConfirmationView = OrderView & {
  firstName: string | null;
  /** Delivery orders: city + district only. */
  shipping: { city: string | null; district: string | null } | null;
  /** Pickup orders: the showroom address/note from store settings. */
  pickup: { address: string | null; note: string | null } | null;
  /** The account to pay into — only while a bank transfer is awaited. */
  bankTransfer: BankAccount | null;
};

type Row = Record<string, unknown>;

const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};
const nullableId = (value: unknown): number | null => {
  const n = num(value, Number.NaN);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const text = (value: unknown, max = 2000): string | null => {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t ? t.slice(0, max) : null;
};
const isRow = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Only an https tracking link is ever rendered as a link (07's CHECK allows nothing else). */
export function safeTrackingUrl(value: unknown): string | null {
  const url = text(value, 500);
  if (!url || !/^https:\/\/[^\s\\]+$/.test(url)) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function normalizeOrderView(raw: unknown): OrderView | null {
  if (!isRow(raw)) return null;
  const orderId = text(raw.order_id, 20);
  if (!orderId || !isOrderId(orderId)) return null;
  const items = Array.isArray(raw.items)
    ? raw.items.filter(isRow).map(
        (item): OrderViewItem => ({
          productId: nullableId(item.product_id),
          variantId: nullableId(item.variant_id),
          productName: text(item.product_name, 200) ?? "Item",
          brand: text(item.brand, 80),
          variantName: text(item.variant_name, 120),
          sku: text(item.sku, 64),
          imageUrl: safeImageUrl(item.image_url),
          quantity: Math.max(0, Math.trunc(num(item.quantity))),
          unitPrice: num(item.unit_price),
          lineTotal: num(item.line_total, num(item.unit_price) * num(item.quantity)),
        }),
      )
    : [];
  const timeline = Array.isArray(raw.timeline)
    ? raw.timeline.filter(isRow).map(
        (entry): OrderTimelineEntry => ({
          status: text(entry.status, 80) ?? "Update",
          location: text(entry.location, 120),
          description: text(entry.description, 1000),
          at: text(entry.at, 64),
        }),
      )
    : [];
  return {
    orderId,
    status: normalizeOrderStatus(raw.status),
    createdAt: text(raw.created_at, 64),
    fulfillment: normalizeFulfillment(raw.fulfillment),
    subtotal: num(raw.subtotal),
    shippingFee: num(raw.shipping_fee),
    discountCode: text(raw.discount_code, 64),
    discountAmount: num(raw.discount_amount),
    totalPrice: num(raw.total_price),
    currency: text(raw.currency, 3) ?? "LKR",
    exchangeRate: num(raw.exchange_rate, 1),
    paymentMethod: isPaymentMethod(raw.payment_method) ? raw.payment_method : null,
    paymentStatus: isPaymentStatus(raw.payment_status) ? raw.payment_status : null,
    trackingNumber: text(raw.tracking_number, 100),
    trackingUrl: safeTrackingUrl(raw.tracking_url),
    items,
    timeline,
  };
}

export function normalizeOrderConfirmation(raw: unknown): OrderConfirmationView | null {
  const view = normalizeOrderView(raw);
  if (!view || !isRow(raw)) return null;
  const shipping = isRow(raw.shipping) ? { city: text(raw.shipping.city, 120), district: text(raw.shipping.district, 60) } : null;
  const pickup = isRow(raw.pickup) ? { address: text(raw.pickup.address, 500), note: text(raw.pickup.note, 500) } : null;
  return {
    ...view,
    firstName: text(raw.first_name, 255),
    shipping,
    pickup,
    bankTransfer: normalizeBankAccount(raw.bank_transfer),
  };
}

/** `{ "throttled": true }` from track_guest_order / view_order — answered like a miss (P14). */
export function isThrottledView(raw: unknown): boolean {
  return isRow(raw) && raw.throttled === true;
}

// ── Dates (Asia/Colombo, identical on server and client) ─────────────────────

const ORDER_DATE = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Colombo", day: "numeric", month: "short", year: "numeric" });
const ORDER_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Colombo",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "22 Sep 2026, 14:05" in Sri Lanka time (fixed locale + zone, so SSR and hydration agree). "" when invalid. */
export function formatOrderDate(value: string | null | undefined, withTime = true): string {
  if (!value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  return (withTime ? ORDER_DATE_TIME : ORDER_DATE).format(new Date(time));
}
