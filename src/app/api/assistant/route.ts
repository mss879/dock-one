import { generateText, isStepCount, type ModelMessage } from "ai";
import type { NextRequest } from "next/server";
import { getAssistantCatalogue, resolveCards, type AssistantSnapshot, type SnapshotProduct } from "@/lib/assistant/catalogue";
import { getCustomerContext, hasAuthCookie } from "@/lib/assistant/customer";
import { failedTurnSignals, logAssistantTurn, readTurnSignals } from "@/lib/assistant/insights";
import { getModel, getVisionModel, isModelConfigured, isVisionEnabled, MODEL_IDS, PROVIDER_OPTIONS } from "@/lib/assistant/model";
import { buildSystemPrompt } from "@/lib/assistant/prompt";
import { buildTools, createCollector, STEP_BUDGET, type AssistantCollector } from "@/lib/assistant/tools";
import { ASSISTANT_LIMITS, type AssistantChatMessage, type AssistantImage, type AssistantResponse, type AssistantStage } from "@/lib/assistant/types";
import { amountToFreeDelivery, type DeliveryRule } from "@/lib/delivery";
import { isSupabaseConfigured } from "@/lib/env";
import { formatLKR } from "@/lib/format";
import { json, MESSAGES } from "@/lib/http";
import { normalizeOrderRef } from "@/lib/orders";
import { bucket, checkRateLimit, clientKey, hashKey, ipBucket } from "@/lib/rate-limit";
import { ASSISTANT_BODY_LIMIT, cleanText, isBot, isPlainObject, isUuid, readJsonBody } from "@/lib/request-guard";
import { getStoreSettings } from "@/lib/settings";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /api/assistant — one shopper message → one JSON envelope (blueprint §10.12, §8).
 *
 *  1. env (DB + model) → 503 "away"          9. context lines (page product, viewed trail, bag)
 *  2. body ≤ 512 KB, object → else 400/413/422 10. generateText (tools, collector, step budget)
 *  3. honeypot → fake success                11. image failed (not a timeout, ≥ 4 s left) → ONE
 *  4. UUID session; clampHistory()               text-only retry; otherwise 502 apology
 *  5. page / ids / subtotal sanitised        12. stage: order form > question > products > null
 *  6. parseImage() (JPEG base64 ≤ 400k)      13. empty text → a stage-appropriate line
 *  7. IP + session limits (+ photo limits)   14. chip salvage — BEFORE logging
 *  8. snapshot + memory + settings (parallel) 15. log_assistant_turn (fail-soft)  16. respond
 *
 * One JSON envelope per turn, not a token stream: every visual element (cards, stage, basket
 * actions) is resolved against the database AFTER the model finishes (P4). A shopper never sees
 * an internal error — only friendly copy (§10.1).
 */

/** Must sit under the host's function limit (Vercel default 60 s). */
export const maxDuration = 60;

const TURN_BUDGET_MS = 24_000;
const MIN_RETRY_MS = 4_000;
const MAX_OUTPUT_TOKENS = 700;
const MAX_REPLY_CHARS = 4000;
/** Mirrors validate_discount's p_subtotal clamp (09): the bag figure is advisory, never charged. */
const MAX_CART_SUBTOTAL = 1_000_000_000;

const AWAY = "The tech desk is away right now. Please try again in a little while, or reach us through the contact page.";
const APOLOGY = "Sorry, I couldn't answer that just now. Please try again in a moment.";
const PHOTO_UNREADABLE = "I couldn't read that photograph, so this answer is from your message alone.";
const PHOTO_OFF = "Photo reading is switched off at the moment, so I haven't looked at your picture.";
const PHOTO_INVALID = "That photo couldn't be sent. Please try another one.";
const PHOTO_SLOW_DOWN = "That's a lot of photos in a short time. Please wait a few minutes before sending another.";

const reply = (body: AssistantResponse, status = 200) => json<AssistantResponse>(body, status);

// ── 4–6. Input sanitising ─────────────────────────────────────────────────────

/** Valid turns only, trimmed and clamped, the last 12 — and it MUST end on a user turn. */
function clampHistory(raw: unknown): AssistantChatMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const turns: AssistantChatMessage[] = [];
  for (const item of raw.slice(-60)) {
    if (!isPlainObject(item)) continue;
    const role = item.role === "user" || item.role === "assistant" ? item.role : null;
    if (!role) continue;
    const content = cleanText(item.content, role === "user" ? ASSISTANT_LIMITS.userChars : ASSISTANT_LIMITS.assistantChars);
    if (content) turns.push({ role, content });
  }
  const recent = turns.slice(-ASSISTANT_LIMITS.historySent);
  return recent.length > 0 && recent[recent.length - 1].role === "user" ? recent : null;
}

