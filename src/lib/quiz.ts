/**
 * Guided finder — questions, lenses, scoring, diversity, explanations and match % (blueprint
 * §9.14 steps 4–7, §17.1 consumer-electronics row, BUILD_SPEC §4.5).
 *
 * A PLAIN module (no "use client" / "server-only"): it runs in the browser on /discover and on
 * the server in `POST /api/quiz` (re-derivation before emailing) and in the assistant's
 * `recommend_for_profile` tool — the SAME `recommend()` everywhere, over the SAME per-product
 * vectors from `fetchCatalogueForFinder()` (`lib/quiz-catalogue.ts`), so chat, finder and email
 * never disagree (blueprint §10.1 "Reuse the finder engine").
 *
 * The browser never sees the lexicon — only the vectors (axis readings 0–10, the spec that drove
 * each reading as a ready-made fact phrase, uses, styles, physical facts) built on the server.
 *
 * CONTRACT (BUILD_SPEC §5; the assistant codes against it — keep these names):
 *   QUESTIONS                         the five question definitions (static vocabulary)
 *   FinderAnswers, UseCase, Budget, Portability, avoid tokens ("wired" | "heavy" | "brand:<Brand>")
 *   recommend(answers, catalogue, opts?) → FinderPick[]  ({ productId, match, style, reason }, ≤ 3 by default)
 *   questionsFor(catalogue, category) → the questions to ask, with only the options the stock honours
 *   parseAnswers(raw, catalogue) → FinderAnswers | null  (allowlist for request bodies / tool input)
 *   profileFor(answers) → FinderProfile                   (what `finder_responses.profile` stores)
 */

import { AXES, clampAxis, type Axis, type AxisScores, type FinderProfile, type ProfileKey } from "@/lib/attribute-axes";
import type { ProductCardData } from "@/lib/catalogue-shared";

// ── Vocabulary ────────────────────────────────────────────────────────────────

/** `attributes.use_cases` values (docs/domain-model.md §3) — the `use` question's options. */
export const USE_CASES = ["everyday", "gaming", "creative", "mobile", "backup", "ergonomic"] as const;
export type UseCase = (typeof USE_CASES)[number];

/** Price tertiles within the chosen category. */
export const BUDGET_BANDS = ["entry", "mid", "premium"] as const;
export type BudgetBand = (typeof BUDGET_BANDS)[number];
export const BUDGETS = [...BUDGET_BANDS, "any"] as const;
export type Budget = (typeof BUDGETS)[number];

export const PORTABILITY_CHOICES = ["light", "any"] as const;
export type Portability = (typeof PORTABILITY_CHOICES)[number];

/** Avoid tokens. Brands are `brand:<Brand>` with the catalogue's own spelling. */
export const AVOID_WIRED = "wired";
export const AVOID_HEAVY = "heavy";
/** "Nothing" — exclusive in the UI, never stored (an empty list means nothing is avoided). */
export const AVOID_NOTHING = "none";
export const AVOID_BRAND_PREFIX = "brand:";
export const MAX_AVOID = 12;

export const avoidBrand = (brand: string): string => `${AVOID_BRAND_PREFIX}${brand}`;
export function brandFromAvoid(token: string): string | null {
  return token.startsWith(AVOID_BRAND_PREFIX) ? token.slice(AVOID_BRAND_PREFIX.length) : null;
}

export type QuestionId = "category" | "use" | "budget" | "portability" | "avoid";
export const QUESTION_IDS: readonly QuestionId[] = ["category", "use", "budget", "portability", "avoid"];

/** What the shopper answered. Questions that were not asked (the stock can't honour them) are null. */
export type FinderAnswers = {
  category: string | null;
  use: UseCase | null;
  budget: Budget | null;
  portability: Portability | null;
  /** Avoid tokens; [] = nothing avoided. */
  avoid: string[];
};

export const EMPTY_ANSWERS: FinderAnswers = { category: null, use: null, budget: null, portability: null, avoid: [] };

// ── Per-product vectors (built on the server by lib/quiz-catalogue.ts) ────────

/** One spec fact behind a reading ("axisNotes"): which spec drove it, as a phrase a reason can quote. */
export type FinderDriver = {
  /** The spec key that drove it, e.g. "gpu", "weight_kg", "capacity_gb". */
  spec: string;
  /** Shopper-facing fact built only from the product's own spec value, e.g. "RTX 4060 graphics". */
  text: string;
  /** The reading this spec gave (0–10); drivers are listed strongest first. */
  reading: number;
};

