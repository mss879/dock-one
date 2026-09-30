/**
 * Admin-side order rows (07_orders.sql, read with select("*") under admin RLS so a column from a
 * newer migration can't break the read). DECIMAL may arrive as a string — normalise here.
 */

import {
  normalizeFulfillment,
  normalizeOrderStatus,
  isPaymentMethod,
  isPaymentStatus,
  type OrderFulfillment,
  type OrderStatus,
  type PaymentMethod,
  type PaymentStatus,
} from "@/lib/orders";

export const ORDERS_MIGRATION = "07_orders.sql";
export const ORDER_RPCS_MIGRATION = "09_order_rpcs.sql";

export type AdminOrderAddress = { street: string | null; city: string | null; district: string | null; postalCode: string | null; country: string | null };

export type AdminOrder = {
  id: string;
  customerId: string | null;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string;
  status: OrderStatus;
  fulfillment: OrderFulfillment;
  address: AdminOrderAddress | null;
  customerNote: string | null;
  subtotal: number;
  shippingFee: number;
  discountCode: string | null;
  discountAmount: number;
  totalPrice: number;
  packingCharges: number;
  currency: string;
  exchangeRate: number;
  paymentMethod: PaymentMethod | null;
  paymentStatus: PaymentStatus | null;
  paymentRef: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  itemCount: number | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AdminOrderItem = {
  id: number;
  productId: number | null;
  variantId: number | null;
  productName: string;
  brand: string | null;
  variantName: string | null;
  sku: string | null;
  imageUrl: string | null;
  quantity: number;
  unitPrice: number;
};

export type AdminTimelineRow = { id: number; status: string; location: string | null; description: string | null; createdAt: string | null };

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function addressFrom(value: unknown): AdminOrderAddress | null {
  if (!isRow(value)) return null;
  const address = { street: text(value.street), city: text(value.city), district: text(value.district), postalCode: text(value.postal_code), country: text(value.country) };
  return address.street || address.city || address.district ? address : null;
}

/** An embedded `order_items(count)` comes back as [{ count: n }]. */
function countFrom(value: unknown): number | null {
  if (Array.isArray(value) && isRow(value[0])) return num(value[0].count, 0);
  return null;
}

export function normalizeAdminOrder(row: Row): AdminOrder {
  return {
    id: text(row.id) ?? "",
    customerId: text(row.customer_id),
    email: text(row.email) ?? "",
    firstName: text(row.first_name),
    lastName: text(row.last_name),
    phone: text(row.phone) ?? "",
    status: normalizeOrderStatus(row.status),
    fulfillment: normalizeFulfillment(row.fulfillment),
    address: addressFrom(row.shipping_address),
    customerNote: text(row.customer_note),
    subtotal: num(row.subtotal),
    shippingFee: num(row.shipping_fee),
    discountCode: text(row.discount_code),
    discountAmount: num(row.discount_amount),
    totalPrice: num(row.total_price),
    packingCharges: num(row.packing_charges),
    currency: text(row.currency) ?? "LKR",
    exchangeRate: num(row.exchange_rate, 1),
    paymentMethod: isPaymentMethod(row.payment_method) ? row.payment_method : null,
    paymentStatus: isPaymentStatus(row.payment_status) ? row.payment_status : null,
    paymentRef: text(row.payment_ref),
    trackingNumber: text(row.tracking_number),
    trackingUrl: text(row.tracking_url),
    itemCount: countFrom(row.order_items),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export function normalizeAdminItem(row: Row): AdminOrderItem {
  return {
    id: num(row.id),
    productId: row.product_id == null ? null : num(row.product_id),
    variantId: row.variant_id == null ? null : num(row.variant_id),
    productName: text(row.product_name) ?? "Item",
    brand: text(row.brand),
    variantName: text(row.variant_name),
    sku: text(row.sku),
    imageUrl: text(row.image_url),
    quantity: num(row.quantity),
    unitPrice: num(row.unit_price),
  };
}

export function normalizeTimelineRow(row: Row): AdminTimelineRow {
  return { id: num(row.id), status: text(row.status) ?? "Update", location: text(row.location), description: text(row.description), createdAt: text(row.created_at) };
}

export function customerName(order: Pick<AdminOrder, "firstName" | "lastName">): string {
  return [order.firstName, order.lastName].filter(Boolean).join(" ") || "—";
}

export function addressLines(address: AdminOrderAddress | null): string[] {
  if (!address) return [];
  return [address.street, address.city, address.district ? `${address.district} district` : null, address.postalCode, address.country].filter((line): line is string => Boolean(line));
}
