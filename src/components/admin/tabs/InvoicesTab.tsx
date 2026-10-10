"use client";

import { FilePlus2, Settings2 } from "lucide-react";
import { useState } from "react";
import { InvoiceEditor } from "@/components/admin/invoices/InvoiceEditor";
import { printInvoice, INVOICE_LOGO_PATH } from "@/components/admin/invoices/invoice-document";
import { TemplateSettings } from "@/components/admin/invoices/TemplateSettings";
import { getAdminTab } from "@/components/admin/registry";
import {
  AdminButton,
  AdminPagination,
  ConfirmDialog,
  DataTable,
  KpiTile,
  QueryError,
  SectionCard,
  Select,
  StatusBadge,
  TabHeader,
  Toolbar,
  type SortState,
} from "@/components/admin/ui";
import { todayYmd } from "@/lib/admin/dates";
import {
  buildInvoiceSave,
  dueHint,
  duplicateForm,
  FALLBACK_INVOICE_SETTINGS,
  fetchInvoice,
  fetchInvoicePage,
  fetchInvoiceSettings,
  fetchInvoiceSummary,
  formatInvoiceDate,
  formatRs,
  fromRpcResult,
  INVOICE_LIST_FILTERS,
  INVOICE_WRITE,
  INVOICES_MIGRATION,
  invoiceDisplayStatus,
  isInvoiceListFilter,
  type InvoiceListFilter,
  type InvoiceListRow,
  type InvoiceRpcResult,
  type InvoiceSettings,
} from "@/lib/admin/invoices";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { unwrapRow, useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { setAdminParams, useAdminParam } from "@/lib/admin/url";
import { adminRpc } from "@/lib/admin/write";
import { bankAccountFromSettings, normalizeStoreSettings } from "@/lib/settings-shared";
import { getBrowserSupabase } from "@/lib/supabase/browser";

/**
 * Admin → Commerce → Invoices (25_invoices.sql). The list: what's owed, what's overdue and what
 * came in, every invoice filtered/sorted/paginated in the database. `?tab=invoices&invoice=<id|new>`
 * opens the builder (editor + live preview); `&from_order=DO-10042` starts one from a web order
 * (the order drawer's "Create invoice"). Back closes it.
 */

export default function InvoicesTab() {
  const tab = getAdminTab("invoices");
  const param = useAdminParam("invoice");
  const fromOrderParam = useAdminParam("from_order");
  const target: number | "new" | null = param === "new" ? "new" : param && /^\d{1,9}$/.test(param) ? Number(param) : null;
  const fromOrder = fromOrderParam && /^DO-\d{1,12}$/i.test(fromOrderParam) ? fromOrderParam.toUpperCase() : null;

  const [search, setSearch] = useState("");
  // ?filter=due (the due-payments alert links here) picks the list filter; the select changes it after
  const [page, setPage] = useState(1);
  const filterParam = useAdminParam("filter");
  const [filter, setFilter] = useState<InvoiceListFilter>(isInvoiceListFilter(filterParam) ? filterParam : "all");
  const [seenFilterParam, setSeenFilterParam] = useState(filterParam);
  if (filterParam !== seenFilterParam) {
    setSeenFilterParam(filterParam);
    if (isInvoiceListFilter(filterParam)) {
      setFilter(filterParam);
      setPage(1);
    }
  }
  const [sort, setSort] = useState<SortState>({ key: "issue_date", direction: "desc" });
  const [templateOpen, setTemplateOpen] = useState(false);
  const [deleting, setDeleting] = useState<InvoiceListRow | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const today = todayYmd();

  const { from, to } = pageRange(page);
  const list = useAdminQuery(({ supabase, signal }) => fetchInvoicePage(supabase, { search, filter, sort, from, to, today, signal }), ["admin-invoices", search, filter, sort, from, to, today], {
    enabled: target === null,
    migration: INVOICES_MIGRATION,
  });
  const summary = useAdminQuery(({ supabase, signal }) => fetchInvoiceSummary(supabase, signal), ["admin-invoice-summary"], {
    enabled: target === null,
    migration: INVOICES_MIGRATION,
  });
  const settingsQuery = useAdminQuery(({ supabase, signal }) => fetchInvoiceSettings(supabase, signal), ["invoice-settings"], { migration: INVOICES_MIGRATION });
  const [settingsOverride, setSettingsOverride] = useState<InvoiceSettings | null>(null);
  const settings = settingsOverride ?? settingsQuery.data ?? null;

  const refresh = () => {
    list.refetch();
    summary.refetch();
  };
  const open = (id: number | "new", extra: Record<string, string | null> = {}) => setAdminParams({ invoice: id, from_order: null, ...extra });

  /** Print straight from the list (loads the invoice and the bank account first). */
  const printRow = async (row: InvoiceListRow) => {
    const supabase = getBrowserSupabase();
    if (!supabase || busyId) return;
    setBusyId(row.id);
    try {
      const controller = new AbortController();
      const [loaded, store] = await Promise.all([
        fetchInvoice(supabase, row.id, controller.signal),
        supabase.from("store_settings").select("*").eq("id", true).maybeSingle(),
      ]);
      if (!loaded) {
        adminToast.error("This invoice no longer exists");
        return;
      }
      const storeRow = unwrapRow<Record<string, unknown>>(store, "03_store_settings.sql");
      const payments = loaded.payments;
      const ok = await printInvoice({
        form: loaded.form,
        settings: settings ?? (await fetchInvoiceSettings(supabase, controller.signal)) ?? FALLBACK_INVOICE_SETTINGS,
        bank: storeRow ? bankAccountFromSettings(normalizeStoreSettings(storeRow)) : null,
        logoUrl: `${window.location.origin}${INVOICE_LOGO_PATH}`,
        paidOn: payments.length ? payments[payments.length - 1].paidOn : null,
      });
      if (!ok) adminToast.error("Couldn't open the print dialog");
    } catch (error) {
      console.error("[admin] invoice print failed", error);
      adminToast.error("Couldn't load the invoice to print it");
    } finally {
      setBusyId(null);
    }
  };

  const duplicateRow = async (row: InvoiceListRow) => {
    const supabase = getBrowserSupabase();
    if (!supabase || busyId) return;
    setBusyId(row.id);
    try {
      const loaded = await fetchInvoice(supabase, row.id, new AbortController().signal);
      if (!loaded) {
        adminToast.error("This invoice no longer exists");
        return;
      }
      const result = await adminRpc<InvoiceRpcResult>("admin_save_invoice", buildInvoiceSave(duplicateForm(loaded.form, settings, today)), INVOICE_WRITE);
      if (!result.ok) {
        adminToast.error("Couldn't duplicate the invoice", result.message);
        return;
      }
      const id = fromRpcResult(result.data).form.id;
      adminToast.success("Copy created as a new draft");
      refresh();
      if (id != null) open(id);
    } catch (error) {
      console.error("[admin] invoice duplicate failed", error);
      adminToast.error("Couldn't duplicate the invoice");
    } finally {
      setBusyId(null);
    }
  };

  const templateDrawer = (
    <TemplateSettings
      open={templateOpen}
      onClose={() => setTemplateOpen(false)}
      settings={settings}
      onSaved={(saved) => {
        setSettingsOverride(saved);
        settingsQuery.refetch();
      }}
    />
  );

  if (target !== null) {
    return (
      <InvoiceEditor
        target={target}
        fromOrder={target === "new" ? fromOrder : null}
        onBack={() => {
          setAdminParams({ invoice: null, from_order: null });
          refresh();
        }}
        onNavigate={(id, options) => setAdminParams({ invoice: id, from_order: null }, { replace: options?.replace })}
        onChanged={refresh}
      />
    );
  }

  const s = summary.data;
  const filtered = search !== "" || filter !== "all";

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          <>
            <AdminButton icon={<Settings2 aria-hidden className="size-3.5" />} onClick={() => setTemplateOpen(true)}>
              Template &amp; numbering
            </AdminButton>
            <AdminButton variant="primary" icon={<FilePlus2 aria-hidden className="size-3.5" />} onClick={() => open("new")}>
              New invoice
            </AdminButton>
          </>
        }
      />

      {(list.error ?? summary.error) && (
        <QueryError error={(list.error ?? summary.error)!} onRetry={refresh} feature="Invoices" className="mb-4" />
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          label="Outstanding"
          loading={summary.loading && !s}
          value={s ? formatRs(s.outstandingTotal) : "—"}
          hint={`Balance due on issued invoices${s ? ` — ${s.outstandingCount} invoice${s.outstandingCount === 1 ? "" : "s"}` : ""}.`}
        />
        <KpiTile
          label="Overdue"
          loading={summary.loading && !s}
          value={s ? formatRs(s.overdueTotal) : "—"}
          hint={`Balance due past the due date (Sri Lanka time)${s ? ` — ${s.overdueCount} invoice${s.overdueCount === 1 ? "" : "s"}` : ""}.`}
        />
        <KpiTile
          label="Received · 30 days"
          loading={summary.loading && !s}
          value={s ? formatRs(s.received30dTotal) : "—"}
          hint="Payments dated in the last 30 days, today included, on issued invoices."
        />
        <KpiTile
          label="Invoiced · 30 days"
          loading={summary.loading && !s}
          value={s ? formatRs(s.issued30dTotal) : "—"}
          hint={`Totals of invoices dated in the last 30 days${s ? ` — ${s.issued30dCount} issued, ${s.draftCount} draft${s.draftCount === 1 ? "" : "s"} open` : ""}.`}
        />
      </div>

      <SectionCard padded={false}>
        <div className="p-4 pb-0">
          <Toolbar
            search={{
              value: search,
              onChange: (value) => {
                setSearch(value);
                setPage(1);
              },
              placeholder: "Invoice no., client, phone, serial no., PO or order",
              label: "Search invoices",
            }}
            filters={
              <Select
                aria-label="Show"
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value as InvoiceListFilter);
                  setPage(1);
                }}
                options={INVOICE_LIST_FILTERS.map((f) => ({ value: f.value, label: f.label }))}
                className="w-48"
              />
            }
            actions={
              filtered ? (
                <AdminButton
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSearch("");
                    setFilter("all");
                    setPage(1);
                  }}
                >
                  Clear filters
                </AdminButton>
              ) : undefined
            }
          />
        </div>
        <DataTable
          caption="Invoices"
          rows={list.data?.rows ?? []}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.number ?? `draft ${row.id}`}
          loading={list.loading}
          failed={Boolean(list.error)}
          sort={sort}
          onSortChange={(next) => {
            setSort(next);
            setPage(1);
          }}
          onRowClick={(row) => open(row.id)}
          rowTone={(row) => {
            const meta = invoiceDisplayStatus(row, today);
            return meta.key === "overdue" ? "attention" : meta.key === "void" ? "muted" : null;
          }}
          columns={[
            {
              key: "number",
              header: "Invoice",
              sortable: true,
              cell: (row) => (
                <span className="flex flex-col">
                  <span className={`font-mono font-semibold ${row.number ? "text-adm-ink" : "text-adm-mute"}`}>{row.number ?? `Draft #${row.id}`}</span>
                  {row.orderId && <span className="font-mono text-[11px] text-adm-mute">{row.orderId}</span>}
                </span>
              ),
            },
            {
              key: "bill_to_name",
              header: "Client",
              sortable: true,
              cell: (row) => (
                <span className="flex min-w-[11rem] flex-col">
                  <span className="truncate font-semibold text-adm-ink">{row.billToName || <span className="font-normal text-adm-mute">No client yet</span>}</span>
                  <span className="truncate text-xs text-adm-mute">{[row.billToPhone, row.billToEmail].filter(Boolean).join(" · ")}</span>
                </span>
              ),
            },
            { key: "issue_date", header: "Date", sortable: true, hideBelow: "md", cell: (row) => <span className="whitespace-nowrap">{formatInvoiceDate(row.issueDate)}</span> },
            {
              key: "due_date",
              header: "Due",
              sortable: true,
              hideBelow: "lg",
              cell: (row) => (
                <span className="flex flex-col whitespace-nowrap">
                  <span>{row.dueDate ? formatInvoiceDate(row.dueDate) : <span className="text-adm-mute">—</span>}</span>
                  <span className="text-[11px] text-adm-mute">{dueHint(row.dueDate, row.balanceDue, row.status, today)}</span>
                </span>
              ),
            },
            { key: "total", header: "Total", sortable: true, align: "right", cell: (row) => <span className="font-mono tabular-nums">{formatRs(row.total)}</span> },
            {
              key: "balance_due",
              header: "Balance",
              sortable: true,
              align: "right",
              hideBelow: "sm",
              cell: (row) =>
                row.status === "issued" && row.balanceDue > 0 ? (
                  <span className="font-mono font-semibold tabular-nums">{formatRs(row.balanceDue)}</span>
                ) : (
                  <span className="text-adm-mute">—</span>
                ),
            },
            {
              key: "status",
              header: "Status",
              cell: (row) => {
                const meta = invoiceDisplayStatus(row, today);
                return (
                  <StatusBadge tone={meta.tone} dot>
                    {meta.label}
                  </StatusBadge>
                );
              },
            },
          ]}
          actions={[
            { label: "Open", onClick: (row) => open(row.id) },
            { label: "Print / PDF", disabled: (row) => busyId === row.id, onClick: (row) => void printRow(row) },
            { label: "Duplicate", disabled: (row) => busyId === row.id, onClick: (row) => void duplicateRow(row) },
            { label: "Delete draft", variant: "danger", hidden: (row) => row.number != null, onClick: setDeleting },
          ]}
          empty={{
            title: filtered ? "No invoices match" : "No invoices yet",
            description: filtered ? "Try another search or filter." : "Create your first invoice — scan a serial number or search products by name, and watch it build on the right.",
            action: filtered ? undefined : (
              <AdminButton variant="primary" icon={<FilePlus2 aria-hidden className="size-3.5" />} onClick={() => open("new")}>
                New invoice
              </AdminButton>
            ),
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="invoices" />
        </div>
      </SectionCard>

      {templateDrawer}

      <ConfirmDialog
        open={deleting != null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title={`Delete draft #${deleting?.id ?? ""}?`}
        description="It was never issued, so it has no number — deleting it leaves no gap."
        confirmLabel="Delete draft"
        onConfirm={async () => {
          if (!deleting) return { ok: false, message: "Nothing to delete." };
          const result = await adminRpc<{ deleted_id: number }>("admin_delete_invoice", { p_invoice_id: deleting.id }, INVOICE_WRITE);
          if (result.ok) {
            adminToast.success("Draft deleted");
            refresh();
          }
          return result;
        }}
      />
    </>
  );
}
