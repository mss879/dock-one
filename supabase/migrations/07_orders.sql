-- ═════════════════════════════════════════════════════════════════════════════
-- 07_orders.sql — Dock One Solutions
--
-- PURPOSE      The order ledger: `order_number_seq` (DO-10001, DO-10002, …), `orders` (one row
--              per placed order, charged in LKR), `order_items` (one row per variant with name /
--              brand / variant / SKU / image SNAPSHOTS so history survives catalogue edits),
--              `order_tracking` (the append-only, human-readable timeline the shopper sees),
--              owner RLS (by account OR verified email) and admin ALL. A guard trigger keeps the
--              money, status and payment columns in the hands of the order RPCs (09).
--              Blueprint §7.3 (orders, order_items, order_tracking), §7.4, §9.4, §9.7,
--              Appendix A 05; BUILD_SPEC §4.6 (DO- ids, LKR, payment_method/payment_status/
--              fulfillment vocabularies, phone NOT NULL, customer_note).
-- DEPENDS ON   01_foundation (touch_updated_at), 02_customers_and_auth (customers, is_admin(),
--              link_guest_orders() starts linking once this table exists), 04_catalogue
--              (products, product_variants for the item foreign keys).
-- ENABLES      08_discounts (adds the orders.discount_id foreign key), 09_order_rpcs
--              (place_order / quote_order / tracking / admin status changes), 11_reviews
--              (verified purchase = a DELIVERED order containing the product), the customer
--              dashboard (WP-D), admin Orders tab (WP-C), dashboards and best sellers (WP-B/WP-H).
-- WRITES       Orders are CREATED only by place_order() and their status / payment / money /
--              tracking columns CHANGE only through admin_set_order_status() and
--              admin_set_payment_status() (09). Admins may still correct contact details
--              (first_name, last_name, phone, shipping_address, customer_note) directly and add
--              timeline rows. Orders are never deleted from the app (cancel instead), and order
--              lines are written only by place_order (guard triggers, §3).
-- SAFE TO RE-RUN: yes (IF NOT EXISTS / CREATE OR REPLACE / DROP … IF EXISTS / guarded DO blocks).
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Order numbers
-- ─────────────────────────────────────────────────────────────────────────────
-- 'DO-' || nextval → DO-10001. Only place_order() (SECURITY DEFINER) takes numbers; no API role
-- may advance or reset the sequence (a drifted sequence = a failed checkout on a PK clash).
CREATE SEQUENCE IF NOT EXISTS public.order_number_seq START WITH 10001;
REVOKE ALL ON SEQUENCE public.order_number_seq FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Tables
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.orders (
  id               TEXT PRIMARY KEY,                          -- 'DO-' || nextval('order_number_seq')
  customer_id      UUID REFERENCES public.customers (id) ON DELETE SET NULL,  -- the signed-in buyer, or linked on confirmed email
  email            TEXT NOT NULL,                             -- lower-cased by place_order
  first_name       TEXT,
  last_name        TEXT,
  phone            TEXT NOT NULL,                             -- normalised (+94…) by place_order: the courier calls it
  status           TEXT NOT NULL DEFAULT 'pending',
  fulfillment      TEXT NOT NULL DEFAULT 'delivery',          -- delivery | pickup (showroom)
  shipping_address JSONB NOT NULL DEFAULT '{}'::jsonb,        -- {street, city, district, postal_code, country}; {} for pickup
  customer_note    TEXT,                                      -- delivery instructions typed at checkout
  subtotal         NUMERIC(12,2) NOT NULL DEFAULT 0,          -- LKR, before discount and delivery
  shipping_fee     NUMERIC(10,2) NOT NULL DEFAULT 0,          -- LKR, from store_settings on the PRE-discount subtotal
  discount_id      INT,                                       -- the redeemed code (FK added by 08_discounts)
  discount_code    TEXT,                                      -- snapshot of the code as redeemed (upper-case)
  discount_amount  NUMERIC(12,2) NOT NULL DEFAULT 0,          -- LKR
  total_price      NUMERIC(12,2) NOT NULL DEFAULT 0,          -- LKR charged: max(subtotal − discount, 0) + shipping_fee
  packing_charges  NUMERIC(10,2) NOT NULL DEFAULT 0,          -- LKR, the store's own packing cost (admin, not charged)
  currency         TEXT NOT NULL DEFAULT 'LKR',               -- the DISPLAY currency the shopper saw (record only)
  exchange_rate    NUMERIC(14,6) NOT NULL DEFAULT 1,          -- units of `currency` per 1 LKR at checkout (record only)
  payment_method   TEXT NOT NULL DEFAULT 'cod',
  payment_status   TEXT NOT NULL DEFAULT 'pending_collection',
  payment_ref      TEXT,                                      -- e.g. the bank transfer reference, set by the admin
  tracking_number  TEXT,
  tracking_url     TEXT,
  view_token       UUID NOT NULL DEFAULT gen_random_uuid(),   -- unlocks /order/[id]?t= (view_order); never guessable
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT orders_id_format CHECK (id ~ '^DO-[0-9]{1,12}$'),
  -- ONE vocabulary (lib/orders.ts ORDER_STATUSES mirrors it; blueprint §9.7).
  CONSTRAINT orders_status_valid CHECK (status IN ('pending', 'processing', 'accepted', 'fulfilled', 'shipped',
                                                   'out_for_delivery', 'delivered', 'cancelled')),
  CONSTRAINT orders_fulfillment_valid CHECK (fulfillment IN ('delivery', 'pickup')),
  CONSTRAINT orders_payment_method_valid CHECK (payment_method IN ('cod', 'bank_transfer')),
  CONSTRAINT orders_payment_status_valid CHECK (payment_status IN ('pending_collection', 'awaiting_transfer',
                                                                   'paid', 'refunded', 'void')),
  -- Each method has its own "not yet paid" state: COD is collected, a transfer is awaited.
  CONSTRAINT orders_payment_pair_valid CHECK (
       (payment_method = 'cod'           AND payment_status <> 'awaiting_transfer')
    OR (payment_method = 'bank_transfer' AND payment_status <> 'pending_collection')),
  CONSTRAINT orders_money_valid CHECK (
        subtotal >= 0 AND shipping_fee >= 0 AND discount_amount >= 0 AND total_price >= 0
    AND packing_charges >= 0 AND packing_charges <= 100000),
  CONSTRAINT orders_currency_valid CHECK (currency ~ '^[A-Z]{3}$' AND exchange_rate > 0 AND exchange_rate <= 1000),
  CONSTRAINT orders_shipping_object CHECK (jsonb_typeof(shipping_address) = 'object'),
  CONSTRAINT orders_text_lengths CHECK (
        char_length(email) BETWEEN 3 AND 255
    AND (first_name      IS NULL OR char_length(first_name)      <= 255)
    AND (last_name       IS NULL OR char_length(last_name)       <= 255)
    AND char_length(phone) BETWEEN 1 AND 50
    AND (customer_note   IS NULL OR char_length(customer_note)   <= 1000)
    AND (discount_code   IS NULL OR char_length(discount_code)   <= 64)
    AND (payment_ref     IS NULL OR char_length(payment_ref)     <= 120)
    AND (tracking_number IS NULL OR char_length(tracking_number) <= 100)
    AND (tracking_url    IS NULL OR (char_length(tracking_url) <= 500 AND tracking_url ~ '^https://[^\\\s]+$')))
);

