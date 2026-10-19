-- ═════════════════════════════════════════════════════════════════════════════
-- 41_suppliers_warranty.sql — Dock One Solutions
--
-- PURPOSE      Suppliers, stock received from them, and warranty per serial-numbered unit.
--
--   suppliers         registration: name, contact person, phone, email, address, notes, active.
--                     Visible only to admins and staff with "Suppliers" (view / edit) — whatever the
--                     request (RLS calls staff_can directly). Only an admin deletes (switch off instead).
--   stock_movements   + supplier_id, supplier_month (the month and year the goods came in from the
--                     supplier). admin_record_stock_receipt() records "stock received" with them (38's
--                     ledger) and can stamp the same supplier details on the units' warranty records.
--   unit_warranties   one row per unit (25's product_units, by serial number):
--                       SUPPLIER warranty  — supplier, month received, start (month/year), expiry date,
--                                            coverage (what the supplier covers)
--                       CUSTOMER warranty  — start (month/year), expiry date, coverage (what the store
--                                            gives the client); filled automatically when the unit is
--                                            sold (sale date + the product's warranty months), editable.
--                     Read / written only through the RPCs below (no table grants): supplier fields are
--                     returned only to accounts allowed to see suppliers.
--   admin_warranty_search(term, status, limit, offset)   by product name or serial number, with
--                     "valid / expired" for each warranty as of today (Sri Lanka).
--   admin_save_warranty(unit_ids, data)   set warranty fields on one or many units.
--   admin_supplier_deliveries(supplier_id)  what came in from a supplier, by month.
--
-- DEPENDS ON   25 (product_units), 38 (stock_movements, admin_record_stock_movement), 39 (staff).
-- ERRORS       22023 invalid_supplier / invalid_warranty / supplier_not_found; 42501 not_authorised.
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Suppliers
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.suppliers (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  contact_person TEXT,
  phone          TEXT,
  email          TEXT,
  address        TEXT,
  notes          TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by     UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT suppliers_name_valid CHECK (char_length(btrim(name)) BETWEEN 1 AND 160 AND name = btrim(name)),
  CONSTRAINT suppliers_text_lengths CHECK (
        (contact_person IS NULL OR char_length(contact_person) <= 120)
    AND (phone   IS NULL OR char_length(phone)   <= 60)
    AND (address IS NULL OR char_length(address) <= 500)
    AND (notes   IS NULL OR char_length(notes)   <= 2000)),
  CONSTRAINT suppliers_email_valid CHECK (email IS NULL OR (char_length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'))
);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_key ON public.suppliers (lower(name));
DROP TRIGGER IF EXISTS suppliers_touch ON public.suppliers;
CREATE TRIGGER suppliers_touch BEFORE UPDATE ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE OR REPLACE FUNCTION public._suppliers_created_by() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.created_by := (SELECT c.id FROM public.customers c WHERE c.id = auth.uid());
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._suppliers_created_by() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS suppliers_created_by ON public.suppliers;
CREATE TRIGGER suppliers_created_by BEFORE INSERT ON public.suppliers FOR EACH ROW EXECUTE FUNCTION public._suppliers_created_by();

ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.suppliers FROM anon;
REVOKE ALL ON SEQUENCE public.suppliers_id_seq FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.suppliers FROM authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.suppliers TO authenticated;
GRANT USAGE ON SEQUENCE public.suppliers_id_seq TO authenticated;
DROP POLICY IF EXISTS suppliers_read ON public.suppliers;
CREATE POLICY suppliers_read ON public.suppliers FOR SELECT TO authenticated USING (public.staff_can('suppliers', 'view'));
DROP POLICY IF EXISTS suppliers_insert ON public.suppliers;
CREATE POLICY suppliers_insert ON public.suppliers FOR INSERT TO authenticated WITH CHECK (public.staff_can('suppliers', 'edit'));
DROP POLICY IF EXISTS suppliers_update ON public.suppliers;
CREATE POLICY suppliers_update ON public.suppliers FOR UPDATE TO authenticated
  USING (public.staff_can('suppliers', 'edit')) WITH CHECK (public.staff_can('suppliers', 'edit'));
DROP POLICY IF EXISTS suppliers_delete ON public.suppliers;
CREATE POLICY suppliers_delete ON public.suppliers FOR DELETE TO authenticated USING (public.is_full_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Stock received from a supplier (38's ledger)
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS supplier_id    INT REFERENCES public.suppliers (id) ON DELETE RESTRICT;
ALTER TABLE public.stock_movements ADD COLUMN IF NOT EXISTS supplier_month DATE;     -- first day of the month received
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_supplier_valid') THEN
    ALTER TABLE public.stock_movements ADD CONSTRAINT stock_movements_supplier_valid CHECK (
      supplier_month IS NULL OR (supplier_month = date_trunc('month', supplier_month)::DATE AND supplier_month >= DATE '2000-01-01'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS stock_movements_supplier_idx ON public.stock_movements (supplier_id, supplier_month) WHERE supplier_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Warranty per unit
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.unit_warranties (
  unit_id                 INT PRIMARY KEY REFERENCES public.product_units (id) ON DELETE CASCADE,
  supplier_id             INT REFERENCES public.suppliers (id) ON DELETE RESTRICT,
  supplier_received_month DATE,
  supplier_start          DATE,
  supplier_expiry         DATE,
  supplier_coverage       TEXT,
  customer_start          DATE,
  customer_expiry         DATE,
  customer_coverage       TEXT,
  customer_auto           BOOLEAN NOT NULL DEFAULT FALSE,     -- the customer warranty was filled in from the sale
  note                    TEXT,
  updated_by              UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unit_warranties_dates_valid CHECK (
        (supplier_start IS NULL OR supplier_expiry IS NULL OR supplier_expiry >= supplier_start)
    AND (customer_start IS NULL OR customer_expiry IS NULL OR customer_expiry >= customer_start)
    AND (supplier_received_month IS NULL OR supplier_received_month = date_trunc('month', supplier_received_month)::DATE)),
  CONSTRAINT unit_warranties_text_lengths CHECK (
        (supplier_coverage IS NULL OR char_length(supplier_coverage) <= 500)
    AND (customer_coverage IS NULL OR char_length(customer_coverage) <= 500)
    AND (note IS NULL OR char_length(note) <= 1000))
);
DROP TRIGGER IF EXISTS unit_warranties_touch ON public.unit_warranties;
CREATE TRIGGER unit_warranties_touch BEFORE UPDATE ON public.unit_warranties FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
ALTER TABLE public.unit_warranties ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.unit_warranties FROM anon, authenticated;     -- RPCs only

-- "12 Months" / "1 Year" (the invoice's WTY column words).
CREATE OR REPLACE FUNCTION public._warranty_words(p_months INT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_months IS NULL OR p_months <= 0 THEN NULL
              WHEN p_months % 12 = 0 THEN (p_months / 12) || CASE WHEN p_months = 12 THEN ' Year' ELSE ' Years' END
              ELSE p_months || CASE WHEN p_months = 1 THEN ' Month' ELSE ' Months' END END
$$;
REVOKE ALL ON FUNCTION public._warranty_words(INT) FROM PUBLIC, anon, authenticated;

-- A unit is sold → its customer warranty starts (sale date + the product's warranty months),
-- unless one was entered by hand. The invoice line's warranty words are the coverage.
CREATE OR REPLACE FUNCTION public._unit_customer_warranty() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_months INT;
  v_start  DATE := COALESCE((NEW.sold_at AT TIME ZONE 'Asia/Colombo')::DATE, (now() AT TIME ZONE 'Asia/Colombo')::DATE);
  v_words  TEXT;
BEGIN
  IF NEW.status = 'in_stock' AND OLD.status = 'sold' THEN          -- the sale was undone
    UPDATE public.unit_warranties
       SET customer_start = NULL, customer_expiry = NULL, customer_coverage = NULL, customer_auto = FALSE
     WHERE unit_id = NEW.id AND customer_auto;
    RETURN NULL;
  END IF;
  IF NEW.status <> 'sold' OR OLD.status = 'sold' THEN
    RETURN NULL;
  END IF;
  SELECT p.warranty_months INTO v_months FROM public.products p WHERE p.id = NEW.product_id;
  IF NEW.invoice_item_id IS NOT NULL THEN
    SELECT it.warranty INTO v_words FROM public.invoice_items it WHERE it.id = NEW.invoice_item_id;
  END IF;
  v_words := COALESCE(v_words, public._warranty_words(v_months));
  INSERT INTO public.unit_warranties (unit_id, customer_start, customer_expiry, customer_coverage, customer_auto)
  VALUES (NEW.id, v_start, CASE WHEN v_months > 0 THEN (v_start + make_interval(months => v_months))::DATE END, v_words, TRUE)
  ON CONFLICT (unit_id) DO UPDATE
    SET customer_start    = EXCLUDED.customer_start,
        customer_expiry   = EXCLUDED.customer_expiry,
        customer_coverage = EXCLUDED.customer_coverage,
        customer_auto     = TRUE
    WHERE public.unit_warranties.customer_start IS NULL OR public.unit_warranties.customer_auto;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._unit_customer_warranty() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS product_units_90_customer_warranty ON public.product_units;
CREATE TRIGGER product_units_90_customer_warranty AFTER UPDATE OF status ON public.product_units
  FOR EACH ROW EXECUTE FUNCTION public._unit_customer_warranty();

-- A date-or-month JSON value: "2026-10", "2026-10-15" or null. p_month → the first of the month.
CREATE OR REPLACE FUNCTION public._warranty_date(p_value JSONB, p_label TEXT, p_month BOOLEAN DEFAULT FALSE)
RETURNS DATE
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_text TEXT;
  v_date DATE;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RETURN NULL;
  END IF;
  v_text := btrim(p_value #>> '{}');
  IF v_text = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    IF v_text ~ '^\d{4}-\d{2}$' THEN
      v_date := (v_text || '-01')::DATE;
    ELSIF v_text ~ '^\d{4}-\d{2}-\d{2}$' THEN
      v_date := v_text::DATE;
    ELSE
      RAISE EXCEPTION 'bad';
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_warranty:%s must be a date (or a month and year).', p_label);
  END;
  IF v_date < DATE '2000-01-01' OR v_date > DATE '2100-12-31' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_warranty:%s is out of range.', p_label);
  END IF;
  RETURN CASE WHEN p_month THEN date_trunc('month', v_date)::DATE ELSE v_date END;
END $$;
REVOKE ALL ON FUNCTION public._warranty_date(JSONB, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RPCs
-- ─────────────────────────────────────────────────────────────────────────────
-- Units by product name / brand / variant or serial number. p_status: all | in_stock | sold |
-- supplier_valid | supplier_expired | customer_valid | customer_expired. Supplier fields are NULL
-- (and supplier_hidden TRUE) for accounts that may not see suppliers.
-- → {total, today, supplier_hidden, rows: [...]}
CREATE OR REPLACE FUNCTION public.admin_warranty_search(p_term TEXT DEFAULT NULL, p_status TEXT DEFAULT 'all', p_limit INT DEFAULT 50, p_offset INT DEFAULT 0)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_today  DATE := (now() AT TIME ZONE 'Asia/Colombo')::DATE;
  v_term   TEXT := lower(btrim(COALESCE(p_term, '')));
  v_status TEXT := lower(COALESCE(NULLIF(btrim(p_status), ''), 'all'));
  v_sup    BOOLEAN := public.staff_can('suppliers', 'view');
  v_limit  INT := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset INT := GREATEST(COALESCE(p_offset, 0), 0);
  v_out    JSONB;
BEGIN
  IF NOT public.is_admin() OR NOT public.staff_can('warranty', 'view') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t see warranty records.';
  END IF;
  IF v_status NOT IN ('all', 'in_stock', 'sold', 'supplier_valid', 'supplier_expired', 'customer_valid', 'customer_expired') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_warranty:Unknown filter.';
  END IF;
  WITH u AS (
    SELECT pu.id, pu.serial_number, pu.status, pu.sold_at, pu.order_item_id, pu.invoice_item_id,
           p.id AS product_id, p.brand, p.name AS product_name, v.name AS variant_name, p.variant_count, p.warranty_months,
           w.supplier_id, w.supplier_received_month, w.supplier_start, w.supplier_expiry, w.supplier_coverage,
           w.customer_start, w.customer_expiry, w.customer_coverage, w.customer_auto, w.note,
           (w.supplier_expiry IS NOT NULL AND w.supplier_expiry >= v_today) AS supplier_valid,
           (w.customer_expiry IS NOT NULL AND w.customer_expiry >= v_today) AS customer_valid
      FROM public.product_units pu
      JOIN public.products p ON p.id = pu.product_id
      JOIN public.product_variants v ON v.id = pu.variant_id
      LEFT JOIN public.unit_warranties w ON w.unit_id = pu.id
     WHERE (v_term = '' OR strpos(lower(concat_ws(' ', p.brand, p.name, v.name, pu.serial_number)), v_term) > 0)
  ), f AS (
    SELECT * FROM u
     WHERE CASE v_status
             WHEN 'in_stock' THEN u.status = 'in_stock'
             WHEN 'sold' THEN u.status = 'sold'
             WHEN 'supplier_valid' THEN u.supplier_valid
             WHEN 'supplier_expired' THEN u.supplier_expiry IS NOT NULL AND NOT u.supplier_valid
             WHEN 'customer_valid' THEN u.customer_valid
             WHEN 'customer_expired' THEN u.customer_expiry IS NOT NULL AND NOT u.customer_valid
             ELSE TRUE END
  )
  SELECT jsonb_build_object(
           'today', v_today, 'supplier_hidden', NOT v_sup,
           'total', (SELECT count(*) FROM f),
           'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                      'unit_id', f.id, 'serial_number', f.serial_number, 'status', f.status, 'sold_at', f.sold_at,
                      'product_id', f.product_id, 'brand', f.brand, 'product_name', f.product_name,
                      'variant_name', CASE WHEN f.variant_count > 1 OR lower(f.variant_name) <> 'standard' THEN f.variant_name END,
                      'sold_on', COALESCE((SELECT i.number FROM public.invoice_items it JOIN public.invoices i ON i.id = it.invoice_id WHERE it.id = f.invoice_item_id),
                                          (SELECT oi.order_id FROM public.order_items oi WHERE oi.id = f.order_item_id)),
                      'customer_name', COALESCE((SELECT i.bill_to_name FROM public.invoice_items it JOIN public.invoices i ON i.id = it.invoice_id WHERE it.id = f.invoice_item_id),
                                                (SELECT NULLIF(btrim(concat_ws(' ', o.first_name, o.last_name)), '') FROM public.order_items oi JOIN public.orders o ON o.id = oi.order_id WHERE oi.id = f.order_item_id)),
                      'supplier_id', CASE WHEN v_sup THEN f.supplier_id END,
                      'supplier_name', CASE WHEN v_sup THEN (SELECT s.name FROM public.suppliers s WHERE s.id = f.supplier_id) END,
                      'supplier_received_month', CASE WHEN v_sup THEN f.supplier_received_month END,
                      'supplier_start', CASE WHEN v_sup THEN f.supplier_start END,
                      'supplier_expiry', CASE WHEN v_sup THEN f.supplier_expiry END,
                      'supplier_coverage', CASE WHEN v_sup THEN f.supplier_coverage END,
                      'supplier_valid', CASE WHEN v_sup THEN f.supplier_valid END,
                      'customer_start', f.customer_start, 'customer_expiry', f.customer_expiry,
                      'customer_coverage', f.customer_coverage, 'customer_auto', COALESCE(f.customer_auto, FALSE),
                      'customer_valid', f.customer_valid, 'note', f.note)
                    ORDER BY lower(f.brand || ' ' || f.product_name), f.serial_number)
                    FROM (SELECT * FROM f ORDER BY lower(f.brand || ' ' || f.product_name), f.serial_number LIMIT v_limit OFFSET v_offset) f), '[]'::jsonb))
    INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_warranty_search(TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_warranty_search(TEXT, TEXT, INT, INT) TO authenticated;

-- Set warranty fields on units (1–500). Only the keys present are written; null clears.
-- Supplier keys need "Suppliers → edit"; customer keys / note need "Warranty → edit".
-- Keys: supplier_id, supplier_received_month, supplier_start, supplier_expiry, supplier_coverage,
--       customer_start, customer_expiry, customer_coverage, note.
CREATE OR REPLACE FUNCTION public.admin_save_warranty(p_unit_ids INT[], p_data JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_w   CONSTANT TEXT := 'invalid_warranty';
  c_sup CONSTANT TEXT[] := ARRAY['supplier_id', 'supplier_received_month', 'supplier_start', 'supplier_expiry', 'supplier_coverage'];
  c_cus CONSTANT TEXT[] := ARRAY['customer_start', 'customer_expiry', 'customer_coverage', 'note'];
  v_key TEXT;
  v_n   INT;
  v_sid INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t change warranty records.';
  END IF;
  IF p_data IS NULL OR jsonb_typeof(p_data) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_warranty:Nothing to save.';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_data) LOOP
    IF v_key = ANY (c_sup) THEN
      IF NOT public.staff_can('suppliers', 'edit') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t change supplier warranty details.';
      END IF;
    ELSIF v_key = ANY (c_cus) THEN
      IF NOT public.staff_can('warranty', 'edit') THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t change warranty records.';
      END IF;
    ELSE
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_warranty:The field “%s” can''t be saved here.', left(v_key, 40));
    END IF;
  END LOOP;
  v_n := COALESCE(cardinality(p_unit_ids), 0);
  IF v_n = 0 OR v_n > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_warranty:Choose 1 to 500 units.';
  END IF;
  IF (SELECT count(*) FROM public.product_units pu WHERE pu.id = ANY (p_unit_ids)) <> (SELECT count(DISTINCT x) FROM unnest(p_unit_ids) x) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_warranty:Some of those units no longer exist — reload and try again.';
  END IF;
  v_sid := public._admin_json_int(c_w, p_data -> 'supplier_id', 'The supplier', 1, 2147483647);
  IF v_sid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id = v_sid) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'supplier_not_found:That supplier no longer exists.';
  END IF;

  INSERT INTO public.unit_warranties (unit_id)
  SELECT DISTINCT x FROM unnest(p_unit_ids) x
  ON CONFLICT (unit_id) DO NOTHING;
  UPDATE public.unit_warranties w SET
    supplier_id             = CASE WHEN p_data ? 'supplier_id' THEN v_sid ELSE w.supplier_id END,
    supplier_received_month = CASE WHEN p_data ? 'supplier_received_month' THEN public._warranty_date(p_data -> 'supplier_received_month', 'The month received', TRUE) ELSE w.supplier_received_month END,
    supplier_start          = CASE WHEN p_data ? 'supplier_start' THEN public._warranty_date(p_data -> 'supplier_start', 'The supplier warranty start') ELSE w.supplier_start END,
    supplier_expiry         = CASE WHEN p_data ? 'supplier_expiry' THEN public._warranty_date(p_data -> 'supplier_expiry', 'The supplier warranty expiry') ELSE w.supplier_expiry END,
    supplier_coverage       = CASE WHEN p_data ? 'supplier_coverage' THEN public._admin_json_text(c_w, p_data -> 'supplier_coverage', 'The supplier coverage', 500) ELSE w.supplier_coverage END,
    customer_start          = CASE WHEN p_data ? 'customer_start' THEN public._warranty_date(p_data -> 'customer_start', 'The customer warranty start') ELSE w.customer_start END,
    customer_expiry         = CASE WHEN p_data ? 'customer_expiry' THEN public._warranty_date(p_data -> 'customer_expiry', 'The customer warranty expiry') ELSE w.customer_expiry END,
    customer_coverage       = CASE WHEN p_data ? 'customer_coverage' THEN public._admin_json_text(c_w, p_data -> 'customer_coverage', 'The customer coverage', 500) ELSE w.customer_coverage END,
    customer_auto           = CASE WHEN p_data ?| ARRAY['customer_start', 'customer_expiry', 'customer_coverage'] THEN FALSE ELSE w.customer_auto END,
    note                    = CASE WHEN p_data ? 'note' THEN public._admin_json_text(c_w, p_data -> 'note', 'The note', 1000) ELSE w.note END,
    updated_by              = auth.uid()
  WHERE w.unit_id = ANY (p_unit_ids);
  RETURN jsonb_build_object('updated', v_n);
EXCEPTION
  WHEN check_violation THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_warranty:An expiry date can''t be before its start.';
END $$;
REVOKE ALL ON FUNCTION public.admin_save_warranty(INT[], JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_warranty(INT[], JSONB) TO authenticated;

-- Stock received from a supplier: 38's "received" movement + the supplier and the month, and
-- (optionally) the supplier details stamped on these units' warranty records.
-- p_warranty: {supplier_start, supplier_expiry, supplier_coverage} (optional), p_unit_ids: units to stamp.
CREATE OR REPLACE FUNCTION public.admin_record_stock_receipt(
  p_variant_id INT, p_quantity INT, p_supplier_id INT, p_received_month DATE,
  p_reference TEXT DEFAULT NULL, p_note TEXT DEFAULT NULL, p_occurred_at TIMESTAMPTZ DEFAULT NULL,
  p_unit_ids INT[] DEFAULT NULL, p_warranty JSONB DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out   JSONB;
  v_month DATE := CASE WHEN p_received_month IS NULL THEN NULL ELSE date_trunc('month', p_received_month)::DATE END;
BEGIN
  IF NOT public.is_admin() OR NOT public.staff_can('inventory', 'edit') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t record stock.';
  END IF;
  IF p_supplier_id IS NOT NULL THEN
    IF NOT public.staff_can('suppliers', 'view') THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t see suppliers.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.suppliers s WHERE s.id = p_supplier_id) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'supplier_not_found:That supplier no longer exists.';
    END IF;
  END IF;
  IF v_month IS NOT NULL AND (v_month < DATE '2000-01-01' OR v_month > (now() AT TIME ZONE 'Asia/Colombo')::DATE) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_supplier:The month received can''t be in the future.';
  END IF;
  v_out := public.admin_record_stock_movement(p_variant_id, 'received', p_quantity, p_reference, p_note, p_occurred_at);
  UPDATE public.stock_movements SET supplier_id = p_supplier_id, supplier_month = v_month
   WHERE id = (v_out ->> 'movement_id')::BIGINT;
  IF p_unit_ids IS NOT NULL AND cardinality(p_unit_ids) > 0 THEN
    IF EXISTS (SELECT 1 FROM unnest(p_unit_ids) x WHERE NOT EXISTS (SELECT 1 FROM public.product_units pu WHERE pu.id = x AND pu.variant_id = p_variant_id)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_warranty:Those serial numbers are not units of this product.';
    END IF;
    PERFORM public.admin_save_warranty(p_unit_ids,
      jsonb_build_object('supplier_id', p_supplier_id, 'supplier_received_month', v_month)
      || COALESCE(p_warranty - ARRAY['customer_start', 'customer_expiry', 'customer_coverage', 'note', 'supplier_id', 'supplier_received_month'], '{}'::jsonb));
  END IF;
  RETURN v_out || jsonb_build_object('supplier_id', p_supplier_id, 'supplier_month', v_month);
END $$;
REVOKE ALL ON FUNCTION public.admin_record_stock_receipt(INT, INT, INT, DATE, TEXT, TEXT, TIMESTAMPTZ, INT[], JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_record_stock_receipt(INT, INT, INT, DATE, TEXT, TEXT, TIMESTAMPTZ, INT[], JSONB) TO authenticated;

-- What came in from a supplier: [{month, variant_id, product, quantity, references}] newest first.
CREATE OR REPLACE FUNCTION public.admin_supplier_deliveries(p_supplier_id INT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out JSONB;
BEGIN
  IF NOT public.staff_can('suppliers', 'view') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t see suppliers.';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'month', d.month, 'variant_id', d.variant_id, 'product', d.product, 'quantity', d.qty,
           'references', d.refs, 'last_at', d.last_at) ORDER BY d.month DESC NULLS LAST, d.last_at DESC), '[]'::jsonb)
    INTO v_out
    FROM (SELECT COALESCE(m.supplier_month, date_trunc('month', m.occurred_at AT TIME ZONE 'Asia/Colombo')::DATE) AS month,
                 m.variant_id,
                 concat_ws(' — ', CASE WHEN lower(p.name) LIKE lower(p.brand) || '%' THEN p.name ELSE p.brand || ' ' || p.name END,
                           CASE WHEN p.variant_count > 1 OR lower(v.name) <> 'standard' THEN v.name END) AS product,
                 sum(m.qty_in)::INT AS qty,
                 string_agg(DISTINCT m.reference, ', ') AS refs,
                 max(m.occurred_at) AS last_at
            FROM public.stock_movements m
            JOIN public.product_variants v ON v.id = m.variant_id
            JOIN public.products p ON p.id = v.product_id
           WHERE m.supplier_id = p_supplier_id AND m.movement_type = 'received'
           GROUP BY 1, 2, 3) d;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_supplier_deliveries(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_supplier_deliveries(INT) TO authenticated;

-- Units of a variant (for "stamp these serials" when stock is received).
CREATE OR REPLACE FUNCTION public.admin_variant_units(p_variant_id INT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t see units.';
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('unit_id', pu.id, 'serial_number', pu.serial_number, 'status', pu.status,
                                                       'has_supplier', w.supplier_id IS NOT NULL) ORDER BY pu.status, pu.id DESC)
                     FROM public.product_units pu LEFT JOIN public.unit_warranties w ON w.unit_id = pu.id
                    WHERE pu.variant_id = p_variant_id), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.admin_variant_units(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_variant_units(INT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Staff sections for this file
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM public.staff_api_map WHERE migration = '41';
INSERT INTO public.staff_api_map (kind, name, area, view_level, edit_level, migration)
SELECT k, n, a, v, e, '41'
  FROM (VALUES
    ('table', 'suppliers',                  'suppliers', 'view', 'edit'),
    ('rpc',   'admin_warranty_search',      'warranty',  'view', 'view'),
    ('rpc',   'admin_save_warranty',        'warranty',  'view', 'edit'),
    ('rpc',   'admin_save_warranty',        'suppliers', 'view', 'edit'),
    ('rpc',   'admin_record_stock_receipt', 'inventory', 'view', 'edit'),
    ('rpc',   'admin_supplier_deliveries',  'suppliers', 'view', 'view'),
    ('rpc',   'admin_variant_units',        'inventory', 'view', 'view'),
    ('rpc',   'admin_variant_units',        'warranty',  'view', 'view')
  ) AS m(k, n, a, v, e);

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 41_suppliers_warranty
--   Run after 40. Add suppliers in admin → Suppliers. Record deliveries with admin → Inventory →
--   Record movement → "Stock received" (supplier + month). Warranty records: admin → Warranty.
--   Units sold before this file have no customer warranty record until one is entered (or the unit
--   is sold again); units sold afterwards get one automatically from the product's warranty months.
--   Verification:
--     SELECT has_table_privilege('authenticated', 'public.unit_warranties', 'SELECT');  -- false
--     SELECT count(*) FROM public.suppliers;
-- ═════════════════════════════════════════════════════════════════════════════
