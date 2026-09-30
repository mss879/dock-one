"use client";

import { ExternalLink, Star } from "lucide-react";
import { useState } from "react";
import { AdminButton, AdminLinkButton, DateTime, Drawer, Field, StatusBadge, Textarea } from "@/components/admin/ui";
import { toastResult } from "@/lib/admin/toast";
import { updateRows } from "@/lib/admin/write";
import { productHref } from "@/lib/catalogue-shared";
import { REPLY_MAX, REVIEW_STATUS, REVIEW_WRITE, type AdminReview, type ReviewStatus } from "./review-types";

type Props = {
  review: AdminReview | null;
  onClose: () => void;
  /** Called after a CONFIRMED write with the row as the database now has it. */
  onSaved: (row: AdminReview) => void;
  onDelete: (row: AdminReview) => void;
};

/**
 * One review in full, with every moderation action: approve / reject, feature (approved only —
 * the database clears it otherwise), the public store reply, delete. Nothing the customer wrote
 * can be edited here (11's guard refuses it anyway).
 */
export function ReviewDetail({ review, onClose, onSaved, onDelete }: Props) {
  // Remount per review so the reply draft starts from that review's saved reply.
  return review ? <ReviewDrawer key={review.id} review={review} onClose={onClose} onSaved={onSaved} onDelete={onDelete} /> : null;
}

function ReviewDrawer({ review, onClose, onSaved, onDelete }: Props & { review: AdminReview }) {
  const [reply, setReply] = useState(review.admin_reply ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const status = REVIEW_STATUS[review.status];

  async function save(patch: Partial<Pick<AdminReview, "status" | "is_featured" | "admin_reply">>, label: string, success: string) {
    setBusy(label);
    const res = await updateRows<AdminReview>("product_reviews", patch, { id: review.id }, REVIEW_WRITE);
    setBusy(null);
    if (!toastResult(res, { success, failure: "Couldn't update the review" })) return;
    onSaved({ ...review, ...res.data[0], product: review.product });
  }

  const setStatus = (next: ReviewStatus) => save({ status: next }, next, next === "approved" ? "Review approved" : next === "rejected" ? "Review rejected" : "Review moved back to pending");
  const trimmedReply = reply.trim();

  return (
    <Drawer
      open
      onClose={onClose}
      busy={busy !== null}
      title={review.title ?? `Review by ${review.author_name}`}
      description={review.product ? `On ${review.product.name}` : "Product no longer exists"}
      headerActions={
        review.product ? (
          <AdminLinkButton href={productHref(review.product.id)} external size="sm" icon={<ExternalLink aria-hidden className="size-3.5" />}>
            View on store
          </AdminLinkButton>
        ) : undefined
      }
      footer={
        <div className="flex flex-wrap items-center gap-2">
          {review.status !== "approved" && (
            <AdminButton variant="primary" loading={busy === "approved"} disabled={busy !== null} onClick={() => setStatus("approved")}>
              Approve
            </AdminButton>
          )}
          {review.status !== "rejected" && (
            <AdminButton loading={busy === "rejected"} disabled={busy !== null} onClick={() => setStatus("rejected")}>
              Reject
            </AdminButton>
          )}
          {review.status === "approved" && (
            <AdminButton
              variant="accent"
              loading={busy === "feature"}
              disabled={busy !== null}
              onClick={() => save({ is_featured: !review.is_featured }, "feature", review.is_featured ? "Review no longer featured" : "Review featured")}
            >
              {review.is_featured ? "Unfeature" : "Feature"}
            </AdminButton>
          )}
          <AdminButton variant="danger" disabled={busy !== null} onClick={() => onDelete(review)} className="ml-auto">
            Delete
          </AdminButton>
        </div>
      }
    >
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={status.tone} dot>
            {status.label}
          </StatusBadge>
          {review.is_featured && <StatusBadge tone="accent">Featured</StatusBadge>}
          {review.is_verified_purchase && <StatusBadge tone="info">Verified purchase</StatusBadge>}
        </div>

        <div>
          <p className="flex items-center gap-2">
            <span role="img" aria-label={`Rated ${review.rating} out of 5`} className="flex">
              {[1, 2, 3, 4, 5].map((i) => (
                <Star key={i} aria-hidden className={`size-4 ${i <= review.rating ? "fill-adm-ink text-adm-ink" : "text-adm-line-strong"}`} />
              ))}
            </span>
            <span className="font-mono text-xs text-adm-mute">{review.rating} / 5</span>
          </p>
          {review.title && <p className="mt-3 font-semibold">{review.title}</p>}
          <p className="mt-2 text-sm leading-6 whitespace-pre-line text-adm-ink-2">{review.body}</p>
        </div>

        <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2 border-y border-adm-line py-4 text-sm">
          <dt className="text-adm-mute">Public name</dt>
          <dd>{review.author_name}</dd>
          <dt className="text-adm-mute">Submitted</dt>
          <dd>
            <DateTime value={review.created_at} />
          </dd>
          <dt className="text-adm-mute">Last change</dt>
          <dd>
            <DateTime value={review.updated_at} />
          </dd>
          <dt className="text-adm-mute">Account</dt>
          <dd>{review.customer_id ? "Signed-in customer" : "Account deleted"}</dd>
        </dl>

        <Field label="Store reply" optional hint="Shown publicly under the review once it's approved. Up to 2,000 characters.">
          <Textarea value={reply} onChange={(event) => setReply(event.target.value)} maxLength={REPLY_MAX} rows={4} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <AdminButton
            size="sm"
            variant="primary"
            loading={busy === "reply"}
            disabled={busy !== null || trimmedReply === (review.admin_reply ?? "") || trimmedReply.length > REPLY_MAX}
            onClick={() => save({ admin_reply: trimmedReply || null }, "reply", trimmedReply ? "Reply saved" : "Reply removed")}
          >
            Save reply
          </AdminButton>
          {review.admin_reply && (
            <AdminButton size="sm" loading={busy === "clear"} disabled={busy !== null} onClick={() => save({ admin_reply: null }, "clear", "Reply removed")}>
              Remove reply
            </AdminButton>
          )}
        </div>
      </div>
    </Drawer>
  );
}
