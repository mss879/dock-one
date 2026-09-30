"use client";

import { Send } from "lucide-react";
import { useState } from "react";
import { AbandonedCartDrawer } from "@/components/admin/growth/AbandonedCartDrawer";
import { CARTS_MIGRATION, cartState, shopperName, type AbandonedCart, type RecoveryRun } from "@/components/admin/growth/types";
import { getAdminTab } from "@/components/admin/registry";
import { AdminButton, AdminPagination, DataTable, DateTime, Money, QueryError, SectionCard, StatusBadge, TabHeader, Tabs, Toolbar } from "@/components/admin/ui";
import { adminApi } from "@/lib/admin/api";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { unwrapCount, unwrapPage, useAdminQuery } from "@/lib/admin/query";
import { orIlike } from "@/lib/admin/search";
import { adminToast } from "@/lib/admin/toast";
import { parseRecoveryItems, RECOVERY_STAGES, recoveryStageLabel } from "@/lib/cart-recovery";

/*
 * Abandoned carts (blueprint §9.10, §11.2; contract: SQL_NOTES → 13_abandoned_carts.sql): every
 * checkout that was started but not finished, each cart's reminder stage ("2 of 3 sent") and
 * opt-out state, and "Send due reminders" → POST /api/cart-recovery with this admin's session —
 * the same job the hourly scheduler runs (it claims only what is due, so pressing it can never
 * send a reminder early or twice). Read-only otherwise: the reminder state belongs to the job.
 */

type Filter = "open" | "ordered" | "all";

const labels = RECOVERY_STAGES.map((stage) => stage.label);
/** "1 hour, 24 hours and 72 hours" — from lib/cart-recovery.ts, so the copy follows the schedule. */
const schedule = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : (labels[0] ?? "");

function runSummary(run: RecoveryRun) {
  const sent = run.stages.reduce((sum, stage) => sum + stage.sent, 0);
  const failed = run.stages.reduce((sum, stage) => sum + stage.failed, 0);
  const more = run.stages.some((stage) => stage.more);
  const perStage = run.stages.map((stage) => `reminder ${stage.stage}: ${stage.sent}`).join(" · ");
  if (sent > 0) adminToast.success(`${sent} reminder${sent === 1 ? "" : "s"} sent`, perStage);
  if (failed > 0) {
    adminToast.error(
      `${failed} reminder${failed === 1 ? "" : "s"} couldn't be sent`,
      "A failed send goes back in the queue for the next run; an address that can't receive mail is skipped. The server log has the details.",
    );
  }
  if (sent === 0 && failed === 0) adminToast.info("Nothing is due right now", `Reminders go out ${schedule} after a checkout stops.`);
  if (more) adminToast.info("More reminders are due", "This run hit its batch limit — run it again, or the hourly job continues.");
}