/** A site path only ("/product/42"): no scheme, host, query or fragment; ≤ 120 chars. */
function sanitizePage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.split(/[?#]/)[0].trim();
  if (!path.startsWith("/") || path.startsWith("//") || path.length > ASSISTANT_LIMITS.pageChars) return null;
  return /^\/[A-Za-z0-9\-._~/%]*$/.test(path) ? path : null;
}

function sanitizeIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids: number[] = [];
  for (const value of raw.slice(0, 50)) {
    if (typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2147483647 && !ids.includes(value)) ids.push(value);
    if (ids.length >= ASSISTANT_LIMITS.ids) break;
  }
  return ids;
}

function sanitizeSubtotal(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.min(Math.round(raw), MAX_CART_SUBTOTAL);
}

/** JPEG only, base64 charset, 512 ≤ length ≤ 400 000. undefined/null → no image; anything else → "invalid". */
function parseImage(raw: unknown): AssistantImage | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw) || raw.mediaType !== "image/jpeg" || typeof raw.data !== "string") return "invalid";
  const data = raw.data;
  if (data.length < ASSISTANT_LIMITS.imageMinChars || data.length > ASSISTANT_LIMITS.imageMaxChars) return "invalid";
  // base64 of a JPEG starts with FF D8 FF → "/9j/".
  if (!data.startsWith("/9j/") || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return "invalid";
  return { mediaType: "image/jpeg", data };
}

// ── 9. Context lines ──────────────────────────────────────────────────────────

const label = (p: SnapshotProduct) => (!p.brand || p.name.toLowerCase().startsWith(p.brand.toLowerCase()) ? p.name : `${p.brand} ${p.name}`);

function contextLines(input: {
  page: string | null;
  viewedIds: number[];
  cartSubtotal: number | null;
  rule: DeliveryRule;
  snapshot: AssistantSnapshot;
  photoNote: string | null;
}): string[] {
  const { snapshot } = input;
  const lines: string[] = [];
  if (input.page) {
    const match = /^\/product\/(\d{1,10})(?:\/|$)/.exec(input.page);
    const product = match ? snapshot.byId.get(Number(match[1])) : undefined;
    lines.push(
      product
        ? `Page: ${input.page} — the shopper is looking at #${product.id} ${label(product)} (${product.variants.length > 1 ? "from " : ""}${formatLKR(product.price)}).`
        : `Page: ${input.page}.`,
    );
  }
  const viewed = input.viewedIds.map((id) => snapshot.byId.get(id)).filter((p): p is SnapshotProduct => Boolean(p));
  if (viewed.length > 0) {
    lines.push(`Viewed this visit, most recent first (acknowledge naturally when it helps; never recite the list): ${viewed.map((p) => `#${p.id} ${label(p)}`).join("; ")}.`);
  }
  if (input.cartSubtotal !== null) {
    const toFree = amountToFreeDelivery(input.cartSubtotal, input.rule);
    const delivery = toFree === null ? "" : toFree > 0 ? `; ${formatLKR(toFree)} more makes delivery free` : "; delivery is already free";
    lines.push(`Bag: about ${formatLKR(input.cartSubtotal)}${delivery}.`);
  } else {
    lines.push("Bag: empty.");
  }
  if (input.photoNote) lines.push(input.photoNote);
  return lines;
}

// ── 10–14. Output handling ────────────────────────────────────────────────────

/** Private memory notes the model may echo ("[You showed, in order: …]") are stripped. */
function stripMemoryNotes(text: string): string {
  return text.replace(/\[(?:You|The customer)\b[^\]\n]{0,600}\]/g, "");
}

/** Plain text: light markdown residue removed, blank-line paragraphs, clamped. */
function tidy(text: string): string {
  return stripMemoryNotes(text)
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_REPLY_CHARS)
    .trim();
}

/** The reply: the text of every step, in order (a model may write its answer beside a tool call). */
function replyText(steps: readonly { text: string }[]): string {
  const parts: string[] = [];
  for (const step of steps) {
    const text = tidy(step.text ?? "");
    if (text && !parts.includes(text)) parts.push(text);
  }
  return tidy(parts.join("\n\n"));
}

