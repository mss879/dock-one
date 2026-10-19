"use client";

import { FilePlus2 } from "lucide-react";
import { useState } from "react";
import { useAdminAccess } from "@/components/admin/access";
import { InvoiceEditor } from "@/components/admin/invoices/InvoiceEditor";
import { INVOICE_LOGO_PATH, printInvoice } from "@/components/admin/invoices/invoice-document";
import { getAdminTab } from "@/components/admin/registry";
import { AdminButton, AdminPagination, DataTable, QueryError, SectionCard, Select, StatusBadge, TabHeader, Toolbar, type SortState } from "@/components/admin/ui";
import { todayYmd } from "@/lib/admin/dates";
import {
  DOCS_MIGRATION,
  FALLBACK_INVOICE_SETTINGS,
  fetchInvoice,
  fetchInvoicePage,
  fetchInvoiceSettings,
  formatInvoiceDate,
  formatRs,
  fromRpcResult,
  INVOICE_WRITE,
  type InvoiceListFilter,
  type InvoiceListRow,
  type InvoiceRpcResult,
  quotationDisplayStatus,
} from "@/lib/admin/invoices";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { useAdminQuery } from "@/lib/admin/query";
import { adminToast } from "@/lib/admin/toast";
import { setAdminParams, useAdminParam } from "@/lib/admin/url";
import { adminRpc } from "@/lib/admin/write";
import { getBrowserSupabase } from "@/lib/supabase/browser";

/**
 * Admin → Commerce → Quotations (40_sales_documents): every saved quotation — made in the admin or
 * requested on the website. `?tab=quotations&quotation=<id|new>` opens the same builder as
 * invoices (quotation template, terms and numbering). A valid quotation converts into a new draft
 * invoice; lines not in the inventory must first be matched by an admin.
 */

const FILTERS: { value: InvoiceListFilter; label: string }[] = [
  { value: "all", label: "All quotations" },
  { value: "issued", label: "Issued" },
  { value: "draft", label: "Drafts" },
  { value: "void", label: "Void" },
];

