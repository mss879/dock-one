import "server-only";
import { absoluteUrl } from "@/lib/env";
import { serverEnv } from "@/lib/env.server";
import { formatLKR, formatLKRExact } from "@/lib/format";
import {
  emailButton,
  emailLabel,
  emailNote,
  emailParagraph,
  emailRows,
  emailShell,
  textFromLines,
  EMAIL_COLORS,
} from "@/lib/email/layout";
import type { EmailMessage } from "@/lib/email/send";
import {
  isPaymentMethod,
  isPaymentStatus,
  normalizeFulfillment,
  paymentMethodLabel,
  safeTrackingUrl,
  type OrderFulfillment,
  type PaymentMethod,
  type PaymentStatus,
} from "@/lib/orders";
import { bankAccountFromSettings, type StoreSettings } from "@/lib/settings-shared";

/**
 * The order emails of blueprint §9.9 — exactly four:
 *   1. order confirmation   (after place_order commits)      → the shopper
 *   2. new-order alert      (same moment, with phone+address) → the owner
 *   3. out for delivery     (admin status change: tracking reference, COD amount due)
 *   4. delivered            (admin status change: the 48 h issue window)
 *
 * Payloads are built by TYPED CONSTRUCTORS from the RPC results (blueprint §14 lesson 34: a
 * renamed optional field once silently dropped the phone from every owner alert). Every value
 * is escaped by the layout helpers. Shopper-bound mail never repeats free text the requester
 * typed (note, street) — only facts the database produced — so the checkout can't be used as an
 * open mailer (lesson 10); the first name is reduced to letters before it is used.
 */

// ── Payloads ─────────────────────────────────────────────────────────────────

export type OrderEmailItem = {
  name: string;
  brand: string | null;
  variantName: string | null;
  sku: string | null;
  quantity: number;
  /** LKR charged per unit. */
  unitPrice: number;
  lineTotal: number;
};

export type OrderEmailAddress = { street: string; city: string; district: string; postalCode: string | null };

/** What place_order returned (09_order_rpcs.sql §3) — the one source for both checkout emails. */
export type PlacedOrder = {
  orderId: string;
  viewToken: string;
  createdAt: string | null;
  email: string;
  firstName: string;
  lastName: string | null;
  phone: string;
  fulfillment: OrderFulfillment;
  /** Delivery orders only. */
  address: OrderEmailAddress | null;
  customerNote: string | null;
  items: OrderEmailItem[];
  subtotal: number;
  shippingFee: number;
  discountCode: string | null;
  discountAmount: number;
  total: number;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  /** The display currency the shopper saw (recorded only — the charge is LKR). */
  currency: string;
  exchangeRate: number;
};

/** What admin_set_order_status returned — enough for the two status emails. */
export type OrderStatusNotice = {
  orderId: string;
  email: string;
  firstName: string | null;
  fulfillment: OrderFulfillment;
  paymentMethod: PaymentMethod | null;
  paymentStatus: PaymentStatus | null;
  /** LKR still to pay (0 once paid/refunded/void). */
  amountDue: number;
  trackingNumber: string | null;
  trackingUrl: string | null;
};

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};
const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/** Letters, marks, apostrophes, hyphens and spaces only (blueprint §6.6) — safe to greet with. */
export function greetingName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[^\p{L}\p{M}' -]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return clean || null;
}

function itemsFrom(raw: unknown): OrderEmailItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRow).map((item) => {
    const quantity = Math.max(0, Math.trunc(num(item.quantity)));
    const unitPrice = num(item.unit_price);
    return {
      name: text(item.product_name, 200) ?? "Item",
      brand: text(item.brand, 80),
      variantName: text(item.variant_name, 120),
      sku: text(item.sku, 64),
      quantity,
      unitPrice,
      lineTotal: num(item.line_total, unitPrice * quantity),
    };
  });
}

