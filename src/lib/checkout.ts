/**
 * Checkout contracts shared by the client islands and the route handlers (blueprint §9.4,
 * BUILD_SPEC §4.6): the zod schemas for /api/checkout, /api/quote, /api/discount and /api/track,
 * the phone rule, the error copy and the quote shape. Plain module (no directive) — it must stay
 * importable by BOTH the browser and the server (never import a "use client" module here).
 *
 * The database is the authority (P1): place_order / quote_order re-validate everything. These
 * schemas only give the shopper fast, identical feedback and keep junk away from the RPCs.
 */

import { z } from "zod";
import { CURRENCY_CODES, type CurrencyCode } from "@/lib/currency-shared";
import { discountMessage, type DiscountVerdict, refusedVerdict, unavailableVerdict, verdictFromSql } from "@/lib/discount-copy";
import { DISTRICTS, normalizeLkPhone } from "@/lib/sri-lanka";
import { MAX_LINES, MAX_QTY } from "@/lib/cart-limits";
import { normalizeOfferCode } from "@/lib/offer-code-shared";
import { PAYMENT_METHODS, type PaymentMethod } from "@/lib/payments/types";
import { FULFILLMENTS, type OrderFulfillment } from "@/lib/orders";

// ── Limits (mirrors of place_order in 09_order_rpcs.sql — change both together, P7) ──

/** = c_max_qty / c_max_lines in place_order/quote_order — one source: src/lib/cart-limits.ts. */
export const CHECKOUT_MAX_QTY = MAX_QTY;
export const CHECKOUT_MAX_LINES = MAX_LINES;

export const CHECKOUT_LIMITS = {
  email: 254,
  name: 255,
  phone: 24,
  street: 500,
  city: 120,
  postalCode: 20,
  note: 1000,
} as const;

export const SHIPPING_COUNTRY = "Sri Lanka";

// ── Codes and phones ─────────────────────────────────────────────────────────

/** = CHECK discounts_code_format (08) — one source: normalizeOfferCode in src/lib/offer-code-shared.ts. */
export const normalizeDiscountCode = normalizeOfferCode;

/**
 * The order phone rule — a MIRROR of `_normalize_phone` in 09_order_rpcs.sql:
 *   1. Sri Lankan numbers exactly as normalizeLkPhone() (src/lib/sri-lanka.ts) → "+94771234567";
 *   2. only if that fails: an international number written with "+" or "00" and a country code
 *      other than 94 → "+<8–15 digits>" (a buyer abroad ordering for delivery here).
 */
export function normalizeOrderPhone(input: unknown): string | null {
  const lk = normalizeLkPhone(input);
  if (lk) return lk;
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > CHECKOUT_LIMITS.phone || /[^\d\s()+.-]/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  const national = trimmed.startsWith("+") ? digits : digits.startsWith("00") ? digits.slice(2) : null;
  if (national && /^[1-9]\d{7,14}$/.test(national) && !national.startsWith("94")) return `+${national}`;
  return null;
}

// ── Copy: the route error map (SQL code → status + words) ────────────────────

/**
 * place_order's machine codes (SQL_NOTES "Route error map for place_order"). The form's field
 * messages below use the SAME words, so a shopper reads one sentence whichever side caught it.
 */
export const CHECKOUT_COPY = {
  invalidEmail: "Please enter a valid email address.",
  invalidName: "Please enter your first name.",
  invalidLastName: "Last names can be up to 255 characters.",
  invalidPhone: "Please enter a valid phone number, e.g. 077 123 4567.",
  invalidAddress: "Please enter your street address, city and district.",
  invalidStreet: "Please enter your street address.",
  invalidCity: "Please enter your city or town.",
  invalidDistrict: "Please choose your district.",
  invalidPostalCode: "Postal codes can be up to 20 characters.",
  invalidNote: "Delivery notes can be up to 1,000 characters.",
  invalidItems: "Your basket couldn't be read. Please refresh the page and try again.",
  invalidQuantity: "You can order up to 10 of each item.",
  invalidFulfillment: "Please choose delivery or showroom pickup.",
  pickupUnavailable: "Showroom pickup isn't available right now. Please choose delivery.",
  unsupportedPayment: "That payment method isn't available right now. Please choose another.",
  invalidCurrency: "We couldn't confirm your display currency. Please refresh and try again.",
  unknownProduct: "An item in your basket is no longer available. Please remove it and try again.",
  storeUnavailable: "Checkout is temporarily unavailable. Please try again shortly.",
  retry: "Please try again.",
  refresh: "Please refresh the page and try again.",
  failed: "We could not place your order. Please try again.",
} as const;