export default function QuotationsTab() {
  const tab = getAdminTab("quotations");
  const access = useAdminAccess();
  const canEdit = access.can("quotations", "edit");
  const param = useAdminParam("quotation");
  const target: number | "new" | null = param === "new" ? "new" : param && /^\d{1,9}$/.test(param) ? Number(param) : null;
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InvoiceListFilter>("all");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: "issue_date", direction: "desc" });
  const [busyId, setBusyId] = useState<number | null>(null);
  const today = todayYmd();
  const { from, to } = pageRange(page);

  const list = useAdminQuery(
    ({ supabase, signal }) => fetchInvoicePage(supabase, { search, filter, sort, from, to, today, signal, docType: "quotation" }),
    ["admin-quotations", search, filter, sort, from, to, today],
    { enabled: target === null, migration: DOCS_MIGRATION },
  );
  const settingsQuery = useAdminQuery(({ supabase, signal }) => fetchInvoiceSettings(supabase, signal), ["invoice-settings"], { migration: DOCS_MIGRATION });

  const open = (id: number | "new") => setAdminParams({ quotation: id });

  const printRow = async (row: InvoiceListRow) => {
    const supabase = getBrowserSupabase();
    if (!supabase || busyId) return;
    setBusyId(row.id);
    try {
      const loaded = await fetchInvoice(supabase, row.id, new AbortController().signal);
      if (!loaded) return adminToast.error("This quotation no longer exists");
      const ok = await printInvoice({
        form: loaded.form,
        settings: settingsQuery.data ?? FALLBACK_INVOICE_SETTINGS,
        bank: null,
        logoUrl: `${window.location.origin}${INVOICE_LOGO_PATH}`,
        paidOn: null,
      });
      if (!ok) adminToast.error("Couldn't open the print dialog");
    } finally {
      setBusyId(null);
    }
  };

  const convertRow = async (row: InvoiceListRow) => {
    if (busyId) return;
    setBusyId(row.id);
    const result = await adminRpc<InvoiceRpcResult>("admin_convert_quotation", { p_quote_id: row.id, p_matches: null }, { ...INVOICE_WRITE, migration: DOCS_MIGRATION });
    setBusyId(null);
    if (!result.ok) {
      // Lines not in the inventory: an admin matches them in the quotation itself.
      if (result.message.includes("not in the inventory") && access.isAdmin) {
        adminToast.info("Match the custom lines first", "Open the quotation and use “Convert to invoice” to pick inventory products for them.");
        open(row.id);
        return;
      }
      adminToast.error("Couldn't convert the quotation", result.message);
      return;
    }
    const id = fromRpcResult(result.data).form.id;
    adminToast.success(`${row.number ?? "The quotation"} converted`, "A draft invoice was made from it.");
    list.refetch();
    if (id != null) setAdminParams({ tab: "invoices", invoice: id }, { reset: true });
  };

  if (target !== null) {
    return (
      <InvoiceEditor
        target={target}
        fromOrder={null}
        newDocType="quotation"
        backLabel="Quotations"
        onBack={() => {
          setAdminParams({ quotation: null });
          list.refetch();
        }}
        onNavigate={(id, options) => setAdminParams({ quotation: id }, { replace: options?.replace })}
        onChanged={() => list.refetch()}
      />
    );
  }

  const filtered = search !== "" || filter !== "all";
  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          canEdit ? (
            <AdminButton variant="primary" icon={<FilePlus2 aria-hidden className="size-3.5" />} onClick={() => open("new")}>
              New quotation
            </AdminButton>
          ) : undefined
        }
      />
      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Quotations" className="mb-4" />}
      <SectionCard padded={false}>
        <div className="p-4 pb-0">
          <Toolbar
            search={{
              value: search,
              onChange: (value) => {
                setSearch(value);
                setPage(1);
              },
              placeholder: "Quotation no., client, phone or email",
              label: "Search quotations",
            }}
            filters={
              <div className="w-44">
                <Select
                  aria-label="Show"
                  value={filter}
                  onChange={(event) => {
                    setFilter(event.target.value as InvoiceListFilter);
                    setPage(1);
                  }}
                  options={FILTERS}
                />
              </div>
            }
          />
        </div>
        <DataTable<InvoiceListRow>
          caption="Quotations"
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
          rowTone={(row) => (row.status === "void" ? "muted" : null)}
          columns={[
            {
              key: "number",
              header: "Quotation",
              sortable: true,
              cell: (row) => (
                <span className="flex flex-col">
                  <span className={`font-mono font-semibold ${row.number ? "text-adm-ink" : "text-adm-mute"}`}>{row.number ?? `Draft #${row.id}`}</span>
                  {row.channel === "website" && <span className="font-mono text-[10px] tracking-[0.06em] text-adm-accent-ink uppercase">Website request</span>}
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
                  <span className="truncate text-xs text-adm-mute">{[row.billToCompany, row.billToPhone, row.billToEmail].filter(Boolean).join(" · ")}</span>
                </span>
              ),
            },
            { key: "issue_date", header: "Date", sortable: true, hideBelow: "md", cell: (row) => formatInvoiceDate(row.issueDate) },
            { key: "valid_until", header: "Valid until", hideBelow: "lg", cell: (row) => (row.validUntil ? formatInvoiceDate(row.validUntil) : <span className="text-adm-mute">—</span>) },
            { key: "total", header: "Total", sortable: true, align: "right", cell: (row) => <span className="font-mono tabular-nums">{formatRs(row.total)}</span> },
            {
              key: "status",
              header: "Status",
              cell: (row) => {
                const meta = quotationDisplayStatus(row, today);
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
            {
              label: "Convert to invoice",
              hidden: (row) => !access.can("invoices", "edit") || row.status === "void" || row.convertedInvoiceId != null || (row.validUntil != null && row.validUntil < today),
              disabled: (row) => busyId === row.id,
              onClick: (row) => void convertRow(row),
            },
            {
              label: "Open invoice",
              hidden: (row) => row.convertedInvoiceId == null,
              onClick: (row) => setAdminParams({ tab: "invoices", invoice: row.convertedInvoiceId }, { reset: true }),
            },
          ]}
          empty={{
            title: filtered ? "No quotations match" : "No quotations yet",
            description: filtered ? "Try another search or filter." : "Make one here, or customers request them on the website (product page or basket → “Request a quotation”).",
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="quotations" />
        </div>
      </SectionCard>
    </>
  );
}
