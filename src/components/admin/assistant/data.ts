/**
 * Assistant insights — the admin tab's data shapes (blueprint §11.4, SQL 19_assistant_core.sql:
 * admin_assistant_overview / admin_assistant_sessions / admin_assistant_transcript). Every figure
 * comes from those RPCs (admin re-checked inside SQL, 42501 otherwise); these normalisers only
 * coerce types (DECIMAL/bigint may arrive as strings) and never invent a value.
 * Plain module: imported by the tab (client) only.
 */

import { ASSISTANT_OUTCOMES, isAssistantOutcome, type AssistantOutcome } from "@/lib/assistant/types";

export const ASSISTANT_MIGRATION = "19_assistant_core.sql";
export const WINDOWS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOWS)[number];
export const SESSIONS_PAGE_SIZE = 25;

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const rowsOf = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRow) : []);
const count = (value: unknown): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const nullableNumber = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

export type Totals = {
  sessions: number;
  turns: number;
  adds: number;
  photos: number;
  struggles: number;
  medianLatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

export type TermCount = { term: string; turns: number };
export type DemandRow = { productId: number; brand: string; name: string; shown: number; taken: number };
export type Overview = {
  days: number;
  since: string | null;
  timezone: string;
  totals: Totals;
  outcomes: Record<AssistantOutcome, number>;
  /** Index = local hour 0–23 (the SQL's business time zone). */
  hours: number[];
  terms: TermCount[];
  zeroResultTerms: TermCount[];
  demand: DemandRow[];
  photoDemand: { reading: string; turns: number }[];
  tools: { tool: string; calls: number }[];
};

export function normalizeOverview(raw: unknown): Overview {
  const row = isRow(raw) ? raw : {};
  const totals = isRow(row.totals) ? row.totals : {};
  const outcomesRow = isRow(row.outcomes) ? row.outcomes : {};
  const hoursRow = isRow(row.hours) ? row.hours : {};
  const outcomes = Object.fromEntries(ASSISTANT_OUTCOMES.map((o) => [o, count(outcomesRow[o])])) as Record<AssistantOutcome, number>;
  const terms = (value: unknown): TermCount[] => rowsOf(value).map((r) => ({ term: text(r.term) ?? "", turns: count(r.turns) })).filter((r) => r.term);
  return {
    days: count(row.days),
    since: text(row.since),
    timezone: text(row.timezone) ?? "Asia/Colombo",
    totals: {
      sessions: count(totals.sessions),
      turns: count(totals.turns),
      adds: count(totals.adds),
      photos: count(totals.photos),
      struggles: count(totals.struggles),
      medianLatencyMs: nullableNumber(totals.median_latency_ms),
      inputTokens: count(totals.input_tokens),
      outputTokens: count(totals.output_tokens),
      cacheReadTokens: count(totals.cache_read_tokens),
    },
    outcomes,
    hours: Array.from({ length: 24 }, (_, h) => count(hoursRow[String(h)])),
    terms: terms(row.terms),
    zeroResultTerms: terms(row.zero_result_terms),
    demand: rowsOf(row.demand)
      .map((r) => ({ productId: count(r.product_id), brand: text(r.brand) ?? "", name: text(r.name) ?? "", shown: count(r.shown), taken: count(r.taken) }))
      .filter((r) => r.productId > 0 && r.name),
    photoDemand: rowsOf(row.photo_demand)
      .map((r) => ({ reading: text(r.reading) ?? "", turns: count(r.turns) }))
      .filter((r) => r.reading),
    tools: rowsOf(row.tools)
      .map((r) => ({ tool: text(r.tool) ?? "", calls: count(r.calls) }))
      .filter((r) => r.tool),
  };
}

export type SessionRow = {
  sessionId: string;
  customerId: string | null;
  messageCount: number;
  turns: number;
  struggles: number;
  photos: number;
  adds: number;
  firstMessage: string | null;
  lastOutcome: AssistantOutcome | null;
  createdAt: string | null;
  lastSeenAt: string | null;
};

export type SessionsPage = { total: number; items: SessionRow[] };

export function normalizeSessions(raw: unknown): SessionsPage {
  const row = isRow(raw) ? raw : {};
  return {
    total: count(row.total),
    items: rowsOf(row.items)
      .map((r) => ({
        sessionId: text(r.session_id) ?? "",
        customerId: text(r.customer_id),
        messageCount: count(r.message_count),
        turns: count(r.turns),
        struggles: count(r.struggles),
        photos: count(r.photos),
        adds: count(r.adds),
        firstMessage: text(r.first_message),
        lastOutcome: isAssistantOutcome(r.last_outcome) ? r.last_outcome : null,
        createdAt: text(r.created_at),
        lastSeenAt: text(r.last_seen_at),
      }))
      .filter((r) => r.sessionId),
  };
}

export type TranscriptMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string | null;
  outcome: AssistantOutcome | null;
  productIds: number[];
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
};

const ids = (value: unknown): number[] => (Array.isArray(value) ? value.map(count).filter((n) => n > 0) : []);
const labels = (value: unknown): string[] => (Array.isArray(value) ? value.map(text).filter((v): v is string => v !== null) : []);

export function normalizeTranscript(raw: unknown): TranscriptMessage[] {
  return rowsOf(raw)
    .map((r) => ({
      id: count(r.id),
      role: r.role === "assistant" ? ("assistant" as const) : ("user" as const),
      content: typeof r.content === "string" ? r.content : "",
      createdAt: text(r.created_at),
      outcome: isAssistantOutcome(r.outcome) ? r.outcome : null,
      productIds: ids(r.product_ids),
      addedProductIds: ids(r.added_product_ids),
      tappedProductIds: ids(r.tapped_product_ids),
      questionId: text(r.question_id),
      toolsUsed: labels(r.tools_used),
      searchTerms: labels(r.search_terms),
      page: text(r.page),
      model: text(r.model),
      latencyMs: nullableNumber(r.latency_ms),
      inputTokens: nullableNumber(r.input_tokens),
      outputTokens: nullableNumber(r.output_tokens),
      cacheReadTokens: nullableNumber(r.cache_read_tokens),
      hasImage: r.has_image === true,
      photoReading: text(r.photo_reading),
    }))
    .sort((a, b) => a.id - b.id);
}

/** Outcome → StatusBadge tone (one map, P6; the vocabulary itself lives in lib/assistant/types.ts). */
export const OUTCOME_TONE: Record<AssistantOutcome, "neutral" | "info" | "success" | "warning" | "danger" | "accent"> = {
  answered: "success",
  no_match: "accent",
  no_image_match: "accent",
  no_tools: "info",
  truncated: "warning",
  bad_ids: "warning",
  dead_end: "danger",
  failed: "danger",
};

/** "2.3 s" / "850 ms"; "—" when there is no figure. */
export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/** 1,284 · 12.9K · 4.2M */
export function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return n.toLocaleString("en-US");
}