/** A spec fact that is not an axis reading but can carry a use (silent clicks, hot-swap sockets…). */
export type FinderFeature = {
  spec: string;
  text: string;
  /** The uses this fact speaks to (cited only when the shopper asked for one of them). */
  uses: UseCase[];
  /** Never cite it to a shopper avoiding this ("wired" connections, for example). */
  conflicts: ("wired" | "heavy")[];
};

/** A style label ("Gaming laptop", "Portable SSD"), most specific first. */
export type FinderStyle = {
  label: string;
  /** The use this label already names (so the reason doesn't repeat it). */
  use: UseCase | null;
  /** Never call a product this when the shopper avoids it. */
  conflicts: ("wired" | "heavy")[];
};

export type FinderProduct = {
  id: number;
  categoryId: string;
  brand: string;
  /** Product line (a `kind = 'line'` collection id) — null when it belongs to none. */
  line: string | null;
  /** Card data for display and "add to basket" (server-built, P4). */
  card: ProductCardData;
  /** Axis readings 0–10 — only axes the specs speak to (absent = unknown). */
  axes: AxisScores;
  /** Which specs drove each axis, strongest first (blueprint "axisNotes"). */
  notes: Partial<Record<Axis, FinderDriver[]>>;
  /** Physical property: 0 (featherweight) – 10 (heavy) for its category; null = unknown. */
  weight: number | null;
  /** Stated weight in grams (null = not stated). */
  weightG: number | null;
  /** Heavy for its category (true), known not heavy (false), unknown (null). */
  heavy: boolean | null;
  /** Has a wireless connection (true), wired only (false), unknown / not applicable (null). */
  wireless: boolean | null;
  /** Uses it suits: `attributes.use_cases` plus uses its specs make unambiguous. */
  uses: UseCase[];
  /** Style labels, most specific first; the last one is the plain category label. */
  styles: FinderStyle[];
  features: FinderFeature[];
  /** A context clause its specs back (e.g. an IP rating), or null. */
  context: string | null;
};

export type FinderCategory = {
  id: string;
  name: string;
  /** The category's own tagline (admin-edited copy), shown as the option hint. */
  tagline: string | null;
  /** Finder-eligible products in it. */
  productCount: number;
};

export type FinderCatalogue = {
  /** Finder-eligible products only (visible, purchasable, WITH specs). */
  products: FinderProduct[];
  /** Categories that have at least one finder-eligible product, in the store's order. */
  categories: FinderCategory[];
};

export const EMPTY_FINDER_CATALOGUE: FinderCatalogue = { products: [], categories: [] };

/** One recommendation. */
export type FinderPick = {
  productId: number;
  /** 62–99, scaled against the best available match (not a theoretical maximum). */
  match: number;
  /** Style label, e.g. "Gaming laptop". */
  style: string;
  /** One sentence built from the product's own drivers. */
  reason: string;
};

// ── Questions (static definitions; category and brand options come from the catalogue) ──

export type QuestionOption = { value: string; label: string; hint?: string };

export type FinderQuestion = {
  id: QuestionId;
  kind: "single" | "multi";
  prompt: string;
  hint: string;
  /** The fixed vocabulary. `category` has none (categories come from the catalogue); `avoid` adds brands. */
  options: readonly QuestionOption[];
};

export const USE_OPTIONS: readonly (QuestionOption & { value: UseCase })[] = [
  { value: "everyday", label: "Study & office", hint: "Docs, browsing, video calls" },
  { value: "gaming", label: "Gaming", hint: "High frame rates, quick response" },
  { value: "creative", label: "Editing & design", hint: "Photo, video and big files" },
  { value: "mobile", label: "On the move", hint: "Light and easy to carry" },
  { value: "backup", label: "Backing up files", hint: "Keep photos and work safe" },
  { value: "ergonomic", label: "All-day comfort", hint: "Shapes designed for long sessions" },
];

export const BUDGET_OPTIONS: readonly (QuestionOption & { value: Budget })[] = [
  { value: "entry", label: "Budget-friendly", hint: "The lower third of our prices" },
  { value: "mid", label: "Balanced", hint: "The middle third" },
  { value: "premium", label: "Best available", hint: "The top third" },
  { value: "any", label: "No limit", hint: "Price doesn't matter" },
];

