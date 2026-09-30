"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { getAdminTab } from "@/components/admin/registry";
import { NewDiscountModal } from "@/components/admin/discounts/NewDiscountModal";
import { OfferPerformance } from "@/components/admin/discounts/OfferPerformance";
import { DISCOUNTS_MIGRATION, DISCOUNT_WRITE, discountState, discountValueLabel, normalizeDiscount, type AdminDiscount } from "@/components/admin/discounts/types";
import {
  AdminButton,
  AdminNotice,
  AdminPagination,
  ConfirmDialog,
  DataTable,
  DateTime,
  Field,
  Modal,
  Money,
  NumberInput,
  QueryError,
  SectionCard,
  StatusBadge,
  TabHeader,
  Toolbar,
  type SortState,
} from "@/components/admin/ui";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { unwrapPage, useAdminQuery } from "@/lib/admin/query";
import { orIlike } from "@/lib/admin/search";
import { adminToast, toastResult } from "@/lib/admin/toast";
import { deleteRows, updateRows } from "@/lib/admin/write";

const STATE_BADGE = {
  live: { tone: "success", label: "Live" },
  paused: { tone: "neutral", label: "Paused" },
  scheduled: { tone: "info", label: "Scheduled" },
  expired: { tone: "neutral", label: "Ended" },
  used_up: { tone: "warning", label: "Used up" },
} as const;

const SORTABLE = new Set(["created_at", "code", "usage_count"]);

/**
 * Discounts (blueprint §11.2): list with usage / limit / active / dates / assistant-only;
 * create (the DB assigns the id and upper-cases the code); pause/resume; assistant-only on/off
 * (needs a usage limit — asked for here, enforced by CHECK too); delete with confirmation; and
 * offer performance from admin_offer_performance. Plain CRUD under admin RLS through the kit's
 * write helpers (error AND affected rows checked). Codes aren't cached on the storefront, so
 * there is nothing to revalidate.
 */
