"use client";

import { Star } from "lucide-react";
import { useState } from "react";
import { ReviewDetail } from "@/components/admin/reviews/ReviewDetail";
import { REVIEW_STATUS, REVIEW_WRITE, REVIEWS_MIGRATION, type AdminReview, type ReviewStatus } from "@/components/admin/reviews/review-types";
import { getAdminTab } from "@/components/admin/registry";
import {
  AdminPagination,
  ConfirmDialog,
  DataTable,
  DateTime,
  QueryError,
  SectionCard,
  Select,
  StatusBadge,
  TabHeader,
  Tabs,
  Toolbar,
} from "@/components/admin/ui";
import { ADMIN_PAGE_SIZE, pageRange } from "@/lib/admin/pagination";
import { unwrapCount, unwrapPage, unwrapRows, useAdminQuery } from "@/lib/admin/query";
import { adminToast, toastResult } from "@/lib/admin/toast";
import { deleteRows, updateRows } from "@/lib/admin/write";

/*
 * Reviews — the moderation queue (WP-J, BUILD_SPEC §2.0(c); contract: SQL_NOTES → 11_reviews.sql).
 * Pending reviews first (the default view), filter by status and product, approve / reject /
 * feature / reply / delete. Every write goes through the kit (error AND row count checked) and,
 * once confirmed, refreshes the storefront's `reviews` + `catalogue` caches (ratings roll up
 * onto products). Nothing here can create a review or change what a customer wrote.
 */

type StatusFilter = ReviewStatus | "all";
type ProductOption = { id: number; name: string };

