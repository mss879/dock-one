"use client";

import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { BarTable, BusyHours } from "@/components/admin/assistant/charts";
import {
  ASSISTANT_MIGRATION,
  compactNumber,
  formatLatency,
  normalizeOverview,
  normalizeSessions,
  OUTCOME_TONE,
  SESSIONS_PAGE_SIZE,
  WINDOWS,
  type SessionRow,
  type WindowDays,
} from "@/components/admin/assistant/data";
import { TranscriptDrawer } from "@/components/admin/assistant/TranscriptDrawer";
import { getAdminTab } from "@/components/admin/registry";
import {
  AdminButton,
  AdminPagination,
  DataTable,
  DateTime,
  KpiTile,
  QueryError,
  SectionCard,
  StatusBadge,
  TabHeader,
  Toggle,
} from "@/components/admin/ui";
import { ASSISTANT_OUTCOMES, OUTCOME_INFO, type AssistantOutcome } from "@/lib/assistant/types";
import { unwrapRpc, useAdminQuery } from "@/lib/admin/query";

/**
 * Assistant insights (blueprint §11.4, §10.13, §12.4) — READ-ONLY. Window 7 / 30 / 90 business
 * days (Asia/Colombo, computed in SQL). Overview KPIs, the outcome mix (the §10.13 labels — one
 * list shared with the TS type, the CHECK and the logger), busy hours, top search terms and the
 * terms that found nothing (catalogue gaps), demand (shown vs taken), photo demand, tool usage,
 * and the sessions list (struggles filter) with a transcript drawer. Every figure comes from
 * admin_assistant_overview / _sessions / _transcript (admin re-checked in SQL); a missing
 * migration shows the banner naming 19_assistant_core.sql; every request is cancelled when a
 * newer one starts (useAdminQuery), so a slow answer can never overwrite a fresher one.
 */

const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

