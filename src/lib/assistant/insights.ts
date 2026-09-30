import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingFunction } from "@/lib/rpc-errors";
import type { AssistantCollector } from "./tools";
import type { AssistantOutcome } from "./types";

/**
 * Turning conversations into data (blueprint §10.13).
 *
 * `readTurnSignals()` classifies every turn WITHOUT asking the model to grade itself; rungs run
 * most specific first (the table order in §10.13). `logAssistantTurn()` is ONE RPC per turn
 * (user row + reply together — two racing inserts contended on the session row) and is fail-soft
 * twice over: log_assistant_turn swallows its own errors in SQL, and anything that reaches the
 * app (a missing migration, a transport error) is logged here and swallowed — a shopper never
 * loses an answer to logging (§13). A clean return proves nothing: verify with the OPS NOTE query
 * in 19_assistant_core.sql.
 */

type StepLike = { finishReason: string; toolCalls: readonly { toolName: string }[] };
/** The parts of a generateText result the classifier reads. */
export type GenerationLike = { finishReason: string; steps: readonly StepLike[] };

export type TurnSignals = {
  outcome: AssistantOutcome;
  /** Tool names in call order (SQL keeps ≤ 12 × 40). */
  toolsUsed: string[];
  /** search_products terms in call order (SQL keeps ≤ 8 × 80, redacted). */
  searchTerms: string[];
};

/** What the shopper ended up seeing on the stage. */
export type StagedResult = { cards: number; question: boolean; orderLookup: boolean };

/** A turn that only suggested replies "answered from nothing". */
const NOT_A_LOOKUP = new Set(["suggest_replies"]);

export function readTurnSignals(
  generation: GenerationLike,
  collector: AssistantCollector,
  hadText: boolean,
  hasImage: boolean,
  stepBudget: number,
  staged: StagedResult,
): TurnSignals {
  const toolsUsed = generation.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName));
  const searchTerms = collector.searches.map((s) => s.term);
  const searchedEmpty = collector.searches.some((s) => s.matches === 0);
  const photoUnmatched = collector.photoMatches === 0; // record_photo_reading's verdict was "none"
  const anyStage = staged.cards > 0 || staged.question || staged.orderLookup;

  let outcome: AssistantOutcome;
  if (generation.finishReason === "length" || (generation.steps.length >= stepBudget && generation.finishReason === "tool-calls")) {
    outcome = "truncated"; // out of tokens, or stopped on the step budget still wanting a tool
  } else if (collector.showProductsCalls > 0 && !anyStage) {
    outcome = "bad_ids"; // show_products called, nothing staged: hallucinated ids
  } else if (hasImage && collector.photoReading !== null && (photoUnmatched || searchedEmpty) && staged.cards === 0) {
    outcome = "no_image_match"; // a product people own that we don't carry
  } else if (searchedEmpty && staged.cards === 0) {
    outcome = "no_match"; // catalogue gap: stock this
  } else if (toolsUsed.every((name) => NOT_A_LOOKUP.has(name))) {
    outcome = "no_tools"; // answered from nothing
  } else if (!hadText && !anyStage) {
    outcome = "dead_end";
  } else {
    outcome = "answered";
  }
  return { outcome, toolsUsed, searchTerms };
}

/** Signals for a turn whose model call threw (outcome `failed`): the tools that did run. */
export function failedTurnSignals(collector: AssistantCollector): TurnSignals {
  return { outcome: "failed", toolsUsed: [...collector.toolLog], searchTerms: collector.searches.map((s) => s.term) };
}

export type AssistantTurnLog = {
  sessionId: string;
  userContent: string;
  assistantContent: string;
  outcome: AssistantOutcome | null;
  shownProductIds: number[];
  addedProductIds: number[];
  tappedProductIds: number[];
  questionId: string | null;
  toolsUsed: string[];
  searchTerms: string[];
  page: string | null;
  model: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  hasImage: boolean;
  photoReading: string | null;
  /** hashKey(clientKey(request)) — lower-case hex; anything else is stored as NULL by SQL. */
  clientKey: string | null;
};

const MIGRATION = "19_assistant_core.sql";
let warnedMissing = false;

const nullIfEmpty = <T>(values: T[]): T[] | null => (values.length > 0 ? values : null);
const tokens = (value: number | null) => (value === null || !Number.isFinite(value) ? null : Math.max(0, Math.round(value)));

/** ONE call per turn, with NAMED arguments (log_assistant_turn has 19 parameters). Never throws. */
export async function logAssistantTurn(supabase: SupabaseClient, turn: AssistantTurnLog): Promise<void> {
  try {
    const { error } = await supabase.rpc("log_assistant_turn", {
      p_session_id: turn.sessionId,
      p_user_content: turn.userContent,
      p_assistant_content: turn.assistantContent,
      p_outcome: turn.outcome,
      p_shown_product_ids: nullIfEmpty(turn.shownProductIds),
      p_added_product_ids: nullIfEmpty(turn.addedProductIds),
      p_tapped_product_ids: nullIfEmpty(turn.tappedProductIds),
      p_question_id: turn.questionId,
      p_tools_used: nullIfEmpty(turn.toolsUsed),
      p_search_terms: nullIfEmpty(turn.searchTerms),
      p_page: turn.page,
      p_model: turn.model,
      p_latency_ms: turn.latencyMs === null ? null : Math.max(0, Math.round(turn.latencyMs)),
      p_input_tokens: tokens(turn.inputTokens),
      p_output_tokens: tokens(turn.outputTokens),
      p_has_image: turn.hasImage,
      p_photo_reading: turn.photoReading,
      p_client_key: turn.clientKey,
      p_cache_read_tokens: tokens(turn.cacheReadTokens),
    });
    if (error) {
      if (isMissingFunction(error)) {
        if (!warnedMissing) console.error(`[assistant] log_assistant_turn is missing — apply migration ${MIGRATION}`);
        warnedMissing = true;
      } else {
        console.error(`[assistant] log_assistant_turn failed: ${error.code || "error"} ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`[assistant] log_assistant_turn failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