export const PORTABILITY_OPTIONS: readonly (QuestionOption & { value: Portability })[] = [
  { value: "light", label: "Must be light or compact", hint: "Easy to carry every day" },
  { value: "any", label: "Doesn't matter", hint: "It will mostly stay put" },
];

export const AVOID_FIXED_OPTIONS: readonly QuestionOption[] = [
  { value: AVOID_WIRED, label: "Wired-only models", hint: "Keep only ones we know connect wirelessly" },
  { value: AVOID_HEAVY, label: "Anything heavy", hint: "Keep only ones we know are light enough to carry" },
];
export const AVOID_NOTHING_OPTION: QuestionOption = { value: AVOID_NOTHING, label: "Nothing", hint: "Show me everything" };

export const QUESTIONS: readonly FinderQuestion[] = [
  { id: "category", kind: "single", prompt: "What are you shopping for?", hint: "Pick one — you can run the finder again for another.", options: [] },
  { id: "use", kind: "single", prompt: "What will you mostly use it for?", hint: "The main job decides the specs that matter.", options: USE_OPTIONS },
  {
    id: "budget",
    kind: "single",
    prompt: "What's your budget?",
    hint: "Scaled to the category — a budget mouse and a budget laptop are very different sums.",
    options: BUDGET_OPTIONS,
  },
  { id: "portability", kind: "single", prompt: "Does it need to be light or compact?", hint: "For carrying it around every day.", options: PORTABILITY_OPTIONS },
  {
    id: "avoid",
    kind: "multi",
    prompt: "Anything you'd rather avoid?",
    hint: "Pick any that apply — we'll leave them out.",
    options: [...AVOID_FIXED_OPTIONS, AVOID_NOTHING_OPTION],
  },
];

export function getQuestion(id: QuestionId): FinderQuestion {
  return QUESTIONS.find((q) => q.id === id) as FinderQuestion;
}

/** A question as asked for one category: only the options the stock can honour. */
export type AskedQuestion = Omit<FinderQuestion, "options"> & { options: QuestionOption[] };

// ── Lenses (blueprint §9.14 step 4) ───────────────────────────────────────────

export type Lens = {
  /** Reward products known to suit this use (tagged, or unambiguous from their specs). */
  use?: UseCase;
  /** Reward high readings. */
  axisBonus?: Partial<Record<Axis, number>>;
  /** Punish high readings (the physical `weight` included). */
  axisPenalty?: Partial<Record<ProfileKey, number>>;
  /** Prefer this price tertile (scored by distance). */
  band?: BudgetBand;
  /** Specs whose facts best carry this answer, quoted first in the explanation. */
  cite?: string[];
};

/** Relative weight of each lens component in the score. */
export const WEIGHT = { use: 34, band: 22, axisBonus: 16, penalty: 38 } as const;

export const USE_LENSES: Record<UseCase, Lens> = {
  everyday: { use: "everyday", axisBonus: { value: 1, battery: 0.5 }, cite: ["cpu", "ram_gb", "battery_h", "storage"] },
  gaming: { use: "gaming", axisBonus: { performance: 1.5 }, cite: ["gpu", "refresh", "cpu", "dpi", "switch"] },
  creative: { use: "creative", axisBonus: { performance: 1.5 }, cite: ["cpu", "ram_gb", "gpu", "storage", "speed"] },
  mobile: { use: "mobile", axisBonus: { portability: 1, battery: 0.75 }, axisPenalty: { weight: 0.5 }, cite: ["weight", "battery_h", "screen", "layout"] },
  backup: { use: "backup", axisBonus: { value: 1 }, cite: ["capacity_gb", "speed", "interface"] },
  ergonomic: { use: "ergonomic" },
};

export const BUDGET_LENSES: Record<Budget, Lens> = {
  entry: { band: "entry", axisBonus: { value: 0.75 } },
  mid: { band: "mid" },
  premium: { band: "premium", axisBonus: { performance: 0.5 } },
  any: {},
};

export const PORTABILITY_LENSES: Record<Portability, Lens> = {
  light: { axisBonus: { portability: 1.5 }, axisPenalty: { weight: 1 }, cite: ["weight", "layout", "screen"] },
  any: {},
};

