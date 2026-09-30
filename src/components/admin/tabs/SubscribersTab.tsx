"use client";

import { Download } from "lucide-react";
import { useState } from "react";
import { ANALYTICS_MIGRATION, LEADS_MIGRATION, type MailingListRow, type NewsletterGrowth, type Subscriber } from "@/components/admin/growth/types";
import { getAdminTab } from "@/components/admin/registry";
import { AdminButton, AdminPagination, DataTable, DateTime, KpiTile, QueryError, SectionCard, StatusBadge, TabHeader, Tabs, Toolbar } from "@/components/admin/ui";
import { newsletterSourceLabel, newsletterUnsubscribePath } from "@/components/growth/newsletter-shared";
import { downloadCsv, toCsv } from "@/lib/admin/csv";
import { todayYmd } from "@/lib/admin/dates";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { unwrapPage, unwrapRpc, useAdminQuery } from "@/lib/admin/query";
import { orIlike } from "@/lib/admin/search";
import { adminToast, toastResult } from "@/lib/admin/toast";
import { adminRpc } from "@/lib/admin/write";
import { absoluteUrl } from "@/lib/env";

/*
 * Subscribers (blueprint §9.11, §11.2; contract: SQL_NOTES → 12_leads.sql, 17_analytics.sql):
 * ONE list attributed by source — counts by source (admin_newsletter_growth), the paginated list
 * (admin RLS), and the CSV export. The export is the MAILING LIST: admin_newsletter_mailing_list()
 * leaves out everyone who unsubscribed or is on the (sealed) suppression list — blueprint §9.11
 * "check email_suppressions before any marketing send" — and carries each person's unsubscribe
 * link for the email footer. Read-only: signups and unsubscribes belong to the shopper.
 */

type Filter = "active" | "unsubscribed" | "all";
const WINDOW_DAYS = 30;
const count = (n: number | undefined) => (typeof n === "number" ? n.toLocaleString("en-GB") : "—");

