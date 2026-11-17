/**
 * How a product option is sold and what the shopper is told (50_product_availability.sql) — a
 * PLAIN module: product cards, the product page, the basket, the assistant and the admin all use
 * the same words, so they never disagree.
 *
 *   mode (the owner's choice per variant)        status shown
 *   stock        In stock / Only N left / Out of stock (from the stock count; untracked = in stock)
 *   order        In stock while there is stock; otherwise "Available to order" + the wait
 *   preorder     "Pre-order" + the expected date or wait (always — a product not out yet)
 *   unavailable  "Out of stock" whatever the count says
 *
 * "Notify me" is offered for out-of-stock options. "order" and "preorder" options can be bought
 * beyond the stock on hand (place_order keeps the rest of the line as a backorder).
 */

export type AvailabilityMode = "stock" | "order" | "preorder" | "unavailable";
export const AVAILABILITY_MODES: readonly AvailabilityMode[] = ["stock", "order", "preorder", "unavailable"];

export const AVAILABILITY_MODE_LABELS: Record<AvailabilityMode, string> = {
  stock: "From stock (in stock / out of stock)",
  order: "Available to order when out of stock",
  preorder: "Pre-order",
  unavailable: "Out of stock (not sold now)",
};

export type AvailabilityStatus = "in_stock" | "low_stock" | "to_order" | "preorder" | "out_of_stock";

export const STATUS_LABELS: Record<AvailabilityStatus, string> = {
  in_stock: "In stock",
  low_stock: "Low stock",
  to_order: "Available to order",
  preorder: "Pre-order",
  out_of_stock: "Out of stock",
};

/** The variant's own settings (product_variants.availability, wait_min_days, wait_max_days, available_on). */
export type VariantAvailability = {
  mode: AvailabilityMode;
  waitMinDays: number | null;
  waitMaxDays: number | null;
  /** YYYY-MM-DD — a pre-order's expected date. */
  availableOn: string | null;
};

export const DEFAULT_VARIANT_AVAILABILITY: VariantAvailability = { mode: "stock", waitMinDays: null, waitMaxDays: null, availableOn: null };

/**
 * A variant's stock as the storefront may know it:
 *   null      not stock-tracked (always sells);
 *   { level } tracked, with the level (exact only when low — otherwise any number above it);
 *   undefined not known (still loading, or the read failed).
 */
export type StockReading = { level: number; low: boolean } | null | undefined;

export type AvailabilityView = {
  status: AvailabilityStatus;
  /** "In stock", "Only 2 left", "Available to order", "Pre-order", "Out of stock". */
  label: string;
  /** "Ships in 7–10 days", "Expected 20 Dec 2026" — or null. */
  wait: string | null;
  /** Can it go in the basket. */
  orderable: boolean;
  /** Most the shopper may add (null = the basket's own cap). */
  maxQty: number | null;
  /** Units on the shelf for an "order" option with stock (more can be ordered beyond them). */
  onShelf: number | null;
  /** Offer "Notify me". */
  notify: boolean;
};

const MODES = new Set<string>(AVAILABILITY_MODES);

function days(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isInteger(n) && n >= 0 && n <= 365 ? n : null;
}

