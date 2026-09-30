"use client";

import { formatDateTime } from "@/lib/admin/dates";
import { html, printDocument } from "@/lib/admin/print";
import { formatLKR, formatLKRExact } from "@/lib/format";
import { FULFILLMENT_LABELS, paymentMethodLabel, paymentStatusLabel } from "@/lib/orders";
import { bankAccountFromSettings, type StoreSettings } from "@/lib/settings-shared";
import { addressLines, customerName, type AdminOrder, type AdminOrderItem } from "./types";

/**
 * Invoice and packing slip for one order, printed through the kit (blueprint §11.3.8: an escaped
 * HTML document in a sandboxed iframe → the browser's print / "Save as PDF"). Every value goes
 * through the `html` tag, which escapes it. Store facts come from store_settings and are printed
 * only when set (P15: no placeholder legal numbers).
 */

const STYLES = `
.doc-head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; border-bottom: 2px solid #0b0b0c; padding-bottom: 10px; margin-bottom: 16px; }
.doc-head .store b { font-size: 16px; text-transform: uppercase; letter-spacing: 0.02em; }
.doc-head .store p, .party p { margin: 2px 0 0; }
.doc-title { text-align: right; }
.doc-title h1 { margin: 0; font-size: 22px; text-transform: uppercase; }
.parties { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin: 12px 0 8px; }
.totals { width: 48%; margin-left: auto; margin-top: 10px; }
.totals td { border-bottom: 1px solid #e2e2de; }
.totals tr.total td { border-top: 2px solid #0b0b0c; border-bottom: 0; font-weight: 700; font-size: 13px; }
.note { margin-top: 14px; padding: 8px 10px; background: #f3ffd2; }
.foot { margin-top: 22px; }
.pay { margin-top: 14px; padding: 10px 12px; border: 1px solid #0b0b0c; }
.pay table { width: auto; margin-top: 4px; }
.pay td { border: 0; padding: 2px 16px 2px 0; }
`;

function storeBlock(settings: StoreSettings) {
  const lines = [settings.address, settings.phone ? `Tel ${settings.phone}` : null, settings.email, settings.businessRegNo ? `Business reg. no. ${settings.businessRegNo}` : null].filter(
    (line): line is string => Boolean(line),
  );
  return html`<div class="store"><b>${settings.storeName}</b>${lines.map((line) => html`<p>${line}</p>`)}</div>`;
}

/** An unpaid bank-transfer invoice says where to pay: the store's account, the amount and the reference. */
function payByTransfer(order: AdminOrder, settings: StoreSettings) {
  const account = order.paymentMethod === "bank_transfer" && order.paymentStatus === "awaiting_transfer" ? bankAccountFromSettings(settings) : null;
  if (!account) return "";
  const rows: [string, string][] = [
    ["Amount (LKR)", formatLKRExact(order.totalPrice)],
    ["Reference", order.id],
    ["Bank", account.bankName],
    ...(account.branch ? ([["Branch", account.branch]] as [string, string][]) : []),
    ["Account name", account.accountName],
    ["Account number", account.accountNumber],
  ];
  return html`<div class="pay"><span class="label">Pay by bank transfer</span>
    <table><tbody>${rows.map(([label, value]) => html`<tr><td class="label">${label}</td><td class="mono"><b>${value}</b></td></tr>`)}</tbody></table>
    ${account.instructions ? html`<p>${account.instructions}</p>` : ""}</div>`;
}

function deliverTo(order: AdminOrder) {
  const lines = order.fulfillment === "pickup" ? ["Showroom pickup"] : addressLines(order.address);
  return html`<div class="party"><span class="label">${order.fulfillment === "pickup" ? "Collection" : "Deliver to"}</span>
    <p><b>${customerName(order)}</b></p>
    <p>${order.phone}</p>
    ${lines.map((line) => html`<p>${line}</p>`)}</div>`;
}

