import { revalidateTag } from "next/cache";
import type { NextRequest } from "next/server";
import { CACHE_TAGS } from "@/lib/cache";
import { toProductId } from "@/lib/catalogue-shared";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { checkRateLimit, ipBucket } from "@/lib/rate-limit";
import { cleanLine, cleanText, isBot, isPlainObject, readJsonBody, toInt } from "@/lib/request-guard";
import { getApprovedReviews, MAX_REVIEW_PAGE } from "@/lib/reviews";
import { logDbError, mapRpcError, parseDbError, type ErrorTable } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";
import { createSessionSupabase } from "@/lib/supabase/session";

/**
 * /api/reviews (WP-J; contract: docs/build/SQL_NOTES.md → 11_reviews.sql)
 *
 *   GET  ?productId=<id>&page=<n>  → one page of APPROVED reviews (the product page's "show more")
 *   POST { productId, rating, title?, body, authorName?, company }  → submit_review()
 *
 * POST follows blueprint §6.7: 16 KB body cap → honeypot (answered exactly like a success) →
 * per-IP limit before any database work → validate/clamp → ONE RPC with the SESSION client
 * (submit_review trusts auth.uid() only; it also throttles per account in the database) →
 * mapped error codes. Every review starts `pending`, so nothing on the storefront changes —
 * except when an APPROVED review is edited (it goes back to moderation): then the cached
 * reviews and ratings are refreshed.
 */

const MIGRATION = "11_reviews.sql";
const BODY_LIMIT = 16 * 1024;

/** submit_review's codes (P0001) → shopper copy (SQL_NOTES → 11_reviews.sql). */
const COPY = {
  not_signed_in: "Please sign in to write a review.",
  rate_limited: "You've sent several reviews just now — please try again later.",
  unknown_product: "This product isn't available for reviews.",
  invalid_rating: "Choose 1 to 5 stars.",
  invalid_title: "Titles can be up to 120 characters.",
  invalid_body: "Reviews need 10 to 4,000 characters.",
  invalid_author_name: "Add a display name (up to 60 characters).",
} as const;

const ERRORS: ErrorTable = {
  not_signed_in: { status: 401, message: COPY.not_signed_in },
  rate_limited: { status: 429, message: COPY.rate_limited },
  unknown_product: { status: 404, message: COPY.unknown_product },
  invalid_rating: { status: 422, message: COPY.invalid_rating },
  invalid_title: { status: 422, message: COPY.invalid_title },
  invalid_body: { status: 422, message: COPY.invalid_body },
  invalid_author_name: { status: 422, message: COPY.invalid_author_name },
};

export async function GET(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);
  const params = request.nextUrl.searchParams;
  const productId = toProductId(params.get("productId"));
  const page = toInt(params.get("page") ?? "1", 1, MAX_REVIEW_PAGE);
  if (productId === null || page === null) return json({ error: MESSAGES.invalid }, 422);

  if (!(await checkRateLimit(createServerSupabase(), ipBucket("reviews-read", request), 60, 60))) {
    return json({ error: MESSAGES.slowDown }, 429);
  }

  const result = await getApprovedReviews(productId, { page });
  if (!result) return json({ error: "Reviews can't be loaded right now. Please try again shortly." }, 503);
  return json(result);
}

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);

  const parsed = await readJsonBody(request, BODY_LIMIT); // 1. bounded read
  if (!parsed.ok) return json({ error: parsed.status === 413 ? MESSAGES.tooLarge : MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const body = parsed.body;

  if (isBot(body.company)) return json({ ok: true, status: "pending", verified: false }); // 2. honeypot

  if (!(await checkRateLimit(createServerSupabase(), ipBucket("reviews", request), 10, 3600))) {
    return json({ error: MESSAGES.slowDown }, 429); // 3. throttle BEFORE db work
  }

  // 4. validate, trim, clamp (the SQL re-checks every rule)
  const productId = toProductId(body.productId);
  if (productId === null) return json({ error: COPY.unknown_product }, 422);
  const rating = toInt(body.rating, 1, 5);
  if (rating === null) return json({ error: COPY.invalid_rating }, 422);
  const title = cleanLine(body.title, 200);
  if (title.length > 120) return json({ error: COPY.invalid_title }, 422);
  const text = cleanText(body.body, 4100);
  if (text.length < 10 || text.length > 4000) return json({ error: COPY.invalid_body }, 422);
  const authorName = cleanLine(body.authorName, 100);
  if (authorName.length > 60) return json({ error: COPY.invalid_author_name }, 422);

  const supabase = await createSessionSupabase();
  let userId: string | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id ?? null;
  } catch {
    userId = null;
  }
  if (!userId) return json({ error: COPY.not_signed_in }, 401);

  // Was this customer's review of the product already published? (their own row — RLS owner read)
  let wasApproved = false;
  try {
    const previous = await supabase.from("product_reviews").select("status").eq("product_id", productId).eq("customer_id", userId).maybeSingle();
    wasApproved = !previous.error && (previous.data as { status?: string } | null)?.status === "approved";
  } catch {
    wasApproved = false;
  }

  const { data, error } = await supabase.rpc("submit_review", {
    p_product_id: productId,
    p_rating: rating,
    p_title: title || null,
    p_body: text,
    p_author_name: authorName || null,
  }); // 5. ONE trusted write
  if (error) {
    const mapped = mapRpcError(error, ERRORS); // 6. code → copy + status
    const { code } = parseDbError(error.message);
    if (!code || !Object.prototype.hasOwnProperty.call(ERRORS, code)) logDbError("api.reviews", error, MIGRATION);
    return json({ error: mapped.message }, mapped.status);
  }

  const result = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const status = result.status === "approved" || result.status === "rejected" ? result.status : "pending";

  // 7. fail-soft side effect: an edited, previously published review left the storefront.
  if (wasApproved && status !== "approved") {
    try {
      revalidateTag(CACHE_TAGS.reviews, { expire: 0 });
      revalidateTag(CACHE_TAGS.catalogue, { expire: 0 });
    } catch (revalidateError) {
      console.error("[api.reviews] storefront refresh failed", revalidateError);
    }
  }

  return json({ ok: true, status, verified: result.is_verified_purchase === true });
}