CREATE INDEX IF NOT EXISTS orders_customer_idx      ON public.orders (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_email_lower_idx   ON public.orders (lower(email));
CREATE INDEX IF NOT EXISTS orders_created_idx       ON public.orders (created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx        ON public.orders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_discount_code_idx ON public.orders (upper(discount_code)) WHERE discount_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_discount_id_idx   ON public.orders (discount_id) WHERE discount_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.order_items (
  id           BIGSERIAL PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES public.orders (id) ON DELETE CASCADE,
  product_id   INT REFERENCES public.products (id) ON DELETE SET NULL,
  variant_id   INT REFERENCES public.product_variants (id) ON DELETE SET NULL,
  quantity     INT NOT NULL,
  unit_price   NUMERIC(12,2) NOT NULL,                        -- LKR charged per unit (the variant's price at checkout)
  -- Snapshots: the line stays readable after the product or variant is renamed or deleted.
  product_name TEXT NOT NULL,
  brand        TEXT,
  variant_name TEXT,
  sku          TEXT,
  image_url    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_items_quantity_valid CHECK (quantity BETWEEN 1 AND 1000),
  CONSTRAINT order_items_price_valid    CHECK (unit_price >= 0),
  CONSTRAINT order_items_text_lengths   CHECK (
        char_length(product_name) BETWEEN 1 AND 200
    AND (brand        IS NULL OR char_length(brand)        <= 80)
    AND (variant_name IS NULL OR char_length(variant_name) <= 120)
    AND (sku          IS NULL OR char_length(sku)          <= 64)
    AND (image_url    IS NULL OR char_length(image_url)    <= 1000))
);
CREATE INDEX IF NOT EXISTS order_items_order_idx   ON public.order_items (order_id, id);
CREATE INDEX IF NOT EXISTS order_items_product_idx ON public.order_items (product_id);
CREATE INDEX IF NOT EXISTS order_items_variant_idx ON public.order_items (variant_id);

-- The shopper's timeline. `status` is a HUMAN label ("Out for delivery", "Ready for pickup"),
-- deliberately separate from orders.status.
CREATE TABLE IF NOT EXISTS public.order_tracking (
  id          BIGSERIAL PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES public.orders (id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  location    TEXT,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_tracking_text_lengths CHECK (
        char_length(btrim(status)) BETWEEN 1 AND 80
    AND (location    IS NULL OR char_length(location)    <= 120)
    AND (description IS NULL OR char_length(description) <= 1000))
);
CREATE INDEX IF NOT EXISTS order_tracking_order_idx ON public.order_tracking (order_id, created_at, id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Triggers
-- ─────────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS orders_touch ON public.orders;
CREATE TRIGGER orders_touch BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- RLS is row-level; this guards COLUMNS. Admins hold ALL on orders (blueprint §7.4), but the
-- reference store's admin panel wrote statuses straight into the row, so cancellations never
-- restocked, never reversed lifetime value and never returned discount uses (§14 #16), and
-- tracking was saved with no timeline row. Here:
--   * INSERT through the API is refused: orders are created only by place_order() (P1);
--   * DELETE through the API is refused: deleting would skip the cancellation reversals —
--     cancel with admin_set_order_status instead (test orders can be removed in the SQL editor);
--   * an UPDATE that changes a managed column is refused with 22023 naming the column;
--   * definer functions that set app.trusted_write = 'on' for their transaction (place_order,
--     the admin order RPCs, link_guest_orders) and callers with no JWT (SQL editor, jobs,
--     migrations: auth.uid() IS NULL) pass;
--   * the foreign keys' ON DELETE SET NULL passes: customer_id / discount_id may become NULL
--     once the referenced customer / discount row no longer exists (an admin deleting a
--     discount code or an account keeps working; detaching by hand is still refused).
-- Freely editable by an admin: first_name, last_name, phone, shipping_address, customer_note.
CREATE OR REPLACE FUNCTION public.orders_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_col TEXT;
BEGIN
  IF auth.uid() IS NULL OR current_setting('app.trusted_write', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'order_insert_managed:orders are created only by place_order';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'order_delete_managed:cancel the order with admin_set_order_status instead of deleting it';
  END IF;
  v_col := CASE
    WHEN NEW.id              IS DISTINCT FROM OLD.id              THEN 'id'
    WHEN NEW.email           IS DISTINCT FROM OLD.email           THEN 'email'
    WHEN NEW.status          IS DISTINCT FROM OLD.status          THEN 'status'
    WHEN NEW.fulfillment     IS DISTINCT FROM OLD.fulfillment     THEN 'fulfillment'
    WHEN NEW.subtotal        IS DISTINCT FROM OLD.subtotal        THEN 'subtotal'
    WHEN NEW.shipping_fee    IS DISTINCT FROM OLD.shipping_fee    THEN 'shipping_fee'
    WHEN NEW.discount_code   IS DISTINCT FROM OLD.discount_code   THEN 'discount_code'
    WHEN NEW.discount_amount IS DISTINCT FROM OLD.discount_amount THEN 'discount_amount'
    WHEN NEW.total_price     IS DISTINCT FROM OLD.total_price     THEN 'total_price'
    WHEN NEW.packing_charges IS DISTINCT FROM OLD.packing_charges THEN 'packing_charges'
    WHEN NEW.currency        IS DISTINCT FROM OLD.currency        THEN 'currency'
    WHEN NEW.exchange_rate   IS DISTINCT FROM OLD.exchange_rate   THEN 'exchange_rate'
    WHEN NEW.payment_method  IS DISTINCT FROM OLD.payment_method  THEN 'payment_method'
    WHEN NEW.payment_status  IS DISTINCT FROM OLD.payment_status  THEN 'payment_status'
    WHEN NEW.payment_ref     IS DISTINCT FROM OLD.payment_ref     THEN 'payment_ref'
    WHEN NEW.tracking_number IS DISTINCT FROM OLD.tracking_number THEN 'tracking_number'
    WHEN NEW.tracking_url    IS DISTINCT FROM OLD.tracking_url    THEN 'tracking_url'
    WHEN NEW.view_token      IS DISTINCT FROM OLD.view_token      THEN 'view_token'
    WHEN NEW.created_at      IS DISTINCT FROM OLD.created_at      THEN 'created_at'
  END;
  -- Links: cleared only by the foreign keys' ON DELETE SET NULL (the referenced row is gone).
  -- Separate statements, so `discounts` is only looked up once 08 exists and a link changed.
  IF v_col IS NULL AND NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN
    IF NEW.customer_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.customers c WHERE c.id = OLD.customer_id) THEN
      v_col := 'customer_id';
    END IF;
  END IF;
  IF v_col IS NULL AND NEW.discount_id IS DISTINCT FROM OLD.discount_id THEN
    IF NEW.discount_id IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.discounts d WHERE d.id = OLD.discount_id) THEN
      v_col := 'discount_id';
    END IF;
  END IF;
  IF v_col IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'order_field_managed:' || v_col
             || ' changes only through admin_set_order_status / admin_set_payment_status';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.orders_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS orders_10_guard ON public.orders;
CREATE TRIGGER orders_10_guard BEFORE INSERT OR UPDATE OR DELETE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_guard();

-- Order lines are the ledger's money: written only by place_order (trusted write). Through the
-- API nobody — admins included — inserts, edits or deletes a line (42501), because totals on the
-- order row are pinned and would silently disagree with edited lines. The one change that
-- passes is the foreign keys' ON DELETE SET NULL: deleting a product or variant clears
-- product_id / variant_id (the snapshots keep the line readable). Callers with no JWT (SQL
-- editor, jobs, the cascade of an order deleted there) pass.
CREATE OR REPLACE FUNCTION public.order_items_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL OR current_setting('app.trusted_write', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id AND NEW.order_id = OLD.order_id
     AND NEW.quantity = OLD.quantity AND NEW.unit_price = OLD.unit_price
     AND NEW.product_name = OLD.product_name
     AND NEW.brand IS NOT DISTINCT FROM OLD.brand
     AND NEW.variant_name IS NOT DISTINCT FROM OLD.variant_name
     AND NEW.sku IS NOT DISTINCT FROM OLD.sku
     AND NEW.image_url IS NOT DISTINCT FROM OLD.image_url
     AND NEW.created_at = OLD.created_at
     AND (NEW.product_id IS NOT DISTINCT FROM OLD.product_id
          OR (NEW.product_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = OLD.product_id)))
     AND (NEW.variant_id IS NOT DISTINCT FROM OLD.variant_id
          OR (NEW.variant_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM public.product_variants v WHERE v.id = OLD.variant_id))) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = 'order_items_managed:order lines are written only by place_order';
END $$;
REVOKE ALL ON FUNCTION public.order_items_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS order_items_10_guard ON public.order_items;
CREATE TRIGGER order_items_10_guard BEFORE INSERT OR UPDATE OR DELETE ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.order_items_guard();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Row-level security
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.orders         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_tracking ENABLE ROW LEVEL SECURITY;

-- anon never touches the ledger (guests see their order only through view_order /
-- track_guest_order); nobody truncates through the API.
REVOKE ALL ON TABLE public.orders, public.order_items, public.order_tracking FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.orders, public.order_items, public.order_tracking FROM authenticated;
REVOKE ALL ON SEQUENCE public.order_items_id_seq, public.order_tracking_id_seq FROM anon;

-- The signed-in viewer's email, lower-cased, ONLY once Supabase Auth has confirmed it (else NULL).
-- The email branch of the owner policies below trusts the address, so it must be a verified one
-- even if "Confirm email" were switched off or a provider that skips verification were added
-- (hardening beyond blueprint §7.4, which relies on the Auth setting alone). Definer: reads auth.users.
CREATE OR REPLACE FUNCTION public._viewer_verified_email() RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT lower(u.email) FROM auth.users u
   WHERE u.id = auth.uid() AND u.email_confirmed_at IS NOT NULL
$$;
REVOKE ALL ON FUNCTION public._viewer_verified_email() FROM PUBLIC, anon, authenticated;
-- Policies run as the querying role, which therefore needs EXECUTE; it only ever returns the
-- caller's own confirmed address.
GRANT EXECUTE ON FUNCTION public._viewer_verified_email() TO authenticated;

-- Owners read their own: by account OR by their CONFIRMED sign-in email (blueprint §7.4).
DROP POLICY IF EXISTS orders_owner_read ON public.orders;
CREATE POLICY orders_owner_read ON public.orders
  FOR SELECT TO authenticated
  USING (customer_id = (SELECT auth.uid()) OR lower(email) = (SELECT public._viewer_verified_email()));
DROP POLICY IF EXISTS orders_admin_all ON public.orders;
CREATE POLICY orders_admin_all ON public.orders
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS order_items_owner_read ON public.order_items;
CREATE POLICY order_items_owner_read ON public.order_items
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o
                  WHERE o.id = order_items.order_id
                    AND (o.customer_id = (SELECT auth.uid()) OR lower(o.email) = (SELECT public._viewer_verified_email()))));
DROP POLICY IF EXISTS order_items_admin_all ON public.order_items;
CREATE POLICY order_items_admin_all ON public.order_items
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS order_tracking_owner_read ON public.order_tracking;
CREATE POLICY order_tracking_owner_read ON public.order_tracking
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders o
                  WHERE o.id = order_tracking.order_id
                    AND (o.customer_id = (SELECT auth.uid()) OR lower(o.email) = (SELECT public._viewer_verified_email()))));