export default function AssistantInsightsTab() {
  const tab = getAdminTab("assistant-insights");
  const [days, setDays] = useState<WindowDays>(30);
  const [strugglesOnly, setStrugglesOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<SessionRow | null>(null);

  const overview = useAdminQuery(
    async ({ supabase, signal }) => normalizeOverview(unwrapRpc(await supabase.rpc("admin_assistant_overview", { p_days: days }).abortSignal(signal), ASSISTANT_MIGRATION)),
    [days],
    { migration: ASSISTANT_MIGRATION },
  );
  const sessions = useAdminQuery(
    async ({ supabase, signal }) =>
      normalizeSessions(
        unwrapRpc(
          await supabase
            .rpc("admin_assistant_sessions", { p_days: days, p_struggles_only: strugglesOnly, p_limit: SESSIONS_PAGE_SIZE, p_offset: (page - 1) * SESSIONS_PAGE_SIZE })
            .abortSignal(signal),
          ASSISTANT_MIGRATION,
        ),
      ),
    [days, strugglesOnly, page],
    { migration: ASSISTANT_MIGRATION },
  );

  const data = overview.data;
  const totals = data?.totals;
  const loading = overview.loading && !data;
  const outcomeRows = ASSISTANT_OUTCOMES.map((outcome) => ({ outcome, turns: data?.outcomes[outcome] ?? 0 }));
  const turns = totals?.turns ?? 0;

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <AdminButton
            icon={<RefreshCw aria-hidden className="size-3.5" />}
            onClick={() => {
              overview.refetch();
              sessions.refetch();
            }}
            loading={overview.loading || sessions.loading}
          >
            Refresh
          </AdminButton>
        }
      />

      {/* Filters: one row above everything they scope. */}
      <div role="group" aria-label="Time window" className="mb-5 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10.5px] font-semibold tracking-[0.08em] text-adm-mute uppercase">Window</span>
        {WINDOWS.map((w) => (
          <AdminButton
            key={w}
            size="sm"
            variant={w === days ? "primary" : "secondary"}
            aria-pressed={w === days}
            onClick={() => {
              setDays(w);
              setPage(1);
            }}
          >
            Last {w} days
          </AdminButton>
        ))}
        {data?.since && (
          <span className="text-[12.5px] text-adm-mute">
            since <DateTime value={data.since} mode="date" /> (Sri Lanka time)
          </span>
        )}
      </div>

      {overview.error && <QueryError error={overview.error} onRetry={overview.refetch} feature="Assistant insights" className="mb-4" />}

      <div className={`grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6 ${overview.loading && data ? "opacity-60 transition-opacity" : ""}`}>
        <KpiTile label="Sessions" loading={loading} value={totals ? compactNumber(totals.sessions) : "—"} hint="Chat sessions with a message in the window." />
        <KpiTile label="Replies" loading={loading} value={totals ? compactNumber(totals.turns) : "—"} hint="Answers from the tech desk (one per shopper turn)." />
        <KpiTile label="Adds" loading={loading} value={totals ? compactNumber(totals.adds) : "—"} hint="Products the desk put in a basket on request, plus Add taps on the products it showed." />
        <KpiTile label="Photo turns" loading={loading} value={totals ? compactNumber(totals.photos) : "—"} hint="Shopper messages that carried a photo (photos are never stored)." />
        <KpiTile
          label="Struggles"
          loading={loading}
          value={totals ? `${compactNumber(totals.struggles)} · ${pct(totals.struggles, turns)}` : "—"}
          hint="Replies with any outcome other than Answered (see the outcome mix), and their share of replies."
        />
        <KpiTile label="Median latency" loading={loading} value={totals ? formatLatency(totals.medianLatencyMs) : "—"} hint="Median time from a shopper's message to the reply." />
      </div>
      {totals && (
        <p className="mt-2 mb-6 font-mono text-[11.5px] text-adm-mute">
          Model tokens in the window: {totals.inputTokens.toLocaleString("en-US")} in ({totals.cacheReadTokens.toLocaleString("en-US")} from cache) ·{" "}
          {totals.outputTokens.toLocaleString("en-US")} out
        </p>
      )}
      {!totals && <div className="mb-6" />}

      <div className="grid gap-6 xl:grid-cols-2">
        <SectionCard title="Outcome mix" description="How every reply ended, classified by the server (never self-graded by the model).">
          <BarTable
            caption="Replies per outcome"
            rows={outcomeRows}
            rowKey={(r) => r.outcome}
            value={(r) => r.turns}
            empty="No replies in this window."
            columns={[
              {
                header: "Outcome",
                cell: (r: { outcome: AssistantOutcome; turns: number }) => (
                  <div className="min-w-0">
                    <StatusBadge tone={OUTCOME_TONE[r.outcome]}>{OUTCOME_INFO[r.outcome].label}</StatusBadge>
                    <p className="mt-1 text-[12px] leading-4 text-adm-mute">
                      {OUTCOME_INFO[r.outcome].meaning}
                      {r.outcome !== "answered" && <> {OUTCOME_INFO[r.outcome].action}</>}
                    </p>
                  </div>
                ),
              },
              { header: "Replies", align: "right", cell: (r) => r.turns.toLocaleString("en-US") },
              { header: "Share", align: "right", cell: (r) => pct(r.turns, turns) },
            ]}
          />
        </SectionCard>

        <SectionCard title="Busy hours" description="When shoppers talk to the desk.">
          <BusyHours hours={data?.hours ?? Array.from({ length: 24 }, () => 0)} timezone={data?.timezone ?? "Asia/Colombo"} />
        </SectionCard>

        <SectionCard title="Top search terms" description="What the desk searched the catalogue for.">
          <BarTable
            caption="Top assistant search terms"
            rows={data?.terms ?? []}
            rowKey={(r) => r.term}
            value={(r) => r.turns}
            empty="No searches in this window."
            columns={[
              { header: "Term", cell: (r) => <span className="break-words">{r.term}</span> },
              { header: "Replies", align: "right", cell: (r) => r.turns },
            ]}
          />
        </SectionCard>

        <SectionCard title="Searches that found nothing" description="Terms from replies where a search came back empty and nothing was shown — the stock-this list.">
          <BarTable
            caption="Zero-result assistant search terms"
            rows={data?.zeroResultTerms ?? []}
            rowKey={(r) => r.term}
            value={(r) => r.turns}
            empty="Every search found something in this window."
            columns={[
              { header: "Term", cell: (r) => <span className="break-words">{r.term}</span> },
              { header: "Replies", align: "right", cell: (r) => r.turns },
            ]}
          />
        </SectionCard>

        <SectionCard title="Demand: shown vs taken" description="Products the desk put on display, and how often they went into a basket from the chat.">
          <BarTable
            caption="Products shown and taken"
            rows={data?.demand ?? []}
            rowKey={(r) => r.productId}
            value={(r) => r.shown}
            empty="No products were shown in this window."
            columns={[
              {
                header: "Product",
                cell: (r) => (
                  <span className="break-words">
                    {r.name.toLowerCase().startsWith(r.brand.toLowerCase()) || !r.brand ? r.name : `${r.brand} ${r.name}`}
                  </span>
                ),
              },
              { header: "Shown", align: "right", cell: (r) => r.shown },
              { header: "Taken", align: "right", cell: (r) => r.taken },
            ]}
          />
        </SectionCard>

        <SectionCard title="Photo demand" description="What shoppers photographed when we had nothing to match — products people own that you don't carry.">
          <BarTable
            caption="Photo readings with no match"
            rows={data?.photoDemand ?? []}
            rowKey={(r) => r.reading}
            value={(r) => r.turns}
            empty="No unmatched photos in this window."
            columns={[
              { header: "Photo read as", cell: (r) => <span className="break-words">{r.reading}</span> },
              { header: "Replies", align: "right", cell: (r) => r.turns },
            ]}
          />
        </SectionCard>

        <SectionCard title="Tool usage" description="How often the desk used each tool.">
          <BarTable
            caption="Tool calls"
            rows={data?.tools ?? []}
            rowKey={(r) => r.tool}
            value={(r) => r.calls}
            empty="No tool calls in this window."
            columns={[
              { header: "Tool", cell: (r) => <span className="font-mono text-[12.5px]">{r.tool}</span> },
              { header: "Calls", align: "right", cell: (r) => r.calls.toLocaleString("en-US") },
            ]}
          />
        </SectionCard>
      </div>

      <SectionCard
        className="mt-6"
        padded={false}
        title="Sessions"
        description="Newest first. Open one to replay the conversation (read-only; contact details were redacted before storage)."
        actions={
          <Toggle
            label="Struggles only"
            checked={strugglesOnly}
            onChange={(on) => {
              setStrugglesOnly(on);
              setPage(1);
            }}
          />
        }
      >
        {sessions.error && <QueryError error={sessions.error} onRetry={sessions.refetch} feature="Sessions" className="m-4" />}
        <DataTable<SessionRow>
          caption="Assistant sessions"
          rows={sessions.data?.items ?? []}
          rowKey={(r) => r.sessionId}
          rowLabel={(r) => `session ${r.sessionId.slice(0, 8)}`}
          loading={sessions.loading}
          failed={Boolean(sessions.error)}
          onRowClick={setSelected}
          selectedKey={selected?.sessionId ?? null}
          rowTone={(r) => (r.struggles > 0 ? "attention" : null)}
          columns={[
            { key: "last_seen_at", header: "Last seen", cell: (r) => <DateTime value={r.lastSeenAt} /> },
            {
              key: "first_message",
              header: "First message",
              cell: (r) => <span className="line-clamp-2 max-w-[28rem] text-adm-ink-2">{r.firstMessage ?? "—"}</span>,
            },
            { key: "turns", header: "Replies", align: "right", cell: (r) => r.turns },
            {
              key: "struggles",
              header: "Struggles",
              align: "right",
              cell: (r) => (r.struggles > 0 ? <StatusBadge tone="warning">{r.struggles}</StatusBadge> : <span className="text-adm-mute">0</span>),
            },
            { key: "photos", header: "Photos", align: "right", hideBelow: "md", cell: (r) => r.photos },
            { key: "adds", header: "Adds", align: "right", hideBelow: "md", cell: (r) => r.adds },
            {
              key: "last_outcome",
              header: "Last outcome",
              hideBelow: "lg",
              cell: (r) => (r.lastOutcome ? <StatusBadge tone={OUTCOME_TONE[r.lastOutcome]}>{OUTCOME_INFO[r.lastOutcome].label}</StatusBadge> : <span className="text-adm-mute">—</span>),
            },
            { key: "customer", header: "Customer", hideBelow: "lg", cell: (r) => (r.customerId ? "Signed in" : <span className="text-adm-mute">Guest</span>) },
          ]}
          actions={[{ label: "Transcript", onClick: setSelected }]}
          empty={{
            title: strugglesOnly ? "No struggling sessions" : "No sessions yet",
            description: strugglesOnly ? "Every reply in this window was answered." : "Conversations with the tech desk appear here.",
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={SESSIONS_PAGE_SIZE} total={sessions.data?.total ?? 0} onPageChange={setPage} loading={sessions.loading} noun="sessions" />
        </div>
      </SectionCard>

      <TranscriptDrawer session={selected} onClose={() => setSelected(null)} />
    </>
  );
}
