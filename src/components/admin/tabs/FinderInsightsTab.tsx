"use client";

import { Compass } from "lucide-react";
import { useMemo, useState } from "react";
import { getAdminTab } from "@/components/admin/registry";
import { DataTable, EmptyState, KpiTile, QueryError, SectionCard, TabHeader, Tabs, Toolbar } from "@/components/admin/ui";
import { AnswerTable, DemandTable } from "@/components/admin/finder/charts";
import {
  FINDER_MIGRATION,
  INSIGHT_QUESTIONS,
  QUESTION_TITLES,
  distribution,
  insightLabel,
  normalizeInsights,
  percent,
  type FinderGap,
  type FinderInsights,
} from "@/components/admin/finder/insights";
import { rangeValue, type DatePreset, type DateRangeValue } from "@/lib/admin/dates";
import { unwrapRows, unwrapRpc, useAdminQuery } from "@/lib/admin/query";

const CATALOGUE_MIGRATION = "04_catalogue.sql";
const PRESETS: readonly DatePreset[] = ["7d", "30d", "90d"];
const DAYS: Partial<Record<DatePreset, number>> = { "7d": 7, "30d": 30, "90d": 90 };
const ALL = "__all__";

type GapRow = FinderGap & { key: string };

/**
 * Finder insights (blueprint §11.2 "distribution of answers: what people want that you may not
 * stock", §12.4 "Finder answer distribution"). Read-only; every figure comes from
 * `admin_finder_insights(p_days)` (14_finder.sql — the admin is re-checked in SQL), one call per
 * window. Figures count finder SESSIONS: a shopper who re-runs the finder replaces their answers.
 */
