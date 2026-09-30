"use client";

import { useState } from "react";
import { CustomerDossier } from "@/components/admin/customers/CustomerDossier";
import { CUSTOMERS_MIGRATION, customerName, type CustomerRow } from "@/components/admin/customers/types";
import { getAdminTab } from "@/components/admin/registry";
import { AdminPagination, DataTable, DateTime, Money, QueryError, SectionCard, StatusBadge, TabHeader, Toolbar, type SortState } from "@/components/admin/ui";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { unwrapPage, useAdminQuery } from "@/lib/admin/query";
import { orIlike } from "@/lib/admin/search";
import { setAdminParams, useAdminParam } from "@/lib/admin/url";
import { formatLkPhone, normalizeLkPhone } from "@/lib/sri-lanka";

/**
 * Admin → Customers (blueprint §11.2): search / sort / paginate the customers table (admin RLS),
 * and a dossier drawer per customer (`?tab=customers&customer=<id>` deep-links it). The only
 * write is the admin note, in the dossier.
 */

const SORTABLE = new Set(["email", "last_name", "orders_count", "total_spent", "created_at"]);
const DEFAULT_SORT: NonNullable<SortState> = { key: "created_at", direction: "desc" };

/** Name, email, phone or city. A Sri Lankan phone typed as "077 123 4567" also matches the stored "+94771234567". */
function searchFilter(term: string): string {
  const base = orIlike(["email", "first_name", "last_name", "phone", "city"], term);
  if (!base) return "";
  const phone = normalizeLkPhone(term);
  const extra = phone ? orIlike(["phone"], phone) : "";
  return extra ? `${base},${extra}` : base;
}

export default function CustomersTab() {
  const tab = getAdminTab("customers");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const selected = useAdminParam("customer");

  const { from, to } = pageRange(page);
  const active = sort && SORTABLE.has(sort.key) ? sort : DEFAULT_SORT;
  const list = useAdminQuery(
    async ({ supabase, signal }) => {
      // select("*"): a column from a newer migration can't break the read (ADMIN_KIT §3).
      let query = supabase.from("customers").select("*", { count: "exact" });
      const filter = searchFilter(search);
      if (filter) query = query.or(filter);
      query = query.order(active.key, { ascending: active.direction === "asc", nullsFirst: false }).order("id", { ascending: true });
      return unwrapPage<CustomerRow>(await query.range(from, to).abortSignal(signal), CUSTOMERS_MIGRATION);
    },
    [search, from, to, active],
    { migration: CUSTOMERS_MIGRATION },
  );

  const openDossier = (row: CustomerRow) => setAdminParams({ customer: row.id });
  const closeDossier = () => setAdminParams({ customer: null });

  return (
    <>
      <TabHeader eyebrow={tab.group} title={tab.label} description={tab.summary} />

      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature="Customers" className="mb-4" />}

      <SectionCard
        padded={false}
        description="Orders and lifetime value here are the account's own (linked, non-cancelled) orders. Open a customer for the full dossier, which also counts orders placed with the same email address."
      >
        <div className="p-4 pb-0">
          <Toolbar
            search={{
              value: search,
              onChange: (value) => {
                setSearch(value);
                setPage(1);
              },
              placeholder: "Name, email, phone or city",
            }}
          />
        </div>
        <DataTable
          caption="Customers"
          rows={list.data?.rows ?? []}
          rowKey={(r) => r.id}
          rowLabel={(r) => customerName(r) || r.email}
          loading={list.loading}
          failed={Boolean(list.error)}
          sort={active}
          onSortChange={(next) => {
            // The default is "Joined, newest first", so "off" would land on it again: from there a
            // click on Joined must reach "oldest first".
            const fromDefault = active.key === DEFAULT_SORT.key && active.direction === DEFAULT_SORT.direction;
            setSort(next ?? (fromDefault ? { key: DEFAULT_SORT.key, direction: "asc" } : DEFAULT_SORT));
            setPage(1);
          }}
          onRowClick={openDossier}
          selectedKey={selected}
          columns={[
            {
              key: "email",
              header: "Customer",
              sortable: true,
              cell: (r) => (
                <span className="block min-w-0">
                  <span className="block truncate font-semibold">{customerName(r) || "—"}</span>
                  <span className="block truncate text-[12.5px] text-adm-mute">{r.email}</span>
                </span>
              ),
            },
            { key: "phone", header: "Phone", hideBelow: "md", cell: (r) => (r.phone ? formatLkPhone(r.phone) : <span className="text-adm-mute">—</span>) },
            {
              key: "district",
              header: "Location",
              hideBelow: "lg",
              cell: (r) => [r.city, r.district].filter(Boolean).join(", ") || <span className="text-adm-mute">—</span>,
            },
            { key: "orders_count", header: "Orders", sortable: true, align: "right", cell: (r) => (r.orders_count ?? 0).toLocaleString("en-GB") },
            { key: "total_spent", header: "Lifetime value", sortable: true, align: "right", cell: (r) => <Money amount={r.total_spent} /> },
            { key: "created_at", header: "Joined", sortable: true, hideBelow: "sm", cell: (r) => <DateTime value={r.created_at} mode="date" /> },
            {
              key: "is_admin",
              header: "Access",
              hideBelow: "md",
              cell: (r) =>
                r.is_admin ? (
                  <StatusBadge tone="accent" dot>
                    Admin
                  </StatusBadge>
                ) : (
                  <span className="text-adm-mute">Customer</span>
                ),
            },
          ]}
          actions={[{ label: "Open", onClick: openDossier }]}
          empty={{
            title: search ? "No customers match" : "No customers yet",
            description: search ? "Try another name, email, phone number or city." : "Accounts appear here when shoppers sign up.",
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="customers" />
        </div>
      </SectionCard>

      <CustomerDossier
        customerId={selected}
        onClose={closeDossier}
        onSaved={(saved) => list.mutate((current) => current && { ...current, rows: current.rows.map((r) => (r.id === saved.id ? saved : r)) })}
      />
    </>
  );
}