/** "suited to …" clause per use (only used when the product backs the use). */
const OCCASIONS: Record<UseCase, string> = {
  everyday: "study and office work",
  gaming: "gaming",
  creative: "editing and design work",
  mobile: "work on the move",
  backup: "backing up your files",
  ergonomic: "comfortable all-day use",
};

/** Match % floor and span (blueprint §9.14 step 7: 62 + (score/best)^3 × 37, clamped 62–99). */
export const MATCH_FLOOR = 62;
export const MATCH_CEILING = 99;

/** Picks returned by default, and the most `opts.limit` may ask for (= the SQL cap of 12). */
export const DEFAULT_PICKS = 3;
export const MAX_PICKS = 12;

// ── Small helpers ─────────────────────────────────────────────────────────────

/** Case-insensitive equality — deliberately locale-free, so browser and server always agree. */
const fold = (text: string) => text.trim().toLowerCase();
const sameText = (a: string, b: string) => fold(a) === fold(b);

function isUseCase(value: unknown): value is UseCase {
  return typeof value === "string" && (USE_CASES as readonly string[]).includes(value);
}
function isBudget(value: unknown): value is Budget {
  return typeof value === "string" && (BUDGETS as readonly string[]).includes(value);
}
function isPortability(value: unknown): value is Portability {
  return typeof value === "string" && (PORTABILITY_CHOICES as readonly string[]).includes(value);
}

export function productsIn(catalogue: FinderCatalogue, category: string | null): FinderProduct[] {
  return category ? catalogue.products.filter((p) => p.categoryId === category) : catalogue.products;
}

/** Distinct brands in a set of products, catalogue spelling, alphabetical. */
export function brandsOf(products: readonly FinderProduct[]): string[] {
  const seen: string[] = [];
  for (const p of products) if (p.brand && !seen.some((b) => sameText(b, p.brand))) seen.push(p.brand);
  return seen.sort((a, b) => (fold(a) < fold(b) ? -1 : fold(a) > fold(b) ? 1 : a < b ? -1 : a > b ? 1 : 0));
}

// ── Budget bands: price tertiles within a category ────────────────────────────

/**
 * Tertile cut prices over the products' from-prices: entry ≤ q1 < mid ≤ q2 < premium, where
 * q1/q2 are the prices at ranks ⌈n/3⌉ and ⌈2n/3⌉ (equal prices always share a band).
 */
export function budgetCuts(products: readonly FinderProduct[]): { q1: number; q2: number } | null {
  const prices = products.map((p) => p.card.price).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (prices.length === 0) return null;
  const at = (fraction: number) => prices[Math.max(0, Math.ceil(prices.length * fraction) - 1)];
  return { q1: at(1 / 3), q2: at(2 / 3) };
}

export function bandOf(price: number, cuts: { q1: number; q2: number } | null): BudgetBand | null {
  if (!cuts || !Number.isFinite(price)) return null;
  if (price <= cuts.q1) return "entry";
  if (price <= cuts.q2) return "mid";
  return "premium";
}

const BAND_INDEX: Record<BudgetBand, number> = { entry: 0, mid: 1, premium: 2 };

function bandFit(band: BudgetBand | null, wanted: BudgetBand): number {
  if (!band) return 0;
  const distance = Math.abs(BAND_INDEX[band] - BAND_INDEX[wanted]);
  return distance === 0 ? 1 : distance === 1 ? 0.35 : 0;
}

// ── Hard refusals (the "avoid" answer) ────────────────────────────────────────

/**
 * Does this product survive the avoid answer? A refusal keeps only what we KNOW is fine:
 * avoiding "wired" keeps products with a known wireless connection; avoiding "heavy" keeps
 * products known not to be heavy; an avoided brand is dropped. Unknown ≠ fine (guessing is
 * worse than omitting).
 */
export function passesAvoid(product: FinderProduct, avoid: readonly string[]): boolean {
  for (const token of avoid) {
    if (token === AVOID_WIRED) {
      if (product.wireless !== true) return false;
    } else if (token === AVOID_HEAVY) {
      if (product.heavy !== false) return false;
    } else {
      const brand = brandFromAvoid(token);
      if (brand !== null && sameText(brand, product.brand)) return false;
    }
  }
  return true;
}

