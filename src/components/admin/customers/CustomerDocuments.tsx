"use client";

import { ArrowUpRight } from "lucide-react";
import { useAdminAccess } from "@/components/admin/access";
import { DataTable, KpiTile, Money, QueryError, SectionCard, StatusBadge } from "@/components/admin/ui";
import { formatInvoiceDate, invoiceDisplayStatus, quotationDisplayStatus } from "@/lib/admin/invoices";
import { unwrapRows, useAdminQuery } from "@/lib/admin/query";
import { setAdminParams } from "@/lib/admin/url";

/**
 * A customer's invoices and quotations (26/40) in their dossier, next to their web orders — matched
 * by the customer account or the bill-to email. Shop sales, website invoices and quotations in one
 * list, with what is still owed. Shown to accounts that can open Invoices or Quotations.
 */

const LIMIT = 50;

type DocRow = {
  id: number;
  number: string | null;
  doc_type: string;
  channel: string | null;
  status: "draft" | "issued" | "void";
  issue_date: string;
  due_date: string | null;
  valid_until: string | null;
  converted_invoice_id: number | null;
  total: number;
  amount_paid: number;
  balance_due: number;
};

const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const quoted = (value: string) => `"${value.replace(/["\\]/g, "\\$&")}"`;

export function CustomerDocuments({ customerId, email, name }: { customerId: string; email: string; name: string }) {
  const access = useAdminAccess();
  const canInvoices = access.can("invoices");
  const canQuotes = access.can("quotations");
  const types = [...(canInvoices ? ["invoice"] : []), ...(canQuotes ? ["quotation"] : [])];
  const address = email.trim().toLowerCase();
  const filter = [`customer_id.eq.${customerId}`, ...(address ? [`bill_to_email.ilike.${quoted(address)}`] : [])].join(",");

  const docs = useAdminQuery(
    async ({ supabase, signal }) =>
      unwrapRows<Record<string, unknown>>(
        await supabase
          .from("invoices")
          .select("id, number, doc_type, channel, status, issue_date, due_date, valid_until, converted_invoice_id, total, amount_paid, balance_due")
          .or(filter)
          .in("doc_type", types)
          .order("issue_date", { ascending: false })
          .order("id", { ascending: false })
          .limit(LIMIT)
          .abortSignal(signal),
        "26_invoices.sql",
      ).map(
        (r): DocRow => ({
          id: n(r.id),
          number: typeof r.number === "string" ? r.number : null,
          doc_type: String(r.doc_type ?? "invoice"),
          channel: typeof r.channel === "string" ? r.channel : null,
          status: r.status === "issued" || r.status === "void" ? r.status : "draft",
          issue_date: String(r.issue_date ?? ""),
          due_date: typeof r.due_date === "string" ? r.due_date : null,
          valid_until: typeof r.valid_until === "string" ? r.valid_until : null,
          converted_invoice_id: r.converted_invoice_id == null ? null : n(r.converted_invoice_id),
          total: n(r.total),
          amount_paid: n(r.amount_paid),
          balance_due: n(r.balance_due),
        }),
      ),
    ["customer-documents", customerId, address, types.join(",")],
    { enabled: types.length > 0 },
  );

  if (types.length === 0) return null;
  const rows = docs.data ?? [];
  const invoiced = rows.filter((r) => r.doc_type === "invoice" && r.status === "issued");
  const sold = invoiced.reduce((sum, r) => sum + r.total, 0);
  const owed = invoiced.reduce((sum, r) => sum + r.balance_due, 0);

  return (
    <SectionCard title="Invoices & quotations" description={`Shop and website invoices, and quotations, for ${name} (by account or email).`} padded={false}>
      {canInvoices && (
        <div className="grid gap-3 p-4 pb-0 sm:grid-cols-2">
          <KpiTile label="Invoiced" value={docs.data ? <Money amount={sold} /> : ""} hint="Issued invoices — shop and website." />
          <KpiTile label="Still owed" value={docs.data ? <Money amount={owed} /> : ""} hint="Balance on issued invoices (credit and part payments)." />
        </div>
      )}
      {docs.error && <QueryError error={docs.error} onRetry={docs.refetch} feature="Invoices" className="m-4" />}
      <DataTable
        caption={`Invoices and quotations of ${name}`}
        rows={rows}
        rowKey={(r) => String(r.id)}
        rowLabel={(r) => r.number ?? `Draft #${r.id}`}
        loading={docs.loading}
        failed={Boolean(docs.error)}
        skeletonRows={2}
        columns={[
          {
            key: "number",
            header: "Document",
            cell: (r) => (
              <span className="flex flex-col">
                <span className="font-mono font-semibold">{r.number ?? `Draft #${r.id}`}</span>
                <span className="text-[11px] text-adm-mute">{r.doc_type === "quotation" ? "Quotation" : r.channel === "website" ? "Website sale" : "Shop sale"}</span>
              </span>
            ),
          },
          { key: "issue_date", header: "Date", hideBelow: "sm", cell: (r) => formatInvoiceDate(r.issue_date) },
          {
            key: "status",
            header: "Status",
            cell: (r) => {
              const meta =
                r.doc_type === "quotation"
                  ? quotationDisplayStatus({ status: r.status, convertedInvoiceId: r.converted_invoice_id, validUntil: r.valid_until })
                  : invoiceDisplayStatus({ status: r.status, balanceDue: r.balance_due, amountPaid: r.amount_paid, dueDate: r.due_date });
              return (
                <StatusBadge tone={meta.tone} dot>
                  {meta.label}
                </StatusBadge>
              );
            },
          },
          { key: "total", header: "Total", align: "right", cell: (r) => <Money amount={r.total} /> },
        ]}
        actions={[
          {
            label: "Open",
            icon: <ArrowUpRight aria-hidden className="size-3.5" />,
            onClick: (r) =>
              r.doc_type === "quotation"
                ? setAdminParams({ tab: "quotations", quotation: String(r.id) }, { reset: true })
                : setAdminParams({ tab: "invoices", invoice: String(r.id) }, { reset: true }),
          },
        ]}
        empty={{ title: "No invoices or quotations", description: "Invoices and quotations made out to this customer (or their email) appear here." }}
      />
    </SectionCard>
  );
}
