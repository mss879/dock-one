-- ═════════════════════════════════════════════════════════════════════════════
-- 25_serial_numbers.sql — Dock One Solutions
--
-- PURPOSE      Serial numbers for every physical unit. The store doesn't use SKUs: each laptop,
--              monitor or drive has its own manufacturer serial, and that is what goes on the
--              invoice and what a warranty claim quotes.
--
--   product_units      one row per unit: its variant (and product), its serial number, and
--                      whether it is IN STOCK or SOLD — and if sold, to which web order line
--                      (`order_item_id`) and/or invoice line (`invoice_item_id`, the foreign key
--                      is added by 26_invoices).
--
--   Stock COUNTS stay where they are: inventory.stock_level is still the number a shopper can
--   buy (place_order takes it at checkout, cancelling gives it back — 09). The units are the
--   physical register on top of it: a web order takes a count at checkout, and the admin picks
--   WHICH serials leave when fulfilling it. So right after a sale, "units in stock" can be one
--   more than stock_level until that order's serials are assigned.
--
--   admin_set_product_serials(p_product_id, p_variants)       grant U, admin re-checked
--       The product editor: for each listed variant, its IN-STOCK serials become exactly the
--       list (new ones added, missing ones removed — sold units are never touched). One call
--       for the whole product, so a serial can move between two of its variants in one save.
--   admin_assign_order_serials(p_order_item_id, p_serials)    grant U, admin re-checked
--       Fulfilment: the serials leaving with one web-order line — at most its quantity. An
--       in-stock unit of that variant becomes SOLD to the line; a serial not recorded yet is
--       recorded as sold (older stock entered without serials); serials taken off the line go
--       back in stock.
--   orders_release_units                                         trigger
--       An order that is cancelled gives its serials back to stock (unless an invoice still
--       holds them).
--
-- DEPENDS ON   01 (touch_updated_at), 02 (is_admin, customers), 04 (product_variants),
--              07 (orders, order_items), 23 (_admin_json_int).
-- ENABLES      the serial-number fields in admin → Products (stock), "Serial numbers" in the
--              admin order drawer, the packing slip's S/N lines, and 26_invoices (invoice lines
--              pick, print and sell serials).
-- ERRORS       42501 `not_authorised:…`. 22023 `code:human text` — invalid_serials,
--              product_not_found, variant_not_in_product, duplicate_serial, serial_taken,
--              serial_sold, serial_other_variant, order_item_not_found, order_cancelled,
--              item_unlinked, too_many_serials (show the text after the first ':').
-- LOCK ORDER   orders row (fulfilment) → product_units rows by id. Units are always locked
--              after any inventory rows (26's issue), never before them.
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The unit register
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.product_units (
  id              SERIAL PRIMARY KEY,
  product_id      INT NOT NULL,                       -- always the variant's product (trigger)
  variant_id      INT NOT NULL,
  serial_number   TEXT NOT NULL,                      -- as printed on the unit (trimmed)
  status          TEXT NOT NULL DEFAULT 'in_stock',   -- in_stock | sold
  order_item_id   BIGINT REFERENCES public.order_items (id) ON DELETE SET NULL,   -- sold through this web-order line
  invoice_item_id INT,                                -- sold on this invoice line (FK: 26_invoices)
  sold_at         TIMESTAMPTZ,
  created_by      UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_units_variant_product_fkey FOREIGN KEY (variant_id, product_id)
    REFERENCES public.product_variants (id, product_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT product_units_status_valid CHECK (status IN ('in_stock', 'sold')),
  -- an in-stock unit belongs to no sale
  CONSTRAINT product_units_links_valid  CHECK (status = 'sold' OR (order_item_id IS NULL AND invoice_item_id IS NULL)),
  CONSTRAINT product_units_serial_valid CHECK (char_length(serial_number) BETWEEN 1 AND 100
                                               AND serial_number = btrim(serial_number)
                                               AND serial_number !~ '[[:cntrl:]]')
);
-- One unit per serial within a product (any case). Different products may share a serial.
CREATE UNIQUE INDEX IF NOT EXISTS product_units_serial_key ON public.product_units (product_id, upper(serial_number));
CREATE INDEX IF NOT EXISTS product_units_variant_idx      ON public.product_units (variant_id, status, id);
CREATE INDEX IF NOT EXISTS product_units_lookup_idx       ON public.product_units (upper(serial_number));
CREATE INDEX IF NOT EXISTS product_units_order_item_idx   ON public.product_units (order_item_id) WHERE order_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_units_invoice_item_idx ON public.product_units (invoice_item_id) WHERE invoice_item_id IS NOT NULL;

-- product_id follows the variant (writers send variant_id only), like 05's inventory.
CREATE OR REPLACE FUNCTION public.product_units_normalize() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_pid INT;
BEGIN
  SELECT v.product_id INTO v_pid FROM public.product_variants v WHERE v.id = NEW.variant_id;
  IF v_pid IS NOT NULL THEN
    NEW.product_id := v_pid;
  END IF;
  NEW.serial_number := btrim(NEW.serial_number, E' \t\r\n');
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.product_units_normalize() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS product_units_10_normalize ON public.product_units;
CREATE TRIGGER product_units_10_normalize BEFORE INSERT OR UPDATE ON public.product_units
  FOR EACH ROW EXECUTE FUNCTION public.product_units_normalize();

-- Admins read the register; every write is an RPC below.
ALTER TABLE public.product_units ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_units FROM anon, authenticated;
GRANT SELECT ON public.product_units TO authenticated;
REVOKE ALL ON SEQUENCE public.product_units_id_seq FROM anon, authenticated;
DROP POLICY IF EXISTS product_units_admin_read ON public.product_units;
CREATE POLICY product_units_admin_read ON public.product_units
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Internal helpers (no grants)
-- ─────────────────────────────────────────────────────────────────────────────

-- A JSON list of serials → trimmed, blanks dropped, ≤ p_max entries of ≤ 100 characters, no
-- control characters, no duplicate (any case). Raises 22023 `<p_code>:…` for the admin form.
CREATE OR REPLACE FUNCTION public._serials_from_json(p_code TEXT, p_value JSONB, p_label TEXT, p_max INT)
RETURNS TEXT[]
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_out TEXT[] := '{}';
  v_up  TEXT[] := '{}';
  e     JSONB;
  t     TEXT;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RETURN v_out;
  END IF;
  IF jsonb_typeof(p_value) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('%s:%s must be a list.', p_code, p_label);
  END IF;
  FOR e IN SELECT x FROM jsonb_array_elements(p_value) AS x LOOP
    IF jsonb_typeof(e) <> 'string' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('%s:%s must be a list of text.', p_code, p_label);
    END IF;
    t := NULLIF(btrim(e #>> '{}', E' \t\r\n'), '');
    CONTINUE WHEN t IS NULL;
    IF char_length(t) > 100 OR t ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('%s:%s: “%s…” isn''t a serial number (at most 100 characters on one line).', p_code, p_label, left(t, 30));
    END IF;
    IF upper(t) = ANY (v_up) THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('duplicate_serial:%s: S/N %s is listed twice.', p_label, t);
    END IF;
    v_out := v_out || t;
    v_up := v_up || upper(t);
  END LOOP;
  IF cardinality(v_out) > p_max THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('%s:%s can have at most %s serial numbers.', p_code, p_label, p_max);
  END IF;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public._serials_from_json(TEXT, JSONB, TEXT, INT) FROM PUBLIC, anon, authenticated;

-- "on order DO-10042" / "on an invoice" — where a sold unit went, for messages.
CREATE OR REPLACE FUNCTION public._unit_sold_where(p_unit public.product_units)
RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_where TEXT;
BEGIN
  IF p_unit.order_item_id IS NOT NULL THEN
    SELECT 'on order ' || oi.order_id INTO v_where FROM public.order_items oi WHERE oi.id = p_unit.order_item_id;
  END IF;
  IF v_where IS NULL AND p_unit.invoice_item_id IS NOT NULL AND to_regclass('public.invoices') IS NOT NULL THEN
    EXECUTE 'SELECT ''on '' || COALESCE(i.number, ''a draft invoice'') FROM public.invoice_items it
               JOIN public.invoices i ON i.id = it.invoice_id WHERE it.id = $1'
      INTO v_where USING p_unit.invoice_item_id;
  END IF;
  RETURN COALESCE(v_where, 'already');
END $$;
REVOKE ALL ON FUNCTION public._unit_sold_where(public.product_units) FROM PUBLIC, anon, authenticated;

-- True when an invoice line belongs to an invoice made for this web order (26_invoices; FALSE
-- before 26 is applied — dynamic SQL, so this file stands on its own).
CREATE OR REPLACE FUNCTION public._invoice_line_for_order(p_invoice_item_id INT, p_order_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_hit BOOLEAN := FALSE;
BEGIN
  IF p_invoice_item_id IS NULL OR p_order_id IS NULL OR to_regclass('public.invoices') IS NULL THEN
    RETURN FALSE;
  END IF;
  EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.invoice_items it JOIN public.invoices i ON i.id = it.invoice_id
                           WHERE it.id = $1 AND i.order_id = $2)'
    INTO v_hit USING p_invoice_item_id, p_order_id;
  RETURN COALESCE(v_hit, FALSE);
END $$;
REVOKE ALL ON FUNCTION public._invoice_line_for_order(INT, TEXT) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. admin_set_product_serials(p_product_id INT, p_variants JSONB) → JSONB
-- ─────────────────────────────────────────────────────────────────────────────
-- p_variants  [{variant_id, serials: ["…", …]}, …] — variants of THIS product (others → error).
--             For each listed variant its IN-STOCK serials become exactly `serials` (≤ 1,000):
--             missing ones are removed, new ones recorded. Variants not listed are untouched;
--             sold units are never touched. A serial may move between two listed variants.
-- Refused: a serial listed twice anywhere in the call (duplicate_serial); one that is SOLD
-- (serial_sold — it can only come back by cancelling that order / voiding that invoice); one in
-- stock under a variant that isn't in this call (serial_taken).
-- Returns {product_id, variants: [{variant_id, in_stock: [serials in entry order]}]}.
CREATE OR REPLACE FUNCTION public.admin_set_product_serials(p_product_id INT, p_variants JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_code CONSTANT TEXT := 'invalid_serials';
  v_variant_ids INT[] := '{}';
  v_all_up      TEXT[] := '{}';
  v_serials     TEXT[];
  v_vid         INT;
  v_label       TEXT;
  e             JSONB;
  s             TEXT;
  u             public.product_units;
  v_out         JSONB := '[]'::jsonb;
  v_me          UUID := (SELECT c.id FROM public.customers c WHERE c.id = auth.uid());
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can record serial numbers.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = p_product_id) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'product_not_found:This product no longer exists — it may have been deleted in another tab.';
  END IF;
  IF p_variants IS NULL OR jsonb_typeof(p_variants) <> 'array' OR jsonb_array_length(p_variants) > 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_serials:The serial numbers must be a list of variants.';
  END IF;

  -- 1. Read and check everything before touching anything.
  FOR e IN SELECT x FROM jsonb_array_elements(p_variants) AS x LOOP
    IF jsonb_typeof(e) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_serials:Each entry must be {variant_id, serials}.';
    END IF;
    v_vid := public._admin_json_int(c_code, e -> 'variant_id', 'The variant', 1, 2147483647);
    SELECT v.name INTO v_label FROM public.product_variants v WHERE v.id = v_vid AND v.product_id = p_product_id;
    IF v_vid IS NULL OR NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'variant_not_in_product:A variant in the list doesn''t belong to this product. Reload and try again.';
    END IF;
    IF v_vid = ANY (v_variant_ids) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_serials:The variant “%s” is listed twice.', v_label);
    END IF;
    v_variant_ids := v_variant_ids || v_vid;
    v_serials := public._serials_from_json(c_code, e -> 'serials', format('“%s”', v_label), 1000);
    FOREACH s IN ARRAY v_serials LOOP
      IF upper(s) = ANY (v_all_up) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('duplicate_serial:S/N %s is listed under two variants.', s);
      END IF;
      v_all_up := v_all_up || upper(s);
    END LOOP;
  END LOOP;

  -- 2. Lock the product's units (in id order), then compare with the register.
  PERFORM 1 FROM public.product_units pu WHERE pu.product_id = p_product_id ORDER BY pu.id FOR UPDATE;
  FOR u IN SELECT * FROM public.product_units pu
            WHERE pu.product_id = p_product_id AND upper(pu.serial_number) = ANY (v_all_up)
  LOOP
    IF u.status = 'sold' THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('serial_sold:S/N %s was sold %s, so it can''t be in stock. Cancel that order or void that invoice to bring it back.',
                         u.serial_number, public._unit_sold_where(u));
    END IF;
    IF NOT (u.variant_id = ANY (v_variant_ids)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('serial_taken:S/N %s is already in stock under another variant of this product.', u.serial_number);
    END IF;
  END LOOP;

  -- 3. Remove the in-stock serials that are no longer listed (first, so a serial can move).
  FOR e IN SELECT x FROM jsonb_array_elements(p_variants) AS x LOOP
    v_vid := (e ->> 'variant_id')::INT;
    v_serials := public._serials_from_json(c_code, e -> 'serials', 'Serials', 1000);
    DELETE FROM public.product_units pu
     WHERE pu.variant_id = v_vid AND pu.status = 'in_stock'
       AND NOT (upper(pu.serial_number) = ANY (v_all_up));     -- listed under another variant = a move (kept)
  END LOOP;

  -- 4. Record the new ones (a kept serial keeps its row; a moved one changes variant).
  FOR e IN SELECT x FROM jsonb_array_elements(p_variants) AS x LOOP
    v_vid := (e ->> 'variant_id')::INT;
    v_serials := public._serials_from_json(c_code, e -> 'serials', 'Serials', 1000);
    FOREACH s IN ARRAY v_serials LOOP
      UPDATE public.product_units pu SET variant_id = v_vid, serial_number = s
       WHERE pu.product_id = p_product_id AND upper(pu.serial_number) = upper(s) AND pu.status = 'in_stock';
      IF NOT FOUND THEN
        INSERT INTO public.product_units (product_id, variant_id, serial_number, created_by)
        VALUES (p_product_id, v_vid, s, v_me);
      END IF;
    END LOOP;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'variant_id', v_vid,
      'in_stock', COALESCE((SELECT jsonb_agg(pu.serial_number ORDER BY array_position(ARRAY(SELECT upper(x) FROM unnest(v_serials) AS x), upper(pu.serial_number)))
                              FROM public.product_units pu WHERE pu.variant_id = v_vid AND pu.status = 'in_stock'), '[]'::jsonb)));
  END LOOP;

  RETURN jsonb_build_object('product_id', p_product_id, 'variants', v_out);
END $$;
REVOKE ALL ON FUNCTION public.admin_set_product_serials(INT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_product_serials(INT, JSONB) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. admin_assign_order_serials(p_order_item_id BIGINT, p_serials JSONB) → JSONB
-- ─────────────────────────────────────────────────────────────────────────────
-- The serials leaving with one web-order line (fulfilment). p_serials: a JSON list of serial
-- numbers, at most the line's quantity ([] clears). For each:
--   · already on this line                 → kept;
--   · an in-stock unit of the line's variant → sold to this line;
--   · not recorded yet                      → recorded as sold to this line (older stock);
--   · in stock under ANOTHER variant        → refused (serial_other_variant);
--   · sold to another order / an invoice    → refused (serial_sold) — unless it is an invoice
--     made for this same order.
-- Serials taken off the line go back in stock (or stay sold if an invoice holds them).
-- Refused for a cancelled order, or a line whose product was deleted from the catalogue.
-- Returns {order_item_id, order_id, serials: [in entry order]}.
CREATE OR REPLACE FUNCTION public.admin_assign_order_serials(p_order_item_id BIGINT, p_serials JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  oi        public.order_items;
  v_status  TEXT;
  v_serials TEXT[];
  v_up      TEXT[];
  s         TEXT;
  u         public.product_units;
  v_label   TEXT;
  v_me      UUID := (SELECT c.id FROM public.customers c WHERE c.id = auth.uid());
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can assign serial numbers.';
  END IF;
  SELECT * INTO oi FROM public.order_items WHERE id = p_order_item_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'order_item_not_found:This order line no longer exists. Reload the order.';
  END IF;
  -- The order row first (the same lock admin_set_order_status takes), so a cancellation and an
  -- assignment never interleave.
  SELECT o.status INTO v_status FROM public.orders o WHERE o.id = oi.order_id FOR UPDATE;
  IF v_status = 'cancelled' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('order_cancelled:%s is cancelled — nothing leaves with it.', oi.order_id);
  END IF;
  IF oi.variant_id IS NULL OR oi.product_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('item_unlinked:“%s” is no longer in the catalogue, so its serials can''t be tracked.', left(oi.product_name, 80));
  END IF;
  v_label := oi.product_name || CASE WHEN oi.variant_name IS NOT NULL AND oi.variant_name <> 'Standard' THEN ' (' || oi.variant_name || ')' ELSE '' END;
  v_serials := public._serials_from_json('invalid_serials', p_serials, format('“%s”', left(v_label, 80)), 1000);
  IF cardinality(v_serials) > oi.quantity THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('too_many_serials:%s serial numbers for %s unit%s of “%s”.', cardinality(v_serials), oi.quantity,
                       CASE WHEN oi.quantity = 1 THEN '' ELSE 's' END, left(v_label, 80));
  END IF;
  v_up := ARRAY(SELECT upper(x) FROM unnest(v_serials) AS x);

  PERFORM 1 FROM public.product_units pu
    WHERE pu.order_item_id = oi.id OR (pu.product_id = oi.product_id AND upper(pu.serial_number) = ANY (v_up))
    ORDER BY pu.id
    FOR UPDATE;

  -- Off the line: back in stock (or still sold when an invoice holds it).
  UPDATE public.product_units pu
     SET order_item_id = NULL,
         status  = CASE WHEN pu.invoice_item_id IS NULL THEN 'in_stock' ELSE 'sold' END,
         sold_at = CASE WHEN pu.invoice_item_id IS NULL THEN NULL ELSE pu.sold_at END
   WHERE pu.order_item_id = oi.id AND NOT (upper(pu.serial_number) = ANY (v_up));

  FOREACH s IN ARRAY v_serials LOOP
    SELECT * INTO u FROM public.product_units pu WHERE pu.product_id = oi.product_id AND upper(pu.serial_number) = upper(s);
    IF NOT FOUND THEN
      INSERT INTO public.product_units (product_id, variant_id, serial_number, status, order_item_id, sold_at, created_by)
      VALUES (oi.product_id, oi.variant_id, s, 'sold', oi.id, now(), v_me);
    ELSIF u.order_item_id = oi.id THEN
      CONTINUE;
    ELSIF u.status = 'in_stock' THEN
      IF u.variant_id <> oi.variant_id THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = format('serial_other_variant:S/N %s is in stock under another variant of this product, not “%s”.', u.serial_number, left(v_label, 80));
      END IF;
      UPDATE public.product_units SET status = 'sold', order_item_id = oi.id, sold_at = now() WHERE id = u.id;
    ELSIF u.order_item_id IS NULL AND public._invoice_line_for_order(u.invoice_item_id, oi.order_id) THEN
      -- already on an invoice made for this very order: the same sale
      UPDATE public.product_units SET order_item_id = oi.id WHERE id = u.id;
    ELSE
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('serial_sold:S/N %s was sold %s.', u.serial_number, public._unit_sold_where(u));
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'order_item_id', oi.id,
    'order_id', oi.order_id,
    'serials', COALESCE((SELECT jsonb_agg(pu.serial_number ORDER BY array_position(v_up, upper(pu.serial_number)), pu.id)
                           FROM public.product_units pu WHERE pu.order_item_id = oi.id), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.admin_assign_order_serials(BIGINT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_order_serials(BIGINT, JSONB) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. A cancelled order gives its serials back
-- ─────────────────────────────────────────────────────────────────────────────
-- admin_set_order_status (09) restocks the counts; this puts the units back on the shelf.
CREATE OR REPLACE FUNCTION public.orders_release_units() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.product_units pu
     SET order_item_id = NULL,
         status  = CASE WHEN pu.invoice_item_id IS NULL THEN 'in_stock' ELSE 'sold' END,
         sold_at = CASE WHEN pu.invoice_item_id IS NULL THEN NULL ELSE pu.sold_at END
   WHERE pu.order_item_id IN (SELECT oi.id FROM public.order_items oi WHERE oi.order_id = NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.orders_release_units() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS orders_release_units ON public.orders;
CREATE TRIGGER orders_release_units AFTER UPDATE OF status ON public.orders
  FOR EACH ROW WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION public.orders_release_units();

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 25_serial_numbers
--   Nothing to configure. Apply after 01–24. Existing stock has no serials yet: open a product in
--   admin → Products, and under each variant's stock enter one serial per unit (the boxes
--   follow the stock number). Web orders: open the order and use "Serial numbers" on each line
--   when you pack it — the serials print on the packing slip and the invoice.
--   Verification:
--     SELECT p.oid::regprocedure, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can
--       FROM pg_proc p WHERE p.proname IN ('admin_set_product_serials', 'admin_assign_order_serials');  -- both false
--     SELECT has_table_privilege('anon', 'public.product_units', 'SELECT');                          -- false
--     -- units in stock vs the sellable count, per variant (a difference = web orders not yet given serials,
--     -- or stock entered without serials):
--     SELECT v.id, p.name, v.name, i.stock_level, count(u.id) FILTER (WHERE u.status = 'in_stock') AS units_in_stock
--       FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
--       LEFT JOIN public.inventory i ON i.variant_id = v.id
--       LEFT JOIN public.product_units u ON u.variant_id = v.id
--      GROUP BY v.id, p.name, v.name, i.stock_level HAVING count(u.id) > 0 ORDER BY p.name;
-- ═════════════════════════════════════════════════════════════════════════════
