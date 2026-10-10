/**
 * Homepage content model (BUILD_SPEC §2.0(b), §6) — a PLAIN module (no "use client" / "server-only"):
 * the server reader (src/lib/content.ts), the storefront components and the admin Homepage /
 * Settings tabs all use the same types, row normalisers, zod block schemas and rich-text parser,
 * so what the admin previews is what the storefront renders (P6).
 *
 * Tables: hero_slides, promo_tiles, content_blocks (supabase/migrations/16_storefront_content.sql,
 * docs/build/SQL_NOTES.md §16). The validators below MIRROR the SQL CHECKs — the database stays the
 * authority; these give the admin a friendly message before it answers.
 *
 * Rich text (hero titles/bodies, promo lines, perks, trust row, ticker, top-bar announcement) is
 * PLAIN TEXT with a tiny, safe mini-markup — never HTML (React escapes every character):
 *   {lime:…} / {violet:…}         a coloured span (no nesting of spans)
 *   a line break or the two characters \n   a <br>
 *   {free_delivery_threshold}     the free-delivery threshold from store_settings, as a <Price>
 *   {returns_window_days}         the returns window (days) from store_settings
 *   "Rs. 12,900" / "LKR 12900"    rendered through <Price> (display-currency aware, BUILD_SPEC §2.7)
 * A line that uses a setting which is off (no threshold = never free; 0 return days) is HIDDEN, and
 * list items may carry `requires` (cod | bank_transfer | pickup | whatsapp | phone): the item is shown
 * only while the store actually offers that (P15 — never promise what the checkout can't keep).
 */

import { z } from "zod";
import { safeImageUrl, SLUG_PATTERN, type SceneVariant } from "@/lib/catalogue-shared";
import { bankTransferReady, phoneDigits, type PublicStoreSettings } from "@/lib/settings-shared";

export const CONTENT_MIGRATION = "16_storefront_content.sql";

type Row = Record<string, unknown>;

// ── Vocabularies (= the CHECK constraints in 16) ─────────────────────────────

export const SCENES: readonly SceneVariant[] = ["night", "paper", "lime", "violet"];
export type Tone = "dark" | "light";
export const TONES: readonly Tone[] = ["dark", "light"];

/** Site path ("/", "/shop?category=laptops", "/#categories") or https URL — hero_slides_links_valid / promo_tiles_href_valid. */
export const LINK_PATTERN = /^(\/([^/\\\s][^\\\s]*)?|https:\/\/[^\\\s]+)$/;
/** "/images/…" or https URL — *_image_valid. */
export const IMAGE_PATTERN = /^(\/[^/\\\s][^\\\s]*|https:\/\/[^\\\s]+)$/;
/** #rgb / #rrggbb — *_background_valid. */
export const HEX_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** CSS object-position, keywords / numbers / % only — promo_tiles_position_valid. */
export const OBJECT_POSITION_PATTERN = /^[a-z0-9%. -]{1,40}$/;

export function isContentLink(value: unknown): value is string {
  return typeof value === "string" && value.length <= 500 && LINK_PATTERN.test(value);
}

export function isContentImage(value: unknown): value is string {
  return typeof value === "string" && value.length <= 1000 && IMAGE_PATTERN.test(value);
}

const isScene = (value: unknown): value is SceneVariant => SCENES.includes(value as SceneVariant);
const isTone = (value: unknown): value is Tone => TONES.includes(value as Tone);

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, maxLength))
    .filter((item): item is string => item !== null)
    .slice(0, maxItems);
}