DROP POLICY IF EXISTS order_tracking_admin_all ON public.order_tracking;
CREATE POLICY order_tracking_admin_all ON public.order_tracking
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 07_orders
--   Nothing to configure here. Orders appear only once 09_order_rpcs.sql is applied (place_order);
--   apply 07 → 08 → 09 together, BEFORE deploying the checkout code (a missing RPC answers 503).
--   Guest orders link to an account when that email is CONFIRMED (02's triggers now find this
--   table), and the account adopts their spend (customers.total_spent / orders_count).
--   Never delete orders to "undo" them: cancel through the admin panel (restocks, reverses the
--   customer's lifetime value and returns the discount use). Direct status/money edits and
--   deletes from the app are refused by orders_10_guard / order_items_10_guard on purpose (to
--   clear TEST orders before launch, delete them in the SQL editor — no JWT there — and fix
--   stock by hand).
--   Keep Supabase Auth → Email → "Confirm email" ON. Shoppers read orders placed with their
--   sign-in email (owner RLS) and guest orders link to accounts by email; both are safe only
--   because Supabase proves the address before issuing a session.
--   Verification:
--     SELECT last_value, is_called FROM public.order_number_seq;          -- 10001 / f on a fresh DB
--     SELECT has_table_privilege('anon', 'public.orders', 'SELECT');       -- false
--     SELECT has_sequence_privilege('authenticated', 'public.order_number_seq', 'USAGE');  -- false
--     SELECT tgrelid::regclass, tgname FROM pg_trigger
--      WHERE tgrelid IN ('public.orders'::regclass, 'public.order_items'::regclass) AND NOT tgisinternal;
--       -- orders: orders_10_guard, orders_touch · order_items: order_items_10_guard
--     -- live probes (anon key is public): the ledger is closed to anon
--     curl -s "$SUPABASE_URL/rest/v1/orders?select=id" -H "apikey: $ANON"                  -- permission denied
--     curl -s -X POST "$SUPABASE_URL/rest/v1/orders" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
--          -H "Content-Type: application/json" -d '{"id":"DO-1","email":"x@y.lk","phone":"1"}'  -- permission denied
-- ═════════════════════════════════════════════════════════════════════════════
