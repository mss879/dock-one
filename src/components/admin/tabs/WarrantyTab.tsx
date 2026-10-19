"use client";

import { useState } from "react";
import { useAdminAccess } from "@/components/admin/access";
import { getAdminTab } from "@/components/admin/registry";
import { AdminButton, AdminNotice, AdminPagination, DataTable, Drawer, Field, Input, QueryError, SectionCard, Select, StatusBadge, TabHeader, Textarea, Toolbar } from "@/components/admin/ui";
import { formatDateTime } from "@/lib/admin/dates";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { AdminDataError, unwrapRows, useAdminQuery } from "@/lib/admin/query";
import { toastResult } from "@/lib/admin/toast";
import { adminRpc } from "@/lib/admin/write";

/**
 * Admin → Catalogue → Warranty (41_suppliers_warranty): one record per serial-numbered unit, found
 * by product name or serial number. The SUPPLIER's warranty (who supplied it, the month it came
 * in, start, expiry, coverage) is kept apart from the warranty given to the CUSTOMER (start,
 * expiry, coverage — filled in automatically when the unit is sold, editable). "Valid" means the
 * expiry date is today or later. Supplier details show only to accounts allowed to see suppliers.
 */

const MIGRATION = "41_suppliers_warranty.sql";

type Unit = {
  unitId: number;
  serial: string;
  status: "in_stock" | "sold";
  soldAt: string | null;
  product: string;
  soldOn: string | null;
  customerName: string | null;
  supplierId: number | null;
  supplierName: string | null;
  supplierMonth: string | null;
  supplierStart: string | null;
  supplierExpiry: string | null;
  supplierCoverage: string | null;
  supplierValid: boolean | null;
  customerStart: string | null;
  customerExpiry: string | null;
  customerCoverage: string | null;
  customerAuto: boolean;
  customerValid: boolean | null;
  note: string | null;
};
type Result = { total: number; supplierHidden: boolean; rows: Unit[] };

const s = (v: unknown) => (typeof v === "string" && v ? v : null);
function fromRow(r: Record<string, unknown>): Unit {
  const brand = s(r.brand) ?? "";
  const name = s(r.product_name) ?? "";
  const product = `${name.toLowerCase().startsWith(brand.toLowerCase()) ? name : `${brand} ${name}`}${s(r.variant_name) ? ` — ${r.variant_name}` : ""}`;
  return {
    unitId: Number(r.unit_id),
    serial: s(r.serial_number) ?? "",
    status: r.status === "sold" ? "sold" : "in_stock",
    soldAt: s(r.sold_at),
    product,
    soldOn: s(r.sold_on),
    customerName: s(r.customer_name),
    supplierId: r.supplier_id == null ? null : Number(r.supplier_id),
    supplierName: s(r.supplier_name),
    supplierMonth: s(r.supplier_received_month),
    supplierStart: s(r.supplier_start),
    supplierExpiry: s(r.supplier_expiry),
    supplierCoverage: s(r.supplier_coverage),
    supplierValid: typeof r.supplier_valid === "boolean" ? r.supplier_valid : null,
    customerStart: s(r.customer_start),
    customerExpiry: s(r.customer_expiry),
    customerCoverage: s(r.customer_coverage),
    customerAuto: r.customer_auto === true,
    customerValid: typeof r.customer_valid === "boolean" ? r.customer_valid : null,
    note: s(r.note),
  };
}

const month = (ymd: string | null) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : "—");
const day = (ymd: string | null) => (ymd ? formatDateTime(`${ymd}T12:00:00+05:30`, "date") : "—");

function Validity({ expiry, valid }: { expiry: string | null; valid: boolean | null }) {
  if (!expiry) return <span className="text-adm-mute">Not recorded</span>;
  return (
    <span className="flex flex-col">
      <StatusBadge tone={valid ? "success" : "danger"} dot>
        {valid ? "Valid" : "Expired"}
      </StatusBadge>
      <span className="mt-0.5 text-[11px] text-adm-mute">until {day(expiry)}</span>
    </span>
  );
}

type Form = Record<"supplierId" | "supplierMonth" | "supplierStart" | "supplierExpiry" | "supplierCoverage" | "customerStart" | "customerExpiry" | "customerCoverage" | "note", string>;

