"use client";

import { useState } from "react";
import { InquiryDrawer } from "@/components/admin/growth/InquiryDrawer";
import { INQUIRY_STATUS, INQUIRY_WRITE, LEADS_MIGRATION, type Inquiry, type InquiryStatus } from "@/components/admin/growth/types";
import { getAdminTab } from "@/components/admin/registry";
import { AdminPagination, ConfirmDialog, DataTable, DateTime, QueryError, SectionCard, StatusBadge, TabHeader, Tabs, Toolbar } from "@/components/admin/ui";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { unwrapCount, unwrapPage, useAdminQuery } from "@/lib/admin/query";
import { orIlike } from "@/lib/admin/search";
import { adminToast } from "@/lib/admin/toast";
import { deleteRows } from "@/lib/admin/write";

/*
 * Inquiries — the contact-form desk (blueprint §9.12, §11.2; contract: SQL_NOTES → 12_leads.sql).
 * New first; open one to read it and answer: by email (POST /api/admin/inquiry-reply sends
 * first, marks answered only if it sent) or "answered without an email" (by phone). Delete is a
 * direct admin-RLS write behind a confirmation. Reads are paginated (select("*"), admin RLS).
 */

type Filter = InquiryStatus | "all";

const excerpt = (text: string, max = 120) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export default function InquiriesTab() {
  const tab = getAdminTab("inquiries");
  const [filter, setFilter] = useState<Filter>("new");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Inquiry | null>(null);
  const [deleting, setDeleting] = useState<Inquiry | null>(null);

  const { from, to } = pageRange(page);
  const list = useAdminQuery(
    async ({ supabase, signal }) => {
      let query = supabase.from("contact_inquiries").select("*", { count: "exact" });
      if (filter !== "all") query = query.eq("status", filter);
      const term = orIlike(["name", "email", "subject"], search);
      if (term) query = query.or(term);
      query = query.order("created_at", { ascending: false }).order("id", { ascending: true });
      return unwrapPage<Inquiry>(await query.range(from, to).abortSignal(signal), LEADS_MIGRATION);
    },
    [filter, search, from, to],
    { migration: LEADS_MIGRATION },
  );

  const counts = useAdminQuery(
    async ({ supabase, signal }) => {
      const count = async (status: InquiryStatus) =>
        unwrapCount(await supabase.from("contact_inquiries").select("id", { count: "exact", head: true }).eq("status", status).abortSignal(signal), LEADS_MIGRATION);
      const [fresh, answered] = await Promise.all([count("new"), count("answered")]);
      return { new: fresh, answered };
    },
    [],
    { migration: LEADS_MIGRATION },
  );

  const refresh = () => {
    list.refetch();
    counts.refetch();
  };

  const c = counts.data;
  const rows = list.data?.rows ?? [];

  return (
    <>
      <TabHeader eyebrow={tab.group} title={tab.label} description={tab.summary} />

      {list.error && <QueryError error={list.error} onRetry={refresh} feature="Inquiries" className="mb-4" />}

      <SectionCard padded={false}>
        <Tabs<Filter>
          label="Inquiry status"
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setPage(1);
          }}
          className="px-4 pt-3"
          items={[
            { key: "new", label: "New", count: c?.new ?? null },
            { key: "answered", label: "Answered", count: c?.answered ?? null },
            { key: "all", label: "All", count: c ? c.new + c.answered : null },
          ]}
        />
        <div className="p-4 pb-0">
          <Toolbar
            search={{
              value: search,
              onChange: (value) => {
                setSearch(value);
                setPage(1);
              },
              placeholder: "Name, email or subject",
            }}
          />
        </div>
        <DataTable<Inquiry>
          caption="Contact inquiries"
          rows={rows}
          rowKey={(row) => row.id}
          rowLabel={(row) => `the inquiry from ${row.name}`}
          loading={list.loading}
          failed={Boolean(list.error)}
          onRowClick={setSelected}
          selectedKey={selected?.id ?? null}
          rowTone={(row) => (row.status === "new" ? "attention" : null)}
          columns={[
            {
              key: "from",
              header: "From",
              cell: (row) => (
                <span className="block min-w-0">
                  <span className="block truncate font-semibold">{row.name}</span>
                  <span className="block truncate text-[12.5px] text-adm-mute">{row.email}</span>
                </span>
              ),
            },
            {
              key: "subject",
              header: "Message",
              cell: (row) => (
                <div className="min-w-0">
                  <p className="font-semibold break-words">{row.subject}</p>
                  <p className="text-adm-ink-2 break-words">{excerpt(row.message)}</p>
                </div>
              ),
            },
            {
              key: "status",
              header: "Status",
              cell: (row) => {
                const status = INQUIRY_STATUS[row.status] ?? INQUIRY_STATUS.new;
                return (
                  <StatusBadge tone={status.tone} dot>
                    {status.label}
                  </StatusBadge>
                );
              },
            },
            { key: "created_at", header: "Received", hideBelow: "md", cell: (row) => <DateTime value={row.created_at} /> },
          ]}
          actions={[
            { label: "Open", onClick: setSelected },
            { label: "Delete", variant: "danger", onClick: setDeleting },
          ]}
          empty={{
            title: search ? "No inquiries match" : filter === "new" ? "No new inquiries" : "No inquiries here",
            description: search ? "Try another name, email or subject." : "Messages sent from the contact page appear here.",
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="inquiries" />
        </div>
      </SectionCard>

      <InquiryDrawer
        inquiry={selected}
        onClose={() => setSelected(null)}
        onAnswered={(row) => {
          setSelected(row);
          refresh();
        }}
        onDelete={setDeleting}
      />

      <ConfirmDialog
        open={deleting != null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title={`Delete the inquiry from ${deleting?.name ?? ""}?`}
        description="The message and any reply record are removed for good. This can't be undone."
        confirmLabel="Delete inquiry"
        onConfirm={async () => {
          const target = deleting;
          if (!target) return true;
          const res = await deleteRows("contact_inquiries", { id: target.id }, { ...INQUIRY_WRITE, action: "delete", expect: 1 });
          if (res.ok) {
            adminToast.success("Inquiry deleted");
            if (selected?.id === target.id) setSelected(null);
            refresh();
          }
          return res;
        }}
      />
    </>
  );
}