function ymd(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** A product_variants row (or anything with its columns) → its availability; pre-50 rows read as "stock". */
export function variantAvailabilityFromRow(row: Record<string, unknown>): VariantAvailability {
  const mode = typeof row.availability === "string" && MODES.has(row.availability) ? (row.availability as AvailabilityMode) : "stock";
  return { mode, waitMinDays: days(row.wait_min_days), waitMaxDays: days(row.wait_max_days), availableOn: ymd(row.available_on) };
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** "20 Dec 2026" for a YYYY-MM-DD (no time-zone drift: read and printed as UTC). */
export function formatAvailableOn(value: string): string {
  const [y, m, d] = value.split("-").map(Number);
  return DATE.format(new Date(Date.UTC(y, m - 1, d)));
}

/** Today in Sri Lanka, YYYY-MM-DD. */
function todayInColombo(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** "Ships in 7–10 days" / "Ships in 5 days" / "Ships within 10 days" / "Ships in 3+ days" — or null. */
export function waitText(min: number | null, max: number | null): string | null {
  if (min !== null && max !== null) return min === max ? `Ships in ${max} day${max === 1 ? "" : "s"}` : `Ships in ${min}–${max} days`;
  if (max !== null) return `Ships within ${max} day${max === 1 ? "" : "s"}`;
  if (min !== null) return min === 0 ? null : `Ships in ${min}+ days`;
  return null;
}

/** The wait a shopper is shown for an option (only for "order" / "preorder"). */
export function availabilityWait(v: VariantAvailability, now: Date = new Date()): string | null {
  if (v.mode === "preorder" && v.availableOn && v.availableOn >= todayInColombo(now)) return `Expected ${formatAvailableOn(v.availableOn)}`;
  if (v.mode === "order" || v.mode === "preorder") return waitText(v.waitMinDays, v.waitMaxDays);
  return null;
}

/** What to show for one option, given its live stock. */
export function variantAvailability(v: VariantAvailability, stock: StockReading, now: Date = new Date()): AvailabilityView {
  const wait = availabilityWait(v, now);
  const view = (status: AvailabilityStatus, extra: Partial<AvailabilityView> = {}): AvailabilityView => ({
    status,
    label: STATUS_LABELS[status],
    wait: status === "to_order" || status === "preorder" ? wait : null,
    orderable: status !== "out_of_stock",
    maxQty: null,
    onShelf: null,
    notify: status === "out_of_stock",
    ...extra,
  });
  if (v.mode === "unavailable") return view("out_of_stock");
  if (v.mode === "preorder") return view("preorder");
  if (stock === null) return v.mode === "order" ? view("to_order") : view("in_stock");
  if (stock === undefined) {
    // not known yet: an "order" option can be bought either way; a "stock" one waits for the count
    return v.mode === "order" ? view("to_order", { label: "Available", wait: null }) : view("in_stock", { label: "", orderable: true });
  }
  if (stock.level > 0) {
    const low = stock.low;
    if (v.mode === "order") {
      return view(low ? "low_stock" : "in_stock", { label: low ? `Only ${stock.level} left` : "In stock", onShelf: stock.level, wait });
    }
    return view(low ? "low_stock" : "in_stock", { label: low ? `Only ${stock.level} left` : "In stock", maxQty: low ? stock.level : null });
  }
  return v.mode === "order" ? view("to_order") : view("out_of_stock");
}

const RANK: Record<AvailabilityStatus, number> = { in_stock: 0, low_stock: 0, to_order: 1, preorder: 2, out_of_stock: 3 };

/** A card's one-line availability — the best of its options (in stock beats to order beats pre-order). */
export type CardAvailability = { status: AvailabilityStatus; label: string; wait: string | null };

export function cardAvailability(options: { availability: VariantAvailability; stock: StockReading }[], now: Date = new Date()): CardAvailability | null {
  let best: AvailabilityView | null = null;
  for (const option of options) {
    if (option.stock === undefined && option.availability.mode === "stock") continue; // unknown: say nothing rather than guess
    const view = variantAvailability(option.availability, option.stock, now);
    if (!best || RANK[view.status] < RANK[best.status]) best = view;
  }
  if (!best) return null;
  const status = best.status === "low_stock" ? "in_stock" : best.status;
  return { status, label: STATUS_LABELS[status], wait: best.status === "to_order" || best.status === "preorder" ? best.wait : null };
}

/** The short line under a basket / checkout line for an option that waits: "Available to order · Ships in 7–10 days". */
export function backorderNote(mode: AvailabilityMode | null, backorder: number, wait: string | null, quantity: number): string | null {
  if (backorder <= 0 || (mode !== "order" && mode !== "preorder")) return null;
  const head = mode === "preorder" ? "Pre-order" : backorder < quantity ? `${backorder} of ${quantity} to order` : "Available to order";
  return wait ? `${head} · ${wait}` : head;
}
