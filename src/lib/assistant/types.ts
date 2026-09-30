/**
 * The assistant's wire format (blueprint §10.3) — imported by the browser widget AND the server
 * route, so it holds only types and the handful of constants both sides must agree on. No server
 * imports, no React, no directive (blueprint §5 "types shared between browser and server live in
 * a types-only module").
 *
 * Adaptations to this store (BUILD_SPEC §2.8 variant model B, P4, P14), each server-built:
 * - a card carries `slug`, `categoryId`, `href` and its default (cheapest) variant so the widget
 *   can put it in the basket through `cart.add()` without inventing anything;
 * - stock is reported in BANDS ("in" / "low" + how many left / "out") — the exact level of a
 *   well-stocked variant never leaves the database (the same rule as /api/availability and
 *   quote_order);
 * - an `add_to_cart` action names the variant id it adds.
 */

// ── Outcomes (blueprint §10.13) ───────────────────────────────────────────────
// The SAME eight labels live in THREE places: this list, CHECK assistant_messages_outcome_valid
// and the coercion inside log_assistant_turn (supabase/migrations/19_assistant_core.sql).
// Change all three together (blueprint §18 "Changing a business rule").

export const ASSISTANT_OUTCOMES = ["truncated", "bad_ids", "no_image_match", "no_match", "no_tools", "dead_end", "answered", "failed"] as const;
export type AssistantOutcome = (typeof ASSISTANT_OUTCOMES)[number];

/** What each outcome means and what the owner does about it (blueprint §10.13) — the admin insights legend. */
export const OUTCOME_INFO: Record<AssistantOutcome, { label: string; meaning: string; action: string }> = {
  truncated: { label: "Truncated", meaning: "Ran out of output tokens or steps while still working.", action: "Raise the step budget or output tokens." },
  bad_ids: { label: "Bad ids", meaning: "Tried to show products that don't exist (nothing was staged).", action: "Prompt or catalogue-digest fix." },
  no_image_match: { label: "Photo: no match", meaning: "Read a photo, searched, found nothing to show.", action: "Catalogue gap: a product people own." },
  no_match: { label: "No match", meaning: "A search came back empty and nothing was shown.", action: "Catalogue gap: consider stocking it." },
  no_tools: { label: "No tools", meaning: "Answered without looking anything up.", action: "Prompt discipline." },
  dead_end: { label: "Dead end", meaning: "No text and nothing on display.", action: "A bug — check the transcript." },
  answered: { label: "Answered", meaning: "A normal turn.", action: "—" },
  failed: { label: "Failed", meaning: "The model call threw (provider error or timeout).", action: "Provider or timeout health." },
};

export function isAssistantOutcome(value: unknown): value is AssistantOutcome {
  return typeof value === "string" && (ASSISTANT_OUTCOMES as readonly string[]).includes(value);
}

// ── Limits both sides apply (the server re-clamps everything) ─────────────────

export const ASSISTANT_LIMITS = {
  /** Messages sent per turn (blueprint §10.14 "It sends the last 12 messages"). */
  historySent: 12,
  /** Messages kept in the browser (blueprint §10.14 "messages (≤ 30)"). */
  historyStored: 30,
  /** A user turn, in characters (§10.12 step 4). */
  userChars: 1000,
  /** An assistant turn as replayed in history, notes included (§10.12 step 4). */
  assistantChars: 2500,
  /** viewedProductIds / tappedProductIds (§10.12 step 5). */
  ids: 12,
  /** base64 JPEG length bounds (§10.12 step 6). */
  imageMinChars: 512,
  imageMaxChars: 400_000,
  /** Cards on the stage (§10.3). */
  cards: 3,
  /** Quick-reply chips and their length (§10.6 suggest_replies). */
  suggestions: 4,
  suggestionChars: 48,
  /** add_to_cart actions per turn (§10.6). */
  actions: 3,
  /** The page path (§10.12 step 5). */
  pageChars: 120,
} as const;

// ── Request ───────────────────────────────────────────────────────────────────

export type AssistantChatRole = "user" | "assistant";
export type AssistantChatMessage = { role: AssistantChatRole; content: string };

export type AssistantImage = { mediaType: "image/jpeg"; data: string };

export type AssistantRequest = {
  /** UUID minted by the browser, persisted across pages. */
  sessionId: string;
  /** The last ≤ 12 turns (private memory notes appended to assistant turns); MUST end on a user turn. */
  messages: AssistantChatMessage[];
  /** "/product/42" → the agent sees the shelf. Path only. */
  page?: string;
  /** Browse trail this session, most recent first, ≤ 12. */
  viewedProductIds?: number[];
  /** ADD taps on staged cards since the last turn (analytics only). */
  tappedProductIds?: number[];
  /** ADVISORY bag subtotal in LKR — only for "X more and delivery is free" and pricing offers. */
  cartSubtotal?: number;
  /** Latest turn only: base64 JPEG ≤ 400k chars. Never stored. */
  image?: AssistantImage;
  /** Honeypot. */
  company?: string;
};