export function outOfStockMessage(label: string): string {
  return `Sorry — “${label}” just sold out or doesn't have enough stock left. Please update your basket.`;
}

export function invalidVariantMessage(name: string): string {
  return `The option you chose for “${name}” is no longer available. Please choose another.`;
}

/** LKR amounts inside route copy are formatted like formatLKR (the client renders numbers through <Price>). */
export function codLimitMessage(maxFormatted: string): string {
  return `Cash on delivery is available for orders up to ${maxFormatted}. Please choose bank transfer.`;
}

// ── Schemas ──────────────────────────────────────────────────────────────────

/** A trimmed text field whose type, and length errors all speak the field's own copy (never zod's). */
const trimmed = (max: number, error: string) => z.string({ error }).trim().max(max, { error });

export const checkoutItemSchema = z.object({
  productId: z.number().int().positive(),
  variantId: z.number().int().positive(),
  qty: z.number().int().min(1).max(CHECKOUT_MAX_QTY),
});
export type CheckoutItem = z.infer<typeof checkoutItemSchema>;

export const shippingSchema = z.object({
  street: trimmed(CHECKOUT_LIMITS.street, CHECKOUT_COPY.invalidStreet).min(1, { error: CHECKOUT_COPY.invalidStreet }),
  city: trimmed(CHECKOUT_LIMITS.city, CHECKOUT_COPY.invalidCity).min(1, { error: CHECKOUT_COPY.invalidCity }),
  district: z.enum(DISTRICTS, { error: CHECKOUT_COPY.invalidDistrict }),
  postal_code: trimmed(CHECKOUT_LIMITS.postalCode, CHECKOUT_COPY.invalidPostalCode).default(""),
  country: z.literal(SHIPPING_COUNTRY).default(SHIPPING_COUNTRY),
});
export type CheckoutShippingInput = z.infer<typeof shippingSchema>;

/** The shopper's own details — what the form validates field by field. */
export const checkoutContactSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(CHECKOUT_LIMITS.email, { error: CHECKOUT_COPY.invalidEmail })
    .pipe(z.email({ error: CHECKOUT_COPY.invalidEmail })),
  firstName: trimmed(CHECKOUT_LIMITS.name, CHECKOUT_COPY.invalidName).min(1, { error: CHECKOUT_COPY.invalidName }),
  lastName: trimmed(CHECKOUT_LIMITS.name, CHECKOUT_COPY.invalidLastName).default(""),
  phone: z.string().trim().refine((value) => normalizeOrderPhone(value) !== null, { error: CHECKOUT_COPY.invalidPhone }),
});

/** POST /api/checkout body (the honeypot `company` is read separately, before this). */
export const checkoutRequestSchema = checkoutContactSchema
  .extend({
    fulfillment: z.enum(FULFILLMENTS, { error: CHECKOUT_COPY.invalidFulfillment }),
    shipping: z.unknown().optional(),
    paymentMethod: z.enum(PAYMENT_METHODS, { error: CHECKOUT_COPY.unsupportedPayment }),
    note: z
      .string()
      .trim()
      .max(CHECKOUT_LIMITS.note, { error: CHECKOUT_COPY.invalidNote })
      .optional()
      .transform((value) => value || null),
    items: z.array(z.unknown()).min(1, { error: CHECKOUT_COPY.invalidItems }).max(CHECKOUT_MAX_LINES, { error: CHECKOUT_COPY.invalidItems }),
    discountCode: z.string().nullish(),
    abandonedCartId: z.string().nullish(),
    currency: z.enum(CURRENCY_CODES as [CurrencyCode, ...CurrencyCode[]], { error: CHECKOUT_COPY.invalidCurrency }),
    exchangeRate: z.number({ error: CHECKOUT_COPY.invalidCurrency }).positive({ error: CHECKOUT_COPY.invalidCurrency }).max(1000, { error: CHECKOUT_COPY.invalidCurrency }),
  })
  .superRefine((value, ctx) => {
    if (value.fulfillment !== "delivery") return;
    const parsed = shippingSchema.safeParse(value.shipping ?? {});
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: ["shipping", ...issue.path.map(String)] });
    }
  });
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

/** Form-field keys used for inline errors. */
export type CheckoutField =
  | "email"
  | "firstName"
  | "lastName"
  | "phone"
  | "fulfillment"
  | "shipping.street"
  | "shipping.city"
  | "shipping.district"
  | "shipping.postal_code"
  | "paymentMethod"
  | "note"
  | "items"
  | "currency";

export type CheckoutFieldErrors = Partial<Record<CheckoutField, string>>;