/** place_order's jsonb → PlacedOrder, or null when a required fact is missing (then no email is sent). */
export function placedOrderFromRpc(raw: unknown): PlacedOrder | null {
  if (!isRow(raw)) return null;
  const orderId = text(raw.order_id, 20);
  const viewToken = text(raw.view_token, 64);
  const email = text(raw.email, 255);
  const phone = text(raw.phone, 50);
  const firstName = text(raw.first_name, 255);
  if (!orderId || !viewToken || !email || !phone || !firstName) return null;
  if (!isPaymentMethod(raw.payment_method) || !isPaymentStatus(raw.payment_status)) return null;
  const fulfillment = normalizeFulfillment(raw.fulfillment);
  const shipping = isRow(raw.shipping_address) ? raw.shipping_address : {};
  const street = text(shipping.street, 500);
  const city = text(shipping.city, 120);
  const district = text(shipping.district, 60);
  return {
    orderId,
    viewToken,
    createdAt: text(raw.created_at, 64),
    email,
    firstName,
    lastName: text(raw.last_name, 255),
    phone,
    fulfillment,
    address: fulfillment === "delivery" && street && city && district ? { street, city, district, postalCode: text(shipping.postal_code, 20) } : null,
    customerNote: text(raw.customer_note, 1000),
    items: itemsFrom(raw.items),
    subtotal: num(raw.subtotal),
    shippingFee: num(raw.shipping_fee),
    discountCode: text(raw.discount_code, 64),
    discountAmount: num(raw.discount_amount),
    total: num(raw.total),
    paymentMethod: raw.payment_method,
    paymentStatus: raw.payment_status,
    currency: text(raw.currency, 3) ?? "LKR",
    exchangeRate: num(raw.exchange_rate, 1),
  };
}

/** admin_set_order_status's jsonb → OrderStatusNotice, or null when there is nobody to write to. */
export function orderStatusNoticeFromRpc(raw: unknown): OrderStatusNotice | null {
  if (!isRow(raw)) return null;
  const orderId = text(raw.order_id, 20);
  const email = text(raw.email, 255);
  if (!orderId || !email) return null;
  return {
    orderId,
    email,
    firstName: text(raw.first_name, 255),
    fulfillment: normalizeFulfillment(raw.fulfillment),
    paymentMethod: isPaymentMethod(raw.payment_method) ? raw.payment_method : null,
    paymentStatus: isPaymentStatus(raw.payment_status) ? raw.payment_status : null,
    amountDue: Math.max(0, num(raw.amount_due)),
    trackingNumber: text(raw.tracking_number, 100),
    trackingUrl: safeTrackingUrl(raw.tracking_url),
  };
}

// ── Shared pieces ────────────────────────────────────────────────────────────

/** Contact lines for the footer — only what the owner has set (P15: nothing invented). */
export function orderFooterLines(settings: StoreSettings): string[] {
  const lines: string[] = [];
  if (settings.phone) lines.push(`Call ${settings.phone}`);
  if (settings.whatsapp && settings.whatsapp !== settings.phone) lines.push(`WhatsApp ${settings.whatsapp}`);
  if (settings.email) lines.push(settings.email);
  if (settings.address) lines.push(settings.address);
  if (settings.businessRegNo) lines.push(`Business reg. no. ${settings.businessRegNo}`);
  return lines;
}

const itemLabel = (item: OrderEmailItem) =>
  `${item.name}${item.variantName && item.variantName !== "Standard" ? ` (${item.variantName})` : ""} × ${item.quantity}`;

function itemsHtml(items: OrderEmailItem[]): string {
  return `${emailLabel("Items")}<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>${emailRows(
    items.map((item) => ({ label: itemLabel(item), value: formatLKR(item.lineTotal) })),
  )}`;
}

function totalsRows(order: Pick<PlacedOrder, "subtotal" | "shippingFee" | "discountCode" | "discountAmount" | "total" | "fulfillment">) {
  const rows: { label: string; value: string; strong?: boolean }[] = [{ label: "Subtotal", value: formatLKR(order.subtotal) }];
  if (order.discountAmount > 0) rows.push({ label: order.discountCode ? `Discount (${order.discountCode})` : "Discount", value: `− ${formatLKR(order.discountAmount)}` });
  rows.push({
    label: order.fulfillment === "pickup" ? "Showroom pickup" : "Delivery",
    value: order.shippingFee > 0 ? formatLKR(order.shippingFee) : "Free",
  });
  rows.push({ label: "Total (LKR)", value: formatLKR(order.total), strong: true });
  return rows;
}

