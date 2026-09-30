-- ═════════════════════════════════════════════════════════════════════════════
-- 17_analytics.sql — Dock One Solutions
--
-- PURPOSE      First-party analytics (blueprint §12, §11.2 Dashboard, §11.3.6, Appendix A 13):
--                analytics_events      the behaviour the server cannot see (views, searches, cart
--                                      clicks…), written ONLY by track_event()
--                track_event()         allowlisted types, clamped sizes, per-session + global
--                                      throttles, customer from auth.uid(), swallows every error
--              and the admin dashboard aggregates (admin re-checked inside → 42501; windows
--              clamped; business time zone Asia/Colombo):
--                admin_sales_overview(p_from, p_to)   revenue, orders, AOV, cancelled, daily series
--                admin_funnel(p_days)                 sessions → product view → add to cart →
--                                                     begin checkout → orders
--                admin_top_products(p_days, p_limit)  top viewed vs top sold
--                admin_search_terms(p_days, p_limit)  top searches + zero-result searches ("stock this")
--                admin_low_stock(p_limit)             tracked variants at or under their threshold
--                admin_recovery_stats(p_days)         carts captured → reminded (by stage) → converted
--                admin_newsletter_growth(p_days)      subscribers by source + daily sign-ups
--                admin_order_status_counts()          orders per status + open
--
-- METRIC DEFINITIONS (blueprint §11.3.6 — "define metrics once and write them down"):
--   business day       a calendar day in Asia/Colombo (public._business_tz()); every date range and
--                      daily bucket uses it. p_days windows = the last p_days business days
--                      INCLUDING today: from local midnight (p_days − 1) days ago until now.
--   revenue            Σ orders.total_price (LKR charged: subtotal − discount + delivery) of orders
--                      whose status is NOT 'cancelled', placed in the range. packing_charges are the
--                      store's own cost, never part of total_price, so they are not in revenue.
--   orders             count of those same non-cancelled orders.
--   AOV                revenue / orders (2 dp; 0 when there are no orders).
--   cancelled          count of orders placed in the range that are now 'cancelled'.
--   open order         status not in ('delivered', 'cancelled').
--   funnel step        DISTINCT analytics sessions (session_id) with at least one event of that
--                      type in the window; "sessions" = distinct sessions with any event; "orders"
--                      = non-cancelled orders placed in the window (the funnel reads orders — a
--                      purchase is never a client event). Client events exist only for shoppers who
--                      accepted analytics cookies, so the order step can exceed the others.
--   views              count of product_view events for the product in the window.
--   units sold         Σ order_items.quantity of non-cancelled orders placed in the window.
--   search term        lower-cased, trimmed, whitespace-collapsed metadata.query (≤ 100 chars);
--   zero-result search a search event whose metadata.results (or, when absent, value) is 0.
--   low stock          a TRACKED variant (inventory row) of an active product, itself active, with
--                      stock_level ≤ low_stock_threshold (0 = sold out).
--   recovery           carts CREATED in the window: captured = all; with_items = non-empty;
--                      reminded_N = reached stage ≥ N; converted = marked converted by place_order;
--                      converted_after_reminder = converted with stage ≥ 1; opted_out;
--                      recovered_revenue = Σ total_price of the non-cancelled orders those
--                      reminded-then-converted carts became.
--   newsletter         total / active (unsubscribed_at IS NULL) / new (created in the window) /
--                      unsubscribed in the window, overall and per source; daily = new sign-ups.
-- DEPENDS ON   01_foundation (_rate_limit_hit), 02_customers_and_auth (is_admin()), 04_catalogue,
--              05_inventory, 07_orders, 12_leads (newsletter_subscribers), 13_abandoned_carts.
-- ENABLES      POST /api/events + src/lib/analytics.ts track() (EVENT_TYPES must equal the CHECK
--              below), admin Dashboard + Reports tabs (WP-H), retention of events (22),
--              assistant insights reuse _business_tz() / _business_window_start() (19, 20).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Business time helpers (internal, no grants) — the ONE place the time zone is named
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._business_tz() RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT 'Asia/Colombo'::TEXT          -- BUILD_SPEC §1 TIMEZONE (the admin UI uses the same zone)
$$;
REVOKE ALL ON FUNCTION public._business_tz() FROM PUBLIC, anon, authenticated;

