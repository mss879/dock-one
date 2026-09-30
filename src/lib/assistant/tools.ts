import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { tool } from "ai";
import { z } from "zod";
import { MAX_QTY } from "@/lib/cart-limits";
import { fetchAvailability } from "@/lib/catalogue";
import type { DeliveryRule } from "@/lib/delivery";
import { DISCOUNT_REFUSED_MESSAGE, type DiscountVerdict } from "@/lib/discount-copy";
import { formatLKR } from "@/lib/format";
import { normalizeOfferCode } from "@/lib/offer-code-shared";
import { BUDGETS, parseAnswers, PORTABILITY_CHOICES, recommend, USE_CASES } from "@/lib/quiz";
import { logDbError } from "@/lib/rpc-errors";
import { stockBands, type AssistantSnapshot, type SnapshotProduct } from "./catalogue";
import { bagWithOffer, checkDiscount, listLiveOffers, type LiveOffer } from "./offers";
import { ASSISTANT_LIMITS, type AssistantAction, type AssistantStockBand, type StageQuestion } from "./types";

/**
 * Tools + the collector (blueprint §10.6).
 *
 * COLLECTOR PATTERN: presentation tools record INTENT; the route resolves it after the model has
 * finished (P4). The model only ever names ids — names, prices, images and stock on the cards are
 * built by the server from the SAME snapshot every read tool used, so what the model was told and
 * what the shopper sees can't disagree. The stage holds one thing: any stage tool clears the
 * other two. Hallucinated ids resolve to nothing.
 *
 * Schemas are written to be OpenAI strict-mode compatible (every key required, optional = null,
 * no unknown keys, no string-length keywords): lengths are enforced in `execute` instead.
 */

/** ONE copy: the insights classifier compares the step count against it (blueprint §10.6). */
export const STEP_BUDGET = { text: 10, photo: 12, retry: 4 } as const;

/** Offer lookups per turn (blueprint §6.4 "max 3 calls per turn"). */
export const MAX_OFFER_CALLS = 3;
/** check_stock ids per call (blueprint §10.6). */
export const MAX_STOCK_IDS = 6;

export type AssistantCollector = {
  /** Last show_products wins (≤ 3 known ids). */
  stagedIds: number[];
  /** Mutually exclusive with the other two. */
  stagedQuestion: StageQuestion | null;
  stagedOrderLookup: { prefillOrderRef: string | null } | null;
  /** From check_stock this turn → onto the cards. */
  stockById: Map<number, AssistantStockBand[]>;
  suggestions: string[];
  actions: AssistantAction[];
  offerCode: string | null;
  offerCalls: number;
  photoReading: string | null;
  /** record_photo_reading's catalogue verdict: how many products it found (0 = a product we don't carry); null = no photo read. */
  photoMatches: number | null;
  // ── signals for insights.readTurnSignals (blueprint §10.13) ──
  /** Every search_products call: the term and how many products matched. */
  searches: { term: string; matches: number }[];
  showProductsCalls: number;
  /** Tools that actually ran, in order (used when the generation itself failed). */
  toolLog: string[];
};

export function createCollector(): AssistantCollector {
  return {
    stagedIds: [],
    stagedQuestion: null,
    stagedOrderLookup: null,
    stockById: new Map(),
    suggestions: [],
    actions: [],
    offerCode: null,
    offerCalls: 0,
    photoReading: null,
    photoMatches: null,
    searches: [],
    showProductsCalls: 0,
    toolLog: [],
  };
}

export type ToolContext = {
  snapshot: AssistantSnapshot;
  collector: AssistantCollector;
  /** The browser's chat session (list_live_offers decides whether it has EARNED exclusive codes). */
  sessionId: string;
  /** Stateless anon client (every RPC here is granted to anon). */
  supabase: SupabaseClient;
  /** Advisory bag subtotal (LKR) from the widget; null = unknown / empty. */
  cartSubtotal: number | null;
  /** store_settings delivery rule (the same row place_order reads). */
  deliveryRule: DeliveryRule;
  /** A photo rides on this turn. */
  hasImage: boolean;
  /** Per-IP offer lookup limit (12 / 10 min, blueprint §6.4) — true = allowed. */
  allowOfferCall: () => Promise<boolean>;
};

// ── Small helpers ─────────────────────────────────────────────────────────────

