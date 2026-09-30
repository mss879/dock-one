"use client";

import { useSyncExternalStore } from "react";
import { track } from "@/lib/analytics";
import { cart } from "@/lib/cart";
import { stashOfferCode, takeOfferCode } from "@/lib/offer-code";
import { toast } from "@/lib/toast";
import { getViewedProductIds } from "@/lib/viewed";
import {
  ASSISTANT_LIMITS,
  MEMORY_NOTE,
  type AssistantAction,
  type AssistantCard,
  type AssistantChatMessage,
  type AssistantOrderView,
  type AssistantRequest,
  type AssistantResponse,
  type AssistantStage,
  type AssistantStockBand,
  type StageQuestion,
} from "@/lib/assistant/types";

/**
 * The assistant's conversation state (blueprint §10.14):
 * - localStorage "dockone.assistant.v1" = { sessionId, messages (≤ 30), stage, savedAt } with a
 *   24 h TTL, so the agent follows the shopper across pages (and tabs);
 * - it SENDS the last 12 messages; private memory notes ([You showed …], [You asked …], the
 *   order-form note, photo notes) are appended to turns in that history and NEVER shown;
 * - actions come only from the response envelope (never parsed from prose): cart.add → cart.open;
 * - an offer code is parked with stashOfferCode() — checkout still asks the shopper to press Apply;
 * - sign-out (the `dockone:signed-out` event, handled by AssistantWidget) clears everything and
 *   rotates the session id: `resetConversation()`.
 *
 * Storage is read lazily in the browser only (never during the server render); a blocked or full
 * storage keeps the conversation in memory for this page view.
 */

export const ASSISTANT_STORAGE_KEY = "dockone.assistant.v1";
const TTL_MS = 24 * 60 * 60 * 1000;

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** Private memory notes, appended when this turn is replayed to the server. Never rendered. */
  notes?: string[];
  /** Assistant turns: quick-reply chips offered with this turn. */
  suggestions?: string[];
  /** User turns: a photograph rode on this message (the image itself is never stored). */
  hasPhoto?: boolean;
  /** Assistant turns: the code parked for checkout by this turn. */
  offerCode?: string;
  /** A friendly failure line — shown, never replayed to the model. */
  error?: boolean;
  /** A local line (greeting, nudge opener) — shown and replayed, but it cost no model call. */
  local?: boolean;
};

export type Conversation = {
  sessionId: string;
  messages: ChatMessage[];
  stage: AssistantStage | null;
  savedAt: number;
};

const EMPTY: Conversation = { sessionId: "", messages: [], stage: null, savedAt: 0 };

// ── ids ───────────────────────────────────────────────────────────────────────

