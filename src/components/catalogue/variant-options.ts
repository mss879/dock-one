import type { ProductVariant } from "@/lib/catalogue-shared";

/*
 * Variant selection for the product page (model B, docs/domain-model.md §1) — plain module so the
 * rules are testable without a DOM.
 */

export type OptionAxis = { name: string; values: string[] };

/**
 * Option groups from `option_values` (e.g. Memory × Storage) — only when EVERY variant names a
 * value for every key and each combination is unique; otherwise (null) the selector lists the
 * variant names. A single variant never gets a selector.
 */
export function optionAxes(variants: readonly ProductVariant[]): OptionAxis[] | null {
  if (variants.length < 2) return null;
  const keys: string[] = [];
  for (const variant of variants) for (const key of Object.keys(variant.optionValues)) if (!keys.includes(key)) keys.push(key);
  if (keys.length === 0 || keys.length > 4) return null;
  if (!variants.every((variant) => keys.every((key) => Boolean(variant.optionValues[key])))) return null;
  const combos = new Set(variants.map((variant) => keys.map((key) => variant.optionValues[key]).join("\u0000")));
  if (combos.size !== variants.length) return null;
  return keys.map((key) => ({ name: key, values: [...new Set(variants.map((variant) => variant.optionValues[key]))] }));
}

/**
 * The variant an option value leads to, given the current selection: one that can be bought
 * first, then the closest match to the other picks, then selector order. null when no variant
 * has that value.
 */
export function resolveOption(
  variants: readonly ProductVariant[],
  current: ProductVariant | null,
  axis: string,
  value: string,
  isOut: (variant: ProductVariant) => boolean,
): ProductVariant | null {
  const candidates = variants.filter((candidate) => candidate.optionValues[axis] === value);
  const matches = (candidate: ProductVariant) =>
    Object.entries(current?.optionValues ?? {}).filter(([key, picked]) => key !== axis && candidate.optionValues[key] === picked).length;
  return [...candidates].sort((a, b) => Number(isOut(a)) - Number(isOut(b)) || matches(b) - matches(a) || a.position - b.position || a.id - b.id)[0] ?? null;
}

/**
 * The variant to show: the shopper's choice; before they choose, the default — unless it's sold
 * out and another option can be bought.
 */
export function effectiveVariant(
  variants: readonly ProductVariant[],
  chosenId: number | null,
  touched: boolean,
  isOut: (variant: ProductVariant) => boolean,
): ProductVariant | null {
  const chosen = variants.find((variant) => variant.id === chosenId) ?? variants[0] ?? null;
  if (chosen && !touched && isOut(chosen)) return variants.find((candidate) => !isOut(candidate)) ?? chosen;
  return chosen;
}