/** How many products in the chosen category survive these answers' refusals. */
export function countMatches(answers: Pick<FinderAnswers, "category" | "avoid">, catalogue: FinderCatalogue): number {
  return productsIn(catalogue, answers.category).filter((p) => passesAvoid(p, answers.avoid)).length;
}

// ── Which questions to ask (hide what the stock can't honour — blueprint §9.14, lesson 40) ──

/** Light or compact enough for the portability question's "must be light" answer. */
const LIGHT_ENOUGH = 7;

/**
 * The questions to ask for a category, in order, each with only the options its stock can
 * honour. A single-choice question is skipped when fewer than two meaningful options remain;
 * the avoid question is always asked while at least one refusal is possible.
 * With `category` null only the category question is returned.
 */
export function questionsFor(catalogue: FinderCatalogue, category: string | null): AskedQuestion[] {
  const categoryQuestion = getQuestion("category");
  const asked: AskedQuestion[] = [
    {
      ...categoryQuestion,
      options: catalogue.categories.filter((c) => c.productCount > 0).map((c) => ({ value: c.id, label: c.name, ...(c.tagline ? { hint: c.tagline } : {}) })),
    },
  ];
  if (!category) return asked;
  const products = productsIn(catalogue, category);
  if (products.length === 0) return asked;

  // use: the use cases present in this category's stock
  const presentUses = new Set(products.flatMap((p) => p.uses));
  const useOptions = USE_OPTIONS.filter((o) => presentUses.has(o.value));
  if (useOptions.length >= 2) asked.push({ ...getQuestion("use"), options: [...useOptions] });

  // budget: tertiles that actually hold a product, plus "no limit"
  const cuts = budgetCuts(products);
  const bands = new Set(products.map((p) => bandOf(p.card.price, cuts)).filter((b): b is BudgetBand => b !== null));
  if (bands.size >= 2) {
    asked.push({ ...getQuestion("budget"), options: BUDGET_OPTIONS.filter((o) => o.value === "any" || bands.has(o.value as BudgetBand)) });
  }

  // portability: only when something here is known to be light or compact
  if (products.some((p) => (p.axes.portability ?? 0) >= LIGHT_ENOUGH)) {
    asked.push({ ...getQuestion("portability"), options: [...PORTABILITY_OPTIONS] });
  }

  // avoid: an option is offered when, on its own, it removes something and leaves something
  const meaningful = (token: string) => {
    const left = products.filter((p) => passesAvoid(p, [token])).length;
    return left > 0 && left < products.length;
  };
  const avoidOptions: QuestionOption[] = [
    ...brandsOf(products)
      .map((brand) => ({ value: avoidBrand(brand), label: brand }))
      .filter((o) => meaningful(o.value)),
    ...AVOID_FIXED_OPTIONS.filter((o) => meaningful(o.value)),
  ];
  if (avoidOptions.length > 0) asked.push({ ...getQuestion("avoid"), options: [...avoidOptions, AVOID_NOTHING_OPTION] });

  return asked;
}

/** Label of a stored answer value (emails, admin insights). Brands read as themselves. */
export function answerLabel(id: QuestionId, value: string, catalogue?: FinderCatalogue): string {
  if (id === "category") return catalogue?.categories.find((c) => c.id === value)?.name ?? value;
  if (id === "avoid") {
    const brand = brandFromAvoid(value);
    if (brand !== null) return brand;
  }
  return getQuestion(id).options.find((o) => o.value === value)?.label ?? value;
}

// ── Allowlist (request bodies, tool input) ────────────────────────────────────

/**
 * Allowlist raw answers against the question definitions: the category must be one the
 * catalogue offers; use / budget / portability must be vocabulary values (or absent); avoid
 * keeps "wired", "heavy" and brands present in that category (canonical spelling), drops
 * "none" and anything else. Unknown keys are dropped. Returns null when the category is missing
 * or unknown, or a present value is outside the vocabulary.
 */
