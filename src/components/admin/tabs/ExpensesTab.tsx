"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { Download, Plus, Tags } from "lucide-react";
import { useState } from "react";
import { CategoriesModal } from "@/components/admin/expenses/CategoriesModal";
import { ExpenseModal } from "@/components/admin/expenses/ExpenseModal";
import {
  categoryFromRow,
  EXPENSE_WRITE,
  EXPENSES_MIGRATION,
  expenseFromRow,
  expenseMethodLabel,
  PERIODS,
  periodRange,
  summaryFromRpc,
  validRange,
  type Expense,
  type ExpenseCategory,
  type PeriodKey,
} from "@/components/admin/expenses/model";
import { getAdminTab } from "@/components/admin/registry";
import {
  AdminButton,
  AdminPagination,
  ConfirmDialog,
  DataTable,
  Field,
  Input,
  KpiTile,
  QueryError,
  SectionCard,
  Select,
  TabHeader,
  Toolbar,
  type SortState,
} from "@/components/admin/ui";
import { csvFileName, downloadCsv, toCsv } from "@/lib/admin/csv";
import { todayYmd } from "@/lib/admin/dates";
import { formatInvoiceDate, formatRs } from "@/lib/admin/invoices";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { unwrapPage, unwrapRows, useAdminQuery } from "@/lib/admin/query";
import { orIlike } from "@/lib/admin/search";
import { adminToast } from "@/lib/admin/toast";
import { deleteRows } from "@/lib/admin/write";
import { getBrowserSupabase } from "@/lib/supabase/browser";

/*
 * Expenses (29_expenses.sql) — what the business pays out, entered by hand. A period (this month
 * by default) and an optional category filter the list; the figures for the period come from
 * admin_expense_summary() so they never depend on paging. Add / edit in a modal, delete behind a
 * confirmation, categories managed in their own modal, CSV of the filtered list.
 */

const CSV_LIMIT = 5000;

