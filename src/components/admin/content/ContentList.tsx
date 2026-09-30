"use client";

import { ExternalLink, Plus } from "lucide-react";
import { useState } from "react";
import { AdminButton, AdminPagination, DataTable, DateTime, QueryError, SectionCard, Select, StatusBadge, Toolbar, type SortState } from "@/components/admin/ui";
import { footerGroupLabel } from "@/components/content/cms-shared";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { useAdminQuery } from "@/lib/admin/query";
import { toastResult } from "@/lib/admin/toast";
import { updateRows } from "@/lib/admin/write";
import {
  CONTENT_MIGRATION,
  CONTENT_TABLE,
  CONTENT_WRITE,
  fetchContentList,
  STATUS_FILTERS,
  storefrontHref,
  type ContentKind,
  type ContentListRow,
  type PageListRow,
  type PostListRow,
  type StatusFilter,
} from "./content-admin";

/**
 * The pages / posts list: search (title, address, author), status filter, sortable columns,
 * pagination in the query (never an unbounded select — blueprint §11.1), the live address of each
 * published record, and row actions. Unpublishing is one guarded write; publishing happens in the
 * editor, where the record is validated first.
 */
export function ContentList({
  kind,
  selectedId,
  refreshKey,
  onEdit,
  onCreate,
  onRequestDelete,
}: {
  kind: ContentKind;
  selectedId: number | null;
  /** Bump to reload after the editor saved or a record was deleted. */
  refreshKey: number;
  onEdit: (id: number) => void;
  onCreate: () => void;
  onRequestDelete: (record: { kind: ContentKind; id: number; title: string; slug: string; isPublished: boolean }) => void;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortState>({ key: "updated_at", direction: "desc" });
  const [page, setPage] = useState(1);
  const [busyId, setBusyId] = useState<number | null>(null);
  const noun = kind === "pages" ? "page" : "post";

  const { from, to } = pageRange(page);
  const list = useAdminQuery(
    ({ supabase, signal }) => fetchContentList(supabase, kind, { search, status, sort, from, to, signal }),
    ["content-list", kind, search, status, sort, from, to, refreshKey],
    { migration: CONTENT_MIGRATION },
  );

  const unpublish = async (row: ContentListRow) => {
    setBusyId(row.id);
    const result = await updateRows(CONTENT_TABLE[kind], { is_published: false }, { id: row.id }, { ...CONTENT_WRITE[kind], expect: 1 });
    setBusyId(null);
    if (!toastResult(result, { success: `${noun === "page" ? "Page" : "Post"} unpublished`, failure: `Couldn't unpublish the ${noun}` })) return;
    list.refetch();
  };

  const titleCell = (row: ContentListRow) => (
    <span className="block min-w-[12rem]">
      <span className="block truncate font-semibold text-adm-ink">{row.title}</span>
      <span className="block truncate font-mono text-[11px] text-adm-mute">{row.slug}</span>
    </span>
  );
  const statusCell = (row: ContentListRow) =>
    row.is_published ? (
      <StatusBadge tone="success" dot>
        Published
      </StatusBadge>
    ) : (
      <StatusBadge tone="neutral">Draft</StatusBadge>
    );
  const addressCell = (row: ContentListRow) => {
    const href = storefrontHref(kind, row.slug);
    return row.is_published ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
        className="inline-flex items-center gap-1 font-mono text-[12px] text-adm-accent-ink underline-offset-2 hover:underline"
      >
        {href}
        <ExternalLink aria-hidden className="size-3" />
        <span className="sr-only">(opens the live {noun} in a new tab)</span>
      </a>
    ) : (
      <span className="font-mono text-[12px] text-adm-mute">{href}</span>
    );
  };

  const pageColumns = [
    { key: "title", header: "Page", sortable: true, cell: (row: ContentListRow) => titleCell(row) },
    { key: "address", header: "Address", hideBelow: "md" as const, cell: addressCell },
    {
      key: "sort_order",
      header: "Footer",
      sortable: true,
      hideBelow: "lg" as const,
      cell: (row: ContentListRow) => {
        const pageRow = row as PageListRow;
        const group = pageRow.show_in_footer ? footerGroupLabel(pageRow.footer_group) : null;
        return group ? (
          <span>
            {group} <span className="font-mono text-[11px] text-adm-mute">#{pageRow.sort_order}</span>
          </span>
        ) : (
          <span className="text-adm-mute">—</span>
        );
      },
    },
    { key: "status", header: "Status", cell: statusCell },
    { key: "updated_at", header: "Updated", sortable: true, hideBelow: "sm" as const, cell: (row: ContentListRow) => <DateTime value={row.updated_at} /> },
  ];
  const postColumns = [
    { key: "title", header: "Post", sortable: true, cell: (row: ContentListRow) => titleCell(row) },
    { key: "address", header: "Address", hideBelow: "lg" as const, cell: addressCell },
    {
      key: "published_at",
      header: "Publish date",
      sortable: true,
      hideBelow: "md" as const,
      cell: (row: ContentListRow) => {
        const at = (row as PostListRow).published_at;
        return at ? <DateTime value={at} mode="date" /> : <span className="text-adm-mute">—</span>;
      },
    },
    { key: "author", header: "Author", hideBelow: "lg" as const, cell: (row: ContentListRow) => (row as PostListRow).author ?? <span className="text-adm-mute">—</span> },
    { key: "status", header: "Status", cell: statusCell },
    { key: "updated_at", header: "Updated", sortable: true, hideBelow: "sm" as const, cell: (row: ContentListRow) => <DateTime value={row.updated_at} /> },
  ];

  const filtered = Boolean(search) || status !== "all";

  return (
    <>
      {list.error && <QueryError error={list.error} onRetry={list.refetch} feature={kind === "pages" ? "Pages" : "Blog posts"} className="mb-4" />}
      <SectionCard padded={false}>
        <div className="p-4 pb-0">
          <Toolbar
            search={{
              value: search,
              onChange: (value) => {
                setSearch(value);
                setPage(1);
              },
              placeholder: kind === "pages" ? "Title or address" : "Title, address or author",
              label: kind === "pages" ? "Search pages" : "Search posts",
            }}
            filters={
              <Select
                aria-label="Status"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as StatusFilter);
                  setPage(1);
                }}
                options={STATUS_FILTERS}
              />
            }
          />
        </div>
        <DataTable
          caption={kind === "pages" ? "Pages" : "Blog posts"}
          rows={list.data?.rows ?? []}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.title}
          loading={list.loading}
          failed={Boolean(list.error)}
          sort={sort}
          onSortChange={(next) => {
            setSort(next);
            setPage(1);
          }}
          onRowClick={(row) => onEdit(row.id)}
          selectedKey={selectedId}
          rowTone={(row) => (row.is_published ? null : "muted")}
          columns={kind === "pages" ? pageColumns : postColumns}
          actions={[
            { label: "Edit", onClick: (row) => onEdit(row.id) },
            { label: "Unpublish", hidden: (row) => !row.is_published, disabled: (row) => busyId === row.id, onClick: (row) => void unpublish(row) },
            {
              label: "Delete",
              variant: "danger",
              onClick: (row) => onRequestDelete({ kind, id: row.id, title: row.title, slug: row.slug, isPublished: row.is_published }),
            },
          ]}
          empty={{
            title: filtered ? `No ${noun}s match` : kind === "pages" ? "No pages yet" : "No posts yet",
            description: filtered
              ? "Try another search or status."
              : kind === "pages"
                ? "Pages hold your policies and information: privacy, terms, returns, delivery, warranty…"
                : "Posts appear on /blogs once published.",
            action: filtered ? undefined : (
              <AdminButton variant="primary" icon={<Plus aria-hidden className="size-3.5" />} onClick={onCreate}>
                {kind === "pages" ? "New page" : "New post"}
              </AdminButton>
            ),
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun={`${noun}s`} />
        </div>
      </SectionCard>
    </>
  );
}
