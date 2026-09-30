import "server-only";
import { fetchAvailability, normalizeProductDetail, PRODUCT_DETAIL_FIELDS, type ProductDetail } from "@/lib/catalogue";
import { parseRecoveryItems } from "@/lib/cart-recovery";
import { isSupabaseConfigured } from "@/lib/env";
import { isUuid } from "@/lib/request-guard";
import { logDbError } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";
import { resolveRecoveryLines, type RestoredLine } from "./recovery-restore";

/**
 * The /recover page's read (blueprint §9.10 "Restore"): get_recovery_cart(p_token) — which
 * never returns the email, address or phone — then the LIVE catalogue for every product the
 * saved lines name, then the resolution rules in recovery-restore.ts.
 *
 * Per-person and live: nothing here goes through the data cache (FOUNDATION_NOTES §6 rule 6).
 * A failed read is "unavailable", never "these items are gone" (that would be untrue — P15).
 */

export type RecoveryView =
  /** No token, a malformed one, or one that matches nothing — all read the same (P14). */
  | { kind: "invalid" }
  /** Supabase unconfigured, the migration missing, or the database unreachable. */
  | { kind: "unavailable" }
  | { kind: "converted"; firstName: string | null }
  | { kind: "ready"; firstName: string | null; lines: RestoredLine[]; unavailable: number };

const MIGRATION = "13_abandoned_carts.sql";
const MAX_AVAILABILITY_PRODUCTS = 24; // = get_product_availability's cap

const firstNameOf = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 60) : null);

export async function loadRecoveryView(token: unknown): Promise<RecoveryView> {
  if (!isUuid(token)) return { kind: "invalid" };
  if (!isSupabaseConfigured) return { kind: "unavailable" };

  let supabase;
  try {
    supabase = createServerSupabase();
  } catch {
    return { kind: "unavailable" };
  }

  const { data, error } = await supabase.rpc("get_recovery_cart", { p_token: token });
  if (error) {
    logDbError("recover.get_recovery_cart", error, MIGRATION);
    return { kind: "unavailable" };
  }
  const cart = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (!cart || cart.found !== true) return { kind: "invalid" };
  const firstName = firstNameOf(cart.first_name);
  if (cart.converted === true) return { kind: "converted", firstName };

  const items = parseRecoveryItems(cart.cart_items);
  if (items.length === 0) return { kind: "ready", firstName, lines: [], unavailable: 0 };

  // Live catalogue: today's names, prices, images and variants (RLS: visible products, active variants).
  const ids = [...new Set(items.map((item) => item.productId))];
  const { data: rows, error: productError } = await supabase.from("products").select(PRODUCT_DETAIL_FIELDS).in("id", ids).eq("is_active", true);
  if (productError) {
    logDbError("recover.products", productError, "04_catalogue.sql");
    return { kind: "unavailable" };
  }
  const products = new Map<number, ProductDetail>();
  for (const row of Array.isArray(rows) ? (rows as unknown as Record<string, unknown>[]) : []) {
    const product = normalizeProductDetail(row);
    if (product) products.set(product.id, product);
  }

  // Stock only matters where a discontinued variant must be swapped ("the first AVAILABLE one").
  const needSwap = items
    .filter((item) => {
      const product = products.get(item.productId);
      return product !== undefined && product.variants.length > 0 && !product.variants.some((variant) => variant.id === item.variantId);
    })
    .map((item) => item.productId);
  const soldOut = new Set<number>();
  if (needSwap.length > 0) {
    const availability = await fetchAvailability([...new Set(needSwap)].slice(0, MAX_AVAILABILITY_PRODUCTS));
    if (availability.ok) {
      for (const row of availability.rows) if (row.stockLevel <= 0) soldOut.add(row.variantId);
    } else {
      // Unknown stock: fall back to the default variant; checkout confirms availability anyway.
      logDbError("recover.availability", availability.error, "05_inventory.sql");
    }
  }

  const { lines, unavailable } = resolveRecoveryLines(items, products, (variant) => soldOut.has(variant.id));
  return { kind: "ready", firstName, lines, unavailable };
}
