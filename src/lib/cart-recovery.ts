/**
 * Abandoned-cart recovery — the schedule and the shared vocabulary (blueprint §9.10).
 *
 * A PLAIN module on purpose (no "use client", no "server-only"): the hourly job
 * (`POST /api/cart-recovery`), the recovery emails, the `/recover` restore page and the admin
 * Abandoned carts tab all read it. The database stores only WHICH stage a cart has reached
 * (`abandoned_carts.recovery_stage`, 13_abandoned_carts.sql), never timing — so retuning a delay
 * is a change to this file alone, no migration (blueprint §18 "Recovery timing").
 */

export const RECOVERY_STAGES = [
  { stage: 1, afterMinutes: 60, label: "1 hour" }, //         recovers most: the shopper was interrupted
  { stage: 2, afterMinutes: 24 * 60, label: "24 hours" },
  { stage: 3, afterMinutes: 72 * 60, label: "72 hours" }, //  the last thing ever sent about that cart
] as const;

export type RecoveryStage = (typeof RECOVERY_STAGES)[number];
export type RecoveryStageNumber = RecoveryStage["stage"];

/** Older carts are "old carts": mailing them reads as a data leak. */
export const RECOVERY_MAX_AGE_HOURS = 14 * 24;
/** Carts claimed per stage per run — sized to the function timeout. `more` = the batch filled. */
export const RECOVERY_BATCH_LIMIT = 20;
/** Parallel sends (email provider rate limits). */
export const RECOVERY_SEND_CONCURRENCY = 3;

/**
 * The gap between this stage and the previous one (stage 1: since the abandonment itself), so a
 * late job can't fire reminders 1 and 2 back to back. Passed to the claim as p_min_gap_minutes.
 */
export function minGapMinutes(stage: number): number {
  const index = RECOVERY_STAGES.findIndex((entry) => entry.stage === stage);
  if (index < 0) return RECOVERY_STAGES[0].afterMinutes;
  const previous = index === 0 ? 0 : RECOVERY_STAGES[index - 1].afterMinutes;
  return RECOVERY_STAGES[index].afterMinutes - previous;
}

// ── Shared vocabulary ────────────────────────────────────────────────────────

/** How many reminders a cart can ever get (the admin tab's "N of 3 sent"). */
export const RECOVERY_STAGE_COUNT = RECOVERY_STAGES.length;

export function isRecoveryStage(value: unknown): value is RecoveryStageNumber {
  return RECOVERY_STAGES.some((entry) => entry.stage === value);
}

/** `recovery_stage` → "Not sent" / "1 of 3 sent" … (a claimed stage whose send failed is released back). */
export function recoveryStageLabel(reached: number): string {
  const stage = Number.isInteger(reached) ? Math.min(Math.max(reached, 0), RECOVERY_STAGE_COUNT) : 0;
  return stage === 0 ? "Not sent" : `${stage} of ${RECOVERY_STAGE_COUNT} sent`;
}

/** The email links. The token is the credential (never an email or an id). */
export const recoveryRestorePath = (token: string) => `/recover?token=${encodeURIComponent(token)}`;
export const recoveryStopPath = (token: string) => `/recover/stop?token=${encodeURIComponent(token)}`;

/**
 * One line of `abandoned_carts.cart_items` — the snapshot `capture_abandoned_cart` wrote FROM THE
 * CATALOGUE at capture time (names, prices and images are database values, never the browser's).
 */
export type RecoveryCartItem = {
  productId: number;
  variantId: number;
  quantity: number;
  name: string;
  variantName: string | null;
  /** LKR unit price at capture time. */
  price: number;
  image: string | null;
};

const positiveInt = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
};
const text = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

/** Tolerant reader for the stored snapshot: malformed lines are dropped, never guessed. */
export function parseRecoveryItems(raw: unknown): RecoveryCartItem[] {
  if (!Array.isArray(raw)) return [];
  const items: RecoveryCartItem[] = [];
  for (const entry of raw.slice(0, 50)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const productId = positiveInt(row.product_id);
    const variantId = positiveInt(row.variant_id);
    const quantity = positiveInt(row.quantity);
    const price = typeof row.price === "number" ? row.price : typeof row.price === "string" ? Number(row.price) : Number.NaN;
    if (productId === null || variantId === null || quantity === null || !Number.isFinite(price) || price < 0) continue;
    items.push({
      productId,
      variantId,
      quantity,
      name: text(row.name, 200) ?? "Item",
      variantName: text(row.variant_name, 120),
      price,
      image: text(row.image, 1000),
    });
  }
  return items;
}