export default function WarrantyTab() {
  const tab = getAdminTab("warranty");
  const access = useAdminAccess();
  const canEdit = access.can("warranty", "edit");
  const canSuppliers = access.can("suppliers", "edit");
  const [term, setTerm] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Unit | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saving, setSaving] = useState(false);
  const { from } = pageRange(page);

  const list = useAdminQuery(
    async ({ supabase, signal }): Promise<Result> => {
      const { data, error } = await supabase.rpc("admin_warranty_search", { p_term: term || null, p_status: status, p_limit: ADMIN_PAGE_SIZE, p_offset: from }).abortSignal(signal);
      if (error) throw new AdminDataError(error, MIGRATION);
      const o = (data ?? {}) as Record<string, unknown>;
      return { total: Number(o.total ?? 0), supplierHidden: o.supplier_hidden === true, rows: (Array.isArray(o.rows) ? (o.rows as Record<string, unknown>[]) : []).map(fromRow) };
    },
    ["admin-warranty", term, status, from],
    { migration: MIGRATION },
  );
  const suppliers = useAdminQuery(
    async ({ supabase, signal }) => unwrapRows<{ id: number; name: string }>(await supabase.from("suppliers").select("id, name").order("name").abortSignal(signal), MIGRATION),
    ["warranty-suppliers"],
    { enabled: canSuppliers, migration: MIGRATION },
  );
  const hidden = list.data?.supplierHidden ?? !access.can("suppliers");

  const open = (u: Unit) => {
    setEditing(u);
    setForm({
      supplierId: u.supplierId ? String(u.supplierId) : "",
      supplierMonth: u.supplierMonth?.slice(0, 7) ?? "",
      supplierStart: u.supplierStart?.slice(0, 7) ?? "",
      supplierExpiry: u.supplierExpiry ?? "",
      supplierCoverage: u.supplierCoverage ?? "",
      customerStart: u.customerStart ?? "",
      customerExpiry: u.customerExpiry ?? "",
      customerCoverage: u.customerCoverage ?? "",
      note: u.note ?? "",
    });
  };
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const save = async () => {
    if (!editing || !form || saving) return;
    const data: Record<string, unknown> = {};
    if (canSuppliers) {
      data.supplier_id = form.supplierId ? Number(form.supplierId) : null;
      data.supplier_received_month = form.supplierMonth || null;
      data.supplier_start = form.supplierStart || null;
      data.supplier_expiry = form.supplierExpiry || null;
      data.supplier_coverage = form.supplierCoverage.trim() || null;
    }
    if (canEdit) {
      const changed = form.customerStart !== (editing.customerStart ?? "") || form.customerExpiry !== (editing.customerExpiry ?? "") || form.customerCoverage !== (editing.customerCoverage ?? "");
      if (changed) {
        data.customer_start = form.customerStart || null;
        data.customer_expiry = form.customerExpiry || null;
        data.customer_coverage = form.customerCoverage.trim() || null;
      }
      data.note = form.note.trim() || null;
    }
    setSaving(true);
    const result = await adminRpc("admin_save_warranty", { p_unit_ids: [editing.unitId], p_data: data }, { migration: MIGRATION });
    setSaving(false);
    if (!toastResult(result, { success: `Warranty saved — S/N ${editing.serial}`, failure: "Couldn't save the warranty" })) return;
    setEditing(null);
    list.refetch();
  };

  return (
    <>
      <TabHeader eyebrow={tab.group} title={tab.label} description={tab.summary} />
      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Warranty records" className="mb-4" />}
      <SectionCard padded={false}>
        <div className="p-4 pb-0">
          <Toolbar
            search={{
              value: term,
              onChange: (v) => {
                setTerm(v);
                setPage(1);
              },
              placeholder: "Serial number or product name",
              label: "Search units",
            }}
            filters={
              <div className="w-56">
                <Select
                  aria-label="Show"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setPage(1);
                  }}
                  options={[
                    { value: "all", label: "All units" },
                    { value: "in_stock", label: "In stock" },
                    { value: "sold", label: "Sold" },
                    { value: "customer_valid", label: "Customer warranty valid" },
                    { value: "customer_expired", label: "Customer warranty expired" },
                    ...(hidden
                      ? []
                      : [
                          { value: "supplier_valid", label: "Supplier warranty valid" },
                          { value: "supplier_expired", label: "Supplier warranty expired" },
                        ]),
                  ]}
                />
              </div>
            }
          />
          <p className="-mt-1 mb-3 text-xs leading-5 text-adm-mute">
            Units come from the serial numbers recorded in Products. The customer warranty starts automatically on the sale date for the product&apos;s warranty months; change it here when the terms differ.
          </p>
        </div>
        <DataTable<Unit>
          caption="Units and their warranties"
          rows={list.data?.rows ?? []}
          rowKey={(u) => u.unitId}
          rowLabel={(u) => u.serial}
          loading={list.loading}
          failed={Boolean(list.error)}
          onRowClick={open}
          columns={[
            {
              key: "unit",
              header: "Product · S/N",
              cell: (u) => (
                <span className="flex min-w-[12rem] flex-col">
                  <span className="font-semibold text-adm-ink">{u.product}</span>
                  <span className="font-mono text-[11px] text-adm-mute">S/N {u.serial}</span>
                </span>
              ),
            },
            {
              key: "sold",
              header: "Sold",
              hideBelow: "md",
              cell: (u) =>
                u.status === "sold" ? (
                  <span className="flex flex-col text-[13px]">
                    <span>{u.customerName ?? "—"}</span>
                    <span className="font-mono text-[11px] text-adm-mute">
                      {u.soldOn ?? ""} {u.soldAt ? `· ${formatDateTime(u.soldAt, "date")}` : ""}
                    </span>
                  </span>
                ) : (
                  <StatusBadge tone="neutral">In stock</StatusBadge>
                ),
            },
            ...(hidden
              ? []
              : [
                  {
                    key: "supplier",
                    header: "Supplier warranty",
                    cell: (u: Unit) => (
                      <span className="flex flex-col gap-0.5">
                        <span className="text-[12px] text-adm-ink-2">{u.supplierName ?? "—"}</span>
                        <Validity expiry={u.supplierExpiry} valid={u.supplierValid} />
                      </span>
                    ),
                  },
                ]),
            { key: "customer", header: "Customer warranty", cell: (u) => <Validity expiry={u.customerExpiry} valid={u.customerValid} /> },
          ]}
          empty={{ title: term ? "No units match" : "No serial-numbered units yet", description: "Record serial numbers per unit in Catalogue → Products." }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="units" />
        </div>
      </SectionCard>

      <Drawer
        open={editing != null}
        onClose={() => setEditing(null)}
        title={editing ? `S/N ${editing.serial}` : "Warranty"}
        description={editing?.product}
        footer={
          canEdit || canSuppliers ? (
            <>
              <AdminButton onClick={() => setEditing(null)} disabled={saving}>
                Cancel
              </AdminButton>
              <AdminButton variant="primary" loading={saving} onClick={() => void save()}>
                Save warranty
              </AdminButton>
            </>
          ) : undefined
        }
      >
        {editing && form && (
          <div className="grid gap-6">
            {!hidden && (
              <section className="grid gap-4">
                <h3 className="font-mono text-[11px] font-semibold tracking-[0.08em] text-adm-mute uppercase">Supplier warranty</h3>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Supplier" className="sm:col-span-2">
                    <Select
                      value={form.supplierId}
                      disabled={!canSuppliers}
                      onChange={(e) => set({ supplierId: e.target.value })}
                      options={[{ value: "", label: "Not recorded" }, ...(suppliers.data ?? []).map((x) => ({ value: String(x.id), label: x.name }))]}
                    />
                  </Field>
                  <Field label="Month received">
                    <Input type="month" value={form.supplierMonth} disabled={!canSuppliers} onChange={(e) => set({ supplierMonth: e.target.value })} />
                  </Field>
                  <Field label="Starts (month)">
                    <Input type="month" value={form.supplierStart} disabled={!canSuppliers} onChange={(e) => set({ supplierStart: e.target.value })} />
                  </Field>
                  <Field label="Expires on">
                    <Input type="date" value={form.supplierExpiry} disabled={!canSuppliers} onChange={(e) => set({ supplierExpiry: e.target.value })} />
                  </Field>
                  <Field label="Coverage" className="sm:col-span-2" hint="What the supplier covers (parts, labour, agent warranty…).">
                    <Textarea rows={2} value={form.supplierCoverage} maxLength={500} disabled={!canSuppliers} onChange={(e) => set({ supplierCoverage: e.target.value })} />
                  </Field>
                </div>
                {editing.supplierExpiry && (
                  <AdminNotice tone={editing.supplierValid ? "success" : "error"}>
                    The supplier warranty {editing.supplierValid ? "is valid" : "has expired"} — {month(editing.supplierStart)} to {day(editing.supplierExpiry)}.
                  </AdminNotice>
                )}
              </section>
            )}
            <section className="grid gap-4">
              <h3 className="font-mono text-[11px] font-semibold tracking-[0.08em] text-adm-mute uppercase">Customer warranty</h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Starts" hint={editing.customerAuto ? "Filled in from the sale." : undefined}>
                  <Input type="date" value={form.customerStart} disabled={!canEdit} onChange={(e) => set({ customerStart: e.target.value })} />
                </Field>
                <Field label="Expires on">
                  <Input type="date" value={form.customerExpiry} disabled={!canEdit} onChange={(e) => set({ customerExpiry: e.target.value })} />
                </Field>
                <Field label="Coverage" className="sm:col-span-2" hint="What the store gives the customer.">
                  <Textarea rows={2} value={form.customerCoverage} maxLength={500} disabled={!canEdit} onChange={(e) => set({ customerCoverage: e.target.value })} />
                </Field>
                <Field label="Note" optional className="sm:col-span-2">
                  <Textarea rows={2} value={form.note} maxLength={1000} disabled={!canEdit} onChange={(e) => set({ note: e.target.value })} />
                </Field>
              </div>
              {editing.customerExpiry && (
                <AdminNotice tone={editing.customerValid ? "success" : "error"}>
                  The customer warranty {editing.customerValid ? "is valid" : "has expired"} — {day(editing.customerStart)} to {day(editing.customerExpiry)}.
                </AdminNotice>
              )}
            </section>
          </div>
        )}
      </Drawer>
    </>
  );
}