export default function ExpensesTab() {
  const tab = getAdminTab("expenses");
  const today = todayYmd();
  const [period, setPeriod] = useState<PeriodKey>("this-month");
  const [custom, setCustom] = useState(() => periodRange("this-month", today));
  const [categoryId, setCategoryId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: "spent_on", direction: "desc" });
  const [editing, setEditing] = useState<Expense | "new" | null>(null);
  const [deleting, setDeleting] = useState<Expense | null>(null);
  const [categoriesOpen, setCategoriesOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const range = period === "custom" ? custom : periodRange(period, today);
  const rangeOk = validRange(range);
  const { from, to } = pageRange(page);

  const categories = useAdminQuery(
    async ({ supabase, signal }) =>
      unwrapRows<Record<string, unknown>>(
        await supabase.from("expense_categories").select("*").order("sort_order").order("name").limit(500).abortSignal(signal),
        EXPENSES_MIGRATION,
      ).map(categoryFromRow),
    ["admin-expense-categories"],
    { migration: EXPENSES_MIGRATION },
  );

  // the expenses in the period, category and search (the list with its count, and the CSV)
  const filtered = (supabase: SupabaseClient, withCount: boolean) => {
    let q = supabase
      .from("expenses")
      .select("*", withCount ? { count: "exact" } : undefined)
      .gte("spent_on", range.from)
      .lte("spent_on", range.to);
    if (categoryId) q = q.eq("category_id", Number(categoryId));
    const term = orIlike(["description", "paid_to", "reference"], search);
    if (term) q = q.or(term);
    return q;
  };

  const list = useAdminQuery(
    async ({ supabase, signal }) => {
      const query = filtered(supabase, true)
        .order(sort?.key ?? "spent_on", { ascending: sort?.direction === "asc" })
        .order("id", { ascending: false });
      const page = unwrapPage<Record<string, unknown>>(await query.range(from, to).abortSignal(signal), EXPENSES_MIGRATION);
      return { total: page.total, rows: page.rows.map(expenseFromRow) };
    },
    ["admin-expenses", range.from, range.to, categoryId, search, sort, from, to],
    { enabled: rangeOk, migration: EXPENSES_MIGRATION },
  );

  const summary = useAdminQuery(
    async ({ supabase, signal }) => {
      const { data, error } = await supabase.rpc("admin_expense_summary", { p_from: range.from, p_to: range.to }).abortSignal(signal);
      if (error) throw error;
      return summaryFromRpc(data);
    },
    ["admin-expense-summary", range.from, range.to],
    { enabled: rangeOk, migration: EXPENSES_MIGRATION },
  );

  const refresh = () => {
    list.refetch();
    summary.refetch();
  };

  const cats: ExpenseCategory[] = categories.data ?? [];
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const rows = list.data?.rows ?? [];
  const s = summary.data;
  const top = s?.byCategory[0];
  const resetPage = () => setPage(1);

  const exportCsv = async () => {
    const supabase = getBrowserSupabase();
    if (!supabase || exporting) return;
    setExporting(true);
    try {
      const { data, error } = await filtered(supabase, false)
        .order("spent_on", { ascending: true })
        .order("id", { ascending: true })
        .limit(CSV_LIMIT);
      if (error) throw error;
      const all = ((data ?? []) as Record<string, unknown>[]).map(expenseFromRow);
      const csv = toCsv(all, [
        { label: "Date", key: "spentOn" },
        { label: "Category", value: (e) => catName.get(e.categoryId) ?? "" },
        { label: "What for", key: "description" },
        { label: "Amount (LKR)", value: (e) => e.amount.toFixed(2) },
        { label: "Paid by", value: (e) => expenseMethodLabel(e.paymentMethod) },
        { label: "Paid to", key: "paidTo" },
        { label: "Bill / receipt no.", key: "reference" },
        { label: "Notes", key: "notes" },
      ]);
      downloadCsv(csvFileName(`expenses-${range.from}-to-${range.to}`), csv);
      if (all.length >= CSV_LIMIT) adminToast.info("Export capped", `The first ${CSV_LIMIT.toLocaleString("en-US")} expenses were exported — narrow the dates for the rest.`);
    } catch (error) {
      adminToast.error("Couldn't export the expenses", error instanceof Error ? error.message : undefined);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <>
            <AdminButton icon={<Tags aria-hidden className="size-3.5" />} onClick={() => setCategoriesOpen(true)}>
              Categories
            </AdminButton>
            <AdminButton variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setEditing("new")} disabled={cats.length === 0}>
              Add expense
            </AdminButton>
          </>
        }
      />

      {(categories.error || list.error || summary.error) && (
        <QueryError error={(categories.error ?? list.error ?? summary.error)!} onRetry={() => (categories.refetch(), refresh())} feature="Expenses" className="mb-4" />
      )}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Period" className="w-44">
          <Select
            value={period}
            options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
            onChange={(e) => {
              const next = e.target.value as PeriodKey;
              if (next === "custom") setCustom(range);
              setPeriod(next);
              resetPage();
            }}
          />
        </Field>
        {period === "custom" && (
          <>
            <Field label="From" className="w-40">
              <Input type="date" value={custom.from} max={custom.to} onChange={(e) => (setCustom((r) => ({ ...r, from: e.target.value })), resetPage())} />
            </Field>
            <Field label="To" className="w-40">
              <Input type="date" value={custom.to} min={custom.from} onChange={(e) => (setCustom((r) => ({ ...r, to: e.target.value })), resetPage())} />
            </Field>
          </>
        )}
        <Field label="Category" className="w-56">
          <Select
            value={categoryId}
            placeholder="All categories"
            options={cats.map((c) => ({ value: String(c.id), label: c.isActive ? c.name : `${c.name} (off)` }))}
            onChange={(e) => (setCategoryId(e.target.value), resetPage())}
          />
        </Field>
        <p className="pb-2 font-mono text-[11px] tracking-[0.06em] text-adm-mute uppercase">
          {rangeOk ? `${formatInvoiceDate(range.from)} – ${formatInvoiceDate(range.to)}` : "Choose a start date on or before the end date"}
        </p>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <KpiTile label="Spent in the period" value={s ? formatRs(s.total) : "—"} loading={summary.loading && !s} hint="Every category, whatever the category filter." />
        <KpiTile label="Expenses" value={s ? s.count.toLocaleString("en-US") : "—"} loading={summary.loading && !s} />
        <KpiTile label="Biggest category" value={top ? top.name : "—"} hint={top ? `${formatRs(top.total)} · ${top.count} expense${top.count === 1 ? "" : "s"}` : undefined} loading={summary.loading && !s} />
      </div>

      {s && s.byCategory.length > 0 && (
        <SectionCard title="By category" className="mb-4">
          <ul className="grid gap-2">
            {s.byCategory.map((c) => {
              const share = s.total > 0 ? c.total / s.total : 0;
              return (
                <li key={c.id} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-[13px]">
                  <button
                    type="button"
                    className="truncate text-left text-adm-ink hover:underline"
                    onClick={() => (setCategoryId(String(c.id)), resetPage())}
                    title={`Show only ${c.name}`}
                  >
                    {c.name}
                  </button>
                  <span aria-hidden className="h-2 bg-adm-panel-2">
                    <span className="block h-full bg-adm-accent" style={{ width: `${Math.max(share * 100, 1)}%` }} />
                  </span>
                  <span className="font-mono text-adm-ink tabular-nums">
                    {formatRs(c.total)} <span className="text-adm-mute">· {Math.round(share * 100)}%</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </SectionCard>
      )}

      <SectionCard padded={false}>
        <div className="p-4 pb-0">
          <Toolbar
            search={{ value: search, onChange: (value) => (setSearch(value), resetPage()), placeholder: "What for, paid to or bill no." }}
            actions={
              <AdminButton size="sm" icon={<Download aria-hidden className="size-3.5" />} loading={exporting} disabled={!rangeOk} onClick={() => void exportCsv()}>
                Export CSV
              </AdminButton>
            }
          />
        </div>
        <DataTable<Expense>
          caption="Expenses"
          rows={rows}
          rowKey={(row) => row.id}
          rowLabel={(row) => `the expense “${row.description}”`}
          loading={list.loading}
          failed={Boolean(list.error)}
          sort={sort}
          onSortChange={(next) => (setSort(next), resetPage())}
          onRowClick={setEditing}
          columns={[
            { key: "spent_on", header: "Date", sortable: true, cell: (row) => <span className="font-mono text-[12.5px] whitespace-nowrap">{formatInvoiceDate(row.spentOn)}</span> },
            { key: "category", header: "Category", hideBelow: "md", cell: (row) => catName.get(row.categoryId) ?? "—" },
            {
              key: "description",
              header: "What for",
              cell: (row) => (
                <span className="block min-w-0">
                  <span className="block font-semibold break-words">{row.description}</span>
                  {(row.paidTo || row.reference) && (
                    <span className="block text-[12.5px] text-adm-mute">
                      {row.paidTo}
                      {row.paidTo && row.reference ? " · " : ""}
                      {row.reference && <span className="font-mono">{row.reference}</span>}
                    </span>
                  )}
                </span>
              ),
            },
            { key: "payment_method", header: "Paid by", hideBelow: "lg", cell: (row) => expenseMethodLabel(row.paymentMethod) },
            { key: "amount", header: "Amount", sortable: true, align: "right", cell: (row) => <span className="font-mono font-semibold tabular-nums whitespace-nowrap">{formatRs(row.amount)}</span> },
          ]}
          actions={[
            { label: "Edit", onClick: setEditing },
            { label: "Delete", variant: "danger", onClick: setDeleting },
          ]}
          empty={{
            title: search || categoryId ? "No expenses match" : "No expenses in this period",
            description: search || categoryId ? "Try another search or category." : "Add the business's payments — rent, salaries, courier — to see where the money goes.",
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="expenses" />
        </div>
      </SectionCard>

      <ExpenseModal
        target={editing}
        categories={cats}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          refresh();
        }}
      />

      <CategoriesModal
        open={categoriesOpen}
        categories={cats}
        onClose={() => setCategoriesOpen(false)}
        onChanged={() => {
          categories.refetch();
          summary.refetch();
        }}
      />

      <ConfirmDialog
        open={deleting != null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title="Delete this expense?"
        description={deleting ? `${formatRs(deleting.amount)} on ${formatInvoiceDate(deleting.spentOn)} — “${deleting.description}”. This can't be undone.` : undefined}
        confirmLabel="Delete expense"
        onConfirm={async () => {
          const target = deleting;
          if (!target) return true;
          const result = await deleteRows("expenses", { id: target.id }, { ...EXPENSE_WRITE, action: "delete", expect: 1 });
          if (result.ok) {
            adminToast.success("Expense deleted");
            refresh();
          }
          return result;
        }}
      />
    </>
  );
}
