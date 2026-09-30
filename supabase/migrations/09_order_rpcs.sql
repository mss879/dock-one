-- ═════════════════════════════════════════════════════════════════════════════
-- 09_order_rpcs.sql — Dock One Solutions
--
-- PURPOSE      Every money-bearing step of an order, computed INSIDE Postgres (blueprint P1):
--                quote_order()            read-only authoritative quote (cart + checkout summaries)
--                place_order()            the ONLY way an order is created
--                validate_discount()      advisory code preview (never redeems)
--                track_guest_order()      order number + email → status/timeline (in-DB throttle)
--                view_order()             order number + view token → confirmation page (throttled)
--                admin_set_order_status() the ONLY path that changes a status (cancel reverses all)
--                admin_set_payment_status() paid / refunded / void with a timeline row
--              The browser names WHAT it wants (product id, variant id, quantity, code, payment
--              METHOD); SQL decides every price, fee, discount, payment status and order number.
--              Blueprint §7.5, §9.4–§9.8, Appendix A 07; BUILD_SPEC §1, §2(e), §4.6.
-- DEPENDS ON   01_foundation (_rate_limit_hit, rate_limit_hits), 02_customers_and_auth (customers,
--              is_admin(); rollups need app.trusted_write), 03_store_settings (the delivery rule,
--              enabled payment methods, pickup, bank account, COD cap), 04_catalogue
--              (products, product_variants), 05_inventory (stock per variant), 07_orders,
--              08_discounts. Optional: 13_abandoned_carts (a cart is marked converted only if
--              that table exists).
-- ENABLES      /api/quote, /api/checkout, /api/discount, /api/track, /order/[id], the admin
--              order-status route and Orders tab (WP-C), order emails, customer dashboard
--              tracking (WP-D), assistant order lookups (21), reports (WP-H).
--
-- THE RULES (mirrored — never duplicated — by TypeScript; change both together, P7):
--   * Delivery: pickup pays 0; otherwise the fee is store_settings.delivery_fee when the
--     PRE-DISCOUNT subtotal is < free_delivery_threshold (NULL threshold = never free), else 0.
--     Mirror: src/lib/delivery.ts deliveryFeeFor().
--   * Quantity 1..10 per variant (c_max_qty = MAX_QTY in src/lib/cart.ts), 1..50 lines.
--   * Discounts are rounded to whole rupees (formatLKR shows whole rupees); percentage ≤ 100;
--     a fixed amount never exceeds the subtotal. Total = max(subtotal − discount, 0) + delivery.
--   * Payment: the client sends a METHOD only. cod → pending_collection, bank_transfer →
--     awaiting_transfer. A method is refused unless store_settings enables it (bank transfer
--     also needs the account: bank_account_name, bank_name and bank_account_number; pickup needs
--     pickup_address) — never offer what the shopper cannot complete (P15).
--     Mirror: src/lib/settings-shared.ts bankTransferReady().
--   * Lock order everywhere: inventory rows by (product_id, variant_id) → discount row →
--     customer row. place_order and the cancellation in admin_set_order_status follow it, so
--     concurrent checkouts and cancellations cannot deadlock.
-- SAFE TO RE-RUN: yes (CREATE OR REPLACE; signatures are final — change one only with a
--              DROP FUNCTION of the old signature first, blueprint §7.1).
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Internal helpers (no grants)
-- ─────────────────────────────────────────────────────────────────────────────

-- The 25 districts: the SAME strings as customers_district_valid (02) and DISTRICTS in
-- src/lib/sri-lanka.ts (tested).
CREATE OR REPLACE FUNCTION public._lk_districts() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT ARRAY['Ampara', 'Anuradhapura', 'Badulla', 'Batticaloa', 'Colombo', 'Galle', 'Gampaha',
               'Hambantota', 'Jaffna', 'Kalutara', 'Kandy', 'Kegalle', 'Kilinochchi', 'Kurunegala',
               'Mannar', 'Matale', 'Matara', 'Monaragala', 'Mullaitivu', 'Nuwara Eliya',
               'Polonnaruwa', 'Puttalam', 'Ratnapura', 'Trincomalee', 'Vavuniya']::TEXT[]
$$;
REVOKE ALL ON FUNCTION public._lk_districts() FROM PUBLIC, anon, authenticated;

