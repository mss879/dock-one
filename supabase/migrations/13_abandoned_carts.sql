-- ═════════════════════════════════════════════════════════════════════════════
-- 13_abandoned_carts.sql — Dock One Solutions
--
-- PURPOSE      Checkout autosave and the three-stage cart recovery (blueprint §9.10, §7.5,
--              §14 lesson 28, Appendix A 10):
--                abandoned_carts                      one row per checkout session (browser UUID)
--                capture_abandoned_cart()             the autosave: email-guarded upsert, never after
--                                                     conversion, suppression-aware, ≤ 25 open carts per
--                                                     address; the lines are re-read from the catalogue
--                claim_abandoned_carts_for_recovery() secret-gated, EXCLUSIVE claim of one stage — it
--                                                     stamps the stage BEFORE mail goes out (returns PII)
--                release_abandoned_cart_recovery()    a send failed: hand the cart back to the queue
--                get_recovery_cart()                  the /recover restore link: items only, never the
--                                                     address or phone
--                stop_cart_recovery()                 "stop these reminders": suppresses the PERSON, so a
--                                                     new cart is born opted out
--              plus the one-time grandfather backfill (carts that existed before recovery shipped
--              are opted out — a flag that is NOT consent and never becomes a suppression).
-- DEPENDS ON   01_foundation (app_config, verify_job_secret), 02_customers_and_auth (is_admin),
--              04_catalogue (products, product_variants), 07_orders (orders), 09_order_rpcs
--              (_parse_order_items, _json_text, _canonical_district; place_order marks the
--              autosave row converted), 12_leads (email_suppressions).
-- ENABLES      POST /api/abandoned-cart (useCheckoutAutosave), POST /api/cart-recovery (hourly job,
--              CART_RECOVERY_SECRET), /recover, /recover/stop + POST /api/cart-recovery/unsubscribe,
--              admin Abandoned carts tab (WP-E); place_order's conversion step (09) — it guards with
--              to_regclass('public.abandoned_carts') and starts converting carts once this file is
--              applied; recovery stats (17); retention (22).
-- SAFE TO RE-RUN: yes (the backfill is guarded by an app_config marker).
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.abandoned_carts (
  id                 UUID PRIMARY KEY,                             -- minted by the browser, stable per checkout session
  email              TEXT NOT NULL,                                -- lower-cased + trimmed (CHECK)
  first_name         TEXT,
  last_name          TEXT,
  phone              TEXT,
  shipping_address   JSONB,                                        -- {street, city, district, postal_code, country}, sanitised
  cart_items         JSONB NOT NULL DEFAULT '[]'::jsonb,           -- [{product_id, variant_id, quantity, name, variant_name, price, image}]
  total_price        NUMERIC(12,2) NOT NULL DEFAULT 0,             -- LKR, Σ price × quantity of cart_items (catalogue prices)
  currency           TEXT NOT NULL DEFAULT 'LKR',                  -- display currency the shopper saw (record only)
  exchange_rate      NUMERIC(14,6) NOT NULL DEFAULT 1,             -- units of `currency` per 1 LKR (record only)
  converted          BOOLEAN NOT NULL DEFAULT FALSE,               -- set by place_order (09)
  converted_order_id TEXT REFERENCES public.orders (id) ON DELETE SET NULL,
  recovery_stage     SMALLINT NOT NULL DEFAULT 0,                  -- 0 = nothing sent; N = reminder N sent (claimed)
  last_recovery_at   TIMESTAMPTZ,
  recovery_token     UUID NOT NULL DEFAULT gen_random_uuid(),      -- the /recover?token= and /recover/stop?token= credential
  recovery_opted_out BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),           -- = time of abandonment: the recovery windows
                                                                   --   measure it, so NOTHING but a real autosave
                                                                   --   (or conversion) may touch it — no touch trigger
  CONSTRAINT abandoned_carts_recovery_token_key UNIQUE (recovery_token),
  CONSTRAINT abandoned_carts_email_valid     CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 255),
  CONSTRAINT abandoned_carts_items_array     CHECK (jsonb_typeof(cart_items) = 'array'),
  CONSTRAINT abandoned_carts_shipping_object CHECK (shipping_address IS NULL OR jsonb_typeof(shipping_address) = 'object'),
  CONSTRAINT abandoned_carts_money_valid     CHECK (total_price >= 0),
  CONSTRAINT abandoned_carts_currency_valid  CHECK (currency ~ '^[A-Z]{3}$' AND exchange_rate > 0 AND exchange_rate <= 1000),
  CONSTRAINT abandoned_carts_stage_valid     CHECK (recovery_stage BETWEEN 0 AND 9),
  CONSTRAINT abandoned_carts_text_lengths    CHECK (
        (first_name IS NULL OR char_length(first_name) <= 255)
    AND (last_name  IS NULL OR char_length(last_name)  <= 255)
    AND (phone      IS NULL OR char_length(phone)      <= 50))
);
CREATE INDEX IF NOT EXISTS abandoned_carts_queue_idx
  ON public.abandoned_carts (recovery_stage, converted, recovery_opted_out, updated_at DESC);
