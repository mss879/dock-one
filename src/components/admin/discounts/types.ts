/** Admin-side discount rows (08_discounts.sql) — DECIMAL may arrive as a string. */

import { formatLKR } from "@/lib/format";

export const DISCOUNTS_MIGRATION = "08_discounts.sql";
export const OFFERS_MIGRATION = "20_assistant_offers.sql";

export type DiscountKind = "percentage" | "fixed_amount";

export type AdminDiscount = {
  id: number;
  code: string;
  title: string;
  kind: DiscountKind;
  value: number;
  minRequirement: number;
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
  usageCount: number;
  isActive: boolean;
  assistantOnly: boolean;
  createdAt: string | null;
};

type Row = Record<string, unknown>;
const num = (value: unknown, fallback = 0): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

export function normalizeDiscount(row: Row): AdminDiscount {
  return {
    id: num(row.id),
    code: text(row.code) ?? "",
    title: text(row.title) ?? "",
    kind: row.kind === "fixed_amount" ? "fixed_amount" : "percentage",
    value: num(row.value),
    minRequirement: num(row.min_requirement),
    startsAt: text(row.starts_at),
    endsAt: text(row.ends_at),
    usageLimit: row.usage_limit == null ? null : num(row.usage_limit),
    usageCount: num(row.usage_count),
    isActive: row.is_active === true,
    assistantOnly: row.assistant_only === true,
    createdAt: text(row.created_at),
  };
}

export function discountValueLabel(discount: Pick<AdminDiscount, "kind" | "value">): string {
  return discount.kind === "percentage" ? `${discount.value}% off` : `${formatLKR(discount.value)} off`;
}

/** Live right now for shoppers (same test as _discount_check, minus the minimum). */
export function discountState(discount: AdminDiscount, now = Date.now()): "live" | "paused" | "scheduled" | "expired" | "used_up" {
  if (!discount.isActive) return "paused";
  if (discount.startsAt && Date.parse(discount.startsAt) > now) return "scheduled";
  if (discount.endsAt && Date.parse(discount.endsAt) < now) return "expired";
  if (discount.usageLimit !== null && discount.usageCount >= discount.usageLimit) return "used_up";
  return "live";
}

/** Constraint names (08) → admin copy for the kit's write helpers. */
export const DISCOUNT_WRITE = {
  entity: "discount",
  migration: DISCOUNTS_MIGRATION,
  constraints: {
    discounts_code_upper_key: "Another discount already uses that code.",
    discounts_code_format: "Codes are 2–32 characters: letters, digits, “-” and “_”, starting with a letter or digit.",
    discounts_title_valid: "Give the discount a name (up to 120 characters).",
    discounts_kind_valid: "Choose percentage or fixed amount.",
    discounts_value_valid: "The value must be more than 0.",
    discounts_percentage_max: "A percentage can't be more than 100.",
    discounts_min_valid: "The minimum order can't be negative.",
    discounts_dates_valid: "The end date must be after the start date.",
    discounts_usage_valid: "The usage limit must be at least 1.",
    discounts_assistant_needs_cap: "Assistant-only codes need a usage limit.",
  },
};