function isoTime(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function integer(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isInteger(n) ? n : fallback;
}

export type ContentLink = { label: string; href: string };

function link(label: unknown, href: unknown): ContentLink | null {
  const cleanLabel = text(label, 40);
  return cleanLabel && isContentLink(href) ? { label: cleanLabel, href } : null;
}

// ── Hero slides ──────────────────────────────────────────────────────────────

export type HeroSlide = {
  id: number;
  /** Safe for next/image (same-origin path or our Supabase storage); null → the fallback scene. */
  imageUrl: string | null;
  /** The stored value as typed (admin previews; may be an https URL the storefront can't serve). */
  rawImageUrl: string | null;
  /** Optional phone/tablet image (below 1024px, migration 27); null → imageUrl everywhere. */
  mobileImageUrl: string | null;
  rawMobileImageUrl: string | null;
  fallbackScene: SceneVariant;
  tone: Tone;
  /** The image's own edge colour, so the mobile split blends. */
  background: string;
  /** The highlighted label — also the slide's accessible name in the carousel. */
  chip: string | null;
  eyebrow: string | null;
  /** Rich text (see the header). */
  title: string;
  body: string | null;
  cta: ContentLink | null;
  secondary: ContentLink | null;
  /** HUD read-out lines (decorative). */
  readout: string[];
  position: number;
  isActive: boolean;
  startsAt: string | null;
  endsAt: string | null;
};

export function normalizeHeroSlide(row: Row): HeroSlide | null {
  const id = integer(row.id, 0);
  const title = typeof row.title === "string" && row.title.trim() ? row.title.slice(0, 200) : null;
  if (id <= 0 || !title) return null;
  const raw = text(row.image_url, 1000);
  const rawMobile = text(row.mobile_image_url, 1000);
  return {
    id,
    imageUrl: safeImageUrl(raw),
    rawImageUrl: raw,
    mobileImageUrl: safeImageUrl(rawMobile),
    rawMobileImageUrl: rawMobile,
    fallbackScene: isScene(row.fallback_scene) ? row.fallback_scene : "paper",
    tone: isTone(row.tone) ? row.tone : "light",
    background: typeof row.background === "string" && HEX_PATTERN.test(row.background) ? row.background : "#0b0b0c",
    chip: text(row.chip, 40),
    eyebrow: text(row.eyebrow, 80),
    title,
    body: text(row.body, 500),
    cta: link(row.cta_label, row.cta_href),
    secondary: link(row.secondary_label, row.secondary_href),
    readout: textList(row.readout, 6, 40),
    position: integer(row.position, 100),
    isActive: row.is_active !== false,
    startsAt: isoTime(row.starts_at),
    endsAt: isoTime(row.ends_at),
  };
}

/** Active and inside its schedule window at `now` (the public RLS rule, re-applied at render time). */
export function isLiveSlide(slide: Pick<HeroSlide, "isActive" | "startsAt" | "endsAt">, now: number): boolean {
  if (!slide.isActive) return false;
  if (slide.startsAt && Date.parse(slide.startsAt) > now) return false;
  if (slide.endsAt && Date.parse(slide.endsAt) <= now) return false;
  return true;
}

export type SlideStatus = "live" | "scheduled" | "ended" | "hidden";

export function slideStatus(slide: Pick<HeroSlide, "isActive" | "startsAt" | "endsAt">, now: number): SlideStatus {
  if (!slide.isActive) return "hidden";
  if (slide.endsAt && Date.parse(slide.endsAt) <= now) return "ended";
  if (slide.startsAt && Date.parse(slide.startsAt) > now) return "scheduled";
  return "live";
}

// ── Promo tiles ──────────────────────────────────────────────────────────────

export const PROMO_SLOTS = [1, 2, 3, 4] as const;
export type PromoSlot = (typeof PROMO_SLOTS)[number];

export type PromoTile = {
  slot: PromoSlot;
  imageUrl: string | null;
  rawImageUrl: string | null;
  fallbackScene: SceneVariant;
  tone: Tone;
  background: string;
  eyebrow: string | null;
  /** 1–4 display lines (rich text each). */
  titleLines: string[];
  body: string | null;
  ctaLabel: string | null;
  href: string;
  /** CSS object-position ("85% bottom"), validated. */
  imagePosition: string | null;
  isActive: boolean;
};

export function normalizePromoTile(row: Row): PromoTile | null {
  const slot = integer(row.slot, 0);
  if (!(PROMO_SLOTS as readonly number[]).includes(slot)) return null;
  const titleLines = textList(row.title_lines, 4, 40);
  if (titleLines.length === 0 || !isContentLink(row.href)) return null;
  const raw = text(row.image_url, 1000);
  const position = typeof row.image_position === "string" && OBJECT_POSITION_PATTERN.test(row.image_position) ? row.image_position : null;
  return {
    slot: slot as PromoSlot,
    imageUrl: safeImageUrl(raw),
    rawImageUrl: raw,
    fallbackScene: isScene(row.fallback_scene) ? row.fallback_scene : "paper",
    tone: isTone(row.tone) ? row.tone : "light",
    background: typeof row.background === "string" && HEX_PATTERN.test(row.background) ? row.background : "#0b0b0c",
    eyebrow: text(row.eyebrow, 40),
    titleLines,
    body: text(row.body, 160),
    ctaLabel: text(row.cta_label, 40),
    href: row.href,
    imagePosition: position,
    isActive: row.is_active !== false,
  };
}

// ── Settings-backed context: tokens and `requires` ───────────────────────────

export const REQUIREMENTS = ["cod", "bank_transfer", "pickup", "whatsapp", "phone"] as const;
export type Requirement = (typeof REQUIREMENTS)[number];

/** Admin copy: what must be true in Store settings for an item that `requires` it to show. */
export const REQUIREMENT_LABELS: Record<Requirement, string> = {
  cod: "Cash on delivery switched on",
  bank_transfer: "Bank transfer switched on, with bank details entered",
  pickup: "Showroom pickup switched on, with a pickup address",
  whatsapp: "A WhatsApp number",
  phone: "A phone number",
};

export type ContentToken = "free_delivery_threshold" | "returns_window_days";
export const CONTENT_TOKENS: readonly ContentToken[] = ["free_delivery_threshold", "returns_window_days"];
export const TOKEN_LABELS: Record<ContentToken, string> = {
  free_delivery_threshold: "the free-delivery threshold (hidden while delivery is never free)",
  returns_window_days: "the returns window in days (hidden while it is 0)",
};

export type ContentContext = {
  /** LKR; null = delivery is never free. */
  freeDeliveryThreshold: number | null;
  deliveryFee: number;
  returnsWindowDays: number;
  /** What the store offers right now — the same rules quote_order uses for its *_available flags. */
  offers: Record<Requirement, boolean>;
};

export type ContentSettings = Pick<
  PublicStoreSettings,
  | "freeDeliveryThreshold"
  | "deliveryFee"
  | "returnsWindowDays"
  | "codEnabled"
  | "bankTransferEnabled"
  | "bankAccountName"
  | "bankName"
  | "bankBranch"
  | "bankAccountNumber"
  | "bankTransferInstructions"
  | "pickupEnabled"
  | "pickupAddress"
  | "whatsapp"
  | "phone"
>;

export function contentContext(settings: ContentSettings): ContentContext {
  return {
    freeDeliveryThreshold: settings.freeDeliveryThreshold,
    deliveryFee: settings.deliveryFee,
    returnsWindowDays: settings.returnsWindowDays,
    offers: {
      cod: settings.codEnabled,
      // quote_order: bank_transfer_available = enabled AND the account (name, bank, number) set; pickup_available = enabled AND address set
      bank_transfer: bankTransferReady(settings),
      pickup: settings.pickupEnabled && Boolean(settings.pickupAddress?.trim()),
      whatsapp: phoneDigits(settings.whatsapp) !== null,
      phone: phoneDigits(settings.phone) !== null,
    },
  };
}

/** A token's value, or null when the setting is off (the text that uses it is then hidden). */
export function tokenValue(token: ContentToken, ctx: ContentContext): number | null {
  switch (token) {
    case "free_delivery_threshold":
      return ctx.freeDeliveryThreshold;
    case "returns_window_days":
      return ctx.returnsWindowDays > 0 ? ctx.returnsWindowDays : null;
  }
}

// ── Rich text ────────────────────────────────────────────────────────────────

export type RichColor = "lime" | "violet";

export type RichNode =
  | { type: "text"; value: string }
  | { type: "break" }
  | { type: "price"; amount: number; source: string }
  | { type: "token"; token: ContentToken }
  | { type: "span"; color: RichColor; children: RichNode[] };

const MAX_RICH_TEXT = 2000;
const TOKEN_AT = /^\{([a-z_]{1,40})\}/;
const SPAN_AT = /^\{(lime|violet):/;
const BREAK = /\r\n|\r|\n|\\n/;
// "Rs. 12,900", "Rs 450", "LKR 1,000" — whole rupees. Anything else stays text.
const PRICE = /\b(?:Rs\.?|LKR)\s?(\d{1,3}(?:,\d{3})+|\d+)(?!\d)/g;
const MAX_TEXT_PRICE = 100_000_000;

/** Index of the "}" closing a span opened before `from` (token braces inside are skipped), or -1. */
function closingBrace(input: string, from: number): number {
  let depth = 0;
  for (let i = from; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

function plainNodes(value: string): RichNode[] {
  const nodes: RichNode[] = [];
  value.split(BREAK).forEach((part, index) => {
    if (index > 0) nodes.push({ type: "break" });
    let last = 0;
    for (const match of part.matchAll(PRICE)) {
      const amount = Number(match[1].replace(/,/g, ""));
      if (!Number.isSafeInteger(amount) || amount > MAX_TEXT_PRICE) continue;
      const start = match.index ?? 0;
      if (start > last) nodes.push({ type: "text", value: part.slice(last, start) });
      nodes.push({ type: "price", amount, source: match[0] });
      last = start + match[0].length;
    }
    if (last < part.length) nodes.push({ type: "text", value: part.slice(last) });
  });
  return nodes;
}

function parseSegment(input: string, allowSpans: boolean): RichNode[] {
  const nodes: RichNode[] = [];
  let plain = "";
  const flush = () => {
    if (plain) nodes.push(...plainNodes(plain));
    plain = "";
  };
  let i = 0;
  while (i < input.length) {
    if (input[i] === "{") {
      const ahead = input.slice(i, i + 48);
      const token = TOKEN_AT.exec(ahead);
      if (token && (CONTENT_TOKENS as readonly string[]).includes(token[1])) {
        flush();
        nodes.push({ type: "token", token: token[1] as ContentToken });
        i += token[0].length;
        continue;
      }
      const span = allowSpans ? SPAN_AT.exec(ahead) : null;
      if (span) {
        const start = i + span[0].length;
        const end = closingBrace(input, start);
        if (end !== -1) {
          flush();
          nodes.push({ type: "span", color: span[1] as RichColor, children: parseSegment(input.slice(start, end), false) });
          i = end + 1;
          continue;
        }
      }
    }
    plain += input[i];
    i += 1;
  }
  flush();
  return nodes;
}

/** Parse the mini-markup into nodes. Never throws; unknown braces stay literal text. */
export function parseRichText(input: string | null | undefined): RichNode[] {
  if (!input) return [];
  return parseSegment(input.slice(0, MAX_RICH_TEXT), true);
}

function collectTokens(nodes: RichNode[], into: Set<ContentToken>): Set<ContentToken> {
  for (const node of nodes) {
    if (node.type === "token") into.add(node.token);
    else if (node.type === "span") collectTokens(node.children, into);
  }
  return into;
}

export function richTextTokens(input: string | null | undefined): ContentToken[] {
  return [...collectTokens(parseRichText(input), new Set())];
}

/** Plain text for accessible names and admin lists ("Grand opening sale_"). */
export function richPlainText(input: string | null | undefined, ctx?: ContentContext): string {
  const walk = (nodes: RichNode[]): string =>
    nodes
      .map((node) => {
        switch (node.type) {
          case "text":
            return node.value;
          case "break":
            return " ";
          case "price":
            return node.source;
          case "token": {
            const value = ctx ? tokenValue(node.token, ctx) : null;
            if (value === null) return `{${node.token}}`;
            return node.token === "free_delivery_threshold" ? `Rs. ${Math.round(value).toLocaleString("en-US")}` : String(value);
          }
          case "span":
            return walk(node.children);
        }
      })
      .join("");
  return walk(parseRichText(input)).replace(/\s+/g, " ").trim();
}

/** Every token the texts use has a value right now (else the line is hidden, P15). */
export function textsShown(texts: readonly (string | null | undefined)[], ctx: ContentContext): boolean {
  return texts.every((value) => richTextTokens(value).every((token) => tokenValue(token, ctx) !== null));
}

/**
 * Why an item is hidden on the storefront right now ([] = shown): unmet `requires` and tokens whose
 * setting is off. The admin shows these reasons; the storefront just filters.
 */
export function hiddenReasons(item: { requires?: readonly Requirement[] | null; texts: readonly (string | null | undefined)[] }, ctx: ContentContext): string[] {
  const reasons: string[] = [];
  for (const requirement of item.requires ?? []) {
    if (!ctx.offers[requirement]) reasons.push(`needs: ${REQUIREMENT_LABELS[requirement]}`);
  }
  const tokens = new Set<ContentToken>();
  for (const value of item.texts) for (const token of richTextTokens(value)) tokens.add(token);
  for (const token of tokens) {
    if (tokenValue(token, ctx) === null) reasons.push(`uses ${TOKEN_LABELS[token]}`);
  }
  return reasons;
}

export function isShown(item: { requires?: readonly Requirement[] | null; texts: readonly (string | null | undefined)[] }, ctx: ContentContext): boolean {
  return hiddenReasons(item, ctx).length === 0;
}

// ── Content blocks (zod, one schema per key) ─────────────────────────────────

const tooLong = (max: number) => ({ error: `up to ${max} characters` });
const optionalText = (max: number) => z.string().trim().max(max, tooLong(max)).default("");
const requiredText = (max: number) => z.string().trim().min(1, { error: "required" }).max(max, tooLong(max));
const requiresSchema = z.array(z.enum(REQUIREMENTS)).max(REQUIREMENTS.length).optional();
const productSlug = z.string().trim().max(120, tooLong(120)).regex(SLUG_PATTERN, { error: "pick a product" });

/** lucide icons for the hero perks strip and the order-your-way list (components/home/icons.ts). */
export const LIST_ICONS = ["truck", "shield", "returns", "warranty", "support", "cod", "store", "whatsapp"] as const;
export type ListIcon = (typeof LIST_ICONS)[number];
/** The animated trust-row icons (components/home/TrustIcons.tsx). */
export const TRUST_ICONS = ["secure", "delivery", "returns", "support", "warranty"] as const;
export type TrustIcon = (typeof TRUST_ICONS)[number];

const listItem = (titleMax: number, textMax: number) =>
  z.object({ icon: z.enum(LIST_ICONS), title: requiredText(titleMax), text: optionalText(textMax), requires: requiresSchema });

export const heroPerksSchema = z.object({
  items: z.array(listItem(40, 80)).min(1, { error: "add at least one perk" }).max(4, { error: "at most 4 perks" }),
});

export const trustRowSchema = z.object({
  items: z
    .array(z.object({ icon: z.enum(TRUST_ICONS), title: requiredText(60), text: optionalText(160), requires: requiresSchema }))
    .min(1, { error: "add at least one item" })
    .max(6, { error: "at most 6 items" }),
});

export const orderYourWaySchema = z.object({
  title: requiredText(60),
  body: optionalText(300),
  items: z.array(listItem(40, 80)).max(4, { error: "at most 4 ways" }),
  art: z
    .object({ top: productSlug.nullable().optional(), bottom: productSlug.nullable().optional() })
    .optional(),
});

export const storeStatusSchema = z.object({
  rows: z
    .array(z.object({ label: requiredText(40), value: requiredText(24), level: z.number().min(0, { error: "0–100 %" }).max(1, { error: "0–100 %" }) }))
    .max(6, { error: "at most 6 rows" }),
  banner: optionalText(60),
});

/** An owner-entered quote. A featured approved review (Reviews tab) takes its place automatically. */
export const testimonialSchema = z.object({
  quote: z.string().trim().min(10, { error: "at least 10 characters" }).max(600, tooLong(600)),
  author: requiredText(60),
  detail: optionalText(60),
});

export const newArrivalsFeatureSchema = z.object({ product: productSlug, title: requiredText(60), kicker: optionalText(60) });

export const CONTENT_BLOCK_SCHEMAS = {
  hero_perks: heroPerksSchema,
  trust_row: trustRowSchema,
  order_your_way: orderYourWaySchema,
  store_status: storeStatusSchema,
  testimonial: testimonialSchema,
  new_arrivals_feature: newArrivalsFeatureSchema,
} as const;

export type ContentBlockKey = keyof typeof CONTENT_BLOCK_SCHEMAS;
export type ContentBlockData<K extends ContentBlockKey> = z.infer<(typeof CONTENT_BLOCK_SCHEMAS)[K]>;

export type HeroPerks = ContentBlockData<"hero_perks">;
export type TrustRowBlock = ContentBlockData<"trust_row">;
export type OrderYourWayBlock = ContentBlockData<"order_your_way">;
export type StoreStatusBlock = ContentBlockData<"store_status">;
export type TestimonialBlock = ContentBlockData<"testimonial">;
export type NewArrivalsFeatureBlock = ContentBlockData<"new_arrivals_feature">;

export type BlockParse<K extends ContentBlockKey> = { ok: true; data: ContentBlockData<K> } | { ok: false; issues: string[] };

/** ["items", 0, "title"] → "Item 1 · title". */
function issuePath(path: readonly PropertyKey[]): string {
  const parts: string[] = [];
  for (let i = 0; i < path.length; i += 1) {
    const part = path[i];
    const next = path[i + 1];
    if ((part === "items" || part === "rows") && typeof next === "number") {
      parts.push(`${part === "rows" ? "Row" : "Item"} ${next + 1}`);
      i += 1;
    } else {
      parts.push(String(part));
    }
  }
  return parts.join(" · ");
}

/** Validate a block's JSON against its key's schema. Invalid → issues (the section hides; the admin shows them). */
export function parseContentBlock<K extends ContentBlockKey>(key: K, data: unknown): BlockParse<K> {
  const result = CONTENT_BLOCK_SCHEMAS[key].safeParse(data);
  if (result.success) return { ok: true, data: result.data as ContentBlockData<K> };
  return {
    ok: false,
    issues: result.error.issues.slice(0, 8).map((issue) => `${issue.path.length ? `${issuePath(issue.path)}: ` : ""}${issue.message}`),
  };
}

// ── Small shared helpers ─────────────────────────────────────────────────────

/** "Rashmi Fernando" → "RF"; any script (first letter of the first two words). */
export function initials(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("");
  return letters.toLocaleUpperCase("en-US") || "·";
}

/** Two-digit section / slide index ("01"). */
export function sectionIndex(n: number): string {
  return String(n).padStart(2, "0");
}