/** RFC 4122 v4 — crypto.randomUUID where available (secure contexts), getRandomValues otherwise. */
export function newSessionId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let messageSeq = 0;
const messageId = () => `m${Date.now().toString(36)}${(messageSeq++).toString(36)}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Sanitising what comes back from storage (it's this browser's own data, but it can be stale or corrupt) ──

const str = (value: unknown, max: number): string | null => (typeof value === "string" && value.trim() ? value.slice(0, max) : null);
const strings = (value: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(value) ? value.map((v) => str(v, maxLen)).filter((v): v is string => v !== null).slice(0, maxItems) : [];
const posInt = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

function sanitizeCard(raw: unknown): AssistantCard | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const id = posInt(c.id);
  const price = num(c.price);
  const slug = str(c.slug, 120);
  const name = str(c.name, 200);
  if (id === null || price === null || !slug || !name) return null;
  const compareAt = num(c.compareAtPrice);
  return {
    id,
    slug,
    brand: str(c.brand, 120) ?? "",
    name,
    subtitle: str(c.subtitle, 240) ?? "",
    categoryId: str(c.categoryId, 120) ?? "",
    price,
    compareAtPrice: compareAt !== null && compareAt > price ? compareAt : null,
    image: str(c.image, 1000),
    variants: strings(c.variants, 20, 120),
    highlights: strings(c.highlights, 3, 160),
    // Stock is "checked this turn" only: a stored band would be stale urgency (P15).
    stock: null,
    defaultVariantId: posInt(c.defaultVariantId),
    defaultVariantName: str(c.defaultVariantName, 120),
    href: `/product/${id}`,
  };
}

function sanitizeQuestion(raw: unknown): StageQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const q = raw as Record<string, unknown>;
  const prompt = str(q.prompt, 160);
  const options = (Array.isArray(q.options) ? q.options : [])
    .map((o) => {
      if (!o || typeof o !== "object") return null;
      const option = o as Record<string, unknown>;
      const label = str(option.label, 48);
      if (!label) return null;
      const hint = str(option.hint, 80);
      return { value: str(option.value, 48) ?? label, label, ...(hint ? { hint } : {}) };
    })
    .filter((o): o is NonNullable<typeof o> => o !== null)
    .slice(0, 6);
  if (!prompt || options.length < 2) return null;
  return { id: str(q.id, 32) ?? "question", prompt, options };
}

/** Live stock bands from THIS turn's response (never from storage): in / low (+ left) / out. */
function sanitizeBands(raw: unknown): AssistantStockBand[] | null {
  if (!Array.isArray(raw)) return null;
  const bands: AssistantStockBand[] = [];
  for (const item of raw.slice(0, 20)) {
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    const variant = str(b.variant, 120);
    if (!variant || (b.state !== "in" && b.state !== "low" && b.state !== "out")) continue;
    const left = posInt(b.left);
    bands.push(b.state === "low" && left !== null ? { variant, state: "low", left } : { variant, state: b.state });
  }
  return bands;
}

export function sanitizeStage(raw: unknown, keepStock = false): AssistantStage | null {
  if (!raw || typeof raw !== "object") return null;
  const stage = raw as Record<string, unknown>;
  if (stage.kind === "products" && Array.isArray(stage.products)) {
    const products = stage.products
      .slice(0, ASSISTANT_LIMITS.cards)
      .map((card, index) => {
        const clean = sanitizeCard(card);
        if (clean && keepStock) clean.stock = sanitizeBands((stage.products as Record<string, unknown>[])[index]?.stock);
        return clean;
      })
      .filter((c): c is AssistantCard => c !== null);
    return products.length > 0 ? { kind: "products", products } : null;
  }
  if (stage.kind === "question") {
    const question = sanitizeQuestion(stage.question);
    return question ? { kind: "question", question } : null;
  }
  if (stage.kind === "order_lookup") {
    const prefill = str(stage.prefillOrderRef, 40);
    return prefill ? { kind: "order_lookup", prefillOrderRef: prefill } : { kind: "order_lookup" };
  }
  return null;
}

function sanitizeMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const role = m.role === "user" || m.role === "assistant" ? m.role : null;
  const content = str(m.content, 5000);
  if (!role || !content) return null;
  const notes = strings(m.notes, 6, 1200);
  const suggestions = strings(m.suggestions, ASSISTANT_LIMITS.suggestions, 80);
  return {
    id: str(m.id, 40) ?? messageId(),
    role,
    content,
    ...(notes.length > 0 ? { notes } : {}),
    ...(suggestions.length > 0 ? { suggestions } : {}),
    ...(m.hasPhoto === true ? { hasPhoto: true } : {}),
    ...(typeof m.offerCode === "string" ? { offerCode: m.offerCode.slice(0, 32) } : {}),
    ...(m.error === true ? { error: true } : {}),
    ...(m.local === true ? { local: true } : {}),
  };
}

function sanitizeConversation(raw: unknown): Conversation {
  if (!raw || typeof raw !== "object") return EMPTY;
  const c = raw as Record<string, unknown>;
  const savedAt = typeof c.savedAt === "number" ? c.savedAt : 0;
  const sessionId = typeof c.sessionId === "string" && UUID.test(c.sessionId) ? c.sessionId.toLowerCase() : "";
  if (!sessionId || Date.now() - savedAt > TTL_MS || savedAt > Date.now() + 60_000) return EMPTY; // 24 h TTL
  const messages = (Array.isArray(c.messages) ? c.messages : [])
    .map(sanitizeMessage)
    .filter((m): m is ChatMessage => m !== null)
    .slice(-ASSISTANT_LIMITS.historyStored);
  return { sessionId, messages, stage: sanitizeStage(c.stage), savedAt };
}

// ── The store (one per tab; storage events keep tabs in step) ─────────────────

let state: Conversation = EMPTY;
let loaded = false;
let busy = false;
let pendingTaps: number[] = [];
let retryImage: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(ASSISTANT_STORAGE_KEY);
    if (raw) state = sanitizeConversation(JSON.parse(raw));
  } catch {
    state = EMPTY;
  }
}

function persist(next: Conversation) {
  try {
    if (next.messages.length === 0 && next.stage === null) window.localStorage.removeItem(ASSISTANT_STORAGE_KEY);
    else window.localStorage.setItem(ASSISTANT_STORAGE_KEY, JSON.stringify({ ...next, stage: sanitizeStage(next.stage) }));
  } catch {
    // storage blocked or full: the conversation lives in memory for this page view
  }
}

function setState(update: (prev: Conversation) => Conversation, save = true) {
  load();
  const next = update(state);
  state = { ...next, messages: next.messages.slice(-ASSISTANT_LIMITS.historyStored), savedAt: Date.now() };
  if (save) persist(state);
  emit();
}

function onStorage(event: StorageEvent) {
  if (event.key !== ASSISTANT_STORAGE_KEY) return;
  try {
    state = event.newValue ? sanitizeConversation(JSON.parse(event.newValue)) : EMPTY;
  } catch {
    state = EMPTY;
  }
  emit();
}

function subscribe(listener: () => void) {
  load();
  if (listeners.size === 0 && typeof window !== "undefined") window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

type Snapshot = { conversation: Conversation; busy: boolean };
let snapshot: Snapshot = { conversation: state, busy };
function getSnapshot(): Snapshot {
  load();
  if (snapshot.conversation !== state || snapshot.busy !== busy) snapshot = { conversation: state, busy };
  return snapshot;
}
const SERVER_SNAPSHOT: Snapshot = { conversation: EMPTY, busy: false };
const getServerSnapshot = () => SERVER_SNAPSHOT;

function setBusy(next: boolean) {
  busy = next;
  emit();
}

/**
 * Sign-out (and nothing else) wipes the conversation: transcript, stage, taps, the parked offer
 * code, and a NEW session id — the next person on a shared device inherits nothing.
 */
export function resetConversation(): void {
  load();
  pendingTaps = [];
  retryImage = null;
  state = { ...EMPTY, sessionId: newSessionId(), savedAt: Date.now() };
  try {
    window.localStorage.removeItem(ASSISTANT_STORAGE_KEY);
  } catch {
    // nothing stored, or storage blocked
  }
  try {
    takeOfferCode(); // read-and-clear
  } catch {
    // storage blocked
  }
  emit();
}

/** True when there is a conversation to come back to (for the launcher). */
export function hasConversation(): boolean {
  load();
  return state.messages.some((m) => !m.local);
}

// ── Building the request ──────────────────────────────────────────────────────

function withNotes(message: ChatMessage, isLatest: boolean): AssistantChatMessage {
  const notes = [...(message.notes ?? [])];
  if (message.role === "user" && message.hasPhoto && !isLatest) notes.push(MEMORY_NOTE.photo);
  const max = message.role === "user" ? ASSISTANT_LIMITS.userChars : ASSISTANT_LIMITS.assistantChars;
  if (notes.length === 0) return { role: message.role, content: message.content.slice(0, max) };
  const noteText = notes.join("\n");
  const room = Math.max(0, max - noteText.length - 2);
  return { role: message.role, content: `${message.content.slice(0, room)}\n\n${noteText}`.slice(0, max) };
}

/** The last 12 replayable turns (failures are never replayed), with their private notes. */
export function historyFor(messages: readonly ChatMessage[]): AssistantChatMessage[] {
  const recent = messages.filter((m) => !m.error && m.content.trim()).slice(-ASSISTANT_LIMITS.historySent);
  return recent.map((m, i) => withNotes(m, i === recent.length - 1));
}

const productLabel = (p: { brand: string; name: string }) => (!p.brand || p.name.toLowerCase().startsWith(p.brand.toLowerCase()) ? p.name : `${p.brand} ${p.name}`);

function stageNotes(stage: AssistantStage): string[] {
  if (stage.kind === "products") return [MEMORY_NOTE.showed(stage.products.map((p) => `#${p.id} ${productLabel(p)}`))];
  if (stage.kind === "question") return [MEMORY_NOTE.asked(stage.question.options.map((o) => o.label))];
  return [MEMORY_NOTE.orderForm];
}