-- Local midnight (Asia/Colombo) (p_days − 1) days ago: the start of a window of p_days business
-- days including today. p_days clamped 1..365 (NULL → 30).
CREATE OR REPLACE FUNCTION public._business_window_start(p_days INT) RETURNS TIMESTAMPTZ
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT (((now() AT TIME ZONE public._business_tz())::DATE
           - (LEAST(GREATEST(COALESCE(p_days, 30), 1), 365) - 1))::TIMESTAMP) AT TIME ZONE public._business_tz()
$$;
REVOKE ALL ON FUNCTION public._business_window_start(INT) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The event log
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.analytics_events (
  id          BIGSERIAL PRIMARY KEY,
  event_type  TEXT NOT NULL,
  session_id  UUID NOT NULL,                  -- the browser's analytics session (rotated after 30 min idle)
  customer_id UUID,                           -- auth.uid() when the beacon carried a session cookie
  product_id  INT,                            -- no FK: events outlive deleted products
  value       NUMERIC(12,2),                  -- LKR value for commerce events; the result count for search
  page        TEXT,                           -- the path (no query string, no fragment)
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,   -- small, non-PII context (≤ 2 KB)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- = EVENT_TYPES in src/lib/analytics.ts (BUILD_SPEC §5). Change both together.
  CONSTRAINT analytics_events_type_valid CHECK (event_type IN (
    'page_view', 'product_view', 'category_view', 'collection_view', 'search', 'add_to_cart',
    'remove_from_cart', 'begin_checkout', 'wishlist_add', 'finder_complete', 'assistant_open',
    'newsletter_signup')),
  CONSTRAINT analytics_events_metadata_object CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX IF NOT EXISTS analytics_events_time_idx    ON public.analytics_events (created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_type_idx    ON public.analytics_events (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_product_idx ON public.analytics_events (product_id, created_at DESC) WHERE product_id IS NOT NULL;

-- Written only by track_event(). Admins read (for their own ad-hoc queries); nobody writes
-- through the API — not even admins (the numbers must be the shoppers' own).
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analytics_events FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.analytics_events FROM authenticated;
REVOKE ALL ON SEQUENCE public.analytics_events_id_seq FROM anon, authenticated;
DROP POLICY IF EXISTS analytics_events_admin_read ON public.analytics_events;
CREATE POLICY analytics_events_admin_read ON public.analytics_events
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

-- Fire-and-forget (POST /api/events answers 204 whatever happens). Purchases are NOT client events:
-- the funnel reads orders.
--   * unknown event types and a NULL session are dropped silently (before any throttle is spent);
--   * throttles: 300 events per session per hour, 50 000 per hour store-wide (then dropped);
--   * customer_id = auth.uid() — call with the cookie session client so signed-in shoppers attach;
--   * product_id kept when > 0; value kept when 0..100 000 000 (LKR), rounded to 2 dp;
--   * page: query string and fragment removed (PII never in URLs), trimmed, ≤ 200 chars;
--   * metadata kept when a JSON object ≤ 2 KB, else {}.
-- Never raises: any error is swallowed (analytics must never cost the shopper anything).
CREATE OR REPLACE FUNCTION public.track_event(
  p_session_id UUID,
  p_event_type TEXT,
  p_product_id INT     DEFAULT NULL,
  p_value      NUMERIC DEFAULT NULL,
  p_page       TEXT    DEFAULT NULL,
  p_metadata   JSONB   DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  -- Only /api/events writes events: a direct PostgREST call is dropped (01, P3).
  IF NOT public._trusted_route_call() THEN RETURN; END IF;
  IF p_session_id IS NULL THEN RETURN; END IF;
  IF NOT COALESCE(p_event_type IN (
       'page_view', 'product_view', 'category_view', 'collection_view', 'search', 'add_to_cart',
       'remove_from_cart', 'begin_checkout', 'wishlist_add', 'finder_complete', 'assistant_open',
       'newsletter_signup'), FALSE) THEN
    RETURN;
  END IF;
  IF NOT public._rate_limit_hit('events:sess:' || p_session_id::TEXT, 300, 3600) THEN RETURN; END IF;
  IF NOT public._rate_limit_hit('events:global', 50000, 3600) THEN RETURN; END IF;
  INSERT INTO public.analytics_events (event_type, session_id, customer_id, product_id, value, page, metadata)
  VALUES (p_event_type, p_session_id, auth.uid(),
          CASE WHEN p_product_id > 0 THEN p_product_id END,
          CASE WHEN p_value >= 0 AND p_value <= 100000000 THEN round(p_value, 2) END,
          NULLIF(left(btrim(split_part(split_part(p_page, '?', 1), '#', 1)), 200), ''),
          CASE WHEN jsonb_typeof(p_metadata) = 'object' AND octet_length(p_metadata::TEXT) <= 2048
               THEN p_metadata ELSE '{}'::jsonb END);
EXCEPTION WHEN OTHERS THEN
  RETURN;   -- analytics must never cost the shopper anything
END $$;
REVOKE ALL ON FUNCTION public.track_event(UUID, TEXT, INT, NUMERIC, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.track_event(UUID, TEXT, INT, NUMERIC, TEXT, JSONB) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Admin aggregates (grant U; admin re-checked inside: 42501 not_authorised)
-- ─────────────────────────────────────────────────────────────────────────────

-- Sales for an inclusive range of business days. NULL p_to → today; NULL p_from → p_to − 29;
-- reversed dates are swapped; ranges longer than 366 days keep the LAST 366; dates are clamped to
-- 2000-01-01..2999-12-31.
-- → {from, to, timezone, currency: "LKR", revenue, orders, aov, cancelled,
--    daily: [{day: "YYYY-MM-DD", orders, revenue}]}   (one entry per day of the range, zeros included)
CREATE OR REPLACE FUNCTION public.admin_sales_overview(p_from DATE DEFAULT NULL, p_to DATE DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tz    TEXT := public._business_tz();
  v_today DATE := (now() AT TIME ZONE public._business_tz())::DATE;
  v_to    DATE;
  v_from  DATE;
  v_swap  DATE;
  v_start TIMESTAMPTZ;
  v_end   TIMESTAMPTZ;
  v_out   JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read sales figures.';
  END IF;
  v_to   := LEAST(GREATEST(COALESCE(p_to, v_today), DATE '2000-01-01'), DATE '2999-12-31');
  v_from := LEAST(GREATEST(COALESCE(p_from, v_to - 29), DATE '2000-01-01'), DATE '2999-12-31');
  IF v_from > v_to THEN
    v_swap := v_from; v_from := v_to; v_to := v_swap;
  END IF;
  IF v_to - v_from > 365 THEN
    v_from := v_to - 365;
  END IF;
  v_start := v_from::TIMESTAMP AT TIME ZONE v_tz;
  v_end   := (v_to + 1)::TIMESTAMP AT TIME ZONE v_tz;

  WITH o AS (
    SELECT (created_at AT TIME ZONE v_tz)::DATE AS day, status, total_price
      FROM public.orders
     WHERE created_at >= v_start AND created_at < v_end
  ), per_day AS (
    SELECT day, count(*) AS orders, sum(total_price) AS revenue
      FROM o WHERE status <> 'cancelled' GROUP BY day
  ), totals AS (
    SELECT COALESCE(sum(total_price) FILTER (WHERE status <> 'cancelled'), 0) AS revenue,
           count(*) FILTER (WHERE status <> 'cancelled')                     AS orders,
           count(*) FILTER (WHERE status = 'cancelled')                      AS cancelled
      FROM o
  )
  SELECT jsonb_build_object(
           'from', v_from, 'to', v_to, 'timezone', v_tz, 'currency', 'LKR',
           'revenue',   t.revenue,
           'orders',    t.orders,
           'aov',       CASE WHEN t.orders > 0 THEN round(t.revenue / t.orders, 2) ELSE 0 END,
           'cancelled', t.cancelled,
           'daily', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                              'day', d.day, 'orders', COALESCE(x.orders, 0), 'revenue', COALESCE(x.revenue, 0))
                              ORDER BY d.day), '[]'::jsonb)
                       FROM (SELECT g::DATE AS day FROM generate_series(v_from, v_to, interval '1 day') g) d
                       LEFT JOIN per_day x ON x.day = d.day))
    INTO v_out
    FROM totals t;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_sales_overview(DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_sales_overview(DATE, DATE) TO authenticated;

-- → {days, since, timezone, sessions, product_view, add_to_cart, begin_checkout, orders}
CREATE OR REPLACE FUNCTION public.admin_funnel(p_days INT DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_days  INT := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_since TIMESTAMPTZ := public._business_window_start(p_days);
  v_out   JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read the funnel.';
  END IF;
  SELECT jsonb_build_object(
           'days', v_days, 'since', v_since, 'timezone', public._business_tz(),
           'sessions',       count(DISTINCT e.session_id),
           'product_view',   count(DISTINCT e.session_id) FILTER (WHERE e.event_type = 'product_view'),
           'add_to_cart',    count(DISTINCT e.session_id) FILTER (WHERE e.event_type = 'add_to_cart'),
           'begin_checkout', count(DISTINCT e.session_id) FILTER (WHERE e.event_type = 'begin_checkout'),
           'orders', (SELECT count(*) FROM public.orders o WHERE o.created_at >= v_since AND o.status <> 'cancelled'))
    INTO v_out
    FROM public.analytics_events e
   WHERE e.created_at >= v_since;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_funnel(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_funnel(INT) TO authenticated;

-- Top viewed vs top sold. p_limit 1..50 (NULL → 10).
-- → {days, since, top_viewed: [{product_id, slug, name, brand, views, units_sold}],
--                 top_sold:   [{product_id, slug, name, brand, units_sold, views}]}
--   (slug/name/brand are NULL for a product that no longer exists)
CREATE OR REPLACE FUNCTION public.admin_top_products(p_days INT DEFAULT 30, p_limit INT DEFAULT 10)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_days  INT := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50);
  v_since TIMESTAMPTZ := public._business_window_start(p_days);
  v_out   JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read product reports.';
  END IF;
  WITH views AS (
    SELECT e.product_id, count(*) AS views
      FROM public.analytics_events e
     WHERE e.created_at >= v_since AND e.event_type = 'product_view' AND e.product_id IS NOT NULL
     GROUP BY e.product_id
  ), sold AS (
    SELECT i.product_id, sum(i.quantity) AS units
      FROM public.order_items i
      JOIN public.orders o ON o.id = i.order_id
     WHERE o.created_at >= v_since AND o.status <> 'cancelled' AND i.product_id IS NOT NULL
     GROUP BY i.product_id
  )
  SELECT jsonb_build_object(
    'days', v_days, 'since', v_since,
    'top_viewed', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'product_id', x.product_id, 'slug', x.slug, 'name', x.name, 'brand', x.brand,
                     'views', x.views, 'units_sold', x.units_sold) ORDER BY x.views DESC, x.product_id)
                   FROM (SELECT v.product_id, p.slug, p.name, p.brand, v.views, COALESCE(s.units, 0) AS units_sold
                           FROM views v
                           LEFT JOIN public.products p ON p.id = v.product_id
                           LEFT JOIN sold s ON s.product_id = v.product_id
                          ORDER BY v.views DESC, v.product_id
                          LIMIT v_limit) x), '[]'::jsonb),
    'top_sold', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'product_id', x.product_id, 'slug', x.slug, 'name', x.name, 'brand', x.brand,
                     'units_sold', x.units_sold, 'views', x.views) ORDER BY x.units_sold DESC, x.product_id)
                   FROM (SELECT s.product_id, p.slug, p.name, p.brand, s.units AS units_sold, COALESCE(v.views, 0) AS views
                           FROM sold s
                           LEFT JOIN public.products p ON p.id = s.product_id
                           LEFT JOIN views v ON v.product_id = s.product_id
                          ORDER BY s.units DESC, s.product_id
                          LIMIT v_limit) x), '[]'::jsonb))
    INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_top_products(INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_top_products(INT, INT) TO authenticated;

-- Site search terms. p_limit 1..100 (NULL → 20). Blank queries are ignored.
-- → {days, since, total_searches, zero_result_searches,
--    top:          [{term, searches, zero_results}],      -- most searched
--    zero_results: [{term, searches}]}                    -- the "stock this" list
CREATE OR REPLACE FUNCTION public.admin_search_terms(p_days INT DEFAULT 30, p_limit INT DEFAULT 20)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_days  INT := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
  v_since TIMESTAMPTZ := public._business_window_start(p_days);
  v_out   JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read search reports.';
  END IF;
  WITH s AS (
    SELECT left(btrim(regexp_replace(lower(e.metadata ->> 'query'), '\s+', ' ', 'g')), 100) AS term,
           CASE WHEN (e.metadata ->> 'results') ~ '^[0-9]{1,9}$' THEN (e.metadata ->> 'results')::INT
                WHEN e.value IS NOT NULL THEN trunc(e.value)::INT END AS results
      FROM public.analytics_events e
     WHERE e.created_at >= v_since AND e.event_type = 'search'
  ), terms AS (
    SELECT term, count(*) AS searches, count(*) FILTER (WHERE results = 0) AS zero_results
      FROM s WHERE term IS NOT NULL AND term <> '' GROUP BY term
  )
  SELECT jsonb_build_object(
    'days', v_days, 'since', v_since,
    'total_searches',       COALESCE((SELECT sum(searches) FROM terms), 0),
    'zero_result_searches', COALESCE((SELECT sum(zero_results) FROM terms), 0),
    'top', COALESCE((SELECT jsonb_agg(jsonb_build_object('term', t.term, 'searches', t.searches, 'zero_results', t.zero_results)
                                      ORDER BY t.searches DESC, t.term)
                       FROM (SELECT * FROM terms ORDER BY searches DESC, term LIMIT v_limit) t), '[]'::jsonb),
    'zero_results', COALESCE((SELECT jsonb_agg(jsonb_build_object('term', t.term, 'searches', t.zero_results)
                                               ORDER BY t.zero_results DESC, t.term)
                                FROM (SELECT * FROM terms WHERE zero_results > 0
                                       ORDER BY zero_results DESC, term LIMIT v_limit) t), '[]'::jsonb))
    INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_search_terms(INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_search_terms(INT, INT) TO authenticated;

-- Low stock: tracked, active variants of active products at or under their threshold, most urgent
-- first. p_limit 1..500 (NULL → 50).
-- → {total, items: [{product_id, variant_id, product_name, variant_name, sku, stock_level, low_stock_threshold}]}
CREATE OR REPLACE FUNCTION public.admin_low_stock(p_limit INT DEFAULT 50)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
  v_out   JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read stock levels.';
  END IF;
  WITH low AS (
    SELECT i.product_id, i.variant_id, p.name AS product_name, v.name AS variant_name, v.sku,
           i.stock_level, i.low_stock_threshold
      FROM public.inventory i
      JOIN public.product_variants v ON v.id = i.variant_id AND v.is_active
      JOIN public.products p ON p.id = i.product_id AND p.is_active
     WHERE i.stock_level <= i.low_stock_threshold
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM low),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.stock_level, x.product_name, x.variant_id)
                         FROM (SELECT * FROM low ORDER BY stock_level, product_name, variant_id LIMIT v_limit) x), '[]'::jsonb))
    INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_low_stock(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_low_stock(INT) TO authenticated;

-- Cart recovery for carts CREATED in the window.
-- → {days, since, captured, with_items, reminded_1, reminded_2, reminded_3, converted,
--    converted_after_reminder, opted_out, recovered_revenue}
CREATE OR REPLACE FUNCTION public.admin_recovery_stats(p_days INT DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_days  INT := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_since TIMESTAMPTZ := public._business_window_start(p_days);
  v_out   JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read recovery figures.';
  END IF;
  SELECT jsonb_build_object(
           'days', v_days, 'since', v_since,
           'captured',                 count(*),
           'with_items',               count(*) FILTER (WHERE jsonb_array_length(c.cart_items) > 0),
           'reminded_1',               count(*) FILTER (WHERE c.recovery_stage >= 1),
           'reminded_2',               count(*) FILTER (WHERE c.recovery_stage >= 2),
           'reminded_3',               count(*) FILTER (WHERE c.recovery_stage >= 3),
           'converted',                count(*) FILTER (WHERE c.converted),
           'converted_after_reminder', count(*) FILTER (WHERE c.converted AND c.recovery_stage >= 1),
           'opted_out',                count(*) FILTER (WHERE c.recovery_opted_out),
           'recovered_revenue', COALESCE((
              SELECT sum(o.total_price)
                FROM public.abandoned_carts c2
                JOIN public.orders o ON o.id = c2.converted_order_id
               WHERE c2.created_at >= v_since AND c2.converted AND c2.recovery_stage >= 1
                 AND o.status <> 'cancelled'), 0))
    INTO v_out
    FROM public.abandoned_carts c
   WHERE c.created_at >= v_since;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_recovery_stats(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_recovery_stats(INT) TO authenticated;

-- Newsletter growth.
-- → {days, since, total, active, new, unsubscribed,
--    by_source: [{source, total, active, new}],            -- largest first
--    daily: [{day: "YYYY-MM-DD", new}]}                    -- one entry per business day of the window
CREATE OR REPLACE FUNCTION public.admin_newsletter_growth(p_days INT DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_days  INT := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_since TIMESTAMPTZ := public._business_window_start(p_days);
  v_tz    TEXT := public._business_tz();
  v_today DATE := (now() AT TIME ZONE public._business_tz())::DATE;
  v_out   JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read subscriber figures.';
  END IF;
  SELECT jsonb_build_object(
    'days', v_days, 'since', v_since,
    'total',        (SELECT count(*) FROM public.newsletter_subscribers),
    'active',       (SELECT count(*) FROM public.newsletter_subscribers WHERE unsubscribed_at IS NULL),
    'new',          (SELECT count(*) FROM public.newsletter_subscribers WHERE created_at >= v_since),
    'unsubscribed', (SELECT count(*) FROM public.newsletter_subscribers WHERE unsubscribed_at >= v_since),
    'by_source', COALESCE((SELECT jsonb_agg(jsonb_build_object('source', x.source, 'total', x.total,
                                                               'active', x.active, 'new', x.new)
                                            ORDER BY x.total DESC, x.source)
                             FROM (SELECT source, count(*) AS total,
                                          count(*) FILTER (WHERE unsubscribed_at IS NULL) AS active,
                                          count(*) FILTER (WHERE created_at >= v_since) AS new
                                     FROM public.newsletter_subscribers GROUP BY source) x), '[]'::jsonb),
    'daily', (SELECT COALESCE(jsonb_agg(jsonb_build_object('day', d.day, 'new', COALESCE(n.new, 0)) ORDER BY d.day), '[]'::jsonb)
                FROM (SELECT g::DATE AS day FROM generate_series(v_today - (v_days - 1), v_today, interval '1 day') g) d
                LEFT JOIN (SELECT (created_at AT TIME ZONE v_tz)::DATE AS day, count(*) AS new
                             FROM public.newsletter_subscribers WHERE created_at >= v_since GROUP BY 1) n
                       ON n.day = d.day))
    INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_newsletter_growth(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_newsletter_growth(INT) TO authenticated;

-- Orders per status (all time).
-- → {total, open, counts: {pending, processing, accepted, fulfilled, shipped, out_for_delivery, delivered, cancelled}}
CREATE OR REPLACE FUNCTION public.admin_order_status_counts()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read order figures.';
  END IF;
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM public.orders),
    'open',  (SELECT count(*) FROM public.orders WHERE status NOT IN ('delivered', 'cancelled')),
    'counts', (SELECT jsonb_object_agg(s.status, COALESCE(c.n, 0))
                 FROM unnest(ARRAY['pending', 'processing', 'accepted', 'fulfilled', 'shipped',
                                   'out_for_delivery', 'delivered', 'cancelled']) AS s(status)
                 LEFT JOIN (SELECT status, count(*) AS n FROM public.orders GROUP BY status) c ON c.status = s.status))
    INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_order_status_counts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_order_status_counts() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 17_analytics
--   No secrets. Events arrive only after a shopper accepts analytics cookies (the consent banner),
--   through POST /api/events → track_event (always 204). Deploy the route with this file.
--   The dashboard reads ONLY the admin_* functions above — every figure is real data; nothing is
--   hard-coded. The logger swallows errors, so verify it once after deploying:
--     SELECT event_type, count(*) FROM public.analytics_events
--      WHERE created_at > now() - interval '1 day' GROUP BY 1 ORDER BY 2 DESC;
--   Verification (as an admin session, or SQL editor with the admin's JWT; the SQL editor itself
--   is not an admin, so call them from the admin panel):
--     SELECT public._business_tz();                                          -- Asia/Colombo
--     SELECT has_function_privilege('anon', 'public.admin_sales_overview(date,date)', 'EXECUTE');  -- false
--     SELECT conname FROM pg_constraint WHERE conname = 'analytics_events_type_valid';    -- EVENT_TYPES mirror
--     -- live probes (anon key is public): events are write-only, aggregates admin-only
--     curl -s "$SUPABASE_URL/rest/v1/analytics_events?select=id" -H "apikey: $ANON"          -- permission denied
--     curl -s "$SUPABASE_URL/rest/v1/rpc/admin_funnel" -H "apikey: $ANON" -H "Content-Type: application/json" -d '{}'
--                                                                                          -- permission denied
-- ═════════════════════════════════════════════════════════════════════════════
