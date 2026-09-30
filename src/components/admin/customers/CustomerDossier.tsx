"use client";

import { ArrowUpRight, Save } from "lucide-react";
import { useState } from "react";
import { ownOrdersFilter } from "@/components/account/dashboard/orders";
import {
  AdminButton,
  AdminNotice,
  AdminPagination,
  DataTable,
  DateTime,
  Drawer,
  Field,
  KpiTile,
  Money,
  QueryError,
  SectionCard,
  Skeleton,
  StatusBadge,
  Textarea,
} from "@/components/admin/ui";
import { pageRange } from "@/lib/admin/pagination";
import { AdminDataError, unwrapPage, unwrapRow, useAdminQuery } from "@/lib/admin/query";
import { toastResult } from "@/lib/admin/toast";
import { setAdminParams } from "@/lib/admin/url";
import { updateRows } from "@/lib/admin/write";
import { orderStatusLabel, orderStatusTone, paymentStatusLabel, paymentStatusTone } from "@/lib/orders";
import { formatLkPhone } from "@/lib/sri-lanka";
import { CUSTOMERS_MIGRATION, customerName, isCustomerId, ORDERS_MIGRATION, type CustomerOrderRow, type CustomerRow } from "./types";

/**
 * Customer dossier (blueprint §11.2 "Customers"): orders matched by customer_id OR email,
 * lifetime value (non-cancelled orders), saved address, and the admin note — the only write,
 * direct under admin RLS with the kit's error + row-count check. The admin flag is shown
 * read-only: it is granted only in the SQL editor (blueprint §6.2).
 */

const NOTE_MAX = 5000; // customers_field_lengths
const LTV_ROW_CAP = 1000; // PostgREST max-rows: one customer never gets near it; if they do, say so
const ORDERS_PAGE = 10;

const WRITE = {
  entity: "customer",
  migration: CUSTOMERS_MIGRATION,
  constraints: { customers_field_lengths: `Notes can be up to ${NOTE_MAX.toLocaleString("en-GB")} characters.` },
};

type Lifetime = { value: number; orders: number; complete: boolean };

function AddressLines({ row }: { row: CustomerRow }) {
  const lines = [row.street, row.city, [row.district, row.postal_code].filter(Boolean).join(" "), row.country]
    .map((line) => (typeof line === "string" ? line.trim() : ""))
    .filter(Boolean);
  if (!row.street && !row.city && !row.district) return <p className="text-adm-mute">No address saved.</p>;
  return (
    <address className="not-italic leading-6">
      {lines.map((line, i) => (
        <span key={i} className="block">
          {line}
        </span>
      ))}
    </address>
  );
}