const FIELD_KEYS: readonly CheckoutField[] = [
  "email",
  "firstName",
  "lastName",
  "phone",
  "fulfillment",
  "shipping.street",
  "shipping.city",
  "shipping.district",
  "shipping.postal_code",
  "paymentMethod",
  "note",
  "items",
  "currency",
];

/** zod issues → { field: first message }. Unknown paths are dropped. */
export function fieldErrorsFrom(issues: readonly { path: readonly PropertyKey[]; message: string }[]): CheckoutFieldErrors {
  const errors: CheckoutFieldErrors = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join(".");
    const field = (key === "exchangeRate" ? "currency" : key.startsWith("items") ? "items" : key) as CheckoutField;
    if (FIELD_KEYS.includes(field) && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}

/** The form's own view of the order it is about to send (before the items are attached). */
export type CheckoutFormValues = {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  fulfillment: OrderFulfillment;
  shipping: { street: string; city: string; district: string; postal_code: string; country: string };
  paymentMethod: PaymentMethod | "";
  note: string;
};

/**
 * Validate the form with the route's own schemas (items/currency are attached at submit). The
 * address is checked separately so every field error shows at once (zod skips an object's
 * refinement while other fields are still invalid).
 */
export function validateCheckoutForm(values: CheckoutFormValues): CheckoutFieldErrors {
  const result = checkoutRequestSchema.safeParse({
    ...values,
    // The address is checked below, field by field (even when a contact field is wrong too). This
    // pass must not run the schema's own delivery-address refinement, which would judge the
    // address it was NOT given (`shipping: undefined`) and reject every delivery order.
    shipping: undefined,
    fulfillment: "pickup",
    paymentMethod: values.paymentMethod || undefined,
    items: [{ productId: 1, variantId: 1, qty: 1 }],
    currency: "LKR",
    exchangeRate: 1,
  });
  const errors = result.success ? {} : fieldErrorsFrom(result.error.issues);
  if (values.fulfillment === "delivery") {
    const address = shippingSchema.safeParse(values.shipping);
    if (!address.success) {
      Object.assign(errors, fieldErrorsFrom(address.error.issues.map((issue) => ({ path: ["shipping", ...issue.path], message: issue.message }))));
    }
  }
  return errors;
}

/** Cart lines → the items array the route accepts (malformed lines are dropped — the route refuses an empty list). */
export function parseCheckoutItems(raw: readonly unknown[]): CheckoutItem[] {
  const items: CheckoutItem[] = [];
  for (const entry of raw) {
    const parsed = checkoutItemSchema.safeParse(entry);
    if (parsed.success) items.push(parsed.data);
  }
  return items;
}

/** POST /api/quote body. */
export const quoteRequestSchema = z.object({
  items: z.array(z.unknown()).max(CHECKOUT_MAX_LINES * 2),
  discountCode: z.string().max(64).nullish(),
  fulfillment: z.enum(FULFILLMENTS).optional(),
});

/** POST /api/discount body. */
export const discountRequestSchema = z.object({
  code: z.string().max(64),
  subtotal: z.number().min(0).max(1_000_000_000).optional(),
});

/** POST /api/track body (order number + email, never in a URL). */
export const trackRequestSchema = z.object({
  order: z.string().trim().min(1).max(40),
  email: z.string().trim().toLowerCase().max(CHECKOUT_LIMITS.email).pipe(z.email()),
});

export const TRACK_NOT_FOUND_MESSAGE = "We couldn't find an order with that number and email. Check both and try again in a few minutes.";

// ── The quote (quote_order → /api/quote → the basket, drawer and checkout summary) ──

export type QuoteLineReason = "unknown_product" | "inactive" | "invalid_variant" | "out_of_stock" | "insufficient_stock";
export type QuoteStock = "ok" | "low" | "out";

export type QuoteLine = {
  /** 1-based position in the request. */
  line: number;
  productId: number | null;
  variantId: number | null;
  /** Clamped 1..10 by SQL. */
  quantity: number;
  /** SQL clamped the quantity → the cart should adopt `quantity`. */
  quantityAdjusted: boolean;
  available: boolean;
  reason: QuoteLineReason | null;
  /** null for hidden products (nothing is revealed about them). */
  productName: string | null;
  brand: string | null;
  slug: string | null;
  imageUrl: string | null;
  variantName: string | null;
  sku: string | null;
  /** LKR, authoritative. */
  unitPrice: number | null;
  compareAtPrice: number | null;
  lineTotal: number | null;
  stock: QuoteStock | null;
  /** Exact level only when low or insufficient. */
  stockLevel: number | null;
};

export type Quote = {
  lines: QuoteLine[];
  /** place_order would accept exactly this basket. */
  orderable: boolean;
  subtotal: number;
  shippingFee: number;
  /** Collapsed to the one refusal copy (P14); null when no code was sent. */
  discount: DiscountVerdict | null;
  discountAmount: number;
  total: number;
  fulfillment: OrderFulfillment;
  deliveryFee: number;
  /** null = delivery is never free. */
  freeDeliveryThreshold: number | null;
  amountToFreeDelivery: number | null;
  pickupAvailable: boolean;
  codAvailable: boolean;
  bankTransferAvailable: boolean;
};

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};
const str = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
const id = (value: unknown): number | null => {
  const n = num(value);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
};
const REASONS: readonly QuoteLineReason[] = ["unknown_product", "inactive", "invalid_variant", "out_of_stock", "insufficient_stock"];
const STOCKS: readonly QuoteStock[] = ["ok", "low", "out"];

