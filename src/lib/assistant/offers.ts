import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toNumber, toText } from "@/lib/catalogue-shared";
import { deliveryFeeFor, type DeliveryRule } from "@/lib/delivery";
import { unavailableVerdict, verdictFromSql, type DiscountVerdict } from "@/lib/discount-copy";
import { normalizeOfferCode } from "@/lib/offer-code-shared";
import { logDbError } from "@/lib/rpc-errors";

/**
 * Offers for the assistant (blueprint §10.7, SQL 20_assistant_offers.sql + 09 validate_discount).
 *
 * - `listLiveOffers()` → list_live_offers(p_session_id): PUBLIC codes arrive with code, title and
 *   minimum only (kind/value/end are NULL in SQL — the model is never given an amount to do maths
 *   with); EXCLUSIVE (assistant_only) codes only for a session the DATABASE decides has earned
 *   them, with their kind/value/end so they can be priced against the bag.
 * - `checkDiscount()` → validate_discount(p_code, p_subtotal): the same verdict place_order
 *   applies, collapsed through lib/discount-copy.ts (one refusal line for every reason except the
 *   minimum — P6, P14).
 * - `bagWithOffer()` mirrors place_order EXACTLY (09): delivery on the PRE-discount subtotal, the
 *   discount capped at the subtotal, a total that never goes below zero (+ delivery).
 *
 * The split public/exclusive is enforced by what the tools RETURN, not by prompting.
 */

const MIGRATION_OFFERS = "20_assistant_offers.sql";
const MIGRATION_DISCOUNT = "09_order_rpcs.sql";

export type LiveOffer = {
  code: string;
  title: string;
  /** LKR minimum subtotal; null when there is none. */
  minimum: number | null;
  exclusive: boolean;
  /** Exclusive codes only. */
  kind: "percentage" | "fixed_amount" | null;
  value: number | null;
  endsAt: string | null;
};

export type LiveOffersResult = { ok: true; offers: LiveOffer[] } | { ok: false };

type Row = Record<string, unknown>;

export async function listLiveOffers(supabase: SupabaseClient, sessionId: string | null): Promise<LiveOffersResult> {
  try {
    const { data, error } = await supabase.rpc("list_live_offers", { p_session_id: sessionId });
    if (error) {
      logDbError("assistant.list_live_offers", error, MIGRATION_OFFERS);
      return { ok: false };
    }
    const rows = Array.isArray(data) ? (data as Row[]) : [];
    const offers: LiveOffer[] = [];
    for (const row of rows.slice(0, 8)) {
      const code = normalizeOfferCode(row.code);
      if (!code) continue;
      const exclusive = row.exclusive === true;
      const minimum = toNumber(row.min_requirement, 0);
      const kind = exclusive && (row.kind === "percentage" || row.kind === "fixed_amount") ? row.kind : null;
      const value = exclusive ? toNumber(row.value, Number.NaN) : Number.NaN;
      offers.push({
        code,
        title: toText(row.title, 120) ?? code,
        minimum: minimum > 0 ? minimum : null,
        exclusive,
        kind,
        value: Number.isFinite(value) && value > 0 ? value : null,
        endsAt: exclusive ? toText(row.ends_at, 64) : null,
      });
    }
    return { ok: true, offers };
  } catch (error) {
    console.error(`[assistant.list_live_offers] ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false };
  }
}

/** validate_discount for one code against a subtotal (LKR). Never throws; an outage reads "could not check". */
export async function checkDiscount(supabase: SupabaseClient, code: string, subtotal: number): Promise<DiscountVerdict> {
  try {
    const { data, error } = await supabase.rpc("validate_discount", { p_code: code, p_subtotal: subtotal });
    if (error) {
      logDbError("assistant.validate_discount", error, MIGRATION_DISCOUNT);
      return unavailableVerdict(code);
    }
    return verdictFromSql(data, code);
  } catch (error) {
    console.error(`[assistant.validate_discount] ${error instanceof Error ? error.message : String(error)}`);
    return unavailableVerdict(code);
  }
}

export type BagWithOffer = {
  subtotal: number;
  discount: number;
  /** Home delivery, decided on the PRE-discount subtotal. */
  delivery: number;
  total: number;
};

/** place_order's arithmetic (09): total = max(subtotal − discount, 0) + delivery(pre-discount subtotal). */
export function bagWithOffer(subtotal: number, discount: number, rule: DeliveryRule): BagWithOffer {
  const sub = Math.max(0, subtotal);
  const off = Math.min(Math.max(0, discount), sub);
  const delivery = deliveryFeeFor(sub, rule, "delivery");
  return { subtotal: sub, discount: off, delivery, total: Math.max(sub - off, 0) + delivery };
}