export default function AbandonedCartsTab() {
  const tab = getAdminTab("abandoned-carts");
  const [filter, setFilter] = useState<Filter>("open");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AbandonedCart | null>(null);
  const [running, setRunning] = useState(false);

  const { from, to } = pageRange(page);
  const list = useAdminQuery(
    async ({ supabase, signal }) => {
      let query = supabase.from("abandoned_carts").select("*", { count: "exact" });
      if (filter === "open") query = query.eq("converted", false);
      if (filter === "ordered") query = query.eq("converted", true);
      const term = orIlike(["email", "first_name", "last_name"], search);
      if (term) query = query.or(term);
      query = query.order("updated_at", { ascending: false }).order("id", { ascending: true });
      return unwrapPage<AbandonedCart>(await query.range(from, to).abortSignal(signal), CARTS_MIGRATION);
    },
    [filter, search, from, to],
    { migration: CARTS_MIGRATION },
  );

  const counts = useAdminQuery(
    async ({ supabase, signal }) => {
      const count = async (converted: boolean) =>
        unwrapCount(await supabase.from("abandoned_carts").select("id", { count: "exact", head: true }).eq("converted", converted).abortSignal(signal), CARTS_MIGRATION);
      const [open, ordered] = await Promise.all([count(false), count(true)]);
      return { open, ordered };
    },
    [],
    { migration: CARTS_MIGRATION },
  );

  const refresh = () => {
    list.refetch();
    counts.refetch();
  };

  async function sendDue() {
    setRunning(true);
    const res = await adminApi<RecoveryRun>("/api/cart-recovery", {}, { method: "POST", timeoutMs: 120_000 });
    setRunning(false);
    if (!res.ok) {
      adminToast.error("Reminders weren't sent", res.message);
      return;
    }
    runSummary(res.data);
    refresh();
  }

  const c = counts.data;

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <AdminButton variant="primary" icon={<Send aria-hidden className="size-3.5" />} loading={running} onClick={() => void sendDue()}>
            Send due reminders
          </AdminButton>
        }
      />

      {list.error && <QueryError error={list.error} onRetry={refresh} feature="Abandoned carts" className="mb-4" />}

      <SectionCard
        padded={false}
        title="Captured checkouts"
        description={`Reminders go out ${schedule} after a shopper stops at checkout — one person gets reminders only about their latest cart, and never after they order. "Reminders off" means the shopper stopped them, their address is on the suppression list, or the cart was captured before reminders were switched on; it is not an unsubscribe.`}
      >
        <Tabs<Filter>
          label="Cart status"
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setPage(1);
          }}
          className="px-4 pt-3"
          items={[
            { key: "open", label: "Not ordered", count: c?.open ?? null },
            { key: "ordered", label: "Ordered", count: c?.ordered ?? null },
            { key: "all", label: "All", count: c ? c.open + c.ordered : null },
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
              placeholder: "Email or name",
            }}
          />
        </div>
        <DataTable<AbandonedCart>
          caption="Abandoned carts"
          rows={list.data?.rows ?? []}
          rowKey={(row) => row.id}
          rowLabel={(row) => `the cart of ${shopperName(row) || row.email}`}
          loading={list.loading}
          failed={Boolean(list.error)}
          onRowClick={setSelected}
          selectedKey={selected?.id ?? null}
          rowTone={(row) => (row.converted || row.recovery_opted_out ? "muted" : null)}
          columns={[
            {
              key: "shopper",
              header: "Shopper",
              cell: (row) => (
                <span className="block min-w-0">
                  <span className="block truncate font-semibold">{shopperName(row) || "—"}</span>
                  <span className="block truncate text-[12.5px] text-adm-mute">{row.email}</span>
                </span>
              ),
            },
            {
              key: "items",
              header: "Cart",
              align: "right",
              cell: (row) => {
                const lines = parseRecoveryItems(row.cart_items);
                const units = lines.reduce((sum, line) => sum + line.quantity, 0);
                return (
                  <span className="block">
                    <Money amount={row.total_price} className="font-semibold" />
                    <span className="block text-[12.5px] text-adm-mute">{units === 1 ? "1 item" : `${units} items`}</span>
                  </span>
                );
              },
            },
            {
              key: "reminders",
              header: "Reminders",
              cell: (row) => (
                <span className="block">
                  <span className="block font-mono text-[12.5px]">{recoveryStageLabel(row.recovery_stage)}</span>
                  {row.last_recovery_at && (
                    <span className="block text-[12.5px] text-adm-mute">
                      last <DateTime value={row.last_recovery_at} />
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: "state",
              header: "Status",
              cell: (row) => {
                const state = cartState(row);
                return (
                  <StatusBadge tone={state.tone} dot>
                    {state.label}
                  </StatusBadge>
                );
              },
            },
            { key: "updated_at", header: "Last activity", hideBelow: "md", cell: (row) => <DateTime value={row.updated_at} /> },
          ]}
          actions={[{ label: "Open", onClick: setSelected }]}
          empty={{
            title: search ? "No carts match" : filter === "ordered" ? "No ordered carts yet" : "No abandoned carts",
            description: search ? "Try another email or name." : "Checkouts are saved here as shoppers fill in their email and name.",
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="carts" />
        </div>
      </SectionCard>

      <AbandonedCartDrawer cart={selected} onClose={() => setSelected(null)} />
    </>
  );
}