export function printInvoice(order: AdminOrder, items: AdminOrderItem[], settings: StoreSettings): Promise<boolean> {
  const rows = items.map(
    (item) => html`<tr>
      <td>${item.productName}${item.variantName && item.variantName !== "Standard" ? html` <span class="label">(${item.variantName})</span>` : ""}</td>
      <td class="mono">${item.sku ?? ""}</td>
      <td class="right num">${item.quantity}</td>
      <td class="right num">${formatLKR(item.unitPrice)}</td>
      <td class="right num">${formatLKR(item.unitPrice * item.quantity)}</td>
    </tr>`,
  );
  const body = html`
    <header class="doc-head">${storeBlock(settings)}
      <div class="doc-title"><h1>Invoice</h1><p class="mono">${order.id}</p><p>${formatDateTime(order.createdAt, "date")}</p></div>
    </header>
    <div class="parties">
      <div class="party"><span class="label">Bill to</span><p><b>${customerName(order)}</b></p><p>${order.email}</p><p>${order.phone}</p></div>
      ${deliverTo(order)}
    </div>
    <table>
      <thead><tr><th>Item</th><th>SKU</th><th class="right">Qty</th><th class="right">Unit (LKR)</th><th class="right">Amount (LKR)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <table class="totals"><tbody>
      <tr><td>Subtotal</td><td class="right num">${formatLKR(order.subtotal)}</td></tr>
      ${order.discountAmount > 0 ? html`<tr><td>Discount${order.discountCode ? ` (${order.discountCode})` : ""}</td><td class="right num">− ${formatLKR(order.discountAmount)}</td></tr>` : ""}
      <tr><td>${FULFILLMENT_LABELS[order.fulfillment]}</td><td class="right num">${order.shippingFee > 0 ? formatLKR(order.shippingFee) : "Free"}</td></tr>
      <tr class="total"><td>Total (LKR)</td><td class="right num">${formatLKR(order.totalPrice)}</td></tr>
    </tbody></table>
    ${payByTransfer(order, settings)}
    <p class="foot"><span class="label">Payment</span> ${paymentMethodLabel(order.paymentMethod)} · ${paymentStatusLabel(order.paymentStatus, order.fulfillment)}${
      order.paymentRef ? html` · Ref ${order.paymentRef}` : ""
    }</p>`;
  return printDocument({ title: `Invoice ${order.id} — ${settings.storeName}`, body, styles: STYLES });
}

export function printPackingSlip(order: AdminOrder, items: AdminOrderItem[], settings: StoreSettings): Promise<boolean> {
  const rows = items.map(
    (item) => html`<tr>
      <td>${item.productName}${item.variantName && item.variantName !== "Standard" ? html` <span class="label">(${item.variantName})</span>` : ""}</td>
      <td class="mono">${item.sku ?? ""}</td>
      <td class="right num">${item.quantity}</td>
      <td class="center">☐</td>
    </tr>`,
  );
  const body = html`
    <header class="doc-head">${storeBlock(settings)}
      <div class="doc-title"><h1>Packing slip</h1><p class="mono">${order.id}</p><p>${formatDateTime(order.createdAt, "date")}</p></div>
    </header>
    <div class="parties">${deliverTo(order)}
      <div class="party"><span class="label">Payment</span><p>${paymentMethodLabel(order.paymentMethod)}</p><p>${paymentStatusLabel(order.paymentStatus, order.fulfillment)}</p>
      ${order.paymentMethod === "cod" && (order.paymentStatus === "pending_collection") ? html`<p><b>Collect ${formatLKR(order.totalPrice)}</b></p>` : ""}</div>
    </div>
    <table>
      <thead><tr><th>Item</th><th>SKU</th><th class="right">Qty</th><th class="center" style="width:40px">Packed</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${order.customerNote ? html`<p class="note"><span class="label">Customer note</span><br>${order.customerNote}</p>` : ""}
    ${order.trackingNumber ? html`<p class="foot"><span class="label">Tracking</span> ${order.trackingNumber}</p>` : ""}`;
  return printDocument({ title: `Packing slip ${order.id} — ${settings.storeName}`, body, styles: STYLES });
}
