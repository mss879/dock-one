import "server-only";
import { recoveryRestorePath, recoveryStopPath, parseRecoveryItems, type RecoveryCartItem, type RecoveryStageNumber, RECOVERY_STAGE_COUNT } from "@/lib/cart-recovery";
import { absoluteUrl } from "@/lib/env";
import { emailButton, emailHref, emailLabel, emailNote, emailParagraph, emailRows, emailShell, esc, textFromLines, EMAIL_COLORS } from "@/lib/email/layout";
import type { EmailMessage } from "@/lib/email/send";
import { greetingName, orderFooterLines } from "@/lib/email/templates/orders";
import { formatLKR } from "@/lib/format";
import type { StoreSettings } from "@/lib/settings-shared";

/**
 * The three abandoned-cart reminders (blueprint §9.9 + §9.10): stage-specific copy, the restore
 * link (/recover?token=) and the stop link (/recover/stop?token= — a page that ASKS, then POSTs,
 * because mail scanners follow GET links, §6.6).
 *
 * Every fact comes from the row the recovery claim returned (13_abandoned_carts.sql): item names
 * and prices are the catalogue's values at capture time — never text the browser sent (P4) — and
 * the first name is reduced to letters before it is used (§6.6). No urgency, stock or discount
 * claims (P15): the only promise made is the one the system keeps — the link restores the items,
 * and prices are confirmed at checkout.
 */

/** One claimed cart — built by `recoveryCartFromClaim` from the claim's jsonb (typed constructor, lesson 34). */
export type RecoveryCart = {
  id: string;
  email: string;
  firstName: string | null;
  token: string;
  items: RecoveryCartItem[];
  /** LKR Σ price × quantity at capture time. */
  total: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * One element of claim_abandoned_carts_for_recovery's array → RecoveryCart, or null when a fact
 * the email needs is missing (the job then skips it rather than mail something wrong). `id` is
 * returned separately so the job can name an unusable row in its log.
 */
export function recoveryCartFromClaim(raw: unknown): { id: string | null; cart: RecoveryCart | null } {
  if (!isRow(raw)) return { id: null, cart: null };
  const id = typeof raw.id === "string" && UUID.test(raw.id) ? raw.id : null;
  const email = typeof raw.email === "string" ? raw.email.trim() : "";
  const token = typeof raw.token === "string" && UUID.test(raw.token) ? raw.token : null;
  const items = parseRecoveryItems(raw.cart_items);
  const total = typeof raw.total_price === "number" ? raw.total_price : Number(raw.total_price);
  if (!id || !email || !token || items.length === 0) return { id, cart: null };
  return {
    id,
    cart: {
      id,
      email,
      firstName: typeof raw.first_name === "string" ? raw.first_name : null,
      token,
      items,
      total: Number.isFinite(total) && total > 0 ? total : items.reduce((sum, item) => sum + item.price * item.quantity, 0),
    },
  };
}

type StageCopy = { subject: string; eyebrow: string; heading: string; intro: (name: string | null, store: string) => string; button: string };

const COPY: Record<RecoveryStageNumber, StageCopy> = {
  1: {
    subject: "You left something in your basket",
    eyebrow: "Your saved basket",
    heading: "Still want these?",
    intro: (name, store) =>
      `${name ? `Hi ${name}, you` : "You"} started a checkout at ${store} but didn't finish. We saved your basket, so you can pick up where you left off.`,
    button: "Restore my basket",
  },
  2: {
    subject: "Your basket is still saved",
    eyebrow: "Your saved basket",
    heading: "Your basket is waiting",
    intro: (name, store) =>
      `${name ? `Hi ${name}, the` : "The"} items you chose at ${store} are still in your saved basket. Restore it in one tap and check out when you're ready.`,
    button: "Restore my basket",
  },
  3: {
    subject: "Last reminder about your basket",
    eyebrow: `Reminder ${RECOVERY_STAGE_COUNT} of ${RECOVERY_STAGE_COUNT}`,
    heading: "Last reminder",
    intro: (name, store) =>
      `${name ? `Hi ${name}, this` : "This"} is the last email ${store} will send you about this basket. The link below still restores it.`,
    button: "Restore my basket",
  },
};

const spacer = `<div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>`;

const itemLabel = (item: RecoveryCartItem) =>
  `${item.name}${item.variantName && item.variantName !== "Standard" ? ` (${item.variantName})` : ""} × ${item.quantity}`;

/** Reminder `stage` (1–3) for one claimed cart. */
export function recoveryEmail(stage: RecoveryStageNumber, cart: RecoveryCart, settings: StoreSettings): EmailMessage {
  const copy = COPY[stage];
  const name = greetingName(cart.firstName);
  const restoreUrl = absoluteUrl(recoveryRestorePath(cart.token));
  const stopUrl = absoluteUrl(recoveryStopPath(cart.token));
  const intro = copy.intro(name, settings.storeName);
  const confirmNote = "Prices and availability are confirmed at checkout.";
  const stopLine =
    stage === RECOVERY_STAGE_COUNT
      ? "To stop basket reminders for good, use the link below (it asks you to confirm first)."
      : "Don't want these reminders? Stop them with the link below (it asks you to confirm first).";
  const footer = orderFooterLines(settings);

  const html = emailShell({
    preheader: `${cart.items.length === 1 ? "1 item" : `${cart.items.length} items`} saved — ${formatLKR(cart.total)}`,
    eyebrow: copy.eyebrow,
    heading: copy.heading,
    intro,
    bodyHtml: [
      emailLabel("In your basket"),
      `<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>`,
      emailRows([
        ...cart.items.map((item) => ({ label: itemLabel(item), value: formatLKR(item.price * item.quantity) })),
        { label: "Basket total when you left", value: formatLKR(cart.total), strong: true },
      ]),
      spacer,
      emailNote(confirmNote, "violet"),
      emailButton(restoreUrl, copy.button),
      spacer,
      emailParagraph(stopLine, EMAIL_COLORS.mute),
      `<p style="margin:0 0 16px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;"><a href="${esc(emailHref(stopUrl))}" style="color:${EMAIL_COLORS.violetInk};text-decoration:underline;">Stop basket reminders</a></p>`,
    ].join(""),
    footerLines: footer,
  });

  const text = textFromLines(
    [
      copy.heading,
      "",
      intro,
      "",
      "In your basket:",
      ...cart.items.map((item) => `- ${itemLabel(item)}: ${formatLKR(item.price * item.quantity)}`),
      `Basket total when you left: ${formatLKR(cart.total)}`,
      "",
      confirmNote,
      "",
      `${copy.button}: ${restoreUrl}`,
      "",
      stopLine,
      `Stop basket reminders: ${stopUrl}`,
    ],
    footer,
  );

  return { to: cart.email, subject: `${copy.subject} — ${settings.storeName}`, html, text };
}
