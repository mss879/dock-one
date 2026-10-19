"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { useAdminAccess } from "@/components/admin/access";
import { getAdminTab } from "@/components/admin/registry";
import { AdminButton, DataTable, Drawer, Field, Input, Modal, QueryError, SectionCard, StatusBadge, TabHeader, Textarea, Toggle, Toolbar } from "@/components/admin/ui";
import { formatDateTime } from "@/lib/admin/dates";
import { AdminDataError, unwrapRows, useAdminQuery } from "@/lib/admin/query";
import { toastResult } from "@/lib/admin/toast";
import { insertRow, updateRows } from "@/lib/admin/write";

/**
 * Admin → Catalogue → Suppliers (41_suppliers_warranty): who the store buys from, and what came in
 * from each supplier by month (recorded with Inventory → Record movement → Stock received).
 * Visible only to the owner and staff with "Suppliers". Switch a supplier off instead of deleting.
 */

const MIGRATION = "41_suppliers_warranty.sql";

type Supplier = {
  id: number;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  isActive: boolean;
};
type Delivery = { month: string | null; product: string; quantity: number; references: string | null; lastAt: string | null };

const str = (v: unknown) => (typeof v === "string" ? v : "");
function fromRow(r: Record<string, unknown>): Supplier {
  return {
    id: Number(r.id),
    name: str(r.name),
    contactPerson: str(r.contact_person),
    phone: str(r.phone),
    email: str(r.email),
    address: str(r.address),
    notes: str(r.notes),
    isActive: r.is_active !== false,
  };
}
const blank = (): Supplier => ({ id: 0, name: "", contactPerson: "", phone: "", email: "", address: "", notes: "", isActive: true });
const orNull = (v: string) => (v.trim() ? v.trim() : null);
const monthLabel = (ymd: string | null) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" }) : "—");

