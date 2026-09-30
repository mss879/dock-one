import "server-only";
import { openai } from "@ai-sdk/openai";
import { serverEnv } from "@/lib/env.server";

/**
 * THE one place the assistant's model is named (blueprint §10.4, BUILD_SPEC §1 LLM row):
 * Vercel AI SDK `ai` 7 + `@ai-sdk/openai` 4, a fast tier model with low reasoning effort (a
 * multi-step turn — search → stock → stage → chips — must land in a few seconds). Swapping the
 * provider or the tier is a two-line change here.
 *
 * Env (read once by lib/env.server.ts, trimmed): OPENAI_API_KEY (unset → the route answers the
 * friendly "away" reply), ASSISTANT_MODEL / ASSISTANT_VISION_MODEL (overrides), ASSISTANT_VISION
 * (`off` disables photo input).
 */

const MODEL_ID = serverEnv.assistantModel || "gpt-5.4-mini";
const VISION_MODEL_ID = serverEnv.assistantVisionModel || MODEL_ID;

export const isModelConfigured = Boolean(serverEnv.openaiApiKey);
export const isVisionEnabled = isModelConfigured && serverEnv.assistantVisionEnabled;

export const getModel = () => openai(MODEL_ID);
export const getVisionModel = () => openai(VISION_MODEL_ID);

/** No `temperature`: GPT-5-family models reject non-default values (blueprint §3.2). */
export const PROVIDER_OPTIONS = { openai: { reasoningEffort: "low" as const } };

/** Recorded on every logged turn (assistant_messages.model). */
export const MODEL_IDS = { text: MODEL_ID, vision: VISION_MODEL_ID };