CREATE INDEX IF NOT EXISTS abandoned_carts_email_idx ON public.abandoned_carts (lower(email), updated_at DESC);
CREATE INDEX IF NOT EXISTS abandoned_carts_created_idx ON public.abandoned_carts (created_at DESC);

-- Admin-only (PII). Shoppers and anon reach carts only through the functions below.
ALTER TABLE public.abandoned_carts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.abandoned_carts FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.abandoned_carts FROM authenticated;
DROP POLICY IF EXISTS abandoned_carts_admin_all ON public.abandoned_carts;
CREATE POLICY abandoned_carts_admin_all ON public.abandoned_carts
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- ─────────────────────────────────────────────────────────────────────────────
-- Checkout autosave (2 s debounce in the browser). Idempotent upsert on the client's UUID; only
-- the SAME address can overwrite a cart, and never after it converted. Answers the id whether or
-- not anything was written (a hijack attempt learns nothing).
--   * p_cart_items: [{product_id, variant_id, quantity}, …] (the place_order line shape; other keys
--     are ignored). The browser only NAMES ids (P4): each line is re-read from the catalogue —
--     name, variant name, price and image come from the database, lines for unknown, hidden or
--     mismatched product/variant pairs are dropped, a variant repeated over lines is merged, and
--     quantities are capped at 10 (MAX_QTY). ≤ 50 lines.
--   * total_price = Σ catalogue price × quantity of the kept lines (LKR). p_total is accepted for
--     the blueprint's signature but NOT trusted.
--   * p_shipping: only street / city / district / postal_code / country survive (trimmed, capped;
--     district canonical or dropped); NULL when nothing usable.
--   * Currency outside the supported list, or an unusable rate → recorded as LKR / 1.
--   * A NEW cart from a suppressed address ('cart_recovery' or 'all') is born opted out; the
--     conflict update never clears an opt-out. ≤ 25 open (unconverted) carts per address:
--     autosaves of an EXISTING cart are always allowed.
-- Errors (P0001): invalid_input (NULL id, not x@y.z, items not an array or > 50 lines) ·
--   too_many_carts. The route treats every error as best-effort silence.
CREATE OR REPLACE FUNCTION public.capture_abandoned_cart(
  p_id            UUID,
  p_email         TEXT,
  p_first_name    TEXT,
  p_last_name     TEXT,
  p_phone         TEXT,
  p_shipping      JSONB,
  p_cart_items    JSONB,
  p_total         NUMERIC,                       -- display hint only (see above)
  p_currency      TEXT    DEFAULT 'LKR',
  p_exchange_rate NUMERIC DEFAULT 1
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_max_lines  CONSTANT INT    := 50;
  c_max_qty    CONSTANT INT    := 10;          -- = MAX_QTY in src/lib/cart.ts (as place_order)
  c_max_open   CONSTANT INT    := 25;
  c_currencies CONSTANT TEXT[] := ARRAY['LKR', 'USD', 'GBP', 'EUR', 'AUD', 'INR', 'AED'];  -- as place_order
  v_email      TEXT := lower(btrim(COALESCE(p_email, '')));
  v_currency   TEXT := upper(btrim(COALESCE(p_currency, '')));
  v_rate       NUMERIC(14,6) := 1;
  v_items      JSONB;
  v_total      NUMERIC(12,2);
  v_shipping   JSONB;
  v_suppressed BOOLEAN;
BEGIN
  -- Direct PostgREST callers (not /api/abandoned-cart) share a small store-wide budget, so the
  -- reminder mailer can't be fed a list of other people's addresses (01, P3).
  IF NOT public._route_or_budget('capture_abandoned_cart', 30, 3600) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF p_id IS NULL OR char_length(v_email) > 255 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF p_cart_items IS NULL OR jsonb_typeof(p_cart_items) <> 'array' THEN
    RAISE EXCEPTION 'invalid_input';
  END IF;
  IF jsonb_array_length(p_cart_items) > c_max_lines THEN      -- nested: never evaluated on a non-array
    RAISE EXCEPTION 'invalid_input';
  END IF;

  -- The snapshot the recovery email and the admin tab show is the catalogue's, not the browser's.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id',   p.id,
           'variant_id',   v.id,
           'quantity',     x.qty,
           'name',         p.name,
           'variant_name', v.name,
           'price',        v.price,
           'image',        p.image_url) ORDER BY x.first_line), '[]'::jsonb),
         COALESCE(sum(v.price * x.qty), 0)
    INTO v_items, v_total
    FROM (SELECT l.product_id, l.variant_id,
                 LEAST(sum(l.quantity), c_max_qty)::INT AS qty,
                 min(l.line) AS first_line
            FROM public._parse_order_items(p_cart_items) l
           WHERE l.product_id IS NOT NULL AND l.variant_id IS NOT NULL AND l.quantity >= 1
           GROUP BY l.product_id, l.variant_id) x
    JOIN public.products p
      ON p.id = x.product_id AND p.is_active AND p.variant_count > 0
    JOIN public.product_variants v
      ON v.id = x.variant_id AND v.product_id = x.product_id AND v.is_active;

  IF jsonb_typeof(p_shipping) = 'object' THEN
    v_shipping := NULLIF(jsonb_strip_nulls(jsonb_build_object(
      'street',      left(public._json_text(p_shipping, 'street'), 500),
      'city',        left(public._json_text(p_shipping, 'city'), 120),
      'district',    public._canonical_district(public._json_text(p_shipping, 'district')),
      'postal_code', left(public._json_text(p_shipping, 'postal_code'), 20),
      'country',     left(public._json_text(p_shipping, 'country'), 80))), '{}'::jsonb);
  END IF;

  IF NOT COALESCE(v_currency = ANY (c_currencies), FALSE) THEN
    v_currency := 'LKR';
  END IF;
  IF v_currency <> 'LKR' THEN
    IF p_exchange_rate > 0 AND p_exchange_rate <= 1000 AND round(p_exchange_rate, 6) > 0 THEN
      v_rate := round(p_exchange_rate, 6);
    ELSE
      v_currency := 'LKR';                     -- an unusable rate: record the base currency, never a wrong pair
    END IF;
  END IF;

  -- One address at a time: the open-cart cap cannot be overshot by parallel autosaves.
  PERFORM pg_advisory_xact_lock(1301, hashtext(v_email));
  v_suppressed := EXISTS (SELECT 1 FROM public.email_suppressions
                           WHERE email = v_email AND reason IN ('cart_recovery', 'all'));
  IF NOT EXISTS (SELECT 1 FROM public.abandoned_carts WHERE id = p_id)
     AND (SELECT count(*) FROM public.abandoned_carts
           WHERE lower(email) = v_email AND NOT converted) >= c_max_open THEN
    RAISE EXCEPTION 'too_many_carts';
  END IF;

  INSERT INTO public.abandoned_carts AS ac (
    id, email, first_name, last_name, phone, shipping_address, cart_items, total_price,
    currency, exchange_rate, recovery_opted_out)
  VALUES (
    p_id, v_email,
    NULLIF(left(btrim(p_first_name), 255), ''),
    NULLIF(left(btrim(p_last_name), 255), ''),
    NULLIF(left(btrim(p_phone), 50), ''),
    v_shipping, v_items, v_total, v_currency, v_rate, v_suppressed)
  ON CONFLICT (id) DO UPDATE SET
    first_name       = EXCLUDED.first_name,
    last_name        = EXCLUDED.last_name,
    phone            = EXCLUDED.phone,
    shipping_address = EXCLUDED.shipping_address,
    cart_items       = EXCLUDED.cart_items,
    total_price      = EXCLUDED.total_price,
    currency         = EXCLUDED.currency,
    exchange_rate    = EXCLUDED.exchange_rate,
    updated_at       = now()
    -- recovery_opted_out deliberately absent: a later autosave can never clear an opt-out
  WHERE ac.email = EXCLUDED.email AND ac.converted = FALSE;

  RETURN p_id;
