"use client";

import Link from "next/link";
import { Star } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/form";
import { Notice } from "@/components/ui/Notice";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { useViewer } from "@/lib/viewer";

type MyReview = { rating: number; title: string | null; body: string; authorName: string; status: "pending" | "approved" | "rejected" };
type Outcome = { tone: "success" | "error"; message: string } | null;

const TITLE_MAX = 120;
const BODY_MIN = 10;
const BODY_MAX = 4000;
const NAME_MAX = 60;

const STATUS_COPY: Record<MyReview["status"], string> = {
  pending: "Your review is waiting for approval.",
  approved: "Your review is published.",
  rejected: "Your review wasn't approved.",
};

/**
 * Write (or edit) a review — signed-in customers only (submit_review trusts auth.uid(), never a
 * posted id). Guests get a sign-in link that comes back here. Posts to /api/reviews; every
 * review starts pending, so the success copy says it appears once approved (true, P15).
 */
export function ReviewForm({ productId, productName }: { productId: number; productName: string }) {
  const viewer = useViewer();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<MyReview | null>(null);
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [authorName, setAuthorName] = useState("");
  const [company, setCompany] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [errors, setErrors] = useState<{ rating?: string; body?: string; title?: string; authorName?: string }>({});

  const userId = viewer.status === "signed_in" ? (viewer.user?.id ?? null) : null;

  // The customer's own review of this product (any status) — RLS lets them read their own rows.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const supabase = getBrowserSupabase();
        if (!supabase) return;
        const { data, error } = await supabase
          .from("product_reviews")
          .select("rating, title, body, author_name, status")
          .eq("product_id", productId)
          .eq("customer_id", userId)
          .maybeSingle();
        if (cancelled || error || !data) return;
        const row = data as Record<string, unknown>;
        const status = row.status === "approved" || row.status === "rejected" ? row.status : "pending";
        const review: MyReview = {
          rating: typeof row.rating === "number" ? row.rating : 0,
          title: typeof row.title === "string" ? row.title : null,
          body: typeof row.body === "string" ? row.body : "",
          authorName: typeof row.author_name === "string" ? row.author_name : "",
          status,
        };
        setMine(review);
        setRating(review.rating);
        setTitle(review.title ?? "");
        setBody(review.body);
        setAuthorName(review.authorName);
      } catch {
        // "my review" is a convenience: without it the form simply starts empty
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [userId, productId]);

  if (viewer.status === "loading") {
    return <div aria-hidden className="h-11 w-48 animate-pulse bg-surface-2" />;
  }

  if (viewer.status === "guest") {
    return (
      <p className="text-sm text-ink-2">
        <Link href={`/signin?next=${encodeURIComponent(`/product/${productId}`)}`} className="font-semibold text-violet-ink underline underline-offset-2 hover:text-ink">
          Sign in to write a review
        </Link>
      </p>
    );
  }

  function validate() {
    const next: typeof errors = {};
    if (rating < 1 || rating > 5) next.rating = "Choose 1 to 5 stars.";
    const text = body.trim();
    if (text.length < BODY_MIN || text.length > BODY_MAX) next.body = "Reviews need 10 to 4,000 characters.";
    if (title.trim().length > TITLE_MAX) next.title = "Titles can be up to 120 characters.";
    if (authorName.trim().length > NAME_MAX) next.authorName = "Display names can be up to 60 characters.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setOutcome(null);
    if (!validate()) return;
    setBusy(true);
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, rating, title: title.trim(), body: body.trim(), authorName: authorName.trim(), company }),
      });
      const result = (await response.json().catch(() => null)) as { ok?: boolean; status?: string; error?: string } | null;
      if (!response.ok || !result?.ok) {
        setOutcome({ tone: "error", message: result?.error ?? "We couldn't send your review. Please try again." });
        return;
      }
      const status = result.status === "approved" || result.status === "rejected" ? result.status : "pending";
      setMine({ rating, title: title.trim() || null, body: body.trim(), authorName: authorName.trim(), status });
      setOpen(false);
      setOutcome({
        tone: "success",
        message: status === "approved" ? "Your review is unchanged and still published." : "Thanks! Your review will appear once it's approved.",
      });
    } catch {
      setOutcome({ tone: "error", message: "We couldn't reach the server. Please check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {mine && !open && <p className="mb-3 text-sm text-ink-2">{STATUS_COPY[mine.status]}</p>}
      {outcome && (
        <Notice tone={outcome.tone} className="mb-4">
          {outcome.message}
        </Notice>
      )}
      {!open ? (
        <Button
          aria-expanded={false}
          onClick={() => {
            setOpen(true);
            setOutcome(null);
          }}
        >
          {mine ? "Edit your review" : "Write a review"}
        </Button>
      ) : (
        <form id={formId} onSubmit={submit} noValidate aria-label={`Review ${productName}`} className="space-y-5 border border-line bg-surface p-5">
          <fieldset aria-describedby={errors.rating ? `${formId}-rating-error` : undefined}>
            <legend className="label mb-2 font-semibold">
              Your rating<span aria-hidden className="ml-1 text-violet-ink">*</span>
            </legend>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((star) => (
                <label key={star} className="grid size-10 cursor-pointer place-items-center has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-violet">
                  <input type="radio" name={`${formId}-rating`} value={star} checked={rating === star} onChange={() => setRating(star)} className="sr-only" />
                  <Star aria-hidden className={`size-6 transition-colors ${star <= rating ? "fill-ink text-ink" : "text-mute"}`} />
                  <span className="sr-only">{star} {star === 1 ? "star" : "stars"}</span>
                </label>
              ))}
            </div>
            {errors.rating && (
              <p id={`${formId}-rating-error`} role="alert" className="mt-2 text-xs text-ink">
                <span aria-hidden className="mr-1 bg-ink px-1 font-mono text-paper">!</span>
                {errors.rating}
              </p>
            )}
          </fieldset>
          <Field label="Title" optional error={errors.title}>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={TITLE_MAX} autoComplete="off" />
          </Field>
          <Field label="Your review" required hint={`${body.trim().length} / ${BODY_MAX.toLocaleString("en-US")} characters (at least ${BODY_MIN})`} error={errors.body}>
            <Textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={BODY_MAX} rows={5} />
          </Field>
          <Field label="Display name" optional hint="Shown with your review. Leave blank to use your first name and last initial." error={errors.authorName}>
            <Input value={authorName} onChange={(event) => setAuthorName(event.target.value)} maxLength={NAME_MAX} autoComplete="nickname" />
          </Field>
          {/* honeypot: only bots fill it (blueprint §6.3) */}
          <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
            <label>
              Company
              <input tabIndex={-1} autoComplete="off" value={company} onChange={(event) => setCompany(event.target.value)} name="company" />
            </label>
          </div>
          <p className="text-xs text-mute">Reviews are checked before they appear. {mine ? "Editing sends your review back for approval." : ""}</p>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={busy} aria-busy={busy}>
              {busy ? "Sending…" : mine ? "Update review" : "Submit review"}
            </Button>
            <button type="button" onClick={() => setOpen(false)} className="label h-11 px-3 font-semibold text-mute hover:text-ink">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
