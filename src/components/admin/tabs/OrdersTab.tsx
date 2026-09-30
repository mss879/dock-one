"use client";

import { useState } from "react";
import { getAdminTab } from "@/components/admin/registry";
import { OrderDrawer } from "@/components/admin/orders/OrderDrawer";
import { ORDERS_MIGRATION, customerName, normalizeAdminOrder, type AdminOrder } from "@/components/admin/orders/types";
import {
  AdminPagination,
  DataTable,
  DateTime,
  Money,
  QueryError,
  SectionCard,
  Select,
  StatusBadge,
  TabHeader,
  Toolbar,
  type SortState,
} from "@/components/admin/ui";
import { rangeBounds, rangeValue, type DateRangeValue } from "@/lib/admin/dates";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { unwrapPage, unwrapRow, useAdminQuery } from "@/lib/admin/query";
import { cleanSearchTerm, orIlike } from "@/lib/admin/search";
import { setAdminParams, useAdminParam } from "@/lib/admin/url";
import {
  FULFILLMENTS,
  FULFILLMENT_LABELS,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  normalizeOrderRef,
  orderStatusLabel,
  orderStatusTone,
  paymentMethodLabel,
  paymentStatusLabel,
  paymentStatusTone,
} from "@/lib/orders";
import { DEFAULT_STORE_SETTINGS, normalizeStoreSettings, type StoreSettings } from "@/lib/settings-shared";
import { normalizeLkPhone } from "@/lib/sri-lanka";

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "open", label: "Open (not delivered or cancelled)" },
  ...ORDER_STATUSES.filter((status) => status !== "processing" && status !== "shipped").map((status) => ({ value: status, label: orderStatusLabel(status) })),
];
const PAYMENT_OPTIONS = [{ value: "", label: "All payments" }, ...PAYMENT_STATUSES.map((status) => ({ value: status, label: paymentStatusLabel(status) }))];
const FULFILLMENT_OPTIONS = [{ value: "", label: "Delivery & pickup" }, ...FULFILLMENTS.map((f) => ({ value: f, label: FULFILLMENT_LABELS[f] }))];

const SORTABLE = new Set(["created_at", "total_price", "status"]);

/**
 * Orders (blueprint §11.2): every order, filtered IN the query (status, payment, fulfilment,
 * Colombo date range, search by order number / email / phone / name), paginated server-side,
 * with a detail drawer (deep link: ?tab=orders&order=DO-10042). Status changes go ONLY through
 * POST /api/admin/order-status; payment through admin_set_payment_status.
 */