END $$;
REVOKE ALL ON FUNCTION public.capture_abandoned_cart(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC, TEXT, NUMERIC)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_abandoned_cart(UUID, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, NUMERIC, TEXT, NUMERIC)
  TO anon, authenticated;

-- One-time grandfathering: do not mail carts that existed before recovery shipped.
-- This flag is NOT consent — never promote it into email_suppressions (§14 lesson 28).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_config WHERE name = 'cart_recovery_backfilled_at') THEN
    UPDATE public.abandoned_carts SET recovery_opted_out = TRUE WHERE NOT recovery_opted_out;
    INSERT INTO public.app_config (name, value) VALUES ('cart_recovery_backfilled_at', now()::TEXT)
    ON CONFLICT (name) DO NOTHING;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- The hourly job (POST /api/cart-recovery). Claim-then-send: ONE statement stamps the stage
-- BEFORE mail goes out, so a crash skips a reminder instead of repeating it. Returns PII, so the
-- DATABASE checks the secret (app_config 'cart_recovery' = CART_RECOVERY_SECRET).
-- A cart is due for stage N when: not converted, not opted out, at stage N−1, abandoned (updated_at)
-- at least p_min_age_minutes ago but no more than p_max_age_hours ago, the previous reminder at
-- least p_min_gap_minutes ago, a real address, a non-empty cart worth > 0, the person is not
-- suppressed, has not placed an order since (from 1 hour before the abandonment), and has no LATER
-- cart (one reminder per person, about their most recent cart). Oldest due carts first.
-- The claim does NOT touch updated_at (the windows measure it).
-- Clamps: stage 1..9 (else invalid_stage), limit 1..200 (25), min age 0..43200 min (60),
-- gap 0..43200 min (60), max age 1..8760 h (336).
-- Errors (P0001): unauthorized · invalid_stage.
-- Returns a JSON array: [{id, email, first_name, last_name, token, cart_items, total_price,
--   currency, abandoned_at}] — never the phone or address.
CREATE OR REPLACE FUNCTION public.claim_abandoned_carts_for_recovery(
  p_secret TEXT, p_stage SMALLINT, p_min_age_minutes INT, p_min_gap_minutes INT,
  p_max_age_hours INT, p_limit INT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_stage   SMALLINT := p_stage;
  v_limit   INT := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 200);
  v_min_age INT := LEAST(GREATEST(COALESCE(p_min_age_minutes, 60), 0), 43200);
  v_gap     INT := LEAST(GREATEST(COALESCE(p_min_gap_minutes, 60), 0), 43200);
  v_max_age INT := LEAST(GREATEST(COALESCE(p_max_age_hours, 336), 1), 8760);
  v_result  JSONB;