export default function FinderInsightsTab() {
  const tab = getAdminTab("finder-insights");
  const [range, setRange] = useState<DateRangeValue>(() => rangeValue("30d"));
  const days = DAYS[range.preset] ?? 30;
  const [view, setView] = useState<string>(ALL);

  const insights = useAdminQuery<FinderInsights>(
    async ({ supabase, signal }) => normalizeInsights(unwrapRpc(await supabase.rpc("admin_finder_insights", { p_days: days }).abortSignal(signal), FINDER_MIGRATION)),
    [days],
    { migration: FINDER_MIGRATION },
  );
  // Category names for the labels (admin RLS reads every category, active or not).
  const categories = useAdminQuery<{ id: string; name: string }[]>(
    async ({ supabase, signal }) => unwrapRows<{ id: string; name: string }>(await supabase.from("categories").select("id, name").order("sort_order").abortSignal(signal), CATALOGUE_MIGRATION),
    [],
    { migration: CATALOGUE_MIGRATION },
  );

  const data = insights.data;
  const nameOf = useMemo(() => {
    const names = new Map((categories.data ?? []).map((c) => [c.id, c.name]));
    return (id: string | null) => (id ? (names.get(id) ?? id) : "Not answered");
  }, [categories.data]);

  const viewItems = useMemo(
    () => [
      { key: ALL, label: "All categories", count: data?.responses ?? null },
      ...(data?.categories ?? []).filter((c) => c.category).map((c) => ({ key: c.category as string, label: nameOf(c.category), count: c.responses })),
    ],
    [data, nameOf],
  );
  const activeView = viewItems.some((item) => item.key === view) ? view : ALL;
  const viewCategory = activeView === ALL ? null : activeView;
  const viewSessions = viewCategory === null ? (data?.responses ?? 0) : (data?.categories.find((c) => c.category === viewCategory)?.responses ?? 0);

  const gapRows: GapRow[] = (data?.gaps ?? []).map((gap, i) => ({ ...gap, key: `${i}:${gap.category}:${gap.use}:${gap.budget}:${gap.portability}:${gap.avoid.join("|")}:${gap.picks}` }));
  const loading = insights.loading && !data;
  const nothing = Boolean(data) && data!.responses === 0;
  const windowLabel = `the last ${days} days`;

  return (
    <>
      <TabHeader eyebrow={tab.group} title={tab.label} description={tab.summary} />

      <Toolbar className="mb-4" dateRange={{ value: range, onChange: setRange, presets: PRESETS }} />

      {insights.error && <QueryError error={insights.error} onRetry={insights.refetch} feature="Finder insights" className="mb-4" />}

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiTile label="Finder sessions" loading={loading} value={data ? data.responses : "—"} hint={`Shoppers whose latest finder answers fall in ${windowLabel} (a re-run replaces earlier answers).`} />
        <KpiTile
          label="Asked for email"
          loading={loading}
          value={data ? data.withEmail : "—"}
          hint={data ? `${percent(data.withEmail, data.responses)} of sessions. Each address also joined the newsletter (source: product finder).` : "Sessions that asked for their picks by email."}
        />
        <KpiTile label="Signed in" loading={loading} value={data ? data.signedIn : "—"} hint="Sessions from a signed-in account." />
        <KpiTile
          label="Came up short"
          loading={loading}
          value={data ? data.short : "—"}
          hint={data ? `${percent(data.short, data.responses)} of sessions: fewer than 3 products matched the answers.` : "Fewer than 3 products matched the answers."}
        />
        <KpiTile label="Nothing matched" loading={loading} value={data ? data.empty : "—"} hint="Sessions where no product matched at all." />
      </div>

      {nothing ? (
        <SectionCard>
          <EmptyState
            icon={<Compass aria-hidden className="size-5" />}
            title={`No finder answers in ${windowLabel}`}
            description="When shoppers use the product finder (/discover), what they ask for shows up here."
          />
        </SectionCard>
      ) : (
        <div className={`space-y-6 transition-opacity ${insights.loading && data ? "opacity-60" : ""}`} aria-busy={insights.loading || undefined}>
          <SectionCard
            title="Demand by category"
            description="What shoppers ran the finder for, and how often fewer than 3 products matched their answers — the first place to look for stock you may be missing."
          >
            {data && data.categories.length > 0 ? (
              <DemandTable
                caption={`Finder sessions by category, ${windowLabel}`}
                rows={data.categories.map((c) => ({ key: c.category ?? "none", label: nameOf(c.category), responses: c.responses, short: c.short, empty: c.empty }))}
              />
            ) : (
              <p className="text-sm text-adm-mute">{loading ? "Loading…" : "Nothing to show yet."}</p>
            )}
          </SectionCard>

          <SectionCard title="What shoppers asked for" description="How often each answer was chosen. Questions the finder didn't ask for a category (its stock couldn't honour them) have no answers there.">
            <Tabs label="Category" value={activeView} onChange={setView} items={viewItems}>
              {data ? (
                <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
                  {INSIGHT_QUESTIONS.map((question) => {
                    const rows = distribution(data, question, viewCategory);
                    const answered = rows.reduce((sum, r) => sum + r.count, 0);
                    return (
                      <section key={question} aria-labelledby={`finder-q-${question}`} className="min-w-0">
                        <h3 id={`finder-q-${question}`} className="mb-2 flex items-baseline justify-between gap-3 border-b border-adm-line pb-1.5">
                          <span className="font-mono text-[10.5px] font-semibold tracking-[0.08em] text-adm-ink-2 uppercase">{QUESTION_TITLES[question]}</span>
                          <span className="text-xs text-adm-mute">
                            {question === "avoid" ? `${viewSessions} sessions` : `${answered} ${answered === 1 ? "answer" : "answers"}`}
                          </span>
                        </h3>
                        {rows.length > 0 ? (
                          <AnswerTable
                            caption={`${QUESTION_TITLES[question]} — ${viewCategory ? nameOf(viewCategory) : "all categories"}, ${windowLabel}`}
                            rows={rows.map((r) => ({ key: r.value, label: r.label, count: r.count }))}
                            total={question === "avoid" ? viewSessions : answered}
                            shareOf={question === "avoid" ? "sessions" : "answers"}
                          />
                        ) : (
                          <p className="py-2 text-sm text-adm-mute">{question === "avoid" ? "Nobody asked to avoid anything." : "No answers."}</p>
                        )}
                      </section>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-adm-mute">{loading ? "Loading…" : "Nothing to show yet."}</p>
              )}
            </Tabs>
          </SectionCard>

          <SectionCard
            title="Where the finder came up short"
            description="Answer sets that found fewer than 3 products, most asked first (up to 25). Each is a demand the current range doesn't fully cover."
            padded={false}
          >
            <DataTable<GapRow>
              caption={`Answer sets with fewer than 3 matching products, ${windowLabel}`}
              rows={gapRows}
              rowKey={(row) => row.key}
              loading={loading}
              failed={Boolean(insights.error) && !data}
              columns={[
                { key: "category", header: "Category", cell: (row) => <span className="font-medium">{nameOf(row.category)}</span> },
                { key: "use", header: "Mostly for", cell: (row) => (row.use ? insightLabel("use", row.use) : "—") },
                { key: "budget", header: "Budget", hideBelow: "md", cell: (row) => (row.budget ? insightLabel("budget", row.budget) : "—") },
                { key: "portability", header: "Light or compact", hideBelow: "lg", cell: (row) => (row.portability ? insightLabel("portability", row.portability) : "—") },
                { key: "avoid", header: "Avoiding", cell: (row) => (row.avoid.length > 0 ? row.avoid.map((v) => insightLabel("avoid", v)).join(", ") : "Nothing") },
                { key: "picks", header: "Matched", align: "right", cell: (row) => row.picks },
                { key: "count", header: "Times asked", align: "right", cell: (row) => <span className="font-semibold">{row.count}</span> },
              ]}
              empty={{ title: "No gaps in this window", description: "Every finder session found 3 matching products." }}
            />
          </SectionCard>
        </div>
      )}
    </>
  );
}