function quoteLineFromSql(row: Row): QuoteLine {
  const reason = REASONS.includes(row.reason as QuoteLineReason) ? (row.reason as QuoteLineReason) : null;
  const unitPrice = num(row.unit_price);
  const compareAt = num(row.compare_at_price);
  return {
    line: num(row.line) ?? 0,
    productId: id(row.product_id),
    variantId: id(row.variant_id),
    quantity: Math.min(CHECKOUT_MAX_QTY, Math.max(1, Math.trunc(num(row.quantity) ?? 1))),
    quantityAdjusted: row.quantity_adjusted === true,
    available: row.available === true && reason === null,
    reason,
    productName: str(row.product_name, 200),
    brand: str(row.brand, 80),
    slug: str(row.slug, 120),
    imageUrl: str(row.image_url, 1000),
    variantName: str(row.variant_name, 120),
    sku: str(row.sku, 64),
    unitPrice,
    compareAtPrice: compareAt !== null && unitPrice !== null && compareAt > unitPrice ? compareAt : null,
    lineTotal: num(row.line_total),
    stock: STOCKS.includes(row.stock as QuoteStock) ? (row.stock as QuoteStock) : null,
    stockLevel: num(row.stock_level),
  };
}

/** SQL quote_order jsonb (snake_case) → Quote. The discount block is collapsed here (P14). */
export function quoteFromSql(raw: unknown, sentCode: string | null): Quote | null {
  if (!isRow(raw) || !Array.isArray(raw.lines)) return null;
  const discount = sentCode === null ? null : isRow(raw.discount) ? verdictFromSql(raw.discount, sentCode) : refusedVerdict(sentCode);
  return {
    lines: raw.lines.filter(isRow).map(quoteLineFromSql),
    orderable: raw.orderable === true,
    subtotal: num(raw.subtotal) ?? 0,
    shippingFee: num(raw.shipping_fee) ?? 0,
    discount,
    discountAmount: num(raw.discount_amount) ?? 0,
    total: num(raw.total) ?? 0,
    fulfillment: raw.fulfillment === "pickup" ? "pickup" : "delivery",
    deliveryFee: num(raw.delivery_fee) ?? 0,
    freeDeliveryThreshold: num(raw.free_delivery_threshold),
    amountToFreeDelivery: num(raw.amount_to_free_delivery),
    pickupAvailable: raw.pickup_available === true,
    codAvailable: raw.cod_available === true,
    bankTransferAvailable: raw.bank_transfer_available === true,
  };
}

/** Client side: accept only a well-formed Quote from /api/quote (defensive; it is our own route). */
export function parseQuote(raw: unknown): Quote | null {
  if (!isRow(raw) || !Array.isArray(raw.lines) || typeof raw.total !== "number" || typeof raw.subtotal !== "number") return null;
  return raw as unknown as Quote;
}

/** Shopper copy for a quote line that needs attention (null = nothing to say). SQL_NOTES wording. */
export function quoteLineNotice(line: Pick<QuoteLine, "reason" | "stock" | "stockLevel">): string | null {
  switch (line.reason) {
    case "unknown_product":
    case "inactive":
      return "No longer available";
    case "invalid_variant":
      return "This option is no longer available";
    case "out_of_stock":
      return "Sold out";
    case "insufficient_stock":
      return line.stockLevel !== null && line.stockLevel > 0 ? `Only ${line.stockLevel} left` : "Sold out";
    default:
      return line.stock === "low" && line.stockLevel !== null && line.stockLevel > 0 ? `Only ${line.stockLevel} left` : null;
  }
}

export { discountMessage, refusedVerdict, unavailableVerdict, type DiscountVerdict };