const excerpt = (text: string, max = 110) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export default function ReviewsTab() {
  const tab = getAdminTab("reviews");
  const [status, setStatus] = useState<StatusFilter>("pending");
  const [productId, setProductId] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<AdminReview | null>(null);
  const [deleting, setDeleting] = useState<AdminReview | null>(null);

  const { from, to } = pageRange(page);
  const list = useAdminQuery(
    async ({ supabase, signal }) => {
      let query = supabase.from("product_reviews").select("*, product:products(id, name)", { count: "exact" });
      if (status !== "all") query = query.eq("status", status);
      if (productId) query = query.eq("product_id", Number(productId));
      query = query.order("created_at", { ascending: false }).order("id", { ascending: false });
      return unwrapPage<AdminReview>(await query.range(from, to).abortSignal(signal), REVIEWS_MIGRATION);
    },
    [status, productId, from, to],
    { migration: REVIEWS_MIGRATION },
  );

  const counts = useAdminQuery(
    async ({ supabase, signal }) => {
      const count = async (value: ReviewStatus) => {
        let query = supabase.from("product_reviews").select("id", { count: "exact", head: true }).eq("status", value);
        if (productId) query = query.eq("product_id", Number(productId));
        return unwrapCount(await query.abortSignal(signal), REVIEWS_MIGRATION);
      };
      const [pending, approved, rejected] = await Promise.all([count("pending"), count("approved"), count("rejected")]);
      return { pending, approved, rejected };
    },
    [productId],
    { migration: REVIEWS_MIGRATION },
  );

  const products = useAdminQuery(
    async ({ supabase, signal }) =>
      unwrapRows<ProductOption>(await supabase.from("products").select("id, name").order("name").limit(1000).abortSignal(signal), "04_catalogue.sql"),
    [],
  );

  const refresh = () => {
    list.refetch();
    counts.refetch();
  };

  const quickStatus = async (row: AdminReview, next: ReviewStatus) => {
    const res = await updateRows<AdminReview>("product_reviews", { status: next }, { id: row.id }, REVIEW_WRITE);
    if (!toastResult(res, { success: next === "approved" ? "Review approved" : "Review rejected", failure: "Couldn't update the review" })) return;
    refresh();
  };

  const c = counts.data;
  const total = c ? c.pending + c.approved + c.rejected : null;
  const rows = list.data?.rows ?? [];

  return (
    <>
      <TabHeader eyebrow={tab.group} title={tab.label} description={tab.summary} />

      {list.error && <QueryError error={list.error} onRetry={refresh} feature="Reviews" className="mb-4" />}

      <SectionCard padded={false}>
        <Tabs<StatusFilter>
          label="Review status"
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          className="px-4 pt-3"
          items={[
            { key: "pending", label: "Pending", count: c?.pending ?? null },
            { key: "approved", label: "Approved", count: c?.approved ?? null },
            { key: "rejected", label: "Rejected", count: c?.rejected ?? null },
            { key: "all", label: "All", count: total },
          ]}
        />
        <div className="p-4 pb-0">
          <Toolbar
            filters={
              <label className="flex items-center gap-2 text-sm">
                <span className="text-adm-mute">Product</span>
                <Select
                  value={productId}
                  onChange={(event) => {
                    setProductId(event.target.value);
                    setPage(1);
                  }}
                  placeholder="All products"
                  options={(products.data ?? []).map((product) => ({ value: String(product.id), label: product.name }))}
                  className="min-w-56"
                />
              </label>
            }
          />
        </div>
        <DataTable<AdminReview>
          caption="Product reviews"
          rows={rows}
          rowKey={(row) => row.id}
          rowLabel={(row) => `review by ${row.author_name}`}
          loading={list.loading}
          failed={Boolean(list.error)}
          onRowClick={setSelected}
          selectedKey={selected?.id ?? null}
          rowTone={(row) => (row.status === "pending" ? "attention" : row.status === "rejected" ? "muted" : null)}
          columns={[
            {
              key: "rating",
              header: "Rating",
              width: "96px",
              cell: (row) => (
                <span role="img" aria-label={`${row.rating} out of 5`} className="flex">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Star key={i} aria-hidden className={`size-3.5 ${i <= row.rating ? "fill-adm-ink text-adm-ink" : "text-adm-line-strong"}`} />
                  ))}
                </span>
              ),
            },
            {
              key: "review",
              header: "Review",
              cell: (row) => (
                <div className="min-w-0">
                  {row.title && <p className="font-semibold">{row.title}</p>}
                  <p className="text-adm-ink-2">{excerpt(row.body)}</p>
                  <p className="mt-1 font-mono text-[11px] text-adm-mute">
                    {row.author_name}
                    {row.is_verified_purchase ? " · verified purchase" : ""}
                    {row.admin_reply ? " · replied" : ""}
                  </p>
                </div>
              ),
            },
            { key: "product", header: "Product", hideBelow: "md", cell: (row) => row.product?.name ?? <span className="text-adm-mute">Deleted product</span> },
            {
              key: "status",
              header: "Status",
              cell: (row) => (
                <span className="flex flex-wrap gap-1">
                  <StatusBadge tone={REVIEW_STATUS[row.status].tone} dot>
                    {REVIEW_STATUS[row.status].label}
                  </StatusBadge>
                  {row.is_featured && <StatusBadge tone="accent">Featured</StatusBadge>}
                </span>
              ),
            },
            { key: "created_at", header: "Submitted", hideBelow: "lg", cell: (row) => <DateTime value={row.created_at} mode="date" /> },
          ]}
          actions={[
            { label: "Approve", hidden: (row) => row.status === "approved", onClick: (row) => void quickStatus(row, "approved") },
            { label: "Reject", hidden: (row) => row.status === "rejected", onClick: (row) => void quickStatus(row, "rejected") },
            { label: "Open", onClick: setSelected },
          ]}
          empty={{
            title: status === "pending" ? "Nothing to moderate" : "No reviews here",
            description: status === "pending" ? "New reviews from customers appear here for approval." : "Try another status or product.",
          }}
        />
        <div className="px-4">
          <AdminPagination page={page} pageSize={ADMIN_PAGE_SIZE} total={list.data?.total ?? 0} onPageChange={setPage} loading={list.loading} noun="reviews" />
        </div>
      </SectionCard>

      <ReviewDetail
        review={selected}
        onClose={() => setSelected(null)}
        onSaved={(row) => {
          setSelected(row);
          refresh();
        }}
        onDelete={(row) => setDeleting(row)}
      />

      <ConfirmDialog
        open={deleting != null}
        onClose={() => setDeleting(null)}
        tone="danger"
        title={`Delete the review by ${deleting?.author_name ?? ""}?`}
        description="It disappears from the product page and the product's rating is recalculated. This can't be undone — rejecting keeps a record instead."
        confirmLabel="Delete review"
        onConfirm={async () => {
          const target = deleting;
          if (!target) return true;
          const res = await deleteRows("product_reviews", { id: target.id }, { ...REVIEW_WRITE, action: "delete" });
          if (res.ok) {
            adminToast.success("Review deleted");
            if (selected?.id === target.id) setSelected(null);
            refresh();
          }
          return res;
        }}
      />
    </>
  );
}
