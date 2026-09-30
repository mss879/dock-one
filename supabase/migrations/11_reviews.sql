-- ═════════════════════════════════════════════════════════════════════════════
-- 11_reviews.sql — Dock One Solutions
--
-- PURPOSE      Real product reviews behind the star ratings the approved design shows (P15:
--              ratings and review counts must come from real rows). One review per signed-in
--              customer per product, submitted only through submit_review() (in-DB rate limit,
--              verified-purchase flag from a DELIVERED order), held as `pending` until an admin
--              approves it; editing a review sends it back to moderation. A trigger keeps
--              products.rating_avg / rating_count equal to the APPROVED reviews (through 04's
--              _apply_product_rating(), the only writer of those columns).
--              get_review_summary() gives the star distribution for the product page.
--              A guard trigger keeps admin moderation honest: admins approve / reject /
--              feature / reply / delete, but cannot create reviews or rewrite a customer's
--              words, rating or verified-purchase flag.
--              BUILD_SPEC §2(c), §9 WP-J; blueprint §7 conventions.
-- DEPENDS ON   01_foundation (_rate_limit_hit, touch_updated_at), 02_customers_and_auth
--              (customers, is_admin()), 04_catalogue (products, _apply_product_rating),
--              07_orders (orders + order_items for the verified-purchase check).
-- ENABLES      /api/reviews (submit), components/reviews/ProductReviews (summary + list + form),
--              admin Reviews tab (approve / reject / feature / reply), homepage testimonial
--              (newest featured approved review), Product JSON-LD aggregateRating (WP-A).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.product_reviews (
  id                   BIGSERIAL PRIMARY KEY,
  product_id           INT NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  customer_id          UUID REFERENCES public.customers (id) ON DELETE SET NULL,  -- NULL once the account is deleted
  author_name          TEXT NOT NULL,                  -- shown publicly ("Nimal P.")
  rating               SMALLINT NOT NULL,
  title                TEXT,
  body                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending',
  is_verified_purchase BOOLEAN NOT NULL DEFAULT FALSE,  -- set by submit_review from a DELIVERED order
  is_featured          BOOLEAN NOT NULL DEFAULT FALSE,  -- admin: homepage testimonial candidate
  admin_reply          TEXT,                            -- public reply from the store
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_reviews_rating_valid CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT product_reviews_status_valid CHECK (status IN ('pending', 'approved', 'rejected')),
  CONSTRAINT product_reviews_text_lengths CHECK (
        char_length(btrim(author_name)) BETWEEN 1 AND 60
    AND (title IS NULL OR char_length(title) <= 120)
    AND char_length(btrim(body)) BETWEEN 10 AND 4000
    AND (admin_reply IS NULL OR char_length(admin_reply) <= 2000))
);
-- One review per customer per product (the upsert in submit_review repeats this predicate).
CREATE UNIQUE INDEX IF NOT EXISTS product_reviews_one_per_customer
  ON public.product_reviews (product_id, customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_reviews_product_approved_idx
  ON public.product_reviews (product_id, created_at DESC) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS product_reviews_moderation_idx ON public.product_reviews (status, created_at DESC);
CREATE INDEX IF NOT EXISTS product_reviews_featured_idx
  ON public.product_reviews (created_at DESC) WHERE is_featured AND status = 'approved';
CREATE INDEX IF NOT EXISTS product_reviews_customer_idx ON public.product_reviews (customer_id);

DROP TRIGGER IF EXISTS product_reviews_touch ON public.product_reviews;
CREATE TRIGGER product_reviews_touch BEFORE UPDATE ON public.product_reviews
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Honesty guard (P15: ratings, counts and the "verified purchase" badge must be real). RLS gives
-- admins ALL on reviews for moderation; this trigger narrows that to moderation:
--   * INSERT through the API is refused (42501): reviews are written only by submit_review();
--   * an API UPDATE may change status, is_featured and admin_reply only — the customer's words,
--     rating, public name, product and verified flag are theirs (22023 naming the column);
--   * customer_id may only become NULL through the foreign key (the account was deleted);
--   * is_featured is cleared whenever a review is not approved (a rejected or re-moderated
--     edit never stays featured; re-feature it after approving the new text).
-- Writers that pass: submit_review() (sets app.trusted_write for its statement) and callers with
-- no JWT (SQL editor, jobs: auth.uid() IS NULL). DELETE is not guarded (admins remove spam).
CREATE OR REPLACE FUNCTION public.product_reviews_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_col TEXT;
BEGIN
  NEW.is_featured := NEW.is_featured AND NEW.status = 'approved';
  IF auth.uid() IS NULL OR current_setting('app.trusted_write', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'review_insert_managed:reviews are submitted only through submit_review';
  END IF;
  v_col := CASE
    WHEN NEW.id                   IS DISTINCT FROM OLD.id                   THEN 'id'
    WHEN NEW.product_id           IS DISTINCT FROM OLD.product_id           THEN 'product_id'
    WHEN NEW.author_name          IS DISTINCT FROM OLD.author_name          THEN 'author_name'
    WHEN NEW.rating               IS DISTINCT FROM OLD.rating               THEN 'rating'
    WHEN NEW.title                IS DISTINCT FROM OLD.title                THEN 'title'
    WHEN NEW.body                 IS DISTINCT FROM OLD.body                 THEN 'body'
    WHEN NEW.is_verified_purchase IS DISTINCT FROM OLD.is_verified_purchase THEN 'is_verified_purchase'
    WHEN NEW.created_at           IS DISTINCT FROM OLD.created_at           THEN 'created_at'
  END;
  IF v_col IS NULL AND NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    IF NEW.customer_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.customers c WHERE c.id = OLD.customer_id) THEN
      v_col := 'customer_id';
    END IF;
  END IF;
  IF v_col IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'review_field_managed:' || v_col || ' belongs to the customer; moderation changes status, is_featured and admin_reply only';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.product_reviews_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS product_reviews_10_guard ON public.product_reviews;
CREATE TRIGGER product_reviews_10_guard BEFORE INSERT OR UPDATE ON public.product_reviews
  FOR EACH ROW EXECUTE FUNCTION public.product_reviews_guard();

-- Rating rollup: products.rating_avg / rating_count = the APPROVED reviews, recomputed for the
-- affected product(s) whenever a review is added, removed, moved, re-rated or (un)approved.
-- Definer: moderation runs as the admin's role, and _apply_product_rating is not granted.
CREATE OR REPLACE FUNCTION public.refresh_product_rating(p_product_id INT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_avg NUMERIC;
  v_n   INT;
BEGIN
  IF p_product_id IS NULL THEN RETURN; END IF;
  SELECT avg(rating), count(*)::INT INTO v_avg, v_n
    FROM public.product_reviews
   WHERE product_id = p_product_id AND status = 'approved';
  PERFORM public._apply_product_rating(p_product_id, v_avg, v_n);
END $$;
REVOKE ALL ON FUNCTION public.refresh_product_rating(INT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.product_reviews_rollup() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.refresh_product_rating(OLD.product_id);
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.product_id = OLD.product_id AND NEW.status = OLD.status AND NEW.rating = OLD.rating THEN
    RETURN NULL;                                        -- text-only edits don't move the average
  END IF;
  PERFORM public.refresh_product_rating(NEW.product_id);
  IF TG_OP = 'UPDATE' AND NEW.product_id <> OLD.product_id THEN
    PERFORM public.refresh_product_rating(OLD.product_id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.product_reviews_rollup() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS product_reviews_rollup ON public.product_reviews;
CREATE TRIGGER product_reviews_rollup AFTER INSERT OR UPDATE OR DELETE ON public.product_reviews
  FOR EACH ROW EXECUTE FUNCTION public.product_reviews_rollup();

-- RLS: everyone reads APPROVED reviews; a shopper also reads their own (pending/rejected);
-- admins read, moderate and delete everything (product_reviews_10_guard limits WHAT they can
-- change). Shoppers write only through submit_review().
ALTER TABLE public.product_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.product_reviews FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.product_reviews FROM authenticated;
REVOKE ALL ON SEQUENCE public.product_reviews_id_seq FROM anon;
-- anon reads every column EXCEPT customer_id (the public storefront never receives account
-- ids). Consequence: anon must name its columns — `select('*')` on product_reviews fails with
-- 42501 for anon. Signed-in callers keep the column (the owner-read policy and "my review"
-- queries filter on it; the admin links reviews to accounts), so a signed-in shopper CAN read
-- the customer_id of approved reviews. An account id is an identifier, never a credential:
-- no function may trust one supplied by a caller (use auth.uid()).
GRANT SELECT (id, product_id, author_name, rating, title, body, status, is_verified_purchase,
              is_featured, admin_reply, created_at, updated_at)
  ON public.product_reviews TO anon;

DROP POLICY IF EXISTS product_reviews_public_read ON public.product_reviews;
CREATE POLICY product_reviews_public_read ON public.product_reviews
  FOR SELECT TO anon, authenticated USING (status = 'approved');
DROP POLICY IF EXISTS product_reviews_owner_read ON public.product_reviews;
CREATE POLICY product_reviews_owner_read ON public.product_reviews
  FOR SELECT TO authenticated USING (customer_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS product_reviews_admin_all ON public.product_reviews;
CREATE POLICY product_reviews_admin_all ON public.product_reviews
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- Submit or edit the caller's review of a product. Signed-in customers only (grant U + a
-- customers row). Throttled in the database: 5 successful submissions per hour per account
-- (a refused submission rolls back and costs nothing). A resubmission with changed content goes
-- back to 'pending'; an identical resubmission keeps its status.
-- Verified purchase = the customer (by account, or by their CONFIRMED sign-in email) has a
-- DELIVERED order containing this product.
-- Errors (P0001): not_signed_in · rate_limited · unknown_product · invalid_rating ·
--   invalid_title · invalid_body · invalid_author_name
-- Returns {review_id, status, is_verified_purchase}.
CREATE OR REPLACE FUNCTION public.submit_review(
  p_product_id  INT,
  p_rating      INT,
  p_title       TEXT,
  p_body        TEXT,
  p_author_name TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid      UUID := auth.uid();
  c          public.customers%ROWTYPE;
  v_title    TEXT := NULLIF(btrim(COALESCE(p_title, '')), '');
  v_body     TEXT := btrim(COALESCE(p_body, ''));
  v_author   TEXT := NULLIF(btrim(COALESCE(p_author_name, '')), '');
  v_email    TEXT;
  v_verified BOOLEAN;
  v_id       BIGINT;
  v_status   TEXT;
  v_prev_trust TEXT := current_setting('app.trusted_write', true);
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_signed_in';
  END IF;
  SELECT * INTO c FROM public.customers WHERE id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_signed_in';
  END IF;
  IF NOT public._rate_limit_hit('review:user:' || v_uid::TEXT, 5, 3600) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF p_product_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.products p
                                          WHERE p.id = p_product_id AND p.is_active AND p.variant_count > 0) THEN
    RAISE EXCEPTION 'unknown_product';
  END IF;
  IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'invalid_rating';
  END IF;
  IF char_length(COALESCE(v_title, '')) > 120 THEN
    RAISE EXCEPTION 'invalid_title';
  END IF;
  IF char_length(v_body) NOT BETWEEN 10 AND 4000 THEN
    RAISE EXCEPTION 'invalid_body';
  END IF;
  -- Default public name: "First L." from the profile.
  v_author := COALESCE(v_author,
                       NULLIF(btrim(concat_ws(' ', NULLIF(btrim(c.first_name), ''),
                                              CASE WHEN NULLIF(btrim(c.last_name), '') IS NOT NULL
                                                   THEN left(btrim(c.last_name), 1) || '.' END)), ''));
  IF v_author IS NULL OR char_length(v_author) > 60 THEN
    RAISE EXCEPTION 'invalid_author_name';
  END IF;

  SELECT lower(u.email) INTO v_email FROM auth.users u WHERE u.id = v_uid AND u.email_confirmed_at IS NOT NULL;
  v_verified := EXISTS (
    SELECT 1
      FROM public.order_items i
      JOIN public.orders o ON o.id = i.order_id
     WHERE i.product_id = p_product_id
       AND o.status = 'delivered'
       AND (o.customer_id = v_uid OR (v_email IS NOT NULL AND lower(o.email) = v_email)));

  PERFORM set_config('app.trusted_write', 'on', true);          -- passes product_reviews_10_guard
  INSERT INTO public.product_reviews AS pr
         (product_id, customer_id, author_name, rating, title, body, status, is_verified_purchase)
  VALUES (p_product_id, v_uid, v_author, p_rating::SMALLINT, v_title, v_body, 'pending', v_verified)
  ON CONFLICT (product_id, customer_id) WHERE customer_id IS NOT NULL DO UPDATE
     SET author_name          = EXCLUDED.author_name,
         rating               = EXCLUDED.rating,
         title                = EXCLUDED.title,
         body                 = EXCLUDED.body,
         is_verified_purchase = EXCLUDED.is_verified_purchase,
         status = CASE WHEN (pr.author_name, pr.rating, pr.title, pr.body)
                            IS NOT DISTINCT FROM
                            (EXCLUDED.author_name, EXCLUDED.rating, EXCLUDED.title, EXCLUDED.body)
                       THEN pr.status ELSE 'pending' END
  RETURNING pr.id, pr.status INTO v_id, v_status;
  PERFORM set_config('app.trusted_write', COALESCE(v_prev_trust, ''), true);

  RETURN jsonb_build_object('review_id', v_id, 'status', v_status, 'is_verified_purchase', v_verified);
END $$;
REVOKE ALL ON FUNCTION public.submit_review(INT, INT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_review(INT, INT, TEXT, TEXT, TEXT) TO authenticated;

-- Star distribution for the product page (approved reviews only). Never raises.
-- → {product_id, total, average (2 dp, 0 when none), counts: {"1": n, …, "5": n}}
CREATE OR REPLACE FUNCTION public.get_review_summary(p_product_id INT)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
           'product_id', p_product_id,
           'total',      count(*),
           'average',    COALESCE(round(avg(r.rating), 2), 0),
           'counts',     jsonb_build_object(
                           '1', count(*) FILTER (WHERE r.rating = 1),
                           '2', count(*) FILTER (WHERE r.rating = 2),
                           '3', count(*) FILTER (WHERE r.rating = 3),
                           '4', count(*) FILTER (WHERE r.rating = 4),
                           '5', count(*) FILTER (WHERE r.rating = 5)))
    FROM public.product_reviews r
   WHERE r.product_id = p_product_id AND r.status = 'approved'
$$;
REVOKE ALL ON FUNCTION public.get_review_summary(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_review_summary(INT) TO anon, authenticated;

-- Re-sync every product's rating from its approved reviews (idempotent; a no-op on a fresh
-- database, a repair if ratings were ever edited outside the rollup).
DO $$
DECLARE
  v_pid INT;
BEGIN
  FOR v_pid IN
    SELECT p.id
      FROM public.products p
      LEFT JOIN (SELECT r.product_id, round(avg(r.rating), 2) AS avg_rating, count(*)::INT AS n
                   FROM public.product_reviews r
                  WHERE r.status = 'approved'
                  GROUP BY r.product_id) a ON a.product_id = p.id
     WHERE (p.rating_avg, p.rating_count) IS DISTINCT FROM (COALESCE(a.avg_rating, 0), COALESCE(a.n, 0))
  LOOP
    PERFORM public.refresh_product_rating(v_pid);
  END LOOP;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 11_reviews
--   Nothing to configure. Reviews appear on the storefront only after an admin approves them
--   (admin Reviews tab: UPDATE product_reviews SET status = 'approved' | 'rejected',
--   is_featured, admin_reply — then revalidate the `reviews` and `catalogue` tags). Any other
--   column edited from the app is refused (22023 review_field_managed:<column>), and reviews
--   cannot be created from the app except by the customer through submit_review. No reviews
--   are seeded: stars show only when real approved reviews exist.
--   Verification:
--     SELECT status, count(*) FROM public.product_reviews GROUP BY 1;
--     SELECT p.slug, p.rating_avg, p.rating_count FROM public.products p
--       LEFT JOIN (SELECT product_id, round(avg(rating), 2) AS a, count(*)::INT AS n
--                    FROM public.product_reviews WHERE status = 'approved' GROUP BY product_id) r
--              ON r.product_id = p.id
--      WHERE (p.rating_avg, p.rating_count) IS DISTINCT FROM (COALESCE(r.a, 0), COALESCE(r.n, 0));  -- 0 rows
--     SELECT has_function_privilege('anon', 'public.submit_review(integer,integer,text,text,text)', 'EXECUTE');  -- false
--     -- verified purchase by CONFIRMED email reads auth.users as the function owner:
--     SELECT has_table_privilege(p.proowner::regrole::text, 'auth.users', 'SELECT')
--       FROM pg_proc p WHERE p.oid = 'public.submit_review(integer,integer,text,text,text)'::regprocedure;  -- true
--     -- live probes (anon key is public):
--     curl -s "$SUPABASE_URL/rest/v1/product_reviews?select=customer_id" -H "apikey: $ANON"   -- permission denied
--     curl -s "$SUPABASE_URL/rest/v1/rpc/get_review_summary" -H "apikey: $ANON" -H "Content-Type: application/json" \
--          -d '{"p_product_id":1}'                                                     -- {"total":0,…}
-- ═════════════════════════════════════════════════════════════════════════════