export default function DiscountsTab() {
  const tab = getAdminTab("discounts");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: "created_at", direction: "desc" });
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AdminDiscount | null>(null);
  const [capping, setCapping] = useState<AdminDiscount | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const [capSaving, setCapSaving] = useState(false);
  const [capError, setCapError] = useState<string | null>(null);

  const { from, to } = pageRange(page);
  const list = useAdminQuery(
    async ({ supabase, signal }) => {
      let query = supabase.from("discounts").select("*", { count: "exact" });
      const filter = orIlike(["code", "title"], search);
      if (filter) query = query.or(filter);
      const key = sort && SORTABLE.has(sort.key) ? sort.key : "created_at";
      query = query.order(key, { ascending: sort?.direction === "asc" }).order("id", { ascending: false });
      return unwrapPage<Record<string, unknown>>(await query.range(from, to).abortSignal(signal), DISCOUNTS_MIGRATION);
    },
    [search, from, to, sort],
    { migration: DISCOUNTS_MIGRATION },
  );
  const rows = (list.data?.rows ?? []).map(normalizeDiscount);

  const replaceRow = (saved: Record<string, unknown> | undefined) => {
    if (!saved) return list.refetch();
    list.mutate((current) => current && { ...current, rows: current.rows.map((row) => (Number(row.id) === Number(saved.id) ? saved : row)) });
  };

  async function toggleActive(row: AdminDiscount) {
    const res = await updateRows<Record<string, unknown>>("discounts", { is_active: !row.isActive }, { id: row.id }, { ...DISCOUNT_WRITE, expect: 1 });
    if (!toastResult(res, { success: `${row.code} ${row.isActive ? "paused" : "resumed"}`, failure: "Couldn't update the discount" })) return;
    replaceRow(res.data[0]);
  }

  async function toggleAssistantOnly(row: AdminDiscount) {
    if (!row.assistantOnly && row.usageLimit === null) {
      // The UI asks for the cap first (the CHECK would refuse it anyway).
      setCap(null);
      setCapError(null);
      setCapping(row);
      return;
    }
    const res = await updateRows<Record<string, unknown>>("discounts", { assistant_only: !row.assistantOnly }, { id: row.id }, { ...DISCOUNT_WRITE, expect: 1 });
    if (!toastResult(res, { success: `${row.code}: ${row.assistantOnly ? "any channel may offer it" : "assistant only"}`, failure: "Couldn't update the discount" })) return;
    replaceRow(res.data[0]);
  }

  async function saveCap() {
    if (!capping || capSaving) return;
    if (cap === null || cap < 1) {
      setCapError("Assistant-only codes need a usage limit of at least 1.");
      return;
    }
    setCapSaving(true);
    const res = await updateRows<Record<string, unknown>>("discounts", { usage_limit: cap, assistant_only: true }, { id: capping.id }, { ...DISCOUNT_WRITE, expect: 1 });
    setCapSaving(false);
    if (!res.ok) {
      setCapError(res.message);
      return;
    }
    adminToast.success(`${capping.code}: assistant only, up to ${cap} uses`);
    replaceRow(res.data[0]);
    setCapping(null);
  }

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <AdminButton variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setCreating(true)}>
            New discount
          </AdminButton>
        }
      />

      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Discounts" className="mb-4" />}

      <SectionCard padded={false} className="mb-6">
        <div className="p-4 pb-0">
          <Toolbar
            search={{
              value: search,
              onChange: (value) => {
                setSearch(value);
                setPage(1);
              },
              placeholder: "Code or name",
              label: "Search discounts",
            }}
          />
        </div>
        <DataTable<AdminDiscount>
          caption="Discount codes"
          rows={rows}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.code}
          loading={list.loading}
          failed={Boolean(list.error)}
          sort={sort}
          onSortChange={(next) => {
            setSort(next);
            setPage(1);
          }}
          rowTone={(row) => (discountState(row) === "live" ? null : "muted")}
          columns={[
            {
              key: "code",
              header: "Code",
              sortable: true,
              cell: (row) => (
                <span className="flex flex-col gap-0.5">
                  <span className="font-mono font-semibold">{row.code}</span>
                  <span className="text-xs text-adm-mute">{row.title}</span>
                </span>
              ),
            },
            { key: "value", header: "Discount", cell: (row) => discountValueLabel(row) },
            { key: "min", header: "Minimum", align: "right", hideBelow: "md", cell: (row) => (row.minRequirement > 0 ? <Money amount={row.minRequirement} /> : "—") },
            { key: "usage_count", header: "Uses", sortable: true, align: "right", cell: (row) => `${row.usageCount}${row.usageLimit !== null ? ` / ${row.usageLimit}` : ""}` },
            {
              key: "dates",
              header: "Dates",
              hideBelow: "lg",
              cell: (row) =>
                row.startsAt || row.endsAt ? (
                  <span className="flex flex-col text-xs">
                    {row.startsAt && (
                      <span>
                        From <DateTime value={row.startsAt} />
                      </span>
                    )}
                    {row.endsAt && (
                      <span>
                        Until <DateTime value={row.endsAt} />
                      </span>
                    )}
                  </span>
                ) : (
                  <span className="text-xs text-adm-mute">No end date</span>
                ),
            },
            {
              key: "status",
              header: "Status",
              cell: (row) => {
                const state = STATE_BADGE[discountState(row)];
                return (
                  <span className="flex flex-wrap gap-1.5">
                    <StatusBadge tone={state.tone} dot>
                      {state.label}
                    </StatusBadge>
                    {row.assistantOnly && <StatusBadge tone="accent">Assistant only</StatusBadge>}
                  </span>
                );
              },
            },
            { key: "created_at", header: "Created", sortable: true, hideBelow: "lg", cell: (row) => <DateTime value={row.createdAt} mode="date" /> },
          ]}
          actions={[
            { label: "Pause", hidden: (row) => !row.isActive, onClick: (row) => void toggleActive(row) },
            { label: "Resume", hidden: (row) => row.isActive, onClick: (row) => void toggleActive(row) },
            { label: "Assistant only", hidden: (row) => row.assistantOnly, onClick: (row) => void toggleAssistantOnly(row) },
            { label: "Any channel", hidden: (row) => !row.assistantOnly, onClick: (row) => void toggleAssistantOnly(row) },
            { label: "Delete", variant: "danger", onClick: setDeleting },
          ]}
          empty={{
            title: search ? "No discounts match" : "No discount codes yet",
            description: search ? "Try another search." : "Create one with “New discount”.",
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="discounts" />
        </div>
      </SectionCard>

      <OfferPerformance />

      <NewDiscountModal open={creating} onClose={() => setCreating(false)} onCreated={list.refetch} />

      <Modal
        open={capping !== null}
        onClose={() => setCapping(null)}
        busy={capSaving}
        onSubmit={saveCap}
        size="sm"
        title={`Assistant only — ${capping?.code ?? ""}`}
        description="Any code the assistant can hand out must have a usage limit."
        footer={
          <>
            <AdminButton onClick={() => setCapping(null)} disabled={capSaving}>
              Cancel
            </AdminButton>
            <AdminButton type="submit" variant="primary" loading={capSaving}>
              Save
            </AdminButton>
          </>
        }
      >
        <div className="grid gap-4">
          <Field label="Usage limit" required hint={capping ? `Used ${capping.usageCount} time${capping.usageCount === 1 ? "" : "s"} so far.` : undefined}>
            <NumberInput value={cap} onChange={setCap} min={1} max={1_000_000} />
          </Field>
          {capError && <AdminNotice tone="error">{capError}</AdminNotice>}
        </div>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title={`Delete ${deleting?.code ?? ""}?`}
        description="Shoppers can no longer use it. Orders that already used it keep their discount and the code on record. To stop it for now, pause it instead."
        confirmLabel="Delete discount"
        onConfirm={async () => {
          if (!deleting) return false;
          const res = await deleteRows("discounts", { id: deleting.id }, { ...DISCOUNT_WRITE, expect: 1 });
          if (res.ok) {
            adminToast.success(`Discount ${deleting.code} deleted`);
            list.refetch();
          }
          return res;
        }}
      />
    </>
  );
}