// ── Stage (the display zone shows ONE thing at a time) ─────────────────────────

export type StageQuestionOption = { value: string; label: string; hint?: string };
export type StageQuestion = { id: string; prompt: string; options: StageQuestionOption[] };

/** Live stock band of one variant (checked this turn). `left` only for "low". */
export type AssistantStockBand = { variant: string; state: "in" | "low" | "out"; left?: number };

/** Every field built by the SERVER from the catalogue snapshot (P4). Prices are LKR; the widget converts for display. */
export type AssistantCard = {
  id: number;
  slug: string;
  brand: string;
  name: string;
  subtitle: string;
  categoryId: string;
  /** "From" price: the cheapest active variant. */
  price: number;
  compareAtPrice: number | null;
  /** Same-origin or our storage URL; null → wireframe art. */
  image: string | null;
  /** Active variant names, in position order. */
  variants: string[];
  /** Attributes worth showing on the card (curated highlights, else the first spec facts). */
  highlights: string[];
  /** null = not checked this turn. */
  stock: AssistantStockBand[] | null;
  /** The variant a one-tap add puts in the basket (the cheapest active one); null = not purchasable. */
  defaultVariantId: number | null;
  defaultVariantName: string | null;
  href: string;
};

export type AssistantStage =
  | { kind: "products"; products: AssistantCard[] }
  | { kind: "question"; question: StageQuestion }
  | { kind: "order_lookup"; prefillOrderRef?: string };

/** Built only from a validated add_to_cart tool call; executed by the widget (cart.add → cart.open). */
export type AssistantAction = {
  type: "add_to_cart";
  product: {
    id: number;
    slug: string;
    brand: string;
    name: string;
    /** The chosen variant's price (display hint — /api/quote re-prices the basket). */
    price: number;
    compareAtPrice: number | null;
    image: string | null;
    categoryId: string;
  };
  variantId: number;
  /** Variant name. */
  variant: string;
  quantity: number;
};

// ── Response ──────────────────────────────────────────────────────────────────

export type AssistantResponse = {
  ok: boolean;
  /** Plain text, blank-line paragraphs, no markdown. */
  content?: string;
  /** null = leave the stage as it was. */
  stage?: AssistantStage | null;
  /** ≤ 4 quick-reply chips (none while a question or the order form is on the stage). */
  suggestions?: string[];
  /** ≤ 3, executed by the widget. */
  actions?: AssistantAction[];
  /** Parked for checkout with stashOfferCode() — NOT applied; the shopper presses Apply. */
  offerCode?: string;
  /** Text memory of the photo (the widget replays it as a private note). */
  photoReading?: string;
  /** Friendly copy only. */
  error?: string;
};

// ── Private order lookup (blueprint §10.8) — never touches the model ──────────

export type AssistantOrderLookupRequest = {
  sessionId: string;
  orderRef: string;
  email: string;
  company?: string;
};

export type AssistantOrderItem = { productId: number | null; variantId: number | null; name: string; variant: string | null; quantity: number };
export type AssistantOrderEvent = { status: string; location: string | null; description: string | null; updatedAt: string | null };

/** The narrow view: no money, address, phone or email. */
export type AssistantOrderView = {
  orderId: string;
  status: string;
  /** Delivery vs showroom pickup — so "out for delivery" reads "ready for pickup" when it is one. */
  fulfillment: "delivery" | "pickup";
  placedAt: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  items: AssistantOrderItem[];
  events: AssistantOrderEvent[];
};

export type AssistantOrderLookupResponse = { ok: true; order: AssistantOrderView } | { ok: false; error: string; code?: string };

// ── Private memory notes (blueprint §10.14) ───────────────────────────────────
// Appended to turns in the history the widget sends — never shown to the shopper. The system
// prompt tells the model they are private; the route strips any the model echoes.

export const MEMORY_NOTE = {
  showed: (items: string[]) => `[You showed, in order: ${items.join("; ")}]`,
  asked: (options: string[]) => `[You asked this with tappable options: ${options.join(" | ")}]`,
  orderForm: "[You put the secure order-lookup form on the display. You cannot see the customer's email or their order.]",
  photo: "[The customer attached a photograph here.]",
  reading: (reading: string) => `[You read the photograph as: ${reading}]`,
  orderItems: (items: string[]) => `[The customer looked up their order in the secure form; it contains: ${items.join("; ")}]`,
} as const;
