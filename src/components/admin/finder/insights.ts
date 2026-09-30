/**
 * Finder insights data (admin, blueprint §11.2 "distribution of answers: what people want that
 * you may not stock"). The figures come from ONE admin RPC, `admin_finder_insights(p_days)`
 * (14_finder.sql — heavy aggregates live in admin_* RPCs, §11.1); this module types and
 * normalises its jsonb and turns stored answer values into labels (the same definitions the
 * finder asks with — lib/quiz.ts, P6). Plain module.
 */

import { answerLabel, brandFromAvoid, type QuestionId } from "@/lib/quiz";

export const FINDER_MIGRATION = "14_finder.sql";

/** The questions whose answers are distributed (category is the filter, not a chart). */
export const INSIGHT_QUESTIONS = ["use", "budget", "portability", "avoid"] as const;
export type InsightQuestion = (typeof INSIGHT_QUESTIONS)[number];

export const QUESTION_TITLES: Record<InsightQuestion, string> = {
  use: "Mostly for",
  budget: "Budget",
  portability: "Light or compact",
  avoid: "Asked to avoid",
};

export type CategoryDemand = { category: string | null; responses: number; short: number; empty: number };
export type AnswerCount = { category: string | null; question: InsightQuestion; value: string; count: number };
export type FinderGap = {
  category: string | null;
  use: string | null;
  budget: string | null;
  portability: string | null;
  avoid: string[];
  picks: number;
  count: number;
};

export type FinderInsights = {
  days: number;
  since: string | null;
  responses: number;
  withEmail: number;
  signedIn: number;
  short: number;
  empty: number;
  categories: CategoryDemand[];
  answers: AnswerCount[];
  gaps: FinderGap[];
};

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): number => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : 0;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
};
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : null);
const isQuestion = (value: unknown): value is InsightQuestion => typeof value === "string" && (INSIGHT_QUESTIONS as readonly string[]).includes(value);

/** RPC jsonb → FinderInsights (anything malformed is dropped, never guessed). */
export function normalizeInsights(raw: unknown): FinderInsights {
  const data = isRow(raw) ? raw : {};
  const list = (value: unknown): Row[] => (Array.isArray(value) ? value.filter(isRow) : []);
  return {
    days: count(data.days) || 30,
    since: text(data.since),
    responses: count(data.responses),
    withEmail: count(data.with_email),
    signedIn: count(data.signed_in),
    short: count(data.short),
    empty: count(data.empty),
    categories: list(data.categories).map((c) => ({ category: text(c.category), responses: count(c.responses), short: count(c.short), empty: count(c.empty) })),
    answers: list(data.answers).flatMap((a) =>
      isQuestion(a.question) && text(a.value) ? [{ category: text(a.category), question: a.question, value: text(a.value) as string, count: count(a.count) }] : [],
    ),
    gaps: list(data.gaps).map((g) => ({
      category: text(g.category),
      use: text(g.use),
      budget: text(g.budget),
      portability: text(g.portability),
      avoid: Array.isArray(g.avoid) ? g.avoid.map(text).filter((v): v is string => v !== null) : [],
      picks: count(g.picks),
      count: count(g.count),
    })),
  };
}

/** A stored answer value → the label the shopper saw (brands read "Brand · Vanta"). */
export function insightLabel(question: InsightQuestion, value: string): string {
  if (question === "avoid") {
    const brand = brandFromAvoid(value);
    if (brand !== null) return `Brand · ${brand}`;
  }
  return answerLabel(question as QuestionId, value);
}

/** Answer counts for one question, summed over the chosen category (null = all), most asked first. */
export function distribution(insights: FinderInsights, question: InsightQuestion, category: string | null): { value: string; label: string; count: number }[] {
  const totals = new Map<string, number>();
  for (const row of insights.answers) {
    if (row.question !== question || (category !== null && row.category !== category)) continue;
    totals.set(row.value, (totals.get(row.value) ?? 0) + row.count);
  }
  return [...totals.entries()]
    .map(([value, n]) => ({ value, label: insightLabel(question, value), count: n }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Share as a whole percent ("—" when there is no base). */
export function percent(part: number, whole: number): string {
  if (!(whole > 0)) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}