const spacer = `<div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>`;

/** "Pay Rs. 12,900 in cash when …" / the bank account to pay into / pickup address — the "what happens next" block. */
function paymentSteps(order: Pick<PlacedOrder, "orderId" | "total" | "fulfillment" | "paymentMethod">, settings: StoreSettings): { html: string; text: string[] } {
  const amount = formatLKR(order.total);
  if (order.paymentMethod === "bank_transfer") {
    const account = bankAccountFromSettings(settings);
    const exact = formatLKRExact(order.total);
    if (!account) {
      const line = `Please transfer ${exact}, with your order number ${order.orderId} as the payment reference. Our bank details are on your order page (the button below).`;
      return { html: emailNote(line, "lime"), text: [line] };
    }
    const intro = `Please transfer ${exact} to the account below, with your order number ${order.orderId} as the payment reference.`;
    const rows = [
      { label: "Amount (LKR)", value: exact, strong: true },
      { label: "Reference", value: order.orderId, strong: true },
      { label: "Bank", value: account.bankName },
      ...(account.branch ? [{ label: "Branch", value: account.branch }] : []),
      { label: "Account name", value: account.accountName },
      { label: "Account number", value: account.accountNumber, strong: true },
    ];
    const after = "When the money reaches us, we'll mark your order as paid — you'll see it on your order page.";
    return {
      html:
        emailNote(intro, "lime") +
        `${emailLabel("Bank transfer details")}<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>${emailRows(rows)}${spacer}` +
        (account.instructions ? emailParagraph(account.instructions) : "") +
        emailParagraph(after, EMAIL_COLORS.mute),
      text: [intro, "", "Bank transfer details:", ...rows.map((row) => `${row.label}: ${row.value}`), ...(account.instructions ? ["", account.instructions] : []), "", after],
    };
  }
  const line =
    order.fulfillment === "pickup"
      ? `Pay ${amount} in cash when you collect your order at the showroom.`
      : `Pay ${amount} in cash when your order is delivered.`;
  return { html: emailNote(line, "lime"), text: [line] };
}

function pickupBlock(settings: StoreSettings): { html: string; text: string[] } {
  if (!settings.pickupAddress) return { html: "", text: [] };
  const lines = [settings.pickupAddress, settings.pickupNote].filter((line): line is string => Boolean(line));
  return {
    html: `${emailLabel("Showroom pickup")}<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>${emailParagraph(lines.join("\n"))}`,
    text: ["Showroom pickup:", ...lines],
  };
}

// ── 1. Order confirmation (shopper) ──────────────────────────────────────────

export function orderConfirmationEmail(order: PlacedOrder, settings: StoreSettings): EmailMessage {
  const name = greetingName(order.firstName);
  const trackUrl = absoluteUrl("/track");
  const viewUrl = absoluteUrl(`/order/${encodeURIComponent(order.orderId)}?t=${encodeURIComponent(order.viewToken)}`);
  const payment = paymentSteps(order, settings);
  const pickup = order.fulfillment === "pickup" ? pickupBlock(settings) : { html: "", text: [] };
  const heading = "Order received";
  const intro = `${name ? `Thanks, ${name}. ` : "Thanks. "}We have received your order ${order.orderId}.`;

  const html = emailShell({
    preheader: `Order ${order.orderId} — ${formatLKR(order.total)} (${paymentMethodLabel(order.paymentMethod)})`,
    eyebrow: `Order ${order.orderId}`,
    heading,
    intro,
    bodyHtml: [
      payment.html,
      pickup.html,
      itemsHtml(order.items),
      spacer,
      emailRows(totalsRows(order)),
      spacer,
      emailRows([
        { label: "Payment", value: paymentMethodLabel(order.paymentMethod) },
        { label: "Fulfilment", value: order.fulfillment === "pickup" ? "Showroom pickup" : "Home delivery" },
      ]),
      spacer,
      emailButton(viewUrl, "View your order"),
      emailParagraph(`Track it any time at ${trackUrl} with your order number and this email address.`, EMAIL_COLORS.mute),
    ].join(""),
    footerLines: orderFooterLines(settings),
  });

  const text = textFromLines(
    [
      `${heading} — ${order.orderId}`,
      "",
      intro,
      "",
      ...payment.text,
      ...(pickup.text.length ? ["", ...pickup.text] : []),
      "",
      "Items:",
      ...order.items.map((item) => `- ${itemLabel(item)}: ${formatLKR(item.lineTotal)}`),
      "",
      ...totalsRows(order).map((row) => `${row.label}: ${row.value}`),
      `Payment: ${paymentMethodLabel(order.paymentMethod)}`,
      "",
      `View your order: ${viewUrl}`,
      `Track it any time: ${trackUrl}`,
    ],
    orderFooterLines(settings),
  );

  return { to: order.email, subject: `Order ${order.orderId} received — ${settings.storeName}`, html, text };
}

