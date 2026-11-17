-- ═════════════════════════════════════════════════════════════════════════════
-- 50_product_availability.sql — Dock One Solutions
--
-- PURPOSE      What the client asked for (Website changes, November 2026 — 01 Frontend,
--              "Availability"): every product card and page says In stock, Available to order,
--              Pre-order or Out of stock, with a wait time where it applies, and an
--              out-of-stock item offers "Notify me".
--
--   product_variants.availability   how a variant is sold (the owner picks it per variant):
--                stock        (default — what every existing variant keeps) In stock while it has
--                             stock (or is not stock-tracked), Out of stock at 0. As before.
--                order        "Available to order": In stock while it has stock; at 0 (or when it
--                             is not stock-tracked at all) it can still be ordered and is sourced
--                             for the customer — the wait time says how long that takes.
--                preorder     "Pre-order": always shown as a pre-order (a product not out yet);
--                             it can be ordered; the expected date / wait time is shown.
--                unavailable  "Out of stock" whatever the stock says — cannot be ordered.
--   wait_min_days / wait_max_days   the wait, in days ("Ships in 7–10 days"); both optional.
--   available_on                    a pre-order's expected date ("Expected 20 Dec 2026"); optional.
--
--   ORDERING BEYOND STOCK (backorders). place_order takes what is on the shelf and lets the rest
--   of an "order" / "pre-order" line wait: order_items.backorder_qty = the units still to come.
--   38's ledger is untouched: stock_reserved stays exactly what the line took from the shelf, so
--   cancelling now puts back ONLY what was taken (admin_set_order_status, below — before 50 it put
--   back the whole quantity, which was the same thing until backorders existed). When the units
--   arrive (Inventory → Record movement → Stock received), the order's next status change
--   (accepted, packed, out for delivery …) moves them from the shelf to the order
--   (orders_40_allocate_backorders), so the hand-over posts the sale and stock stays true.
--
--   NOTIFY ME. stock_alerts: one row per email per variant while it waits. Shoppers add
--   themselves through request_stock_alert (via POST /api/stock-alert, limited per IP); the
--   admin sees the requests in Inventory → "Notify me" requests and emails everyone waiting on a
--   variant once it is back (POST /api/admin/stock-alerts → admin_take_stock_alerts, which marks
--   them told). Emails are kept only until then (sent rows are deleted after 180 days).
--
-- REPLACES     quote_order (09), place_order (49 — start from 49's: card payments),
--              admin_set_order_status (09), list_in_stock_product_ids (05).
--              RE-RUN 50 AFTER ANY RE-RUN OF 05, 09 OR 49.
-- DEPENDS ON   01 (rate limits, _route_or_budget), 02 (customers, is_admin), 04 (products,
--              product_variants), 05 (inventory), 07/09 (orders), 38 (ledger: stock_reserved,
--              _stock_claim, stock_ledger_started), 39 (staff_api_map), 49 (card payments).
-- ERRORS       place_order / quote_order: as before (out_of_stock:<label> now also for an
--              "unavailable" variant). request_stock_alert (P0001): rate_limited, invalid_email,
--              invalid_variant. Admin RPCs: 42501 not_authorised:…
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. How each variant is sold
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS availability  TEXT NOT NULL DEFAULT 'stock';
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS wait_min_days INT;
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS wait_max_days INT;
ALTER TABLE public.product_variants ADD COLUMN IF NOT EXISTS available_on  DATE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_variants_availability_valid') THEN
    ALTER TABLE public.product_variants ADD CONSTRAINT product_variants_availability_valid CHECK (
          availability IN ('stock', 'order', 'preorder', 'unavailable')
      AND (wait_min_days IS NULL OR wait_min_days BETWEEN 0 AND 365)
      AND (wait_max_days IS NULL OR wait_max_days BETWEEN 1 AND 365)
      AND (wait_min_days IS NULL OR wait_max_days IS NULL OR wait_min_days <= wait_max_days)
      AND (available_on IS NULL OR available_on BETWEEN DATE '2020-01-01' AND DATE '2100-12-31'));
  END IF;
END $$;

-- What a web-order line still waits for (ordered beyond the stock on hand). Set by place_order;
-- lowered when stock arrives and is moved to the order (section 6).
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS backorder_qty INT NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_backorder_valid') THEN
    ALTER TABLE public.order_items ADD CONSTRAINT order_items_backorder_valid
      CHECK (backorder_qty >= 0 AND backorder_qty <= quantity);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS order_items_backorder_idx ON public.order_items (order_id) WHERE backorder_qty > 0;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Notify me
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stock_alerts (
  id          BIGSERIAL PRIMARY KEY,
  product_id  INT NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  variant_id  INT NOT NULL REFERENCES public.product_variants (id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  customer_id UUID REFERENCES public.customers (id) ON DELETE SET NULL,   -- signed in when asking
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_at TIMESTAMPTZ,                                                -- told it is back
  notified_by UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  CONSTRAINT stock_alerts_email_valid CHECK (
    char_length(email) <= 254 AND email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
-- one waiting request per email per variant
CREATE UNIQUE INDEX IF NOT EXISTS stock_alerts_waiting_key ON public.stock_alerts (variant_id, email) WHERE notified_at IS NULL;
CREATE INDEX IF NOT EXISTS stock_alerts_notified_idx ON public.stock_alerts (notified_at) WHERE notified_at IS NOT NULL;

-- Admins (and staff with Inventory) read; nobody writes through the API — the RPCs below do.
ALTER TABLE public.stock_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_alerts FROM anon, authenticated;
GRANT SELECT ON public.stock_alerts TO authenticated;
REVOKE ALL ON SEQUENCE public.stock_alerts_id_seq FROM anon, authenticated;
DROP POLICY IF EXISTS stock_alerts_admin_read ON public.stock_alerts;
CREATE POLICY stock_alerts_admin_read ON public.stock_alerts
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

-- request_stock_alert(variant, email) → {ok: true}. The same answer whether or not the email was
-- already waiting (it says nothing about other people's requests). Only for a variant a shopper
-- can see. Direct PostgREST callers share a small store-wide budget (the route limits per IP).
CREATE OR REPLACE FUNCTION public.request_stock_alert(p_variant_id INT, p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email   TEXT := lower(btrim(COALESCE(p_email, '')));
  v_product INT;
BEGIN
  IF NOT public._route_or_budget('request_stock_alert', 60, 3600) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF char_length(v_email) > 254 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;
  SELECT v.product_id INTO v_product
    FROM public.product_variants v
    JOIN public.products p ON p.id = v.product_id AND p.is_active AND p.variant_count > 0
   WHERE v.id = p_variant_id AND v.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_variant';
  END IF;
  INSERT INTO public.stock_alerts (product_id, variant_id, email, customer_id)
  VALUES (v_product, p_variant_id, v_email, (SELECT c.id FROM public.customers c WHERE c.id = auth.uid()))
  ON CONFLICT (variant_id, email) WHERE notified_at IS NULL DO NOTHING;
  RETURN jsonb_build_object('ok', TRUE);
END $$;
REVOKE ALL ON FUNCTION public.request_stock_alert(INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_stock_alert(INT, TEXT) TO anon, authenticated;

-- admin_take_stock_alerts(variant) → {product_id, product_name, slug, variant_name, emails: [...]}
-- Marks everyone waiting on the variant as told and hands their emails to the route that sends
-- the "back in stock" email. Sent requests older than 180 days are deleted here.
CREATE OR REPLACE FUNCTION public.admin_take_stock_alerts(p_variant_id INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_emails JSONB;
  r        RECORD;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t send stock emails.';
  END IF;
  SELECT p.id, p.name, p.slug, v.name AS variant_name, p.variant_count
    INTO r
    FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
   WHERE v.id = p_variant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'variant_not_found:That product option no longer exists.';
  END IF;
  DELETE FROM public.stock_alerts WHERE notified_at < now() - interval '180 days';
  WITH taken AS (
    UPDATE public.stock_alerts
       SET notified_at = now(), notified_by = (SELECT c.id FROM public.customers c WHERE c.id = auth.uid())
     WHERE variant_id = p_variant_id AND notified_at IS NULL
    RETURNING id, email
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id, 'email', email) ORDER BY id), '[]'::jsonb) INTO v_emails FROM taken;
  RETURN jsonb_build_object('product_id', r.id, 'product_name', r.name, 'slug', r.slug,
                            'variant_name', CASE WHEN r.variant_count > 1 THEN r.variant_name END,
                            'emails', v_emails);
END $$;
REVOKE ALL ON FUNCTION public.admin_take_stock_alerts(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_take_stock_alerts(INT) TO authenticated;

-- An email that could not be sent goes back to waiting (only ones taken in the last hour; a newer
-- request from the same address already waiting wins and the older row is dropped).
CREATE OR REPLACE FUNCTION public.admin_return_stock_alerts(p_ids BIGINT[])
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_n INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t send stock emails.';
  END IF;
  DELETE FROM public.stock_alerts a
   WHERE a.id = ANY (COALESCE(p_ids, '{}')) AND a.notified_at > now() - interval '1 hour'
     AND EXISTS (SELECT 1 FROM public.stock_alerts w
                  WHERE w.variant_id = a.variant_id AND w.email = a.email AND w.notified_at IS NULL);
  UPDATE public.stock_alerts SET notified_at = NULL, notified_by = NULL
   WHERE id = ANY (COALESCE(p_ids, '{}')) AND notified_at > now() - interval '1 hour';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;
REVOKE ALL ON FUNCTION public.admin_return_stock_alerts(BIGINT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_return_stock_alerts(BIGINT[]) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. quote_order — 09's, with the availability of each line
-- ─────────────────────────────────────────────────────────────────────────────
-- An "order" / "pre-order" line is orderable beyond the stock (reason NULL); an "unavailable"
-- one never is (out_of_stock). Each line also carries `availability` (the variant's mode),
-- `backorder` (units that are not on the shelf — they wait) and, for order / pre-order lines,
-- `wait_min_days`, `wait_max_days`, `available_on`.
CREATE OR REPLACE FUNCTION public.quote_order(
  p_items         JSONB,
  p_discount_code TEXT DEFAULT NULL,
  p_fulfillment   TEXT DEFAULT 'delivery'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_max_lines   CONSTANT INT := 50;
  c_max_qty     CONSTANT INT := 10;          -- = MAX_QTY in src/lib/cart.ts
  s             public.store_settings%ROWTYPE;
  r             RECORD;
  v_lines       JSONB := '[]'::jsonb;
  v_subtotal    NUMERIC(12,2) := 0;
  v_raw_count   INT := 0;
  v_available   INT := 0;
  v_all_ok      BOOLEAN := TRUE;
  v_adjusted    BOOLEAN;
  v_reason      TEXT;
  v_band        TEXT;
  v_pickup_ok   BOOLEAN;
  v_bank_ok     BOOLEAN;
  v_fulfillment TEXT;
  v_fee         NUMERIC(10,2) := 0;
  v_code        TEXT := NULLIF(btrim(COALESCE(p_discount_code, '')), '');
  v_disc        JSONB := NULL;
  v_disc_amount NUMERIC(12,2) := 0;
  v_total       NUMERIC(12,2);
BEGIN
  -- Direct PostgREST callers (not /api/quote) share a small store-wide budget (01, P3).
  IF NOT public._route_or_budget('quote_order', 600, 3600) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  SELECT * INTO s FROM public.store_settings WHERE id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'store_unavailable';
  END IF;
  v_pickup_ok := s.pickup_enabled AND NULLIF(btrim(COALESCE(s.pickup_address, '')), '') IS NOT NULL;
  -- Bank transfer only while the shopper can pay: the account name, bank and number are set
  -- (03's CHECK keeps each one non-blank). The branch and the extra note are optional.
  v_bank_ok   := s.bank_transfer_enabled AND s.bank_account_name IS NOT NULL AND s.bank_name IS NOT NULL
                 AND s.bank_account_number IS NOT NULL;
  -- Pickup only when the store offers it; otherwise the quote is a delivery quote.
  v_fulfillment := CASE WHEN lower(btrim(COALESCE(p_fulfillment, ''))) = 'pickup' AND v_pickup_ok
                        THEN 'pickup' ELSE 'delivery' END;
  IF jsonb_typeof(p_items) = 'array' THEN
    v_raw_count := jsonb_array_length(p_items);
  END IF;

  FOR r IN
    SELECT x.*, sum(x.qty) OVER (PARTITION BY x.v_id) AS variant_qty
      FROM (SELECT pa.line, pa.product_id AS pid, pa.variant_id AS vid, pa.quantity AS raw_qty,
                   LEAST(GREATEST(COALESCE(pa.quantity, 1), 1), c_max_qty) AS qty,
                   p.id AS p_id, (p.is_active AND p.variant_count > 0) AS p_visible,
                   p.name AS p_name, p.brand, p.slug, p.image_url,
                   v.id AS v_id, v.name AS v_name, v.sku, v.price, v.compare_at_price,
                   i.stock_level, i.low_stock_threshold,
                   v.availability AS v_mode, v.wait_min_days, v.wait_max_days, v.available_on
              FROM public._parse_order_items(p_items) pa
              LEFT JOIN public.products p ON p.id = pa.product_id
              LEFT JOIN public.product_variants v
                     ON v.id = pa.variant_id AND v.product_id = pa.product_id AND v.is_active
              LEFT JOIN public.inventory i ON i.variant_id = v.id
             WHERE pa.line <= c_max_lines) x
     ORDER BY x.line
  LOOP
    v_reason := CASE
      WHEN r.p_id IS NULL                                            THEN 'unknown_product'
      WHEN NOT r.p_visible                                           THEN 'inactive'
      WHEN r.v_id IS NULL                                            THEN 'invalid_variant'
      WHEN r.v_mode = 'unavailable'                                  THEN 'out_of_stock'
      WHEN r.v_mode IN ('order', 'preorder')                         THEN NULL   -- 50: may wait for stock
      WHEN r.stock_level IS NOT NULL AND r.stock_level <= 0          THEN 'out_of_stock'
      WHEN r.stock_level IS NOT NULL AND r.stock_level < r.variant_qty THEN 'insufficient_stock'
    END;
    -- Stock band: tracked variants only; exact level only when it is low (or not enough).
    v_band := CASE
      WHEN r.p_id IS NULL OR NOT r.p_visible OR r.v_id IS NULL        THEN NULL
      WHEN r.v_mode = 'unavailable'                                   THEN 'out'
      WHEN r.stock_level IS NULL                                      THEN 'ok'      -- untracked: always sells
      WHEN r.stock_level <= 0                                         THEN 'out'
      WHEN r.stock_level <= r.low_stock_threshold                     THEN 'low'
      ELSE 'ok'
    END;
    v_adjusted := r.raw_qty IS DISTINCT FROM r.qty;                  -- missing / 0 / over 10 → clamped
    IF v_adjusted OR (r.v_id IS NOT NULL AND r.variant_qty > c_max_qty) THEN
      v_all_ok := FALSE;                                               -- place_order: invalid_quantity
    END IF;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'line',              r.line,
      'product_id',        r.pid,
      'variant_id',        r.vid,
      'quantity',          r.qty,
      'quantity_adjusted', v_adjusted,
      'available',         v_reason IS NULL,
      'reason',            v_reason,
      -- hidden (inactive / unknown) products reveal nothing
      'product_name',      CASE WHEN r.p_visible THEN r.p_name END,
      'brand',             CASE WHEN r.p_visible THEN r.brand END,
      'slug',              CASE WHEN r.p_visible THEN r.slug END,
      'image_url',         CASE WHEN r.p_visible THEN r.image_url END,
      'variant_name',      CASE WHEN r.p_visible THEN r.v_name END,
      'sku',               CASE WHEN r.p_visible THEN r.sku END,
      'unit_price',        CASE WHEN r.p_visible THEN r.price END,
      'compare_at_price',  CASE WHEN r.p_visible AND r.compare_at_price > r.price THEN r.compare_at_price END,
      'line_total',        CASE WHEN v_reason IS NULL THEN r.price * r.qty END,
      'stock',             v_band,
      'stock_level',       CASE WHEN v_band = 'low' OR v_reason = 'insufficient_stock' THEN r.stock_level END,
      -- 50: how the variant is sold, and how much of this line waits for stock
      'availability',      CASE WHEN r.p_visible AND r.v_id IS NOT NULL THEN r.v_mode END,
      'backorder',         CASE WHEN v_reason IS NULL AND r.v_mode IN ('order', 'preorder')
                                THEN CASE WHEN r.stock_level IS NULL THEN r.qty
                                          ELSE LEAST(r.qty, GREATEST(r.variant_qty - GREATEST(r.stock_level, 0), 0)) END
                                ELSE 0 END,
      'wait_min_days',     CASE WHEN r.p_visible AND r.v_mode IN ('order', 'preorder') THEN r.wait_min_days END,
      'wait_max_days',     CASE WHEN r.p_visible AND r.v_mode IN ('order', 'preorder') THEN r.wait_max_days END,
      'available_on',      CASE WHEN r.p_visible AND r.v_mode = 'preorder' THEN r.available_on END));
    IF v_reason IS NULL THEN
      v_subtotal  := v_subtotal + r.price * r.qty;
      v_available := v_available + 1;
    ELSE
      v_all_ok := FALSE;
    END IF;
  END LOOP;

  IF v_available > 0 THEN
    v_fee := public._delivery_fee(v_subtotal, v_fulfillment, s.delivery_fee, s.free_delivery_threshold);
  END IF;
  IF v_code IS NOT NULL THEN
    v_disc := public._discount_check(v_code, v_subtotal);
    IF (v_disc ->> 'valid')::BOOLEAN THEN
      v_disc_amount := (v_disc ->> 'amount')::NUMERIC;
    END IF;
    v_disc := v_disc - 'discount_id';
  END IF;
  v_total := GREATEST(v_subtotal - v_disc_amount, 0) + v_fee;

  RETURN jsonb_build_object(
    'lines',                   v_lines,
    'orderable',               v_raw_count BETWEEN 1 AND c_max_lines AND v_all_ok,
    'subtotal',                v_subtotal,
    'shipping_fee',            v_fee,
    'discount',                v_disc,
    'discount_amount',         v_disc_amount,
    'total',                   v_total,
    'currency',                'LKR',
    'fulfillment',             v_fulfillment,
    'delivery_fee',            s.delivery_fee,
    'free_delivery_threshold', s.free_delivery_threshold,
    'amount_to_free_delivery', CASE WHEN s.free_delivery_threshold IS NULL THEN NULL
                                    ELSE GREATEST(s.free_delivery_threshold - v_subtotal, 0) END,
    'pickup_available',        v_pickup_ok,
    'cod_available',           s.cod_enabled AND (s.cod_max_total IS NULL OR v_total <= s.cod_max_total),
    'bank_transfer_available', v_bank_ok);
END $$;
REVOKE ALL ON FUNCTION public.quote_order(JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_order(JSONB, TEXT, TEXT) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. place_order — 49's (card payments included, unchanged), with backorders
-- ─────────────────────────────────────────────────────────────────────────────
-- Each line's stock: an "unavailable" variant is refused (out_of_stock); an "order" / "pre-order"
-- variant takes what is on the shelf and the rest waits — the line's `backorder` in the answer and
-- order_items.backorder_qty; every other variant needs the full quantity, as before.
CREATE OR REPLACE FUNCTION public.place_order(
  p_email             TEXT,
  p_first_name        TEXT,
  p_last_name         TEXT,
  p_phone             TEXT,
  p_shipping          JSONB,                        -- {street, city, district, postal_code, country}
  p_items             JSONB,                        -- [{product_id, variant_id, quantity}]
  p_discount_code     TEXT    DEFAULT NULL,
  p_abandoned_cart_id UUID    DEFAULT NULL,
  p_currency          TEXT    DEFAULT 'LKR',        -- display currency the shopper saw (recorded)
  p_exchange_rate     NUMERIC DEFAULT 1,            -- units of p_currency per 1 LKR (recorded)
  p_payment_method    TEXT    DEFAULT 'cod',        -- cod | bank_transfer | card — NEVER a status
  p_fulfillment       TEXT    DEFAULT 'delivery',   -- delivery | pickup
  p_customer_note     TEXT    DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_max_lines   CONSTANT INT    := 50;
  c_max_qty     CONSTANT INT    := 10;              -- = MAX_QTY in src/lib/cart.ts
  c_currencies  CONSTANT TEXT[] := ARRAY['LKR', 'USD', 'GBP', 'EUR', 'AUD', 'INR', 'AED'];  -- = CURRENCIES in src/lib/currency-shared.ts
  s             public.store_settings%ROWTYPE;
  v_email       TEXT := lower(btrim(COALESCE(p_email, '')));
  v_first       TEXT := NULLIF(btrim(COALESCE(p_first_name, '')), '');
  v_last        TEXT := NULLIF(btrim(COALESCE(p_last_name, '')), '');
  v_phone       TEXT;
  v_method      TEXT := lower(btrim(COALESCE(p_payment_method, '')));
  v_pay_status  TEXT;
  v_fulfillment TEXT := lower(btrim(COALESCE(p_fulfillment, 'delivery')));
  v_note        TEXT := NULLIF(btrim(COALESCE(p_customer_note, '')), '');
  v_currency    TEXT := upper(btrim(COALESCE(p_currency, '')));
  v_rate        NUMERIC(14,6);
  v_address     JSONB := '{}'::jsonb;
  v_street      TEXT;
  v_city        TEXT;
  v_district    TEXT;
  v_postal      TEXT;
  v_country     TEXT;
  r             RECORD;
  v_product     public.products%ROWTYPE;
  v_variant     public.product_variants%ROWTYPE;
  v_label       TEXT;
  v_stock       INT;
  v_tracked     BOOLEAN;
  v_take        INT;
  v_backorder   INT;
  v_lines       JSONB := '[]'::jsonb;
  v_subtotal    NUMERIC(12,2) := 0;
  v_shipping    NUMERIC(10,2);
  v_code        TEXT := NULLIF(upper(btrim(COALESCE(p_discount_code, ''))), '');
  v_disc_id     INT;
  v_check       JSONB;
  v_discount    NUMERIC(12,2) := 0;
  v_total       NUMERIC(12,2);
  v_order_id    TEXT;
  v_created     TIMESTAMPTZ;
  v_uid         UUID := auth.uid();
  v_customer    UUID;
  v_token       UUID := gen_random_uuid();
  v_prev_trust  TEXT := current_setting('app.trusted_write', true);
BEGIN
  -- Direct PostgREST callers (not /api/checkout, whose per-IP and per-email limits they would skip)
  -- share a small store-wide budget, so fake orders cannot drain stock or burn capped codes (01, P3).
  IF NOT public._route_or_budget('place_order', 20, 3600) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  SELECT * INTO s FROM public.store_settings WHERE id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'store_unavailable';
  END IF;

  -- 1. Payment: the client names a METHOD; SQL decides the starting status. A client can never
  --    declare "paid". COALESCE: a NULL method must not slip through the IN test.
  IF NOT COALESCE(v_method IN ('cod', 'bank_transfer', 'card'), FALSE) THEN
    RAISE EXCEPTION 'unsupported_payment_method';
  END IF;
  IF v_method = 'cod' THEN
    IF NOT s.cod_enabled THEN
      RAISE EXCEPTION 'unsupported_payment_method';
    END IF;
    v_pay_status := 'pending_collection';
  ELSIF v_method = 'card' THEN
    IF NOT s.card_payments_enabled THEN
      RAISE EXCEPTION 'unsupported_payment_method';      -- 49: the owner's switch
    END IF;
    v_pay_status := 'awaiting_payment';                   -- paid only by WebXPay's signed answer
  ELSE
    IF NOT s.bank_transfer_enabled OR s.bank_account_name IS NULL OR s.bank_name IS NULL
       OR s.bank_account_number IS NULL THEN
      RAISE EXCEPTION 'unsupported_payment_method';      -- no account = the shopper could not pay
    END IF;
    v_pay_status := 'awaiting_transfer';
  END IF;

  -- 2. Who and where.
  IF char_length(v_email) > 255 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'invalid_email';
  END IF;
  IF v_first IS NULL OR char_length(v_first) > 255 OR char_length(COALESCE(v_last, '')) > 255 THEN
    RAISE EXCEPTION 'invalid_name';
  END IF;
  v_phone := public._normalize_phone(p_phone);
  IF v_phone IS NULL THEN
    RAISE EXCEPTION 'invalid_phone';
  END IF;
  IF NOT COALESCE(v_fulfillment IN ('delivery', 'pickup'), FALSE) THEN
    RAISE EXCEPTION 'invalid_fulfillment';
  END IF;
  IF v_fulfillment = 'pickup' THEN
    IF NOT s.pickup_enabled OR NULLIF(btrim(COALESCE(s.pickup_address, '')), '') IS NULL THEN
      RAISE EXCEPTION 'pickup_unavailable';
    END IF;                                             -- pickup: no address needed, none stored
  ELSE
    IF p_shipping IS NULL OR jsonb_typeof(p_shipping) <> 'object' THEN
      RAISE EXCEPTION 'invalid_shipping_address';
    END IF;
    v_street   := public._json_text(p_shipping, 'street');
    v_city     := public._json_text(p_shipping, 'city');
    v_district := public._canonical_district(public._json_text(p_shipping, 'district'));
    v_postal   := public._json_text(p_shipping, 'postal_code');
    v_country  := COALESCE(public._json_text(p_shipping, 'country'), 'Sri Lanka');
    IF v_street IS NULL OR char_length(v_street) > 500
       OR v_city IS NULL OR char_length(v_city) > 120
       OR v_district IS NULL
       OR char_length(COALESCE(v_postal, '')) > 20
       OR lower(v_country) <> 'sri lanka' THEN
      RAISE EXCEPTION 'invalid_shipping_address';
    END IF;
    v_address := jsonb_build_object('street', v_street, 'city', v_city, 'district', v_district,
                                    'postal_code', v_postal, 'country', 'Sri Lanka');
  END IF;
  IF char_length(COALESCE(v_note, '')) > 1000 THEN
    RAISE EXCEPTION 'invalid_note';
  END IF;

  -- 3. Items: 1..50 lines, integer ids, 1..10 per variant. Nested IFs, not an OR chain:
  --    jsonb_array_length() raises on a non-array and OR has no evaluation order.
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND c_max_lines THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;
  IF EXISTS (SELECT 1 FROM public._parse_order_items(p_items) x
              WHERE NOT x.well_formed OR x.product_id IS NULL OR x.variant_id IS NULL) THEN
    RAISE EXCEPTION 'invalid_items';
  END IF;
  IF EXISTS (SELECT 1 FROM public._parse_order_items(p_items) x
              WHERE x.quantity IS NULL OR x.quantity NOT BETWEEN 1 AND c_max_qty) THEN
    RAISE EXCEPTION 'invalid_quantity';
  END IF;
  IF EXISTS (SELECT 1 FROM public._parse_order_items(p_items) x
              GROUP BY x.product_id, x.variant_id HAVING sum(x.quantity) > c_max_qty) THEN
    RAISE EXCEPTION 'invalid_quantity';                 -- the same variant split over several lines
  END IF;

  -- 4. Currency is recorded, never charged: a supported code and a sane rate (LKR ⇒ exactly 1).
  IF NOT COALESCE(v_currency = ANY (c_currencies), FALSE) THEN
    RAISE EXCEPTION 'invalid_currency';
  END IF;
  IF p_exchange_rate IS NULL OR NOT (p_exchange_rate > 0 AND p_exchange_rate <= 1000) THEN
    RAISE EXCEPTION 'invalid_exchange_rate';            -- also refuses NaN / Infinity
  END IF;
  v_rate := round(p_exchange_rate, 6);
  IF v_rate <= 0 OR (v_currency = 'LKR' AND v_rate <> 1) THEN
    RAISE EXCEPTION 'invalid_exchange_rate';
  END IF;

  -- 5. Price, validate and reserve every variant. Sorted by (product_id, variant_id) so
  --    concurrent orders take inventory locks in the same order and cannot deadlock.
  FOR r IN
    SELECT x.product_id, x.variant_id, sum(x.quantity)::INT AS qty
      FROM public._parse_order_items(p_items) x
     GROUP BY x.product_id, x.variant_id
     ORDER BY x.product_id, x.variant_id
  LOOP
    SELECT * INTO v_product FROM public.products WHERE id = r.product_id AND is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown_product:%', r.product_id;
    END IF;
    SELECT * INTO v_variant FROM public.product_variants
     WHERE id = r.variant_id AND product_id = r.product_id AND is_active;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_variant:%', v_product.name;
    END IF;
    v_label := v_product.name
            || CASE WHEN v_product.variant_count > 1 THEN ' (' || v_variant.name || ')' ELSE '' END;
    SELECT stock_level INTO v_stock FROM public.inventory WHERE variant_id = r.variant_id FOR UPDATE;
    v_tracked := FOUND;                                 -- no row = not tracked = always sells …
    IF v_variant.availability = 'unavailable' THEN      -- … unless marked unavailable (50)
      RAISE EXCEPTION 'out_of_stock:%', v_label;
    END IF;
    v_take := 0;
    IF v_tracked THEN
      -- 50: an "order" / "pre-order" variant may be ordered beyond the shelf: take what is
      -- there, the rest of the line waits (backorder). Any other variant needs it all.
      IF v_stock < r.qty AND v_variant.availability NOT IN ('order', 'preorder') THEN
        RAISE EXCEPTION 'out_of_stock:%', v_label;
      END IF;
      v_take := LEAST(GREATEST(v_stock, 0), r.qty);
      IF v_take > 0 THEN
        UPDATE public.inventory SET stock_level = stock_level - v_take WHERE variant_id = r.variant_id;
      END IF;
    END IF;
    v_backorder := CASE WHEN v_variant.availability IN ('order', 'preorder') THEN r.qty - v_take ELSE 0 END;
    v_subtotal := v_subtotal + v_variant.price * r.qty;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'product_id',   r.product_id,
      'variant_id',   r.variant_id,
      'product_name', v_product.name,
      'brand',        v_product.brand,
      'variant_name', v_variant.name,
      'sku',          v_variant.sku,
      'image_url',    v_product.image_url,
      'quantity',     r.qty,
      'unit_price',   v_variant.price,
      'line_total',   v_variant.price * r.qty,
      'backorder',    v_backorder));
  END LOOP;

  -- 6. Delivery on the PRE-discount subtotal: a code never costs anyone free delivery.
  v_shipping := public._delivery_fee(v_subtotal, v_fulfillment, s.delivery_fee, s.free_delivery_threshold);

  -- 7. Discount: locked, validated, and counted HERE and nowhere else.
  IF v_code IS NOT NULL THEN
    IF v_code !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' THEN
      RAISE EXCEPTION 'invalid_discount_code';
    END IF;
    SELECT id INTO v_disc_id FROM public.discounts WHERE upper(code) = v_code FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_discount_code';
    END IF;
    v_check := public._discount_check(v_code, v_subtotal);
    CASE v_check ->> 'reason'
      WHEN 'exhausted'       THEN RAISE EXCEPTION 'discount_exhausted';
      WHEN 'minimum_not_met' THEN RAISE EXCEPTION 'discount_minimum_not_met:%', v_check ->> 'minimum';
      ELSE NULL;
    END CASE;
    IF NOT COALESCE((v_check ->> 'valid')::BOOLEAN, FALSE) THEN
      RAISE EXCEPTION 'invalid_discount_code';          -- unknown, inactive, not started or expired
    END IF;
    v_discount := (v_check ->> 'amount')::NUMERIC;
  END IF;

  v_total := GREATEST(v_subtotal - v_discount, 0) + v_shipping;

  -- 8. Cash on delivery can be capped by the owner.
  IF v_method = 'cod' AND s.cod_max_total IS NOT NULL AND v_total > s.cod_max_total THEN
    RAISE EXCEPTION 'cod_limit_exceeded:%', s.cod_max_total;
  END IF;
  -- 49: WebXPay refuses a total under Rs. 1 (its error 409), so such a basket can't pay by card.
  IF v_method = 'card' AND v_total < 1 THEN
    RAISE EXCEPTION 'unsupported_payment_method';
  END IF;

  -- 9. Write everything in this one transaction.
  PERFORM set_config('app.trusted_write', 'on', true);
  IF v_disc_id IS NOT NULL THEN
    UPDATE public.discounts SET usage_count = usage_count + 1 WHERE id = v_disc_id;
  END IF;
  SELECT c.id INTO v_customer FROM public.customers c WHERE c.id = v_uid;   -- NULL for guests
  v_order_id := 'DO-' || nextval('public.order_number_seq');

  INSERT INTO public.orders (
    id, customer_id, email, first_name, last_name, phone, status, fulfillment, shipping_address,
    customer_note, subtotal, shipping_fee, discount_id, discount_code, discount_amount, total_price,
    currency, exchange_rate, payment_method, payment_status, view_token)
  VALUES (
    v_order_id, v_customer, v_email, v_first, v_last, v_phone, 'pending', v_fulfillment, v_address,
    v_note, v_subtotal, v_shipping, v_disc_id, CASE WHEN v_disc_id IS NOT NULL THEN v_code END,
    v_discount, v_total, v_currency, v_rate, v_method, v_pay_status, v_token)
  RETURNING created_at INTO v_created;

  INSERT INTO public.order_items (order_id, product_id, variant_id, quantity, unit_price,
                                  product_name, brand, variant_name, sku, image_url, backorder_qty)
  SELECT v_order_id, (l ->> 'product_id')::INT, (l ->> 'variant_id')::INT, (l ->> 'quantity')::INT,
         (l ->> 'unit_price')::NUMERIC, l ->> 'product_name', l ->> 'brand', l ->> 'variant_name',
         l ->> 'sku', l ->> 'image_url', COALESCE((l ->> 'backorder')::INT, 0)
    FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS e(l, ord)
   ORDER BY e.ord;

  INSERT INTO public.order_tracking (order_id, status, description)
  VALUES (v_order_id, public._order_status_label('pending', v_fulfillment), 'We have received your order.');

  -- 10. The checkout autosave row becomes "converted" — only for the same shopper, and only
  --     once 13_abandoned_carts exists. A side effect: it never fails the order (P5).
  IF p_abandoned_cart_id IS NOT NULL AND to_regclass('public.abandoned_carts') IS NOT NULL THEN
    BEGIN
      UPDATE public.abandoned_carts
         SET converted = TRUE, converted_order_id = v_order_id, updated_at = now()
       WHERE id = p_abandoned_cart_id AND lower(email) = v_email AND NOT converted;
    EXCEPTION WHEN undefined_table OR undefined_column THEN
      NULL;
    END;
  END IF;

  -- 11. The signed-in buyer's lifetime figures (pinned columns: trusted write).
  IF v_customer IS NOT NULL THEN
    UPDATE public.customers
       SET total_spent = total_spent + v_total, orders_count = orders_count + 1
     WHERE id = v_customer;
  END IF;
  PERFORM set_config('app.trusted_write', COALESCE(v_prev_trust, ''), true);

  RETURN jsonb_build_object(
    'order_id',         v_order_id,
    'view_token',       v_token,
    'created_at',       v_created,
    'subtotal',         v_subtotal,
    'shipping_fee',     v_shipping,
    'discount_code',    CASE WHEN v_disc_id IS NOT NULL THEN v_code END,
    'discount_amount',  v_discount,
    'total',            v_total,
    'currency',         v_currency,
    'exchange_rate',    v_rate,
    'payment_method',   v_method,
    'payment_status',   v_pay_status,
    'fulfillment',      v_fulfillment,
    'email',            v_email,
    'first_name',       v_first,
    'last_name',        v_last,
    'phone',            v_phone,
    'shipping_address', v_address,
    'customer_note',    v_note,
    'items',            v_lines);
END $$;
REVOKE ALL ON FUNCTION public.place_order(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.place_order(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT)
  TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. admin_set_order_status — 09's, putting back only what the order took
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_set_order_status(
  p_order_id        TEXT,
  p_status          TEXT,
  p_tracking_number TEXT    DEFAULT NULL,           -- NULL/'' = keep the current one
  p_tracking_url    TEXT    DEFAULT NULL,           -- NULL/'' = keep; https:// only
  p_packing_charges NUMERIC DEFAULT NULL,           -- NULL = keep; LKR 0–100000
  p_note            TEXT    DEFAULT NULL            -- shown to the shopper on the timeline row
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o            public.orders%ROWTYPE;
  v_status     TEXT := lower(btrim(COALESCE(p_status, '')));
  v_tracking   TEXT := NULLIF(btrim(COALESCE(p_tracking_number, '')), '');
  v_url        TEXT := NULLIF(btrim(COALESCE(p_tracking_url, '')), '');
  v_note       TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_status_chg BOOLEAN;
  v_track_chg  BOOLEAN;
  v_url_chg    BOOLEAN;
  v_pack_chg   BOOLEAN;
  v_label      TEXT;
  v_desc       TEXT;
  v_previous   TEXT;
  v_prev_trust TEXT := current_setting('app.trusted_write', true);
  v_ledger     TIMESTAMPTZ;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can change an order.';
  END IF;
  IF NOT COALESCE(v_status IN ('pending', 'accepted', 'fulfilled', 'out_for_delivery', 'delivered', 'cancelled'), FALSE) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_status:Unsupported order status.';
  END IF;
  IF char_length(COALESCE(v_tracking, '')) > 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_tracking_number:At most 100 characters.';
  END IF;
  IF v_url IS NOT NULL AND (char_length(v_url) > 500 OR v_url !~ '^https://[^\\\s]+$') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_tracking_url:Use a full https:// link (at most 500 characters).';
  END IF;
  IF p_packing_charges IS NOT NULL AND NOT (p_packing_charges >= 0 AND p_packing_charges <= 100000) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_packing_charges:Packing charges must be between 0 and 100000.';
  END IF;
  IF char_length(COALESCE(v_note, '')) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_note:At most 500 characters.';
  END IF;

  SELECT * INTO o FROM public.orders WHERE id = public._normalize_order_ref(p_order_id) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'order_not_found:No order with that number.';
  END IF;
  IF o.status = 'cancelled' AND v_status <> 'cancelled' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_transition:A cancelled order cannot be reopened.';
  END IF;
  IF v_status = 'out_for_delivery' AND o.fulfillment = 'delivery' AND COALESCE(v_tracking, o.tracking_number) IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'tracking_required:A tracking number is required to mark a delivery order out for delivery.';
  END IF;

  v_previous   := o.status;
  v_status_chg := o.status <> v_status;
  v_track_chg  := v_tracking IS NOT NULL AND v_tracking IS DISTINCT FROM o.tracking_number;
  v_url_chg    := v_url IS NOT NULL AND v_url IS DISTINCT FROM o.tracking_url;
  v_pack_chg   := p_packing_charges IS NOT NULL AND p_packing_charges IS DISTINCT FROM o.packing_charges;

  IF NOT (v_status_chg OR v_track_chg OR v_url_chg OR v_pack_chg OR v_note IS NOT NULL) THEN
    RETURN jsonb_build_object(
      'order_id', o.id, 'status', o.status, 'previous_status', o.status, 'changed', FALSE,
      'timeline_label', NULL, 'fulfillment', o.fulfillment, 'email', o.email,
      'first_name', o.first_name, 'last_name', o.last_name, 'total_price', o.total_price,
      'currency', o.currency, 'exchange_rate', o.exchange_rate,
      'payment_method', o.payment_method, 'payment_status', o.payment_status,
      'amount_due', CASE WHEN o.payment_status IN ('pending_collection', 'awaiting_transfer') THEN o.total_price ELSE 0 END,
      'tracking_number', o.tracking_number, 'tracking_url', o.tracking_url,
      'packing_charges', o.packing_charges);
  END IF;

  PERFORM set_config('app.trusted_write', 'on', true);

  IF v_status_chg AND v_status = 'cancelled' THEN
    -- 1. Restock tracked variants (untracked stay untracked). Lock in the global order first.
    --    50: put back what the order TOOK from the shelf (order_items.stock_reserved, kept by
    --    38's ledger): a line that waited for stock (a backorder) took less than its quantity.
    --    Orders placed before the ledger started put back the whole quantity, as before.
    BEGIN
      v_ledger := (SELECT value::timestamptz FROM public.app_config WHERE name = 'stock_ledger_started');
    EXCEPTION WHEN others THEN
      v_ledger := NULL;
    END;
    PERFORM 1 FROM public.inventory inv
      WHERE inv.variant_id IN (SELECT i.variant_id FROM public.order_items i
                                WHERE i.order_id = o.id AND i.variant_id IS NOT NULL)
      ORDER BY inv.product_id, inv.variant_id
      FOR UPDATE;
    UPDATE public.inventory inv
       SET stock_level = LEAST(inv.stock_level + x.qty, 1000000)
      FROM (SELECT i.variant_id,
                   sum(CASE WHEN v_ledger IS NULL OR o.created_at < v_ledger THEN i.quantity
                            ELSE i.stock_reserved END)::INT AS qty
              FROM public.order_items i
             WHERE i.order_id = o.id AND i.variant_id IS NOT NULL
             GROUP BY i.variant_id) x
     WHERE inv.variant_id = x.variant_id AND x.qty > 0;
    -- 2. Give the discount use back.
    IF o.discount_id IS NOT NULL THEN
      UPDATE public.discounts SET usage_count = GREATEST(usage_count - 1, 0) WHERE id = o.discount_id;
    ELSIF o.discount_code IS NOT NULL THEN                -- the code row was re-created: match by code
      UPDATE public.discounts SET usage_count = GREATEST(usage_count - 1, 0)
       WHERE upper(code) = upper(o.discount_code);
    END IF;
    -- 3. Reverse the customer's lifetime figures.
    IF o.customer_id IS NOT NULL THEN
      UPDATE public.customers
         SET total_spent  = GREATEST(total_spent - o.total_price, 0),
             orders_count = GREATEST(orders_count - 1, 0)
       WHERE id = o.customer_id;
    END IF;
  END IF;

  UPDATE public.orders
     SET status          = v_status,
         tracking_number = COALESCE(v_tracking, tracking_number),
         tracking_url    = COALESCE(v_url, tracking_url),
         packing_charges = COALESCE(p_packing_charges, packing_charges)
   WHERE id = o.id
  RETURNING * INTO o;

  -- Timeline: a row for every status change; an "Update" row for a note or new tracking.
  v_desc := NULLIF(concat_ws(' ',
              v_note,
              CASE WHEN v_track_chg
                     OR (v_status_chg AND v_status = 'out_for_delivery' AND o.tracking_number IS NOT NULL)
                   THEN 'Tracking reference ' || o.tracking_number || '.' END), '');
  IF v_status_chg THEN
    v_label := public._order_status_label(v_status, o.fulfillment);
  ELSIF v_note IS NOT NULL OR v_track_chg OR v_url_chg THEN
    v_label := 'Update';
  END IF;
  IF v_label IS NOT NULL THEN
    INSERT INTO public.order_tracking (order_id, status, description) VALUES (o.id, v_label, v_desc);
  END IF;

  PERFORM set_config('app.trusted_write', COALESCE(v_prev_trust, ''), true);

  RETURN jsonb_build_object(
    'order_id', o.id, 'status', o.status, 'previous_status', v_previous,
    'changed', TRUE, 'timeline_label', v_label, 'fulfillment', o.fulfillment, 'email', o.email,
    'first_name', o.first_name, 'last_name', o.last_name, 'total_price', o.total_price,
    'currency', o.currency, 'exchange_rate', o.exchange_rate,
    'payment_method', o.payment_method, 'payment_status', o.payment_status,
    'amount_due', CASE WHEN o.payment_status IN ('pending_collection', 'awaiting_transfer') THEN o.total_price ELSE 0 END,
    'tracking_number', o.tracking_number, 'tracking_url', o.tracking_url,
    'packing_charges', o.packing_charges);
END $$;
REVOKE ALL ON FUNCTION public.admin_set_order_status(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_order_status(TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Backordered units arrive: the order's next status change takes them off the shelf
-- ─────────────────────────────────────────────────────────────────────────────
-- Before the order is handed over, any status change (accepted, packed, out for delivery,
-- delivered / collected) moves what is now on the shelf (up to what each line still waits for)
-- to the order: stock goes down, stock_reserved up, backorder_qty down — a reservation, exactly
-- like checkout, so 38 posts the SALE at the hand-over. Cancelling then puts it all back (5).
-- Runs BEFORE the orders row changes, so 38's AFTER trigger already sees the new reservation.
CREATE OR REPLACE FUNCTION public._order_allocate_backorders() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r       RECORD;
  v_stock INT;
  v_take  INT;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status = 'cancelled' OR OLD.status = 'cancelled'
     OR public._stock_issued_status(OLD.status, OLD.fulfillment) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.order_id = NEW.id AND oi.backorder_qty > 0 AND oi.variant_id IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  -- Lock the inventory rows in the global (product_id, variant_id) order (as place_order does).
  PERFORM 1 FROM public.inventory inv
    WHERE inv.variant_id IN (SELECT oi.variant_id FROM public.order_items oi
                              WHERE oi.order_id = NEW.id AND oi.backorder_qty > 0 AND oi.variant_id IS NOT NULL)
    ORDER BY inv.product_id, inv.variant_id
    FOR UPDATE;
  FOR r IN
    SELECT oi.id, oi.variant_id, oi.backorder_qty
      FROM public.order_items oi
      JOIN public.inventory inv ON inv.variant_id = oi.variant_id
     WHERE oi.order_id = NEW.id AND oi.backorder_qty > 0
     ORDER BY inv.product_id, inv.variant_id, oi.id
  LOOP
    SELECT stock_level INTO v_stock FROM public.inventory WHERE variant_id = r.variant_id;
    v_take := LEAST(r.backorder_qty, GREATEST(COALESCE(v_stock, 0), 0));
    CONTINUE WHEN v_take <= 0;
    UPDATE public.inventory SET stock_level = stock_level - v_take WHERE variant_id = r.variant_id;
    -- shelf → this order: a reservation, not a movement (drop the automatic adjustment row, 38)
    PERFORM public._stock_claim(r.variant_id, 'out', v_take, NULL, NULL, NULL);
    UPDATE public.order_items
       SET stock_reserved = LEAST(stock_reserved + v_take, 1000), backorder_qty = backorder_qty - v_take
     WHERE id = r.id;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._order_allocate_backorders() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS orders_40_allocate_backorders ON public.orders;
CREATE TRIGGER orders_40_allocate_backorders BEFORE UPDATE OF status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public._order_allocate_backorders();

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. "In stock only" (05's list_in_stock_product_ids, with the variant modes)
-- ─────────────────────────────────────────────────────────────────────────────
-- In stock = on the shelf now: a stock-tracked variant with stock (sold as "stock" or "order"),
-- or an untracked variant sold as "stock". Pre-orders, "available to order" items with nothing
-- on the shelf and "unavailable" ones are not in stock.
CREATE OR REPLACE FUNCTION public.list_in_stock_product_ids()
RETURNS TABLE (product_id INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id
    FROM public.products p
   WHERE p.is_active AND p.variant_count > 0
     AND EXISTS (SELECT 1
                   FROM public.product_variants v
                   LEFT JOIN public.inventory i ON i.variant_id = v.id
                  WHERE v.product_id = p.id AND v.is_active AND v.availability IN ('stock', 'order')
                    AND CASE WHEN i.variant_id IS NULL THEN v.availability = 'stock' ELSE i.stock_level > 0 END)
   ORDER BY p.id
$$;
REVOKE ALL ON FUNCTION public.list_in_stock_product_ids() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_in_stock_product_ids() TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Staff: "Notify me" requests belong to Inventory (view to read them, edit to send)
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM public.staff_api_map WHERE migration = '50';
INSERT INTO public.staff_api_map (kind, name, area, view_level, edit_level, migration) VALUES
  ('table', 'stock_alerts',              'inventory', 'view', 'admin', '50'),
  ('table', 'stock_alerts',              'products',  'view', 'admin', '50'),
  ('rpc',   'admin_take_stock_alerts',   'inventory', 'view', 'edit',  '50'),
  ('rpc',   'admin_return_stock_alerts', 'inventory', 'view', 'edit',  '50');

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 50_product_availability
--   Run after 01–49 (it replaces 49's place_order — run 50 again after any re-run of 05, 09 or 49).
--   Nothing changes for shoppers until a variant is set to something other than "In stock /
--   out of stock" (admin → Products → a product → Variants → Availability).
--   Verification:
--     SELECT availability, count(*) FROM public.product_variants GROUP BY 1;          -- all 'stock' at first
--     SELECT has_function_privilege('anon', 'public.request_stock_alert(integer,text)', 'EXECUTE');  -- true
--     SELECT has_table_privilege('anon', 'public.stock_alerts', 'SELECT');                           -- false
--     SELECT o.id, oi.product_name, oi.quantity, oi.stock_reserved, oi.backorder_qty
--       FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id
--      WHERE oi.backorder_qty > 0 ORDER BY o.created_at DESC;                        -- orders waiting for stock
-- ═════════════════════════════════════════════════════════════════════════════