export function parseAnswers(raw: unknown, catalogue: FinderCatalogue): FinderAnswers | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;

  const category = typeof input.category === "string" ? input.category.trim() : "";
  const known = catalogue.categories.find((c) => c.id === category && c.productCount > 0);
  if (!known) return null;

  const optional = <T>(value: unknown, guard: (v: unknown) => v is T): T | null | undefined => {
    if (value === undefined || value === null || value === "") return null;
    return guard(value) ? value : undefined; // undefined = present but invalid
  };
  const use = optional(input.use, isUseCase);
  const budget = optional(input.budget, isBudget);
  const portability = optional(input.portability, isPortability);
  if (use === undefined || budget === undefined || portability === undefined) return null;

  const brands = brandsOf(productsIn(catalogue, known.id));
  const avoid: string[] = [];
  const rawAvoid = Array.isArray(input.avoid) ? input.avoid.slice(0, 40) : [];
  for (const item of rawAvoid) {
    if (typeof item !== "string") continue;
    const token = item.trim();
    let canonical: string | null = null;
    if (token === AVOID_WIRED || token === AVOID_HEAVY) canonical = token;
    else {
      const brand = brandFromAvoid(token);
      const match = brand !== null ? brands.find((b) => sameText(b, brand.trim())) : undefined;
      if (match) canonical = avoidBrand(match);
    }
    if (canonical && !avoid.includes(canonical)) avoid.push(canonical);
    if (avoid.length >= MAX_AVOID) break;
  }

  return { category: known.id, use, budget, portability, avoid };
}

/** The answers as stored in `finder_responses.answers` (only questions that were answered). */
export function answersRecord(answers: FinderAnswers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (answers.category) out.category = answers.category;
  if (answers.use) out.use = answers.use;
  if (answers.budget) out.budget = answers.budget;
  if (answers.portability) out.portability = answers.portability;
  out.avoid = [...answers.avoid];
  return out;
}

// ── Lenses from answers ───────────────────────────────────────────────────────

export function lensesFor(answers: FinderAnswers): Lens[] {
  const lenses: Lens[] = [];
  if (answers.use) lenses.push(USE_LENSES[answers.use]);
  if (answers.budget) lenses.push(BUDGET_LENSES[answers.budget]);
  if (answers.portability) lenses.push(PORTABILITY_LENSES[answers.portability]);
  return lenses;
}

/**
 * The shopper's profile implied by their answers: 5 is neutral, each lens bonus moves an axis
 * up by 2.5 per unit and each penalty down. Only keys the answers touch are included. This is
 * what `finder_responses.profile` stores and what the assistant's memory reads back.
 */
export function profileFor(answers: FinderAnswers): FinderProfile {
  const net = new Map<ProfileKey, number>();
  for (const lens of lensesFor(answers)) {
    for (const [axis, w] of Object.entries(lens.axisBonus ?? {})) net.set(axis as ProfileKey, (net.get(axis as ProfileKey) ?? 0) + (w ?? 0));
    for (const [key, w] of Object.entries(lens.axisPenalty ?? {})) net.set(key as ProfileKey, (net.get(key as ProfileKey) ?? 0) - (w ?? 0));
  }
  const profile: FinderProfile = {};
  for (const [key, value] of net) {
    const clamped = clampAxis(5 + 2.5 * value);
    if (clamped !== null) profile[key] = clamped;
  }
  return profile;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function reading(product: FinderProduct, key: ProfileKey): number {
  if (key === "weight") return product.weight ?? 0;
  return product.axes[key] ?? 0;
}

/**
 * Score one product against the lenses. Unknown readings neither earn a bonus nor a penalty.
 * A baseline of 1 keeps the best score positive, so "no preference" reads as a full match.
 */
export function scoreProduct(product: FinderProduct, lenses: readonly Lens[], band: BudgetBand | null): number {
  let score = 1;
  for (const lens of lenses) {
    if (lens.use && product.uses.includes(lens.use)) score += WEIGHT.use;
    if (lens.band) score += WEIGHT.band * bandFit(band, lens.band);
    for (const [axis, w] of Object.entries(lens.axisBonus ?? {})) score += WEIGHT.axisBonus * (w ?? 0) * (reading(product, axis as ProfileKey) / 10);
    for (const [key, w] of Object.entries(lens.axisPenalty ?? {})) score -= WEIGHT.penalty * (w ?? 0) * (reading(product, key as ProfileKey) / 10);
  }
  return score;
}

/** 62 + (score/best)^3 × 37, clamped 62–99 (blueprint §9.14 step 7). */
export function matchPercent(score: number, best: number): number {
  if (!(best > 0)) return MATCH_FLOOR;
  const ratio = Math.max(0, Math.min(1, score / best));
  return Math.round(Math.min(MATCH_CEILING, Math.max(MATCH_FLOOR, MATCH_FLOOR + ratio ** 3 * (MATCH_CEILING - MATCH_FLOOR))));
}

// ── Diversity (blueprint §9.14 step 5) ────────────────────────────────────────

/**
 * Fill the slots in rank order with at most 2 per brand and 1 per product line; relax the line
 * rule, then the brand rule, rather than return fewer than `limit`. Returns in rank order.
 */
export function diversify<T extends { product: FinderProduct }>(ranked: readonly T[], limit: number): T[] {
  const chosen = new Set<number>();
  const passes: { brand: number; line: number }[] = [
    { brand: 2, line: 1 },
    { brand: 2, line: Number.POSITIVE_INFINITY },
    { brand: Number.POSITIVE_INFINITY, line: Number.POSITIVE_INFINITY },
  ];
  for (const rule of passes) {
    for (let i = 0; i < ranked.length && chosen.size < limit; i += 1) {
      if (chosen.has(i)) continue;
      const { product } = ranked[i];
      const picked = [...chosen].map((j) => ranked[j].product);
      const sameBrand = picked.filter((p) => sameText(p.brand, product.brand)).length;
      const lineKey = product.line ?? `#${product.id}`;
      const sameLine = picked.filter((p) => (p.line ?? `#${p.id}`) === lineKey).length;
      if (sameBrand < rule.brand && sameLine < rule.line) chosen.add(i);
    }
    if (chosen.size >= limit) break;
  }
  return [...chosen].sort((a, b) => a - b).map((i) => ranked[i]);
}

// ── Explanation (blueprint §9.14 step 6) ──────────────────────────────────────

/** Axes whose drivers carry what the shopper asked for, strongest emphasis first. */
function wantedAxes(lenses: readonly Lens[]): Axis[] {
  const weight = new Map<Axis, number>();
  for (const lens of lenses) {
    for (const [axis, w] of Object.entries(lens.axisBonus ?? {})) weight.set(axis as Axis, (weight.get(axis as Axis) ?? 0) + (w ?? 0));
  }
  return [...weight.entries()].filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1]).map(([axis]) => axis);
}