// ── 2. New-order alert (owner) — with phone and address ─────────────────────

export function ownerOrderAlertEmail(order: PlacedOrder, settings: StoreSettings, to: string): EmailMessage {
  const adminUrl = absoluteUrl(`/admin?tab=orders&order=${encodeURIComponent(order.orderId)}`);
  const customer = [order.firstName, order.lastName].filter(Boolean).join(" ");
  const addressLines = order.address
    ? [order.address.street, order.address.city, `${order.address.district} district`, order.address.postalCode].filter((line): line is string => Boolean(line))
    : [];
  const contactRows = [
    { label: "Customer", value: customer },
    { label: "Email", value: order.email },
    { label: "Phone", value: order.phone },
    { label: "Fulfilment", value: order.fulfillment === "pickup" ? "Showroom pickup" : "Home delivery" },
    { label: "Payment", value: paymentMethodLabel(order.paymentMethod) },
  ];
  if (order.currency !== "LKR") contactRows.push({ label: "Shopper's display currency", value: order.currency });

  const html = emailShell({
    preheader: `${customer} · ${formatLKR(order.total)} · ${paymentMethodLabel(order.paymentMethod)}`,
    eyebrow: "New order",
    heading: order.orderId,
    intro: `${customer} placed an order for ${formatLKR(order.total)}.`,
    bodyHtml: [
      emailRows(contactRows),
      spacer,
      addressLines.length ? `${emailLabel("Deliver to")}<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>${emailParagraph(addressLines.join("\n"))}` : "",
      order.customerNote ? `${emailLabel("Customer note")}<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>${emailNote(order.customerNote, "violet")}` : "",
      itemsHtml(order.items),
      spacer,
      emailRows(totalsRows(order)),
      spacer,
      emailButton(adminUrl, "Open in admin"),
    ].join(""),
  });

  const text = textFromLines([
    `New order ${order.orderId}`,
    "",
    ...contactRows.map((row) => `${row.label}: ${row.value}`),
    ...(addressLines.length ? ["", "Deliver to:", ...addressLines] : []),
    ...(order.customerNote ? ["", "Customer note:", order.customerNote] : []),
    "",
    "Items:",
    ...order.items.map((item) => `- ${itemLabel(item)}${item.sku ? ` [${item.sku}]` : ""}: ${formatLKR(item.lineTotal)}`),
    "",
    ...totalsRows(order).map((row) => `${row.label}: ${row.value}`),
    "",
    `Open in admin: ${adminUrl}`,
  ]);

  return { to, subject: `New order ${order.orderId} — ${formatLKR(order.total)} (${paymentMethodLabel(order.paymentMethod)})`, html, text };
}

// ── 3. Out for delivery / ready for pickup (shopper) ─────────────────────────