function cartSubtotal(): number {
  return cart.getLines().reduce((sum, line) => sum + line.price * line.qty, 0);
}

function executeActions(actions: readonly AssistantAction[]) {
  let added = 0;
  for (const action of actions.slice(0, ASSISTANT_LIMITS.actions)) {
    const ok = cart.add(
      {
        productId: action.product.id,
        variantId: action.variantId,
        slug: action.product.slug,
        name: action.product.name,
        brand: action.product.brand,
        variantName: action.variant,
        price: action.product.price,
        compareAtPrice: action.product.compareAtPrice,
        imageUrl: action.product.image,
        categoryId: action.product.categoryId,
      },
      action.quantity,
    );
    if (ok) added += 1;
  }
  if (added > 0) cart.open();
  else toast({ title: "Basket is full", description: "Remove something to add more lines.", action: { label: "View", onClick: cart.open } });
}

const OFFLINE = "I can't reach the tech desk right now. Check your connection and try again.";
const FALLBACK_ERROR = "Sorry, I couldn't answer that just now. Please try again in a moment.";

async function request(image: string | null, honeypot: string): Promise<void> {
  const conversation = state;
  const body: AssistantRequest = {
    sessionId: conversation.sessionId,
    messages: historyFor(conversation.messages),
    page: typeof window !== "undefined" ? window.location.pathname.slice(0, ASSISTANT_LIMITS.pageChars) : undefined,
    viewedProductIds: getViewedProductIds().slice(0, ASSISTANT_LIMITS.ids),
    tappedProductIds: pendingTaps.slice(0, ASSISTANT_LIMITS.ids),
    cartSubtotal: cartSubtotal(),
    ...(image ? { image: { mediaType: "image/jpeg", data: image } } : {}),
    company: honeypot,
  };
  if (body.messages.length === 0 || body.messages[body.messages.length - 1].role !== "user") return;
  const sentSession = conversation.sessionId;
  const taps = pendingTaps;
  pendingTaps = [];
  setBusy(true);
  let data: AssistantResponse | null = null;
  let offline = false;
  try {
    const res = await fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      data = (await res.json()) as AssistantResponse;
    } catch {
      data = null;
    }
    if (!res.ok && data) data = { ...data, ok: false };
  } catch {
    offline = true;
  } finally {
    setBusy(false);
  }

  // Signed out (or the conversation was reset) while this turn was in flight: drop the answer.
  if (state.sessionId !== sentSession) return;
  if (!data || !data.ok) {
    pendingTaps = [...taps, ...pendingTaps].slice(0, ASSISTANT_LIMITS.ids); // not sent: keep them for the next turn
    retryImage = image;
    const text = offline ? OFFLINE : typeof data?.error === "string" && data.error ? data.error : FALLBACK_ERROR;
    setState((prev) => ({ ...prev, messages: [...prev.messages, { id: messageId(), role: "assistant", content: text, error: true }] }));
    return;
  }
  retryImage = null;
  const content = typeof data.content === "string" ? data.content.trim() : "";
  const stage = data.stage ? sanitizeStage(data.stage, true) : null;
  const notes = [...(stage ? stageNotes(stage) : [])];
  if (typeof data.photoReading === "string" && data.photoReading) notes.push(MEMORY_NOTE.reading(data.photoReading.slice(0, 200)));
  const offerCode = typeof data.offerCode === "string" && data.offerCode ? data.offerCode : null;
  if (offerCode) stashOfferCode(offerCode);
  const suggestions = strings(data.suggestions, ASSISTANT_LIMITS.suggestions, ASSISTANT_LIMITS.suggestionChars);
  if (content || stage) {
    setState((prev) => ({
      ...prev,
      stage: stage ?? prev.stage,
      messages: [
        ...prev.messages,
        {
          id: messageId(),
          role: "assistant",
          content: content || " ",
          ...(notes.length > 0 ? { notes } : {}),
          ...(suggestions.length > 0 ? { suggestions } : {}),
          ...(offerCode ? { offerCode } : {}),
        },
      ],
    }));
  }
  if (Array.isArray(data.actions) && data.actions.length > 0) executeActions(data.actions);
}

