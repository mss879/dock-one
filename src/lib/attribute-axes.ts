/**
 * The guided finder's axes (blueprint §9.14 step 1, §17.1 consumer-electronics row, BUILD_SPEC §1
 * RECOMMENDER_AXES) — a PLAIN module: the browser (/discover), the capture route, the assistant
 * and the admin insights tab all read the same list (P6).
 *
 * - Four character axes, each a 0–10 reading derived from a product's own specs by the
 *   server-only lexicon (`lib/attribute-lexicon.ts`):
 *     performance  how capable the hardware is for demanding work (CPU/GPU tier, RAM, drive speed,
 *                  interface, sensor, switch type)
 *     portability  how easy it is to carry (weight, screen size, layout, drive type, ruggedness)
 *     battery      how long it runs between charges (rated hours, battery capacity)
 *     value        price-value: capability (or, for storage, capacity) per rupee within its
 *                  category — computed by `lib/quiz-catalogue.ts` from real prices
 *   `ecosystem` (the §17.1 row's fifth axis) is dropped: the catalogue carries no OS/ecosystem
 *   data to honour it (§9.14: remove what the stock can't honour).
 * - One physical property: `weight` — how heavy the product is for its category (0 = featherweight,
 *   10 = heavy), read from `weight_kg` / `weight_g` (or a drive type that fixes it). It decides the
 *   "avoid heavy" refusal and the portability lens's penalty.
 *
 * A product has a reading only on the axes its specs actually speak to; an absent axis means
 * UNKNOWN (never guessed, never scored as 0).
 *
 * `PROFILE_KEYS` is also the allowlist for `finder_responses.profile` (clamped 0–10 by
 * `record_finder_response`, 14_finder.sql) and for the assistant's returning-customer memory
 * (`get_assistant_customer_context`, 21_assistant_memory_lookup.sql) — change all three together.
 */

export const AXES = ["performance", "portability", "battery", "value"] as const;
export type Axis = (typeof AXES)[number];

export const PHYSICAL_PROPERTIES = ["weight"] as const;
export type PhysicalProperty = (typeof PHYSICAL_PROPERTIES)[number];

/** Keys a stored shopper profile may carry (= the SQL allowlist in 21). */
export const PROFILE_KEYS = [...AXES, ...PHYSICAL_PROPERTIES] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];

/** Readings on the character axes, 0–10. Only axes with a reading are present. */
export type AxisScores = Partial<Record<Axis, number>>;

/** A shopper profile: how strongly their answers lean on each key, 0–10 (5 = neutral). */
export type FinderProfile = Partial<Record<ProfileKey, number>>;

export const AXIS_LABELS: Record<ProfileKey, string> = {
  performance: "Performance",
  portability: "Portability",
  battery: "Battery life",
  value: "Value for money",
  weight: "Weight",
};

export const AXIS_MIN = 0;
export const AXIS_MAX = 10;

export function isAxis(value: unknown): value is Axis {
  return typeof value === "string" && (AXES as readonly string[]).includes(value);
}

export function isProfileKey(value: unknown): value is ProfileKey {
  return typeof value === "string" && (PROFILE_KEYS as readonly string[]).includes(value);
}

/** Clamp to 0–10 with one decimal (NaN/∞ → null). */
export function clampAxis(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(Math.min(AXIS_MAX, Math.max(AXIS_MIN, value)) * 10) / 10;
}

/**
 * Keep only allowlisted keys with numeric values, clamped 0–10 — the same rule the SQL applies
 * (record_finder_response keeps ≤ 20 numeric keys; 21 keeps only these five).
 */
export function sanitizeProfile(raw: unknown): FinderProfile {
  const out: FinderProfile = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of PROFILE_KEYS) {
    const value = clampAxis((raw as Record<string, unknown>)[key]);
    if (value !== null) out[key] = value;
  }
  return out;
}