export default function SubscribersTab() {
  const tab = getAdminTab("subscribers");
  const [filter, setFilter] = useState<Filter>("active");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  const growth = useAdminQuery(
    async ({ supabase, signal }) => unwrapRpc<NewsletterGrowth>(await supabase.rpc("admin_newsletter_growth", { p_days: WINDOW_DAYS }).abortSignal(signal), ANALYTICS_MIGRATION),
    [],
    { migration: ANALYTICS_MIGRATION },
  );

  const { from, to } = pageRange(page);
  const list = useAdminQuery(
    async ({ supabase, signal }) => {
      let query = supabase.from("newsletter_subscribers").select("*", { count: "exact" });
      if (filter === "active") query = query.is("unsubscribed_at", null);
      if (filter === "unsubscribed") query = query.not("unsubscribed_at", "is", null);
      const term = orIlike(["email"], search);
      if (term) query = query.or(term);
      query = query.order("created_at", { ascending: false }).order("id", { ascending: false });
      return unwrapPage<Subscriber>(await query.range(from, to).abortSignal(signal), LEADS_MIGRATION);
    },
    [filter, search, from, to],
    { migration: LEADS_MIGRATION },
  );

  async function exportMailingList() {
    setExporting(true);
    const res = await adminRpc<MailingListRow[]>("admin_newsletter_mailing_list", {}, { migration: LEADS_MIGRATION, action: "load", requireData: false });
    setExporting(false);
    if (!toastResult(res, { failure: "Couldn't export the mailing list" })) return;
    const rows = Array.isArray(res.data) ? res.data : [];
    if (rows.length === 0) {
      adminToast.info("Nobody to export", "There are no subscribers who can be emailed yet.");
      return;
    }
    const csv = toCsv(rows, [
      { label: "Email", key: "email" },
      { label: "Source", value: (row) => newsletterSourceLabel(row.source) },
      { label: "Subscribed (Colombo)", key: "created_at" },
      { label: "Confirmed (Colombo)", key: "confirmed_at" },
      { label: "Unsubscribe link", value: (row) => absoluteUrl(newsletterUnsubscribePath(row.unsubscribe_token)) },
    ]);
    downloadCsv(`newsletter-mailing-list-${todayYmd()}`, csv);
    adminToast.success(`Exported ${rows.length.toLocaleString("en-GB")} subscriber${rows.length === 1 ? "" : "s"}`);
  }

  const g = growth.data;
  const bySource = g?.by_source ?? [];

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <AdminButton variant="primary" icon={<Download aria-hidden className="size-3.5" />} loading={exporting} onClick={() => void exportMailingList()}>
            Export mailing list
          </AdminButton>
        }
      />

      {growth.error && <QueryError error={growth.error} onRetry={growth.refetch} feature="Subscriber figures" className="mb-4" />}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile label="Subscribed" value={count(g?.active)} loading={growth.loading && !g} hint="On the list now (not unsubscribed)." />
        <KpiTile label={`New · ${WINDOW_DAYS} days`} value={count(g?.new)} loading={growth.loading && !g} hint={`Signups in the last ${WINDOW_DAYS} days (Sri Lanka time), whatever they did since.`} />
        <KpiTile label={`Unsubscribed · ${WINDOW_DAYS} days`} value={count(g?.unsubscribed)} loading={growth.loading && !g} hint={`Unsubscribes in the last ${WINDOW_DAYS} days.`} />
        <KpiTile label="All-time signups" value={count(g?.total)} loading={growth.loading && !g} hint="Every address that ever joined, including unsubscribed ones." />
      </div>

      <SectionCard title="By source" description="Where people joined the list. An address keeps the first place it signed up." padded={false} className="mb-4">
        <DataTable<NewsletterGrowth["by_source"][number]>
          caption="Subscribers by source"
          rows={bySource}
          rowKey={(row) => row.source}
          loading={growth.loading && !g}
          failed={Boolean(growth.error)}
          columns={[
            { key: "source", header: "Source", cell: (row) => newsletterSourceLabel(row.source) },
            { key: "active", header: "Subscribed", align: "right", cell: (row) => count(row.active) },
            { key: "new", header: `New · ${WINDOW_DAYS} days`, align: "right", cell: (row) => count(row.new) },
            { key: "total", header: "All time", align: "right", cell: (row) => count(row.total) },
          ]}
          empty={{ title: "No subscribers yet", description: "Signups from the newsletter forms and the product finder appear here." }}
        />
      </SectionCard>

      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Subscribers" className="mb-4" />}

      <SectionCard
        padded={false}
        title="All subscribers"
        description="The export contains only people who can be emailed: it leaves out everyone who unsubscribed or is on the suppression list. Put each person's unsubscribe link (in the export) in every email you send."
      >
        <Tabs<Filter>
          label="Subscription status"
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setPage(1);
          }}
          className="px-4 pt-3"
          items={[
            { key: "active", label: "Subscribed", count: g?.active ?? null },
            { key: "unsubscribed", label: "Unsubscribed", count: g ? g.total - g.active : null },
            { key: "all", label: "All", count: g?.total ?? null },
          ]}
        />
        <div className="p-4 pb-0">
          <Toolbar
            search={{
              value: search,
              onChange: (value) => {
                setSearch(value);
                setPage(1);
              },
              placeholder: "Email address",
            }}
          />
        </div>
        <DataTable<Subscriber>
          caption="Newsletter subscribers"
          rows={list.data?.rows ?? []}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.email}
          loading={list.loading}
          failed={Boolean(list.error)}
          rowTone={(row) => (row.unsubscribed_at ? "muted" : null)}
          columns={[
            { key: "email", header: "Email", cell: (row) => <span className="block truncate font-mono text-[13px]">{row.email}</span> },
            { key: "source", header: "Source", hideBelow: "sm", cell: (row) => newsletterSourceLabel(row.source) },
            {
              key: "status",
              header: "Status",
              cell: (row) =>
                row.unsubscribed_at ? (
                  <span className="block">
                    <StatusBadge tone="neutral">Unsubscribed</StatusBadge>
                    <span className="mt-1 block text-[12.5px] text-adm-mute">
                      <DateTime value={row.unsubscribed_at} mode="date" />
                    </span>
                  </span>
                ) : (
                  <StatusBadge tone="success" dot>
                    Subscribed
                  </StatusBadge>
                ),
            },
            { key: "created_at", header: "Joined", hideBelow: "md", cell: (row) => <DateTime value={row.created_at} mode="date" /> },
          ]}
          empty={{
            title: search ? "No subscribers match" : filter === "unsubscribed" ? "Nobody has unsubscribed" : "No subscribers yet",
            description: search ? "Try another address." : "Signups from the newsletter forms and the product finder appear here.",
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="subscribers" />
        </div>
      </SectionCard>
    </>
  );
}
