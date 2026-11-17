import "server-only";
import { createHash } from "node:crypto";
import { generateText, isStepCount, type ModelMessage } from "ai";
import { createServerSupabase } from "@/lib/supabase/server";
import { productHref } from "@/lib/catalogue-shared";
import { absoluteUrl } from "@/lib/env";
import { formatLKR } from "@/lib/format";
import { bucket, checkRateLimit } from "@/lib/rate-limit";
import { cleanText } from "@/lib/request-guard";
import { getStoreSettings } from "@/lib/settings";
import { getAssistantCatalogue, type SnapshotProduct } from "./catalogue";
import { getModel, isModelConfigured, PROVIDER_OPTIONS } from "./model";
import { buildSystemPrompt } from "./prompt";
import { buildTools, createCollector, STEP_BUDGET } from "./tools";
import { ASSISTANT_LIMITS } from "./types";

/**
 * The store's AI assistant answering on WhatsApp (54_whatsapp) — the same desk as the website's
 * chat: the same catalogue snapshot, store facts, knowledge and tools, plus a WHATSAPP section in
 * the prompt. WhatsApp has no display, so what the display tools chose is written out after the
 * reply: products as name, price and link; a question's options as lines; the tracking link for
 * order questions. suggest_replies and add_to_cart are left out (no chips, no basket there).
 *
 * Returns the text to send, or null when there is nothing to send (no model, a failure, too many
 * turns from one number) — the message then simply waits in admin → WhatsApp for a person.
 */

export type WhatsappHistoryTurn = { direction: "in" | "out"; body: string };

const TURN_BUDGET_MS = 20_000;
const MAX_OUTPUT_TOKENS = 600;
const MAX_REPLY_CHARS = 3500;

/** A stable, UUID-shaped session per WhatsApp number (offers are earned per session). */
function sessionFor(waId: string): string {
  const h = createHash("sha256").update(`whatsapp:${waId}`).digest("hex");
  const variant = (8 + (Number.parseInt(h[16], 16) % 4)).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const label = (p: SnapshotProduct) => (!p.brand || p.name.toLowerCase().startsWith(p.brand.toLowerCase()) ? p.name : `${p.brand} ${p.name}`);

/** Plain text for WhatsApp: private notes and markdown residue removed, clamped. */
function tidy(text: string): string {
  return text
    .replace(/\[(?:You|The customer)\b[^\]\n]{0,600}\]/g, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/__([^_\n]+)__/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_REPLY_CHARS)
    .trim();
}

function toMessages(history: readonly WhatsappHistoryTurn[], text: string): ModelMessage[] {
  const turns: ModelMessage[] = [];
  for (const turn of history.slice(-(ASSISTANT_LIMITS.historySent - 1))) {
    const body = cleanText(turn.body, turn.direction === "in" ? ASSISTANT_LIMITS.userChars : ASSISTANT_LIMITS.assistantChars);
    if (!body) continue;
    turns.push(turn.direction === "in" ? { role: "user", content: body } : { role: "assistant", content: body });
  }
  turns.push({ role: "user", content: cleanText(text, ASSISTANT_LIMITS.userChars) });
  return turns;
}

export async function whatsappAssistantReply(input: { waId: string; name: string | null; text: string; history: readonly WhatsappHistoryTurn[] }): Promise<string | null> {
  const started = Date.now();
  if (!isModelConfigured || !cleanText(input.text, ASSISTANT_LIMITS.userChars)) return null;
  const supabase = createServerSupabase();
  // One number can't run up the model bill: 30 answers an hour per number.
  if (!(await checkRateLimit(supabase, bucket("assistant_whatsapp", "number", input.waId), 30, 3600))) return null;

  const [snapshot, settings] = await Promise.all([getAssistantCatalogue().catch(() => null), getStoreSettings()]);
  if (!snapshot) return null;
  const collector = createCollector();
  const sessionId = sessionFor(input.waId);
  const all = buildTools({
    snapshot,
    collector,
    sessionId,
    supabase,
    cartSubtotal: null,
    deliveryRule: { deliveryFee: settings.deliveryFee, freeDeliveryThreshold: settings.freeDeliveryThreshold },
    hasImage: false,
    allowOfferCall: () => checkRateLimit(supabase, bucket("assistant_offers", "whatsapp", input.waId), 12, 600),
  });
  const tools = Object.fromEntries(Object.entries(all).filter(([name]) => name !== "suggest_replies" && name !== "add_to_cart")) as Omit<typeof all, "suggest_replies" | "add_to_cart">;

  let reply: string;
  try {
    const generation = await generateText({
      model: getModel(),
      providerOptions: PROVIDER_OPTIONS,
      instructions: buildSystemPrompt({
        snapshot,
        settings,
        customer: null,
        photoTurn: false,
        channel: "whatsapp",
        contextLines: [`Channel: WhatsApp${input.name ? ` — their WhatsApp name is ${cleanText(input.name, 60).replace(/[[\]{}<>]/g, "")}` : ""}.`],
      }),
      messages: toMessages(input.history, input.text),
      tools,
      stopWhen: isStepCount(STEP_BUDGET.text),
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(Math.max(1000, TURN_BUDGET_MS - (Date.now() - started))),
    });
    const parts: string[] = [];
    for (const step of generation.steps) {
      const text = tidy(step.text ?? "");
      if (text && !parts.includes(text)) parts.push(text);
    }
    reply = tidy(parts.join("\n\n"));
  } catch (error) {
    console.error(`[whatsapp-assistant] generation failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    return null;
  }

  // What the display tools chose, written out for WhatsApp.
  const extra: string[] = [];
  if (collector.stagedOrderLookup) {
    extra.push(`Track your order here: ${absoluteUrl("/track")}`);
  } else if (collector.stagedQuestion) {
    extra.push(collector.stagedQuestion.options.map((o) => `• ${o.label}`).join("\n"));
  } else if (collector.stagedIds.length > 0) {
    for (const id of collector.stagedIds) {
      const p = snapshot.byId.get(id);
      if (!p) continue;
      extra.push(`${label(p)} — ${p.variants.length > 1 ? "from " : ""}${formatLKR(p.price)}\n${absoluteUrl(productHref(p.id))}`);
    }
  }
  const text = [reply, ...extra].filter(Boolean).join("\n\n").slice(0, 4096).trim();
  return text || null;
}