// ── Actions (plain functions: the widget uses them before the panel's code has loaded) ──

/**
 * Send a message (and optionally a prepared JPEG, base64). Returns the new message's id, or null
 * when nothing was sent (a turn is already in flight, or there is nothing to send).
 */
export function sendMessage(text: string, options: { image?: string | null; honeypot?: string } = {}): string | null {
  if (busy) return null;
  const image = options.image ?? null;
  const content = text.trim().slice(0, ASSISTANT_LIMITS.userChars) || (image ? "Here is a photo." : "");
  if (!content) return null;
  const id = messageId();
  setState((prev) => ({
    sessionId: prev.sessionId || newSessionId(),
    // A question on the stage is answered by this message.
    stage: prev.stage?.kind === "question" ? null : prev.stage,
    savedAt: prev.savedAt,
    messages: [...prev.messages, { id, role: "user", content, ...(image ? { hasPhoto: true } : {}) }],
  }));
  void request(image, options.honeypot ?? "");
  return id;
}

/** Re-send after a failure line (with the failed turn's photo, if it had one). */
export function retryLastMessage(honeypot = ""): void {
  if (busy) return;
  const last = state.messages[state.messages.length - 1];
  if (!last?.error) return;
  setState((prev) => ({ ...prev, messages: prev.messages.slice(0, -1) }));
  void request(retryImage, honeypot);
}