function fallbackLine(stage: AssistantStage | null): string {
  if (stage?.kind === "products") return "Here's what I found.";
  if (stage?.kind === "question") return stage.question.prompt;
  if (stage?.kind === "order_lookup") return "Use the secure form to look up your order. I can't see what you type there.";
  return "Sorry, I didn't catch that. Could you put it another way?";
}

/**
 * No suggest_replies call, but the reply ENDS with 2–4 short, unpunctuated lines: those are
 * chips — turn them into chips, cut them from the text, and drop an orphaned lead-in
 * ("Quick options:"). Done BEFORE logging, so the log matches what the shopper saw.
 */
function salvageChips(text: string): { text: string; chips: string[] } | null {
  const lines = text.split("\n");
  let i = lines.length - 1;
  while (i >= 0 && lines[i].trim() === "") i -= 1;
  const chips: string[] = [];
  while (i >= 0) {
    const raw = lines[i].trim();
    if (!raw) break;
    const line = raw.replace(/^(?:[-*•]|\d{1,2}[.)])\s+/, "").replace(/^["“']|["”']$/g, "").trim();
    if (line.length < 2 || line.length > ASSISTANT_LIMITS.suggestionChars || /[.!?:;,]$/.test(line)) break;
    chips.unshift(line);
    i -= 1;
  }
  if (chips.length < 2 || chips.length > ASSISTANT_LIMITS.suggestions) return null;
  let rest = lines.slice(0, i + 1);
  let j = rest.length - 1;
  while (j >= 0 && rest[j].trim() === "") j -= 1;
  if (j >= 0 && /:\s*$/.test(rest[j]) && rest[j].trim().length <= 40) rest = rest.slice(0, j);
  const remaining = rest.join("\n").trim();
  return remaining ? { text: remaining, chips } : null;
}

/** The order-form prefill survives only if the shopper literally typed that number (and it has the shape). */
function verifiedPrefill(ref: string | null, history: readonly AssistantChatMessage[]): string | null {
  const wanted = normalizeOrderRef(ref);
  if (!wanted) return null;
  const typed = new Set<string>();
  for (const message of history) {
    if (message.role !== "user") continue;
    for (const match of message.content.matchAll(/(?:#|\bDO[-\s]?)?\d{3,12}\b/gi)) {
      const normalized = normalizeOrderRef(match[0]);
      if (normalized) typed.add(normalized);
    }
  }
  return typed.has(wanted) ? wanted : null;
}

function isTimeout(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error || (typeof current === "object" && current !== null)) {
      const name = (current as { name?: unknown }).name;
      const message = (current as { message?: unknown }).message;
      if (name === "TimeoutError" || name === "AbortError") return true;
      if (typeof message === "string" && /timed? ?out|aborted/i.test(message)) return true;
      current = (current as { cause?: unknown; lastError?: unknown }).cause ?? (current as { lastError?: unknown }).lastError;
    } else break;
  }
  return false;
}

const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

function toModelMessages(history: readonly AssistantChatMessage[], image: AssistantImage | null): ModelMessage[] {
  return history.map((message, index): ModelMessage => {
    if (message.role === "assistant") return { role: "assistant", content: message.content };
    if (image && index === history.length - 1) {
      // The photo rides ONLY on the latest user turn, as a FilePart (never replayed, never stored).
      return {
        role: "user",
        content: [
          { type: "text", text: message.content },
          { type: "file", mediaType: "image/jpeg", data: { type: "data", data: image.data } },
        ],
      };
    }
    return { role: "user", content: message.content };
  });
}

// ── The route ─────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const started = Date.now();

  // 1. Environment: the database and the model.
  if (!isSupabaseConfigured || !isModelConfigured) return reply({ ok: false, error: AWAY }, 503);

  // 2. Bounded read.
  const parsed = await readJsonBody(request, ASSISTANT_BODY_LIMIT);
  if (!parsed.ok) return reply({ ok: false, error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return reply({ ok: false, error: MESSAGES.invalid }, 422);
  const body = parsed.body;

  // 3. Honeypot: a fake success, indistinguishable from a quiet answer.
  if (isBot(body.company)) return reply({ ok: true, content: "" });

  // 4. Session + history.
  const sessionId = isUuid(body.sessionId) ? body.sessionId.toLowerCase() : null;
  const history = clampHistory(body.messages);
  if (!sessionId || !history) return reply({ ok: false, error: MESSAGES.invalid }, 422);
  const userContent = history[history.length - 1].content;

  // 5. Context the browser may send (all advisory, all re-validated against the snapshot).
  const page = sanitizePage(body.page);
  const viewedIds = sanitizeIds(body.viewedProductIds);
  const tappedIds = sanitizeIds(body.tappedProductIds);
  const cartSubtotal = sanitizeSubtotal(body.cartSubtotal);

  // 6. The photo.
  const image = parseImage(body.image);
  if (image === "invalid") return reply({ ok: false, error: PHOTO_INVALID }, 422);
  const photoAttached = image !== null;
  const withImage = image !== null && isVisionEnabled;

  // 7. Rate limits — each its own round trip, before any other database work.
  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("assistant", request), 20, 300))) return reply({ ok: false, error: MESSAGES.slowDown }, 429);
  if (!(await checkRateLimit(supabase, bucket("assistant", "session", sessionId), 80, 3600))) return reply({ ok: false, error: MESSAGES.slowDown }, 429);
  if (photoAttached) {
    if (!(await checkRateLimit(supabase, ipBucket("assistant_photo", request), 6, 900))) return reply({ ok: false, error: PHOTO_SLOW_DOWN }, 429);
    if (!(await checkRateLimit(supabase, bucket("assistant_photo", "session", sessionId), 12, 3600))) return reply({ ok: false, error: PHOTO_SLOW_DOWN }, 429);
  }

  const clientKeyHash = hashKey(clientKey(request));
  const logFailure = (collector: AssistantCollector | null, error: string, model: string | null) => {
    const signals = failedTurnSignals(collector ?? createCollector());
    return logAssistantTurn(supabase, {
      sessionId,
      userContent,
      assistantContent: error,
      outcome: signals.outcome,
      shownProductIds: [],
      addedProductIds: [],
      tappedProductIds: tappedIds,
      questionId: null,
      toolsUsed: signals.toolsUsed,
      searchTerms: signals.searchTerms,
      page,
      model,
      latencyMs: Date.now() - started,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      hasImage: photoAttached,
      photoReading: collector?.photoReading ?? null,
      clientKey: clientKeyHash,
    });
  };

  // 8. Snapshot (cached) + returning-customer memory (cookie-gated) + settings, in parallel.
  const [snapshot, customer, settings] = await Promise.all([
    getAssistantCatalogue().catch((error: unknown) => {
      console.error(`[assistant] catalogue unavailable: ${describe(error)}`);
      return null;
    }),
    hasAuthCookie(request) ? getCustomerContext(sessionId, clientKeyHash) : Promise.resolve(null),
    getStoreSettings(),
  ]);
  if (!snapshot) {
    await logFailure(null, AWAY, null);
    return reply({ ok: false, error: AWAY }, 503);
  }
  const rule: DeliveryRule = { deliveryFee: settings.deliveryFee, freeDeliveryThreshold: settings.freeDeliveryThreshold };

  // 9 + 10. One attempt = one collector, one tool set, one generation.
  const collectors: AssistantCollector[] = [];
  const attempt = async (useImage: boolean, budget: number, photoNote: string | null) => {
    const collector = createCollector();
    collectors.push(collector);
    const tools = buildTools({
      snapshot,
      collector,
      sessionId,
      supabase,
      cartSubtotal,
      deliveryRule: rule,
      hasImage: useImage,
      allowOfferCall: () => checkRateLimit(supabase, ipBucket("assistant_offers", request), 12, 600),
    });
    const remaining = TURN_BUDGET_MS - (Date.now() - started);
    const generation = await generateText({
      model: useImage ? getVisionModel() : getModel(),
      providerOptions: PROVIDER_OPTIONS,
      instructions: buildSystemPrompt({
        snapshot,
        settings,
        customer,
        photoTurn: useImage,
        contextLines: contextLines({ page, viewedIds, cartSubtotal, rule, snapshot, photoNote }),
      }),
      messages: toModelMessages(history, useImage ? (image as AssistantImage) : null),
      tools,
      // `isStepCount` is ai 7's name for the blueprint's `stepCountIs` (the old name is a deprecated alias).
      stopWhen: isStepCount(budget),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(Math.max(1000, remaining)),
    });
    return { generation, collector, usedImage: useImage, budget };
  };

  let result: Awaited<ReturnType<typeof attempt>> | null = null;
  let prefix: string | null = photoAttached && !isVisionEnabled ? PHOTO_OFF : null;
  const firstNote = photoAttached && !isVisionEnabled ? "The shopper attached a photograph, but photo reading is switched off so you cannot see it; they have already been told. Help from their words." : null;
  try {
    result = await attempt(withImage, withImage ? STEP_BUDGET.photo : STEP_BUDGET.text, firstNote);
  } catch (error) {
    console.error(`[assistant] Assistant generation failed: ${describe(error)}`);
    // 11. An image turn that failed for a reason other than time gets ONE text-only retry.
    if (withImage && !isTimeout(error) && TURN_BUDGET_MS - (Date.now() - started) >= MIN_RETRY_MS) {
      try {
        result = await attempt(false, STEP_BUDGET.retry, "The shopper attached a photograph that could not be read; they have already been told. Help from their words.");
        prefix = PHOTO_UNREADABLE;
      } catch (retryError) {
        console.error(`[assistant] text-only retry failed: ${describe(retryError)}`);
      }
    }
  }
  if (!result) {
    await logFailure(collectors[collectors.length - 1] ?? null, APOLOGY, withImage ? MODEL_IDS.vision : MODEL_IDS.text);
    return reply({ ok: false, error: APOLOGY }, 502);
  }

  const { generation, collector, usedImage, budget } = result;

  // 12. Stage: the order form > a question > products (server-resolved) > leave it as it was.
  let stage: AssistantStage | null = null;
  if (collector.stagedOrderLookup) {
    const prefill = verifiedPrefill(collector.stagedOrderLookup.prefillOrderRef, history);
    stage = prefill ? { kind: "order_lookup", prefillOrderRef: prefill } : { kind: "order_lookup" };
  } else if (collector.stagedQuestion) {
    stage = { kind: "question", question: collector.stagedQuestion };
  } else if (collector.stagedIds.length > 0) {
    const cards = resolveCards(collector.stagedIds, snapshot, collector.stockById);
    if (cards.length > 0) stage = { kind: "products", products: cards };
  }

  // 13. Text (empty → a line that fits the stage).
  let content = replyText(generation.steps);
  const hadText = content.length > 0;

  // 14. Chip salvage, before logging.
  let suggestions = collector.suggestions;
  const calledSuggest = generation.steps.some((step) => step.toolCalls.some((call) => call.toolName === "suggest_replies"));
  const formOrQuestion = stage?.kind === "question" || stage?.kind === "order_lookup";
  if (!calledSuggest && !formOrQuestion && content) {
    const salvaged = salvageChips(content);
    if (salvaged) {
      content = salvaged.text;
      suggestions = salvaged.chips;
    }
  }
  if (formOrQuestion) suggestions = [];
  if (!content) content = fallbackLine(stage);
  if (prefix) content = `${prefix}\n\n${content}`;

  // 15. One log write per turn (fail-soft).
  const shownProductIds = stage?.kind === "products" ? stage.products.map((card) => card.id) : [];
  const signals = readTurnSignals(generation, collector, hadText, usedImage, budget, {
    cards: shownProductIds.length,
    question: stage?.kind === "question",
    orderLookup: stage?.kind === "order_lookup",
  });
  await logAssistantTurn(supabase, {
    sessionId,
    userContent,
    assistantContent: content,
    outcome: signals.outcome,
    shownProductIds,
    addedProductIds: collector.actions.map((action) => action.product.id),
    tappedProductIds: tappedIds,
    questionId: stage?.kind === "question" ? stage.question.id : null,
    toolsUsed: signals.toolsUsed,
    searchTerms: signals.searchTerms,
    page,
    model: usedImage ? MODEL_IDS.vision : MODEL_IDS.text,
    latencyMs: Date.now() - started,
    inputTokens: generation.usage.inputTokens ?? null,
    outputTokens: generation.usage.outputTokens ?? null,
    cacheReadTokens: generation.usage.inputTokenDetails?.cacheReadTokens ?? null,
    hasImage: photoAttached,
    photoReading: collector.photoReading,
    clientKey: clientKeyHash,
  });

  // 16. Respond.
  return reply({
    ok: true,
    content,
    stage,
    ...(suggestions.length > 0 ? { suggestions } : {}),
    ...(collector.actions.length > 0 ? { actions: collector.actions } : {}),
    ...(collector.offerCode ? { offerCode: collector.offerCode } : {}),
    ...(collector.photoReading ? { photoReading: collector.photoReading } : {}),
  });
}
