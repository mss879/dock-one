-- ═════════════════════════════════════════════════════════════════════════════
-- 49_card_payments.sql — Dock One Solutions
--
-- PURPOSE      Card payments through WebXPay's redirect gateway (developers.webxpay.com →
--              "Redirect Integration"; the same mechanism WebXPay's own WooCommerce and Shopify
--              plugins use). The blueprint's payment seam (§9.4 "To add a gateway"), end to end:
--                * a third payment METHOD, `card`, whose orders start `awaiting_payment`
--                  (place_order — the client still names a method only, never a status);
--                * store_settings.card_payments_enabled: the owner's switch (admin → Settings);
--                * `payment_attempts`: one row per trip to WebXPay — its unguessable reference
--                  (what WebXPay calls the unique order id / "Store Reference"), the amount asked
--                  for, and what WebXPay answered;
--                * begin_card_payment(): opens an attempt for an unpaid card order (view token);
--                * mark_order_paid(): the blueprint's secret-gated "paid" RPC — an approved,
--                  signature-verified WebXPay answer for the FULL amount marks the order paid;
--                * record_card_payment_failure(): a declined / cancelled answer;
--                * view_order() also returns the latest attempt (the order page's Pay / Try again);
--                * admin_set_payment_status(): awaiting_payment → paid by hand (a payment that
--                  reached WebXPay but never came back to the site);
--                * _web_invoice_receipt(): a paid card order's invoice receipt is recorded as "card";
--                * the privacy page lists WebXPay among the services that process data.
--              The server (src/app/api/payments/webxpay/*) verifies WebXPay's RSA signature —
--              Postgres cannot — and only then calls these functions with PAYMENTS_SECRET.
-- DEPENDS ON   01_foundation (app_config, verify_job_secret), 03_store_settings, 07_orders,
--              09_order_rpcs (replaces place_order, view_order, admin_set_payment_status — re-run
--              49 after any re-run of 09), 15_content (cms_pages), 39_staff_accounts
--              (staff_api_map), 40_sales_documents (replaces _web_invoice_receipt — re-run 49
--              after any re-run of 40).
-- ENABLES      /api/payments/webxpay/start, /api/payments/webxpay/webhook (WebXPay's Return URL),
--              /api/admin/webxpay, the checkout's card option, the order page's payment panel,
--              the admin order drawer's WebXPay attempts.
-- SAFE TO RE-RUN: yes (ADD COLUMN IF NOT EXISTS / DROP + ADD CONSTRAINT / CREATE OR REPLACE;
--              the secret and the privacy line are written once).
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The owner's switch
-- ─────────────────────────────────────────────────────────────────────────────
-- OFF until the owner turns it on in admin → Settings → Payments, after the WebXPay keys are on
-- the server: the checkout offers card payment only while this is on AND the server has the keys.
ALTER TABLE public.store_settings
  ADD COLUMN IF NOT EXISTS card_payments_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Orders: the card vocabulary
-- ─────────────────────────────────────────────────────────────────────────────
-- 07's vocabularies plus `card` / `awaiting_payment` (lib/payments/types.ts mirrors them). Each
-- method keeps its own "not yet paid" state: COD is collected, a transfer is awaited, a card
-- payment is awaited from the gateway.
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_method_valid;
ALTER TABLE public.orders ADD CONSTRAINT orders_payment_method_valid
  CHECK (payment_method IN ('cod', 'bank_transfer', 'card'));
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_status_valid;
ALTER TABLE public.orders ADD CONSTRAINT orders_payment_status_valid
  CHECK (payment_status IN ('pending_collection', 'awaiting_transfer', 'awaiting_payment', 'paid', 'refunded', 'void'));
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_payment_pair_valid;
ALTER TABLE public.orders ADD CONSTRAINT orders_payment_pair_valid CHECK (
     (payment_method = 'cod'           AND payment_status NOT IN ('awaiting_transfer', 'awaiting_payment'))
  OR (payment_method = 'bank_transfer' AND payment_status NOT IN ('pending_collection', 'awaiting_payment'))
  OR (payment_method = 'card'          AND payment_status NOT IN ('pending_collection', 'awaiting_transfer')));

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. payment_attempts — one row per trip to WebXPay
-- ─────────────────────────────────────────────────────────────────────────────
-- `reference` is what the order page sends WebXPay as the unique order id: the order number plus
-- 12 random hex characters (DO-10050-3F9A1C2B7E4D). It shows in WebXPay's portal as the store
-- reference, and it is UNGUESSABLE on purpose: WebXPay's public key and the merchant secret key
-- both reach the browser (that is how WebXPay's redirect works), so anyone can start a WebXPay
-- payment for any reference and amount they like. The server therefore trusts an answer only
-- when WebXPay's signature verifies, the reference is one this database issued, and the amount
-- WebXPay was asked for is exactly this attempt's amount (= the order total) — never just
-- "approved".
-- Status: started (sent to WebXPay) → approved (the order was marked paid) | declined (WebXPay
-- said no, or the shopper cancelled) | review (approved by WebXPay but NOT applied: wrong or short
-- amount, the order was already paid or cancelled — `review_reason` says which; the owner
-- refunds in WebXPay or marks the order paid by hand).
CREATE TABLE IF NOT EXISTS public.payment_attempts (
  id              BIGSERIAL PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES public.orders (id) ON DELETE CASCADE,
  provider        TEXT NOT NULL DEFAULT 'webxpay',
  reference       TEXT NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,                -- LKR asked for (the order total at the start)
  currency        TEXT NOT NULL DEFAULT 'LKR',
  status          TEXT NOT NULL DEFAULT 'started',
  gateway_ref     TEXT,                                  -- WebXPay's order reference number (T…)
  gateway_status  TEXT,                                  -- WebXPay's status code ('0' / '00' approved, '15' declined, …)
  gateway_message TEXT,                                  -- WebXPay's comment ("00 - APPROVED", "No such issuer", …)
  gateway_id      TEXT,                                  -- the payment option WebXPay used (its Gateway IDs table)
  paid_amount     NUMERIC(12,2),                         -- what WebXPay says it charged
  gateway_time    TEXT,                                  -- WebXPay's transaction time, as sent
  review_reason   TEXT,
  source          TEXT,                                  -- return (the shopper came back) | lookup (admin check)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  CONSTRAINT payment_attempts_reference_key UNIQUE (reference),
  CONSTRAINT payment_attempts_provider_valid CHECK (provider IN ('webxpay')),
  CONSTRAINT payment_attempts_status_valid CHECK (status IN ('started', 'approved', 'declined', 'review')),
  CONSTRAINT payment_attempts_source_valid CHECK (source IS NULL OR source IN ('return', 'lookup')),
  CONSTRAINT payment_attempts_money_valid CHECK (amount > 0 AND (paid_amount IS NULL OR paid_amount >= 0)),
  CONSTRAINT payment_attempts_text_lengths CHECK (
        reference ~ '^DO-[0-9]{1,12}-[0-9A-F]{12}$'
    AND currency ~ '^[A-Z]{3}$'
    AND (gateway_ref     IS NULL OR char_length(gateway_ref)     <= 64)
    AND (gateway_status  IS NULL OR char_length(gateway_status)  <= 16)
    AND (gateway_message IS NULL OR char_length(gateway_message) <= 200)
    AND (gateway_id      IS NULL OR char_length(gateway_id)      <= 16)
    AND (gateway_time    IS NULL OR char_length(gateway_time)    <= 40)
    AND (review_reason   IS NULL OR char_length(review_reason)   <= 300))
);
CREATE INDEX IF NOT EXISTS payment_attempts_order_idx ON public.payment_attempts (order_id, created_at DESC, id DESC);

-- Written only by the definer functions below. Admins (and staff with Orders) read them in the
-- order drawer; anon never.
ALTER TABLE public.payment_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_attempts FROM anon, authenticated;
GRANT SELECT ON TABLE public.payment_attempts TO authenticated;
REVOKE ALL ON SEQUENCE public.payment_attempts_id_seq FROM anon, authenticated;
DROP POLICY IF EXISTS payment_attempts_admin_read ON public.payment_attempts;
CREATE POLICY payment_attempts_admin_read ON public.payment_attempts
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

-- Staff: whoever may view Orders sees an order's WebXPay attempts (nobody writes them by hand).
DELETE FROM public.staff_api_map WHERE migration = '49';
INSERT INTO public.staff_api_map (kind, name, area, view_level, edit_level, migration)
VALUES ('table', 'payment_attempts', 'orders', 'view', 'admin', '49');

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The payments secret (app_config 'payments' = PAYMENTS_SECRET)
-- ─────────────────────────────────────────────────────────────────────────────
-- Created once, here, so there is nothing to generate by hand: copy it into PAYMENTS_SECRET (see
-- the OPS NOTE). Without it on the server every function below answers `unauthorized` and the
-- checkout does not offer card payment.
INSERT INTO public.app_config (name, value)
VALUES ('payments', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT (name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. place_order — 09's function, word for word, plus the card method
-- ─────────────────────────────────────────────────────────────────────────────
-- The only change from 09: `card` is accepted while store_settings.card_payments_enabled is on
-- (and the total is at least Rs. 1, WebXPay's minimum), and such an order starts
-- `awaiting_payment`. The order is placed — stock reserved, code redeemed — BEFORE the shopper
-- pays; WebXPay's signed answer later marks it paid (mark_order_paid). A card order nobody pays
-- stays "awaiting payment" until the owner cancels it (which restocks it, as for an unpaid
-- transfer).
-- One transaction: any RAISE rolls back every stock decrement and the discount use.
-- Machine errors (P0001, message 'code' or 'code:detail'):
--   store_unavailable · unsupported_payment_method · invalid_email · invalid_name · invalid_phone
--   invalid_fulfillment · pickup_unavailable · invalid_shipping_address · invalid_note
--   invalid_items · invalid_quantity · invalid_currency · invalid_exchange_rate
--   unknown_product:<product id> · invalid_variant:<product name> · out_of_stock:<label>
--   invalid_discount_code · discount_exhausted · discount_minimum_not_met:<minimum LKR>
--   cod_limit_exceeded:<COD cap LKR>
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
    IF FOUND THEN                                       -- no row = not tracked = always sells
      IF v_stock < r.qty THEN
        RAISE EXCEPTION 'out_of_stock:%', v_label;
      END IF;
      UPDATE public.inventory SET stock_level = stock_level - r.qty WHERE variant_id = r.variant_id;
    END IF;
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
      'line_total',   v_variant.price * r.qty));
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
                                  product_name, brand, variant_name, sku, image_url)
  SELECT v_order_id, (l ->> 'product_id')::INT, (l ->> 'variant_id')::INT, (l ->> 'quantity')::INT,
         (l ->> 'unit_price')::NUMERIC, l ->> 'product_name', l ->> 'brand', l ->> 'variant_name',
         l ->> 'sku', l ->> 'image_url'
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
-- 6. view_order — the order page, plus the latest WebXPay attempt
-- ─────────────────────────────────────────────────────────────────────────────
-- The confirmation page (/order/[id]?t=<view_token>): the unguessable per-order token (a random
-- UUID, 122 bits) is the credential; an order number alone never is. Throttled like tracking,
-- per order number: each WRONG token costs 2 of 8 per 15 minutes (a miss costs double), and
-- once that order's bucket is full further wrong tokens answer {"throttled": true} instead of
-- NULL. The RIGHT token always answers and costs nothing — order numbers are sequential, so a
-- throttle that also refused the right token would let anyone lock the next shopper out of
-- their own confirmation page by sending a few junk tokens for DO-<n+1>. (Guessing gains
-- nothing either way: the token space is not searchable.)
-- Returns the _order_view plus first_name, the delivery city/district (never the street or
-- phone), the pickup address for pickup orders, and — while a transfer is awaited — the bank
-- account to pay into (`bank_transfer`: account_name, bank_name, branch, account_number,
-- instructions). NULL = no match.
-- 49 adds `card_payment` for card orders: the LATEST WebXPay attempt — {status: started |
-- approved | declined | review, message, at}, or NULL before the first one. `message` is
-- WebXPay's own reason, and only for a declined attempt (a held one says nothing internal).
CREATE OR REPLACE FUNCTION public.view_order(p_order_id TEXT, p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ref    TEXT := public._normalize_order_ref(p_order_id);
  v_bucket TEXT;
  o        public.orders%ROWTYPE;
  s        public.store_settings%ROWTYPE;
BEGIN
  IF v_ref IS NULL OR p_token IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = v_ref AND view_token = p_token;
  IF NOT FOUND THEN
    v_bucket := 'view:ref:' || v_ref;
    IF NOT public._rate_limit_hit(v_bucket, 8, 900) THEN
      RETURN jsonb_build_object('throttled', TRUE);
    END IF;
    PERFORM public._rate_limit_hit(v_bucket, 8, 900);   -- a miss costs double
    RETURN NULL;
  END IF;
  SELECT * INTO s FROM public.store_settings WHERE id;
  RETURN public._order_view(o.id) || jsonb_build_object(
    'first_name', o.first_name,
    'shipping',   CASE WHEN o.fulfillment = 'delivery'
                       THEN jsonb_build_object('city',     o.shipping_address ->> 'city',
                                               'district', o.shipping_address ->> 'district') END,
    'pickup',     CASE WHEN o.fulfillment = 'pickup'
                       THEN jsonb_build_object('address', s.pickup_address, 'note', s.pickup_note) END,
    'bank_transfer',
                  CASE WHEN o.payment_method = 'bank_transfer' AND o.payment_status = 'awaiting_transfer'
                       THEN jsonb_build_object('account_name',   s.bank_account_name,
                                               'bank_name',      s.bank_name,
                                               'branch',         s.bank_branch,
                                               'account_number', s.bank_account_number,
                                               'instructions',   s.bank_transfer_instructions) END,
    'card_payment',
                  CASE WHEN o.payment_method = 'card'
                       THEN (SELECT jsonb_build_object('status',  a.status,
                                                       'message', CASE WHEN a.status = 'declined' THEN a.gateway_message END,
                                                       'at',      COALESCE(a.completed_at, a.created_at))
                               FROM public.payment_attempts a
                              WHERE a.order_id = o.id
                              ORDER BY a.created_at DESC, a.id DESC
                              LIMIT 1) END);
END $$;
REVOKE ALL ON FUNCTION public.view_order(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.view_order(TEXT, UUID) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. admin_set_payment_status — a card payment marked paid by hand
-- ─────────────────────────────────────────────────────────────────────────────
-- 09's function, word for word, except that `awaiting_payment` (49: card) may also become paid —
-- the owner's way to record a card payment WebXPay took but the site never heard about (the
-- shopper closed the page before WebXPay sent them back). WebXPay's own answers go through
-- mark_order_paid instead.
-- Payment status: the client never sets it at checkout; only an admin moves it afterwards.
--   pending_collection | awaiting_transfer | awaiting_payment → paid  (cash collected / transfer
--                                                                     received / card payment confirmed)
--   paid                                  → refunded
--   any                                   → void      (only on a CANCELLED order: nothing is due)
-- Same status → only the reference may change (no timeline row). Anything else →
-- 22023 invalid_payment_transition. Every change adds a timeline row.
CREATE OR REPLACE FUNCTION public.admin_set_payment_status(
  p_order_id    TEXT,
  p_status      TEXT,
  p_payment_ref TEXT DEFAULT NULL                    -- NULL/'' = keep; ≤ 120 chars
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o            public.orders%ROWTYPE;
  v_status     TEXT := lower(btrim(COALESCE(p_status, '')));
  v_ref        TEXT := NULLIF(btrim(COALESCE(p_payment_ref, '')), '');
  v_prev       TEXT;
  v_changed    BOOLEAN := FALSE;
  v_label      TEXT;
  v_prev_trust TEXT := current_setting('app.trusted_write', true);
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can change a payment.';
  END IF;
  IF NOT COALESCE(v_status IN ('paid', 'refunded', 'void'), FALSE) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_payment_status:Use paid, refunded or void.';
  END IF;
  IF char_length(COALESCE(v_ref, '')) > 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_payment_ref:At most 120 characters.';
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = public._normalize_order_ref(p_order_id) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'order_not_found:No order with that number.';
  END IF;
  v_prev := o.payment_status;

  IF v_prev <> v_status THEN
    IF NOT (   (v_status = 'paid'     AND v_prev IN ('pending_collection', 'awaiting_transfer', 'awaiting_payment'))
            OR (v_status = 'refunded' AND v_prev = 'paid')
            OR (v_status = 'void'     AND o.status = 'cancelled')) THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'invalid_payment_transition:' || v_prev || ' cannot become ' || v_status
               || CASE WHEN v_status = 'void' THEN ' (cancel the order first)' ELSE '' END || '.';
    END IF;
    v_changed := TRUE;
    v_label := CASE v_status WHEN 'paid' THEN 'Payment received'
                             WHEN 'refunded' THEN 'Payment refunded'
                             ELSE 'No payment due' END;
  END IF;
  IF v_ref IS NOT NULL AND v_ref IS DISTINCT FROM o.payment_ref THEN
    v_changed := TRUE;
  END IF;

  IF v_changed THEN
    PERFORM set_config('app.trusted_write', 'on', true);
    UPDATE public.orders
       SET payment_status = v_status,
           payment_ref    = COALESCE(v_ref, payment_ref)
     WHERE id = o.id
    RETURNING * INTO o;
    IF v_label IS NOT NULL THEN
      INSERT INTO public.order_tracking (order_id, status) VALUES (o.id, v_label);
    END IF;
    PERFORM set_config('app.trusted_write', COALESCE(v_prev_trust, ''), true);
  END IF;

  RETURN jsonb_build_object(
    'order_id', o.id, 'status', o.status, 'payment_status', o.payment_status,
    'previous_payment_status', v_prev, 'payment_ref', o.payment_ref, 'changed', v_changed,
    'timeline_label', v_label, 'payment_method', o.payment_method, 'fulfillment', o.fulfillment,
    'email', o.email, 'first_name', o.first_name, 'last_name', o.last_name,
    'total_price', o.total_price);
END $$;
REVOKE ALL ON FUNCTION public.admin_set_payment_status(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_payment_status(TEXT, TEXT, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. _web_invoice_receipt — a paid card order is receipted as "card"
-- ─────────────────────────────────────────────────────────────────────────────
-- 40's function, word for word, except the method: a card order's receipt is "card", with
-- WebXPay's reference (orders.payment_ref) as its reference.
-- The receipt for a paid web order (cash on delivery → cash; transfer → bank transfer; card → card).
CREATE OR REPLACE FUNCTION public._web_invoice_receipt(p_invoice_id INT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv public.invoices;
  o   public.orders;
BEGIN
  SELECT * INTO inv FROM public.invoices WHERE id = p_invoice_id;
  SELECT * INTO o FROM public.orders WHERE id = inv.order_id;
  IF inv.status <> 'issued' OR inv.balance_due <= 0 OR o.payment_status IS DISTINCT FROM 'paid' THEN
    RETURN;
  END IF;
  INSERT INTO public.invoice_payments (invoice_id, amount, paid_on, method, reference, note, source, payer_name, created_by)
  VALUES (inv.id, inv.balance_due, (now() AT TIME ZONE 'Asia/Colombo')::DATE,
          CASE o.payment_method WHEN 'bank_transfer' THEN 'bank_transfer' WHEN 'card' THEN 'card' ELSE 'cash' END,
          o.payment_ref, format('Web order %s', o.id), 'manual', inv.bill_to_name,
          (SELECT c.id FROM public.customers c WHERE c.id = auth.uid()));
  PERFORM public._invoice_recalc(inv.id);
END $$;
REVOKE ALL ON FUNCTION public._web_invoice_receipt(INT) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Internal helpers (no grants)
-- ─────────────────────────────────────────────────────────────────────────────
-- A gateway amount as NUMERIC(12,2): plain digits with up to 2 decimals ("1500", "1500.00"),
-- else NULL. The route sends WebXPay's figures in this canonical shape.
CREATE OR REPLACE FUNCTION public._card_amount(p_obj JSONB, p_key TEXT) RETURNS NUMERIC
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN public._json_text(p_obj, p_key) ~ '^[0-9]{1,10}(\.[0-9]{1,2})?$'
              THEN public._json_text(p_obj, p_key)::NUMERIC(12,2) END
$$;
REVOKE ALL ON FUNCTION public._card_amount(JSONB, TEXT) FROM PUBLIC, anon, authenticated;

-- A gateway text field: trimmed, control characters removed, capped; '' → NULL.
CREATE OR REPLACE FUNCTION public._card_text(p_obj JSONB, p_key TEXT, p_max INT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT NULLIF(btrim(left(regexp_replace(COALESCE(public._json_text(p_obj, p_key), ''), '[[:cntrl:]]', '', 'g'), p_max)), '')
$$;
REVOKE ALL ON FUNCTION public._card_text(JSONB, TEXT, INT) FROM PUBLIC, anon, authenticated;

-- What the payment functions answer the server: the outcome plus the order as place_order
-- returns it (the confirmation and owner emails are built from exactly these keys —
-- placedOrderFromRpc), with payment_ref and view_token (the server sends the shopper back to
-- their order page). Read after the caller's own writes in the same transaction.
CREATE OR REPLACE FUNCTION public._card_order_payload(p_order_id TEXT, p_outcome TEXT, p_first BOOLEAN)
RETURNS JSONB
LANGUAGE sql SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'outcome',          p_outcome,
    'first',            COALESCE(p_first, FALSE),
    'order_id',         o.id,
    'view_token',       o.view_token,
    'created_at',       o.created_at,
    'status',           o.status,
    'subtotal',         o.subtotal,
    'shipping_fee',     o.shipping_fee,
    'discount_code',    o.discount_code,
    'discount_amount',  o.discount_amount,
    'total',            o.total_price,
    'currency',         o.currency,
    'exchange_rate',    o.exchange_rate,
    'payment_method',   o.payment_method,
    'payment_status',   o.payment_status,
    'payment_ref',      o.payment_ref,
    'fulfillment',      o.fulfillment,
    'email',            o.email,
    'first_name',       o.first_name,
    'last_name',        o.last_name,
    'phone',            o.phone,
    'shipping_address', o.shipping_address,
    'customer_note',    o.customer_note,
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'product_id',   i.product_id,
               'variant_id',   i.variant_id,
               'product_name', i.product_name,
               'brand',        i.brand,
               'variant_name', i.variant_name,
               'sku',          i.sku,
               'image_url',    i.image_url,
               'quantity',     i.quantity,
               'unit_price',   i.unit_price,
               'line_total',   i.unit_price * i.quantity) ORDER BY i.id)
        FROM public.order_items i WHERE i.order_id = o.id), '[]'::jsonb))
    FROM public.orders o
   WHERE o.id = p_order_id
$$;
REVOKE ALL ON FUNCTION public._card_order_payload(TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. begin_card_payment — open an attempt (POST /api/payments/webxpay/start)
-- ─────────────────────────────────────────────────────────────────────────────
-- The order page's Pay button. The view token is the shopper's credential (as for view_order);
-- PAYMENTS_SECRET proves the caller is the site's own server, because the answer carries what
-- WebXPay's form needs — email, phone and address, which view_order never returns.
-- NULL = no order with that number AND token. Errors (P0001): unauthorized · not_card_order ·
-- order_cancelled · already_paid · payment_not_due (refunded / void) · card_unavailable (the
-- owner's switch is off) · amount_too_small (under WebXPay's Rs. 1) · too_many_attempts (10 an
-- hour per order).
-- Each call opens a NEW attempt with a new reference: a shopper who comes back from WebXPay
-- without paying and presses Pay again gets a fresh one (old ones simply stay "started").
CREATE OR REPLACE FUNCTION public.begin_card_payment(p_secret TEXT, p_order_id TEXT, p_token UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_per_hour  CONSTANT INT := 10;
  v_ref       TEXT := public._normalize_order_ref(p_order_id);
  o           public.orders%ROWTYPE;
  s           public.store_settings%ROWTYPE;
  v_reference TEXT;
BEGIN
  IF NOT public.verify_job_secret('payments', p_secret) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  IF v_ref IS NULL OR p_token IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = v_ref AND view_token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF o.payment_method <> 'card' THEN
    RAISE EXCEPTION 'not_card_order';
  END IF;
  IF o.status = 'cancelled' THEN
    RAISE EXCEPTION 'order_cancelled';
  END IF;
  IF o.payment_status = 'paid' THEN
    RAISE EXCEPTION 'already_paid';
  END IF;
  IF o.payment_status <> 'awaiting_payment' THEN
    RAISE EXCEPTION 'payment_not_due';
  END IF;
  SELECT * INTO s FROM public.store_settings WHERE id;
  IF NOT FOUND OR NOT s.card_payments_enabled THEN
    RAISE EXCEPTION 'card_unavailable';
  END IF;
  IF o.total_price < 1 THEN
    RAISE EXCEPTION 'amount_too_small';
  END IF;
  IF (SELECT count(*) FROM public.payment_attempts a
       WHERE a.order_id = o.id AND a.created_at > now() - interval '1 hour') >= c_per_hour THEN
    RAISE EXCEPTION 'too_many_attempts';
  END IF;

  -- 12 hex characters of a random UUID's first (fully random) block: 48 bits, not guessable.
  v_reference := o.id || '-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 12));
  INSERT INTO public.payment_attempts (order_id, provider, reference, amount, currency)
  VALUES (o.id, 'webxpay', v_reference, o.total_price, 'LKR');

  RETURN jsonb_build_object(
    'order_id',         o.id,
    'reference',        v_reference,
    'amount',           o.total_price,
    'currency',         'LKR',
    'email',            o.email,
    'first_name',       o.first_name,
    'last_name',        o.last_name,
    'phone',            o.phone,
    'fulfillment',      o.fulfillment,
    'shipping_address', o.shipping_address);
END $$;
REVOKE ALL ON FUNCTION public.begin_card_payment(TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_card_payment(TEXT, TEXT, UUID) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. mark_order_paid — WebXPay approved (blueprint §9.4: the secret-gated "paid" RPC)
-- ─────────────────────────────────────────────────────────────────────────────
-- Called ONLY after the server has verified WebXPay's signature (the Return URL) or asked
-- WebXPay's transaction API itself (the admin check). p_result: {requested_amount, paid_amount,
-- gateway_ref, gateway_status, gateway_message, gateway_id, gateway_time, source}.
-- The payment is APPLIED — order → paid, payment_ref = WebXPay's reference, a "Payment received"
-- timeline row — only when ALL of these hold:
--   * WebXPay was asked for exactly this attempt's amount, which is still the order total
--     (a forged request for Rs. 1 against a real reference is refused);
--   * WebXPay did not charge less than that (a figure above it — a fee — is fine);
--   * the order is not cancelled and is still awaiting payment.
-- Otherwise the attempt is held as `review` with the reason, and the order is left alone. A
-- repeat of an applied answer changes nothing (outcome paid, first = false), so the shopper's
-- refresh never sends a second confirmation email. Lock order: the order row, then the attempt
-- (as admin_set_payment_status, which locks the order).
-- Returns _card_order_payload(outcome: paid | review, first: TRUE only when THIS call marked the
-- order paid) or {"outcome": "unknown_reference"}. Errors (P0001): unauthorized.
CREATE OR REPLACE FUNCTION public.mark_order_paid(p_secret TEXT, p_reference TEXT, p_result JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a            public.payment_attempts%ROWTYPE;
  o            public.orders%ROWTYPE;
  v_requested  NUMERIC(12,2) := public._card_amount(p_result, 'requested_amount');
  v_paid       NUMERIC(12,2) := public._card_amount(p_result, 'paid_amount');
  v_source     TEXT := CASE WHEN public._json_text(p_result, 'source') = 'lookup' THEN 'lookup' ELSE 'return' END;
  v_reason     TEXT;
  v_prev_trust TEXT := current_setting('app.trusted_write', true);
BEGIN
  IF NOT public.verify_job_secret('payments', p_secret) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  SELECT * INTO a FROM public.payment_attempts WHERE reference = btrim(COALESCE(p_reference, ''));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'unknown_reference');
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = a.order_id FOR UPDATE;
  SELECT * INTO a FROM public.payment_attempts WHERE id = a.id FOR UPDATE;

  IF a.status = 'approved' THEN
    RETURN public._card_order_payload(o.id, 'paid', FALSE);
  END IF;

  v_reason := CASE
    WHEN v_requested IS NULL OR v_requested <> a.amount
      THEN format('WebXPay was asked for Rs. %s, but this attempt was for Rs. %s. Not applied: check the payment in WebXPay.',
                  COALESCE(v_requested::TEXT, '?'), a.amount)
    WHEN a.amount <> o.total_price
      THEN format('This attempt was for Rs. %s but the order total is Rs. %s. Not applied: check the payment in WebXPay.',
                  a.amount, o.total_price)
    WHEN v_paid IS NOT NULL AND v_paid < a.amount
      THEN format('WebXPay charged Rs. %s of Rs. %s. Not applied: check it in WebXPay, then mark the order paid by hand if you accept it.',
                  v_paid, a.amount)
    WHEN o.status = 'cancelled'
      THEN 'The order was cancelled before this payment arrived: refund it in WebXPay.'
    WHEN o.payment_status = 'paid'
      THEN 'The order was already paid: if this is a second payment, refund it in WebXPay.'
    WHEN o.payment_status <> 'awaiting_payment'
      THEN format('The order''s payment is "%s": refund this payment in WebXPay if it is not needed.', o.payment_status)
  END;

  UPDATE public.payment_attempts
     SET status          = CASE WHEN v_reason IS NULL THEN 'approved' ELSE 'review' END,
         review_reason   = v_reason,
         gateway_ref     = COALESCE(public._card_text(p_result, 'gateway_ref', 64), gateway_ref),
         gateway_status  = COALESCE(public._card_text(p_result, 'gateway_status', 16), gateway_status),
         gateway_message = COALESCE(public._card_text(p_result, 'gateway_message', 200), gateway_message),
         gateway_id      = COALESCE(public._card_text(p_result, 'gateway_id', 16), gateway_id),
         gateway_time    = COALESCE(public._card_text(p_result, 'gateway_time', 40), gateway_time),
         paid_amount     = COALESCE(v_paid, paid_amount),
         source          = v_source,
         completed_at    = now()
   WHERE id = a.id
  RETURNING * INTO a;

  IF v_reason IS NOT NULL THEN
    RETURN public._card_order_payload(o.id, 'review', FALSE);
  END IF;

  PERFORM set_config('app.trusted_write', 'on', true);
  UPDATE public.orders
     SET payment_status = 'paid',
         payment_ref    = left(COALESCE(a.gateway_ref, a.reference), 120)
   WHERE id = o.id;
  INSERT INTO public.order_tracking (order_id, status, description)
  VALUES (o.id, 'Payment received', 'Paid by card.');
  PERFORM set_config('app.trusted_write', COALESCE(v_prev_trust, ''), true);

  RETURN public._card_order_payload(o.id, 'paid', TRUE);
END $$;
REVOKE ALL ON FUNCTION public.mark_order_paid(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_order_paid(TEXT, TEXT, JSONB) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 12. record_card_payment_failure — WebXPay declined (or the shopper cancelled)
-- ─────────────────────────────────────────────────────────────────────────────
-- Same p_result keys as mark_order_paid. The order is never touched: it stays awaiting payment
-- and the order page offers "Try again". An attempt already approved or held for review keeps
-- that status (a later "declined" never undoes a payment).
-- Returns _card_order_payload(outcome: declined | paid | review, first = FALSE) or
-- {"outcome": "unknown_reference"}. Errors (P0001): unauthorized.
CREATE OR REPLACE FUNCTION public.record_card_payment_failure(p_secret TEXT, p_reference TEXT, p_result JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  a public.payment_attempts%ROWTYPE;
  o public.orders%ROWTYPE;
BEGIN
  IF NOT public.verify_job_secret('payments', p_secret) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  SELECT * INTO a FROM public.payment_attempts WHERE reference = btrim(COALESCE(p_reference, ''));
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'unknown_reference');
  END IF;
  SELECT * INTO o FROM public.orders WHERE id = a.order_id FOR UPDATE;
  SELECT * INTO a FROM public.payment_attempts WHERE id = a.id FOR UPDATE;

  IF a.status = 'approved' THEN
    RETURN public._card_order_payload(o.id, 'paid', FALSE);
  END IF;
  IF a.status = 'review' THEN
    RETURN public._card_order_payload(o.id, 'review', FALSE);
  END IF;

  UPDATE public.payment_attempts
     SET status          = 'declined',
         gateway_ref     = COALESCE(public._card_text(p_result, 'gateway_ref', 64), gateway_ref),
         gateway_status  = COALESCE(public._card_text(p_result, 'gateway_status', 16), gateway_status),
         gateway_message = COALESCE(public._card_text(p_result, 'gateway_message', 200), gateway_message),
         gateway_id      = COALESCE(public._card_text(p_result, 'gateway_id', 16), gateway_id),
         gateway_time    = COALESCE(public._card_text(p_result, 'gateway_time', 40), gateway_time),
         paid_amount     = COALESCE(public._card_amount(p_result, 'paid_amount'), paid_amount),
         source          = CASE WHEN public._json_text(p_result, 'source') = 'lookup' THEN 'lookup' ELSE 'return' END,
         completed_at    = now()
   WHERE id = a.id;

  RETURN public._card_order_payload(o.id, 'declined', FALSE);
END $$;
REVOKE ALL ON FUNCTION public.record_card_payment_failure(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_card_payment_failure(TEXT, TEXT, JSONB) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 13. The privacy page names WebXPay
-- ─────────────────────────────────────────────────────────────────────────────
-- Added under the hosting line 47 wrote, only while that exact line is there and WebXPay isn't
-- named yet — a page the owner has rewritten is left alone (add the line in admin → Pages).
DO $privacy$
DECLARE
  c_host CONSTANT TEXT := '- **Netlify** — runs this website, so it handles your requests, including your network (IP) address, when you visit.';
  c_line CONSTANT TEXT := '- **WebXPay** — our card payment gateway. When you pay by card, your name, email address, phone number, delivery address, order number and the amount are sent to WebXPay, and you enter your card details on its payment page — we never see or store your full card number.';
BEGIN
  IF to_regclass('public.cms_pages') IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.cms_pages
     SET content = replace(content, c_host, c_host || E'\n' || c_line)
   WHERE slug = 'privacy'
     AND position(c_host IN content) > 0
     AND position('**WebXPay**' IN content) = 0;
END $privacy$;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 49_card_payments
--   Safe to apply before or after the code that uses it: card stays OFF (store_settings.
--   card_payments_enabled = false) until the owner switches it on, so nothing changes at checkout.
--   To take card payments:
--     1. Copy the secret this file created into PAYMENTS_SECRET (local .env and Netlify):
--          SELECT value FROM public.app_config WHERE name = 'payments';
--     2. WebXPay merchant portal → Settings → Integration information: put the Secret key in
--        WEBXPAY_SECRET_KEY and the Public key in WEBXPAY_PUBLIC_KEY (see .env.example). Staging
--        keys need WEBXPAY_ENVIRONMENT=staging.
--     3. WebXPay merchant portal → Settings → Website integration → Return URL:
--          https://dockonesolutions.com/api/payments/webxpay/webhook
--        (WebXPay keeps ONE return URL: for a local test, point it at
--        http://localhost:3000/api/payments/webxpay/webhook and put it back afterwards.)
--     4. Restart / redeploy, then admin → Settings → Payments → switch on "Card payment (WebXPay)".
--   Re-run this file after any re-run of 09_order_rpcs.sql or 40_sales_documents.sql (it replaces
--   place_order, view_order, admin_set_payment_status and _web_invoice_receipt).
--   Verification:
--     SELECT card_payments_enabled FROM public.store_settings;                       -- f until switched on
--     SELECT char_length(value) FROM public.app_config WHERE name = 'payments';      -- 64
--     SELECT conname FROM pg_constraint WHERE conrelid = 'public.orders'::regclass AND conname LIKE 'orders_payment_%';
--     SELECT o.id, o.payment_status, a.reference, a.status, a.gateway_message, a.review_reason
--       FROM public.payment_attempts a JOIN public.orders o ON o.id = a.order_id
--      ORDER BY a.created_at DESC LIMIT 20;                                           -- recent WebXPay trips
--     -- live probes (anon key is public): every payment function needs the secret
--     curl -s "$SUPABASE_URL/rest/v1/rpc/mark_order_paid" -H "apikey: $ANON" -H "Content-Type: application/json" \
--          -d '{"p_secret":"x","p_reference":"DO-1-000000000000","p_result":{}}'   -- {"message":"unauthorized",…}
--     curl -s "$SUPABASE_URL/rest/v1/payment_attempts?select=id" -H "apikey: $ANON"   -- permission denied
--   Undo (before any card order exists): DROP the three functions and payment_attempts, re-run 07's
--   constraints by hand, re-run 09 and 40, and DELETE FROM public.staff_api_map WHERE migration = '49'.
-- ═════════════════════════════════════════════════════════════════════════════