-- 'colombo ' → 'Colombo'; anything else → NULL.
CREATE OR REPLACE FUNCTION public._canonical_district(p_district TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT d FROM unnest(public._lk_districts()) AS d WHERE lower(d) = lower(btrim(p_district)) LIMIT 1
$$;
REVOKE ALL ON FUNCTION public._canonical_district(TEXT) FROM PUBLIC, anon, authenticated;

-- A JSON object field as trimmed text, only when it is a JSON string or number; '' → NULL.
CREATE OR REPLACE FUNCTION public._json_text(p_obj JSONB, p_key TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(p_obj) = 'object' AND jsonb_typeof(p_obj -> p_key) IN ('string', 'number')
              THEN NULLIF(btrim(p_obj ->> p_key), '') END
$$;
REVOKE ALL ON FUNCTION public._json_text(JSONB, TEXT) FROM PUBLIC, anon, authenticated;

-- Phone → E.164, or NULL when it is not a phone number. Two steps, in this order:
--   1. Sri Lankan: EXACTLY normalizeLkPhone() in src/lib/sri-lanka.ts, step for step ("077 123
--      4567", "0771234567", "+94 77 123 4567", "0094…", "94771234567", "771234567", landlines
--      "011 …" → "+94771234567"). Whatever the storefront accepts as a Sri Lankan number is
--      stored as the same E.164 string (e.g. "00771234567" → "+94771234567" on both sides).
--   2. Only if step 1 found no Sri Lankan number: an international number written with "+" or
--      "00" and a non-94 country code → "+<8–15 digits>" (a buyer abroad ordering for delivery
--      here). normalizeLkPhone() returns null for these, so the checkout form must accept them
--      too (SQL_NOTES: phone rule) or they never reach this function.
CREATE OR REPLACE FUNCTION public._normalize_phone(p_phone TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_t   TEXT := btrim(COALESCE(p_phone, ''));
  v_all TEXT;
  v_d   TEXT;
BEGIN
  IF v_t = '' OR char_length(v_t) > 24 OR v_t ~ '[^0-9\s()+.-]' THEN
    RETURN NULL;
  END IF;
  v_all := regexp_replace(v_t, '[^0-9]', '', 'g');

  -- 1. Sri Lankan (mirror of normalizeLkPhone).
  v_d := v_all;
  IF left(v_t, 1) = '+' THEN
    v_d := CASE WHEN left(v_d, 2) = '94' THEN substr(v_d, 3) END;   -- "+<not 94>" is not Sri Lankan
  ELSIF left(v_d, 4) = '0094' THEN
    v_d := substr(v_d, 5);
  ELSIF left(v_d, 2) = '94' AND char_length(v_d) = 11 THEN
    v_d := substr(v_d, 3);
  ELSIF left(v_d, 1) = '0' THEN
    v_d := substr(v_d, 2);
  END IF;
  -- "+94 077 …" / "0094 077 …": a trunk 0 kept after the country code
  IF char_length(v_d) = 10 AND left(v_d, 1) = '0' THEN
    v_d := substr(v_d, 2);
  END IF;
  IF v_d ~ '^[1-9][0-9]{8}$' THEN
    RETURN '+94' || v_d;
  END IF;

  -- 2. International ("+" or "00" prefix, country code other than 94).
  v_d := CASE WHEN left(v_t, 1) = '+'    THEN v_all
              WHEN left(v_all, 2) = '00' THEN substr(v_all, 3) END;
  IF v_d ~ '^[1-9][0-9]{7,14}$' AND left(v_d, 2) <> '94' THEN
    RETURN '+' || v_d;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._normalize_phone(TEXT) FROM PUBLIC, anon, authenticated;

-- Order reference as typed by a shopper → 'DO-10001' ("DO-10001", "do-10001", "#10001",
-- "10001", "DO 10001"). Anything else is returned trimmed/upper-cased/capped (it will simply
-- not match); blank → NULL.
CREATE OR REPLACE FUNCTION public._normalize_order_ref(p_ref TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
           WHEN v = '' THEN NULL
           WHEN v ~ '^#?(DO)?[-\s]?[0-9]{1,12}$' THEN 'DO-' || (regexp_replace(v, '[^0-9]', '', 'g'))::BIGINT::TEXT
           ELSE left(v, 64)
         END
    FROM (SELECT upper(btrim(COALESCE(p_ref, ''))) AS v) s
$$;
REVOKE ALL ON FUNCTION public._normalize_order_ref(TEXT) FROM PUBLIC, anon, authenticated;

-- Cart lines → typed rows. Malformed values become NULL (callers decide: place_order raises,
-- quote_order reports). `line` is the 1-based position in the input array.
CREATE OR REPLACE FUNCTION public._parse_order_items(p_items JSONB)
RETURNS TABLE (line INT, product_id INT, variant_id INT, quantity INT, well_formed BOOLEAN)
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT e.ord::INT,
         CASE WHEN jsonb_typeof(e.value) = 'object' AND (e.value ->> 'product_id') ~ '^[0-9]{1,9}$'
              THEN (e.value ->> 'product_id')::INT END,
         CASE WHEN jsonb_typeof(e.value) = 'object' AND (e.value ->> 'variant_id') ~ '^[0-9]{1,9}$'
              THEN (e.value ->> 'variant_id')::INT END,
         CASE WHEN jsonb_typeof(e.value) = 'object' AND (e.value ->> 'quantity') ~ '^[0-9]{1,4}$'
              THEN (e.value ->> 'quantity')::INT END,
         jsonb_typeof(e.value) = 'object'
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END)
         WITH ORDINALITY AS e(value, ord)
$$;
REVOKE ALL ON FUNCTION public._parse_order_items(JSONB) FROM PUBLIC, anon, authenticated;

-- The delivery rule (see header). Mirror: src/lib/delivery.ts deliveryFeeFor().
CREATE OR REPLACE FUNCTION public._delivery_fee(p_subtotal NUMERIC, p_fulfillment TEXT, p_fee NUMERIC, p_threshold NUMERIC)
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT (CASE
            WHEN p_fulfillment = 'pickup' THEN 0
            WHEN p_threshold IS NOT NULL AND COALESCE(p_subtotal, 0) >= p_threshold THEN 0   -- fee only when subtotal < threshold
            ELSE COALESCE(p_fee, 0)
          END)::NUMERIC(10,2)
$$;
REVOKE ALL ON FUNCTION public._delivery_fee(NUMERIC, TEXT, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;

-- Discount amount in whole rupees: percentage capped at 100 %, never more than the subtotal.
CREATE OR REPLACE FUNCTION public._discount_amount(p_kind TEXT, p_value NUMERIC, p_subtotal NUMERIC)
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT (CASE
            WHEN COALESCE(p_subtotal, 0) <= 0 OR COALESCE(p_value, 0) <= 0 THEN 0
            WHEN p_kind = 'percentage' THEN LEAST(round(p_subtotal * LEAST(p_value, 100) / 100, 0), p_subtotal)
            ELSE LEAST(round(p_value, 0), p_subtotal)
          END)::NUMERIC(12,2)
$$;
REVOKE ALL ON FUNCTION public._discount_amount(TEXT, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;

-- One discount verdict for quote_order, validate_discount and place_order (P6).
-- → {discount_id, code, valid, amount, reason, minimum}; reason ∈ invalid | expired |
--   exhausted | minimum_not_met (NULL when valid). Not found, inactive, malformed and
--   not-yet-started all read "invalid". Never counts a use.
CREATE OR REPLACE FUNCTION public._discount_check(p_code TEXT, p_subtotal NUMERIC)
RETURNS JSONB
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_code TEXT := upper(btrim(COALESCE(p_code, '')));
  v_sub  NUMERIC := GREATEST(LEAST(COALESCE(p_subtotal, 0), 1000000000), 0);   -- NaN/±Infinity/negatives clamp
  d      public.discounts%ROWTYPE;
BEGIN
  IF v_code !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$' THEN
    RETURN jsonb_build_object('discount_id', NULL, 'code', NULL, 'valid', FALSE, 'amount', 0,
                              'reason', 'invalid', 'minimum', NULL);
  END IF;
  SELECT * INTO d FROM public.discounts WHERE upper(code) = v_code;
  IF NOT FOUND OR NOT d.is_active OR (d.starts_at IS NOT NULL AND d.starts_at > now()) THEN
    RETURN jsonb_build_object('discount_id', NULL, 'code', v_code, 'valid', FALSE, 'amount', 0,
                              'reason', 'invalid', 'minimum', NULL);
  END IF;
  IF d.ends_at IS NOT NULL AND d.ends_at < now() THEN
    RETURN jsonb_build_object('discount_id', d.id, 'code', d.code, 'valid', FALSE, 'amount', 0,
                              'reason', 'expired', 'minimum', NULL);
  END IF;
  IF d.usage_limit IS NOT NULL AND d.usage_count >= d.usage_limit THEN
    RETURN jsonb_build_object('discount_id', d.id, 'code', d.code, 'valid', FALSE, 'amount', 0,
                              'reason', 'exhausted', 'minimum', NULL);
  END IF;
  IF v_sub < d.min_requirement THEN
    RETURN jsonb_build_object('discount_id', d.id, 'code', d.code, 'valid', FALSE, 'amount', 0,
                              'reason', 'minimum_not_met', 'minimum', d.min_requirement);
  END IF;
  RETURN jsonb_build_object('discount_id', d.id, 'code', d.code, 'valid', TRUE,
                            'amount', public._discount_amount(d.kind, d.value, v_sub),
                            'reason', NULL, 'minimum', NULL);
END $$;
REVOKE ALL ON FUNCTION public._discount_check(TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;

-- Human timeline labels (pickup-aware). lib/orders.ts should show the same words.
CREATE OR REPLACE FUNCTION public._order_status_label(p_status TEXT, p_fulfillment TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE p_status
    WHEN 'pending'          THEN 'Order placed'
    WHEN 'processing'       THEN 'Processing'
    WHEN 'accepted'         THEN 'Accepted'
    WHEN 'fulfilled'        THEN 'Packed'
    WHEN 'shipped'          THEN 'Shipped'
    WHEN 'out_for_delivery' THEN CASE WHEN p_fulfillment = 'pickup' THEN 'Ready for pickup' ELSE 'Out for delivery' END
    WHEN 'delivered'        THEN CASE WHEN p_fulfillment = 'pickup' THEN 'Collected' ELSE 'Delivered' END
    WHEN 'cancelled'        THEN 'Cancelled'
    ELSE 'Update'
  END
$$;
REVOKE ALL ON FUNCTION public._order_status_label(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- The shopper-safe view of one order: status, money, fulfilment, tracking, items, timeline.
-- NEVER the street address, phone, email, note, packing charges or view token.
CREATE OR REPLACE FUNCTION public._order_view(p_order_id TEXT) RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'order_id',        o.id,
    'status',          o.status,
    'created_at',      o.created_at,
    'fulfillment',     o.fulfillment,
    'subtotal',        o.subtotal,
    'shipping_fee',    o.shipping_fee,
    'discount_code',   o.discount_code,
    'discount_amount', o.discount_amount,
    'total_price',     o.total_price,
    'currency',        o.currency,
    'exchange_rate',   o.exchange_rate,
    'payment_method',  o.payment_method,
    'payment_status',  o.payment_status,
    'tracking_number', o.tracking_number,
    'tracking_url',    o.tracking_url,
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
        FROM public.order_items i WHERE i.order_id = o.id), '[]'::jsonb),
    'timeline', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'status',      t.status,
               'location',    t.location,
               'description', t.description,
               'at',          t.created_at) ORDER BY t.created_at, t.id)
        FROM public.order_tracking t WHERE t.order_id = o.id), '[]'::jsonb))
    FROM public.orders o
   WHERE o.id = p_order_id
$$;
REVOKE ALL ON FUNCTION public._order_view(TEXT) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. quote_order — the read-only twin of place_order (BUILD_SPEC §2(e))
-- ─────────────────────────────────────────────────────────────────────────────
-- Every total the shopper sees (cart drawer, basket, checkout summary) comes from here. It
-- never raises for bad input and never writes: malformed lines are reported per line.
-- Lines beyond the first 50 are ignored (and the quote is not orderable). A missing or
-- out-of-range quantity is clamped to 1..10 and flagged `quantity_adjusted`; `orderable` is TRUE
-- only when place_order would accept exactly this cart: 1..50 lines, every line available, no
-- quantity adjusted, and no variant totalling more than 10 across lines.
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
                   i.stock_level, i.low_stock_threshold
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
      WHEN r.stock_level IS NOT NULL AND r.stock_level <= 0          THEN 'out_of_stock'
      WHEN r.stock_level IS NOT NULL AND r.stock_level < r.variant_qty THEN 'insufficient_stock'
    END;
    -- Stock band: tracked variants only; exact level only when it is low (or not enough).
    v_band := CASE
      WHEN r.p_id IS NULL OR NOT r.p_visible OR r.v_id IS NULL        THEN NULL
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
      'stock_level',       CASE WHEN v_band = 'low' OR v_reason = 'insufficient_stock' THEN r.stock_level END));
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
-- 3. place_order — the ONLY way an order is created (blueprint §9.4)
-- ─────────────────────────────────────────────────────────────────────────────
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
  p_payment_method    TEXT    DEFAULT 'cod',        -- cod | bank_transfer — NEVER a status
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
  IF NOT COALESCE(v_method IN ('cod', 'bank_transfer'), FALSE) THEN
    RAISE EXCEPTION 'unsupported_payment_method';
  END IF;
  IF v_method = 'cod' THEN
    IF NOT s.cod_enabled THEN
      RAISE EXCEPTION 'unsupported_payment_method';
    END IF;
    v_pay_status := 'pending_collection';
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
-- 4. validate_discount — advisory preview (blueprint §9.6). Never counts a use (a direct call only records a brake hit, 01).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.validate_discount(p_code TEXT, p_subtotal NUMERIC)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v JSONB;
BEGIN
  -- Direct PostgREST callers (not /api/discount or the assistant) share a small store-wide budget,
  -- so codes cannot be guessed at full speed (01, P3).
  IF NOT public._route_or_budget('validate_discount', 120, 3600) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  v := public._discount_check(p_code, p_subtotal);
  RETURN jsonb_build_object('valid',           v -> 'valid',
                            'discount_amount', v -> 'amount',
                            'reason',          v -> 'reason',
                            'minimum',         v -> 'minimum');