/** Single-line text: control chars, brackets (private-note syntax) and newlines removed, clamped. */
function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

function enumOrString(values: readonly string[]) {
  return values.length > 0 ? z.enum(values as [string, ...string[]]) : z.string();
}

const productLabel = (p: SnapshotProduct) => (p.name.toLowerCase().startsWith(p.brand.toLowerCase()) || !p.brand ? p.name : `${p.brand} ${p.name}`);

function flagsOf(p: SnapshotProduct): string[] {
  return [p.isBestseller && "bestseller", p.isNew && "new", p.isFlashDeal && "deal"].filter((f): f is string => Boolean(f));
}

function summary(p: SnapshotProduct) {
  return {
    id: p.id,
    brand: p.brand,
    name: p.name,
    price: `${p.variants.length > 1 ? "from " : ""}${formatLKR(p.price)}`,
    ...(p.compareAtPrice !== null ? { wasPrice: formatLKR(p.compareAtPrice) } : {}),
    category: p.categoryId,
    subtitle: p.subtitle,
    flags: flagsOf(p),
  };
}

// Search: word matching over the snapshot (no vector RAG — blueprint §10.1).

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "for", "with", "without", "of", "to", "in", "on", "at", "by", "my", "me", "i", "you", "your",
  "is", "are", "it", "that", "this", "some", "any", "need", "want", "looking", "show", "find", "get", "buy", "please", "under",
  "below", "over", "above", "around", "about", "than", "less", "more", "cheap", "cheapest", "best", "good", "new", "rs", "lkr",
]);
/** Common names shoppers use for the same thing (language facts, not product claims). */
const ALIASES: Record<string, string[]> = {
  notebook: ["laptop"],
  laptops: ["laptop"],
  mice: ["mouse"],
  mouses: ["mouse"],
  keyboards: ["keyboard"],
  pendrive: ["flash"],
  pen: ["flash"],
  thumbdrive: ["flash"],
  thumb: ["flash"],
  stick: ["flash"],
  harddisk: ["hdd"],
  hdd: ["hdd", "hard"],
  ssds: ["ssd"],
  wireless: ["wireless", "bluetooth", "tri-mode"],
  gamer: ["gaming"],
  game: ["gaming"],
  games: ["gaming"],
};