BEGIN
  IF NOT public.verify_job_secret('cart_recovery', p_secret) THEN RAISE EXCEPTION 'unauthorized'; END IF;
  IF v_stage IS NULL OR v_stage < 1 OR v_stage > 9 THEN RAISE EXCEPTION 'invalid_stage'; END IF;

  WITH candidates AS (
    SELECT DISTINCT ON (lower(ac.email)) ac.id, ac.updated_at
      FROM public.abandoned_carts ac
     WHERE ac.converted = FALSE
       AND ac.recovery_opted_out = FALSE
       AND ac.recovery_stage = v_stage - 1
       AND ac.updated_at <= now() - make_interval(mins => v_min_age)
       AND ac.updated_at >= now() - make_interval(hours => v_max_age)
       AND (ac.last_recovery_at IS NULL OR ac.last_recovery_at <= now() - make_interval(mins => v_gap))
       AND ac.email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
       AND ac.total_price > 0
       AND jsonb_array_length(ac.cart_items) > 0             -- always an array (CHECK)
       AND NOT EXISTS (SELECT 1 FROM public.email_suppressions s
                        WHERE s.email = lower(ac.email) AND s.reason IN ('cart_recovery', 'all'))
       AND NOT EXISTS (SELECT 1 FROM public.orders o          -- they bought since
                        WHERE lower(o.email) = lower(ac.email)
                          AND o.created_at >= ac.updated_at - interval '1 hour')
       AND NOT EXISTS (SELECT 1 FROM public.abandoned_carts later   -- a later cart is the one that counts
                        WHERE lower(later.email) = lower(ac.email)
                          AND later.id <> ac.id
                          AND later.updated_at > ac.updated_at)
     ORDER BY lower(ac.email), ac.updated_at DESC, ac.id
  ), due AS (
    SELECT c.id FROM candidates c ORDER BY c.updated_at, c.id LIMIT v_limit
  ), claimed AS (
    UPDATE public.abandoned_carts ac
       SET recovery_stage = v_stage, last_recovery_at = now()     -- updated_at NOT touched
     WHERE ac.id IN (SELECT id FROM due)
       AND ac.recovery_stage = v_stage - 1                        -- re-checked under the row lock:
       AND ac.converted = FALSE                                   --   an EXCLUSIVE claim, and a cart that
       AND ac.recovery_opted_out = FALSE                          --   converted meanwhile is left alone
    RETURNING ac.id, ac.email, ac.first_name, ac.last_name, ac.recovery_token,
              ac.cart_items, ac.total_price, ac.currency, ac.updated_at
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', c.id, 'email', c.email, 'first_name', c.first_name, 'last_name', c.last_name,
           'token', c.recovery_token, 'cart_items', c.cart_items, 'total_price', c.total_price,
           'currency', c.currency, 'abandoned_at', c.updated_at) ORDER BY c.updated_at, c.id), '[]'::jsonb)
    INTO v_result
    FROM claimed c;
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.claim_abandoned_carts_for_recovery(TEXT, SMALLINT, INT, INT, INT, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_abandoned_carts_for_recovery(TEXT, SMALLINT, INT, INT, INT, INT)
  TO anon, authenticated;                                     -- secret-gated

-- A send failed: hand the cart back to stage p_stage − 1 (and clear last_recovery_at), but only
-- if it is still at p_stage. TRUE = released; FALSE = nothing to release (or bad arguments).
-- Errors (P0001): unauthorized.
CREATE OR REPLACE FUNCTION public.release_abandoned_cart_recovery(p_secret TEXT, p_id UUID, p_stage SMALLINT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_rows INT;
BEGIN
  IF NOT public.verify_job_secret('cart_recovery', p_secret) THEN RAISE EXCEPTION 'unauthorized'; END IF;
  IF p_id IS NULL OR p_stage IS NULL OR p_stage < 1 OR p_stage > 9 THEN RETURN FALSE; END IF;
  UPDATE public.abandoned_carts
     SET recovery_stage = GREATEST(p_stage - 1, 0), last_recovery_at = NULL
   WHERE id = p_id AND recovery_stage = p_stage;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END $$;
REVOKE ALL ON FUNCTION public.release_abandoned_cart_recovery(TEXT, UUID, SMALLINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_abandoned_cart_recovery(TEXT, UUID, SMALLINT) TO anon, authenticated;  -- secret-gated

-- The restore link (/recover?token=). The token is the credential. Items only: the address and
-- phone never come back (links get forwarded and sit in shared inboxes).
-- → {"found": false} | {"found": true, "converted", "first_name", "cart_items", "opted_out"}
CREATE OR REPLACE FUNCTION public.get_recovery_cart(p_token UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c public.abandoned_carts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.abandoned_carts WHERE recovery_token = p_token;
  IF NOT FOUND THEN RETURN jsonb_build_object('found', FALSE); END IF;
  RETURN jsonb_build_object('found', TRUE, 'converted', c.converted, 'first_name', c.first_name,
                            'cart_items', c.cart_items, 'opted_out', c.recovery_opted_out);
END $$;
REVOKE ALL ON FUNCTION public.get_recovery_cart(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_recovery_cart(UUID) TO anon, authenticated;

-- "Stop these reminders" (/recover/stop asks, then POSTs). Suppresses the PERSON, so it survives
-- future carts, and opts out every cart of that address. TRUE for known, unknown and NULL tokens.
CREATE OR REPLACE FUNCTION public.stop_cart_recovery(p_token UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email TEXT;
BEGIN
  SELECT lower(email) INTO v_email FROM public.abandoned_carts WHERE recovery_token = p_token;
  IF v_email IS NOT NULL THEN
    INSERT INTO public.email_suppressions (email, reason) VALUES (v_email, 'cart_recovery')
    ON CONFLICT DO NOTHING;
    UPDATE public.abandoned_carts SET recovery_opted_out = TRUE
     WHERE lower(email) = v_email AND NOT recovery_opted_out;
  END IF;
  RETURN TRUE;                                                -- same answer whether or not it exists
END $$;
REVOKE ALL ON FUNCTION public.stop_cart_recovery(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stop_cart_recovery(UUID) TO anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 13_abandoned_carts
--   Do this or recovery stays OFF (the job answers 401/503 and claims nothing):
--     INSERT INTO public.app_config (name, value)
--     VALUES ('cart_recovery', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
--     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
--     SELECT value FROM public.app_config WHERE name = 'cart_recovery';   -- copy into CART_RECOVERY_SECRET
--   then schedule hourly (the same bearer secret):
--     curl -X POST https://<domain>/api/cart-recovery -H "Authorization: Bearer <secret>"
--   Autosave works without the secret (captures are stored; nothing is mailed until it is set).
--   Carts that existed when this file was first applied are opted out (grandfathering, marker
--   app_config 'cart_recovery_backfilled_at') — that flag is NOT an unsubscribe.
--   Verification:
--     SELECT recovery_stage, count(*) FROM public.abandoned_carts
--      WHERE NOT converted AND NOT recovery_opted_out GROUP BY 1 ORDER BY 1;   -- the queue
--     SELECT count(*) FILTER (WHERE converted) AS converted, count(*) AS captured FROM public.abandoned_carts;
--     SELECT value FROM public.app_config WHERE name = 'cart_recovery_backfilled_at';
--     -- live probes (anon key is public): carts are closed, the claim needs the secret
--     curl -s "$SUPABASE_URL/rest/v1/abandoned_carts?select=email" -H "apikey: $ANON"       -- permission denied
--     curl -s "$SUPABASE_URL/rest/v1/rpc/claim_abandoned_carts_for_recovery" -H "apikey: $ANON" \
--          -H "Content-Type: application/json" \
--          -d '{"p_secret":"x","p_stage":1,"p_min_age_minutes":60,"p_min_gap_minutes":60,"p_max_age_hours":336,"p_limit":1}'
--          -- {"message":"unauthorized",…}
-- ═════════════════════════════════════════════════════════════════════════════