/** What the shopper refuses, as conflict flags for drivers, features and style labels. */
function refusals(answers: FinderAnswers): Set<"wired" | "heavy"> {
  const set = new Set<"wired" | "heavy">();
  if (answers.avoid.includes(AVOID_WIRED)) set.add("wired");
  if (answers.avoid.includes(AVOID_HEAVY) || answers.portability === "light") set.add("heavy");
  return set;
}

function article(label: string): string {
  return /^[aeio]/i.test(label) ? "An" : "A";
}

function joinFacts(facts: string[]): string {
  if (facts.length <= 1) return facts[0] ?? "";
  return `${facts.slice(0, -1).join(", ")} and ${facts[facts.length - 1]}`;
}

/** Only strengths are quoted: a driver below this reading would argue against the pick. */
const QUOTABLE = 5;

/** A fact the style label already says ("compact 60% layout" under "Compact 60% keyboard"). */
function echoes(fact: string, label: string): boolean {
  const core = fact
    .toLowerCase()
    .replace(/^(a|an)\s+/, "")
    .replace(/\s+(switches|connectivity|layout|grip)$/, "")
    .trim();
  return core.length > 0 && label.toLowerCase().includes(core);
}

/**
 * One sentence from the product's drivers: its style label, up to two facts that carry what
 * the shopper asked for, a use clause only when the product backs that use, and a context
 * clause only when its specs back it. Nothing from an axis they asked to avoid is ever cited,
 * and no label contradicts an avoid answer.
 */