const normalizeWords = (text: string) => text.toLowerCase().replace(/[^a-z0-9.+#]+/g, " ").trim();
const wordsOf = (text: string) => normalizeWords(text).split(" ").filter(Boolean);

function queryTokens(query: string): string[][] {
  const tokens = wordsOf(query).filter((t) => (t.length > 1 || /\d/.test(t)) && !STOPWORDS.has(t) && !/^\d{4,}$/.test(t));
  return [...new Set(tokens)].slice(0, 12).map((t) => {
    const forms = new Set([t, ...(ALIASES[t] ?? [])]);
    if (t.length > 3 && t.endsWith("s")) forms.add(t.slice(0, -1));
    return [...forms];
  });
}

function matchesWord(words: readonly string[], form: string): boolean {
  return words.some((w) => w === form || (form.length >= 3 && w.startsWith(form)));
}

const indexCache = new WeakMap<SnapshotProduct, { title: string[]; all: string[]; padded: string }>();
function indexOf(p: SnapshotProduct) {
  let entry = indexCache.get(p);
  if (!entry) {
    const all = wordsOf(p.searchText);
    entry = { title: wordsOf(p.titleText), all, padded: ` ${all.join(" ")} ` };
    indexCache.set(p, entry);
  }
  return entry;
}

// ── Photo matching: the catalogue's verdict on a photographed product ─────────

export const PHOTO_KINDS = ["product", "port_or_cable", "unclear", "other"] as const;
export type PhotoVerdict = "carried" | "similar" | "none" | "unclear" | "not_a_product";

export type PhotoReading = {
  kind: (typeof PHOTO_KINDS)[number];
  brand: string;
  model: string;
  productType: string;
  /** A catalogue category id, or null when the product isn't something the store's categories cover. */
  category: string | null;
  features: string[];
};

/**
 * Decides, from what the model read off the photo, whether we CARRY that product, carry something
 * SIMILAR, or carry NONE of it — the model only relays the verdict (P4: the server decides).
 *  carried  every brand + model word is in one product's title AND the product's own brand word is
 *           among them (so a generic "wireless mouse" typed as a model name can never "match").
 *  similar  the product belongs to one of our categories: that category's products, ranked by how
 *           many of the photo's type/feature words they mention (brand match is a bonus).
 *  none     nothing in that category, or a category we don't have.
 */
export function matchPhoto(snapshot: AssistantSnapshot, reading: PhotoReading): { verdict: Extract<PhotoVerdict, "carried" | "similar" | "none">; products: SnapshotProduct[] } {
  const brandTokens = queryTokens(reading.brand);
  const modelTokens = queryTokens(reading.model);
  const nameTokens = [...brandTokens, ...modelTokens];
  const matchesTitle = (p: SnapshotProduct, forms: readonly string[]) => forms.some((f) => matchesWord(indexOf(p).title, f));
  if (modelTokens.length > 0) {
    const carried = snapshot.products.filter((p) => {
      if (!nameTokens.every((forms) => matchesTitle(p, forms))) return false;
      const brandWord = wordsOf(p.brand)[0] ?? wordsOf(p.name)[0] ?? "";
      return brandWord !== "" && nameTokens.some((forms) => forms.some((f) => f === brandWord || (f.length >= 3 && brandWord.startsWith(f))));
    });
    if (carried.length > 0) return { verdict: "carried", products: carried.slice(0, ASSISTANT_LIMITS.cards) };
  }
  const pool = reading.category ? snapshot.products.filter((p) => p.categoryId === reading.category) : [];
  if (pool.length === 0) return { verdict: "none", products: [] };
  // Model words count too, so "Studio 16" from another brand still ranks our Studio 16 first.
  const featureTokens = queryTokens([reading.productType, ...reading.features, reading.model].join(" "));
  const scored = pool.map((p) => {
    const index = indexOf(p);
    let score = 0;
    for (const forms of featureTokens) {
      if (forms.some((f) => matchesWord(index.title, f))) score += 3;
      else if (forms.some((f) => matchesWord(index.all, f))) score += 1;
    }
    if (brandTokens.length > 0 && brandTokens.every((forms) => matchesTitle(p, forms))) score += 2;
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score || Number(b.p.isBestseller) - Number(a.p.isBestseller) || a.p.price - b.p.price);
  return { verdict: "similar", products: scored.slice(0, ASSISTANT_LIMITS.cards).map((s) => s.p) };
}

// ── Offers ────────────────────────────────────────────────────────────────────

function offerTerms(offer: LiveOffer): string | null {
  if (!offer.exclusive || offer.kind === null || offer.value === null) return null;
  return offer.kind === "percentage" ? `${offer.value}% off` : `${formatLKR(offer.value)} off`;
}

function bagLine(ctx: ToolContext, verdict: DiscountVerdict) {
  const subtotal = ctx.cartSubtotal ?? 0;
  if (!(subtotal > 0) || verdict.valid !== true) return null;
  const bag = bagWithOffer(subtotal, verdict.discountAmount, ctx.deliveryRule);
  return {
    bagSubtotal: formatLKR(bag.subtotal),
    discount: formatLKR(bag.discount),
    delivery: bag.delivery > 0 ? formatLKR(bag.delivery) : "free",
    total: formatLKR(bag.total),
  };
}

async function offerCallAllowed(ctx: ToolContext): Promise<string | null> {
  if (ctx.collector.offerCalls >= MAX_OFFER_CALLS) return "Offer lookups are limited to 3 per reply.";
  ctx.collector.offerCalls += 1;
  if (!(await ctx.allowOfferCall())) return "Offers can't be checked right now — try again in a few minutes.";
  return null;
}

// ── The tools ─────────────────────────────────────────────────────────────────

export function buildTools(ctx: ToolContext) {
  const { snapshot, collector } = ctx;
  const categoryIds = snapshot.meta.categories.map((c) => c.id);
  const finderCategoryIds = snapshot.scored.categories.map((c) => c.id);
  const log = (name: string) => collector.toolLog.push(name);
  const known = (ids: readonly number[], cap: number) => {
    const out: number[] = [];
    for (const id of ids) if (Number.isInteger(id) && snapshot.byId.has(id) && !out.includes(id) && out.length < cap) out.push(id);
    return out;
  };
  const nameOf = (id: number) => {
    const p = snapshot.byId.get(id);
    return p ? productLabel(p) : `#${id}`;
  };
  /** record_photo_reading's answer, so a second call on the same photo repeats the same verdict. */
  let photoResult: Record<string, unknown> | null = null;

  return {
    search_products: tool({
      description:
        "Search the catalogue. Filters: free-text words (EVERY word must match a product's name, specs or description), category id, brand, LKR price range, features every result must mention (mustHave), sort. Returns { totalMatches, results } (≤ 8 summaries). Use 1–3 short words from the catalogue's own vocabulary; the catalogue digest lists every product too.",
      inputSchema: z.strictObject({
        query: z.string().nullable().describe("1–3 short words that must all match, e.g. 'portable ssd' or 'wireless mouse'. null = filters only."),
        category: enumOrString(categoryIds).nullable().describe("Category id from the catalogue, or null."),
        brand: enumOrString(snapshot.meta.brands).nullable().describe("Brand as spelled in the catalogue, or null."),
        minPrice: z.number().min(0).nullable().describe("Lowest from-price in LKR, or null."),
        maxPrice: z.number().min(0).nullable().describe("Highest from-price in LKR, or null."),
        mustHave: z.array(z.string()).max(4).nullable().describe("Features each result must mention in its specs, e.g. ['hot-swap'], ['Bluetooth'], ['RTX 4060']. null = none."),
        sort: z.enum(["relevance", "price_low", "price_high"]).nullable(),
        limit: z.number().int().min(1).max(8).nullable().describe("Results to return (default 5, max 8)."),
      }),
      execute: async (input) => {
        log("search_products");
        const query = clean(input.query, 80);
        const tokens = queryTokens(query);
        const mustHave = (input.mustHave ?? []).map((t) => normalizeWords(clean(t, 40))).filter(Boolean).slice(0, 4);
        const category = input.category && categoryIds.includes(input.category) ? input.category : null;
        const brand = input.brand ? clean(input.brand, 80).toLowerCase() : "";
        const min = typeof input.minPrice === "number" && Number.isFinite(input.minPrice) ? input.minPrice : null;
        const max = typeof input.maxPrice === "number" && Number.isFinite(input.maxPrice) ? input.maxPrice : null;

        const scored: { p: SnapshotProduct; score: number }[] = [];
        for (const p of snapshot.products) {
          if (category && p.categoryId !== category) continue;
          if (brand && p.brand.toLowerCase() !== brand) continue;
          if (min !== null && p.price < min) continue;
          if (max !== null && p.price > max) continue;
          const index = indexOf(p);
          if (mustHave.some((term) => !index.padded.includes(` ${term} `))) continue;
          // Every word must match (in the name/brand/spec line first, else anywhere in the product's text):
          // an OR match would answer "logitech mx keys" with an MX mouse and hide a real catalogue gap.
          let score = 0;
          let all = true;
          for (const forms of tokens) {
            if (forms.some((f) => matchesWord(index.title, f))) score += 3;
            else if (forms.some((f) => matchesWord(index.all, f))) score += 1;
            else {
              all = false;
              break;
            }
          }
          if (!all) continue;
          scored.push({ p, score });
        }
        const sort = input.sort ?? "relevance";
        scored.sort((a, b) =>
          sort === "price_low" ? a.p.price - b.p.price : sort === "price_high" ? b.p.price - a.p.price : b.score - a.score || Number(b.p.isBestseller) - Number(a.p.isBestseller),
        );
        const limit = Math.min(8, Math.max(1, Math.trunc(input.limit ?? 5)));
        const term = query || [category, input.brand, ...mustHave].filter(Boolean).join(" ");
        if (term) collector.searches.push({ term: term.slice(0, 80), matches: scored.length });
        return {
          totalMatches: scored.length,
          results: scored.slice(0, limit).map(({ p }) => summary(p)),
          ...(scored.length === 0
            ? {
                note: "Nothing matches every word. Try fewer or broader words, or the category/brand/price filters, and check the CATALOGUE digest before saying we don't carry something. If we truly don't, say so plainly and offer the closest thing we do carry only if there is one.",
              }
            : {}),
        };
      },
    }),

    get_product_details: tool({
      description:
        "The full public spec sheet of ONE product: description, specs, highlights, use cases, what's in the box, warranty (if stated), variants with prices, rating (only if reviewed), URL. Specs not listed are UNKNOWN — say so, never guess.",
      inputSchema: z.strictObject({ id: z.number().int().describe("Product id (#id in the catalogue).") }),
      execute: async ({ id }) => {
        log("get_product_details");
        const p = snapshot.byId.get(id);
        if (!p) return { error: `There is no product #${id} in the catalogue.` };
        const description = p.description ? (p.description.length > 600 ? `${p.description.slice(0, 597).trimEnd()}…` : p.description) : null;
        return {
          id: p.id,
          brand: p.brand,
          name: p.name,
          category: p.categoryName ?? p.categoryId,
          url: p.href,
          subtitle: p.subtitle,
          description,
          specs: p.specRows.map((row) => `${row.label}: ${row.value}`),
          highlights: p.highlights,
          useCases: p.useCases,
          inTheBox: p.inTheBox,
          warranty: p.warrantyMonths !== null && p.warrantyMonths > 0 ? `${p.warrantyMonths} months` : null,
          variants: p.variants.map((v) => ({ name: v.name, price: formatLKR(v.price), ...(v.compareAtPrice !== null ? { wasPrice: formatLKR(v.compareAtPrice) } : {}) })),
          rating: p.ratingCount > 0 ? { average: Math.round(p.ratingAvg * 10) / 10, reviews: p.ratingCount } : null,
          flags: flagsOf(p),
          note: "Only the specs listed here are known. For availability call check_stock.",
        };
      },
    }),

    check_stock: tool({
      description:
        "LIVE availability for up to 6 product ids, per variant: 'in stock', 'low — only N left' or 'out of stock'. Call it before saying anything about availability. Never state a count that isn't 'low'.",
      inputSchema: z.strictObject({ ids: z.array(z.number().int()).min(1).max(MAX_STOCK_IDS) }),
      execute: async ({ ids }) => {
        log("check_stock");
        const productIds = known(ids, MAX_STOCK_IDS);
        if (productIds.length === 0) return { error: "None of those ids are in the catalogue." };
        const result = await fetchAvailability(productIds);
        if (!result.ok) {
          logDbError("assistant.check_stock", result.error, "05_inventory.sql");
          return {
            stock: productIds.map((id) => ({ id, name: nameOf(id), availability: "unknown" })),
            note: "Live stock couldn't be checked just now: say availability is confirmed at checkout.",
          };
        }
        return {
          stock: productIds.map((id) => {
            const p = snapshot.byId.get(id) as SnapshotProduct;
            const bands = stockBands(p, result.rows);
            collector.stockById.set(id, bands);
            return {
              id,
              name: productLabel(p),
              variants: bands.map((b) => ({
                variant: b.variant,
                availability: b.state === "out" ? "out of stock" : b.state === "low" ? `low — only ${b.left} left` : "in stock",
              })),
            };
          }),
        };
      },
    }),

    recommend_for_profile: tool({
      description:
        "The guided finder's engine (the same one as /discover). Give the shopper's answers; returns ≤ 3 picks { id, match, style, reason }. Use after 3–4 answers, then check_stock and show_products.",
      inputSchema: z.strictObject({
        category: enumOrString(finderCategoryIds).describe("Category id."),
        use: z.enum(USE_CASES).nullable().describe("Main use, or null if not asked."),
        budget: z.enum(BUDGETS).nullable().describe("entry = lower third of prices, mid, premium = top third, any = no limit; null if not asked."),
        portability: z.enum(PORTABILITY_CHOICES).nullable().describe("light = must be light or compact, any = doesn't matter; null if not asked."),
        avoid: z.array(z.string()).max(12).describe("'wired', 'heavy' and/or 'brand:<Brand>' (catalogue spelling); [] = nothing avoided."),
      }),
      execute: async (input) => {
        log("recommend_for_profile");
        if (snapshot.scored.products.length === 0) return { picks: [], note: "The finder isn't available right now — use search_products instead." };
        const answers = parseAnswers(input, snapshot.scored);
        if (!answers) {
          return { error: `Those answers don't fit the finder. Categories: ${finderCategoryIds.join(", ")}; uses: ${USE_CASES.join(", ")}; budgets: ${BUDGETS.join(", ")}.` };
        }
        const picks = recommend(answers, snapshot.scored, { limit: 3 }).filter((pick) => snapshot.byId.has(pick.productId));
        return {
          picks: picks.map((pick) => {
            const p = snapshot.byId.get(pick.productId) as SnapshotProduct;
            return { id: pick.productId, name: productLabel(p), price: formatLKR(p.price), match: `${pick.match}%`, style: pick.style, reason: pick.reason };
          }),
          note:
            picks.length > 0
              ? "Check stock, stage these with show_products, and explain each in one line using its reason."
              : "Nothing survives those answers — ask whether they'd relax what they want to avoid.",
        };
      },
    }),

    show_products: tool({
      description: "Put up to 3 products on the display (by id, in the order you talk about them). Stage every product you name. Replaces whatever was on the display.",
      inputSchema: z.strictObject({ ids: z.array(z.number().int()).min(1).max(ASSISTANT_LIMITS.cards) }),
      execute: async ({ ids }) => {
        log("show_products");
        collector.showProductsCalls += 1;
        const staged = known(ids, ASSISTANT_LIMITS.cards);
        collector.stagedIds = staged;
        collector.stagedQuestion = null;
        collector.stagedOrderLookup = null;
        if (staged.length === 0) return { shown: [], error: "None of those ids exist — use ids from the catalogue or a tool result." };
        return {
          shown: staged.map((id) => `#${id} ${nameOf(id)}`),
          ...(staged.length < new Set(ids).size ? { note: "Unknown ids were ignored." } : {}),
        };
      },
    }),

    present_question: tool({
      description:
        "Ask ONE question with 2–6 tappable options (guided builder). Replaces the display. The shopper's tap arrives as their next message. Don't call suggest_replies after it.",
      inputSchema: z.strictObject({
        id: z.string().describe("Short id: category, use, budget, portability, avoid — or your own short slug."),
        prompt: z.string().describe("The question, one short sentence."),
        options: z
          .array(z.strictObject({ value: z.string(), label: z.string().describe("≤ 48 characters"), hint: z.string().nullable().describe("≤ 80 characters, or null") }))
          .min(2)
          .max(6),
      }),
      execute: async (input) => {
        log("present_question");
        const id = clean(input.id, 32).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "question";
        const prompt = clean(input.prompt, 160);
        const options: StageQuestion["options"] = [];
        for (const option of input.options) {
          const label = clean(option.label, 48);
          if (!label || options.some((o) => o.label.toLowerCase() === label.toLowerCase())) continue;
          const hint = clean(option.hint, 80);
          options.push({ value: clean(option.value, 48) || label, label, ...(hint ? { hint } : {}) });
          if (options.length >= 6) break;
        }
        if (!prompt || options.length < 2) return { error: "A question needs a prompt and at least 2 distinct options." };
        collector.stagedQuestion = { id, prompt, options };
        collector.stagedIds = [];
        collector.stagedOrderLookup = null;
        return { ok: true, note: "The question and its options are on the display. End your reply with the question in one short sentence; no suggest_replies." };
      },
    }),

    present_order_lookup: tool({
      description:
        "Put the secure order-lookup form on the display for ANY question about an existing order (status, tracking, delivery). You cannot see what they type. orderRef: only an order number the shopper typed themselves, else null.",
      inputSchema: z.strictObject({ orderRef: z.string().nullable() }),
      execute: async ({ orderRef }) => {
        log("present_order_lookup");
        collector.stagedOrderLookup = { prefillOrderRef: clean(orderRef, 40) || null };
        collector.stagedIds = [];
        collector.stagedQuestion = null;
        return {
          ok: true,
          note: "The secure form is on the display. You cannot see what they type or their order — the result is shown to them directly. Never ask for or repeat their email or order number.",
        };
      },
    }),

    add_to_cart: tool({
      description:
        "Add a product to the shopper's basket — ONLY when they explicitly ask you to (or accept an offer that needs it). variant: an exact variant name from get_product_details, or null for the default (cheapest). Max 3 per reply. Confirm in words what you added.",
      inputSchema: z.strictObject({
        productId: z.number().int(),
        variant: z.string().nullable(),
        quantity: z.number().int().min(1).max(MAX_QTY).nullable(),
      }),
      execute: async ({ productId, variant, quantity }) => {
        log("add_to_cart");
        if (collector.actions.length >= ASSISTANT_LIMITS.actions) return { ok: false, error: "At most 3 additions per reply." };
        const p = snapshot.byId.get(productId);
        if (!p) return { ok: false, error: `There is no product #${productId} in the catalogue.` };
        const wanted = clean(variant, 120).toLowerCase();
        const chosen = wanted ? p.variants.find((v) => v.name.toLowerCase() === wanted) : p.variants.find((v) => v.id === p.defaultVariantId);
        if (!chosen) return { ok: false, error: `No variant called "${clean(variant, 60)}". Variants: ${p.variants.map((v) => v.name).join(", ")}.` };
        const qty = Math.min(MAX_QTY, Math.max(1, Math.trunc(quantity ?? 1)));
        collector.actions.push({
          type: "add_to_cart",
          product: { id: p.id, slug: p.slug, brand: p.brand, name: p.name, price: chosen.price, compareAtPrice: chosen.compareAtPrice, image: p.image, categoryId: p.categoryId },
          variantId: chosen.id,
          variant: chosen.name,
          quantity: qty,
        });
        return { ok: true, added: `${qty} × ${productLabel(p)}${p.variants.length > 1 ? ` (${chosen.name})` : ""} at ${formatLKR(chosen.price)} each`, note: "Their basket opens with it." };
      },
    }),

    list_offers: tool({
      description:
        "Live discount codes. Call it for ANY question about discounts, deals, codes or offers. Public codes: share code, name and minimum only — never an amount. Exclusive codes come with their terms and are priced against the bag for you.",
      inputSchema: z.strictObject({}),
      execute: async () => {
        log("list_offers");
        const refused = await offerCallAllowed(ctx);
        if (refused) return { offers: [], note: refused };
        const result = await listLiveOffers(ctx.supabase, ctx.sessionId);
        if (!result.ok) return { offers: [], note: "Offers can't be checked right now." };
        const subtotal = ctx.cartSubtotal ?? 0;
        const offers = [];
        for (const offer of result.offers) {
          if (!offer.exclusive) {
            offers.push({ code: offer.code, name: offer.title, minimumSpend: offer.minimum !== null ? formatLKR(offer.minimum) : null, exclusive: false });
            continue;
          }
          const priced = subtotal > 0 ? bagLine(ctx, await checkDiscount(ctx.supabase, offer.code, subtotal)) : null;
          offers.push({
            code: offer.code,
            name: offer.title,
            exclusive: true,
            terms: offerTerms(offer),
            minimumSpend: offer.minimum !== null ? formatLKR(offer.minimum) : null,
            endsAt: offer.endsAt,
            onThisBag: priced,
          });
        }
        return {
          offers,
          note:
            offers.length === 0
              ? "No offers are running right now."
              : "Public codes: code, name and minimum only. Delivery is decided on the bag before any discount. Save a code with check_offer only after the shopper accepts it.",
        };
      },
    }),

    check_offer: tool({
      description:
        "Check ONE named code against the shopper's bag (the same verdict checkout applies). saveForCheckout: true ONLY after the shopper accepts the code — it is then parked for checkout, where they still press Apply.",
      inputSchema: z.strictObject({ code: z.string(), saveForCheckout: z.boolean() }),
      execute: async ({ code: rawCode, saveForCheckout }) => {
        log("check_offer");
        const refused = await offerCallAllowed(ctx);
        if (refused) return { valid: null, message: refused };
        const code = normalizeOfferCode(rawCode);
        if (!code) return { code: clean(rawCode, 32).toUpperCase(), valid: false, message: DISCOUNT_REFUSED_MESSAGE };
        const subtotal = Math.max(0, ctx.cartSubtotal ?? 0);
        const verdict = await checkDiscount(ctx.supabase, code, subtotal);
        if (verdict.valid !== true) return { code, valid: verdict.valid, message: verdict.message, saved: false };
        if (saveForCheckout) collector.offerCode = code;
        const bag = bagLine(ctx, verdict);
        return {
          code,
          valid: true,
          ...(bag ? { onThisBag: bag } : { note: "The bag is empty, so the amount can't be worked out yet." }),
          saved: saveForCheckout,
          ...(saveForCheckout ? { savedNote: "Parked for checkout: the shopper still presses Apply there." } : {}),
        };
      },
    }),

    record_photo_reading: tool({
      description:
        "Photo turns only, FIRST: record what the photograph shows and get the catalogue's verdict on it — carried (we sell that product; its ids are returned), similar (we don't sell it; the closest things we DO carry are returned), none (we carry nothing like it), unclear, or not_a_product. Follow the verdict exactly; never claim we carry something it did not return.",
      inputSchema: z.strictObject({
        reading: z.string().describe("What it shows in a few words: brand and model if legible, else the product type; 'unclear' if you can't tell."),
        kind: z.enum(PHOTO_KINDS).describe("product = something a shopper could buy; port_or_cable = a port, cable or setup question; unclear = can't tell what it is; other = anything else."),
        brand: z.string().nullable().describe("The brand as printed or unmistakably recognisable, else null. Never guess."),
        model: z.string().nullable().describe("The model name or number as printed, else null. Never guess and never put a generic type here."),
        productType: z.string().nullable().describe("Generic type in 1–3 words: 'wireless mouse', 'mechanical keyboard', 'portable ssd', 'headphones'."),
        category: enumOrString(categoryIds).nullable().describe("The store category this product belongs to — only if it IS that kind of product (a mouse pad is not a mouse); otherwise null."),
        features: z.array(z.string()).max(4).describe("Up to 4 visible, distinguishing features: 'ergonomic', '75 percent layout', 'RGB', '2TB', 'gaming'. [] if none."),
      }),
      execute: async (input) => {
        log("record_photo_reading");
        if (!ctx.hasImage) return { ok: false, note: "There is no photograph on this turn." };
        if (photoResult) return { ...photoResult, note: "Already recorded for this photo — this is the same verdict." };
        const text = clean(input.reading, 80);
        collector.photoReading = text || "unclear";
        const reading: PhotoReading = {
          kind: PHOTO_KINDS.includes(input.kind) ? input.kind : "unclear",
          brand: clean(input.brand, 60),
          model: clean(input.model, 80),
          productType: clean(input.productType, 60),
          category: input.category && categoryIds.includes(input.category) ? input.category : null,
          features: input.features.map((f) => clean(f, 40)).filter(Boolean).slice(0, 4),
        };
        const finish = (result: Record<string, unknown>) => {
          photoResult = { reading: collector.photoReading, ...result };
          return photoResult;
        };
        if (reading.kind === "port_or_cable") {
          return finish({ verdict: "not_a_product", note: "A port, cable or setup, not a product: help with that (identify it, then suggest compatible items from the catalogue with search_products)." });
        }
        if (reading.kind === "other") {
          return finish({ verdict: "not_a_product", note: "Not a product. Say briefly what you see and ask how you can help. Nothing on the display." });
        }
        if (reading.kind === "unclear" || collector.photoReading === "unclear" || (!reading.productType && !reading.brand && !reading.model)) {
          return finish({ verdict: "unclear", note: "You couldn't make it out. Say so and ask the shopper, in one short question, what the product is. Don't guess and don't put anything on the display." });
        }
        const match = matchPhoto(snapshot, reading);
        collector.photoMatches = match.products.length;
        const products = match.products.map(summary);
        if (match.verdict === "carried") {
          return finish({
            verdict: "carried",
            products,
            note: "We carry the product in the photo. Call check_stock for these ids, put them on the display with show_products, and say it is the one in their photo.",
          });
        }
        if (match.verdict === "similar") {
          return finish({
            verdict: "similar",
            closest: products,
            note: "We do NOT carry this exact product. Tell the shopper so plainly first, then offer these — the closest things we do carry: call check_stock for their ids, put them on the display with show_products, and call them similar, never the same.",
          });
        }
        return finish({
          verdict: "none",
          note: "We don't carry this product or anything like it. Say so plainly in one or two sentences, and say what we do sell (the categories) in one line. Nothing on the display; no substitutes unless the shopper asks.",
        });
      },
    }),

    suggest_replies: tool({
      description:
        "2–4 short quick replies (≤ 48 characters each) the shopper might tap next, specific to THIS moment. Required at the end of every reply except after present_question. Never also list them in your text.",
      inputSchema: z.strictObject({ replies: z.array(z.string()).min(2).max(ASSISTANT_LIMITS.suggestions) }),
      execute: async ({ replies }) => {
        log("suggest_replies");
        const chips: string[] = [];
        for (const reply of replies) {
          const chip = clean(reply, 200);
          if (!chip || chip.length > ASSISTANT_LIMITS.suggestionChars) continue;
          if (!chips.some((c) => c.toLowerCase() === chip.toLowerCase())) chips.push(chip);
        }
        collector.suggestions = chips.slice(0, ASSISTANT_LIMITS.suggestions);
        return { ok: true };
      },
    }),
  };
}

export type AssistantTools = ReturnType<typeof buildTools>;