export default function OrdersTab() {
  const tab = getAdminTab("orders");
  // Deep link from anywhere in the admin (e.g. the Customers dossier): /admin?tab=orders&order=DO-10042
  // ("do-10042", "#10042" and "10042" open the same order).
  const orderParam = useAdminParam("order");
  const selected = orderParam ? (normalizeOrderRef(orderParam) ?? orderParam.trim().slice(0, 40)) : null;
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [payment, setPayment] = useState("");
  const [fulfillment, setFulfillment] = useState("");
  const [range, setRange] = useState<DateRangeValue>(() => rangeValue("30d"));
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>({ key: "created_at", direction: "desc" });

  const term = cleanSearchTerm(search);
  const { from, to } = pageRange(page);
  const bounds = rangeBounds(range);

  const list = useAdminQuery(
    async ({ supabase, signal }) => {
      let query = supabase.from("orders").select("*, order_items(count)", { count: "exact" });
      if (status === "open") query = query.not("status", "in", "(delivered,cancelled)");
      else if (status) query = query.eq("status", status);
      if (payment) query = query.eq("payment_status", payment);
      if (fulfillment) query = query.eq("fulfillment", fulfillment);
      if (term) {
        // A search looks across all dates: an order number or email is exact enough.
        const parts = [orIlike(["id", "email", "first_name", "last_name", "phone"], term)];
        const ref = normalizeOrderRef(term);
        if (ref) parts.push(`id.eq."${ref}"`);
        const phone = normalizeLkPhone(term);
        if (phone) parts.push(`phone.eq."${phone}"`);
        query = query.or(parts.filter(Boolean).join(","));
      } else {
        query = query.gte("created_at", bounds.gte).lt("created_at", bounds.lt);
      }
      const key = sort && SORTABLE.has(sort.key) ? sort.key : "created_at";
      query = query.order(key, { ascending: sort?.direction === "asc" });
      if (key !== "created_at") query = query.order("created_at", { ascending: false });
      return unwrapPage<Record<string, unknown>>(await query.range(from, to).abortSignal(signal), ORDERS_MIGRATION);
    },
    [term, status, payment, fulfillment, bounds.gte, bounds.lt, from, to, sort],
    { migration: ORDERS_MIGRATION },
  );

  // Store facts for the invoice header (public row; read once).
  const settingsQuery = useAdminQuery(
    async ({ supabase, signal }) => unwrapRow<Record<string, unknown>>(await supabase.from("store_settings").select("*").eq("id", true).abortSignal(signal).maybeSingle(), "03_store_settings.sql"),
    [],
    { migration: "03_store_settings.sql" },
  );
  const settings: StoreSettings = settingsQuery.data ? normalizeStoreSettings(settingsQuery.data) : DEFAULT_STORE_SETTINGS;

  const rows: AdminOrder[] = (list.data?.rows ?? []).map(normalizeAdminOrder);
  const resetPage = () => setPage(1);

  return (
    <>
      <TabHeader eyebrow={tab.group} title={tab.label} description={tab.summary} />

      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Orders" className="mb-4" />}

      <SectionCard padded={false}>
        <div className="p-4 pb-0">
          <Toolbar
            search={{
              value: search,
              onChange: (value) => {
                setSearch(value);
                resetPage();
              },
              placeholder: "Order no., email, phone or name",
              label: "Search orders",
            }}
            filters={
              <>
                <Select aria-label="Order status" value={status} onChange={(e) => { setStatus(e.target.value); resetPage(); }} options={STATUS_OPTIONS} />
                <Select aria-label="Payment status" value={payment} onChange={(e) => { setPayment(e.target.value); resetPage(); }} options={PAYMENT_OPTIONS} />
                <Select aria-label="Fulfilment" value={fulfillment} onChange={(e) => { setFulfillment(e.target.value); resetPage(); }} options={FULFILLMENT_OPTIONS} />
              </>
            }
            dateRange={term ? undefined : { value: range, onChange: (value) => { setRange(value); resetPage(); } }}
          >
            {term && <p className="text-xs text-adm-mute">Searching all dates.</p>}
          </Toolbar>
        </div>
        <DataTable<AdminOrder>
          caption="Orders"
          rows={rows}
          rowKey={(row) => row.id}
          rowLabel={(row) => `order ${row.id}`}
          loading={list.loading}
          failed={Boolean(list.error)}
          sort={sort}
          onSortChange={(next) => {
            setSort(next);
            resetPage();
          }}
          onRowClick={(row) => setAdminParams({ order: row.id })}
          selectedKey={selected}
          rowTone={(row) => (row.status === "pending" ? "attention" : row.status === "cancelled" ? "muted" : null)}
          columns={[
            { key: "id", header: "Order", cell: (row) => <span className="font-mono font-semibold">{row.id}</span> },
            { key: "created_at", header: "Placed", sortable: true, cell: (row) => <DateTime value={row.createdAt} /> },
            {
              key: "customer",
              header: "Customer",
              cell: (row) => (
                <span className="block max-w-[16rem] truncate">
                  {customerName(row)}
                  <span className="block truncate text-xs text-adm-mute">{row.email}</span>
                </span>
              ),
            },
            { key: "items", header: "Items", align: "right", hideBelow: "md", cell: (row) => (row.itemCount ?? "—") },
            { key: "total_price", header: "Total", sortable: true, align: "right", cell: (row) => <Money amount={row.totalPrice} /> },
            {
              key: "payment",
              header: "Payment",
              hideBelow: "lg",
              cell: (row) => (
                <span className="flex flex-col items-start gap-1">
                  <span className="text-xs text-adm-mute">{paymentMethodLabel(row.paymentMethod)}</span>
                  <StatusBadge tone={paymentStatusTone(row.paymentStatus)}>{paymentStatusLabel(row.paymentStatus, row.fulfillment)}</StatusBadge>
                </span>
              ),
            },
            { key: "fulfillment", header: "Fulfilment", hideBelow: "lg", cell: (row) => FULFILLMENT_LABELS[row.fulfillment] },
            {
              key: "status",
              header: "Status",
              sortable: true,
              cell: (row) => (
                <StatusBadge tone={orderStatusTone(row.status)} dot>
                  {orderStatusLabel(row.status, row.fulfillment)}
                </StatusBadge>
              ),
            },
          ]}
          empty={{
            title: term || status || payment || fulfillment ? "No orders match" : "No orders in this period",
            description: term ? "Check the order number, email or phone." : "Try a longer date range or clear the filters.",
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="orders" />
        </div>
      </SectionCard>

      <OrderDrawer key={selected ?? "none"} orderId={selected} settings={settings} onClose={() => setAdminParams({ order: null })} onChanged={list.refetch} />
    </>
  );
}