export function explain(product: FinderProduct, answers: FinderAnswers): { style: string; reason: string } {
  const refused = refusals(answers);
  const clear = (conflicts: readonly ("wired" | "heavy")[]) => !conflicts.some((c) => refused.has(c));
  const style = product.styles.find((s) => clear(s.conflicts)) ?? product.styles[product.styles.length - 1] ?? { label: "Product", use: null, conflicts: [] };

  const lenses = lensesFor(answers);
  const facts: string[] = [];
  const specsUsed = new Set<string>();
  const take = (spec: string, text: string) => {
    if (facts.length >= 2 || !text || specsUsed.has(spec) || facts.includes(text) || echoes(text, style.label)) return;
    specsUsed.add(spec);
    facts.push(text);
  };
  const quotable = (axis: Axis) => (product.notes[axis] ?? []).filter((d) => d.reading >= QUOTABLE && !(refused.has("heavy") && axis === "portability" && d.reading < 7));

  // 1. drivers on the axes they asked for — the specs that best carry their answers first
  const citeOrder = lenses.flatMap((lens) => lens.cite ?? []);
  const rank = (spec: string) => {
    const i = citeOrder.indexOf(spec);
    return i === -1 ? citeOrder.length : i;
  };
  const wanted = wantedAxes(lenses).flatMap((axis) => quotable(axis));
  for (const d of [...wanted].sort((a, b) => rank(a.spec) - rank(b.spec))) take(d.spec, d.text);
  // 2. facts that speak to the use they asked for
  if (answers.use) for (const f of product.features) if (f.uses.includes(answers.use) && clear(f.conflicts)) take(f.spec, f.text);
  // 3. otherwise the product's own strongest drivers
  if (facts.length < 2) {
    const strongest = AXES.flatMap((axis) => quotable(axis)).sort((a, b) => b.reading - a.reading);
    for (const d of strongest) take(d.spec, d.text);
  }
  if (facts.length < 2) for (const f of product.features) if (clear(f.conflicts)) take(f.spec, f.text);

  const occasion = answers.use && product.uses.includes(answers.use) && style.use !== answers.use ? OCCASIONS[answers.use] : null;
  const label = style.label.charAt(0).toLowerCase() + style.label.slice(1);
  const labelText = /^[A-Z0-9]{2,}/.test(style.label) ? style.label : label; // keep "SSD"-style acronyms as written

  let sentence = `${article(style.label)} ${labelText}`;
  if (facts.length > 0) sentence += ` with ${joinFacts(facts)}`;
  if (occasion) sentence += `, suited to ${occasion}`;
  if (product.context) sentence += `, ${product.context}`;
  if (facts.length === 0 && !occasion && !product.context) sentence += " that fits everything you asked for";
  return { style: style.label, reason: `${sentence}.` };
}

// ── recommend() ───────────────────────────────────────────────────────────────

export type RecommendOptions = {
  /** How many picks (default 3, at most 12). */
  limit?: number;
};

export type RankedPick = FinderPick & { score: number };

/**
 * The finder's recommendations: refuse what they avoid, score the rest through the answer
 * lenses, rank, apply the diversity rules, then explain each pick and scale its match % against
 * the best available match. Deterministic: the same answers over the same catalogue always give
 * the same picks in the same order (browser, capture route and assistant agree).
 * Returns fewer than `limit` only when fewer products survive the avoid answer.
 */
export function recommend(answers: FinderAnswers, catalogue: FinderCatalogue, opts: RecommendOptions = {}): FinderPick[] {
  return rankPicks(answers, catalogue, opts).map(({ productId, match, style, reason }) => ({ productId, match, style, reason }));
}

/** recommend() with each pick's raw score (for tests and diagnostics). */
export function rankPicks(answers: FinderAnswers, catalogue: FinderCatalogue, opts: RecommendOptions = {}): RankedPick[] {
  const limit = Math.min(MAX_PICKS, Math.max(1, Math.trunc(opts.limit ?? DEFAULT_PICKS)));
  const pool = productsIn(catalogue, answers.category).filter((p) => passesAvoid(p, answers.avoid));
  if (pool.length === 0) return [];

  // Tertiles are per category (a budget mouse and a budget laptop are different sums).
  const cutsByCategory = new Map<string, { q1: number; q2: number } | null>();
  for (const p of pool) {
    if (!cutsByCategory.has(p.categoryId)) cutsByCategory.set(p.categoryId, budgetCuts(productsIn(catalogue, p.categoryId)));
  }

  const lenses = lensesFor(answers);
  const ranked = pool
    .map((product) => ({ product, score: scoreProduct(product, lenses, bandOf(product.card.price, cutsByCategory.get(product.categoryId) ?? null)) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        Object.keys(b.product.axes).length - Object.keys(a.product.axes).length ||
        a.product.card.price - b.product.card.price ||
        a.product.id - b.product.id,
    );

  const best = Math.max(...ranked.map((r) => r.score));
  return diversify(ranked, limit).map(({ product, score }) => {
    const { style, reason } = explain(product, answers);
    return { productId: product.id, match: matchPercent(score, best), style, reason, score };
  });
}