export function outForDeliveryEmail(notice: OrderStatusNotice, settings: StoreSettings): EmailMessage {
  const name = greetingName(notice.firstName);
  const pickup = notice.fulfillment === "pickup";
  const due = notice.amountDue > 0 ? formatLKR(notice.amountDue) : null;
  const heading = pickup ? "Ready for pickup" : "Out for delivery";
  const intro = pickup
    ? `${name ? `Hi ${name}, y` : "Y"}our order ${notice.orderId} is ready for pickup at the showroom.`
    : `${name ? `Hi ${name}, y` : "Y"}our order ${notice.orderId} is out for delivery.`;

  // Only cash orders carry an amount due at the door (SQL_NOTES: COD and amount_due > 0).
  const dueLine =
    due && notice.paymentMethod === "cod" ? (pickup ? `Amount to pay when you collect: ${due} (cash).` : `Amount to pay on delivery: ${due} (cash).`) : null;

  const trackingRows = notice.trackingNumber ? [{ label: "Tracking reference", value: notice.trackingNumber }] : [];
  const pickupInfo = pickup ? pickupBlock(settings) : { html: "", text: [] };

  const html = emailShell({
    preheader: `${notice.orderId}: ${heading.toLowerCase()}${due && notice.paymentMethod === "cod" ? ` — ${due} due` : ""}`,
    eyebrow: `Order ${notice.orderId}`,
    heading,
    intro,
    bodyHtml: [
      dueLine ? emailNote(dueLine, "lime") : "",
      trackingRows.length ? emailRows(trackingRows) + spacer : "",
      pickupInfo.html,
      notice.trackingUrl ? emailButton(notice.trackingUrl, "Track with the courier") : emailButton("/track", "Track your order"),
    ].join(""),
    footerLines: orderFooterLines(settings),
  });

  const text = textFromLines(
    [
      `${heading} — ${notice.orderId}`,
      "",
      intro,
      ...(dueLine ? ["", dueLine] : []),
      ...(notice.trackingNumber ? ["", `Tracking reference: ${notice.trackingNumber}`] : []),
      ...(notice.trackingUrl ? [`Track with the courier: ${notice.trackingUrl}`] : [`Track your order: ${absoluteUrl("/track")}`]),
      ...(pickupInfo.text.length ? ["", ...pickupInfo.text] : []),
    ],
    orderFooterLines(settings),
  );

  return { to: notice.email, subject: `${heading}: order ${notice.orderId} — ${settings.storeName}`, html, text };
}

// ── 4. Delivered / collected (shopper) — the 48 h issue window ───────────────

export function deliveredEmail(notice: OrderStatusNotice, settings: StoreSettings): EmailMessage {
  const name = greetingName(notice.firstName);
  const pickup = notice.fulfillment === "pickup";
  const heading = pickup ? "Order collected" : "Order delivered";
  const intro = `${name ? `Hi ${name}, y` : "Y"}our order ${notice.orderId} has been ${pickup ? "collected" : "delivered"}. Thank you for shopping with ${settings.storeName}.`;
  // Only ways that really reach the store: replies (when RESEND_REPLY_TO is set) and the contact
  // details the owner entered in store settings.
  const ways = [
    serverEnv.resendReplyTo ? "reply to this email" : null,
    settings.email ? `email ${settings.email}` : null,
    settings.phone ? `call ${settings.phone}` : null,
    settings.whatsapp && settings.whatsapp !== settings.phone ? `WhatsApp ${settings.whatsapp}` : null,
  ].filter((way): way is string => way !== null);
  const reach = ways.length > 1 ? `${ways.slice(0, -1).join(", ")} or ${ways[ways.length - 1]}` : (ways[0] ?? null);
  const window = `If anything is wrong with your order, tell us within 48 hours${reach ? `: ${reach}` : ""}, quoting ${notice.orderId}.`;

  const html = emailShell({
    preheader: `${notice.orderId} ${pickup ? "collected" : "delivered"} — tell us within 48 hours if anything is wrong`,
    eyebrow: `Order ${notice.orderId}`,
    heading,
    intro,
    bodyHtml: emailNote(window, "violet"),
    footerLines: orderFooterLines(settings),
  });

  const text = textFromLines([`${heading} — ${notice.orderId}`, "", intro, "", window], orderFooterLines(settings));
  return { to: notice.email, subject: `${heading}: ${notice.orderId} — ${settings.storeName}`, html, text };
}