/** A local assistant line (greeting, nudge opener) with chips — no model call. */
export function addLocalMessage(text: string, chips: readonly string[]): void {
  setState((prev) => ({
    ...prev,
    sessionId: prev.sessionId || newSessionId(),
    messages: [...prev.messages, { id: messageId(), role: "assistant", content: text, local: true, ...(chips.length > 0 ? { suggestions: chips.slice(0, 4) } : {}) }],
  }));
}

/** An ADD tap on a staged card: sent with the next turn (analytics only). */
export function recordStageTap(productId: number): void {
  if (!Number.isInteger(productId) || productId <= 0) return;
  pendingTaps = [...pendingTaps.filter((id) => id !== productId), productId].slice(-ASSISTANT_LIMITS.ids);
}

/** The private order form found an order: remember its ITEMS (never the number or the email). */
export function rememberOrderLookup(order: AssistantOrderView): void {
  const items = order.items
    .slice(0, 12)
    .map((item) => `${item.quantity} × ${item.name}${item.variant && item.variant !== "Standard" ? ` (${item.variant})` : ""}`.replace(/[[\]]/g, " "));
  if (items.length === 0) return;
  const note = MEMORY_NOTE.orderItems(items);
  setState((prev) => {
    const messages = [...prev.messages];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === "assistant" && !messages[i].error) {
        const notes = (messages[i].notes ?? []).filter((n) => !n.startsWith("[The customer looked up"));
        messages[i] = { ...messages[i], notes: [...notes, note] };
        break;
      }
    }
    return { ...prev, messages };
  });
}

/** Fired when the shopper opens the panel (launcher or an accepted nudge). */
export function trackAssistantOpen(): void {
  track("assistant_open");
}

// ── The hook ──────────────────────────────────────────────────────────────────

/** The conversation and whether a turn is in flight (SSR/hydration: empty and idle). */
export function useAssistantChat(): { conversation: Conversation; busy: boolean } {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