export default function SuppliersTab() {
  const tab = getAdminTab("suppliers");
  const access = useAdminAccess();
  const canEdit = access.can("suppliers", "edit");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewing, setViewing] = useState<Supplier | null>(null);

  const list = useAdminQuery(
    async ({ supabase, signal }) => unwrapRows<Record<string, unknown>>(await supabase.from("suppliers").select("*").order("is_active", { ascending: false }).order("name").abortSignal(signal), MIGRATION).map(fromRow),
    ["admin-suppliers"],
    { migration: MIGRATION },
  );
  const deliveries = useAdminQuery(
    async ({ supabase, signal }) => {
      const { data, error } = await supabase.rpc("admin_supplier_deliveries", { p_supplier_id: viewing?.id }).abortSignal(signal);
      if (error) throw new AdminDataError(error, MIGRATION);
      return (Array.isArray(data) ? (data as Record<string, unknown>[]) : []).map(
        (d): Delivery => ({ month: typeof d.month === "string" ? d.month : null, product: str(d.product), quantity: Number(d.quantity ?? 0), references: typeof d.references === "string" ? d.references : null, lastAt: typeof d.last_at === "string" ? d.last_at : null }),
      );
    },
    ["supplier-deliveries", viewing?.id],
    { enabled: viewing != null, migration: MIGRATION },
  );

  const save = async () => {
    if (!editing || saving) return;
    if (!editing.name.trim()) return;
    setSaving(true);
    const values = {
      name: editing.name.trim(),
      contact_person: orNull(editing.contactPerson),
      phone: orNull(editing.phone),
      email: orNull(editing.email)?.toLowerCase() ?? null,
      address: orNull(editing.address),
      notes: orNull(editing.notes),
      is_active: editing.isActive,
    };
    const result = editing.id
      ? await updateRows("suppliers", values, { id: editing.id }, { migration: MIGRATION, entity: "supplier", expect: 1 })
      : await insertRow("suppliers", values, { migration: MIGRATION, entity: "supplier" });
    setSaving(false);
    if (!toastResult(result, { success: editing.id ? "Supplier saved" : "Supplier added", failure: "Couldn't save the supplier" })) return;
    setEditing(null);
    list.refetch();
  };

  const rows = (list.data ?? []).filter((s) => !search.trim() || `${s.name} ${s.contactPerson} ${s.phone} ${s.email}`.toLowerCase().includes(search.trim().toLowerCase()));
  const set = (patch: Partial<Supplier>) => setEditing((e) => (e ? { ...e, ...patch } : e));

  return (
    <>
      <TabHeader
        eyebrow={tab.group}
        title={tab.label}
        description={tab.summary}
        actions={
          canEdit ? (
            <AdminButton variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={() => setEditing(blank())}>
              Add supplier
            </AdminButton>
          ) : undefined
        }
      />
      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Suppliers" className="mb-4" />}
      <SectionCard padded={false}>
        <div className="p-4 pb-0">
          <Toolbar search={{ value: search, onChange: setSearch, placeholder: "Name, contact, phone or email", label: "Search suppliers" }} />
        </div>
        <DataTable<Supplier>
          caption="Suppliers"
          rows={rows}
          rowKey={(s) => s.id}
          rowLabel={(s) => s.name}
          loading={list.loading}
          failed={Boolean(list.error)}
          onRowClick={setViewing}
          rowTone={(s) => (s.isActive ? null : "muted")}
          columns={[
            { key: "name", header: "Supplier", cell: (s) => <span className="font-semibold text-adm-ink">{s.name}</span> },
            { key: "contact", header: "Contact", cell: (s) => [s.contactPerson, s.phone].filter(Boolean).join(" · ") || <span className="text-adm-mute">—</span> },
            { key: "email", header: "Email", hideBelow: "md", cell: (s) => s.email || <span className="text-adm-mute">—</span> },
            { key: "active", header: "Status", cell: (s) => (s.isActive ? <StatusBadge tone="success">Active</StatusBadge> : <StatusBadge tone="neutral">Switched off</StatusBadge>) },
          ]}
          actions={[
            { label: "Deliveries", onClick: setViewing },
            { label: "Edit", hidden: () => !canEdit, onClick: (s) => setEditing({ ...s }) },
          ]}
          empty={{ title: "No suppliers yet", description: "Add the distributors and agents you buy from." }}
        />
      </SectionCard>

      <Modal
        open={editing != null}
        onClose={() => setEditing(null)}
        busy={saving}
        size="lg"
        onSubmit={() => void save()}
        title={editing?.id ? `Edit ${editing.name}` : "Add a supplier"}
        footer={
          <>
            <AdminButton onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </AdminButton>
            <AdminButton type="submit" variant="primary" loading={saving} disabled={!editing?.name.trim()}>
              Save supplier
            </AdminButton>
          </>
        }
      >
        {editing && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required className="sm:col-span-2">
              <Input value={editing.name} maxLength={160} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Contact person" optional>
              <Input value={editing.contactPerson} maxLength={120} onChange={(e) => set({ contactPerson: e.target.value })} />
            </Field>
            <Field label="Phone" optional>
              <Input type="tel" value={editing.phone} maxLength={60} onChange={(e) => set({ phone: e.target.value })} />
            </Field>
            <Field label="Email" optional className="sm:col-span-2">
              <Input type="email" value={editing.email} maxLength={254} onChange={(e) => set({ email: e.target.value })} />
            </Field>
            <Field label="Address" optional className="sm:col-span-2">
              <Textarea rows={2} value={editing.address} maxLength={500} onChange={(e) => set({ address: e.target.value })} />
            </Field>
            <Field label="Notes" optional className="sm:col-span-2" hint="Terms, warranty arrangements, account numbers…">
              <Textarea rows={3} value={editing.notes} maxLength={2000} onChange={(e) => set({ notes: e.target.value })} />
            </Field>
            {editing.id > 0 && <Toggle label="Active" description="Switched-off suppliers stay on old records." checked={editing.isActive} onChange={(isActive) => set({ isActive })} />}
          </div>
        )}
      </Modal>

      <Drawer open={viewing != null} onClose={() => setViewing(null)} title={viewing?.name ?? "Supplier"} description="What came in from this supplier, by month.">
        {viewing && (
          <div className="grid gap-4">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[13px]">
              {[
                ["Contact", viewing.contactPerson],
                ["Phone", viewing.phone],
                ["Email", viewing.email],
                ["Address", viewing.address],
                ["Notes", viewing.notes],
              ]
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-adm-mute">{k}</dt>
                    <dd className="whitespace-pre-wrap text-adm-ink">{v}</dd>
                  </div>
                ))}
            </dl>
            {deliveries.error && <QueryError error={deliveries.error} onRetry={deliveries.refetch} feature="Deliveries" />}
            <DataTable<Delivery>
              caption="Deliveries"
              rows={deliveries.data ?? []}
              rowKey={(d) => `${d.month}-${d.product}`}
              loading={deliveries.loading}
              failed={Boolean(deliveries.error)}
              columns={[
                { key: "month", header: "Month received", cell: (d) => monthLabel(d.month) },
                { key: "product", header: "Product", cell: (d) => d.product },
                { key: "qty", header: "Qty", align: "right", cell: (d) => <span className="font-mono tabular-nums">{d.quantity}</span> },
                { key: "ref", header: "Reference", hideBelow: "md", cell: (d) => d.references ?? <span className="text-adm-mute">—</span> },
                { key: "at", header: "Recorded", hideBelow: "lg", cell: (d) => (d.lastAt ? formatDateTime(d.lastAt, "date") : "—") },
              ]}
              empty={{ title: "Nothing recorded yet", description: "Record deliveries in Inventory → Record movement → Stock received, choosing this supplier." }}
            />
          </div>
        )}
      </Drawer>
    </>
  );
}