export function CustomerDossier({ customerId, onClose, onSaved }: { customerId: string | null; onClose: () => void; onSaved: (row: CustomerRow) => void }) {
  const open = customerId !== null;
  const validId = isCustomerId(customerId);

  const customer = useAdminQuery(
    async ({ supabase, signal }) => unwrapRow<CustomerRow>(await supabase.from("customers").select("*").eq("id", customerId).abortSignal(signal).maybeSingle(), CUSTOMERS_MIGRATION),
    [customerId],
    { enabled: open && validId, migration: CUSTOMERS_MIGRATION },
  );
  const row = customer.data && customer.data.id === customerId ? customer.data : null;
  const filter = row ? ownOrdersFilter(row.id, row.email) : "";

  const [ordersPage, setOrdersPage] = useState(1);
  const [pageFor, setPageFor] = useState<string | null>(customerId);
  if (pageFor !== customerId) {
    setPageFor(customerId);
    setOrdersPage(1);
  }
  const { from, to } = pageRange(ordersPage, ORDERS_PAGE);

  const orders = useAdminQuery(
    async ({ supabase, signal }) =>
      unwrapPage<CustomerOrderRow>(
        await supabase.from("orders").select("*", { count: "exact" }).or(filter).order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to).abortSignal(signal),
        ORDERS_MIGRATION,
      ),
    [filter, from, to],
    { enabled: open && filter !== "", migration: ORDERS_MIGRATION },
  );

  // Lifetime value = Σ total_price of NON-cancelled orders placed by this account or with its email.
  const lifetime = useAdminQuery(
    async ({ supabase, signal }): Promise<Lifetime> => {
      const response = await supabase
        .from("orders")
        .select("total_price, status", { count: "exact" })
        .or(filter)
        .range(0, LTV_ROW_CAP - 1)
        .abortSignal(signal);
      if (response.error) throw new AdminDataError(response.error, ORDERS_MIGRATION);
      const rows = Array.isArray(response.data) ? (response.data as { total_price: number | string | null; status: string }[]) : [];
      const counted = rows.filter((r) => r.status !== "cancelled");
      return {
        value: counted.reduce((sum, r) => sum + (Number(r.total_price) || 0), 0),
        orders: counted.length,
        complete: typeof response.count !== "number" || response.count <= rows.length,
      };
    },
    [filter],
    { enabled: open && filter !== "", migration: ORDERS_MIGRATION },
  );

  const [noteDraft, setNoteDraft] = useState<string | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (row && noteFor !== row.id) {
    setNoteFor(row.id);
    setNoteDraft(row.note ?? "");
  }
  const note = noteDraft ?? "";
  const noteChanged = row !== null && note.trim() !== (row.note ?? "").trim();

  const saveNote = async () => {
    if (!row || saving) return;
    setSaving(true);
    const res = await updateRows<CustomerRow>("customers", { note: note.trim() ? note.trim() : null }, { id: row.id }, { ...WRITE, expect: 1 });
    setSaving(false);
    if (!toastResult(res, { success: "Note saved", failure: "Couldn't save the note" })) return;
    const saved = res.data[0];
    customer.mutate(() => saved);
    setNoteDraft(saved.note ?? "");
    onSaved(saved);
  };

  const name = row ? customerName(row) : "";
  const title = row ? name || row.email : "Customer";

  return (
    <Drawer
      open={open}
      onClose={onClose}
      busy={saving}
      width="lg"
      title={title}
      description={row ? (name ? row.email : undefined) : undefined}
    >
      {!validId && open && <AdminNotice tone="error" title="Unknown customer">That link doesn&apos;t point to a customer.</AdminNotice>}
      {customer.error && <QueryError error={customer.error} onRetry={customer.refetch} feature="Customer" className="mb-4" />}
      {validId && customer.loading && !row && (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      )}
      {validId && !customer.loading && !customer.error && customer.data === null && (
        <AdminNotice tone="error" title="Customer not found">
          This account may have been deleted.
        </AdminNotice>
      )}

      {row && (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <KpiTile
              label="Lifetime value"
              loading={lifetime.loading && !lifetime.data}
              value={lifetime.data ? lifetime.data.complete ? <Money amount={lifetime.data.value} /> : "—" : lifetime.error ? "—" : ""}
              hint="Sum of the totals of this customer's non-cancelled orders, placed from the account or with its email address."
            />
            <KpiTile
              label="Orders"
              loading={lifetime.loading && !lifetime.data}
              value={lifetime.data ? (lifetime.data.complete ? lifetime.data.orders.toLocaleString("en-GB") : "—") : lifetime.error ? "—" : ""}
              hint="Non-cancelled orders, placed from the account or with its email address."
            />
          </div>
          {lifetime.data && !lifetime.data.complete && (
            <AdminNotice tone="info">This customer has more than {LTV_ROW_CAP.toLocaleString("en-GB")} orders — use Reports for the full total.</AdminNotice>
          )}
          {lifetime.error && <QueryError error={lifetime.error} onRetry={lifetime.refetch} feature="Lifetime value" />}

          <SectionCard title="Contact">
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[140px_1fr]">
              <dt className="font-mono text-[11px] tracking-[0.06em] text-adm-mute uppercase">Email</dt>
              <dd className="break-all">{row.email}</dd>
              <dt className="font-mono text-[11px] tracking-[0.06em] text-adm-mute uppercase">Phone</dt>
              <dd>{row.phone ? formatLkPhone(row.phone) : <span className="text-adm-mute">—</span>}</dd>
              <dt className="font-mono text-[11px] tracking-[0.06em] text-adm-mute uppercase">Joined</dt>
              <dd>
                <DateTime value={row.created_at} mode="date" />
              </dd>
              <dt className="font-mono text-[11px] tracking-[0.06em] text-adm-mute uppercase">Admin access</dt>
              <dd>
                {row.is_admin ? (
                  <StatusBadge tone="accent" dot>
                    Admin
                  </StatusBadge>
                ) : (
                  <StatusBadge>Customer</StatusBadge>
                )}
                <p className="mt-1.5 text-[12.5px] text-adm-mute">Granted or removed only in the Supabase SQL editor (see 02_customers_and_auth.sql).</p>
              </dd>
            </dl>
          </SectionCard>

          <SectionCard title="Saved address" description="The default the checkout fills in.">
            <AddressLines row={row} />
          </SectionCard>

          <SectionCard
            title="Admin note"
            description="Not shown anywhere on the storefront. It is stored on the customer's own record, so keep it factual."
            footer={
              <div className="flex items-center justify-end gap-2">
                <AdminButton onClick={() => setNoteDraft(row.note ?? "")} disabled={!noteChanged || saving}>
                  Reset
                </AdminButton>
                <AdminButton variant="primary" icon={<Save aria-hidden className="size-3.5" />} loading={saving} disabled={!noteChanged} onClick={saveNote}>
                  Save note
                </AdminButton>
              </div>
            }
          >
            <Field label="Note" optional hint={`${note.length.toLocaleString("en-GB")} / ${NOTE_MAX.toLocaleString("en-GB")}`}>
              <Textarea rows={4} maxLength={NOTE_MAX} value={note} onChange={(e) => setNoteDraft(e.target.value)} disabled={saving} />
            </Field>
          </SectionCard>

          <SectionCard title="Orders" description="Placed from this account or with its email address." padded={false}>
            {orders.error && <QueryError error={orders.error} onRetry={orders.refetch} feature="Orders" className="m-4" />}
            <DataTable
              caption={`Orders of ${title}`}
              rows={orders.data?.rows ?? []}
              rowKey={(r) => r.id}
              rowLabel={(r) => r.id}
              loading={orders.loading}
              failed={Boolean(orders.error)}
              skeletonRows={3}
              columns={[
                { key: "id", header: "Order", cell: (r) => <span className="font-mono font-semibold">{r.id}</span> },
                { key: "created_at", header: "Placed", hideBelow: "sm", cell: (r) => <DateTime value={r.created_at} mode="date" /> },
                {
                  key: "status",
                  header: "Status",
                  cell: (r) => <StatusBadge tone={orderStatusTone(r.status)}>{orderStatusLabel(r.status, r.fulfillment)}</StatusBadge>,
                },
                {
                  key: "payment_status",
                  header: "Payment",
                  hideBelow: "md",
                  cell: (r) => <StatusBadge tone={paymentStatusTone(r.payment_status)}>{paymentStatusLabel(r.payment_status, r.fulfillment)}</StatusBadge>,
                },
                { key: "total_price", header: "Total", align: "right", cell: (r) => <Money amount={r.total_price} /> },
              ]}
              actions={[
                {
                  label: "Open in Orders",
                  icon: <ArrowUpRight aria-hidden className="size-3.5" />,
                  onClick: (r) => setAdminParams({ tab: "orders", order: r.id }, { reset: true }),
                },
              ]}
              empty={{ title: "No orders yet", description: "Orders placed from this account or with its email address appear here." }}
            />
            <div className="px-4">
              <AdminPagination page={ordersPage} pageSize={ORDERS_PAGE} total={orders.data?.total ?? 0} onPageChange={setOrdersPage} loading={orders.loading} noun="orders" />
            </div>
          </SectionCard>
        </div>
      )}
    </Drawer>
  );
}