END $$;
REVOKE ALL ON FUNCTION public.validate_discount(TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_discount(TEXT, NUMERIC) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Guest tracking and the confirmation page (blueprint §9.4, §9.8)
-- ─────────────────────────────────────────────────────────────────────────────
-- Order number AND email must both match. Granted to anon over SEQUENTIAL ids, so it throttles
-- itself: 8 calls per 15 minutes per order number AND per md5(email); a miss costs double.
-- NULL = wrong/unknown/blank (all alike); {"throttled": true} = over the limit.
CREATE OR REPLACE FUNCTION public.track_guest_order(p_order_id TEXT, p_email TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ref     TEXT := public._normalize_order_ref(p_order_id);
  v_mail    TEXT := lower(btrim(COALESCE(p_email, '')));
  v_ok_ref  BOOLEAN;
  v_ok_mail BOOLEAN;
BEGIN
  IF v_ref IS NULL OR v_mail = '' THEN
    RETURN NULL;
  END IF;
  -- Two separate statements: both buckets are always charged (no OR short-circuit games).
  v_ok_ref  := public._rate_limit_hit('track:ref:' || v_ref, 8, 900);
  v_ok_mail := public._rate_limit_hit('track:mail:' || md5(v_mail), 8, 900);
  IF NOT v_ok_ref OR NOT v_ok_mail THEN
    RETURN jsonb_build_object('throttled', TRUE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.orders WHERE id = v_ref AND lower(email) = v_mail) THEN
    PERFORM public._rate_limit_hit('track:ref:' || v_ref, 8, 900);             -- a miss costs double
    PERFORM public._rate_limit_hit('track:mail:' || md5(v_mail), 8, 900);
    RETURN NULL;
  END IF;
  RETURN public._order_view(v_ref);
END $$;
REVOKE ALL ON FUNCTION public.track_guest_order(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.track_guest_order(TEXT, TEXT) TO anon, authenticated;

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
                                               'instructions',   s.bank_transfer_instructions) END);
END $$;
REVOKE ALL ON FUNCTION public.view_order(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.view_order(TEXT, UUID) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Admin: order status (blueprint §9.7) and payment status
-- ─────────────────────────────────────────────────────────────────────────────
-- The single path for changing an order's status. Admin re-checked here (P9: 42501).
-- Assignable: pending, accepted, fulfilled, out_for_delivery, delivered, cancelled.
-- Transitions: any assignable status may be set on a non-cancelled order (moving back fixes a
-- mistake); a cancelled order is final. out_for_delivery needs a tracking number on DELIVERY
-- orders (a pickup order becomes "Ready for pickup" without one). Cancelling — in the same
-- transaction — restocks the tracked variants, reverses the customer's lifetime figures and
-- gives the discount use back. Payment status is NOT changed by a cancellation: record a
-- refund (paid → refunded) or void an unpaid one with admin_set_payment_status.
-- Same status + a note / new tracking → an "Update" timeline row; nothing new → changed=false.
-- Parameter errors: 22023 with 'code:human detail' — invalid_status, invalid_tracking_number,
-- invalid_tracking_url, invalid_packing_charges, invalid_note, order_not_found,
-- invalid_transition, tracking_required.
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
    PERFORM 1 FROM public.inventory inv
      WHERE inv.variant_id IN (SELECT i.variant_id FROM public.order_items i
                                WHERE i.order_id = o.id AND i.variant_id IS NOT NULL)
      ORDER BY inv.product_id, inv.variant_id
      FOR UPDATE;
    UPDATE public.inventory inv
       SET stock_level = LEAST(inv.stock_level + x.qty, 1000000)
      FROM (SELECT i.variant_id, sum(i.quantity)::INT AS qty
              FROM public.order_items i
             WHERE i.order_id = o.id AND i.variant_id IS NOT NULL
             GROUP BY i.variant_id) x
     WHERE inv.variant_id = x.variant_id;
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

-- Payment status: the client never sets it at checkout; only an admin moves it afterwards.
--   pending_collection | awaiting_transfer → paid     (cash collected / transfer received)
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
    IF NOT (   (v_status = 'paid'     AND v_prev IN ('pending_collection', 'awaiting_transfer'))
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

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 09_order_rpcs
--   Do this or checkout stays off: apply 07 + 08 + 09, then in store_settings (admin Settings tab)
--   check the bank account (03 fills the store's own; or switch bank_transfer_enabled off), and
--   set pickup_address or switch pickup_enabled off — place_order REFUSES bank transfer without
--   the account name, bank and number (unsupported_payment_method) and pickup without an address
--   (pickup_unavailable). quote_order reports both as *_available so the checkout hides them.
--   No secrets: the throttles use rate_limit_hits directly (no RATE_LIMIT_SECRET needed here),
--   but set RATE_LIMIT_SECRET anyway for the route-level limits (01).
--   The delivery rule lives in store_settings: change delivery_fee / free_delivery_threshold
--   there, never in code. src/lib/delivery.ts only previews it.
--   Verification:
--     SELECT public.quote_order('[{"product_id":1,"variant_id":1,"quantity":1}]'::jsonb, NULL, 'delivery');
--     SELECT p.oid::regprocedure, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can
--       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
--        AND p.proname IN ('quote_order','place_order','validate_discount','track_guest_order','view_order',
--                          'admin_set_order_status','admin_set_payment_status','_order_view','_discount_check')
--      ORDER BY p.proname;   -- anon_can TRUE exactly for quote_order, place_order, validate_discount,
--                            -- track_guest_order and view_order
--     -- live probes (anon key is public):
--     curl -s "$SUPABASE_URL/rest/v1/rpc/place_order" -H "apikey: $ANON" -H "Content-Type: application/json" \
--          -d '{"p_email":"probe@example.com","p_first_name":"P","p_last_name":"","p_phone":"0771234567",
--               "p_shipping":{},"p_items":[],"p_payment_method":"cod"}'          -- {"message":"invalid_shipping_address",…}
--     curl -s "$SUPABASE_URL/rest/v1/rpc/admin_set_order_status" -H "apikey: $ANON" -H "Content-Type: application/json" \
--          -d '{"p_order_id":"DO-10001","p_status":"cancelled"}'            -- permission denied
--     curl -s "$SUPABASE_URL/rest/v1/rpc/track_guest_order" -H "apikey: $ANON" -H "Content-Type: application/json" \
--          -d '{"p_order_id":"DO-1","p_email":"x@y.lk"}'                    -- null
-- ═════════════════════════════════════════════════════════════════════════════
