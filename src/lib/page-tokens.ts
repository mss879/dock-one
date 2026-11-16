import { formatLKR } from "@/lib/format";
import { bankTransferReady, phoneDigits, type PublicStoreSettings } from "@/lib/settings-shared";

/*
 * Store settings inside owner-written pages (CMS pages — 47's policy pages rely on it).
 * `{delivery_fee}`, `{returns_window_days}`, `{email}`… in a page's Markdown become the CURRENT
 * store_settings values whenever the page renders, on the storefront and in the admin preview, so
 * a policy can never disagree with Settings (P6): change the fee once and every page follows.
 *   - A source LINE that uses a token with no value (that setting is empty or switched off) is left
 *     out — put such a fact on its own line (a list item, say).
 *   - Unknown names, and `\{name}`, stay exactly as written.
 *   - Values go in as escaped Markdown text (email, phone and WhatsApp as links), so a setting can
 *     never add formatting or HTML of its own.
 * PLAIN module: the storefront applies it on the server, the admin preview in the browser.
 */

export type PageTokenSettings = Pick<
  PublicStoreSettings,
  | "storeName"
  | "email"
  | "phone"
  | "whatsapp"
  | "address"
  | "businessRegNo"
  | "openingHours"
  | "deliveryFee"
  | "freeDeliveryThreshold"
  | "returnsWindowDays"
  | "pickupEnabled"
  | "pickupAddress"
  | "pickupNote"
  | "warrantyNote"
  | "codEnabled"
  | "codMaxTotal"
  | "bankTransferEnabled"
  | "bankAccountName"
  | "bankName"
  | "bankBranch"
  | "bankAccountNumber"
  | "bankTransferInstructions"
  | "cardPaymentsEnabled"
>;

/** Every token, with the admin's "Formatting help" text. */
export const PAGE_TOKENS = [
  { name: "store_name", help: "the store's name" },
  { name: "address", help: "the store's address" },
  { name: "email", help: "the contact email, as a link" },
  { name: "phone", help: "the phone number, as a link" },
  { name: "whatsapp", help: "the WhatsApp number, as a link" },
  { name: "opening_hours", help: "the opening hours" },
  { name: "business_reg_no", help: "the business registration number" },
  { name: "payment_methods", help: "the payment methods checkout offers right now" },
  { name: "cod_max_total", help: "the cash-on-delivery limit (only while there is one)" },
  { name: "delivery_fee", help: "the delivery fee" },
  { name: "free_delivery_threshold", help: "the order total from which delivery is free" },
  { name: "pickup_address", help: "the showroom pickup address (only while pickup is on)" },
  { name: "pickup_note", help: "the pickup note (only while pickup is on)" },
  { name: "returns_window_days", help: "the returns window in days (only while it is above 0)" },
  { name: "warranty_note", help: "the store's warranty note" },
] as const;

export type PageToken = (typeof PAGE_TOKENS)[number]["name"];
export type PageTokenValues = Record<PageToken, string | null>;

const NAMES: ReadonlySet<string> = new Set(PAGE_TOKENS.map((token) => token.name));
const TOKEN = /(\\?)\{([a-z_]{1,40})\}/g;

/** Every ASCII punctuation mark escaped, so a value is always plain text in the Markdown. */
function plain(value: string): string {
  return value.replace(/[!-/:-@[-`{-~]/g, (ch) => `\\${ch}`);
}

/** Trimmed, on one line (a value never splits the page's lines), escaped; null when empty. */
function text(value: string | null | undefined): string | null {
  const one = value?.replace(/\s*\r?\n\s*/g, ", ").trim();
  return one ? plain(one) : null;
}

function link(label: string, href: string): string {
  return `[${plain(label)}](${href})`;
}

/** "a", "a and b", "a, b and c". */
function sentenceList(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Each token's Markdown for these settings; null = no value (the lines that use it are left out). */
export function pageTokenValues(settings: PageTokenSettings): PageTokenValues {
  const email = settings.email?.trim() || null;
  const phone = settings.phone?.trim() || null;
  const whatsapp = phoneDigits(settings.whatsapp);
  const pickup = settings.pickupEnabled && Boolean(settings.pickupAddress?.trim());
  const methods = [
    settings.codEnabled ? "cash on delivery" : null,
    bankTransferReady(settings) ? "bank transfer" : null,
    settings.cardPaymentsEnabled ? "card payment" : null,
  ].filter((m): m is string => m !== null);
  return {
    store_name: text(settings.storeName),
    address: text(settings.address),
    email: email ? link(email, `mailto:${email}`) : null,
    phone: phone && phoneDigits(phone) ? link(phone, `tel:${phone.replace(/[^\d+]/g, "")}`) : null,
    whatsapp: whatsapp && settings.whatsapp ? link(settings.whatsapp.trim(), `https://wa.me/${whatsapp}`) : null,
    opening_hours: text(settings.openingHours),
    business_reg_no: text(settings.businessRegNo),
    payment_methods: methods.length > 0 ? plain(sentenceList(methods)) : null,
    cod_max_total: settings.codEnabled && settings.codMaxTotal !== null ? plain(formatLKR(settings.codMaxTotal)) : null,
    delivery_fee: plain(formatLKR(settings.deliveryFee)),
    free_delivery_threshold: settings.freeDeliveryThreshold !== null ? plain(formatLKR(settings.freeDeliveryThreshold)) : null,
    pickup_address: pickup ? text(settings.pickupAddress) : null,
    pickup_note: pickup ? text(settings.pickupNote) : null,
    returns_window_days: settings.returnsWindowDays > 0 ? String(settings.returnsWindowDays) : null,
    warranty_note: text(settings.warrantyNote),
  };
}

/** The Markdown with every known token filled in; a line using a token that has no value is dropped. */
export function applyPageTokens(source: string, values: PageTokenValues): string {
  if (!source.includes("{")) return source;
  const lines: string[] = [];
  for (const line of source.split("\n")) {
    let missing = false;
    const filled = line.replace(TOKEN, (match: string, escaped: string, name: string) => {
      if (escaped || !NAMES.has(name)) return match;
      const value = values[name as PageToken];
      if (value === null) missing = true;
      return value ?? "";
    });
    if (!missing) lines.push(filled);
  }
  return lines.join("\n");
}

/** Plain text of a filled-in token string (the page's summary as a meta description). */
export function stripMarkdownEscapes(value: string): string {
  return value.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\\([!-/:-@[-`{-~])/g, "$1");
}
