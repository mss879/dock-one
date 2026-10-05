-- ═════════════════════════════════════════════════════════════════════════════
-- 26_invoices.sql — Dock One Solutions
--
-- PURPOSE      Invoices made in the admin (Commerce → Invoices) — showroom, phone and business
--              sales, or a formal invoice for a web order — laid out like the client's own
--              invoice workbook (Final_Invoice_.xlsx): logo, address and contacts, BILL TO,
--              Invoice No / Date / Due Date, NO. · DESCRIPTION · WTY · QTY · UNIT PRICE (LKR) ·
--              AMOUNT, SUB TOTAL − DISCOUNT + VAT / TAX = TOTAL (LKR), payment terms, the
--              numbered notes and "Thank You!".
--
--   invoice_settings   ONE row: numbering (prefix, digits, next number), the header text, what a
--                      new invoice starts from (notes, payment terms, VAT / tax rate, due days,
--                      stock, bank details) and the closing lines. Filled once from the workbook;
--                      edited in the admin (the only table here admins write directly).
--   invoices           one row per invoice.
--                        DRAFT   no number; everything can change; can be deleted.
--                        ISSUED  gets the next number when first issued (gapless: taken under a
--                                row lock in the same transaction as everything else) and, when
--                                `deduct_stock` is on, takes its catalogue lines out of stock.
--                                Its number is kept for good. Quantities, prices, discount,
--                                VAT / tax, the invoice date and the stock setting are fixed;
--                                client details, due date, notes, terms and each line's
--                                description / warranty / serial numbers stay editable.
--                                "Back to draft" (only while no payment is recorded) returns the
--                                stock and unlocks everything; issuing again keeps the number.
--                        VOID    returns the stock and stays on record (numbered invoices are
--                                never deleted, so the sequence has no holes).
--   invoice_items      the lines, in order. A line may link a catalogue variant (stock, serials) or
--                      be free text (services, delivery). Description, warranty and price are
--                      SNAPSHOTS — editing the catalogue never changes an invoice. `stock_taken`
--                      is exactly what the line took from inventory (returned on draft/void).
--                      `serial_numbers` lists one serial per unit (printed "S/N: …"): issuing SELLS
--                      the matching in-stock units of 25's register to the line, back to draft /
--                      void puts them back, and a serial sold elsewhere is refused. A serial that
--                      isn't in the register (older stock) is simply printed.
--   invoice_payments   money received against an issued invoice (cash, bank transfer, card,
--                      cheque, online, other) → unpaid / partially paid / paid and the balance.
--
-- MONEY        line amount = round(qty × unit price, 2); subtotal = Σ line amounts;
--              discount = an amount (capped at the subtotal) or a percent of the subtotal;
--              VAT / TAX = a percent of (subtotal − discount) or an amount;
--              total = subtotal − discount + VAT / TAX; balance = total − payments.
--              Only _invoice_recalc() writes these (the API roles hold no write privilege on the
--              invoice tables at all). src/lib/admin/invoices.ts mirrors the arithmetic for the
--              live preview; the database stays the authority.
-- DEPENDS ON   01 (touch_updated_at), 02 (is_admin, customers), 04 (products, variants),
--              05 (inventory), 07 (orders), 23 (the _admin_json_* field readers),
--              25 (product_units — this file adds its invoice_item_id foreign key).
-- ENABLES      admin → Commerce → Invoices; "Create invoice" in the admin order drawer.
-- WRITES       Every invoice write is an admin RPC below (grant U, is_admin() re-checked inside).
--              Admins READ the four tables through RLS and UPDATE invoice_settings directly.
-- ERRORS       42501 `not_authorised:…` (caller is not an admin). 22023 `code:human text` —
--              invalid_invoice, invalid_item, invalid_payment, invoice_not_found, invoice_changed,
--              invoice_locked, invoice_void, invoice_incomplete, invoice_already_issued,
--              invoice_not_issued, invoice_numbered, invoice_has_payments, invalid_quantity,
--              insufficient_stock, overpayment, payment_not_found, invoice_settings_missing,
--              duplicate_serial, too_many_serials, serial_sold, serial_other_variant (show the text
--              after the first ':'). CHECK / FK violations keep their constraint names
--              (23514 / 23503). docs/build/SQL_NOTES.md (26).
-- LOCK ORDER   the invoice row → its inventory rows in (product_id, variant_id) order → its
--              product_units rows by id → the invoice_settings row (numbering). Inventory is locked
--              in the same global order as place_order, admin_set_order_status and
--              admin_save_product, and units always after inventory, so none can deadlock.
-- SAFE TO RE-RUN: yes (the settings row is inserted once and never overwritten).
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.invoice_settings (
  id                        BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),   -- singleton
  -- numbering: prefix || the next number zero-padded to `number_digits` → INV-0001
  number_prefix             TEXT NOT NULL DEFAULT 'INV-',
  number_digits             INT  NOT NULL DEFAULT 4,
  next_number               INT  NOT NULL DEFAULT 1,
  -- header (beside the logo); the first address line prints bold
  address_lines             TEXT[] NOT NULL DEFAULT '{}',
  phone                     TEXT,
  email                     TEXT,
  website                   TEXT,
  -- what a NEW invoice starts from (each invoice keeps its own copy)
  default_due_days          INT,                          -- NULL = no due date filled in
  default_payment_terms     TEXT,
  default_notes             TEXT[] NOT NULL DEFAULT '{}', -- printed numbered 1., 2., …
  default_tax_rate          NUMERIC(5,2) NOT NULL DEFAULT 0,
  default_deduct_stock      BOOLEAN NOT NULL DEFAULT TRUE,
  default_show_bank_details BOOLEAN NOT NULL DEFAULT FALSE,
  -- closing
  closing_title             TEXT,                         -- "Thank You!"
  closing_line              TEXT,                         -- "For choosing DockOne Solutions"
  footer_tagline            TEXT,                         -- the footer band, letter-spaced
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by                UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  CONSTRAINT invoice_settings_numbering_valid CHECK (
        char_length(number_prefix) <= 12 AND number_prefix ~ '^[A-Za-z0-9/#._-]*$'
    AND number_digits BETWEEN 1 AND 10
    AND next_number BETWEEN 1 AND 999999999),
  CONSTRAINT invoice_settings_text_lengths CHECK (
        (phone   IS NULL OR char_length(phone)   <= 40)
    AND (website IS NULL OR char_length(website) <= 120)
    AND (default_payment_terms IS NULL OR char_length(default_payment_terms) <= 2000)
    AND (closing_title  IS NULL OR char_length(closing_title)  <= 60)
    AND (closing_line   IS NULL OR char_length(closing_line)   <= 120)
    AND (footer_tagline IS NULL OR char_length(footer_tagline) <= 80)),
  CONSTRAINT invoice_settings_email_valid CHECK (
    email IS NULL OR (char_length(email) <= 254 AND email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  CONSTRAINT invoice_settings_defaults_valid CHECK (
        (default_due_days IS NULL OR default_due_days BETWEEN 0 AND 365)
    AND default_tax_rate BETWEEN 0 AND 100),
  -- ≤ 4 address lines of ≤ 120 characters, ≤ 20 notes of ≤ 500 (a regex count stops at 255), no NULLs
  CONSTRAINT invoice_settings_lists_valid CHECK (
        cardinality(address_lines) <= 4
    AND cardinality(default_notes) <= 20
    AND array_position(address_lines, NULL) IS NULL
    AND array_position(default_notes, NULL) IS NULL
    AND NOT jsonb_path_exists(to_jsonb(address_lines), '$[*] ? (@ like_regex "^.{121}" flag "s")')
    AND NOT jsonb_path_exists(to_jsonb(default_notes), '$[*] ? (@ like_regex "^.{250}.{251}" flag "s")'))
);

CREATE TABLE IF NOT EXISTS public.invoices (
  id                  SERIAL PRIMARY KEY,
  number              TEXT,                                -- INV-0001: set when first issued, then kept
  status              TEXT NOT NULL DEFAULT 'draft',       -- draft | issued | void
  payment_status      TEXT NOT NULL DEFAULT 'unpaid',      -- derived: unpaid | partial | paid
  issue_date          DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Colombo')::date),
  due_date            DATE,
  reference           TEXT,                                -- the client's PO / quotation no. (printed)
  order_id            TEXT REFERENCES public.orders (id) ON DELETE SET NULL,     -- made from this web order
  customer_id         UUID REFERENCES public.customers (id) ON DELETE SET NULL,  -- a registered client
  -- BILL TO (all optional while a draft; the name is required to issue)
  bill_to_name        TEXT,
  bill_to_address     TEXT,
  bill_to_city        TEXT,
  bill_to_postal_code TEXT,
  bill_to_phone       TEXT,
  bill_to_email       TEXT,
  payment_terms       TEXT,
  notes               TEXT[] NOT NULL DEFAULT '{}',
  show_bank_details   BOOLEAN NOT NULL DEFAULT FALSE,     -- print the store's transfer account
  -- adjustments as entered
  discount_type       TEXT NOT NULL DEFAULT 'amount',      -- amount | percent
  discount_value      NUMERIC(12,2) NOT NULL DEFAULT 0,
  tax_type            TEXT NOT NULL DEFAULT 'percent',     -- amount | percent
  tax_value           NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- derived by _invoice_recalc() (LKR) ---------------------------------------
  subtotal            NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax_amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
  total               NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_paid         NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance_due         NUMERIC(14,2) NOT NULL DEFAULT 0,
  item_count          INT NOT NULL DEFAULT 0,
  serial_search       TEXT NOT NULL DEFAULT '',            -- every line's serials, space-separated (list search)
  -- stock ----------------------------------------------------------------------
  deduct_stock        BOOLEAN NOT NULL DEFAULT TRUE,       -- take catalogue lines out of stock when issued
  stock_deducted      BOOLEAN NOT NULL DEFAULT FALSE,      -- it did (returned on back-to-draft / void)
  internal_note       TEXT,                                -- admin only, never printed
  issued_at           TIMESTAMPTZ,                         -- first issued
  voided_at           TIMESTAMPTZ,
  void_reason         TEXT,
  created_by          UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoices_number_key         UNIQUE (number),
  CONSTRAINT invoices_status_valid       CHECK (status IN ('draft', 'issued', 'void')),
  CONSTRAINT invoices_payment_status_valid CHECK (payment_status IN ('unpaid', 'partial', 'paid')),
  CONSTRAINT invoices_numbered_when_issued CHECK (status = 'draft' OR number IS NOT NULL),
  CONSTRAINT invoices_number_format      CHECK (number IS NULL OR (char_length(number) BETWEEN 1 AND 40 AND number !~ '\s')),
  CONSTRAINT invoices_dates_valid        CHECK (due_date IS NULL OR due_date >= issue_date),
  CONSTRAINT invoices_discount_valid     CHECK (discount_type IN ('amount', 'percent') AND discount_value >= 0
                                                AND discount_value <= CASE WHEN discount_type = 'percent' THEN 100 ELSE 100000000 END),
  CONSTRAINT invoices_tax_valid          CHECK (tax_type IN ('amount', 'percent') AND tax_value >= 0
                                                AND tax_value <= CASE WHEN tax_type = 'percent' THEN 100 ELSE 100000000 END),
  CONSTRAINT invoices_money_valid        CHECK (subtotal >= 0 AND discount_amount >= 0 AND tax_amount >= 0 AND total >= 0
                                                AND amount_paid >= 0 AND balance_due >= 0 AND item_count >= 0),
  CONSTRAINT invoices_email_valid        CHECK (bill_to_email IS NULL
                                                OR (char_length(bill_to_email) <= 254 AND bill_to_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  CONSTRAINT invoices_notes_valid        CHECK (cardinality(notes) <= 20 AND array_position(notes, NULL) IS NULL
                                                AND NOT jsonb_path_exists(to_jsonb(notes), '$[*] ? (@ like_regex "^.{250}.{251}" flag "s")')),
  CONSTRAINT invoices_text_lengths       CHECK (
        (reference           IS NULL OR char_length(reference)           <= 120)
    AND (bill_to_name        IS NULL OR char_length(bill_to_name)        <= 200)
    AND (bill_to_address     IS NULL OR char_length(bill_to_address)     <= 500)
    AND (bill_to_city        IS NULL OR char_length(bill_to_city)        <= 120)
    AND (bill_to_postal_code IS NULL OR char_length(bill_to_postal_code) <= 20)
    AND (bill_to_phone       IS NULL OR char_length(bill_to_phone)       <= 50)
    AND (payment_terms       IS NULL OR char_length(payment_terms)       <= 2000)
    AND (internal_note       IS NULL OR char_length(internal_note)       <= 2000)
    AND (void_reason         IS NULL OR char_length(void_reason)         <= 500))
);

CREATE INDEX IF NOT EXISTS invoices_created_idx    ON public.invoices (created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_issue_date_idx ON public.invoices (issue_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS invoices_status_idx     ON public.invoices (status, issue_date DESC);
CREATE INDEX IF NOT EXISTS invoices_open_due_idx   ON public.invoices (due_date) WHERE status = 'issued' AND balance_due > 0;
CREATE INDEX IF NOT EXISTS invoices_order_idx      ON public.invoices (order_id) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoices_customer_idx   ON public.invoices (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoices_client_idx     ON public.invoices (lower(bill_to_name));

CREATE TABLE IF NOT EXISTS public.invoice_items (
  id             SERIAL PRIMARY KEY,
  invoice_id     INT NOT NULL REFERENCES public.invoices (id) ON DELETE CASCADE,
  position       INT NOT NULL DEFAULT 0,
  product_id     INT REFERENCES public.products (id) ON DELETE SET NULL,
  variant_id     INT REFERENCES public.product_variants (id) ON DELETE SET NULL,
  description    TEXT NOT NULL,                          -- printed under DESCRIPTION (may be several lines)
  serial_numbers TEXT[] NOT NULL DEFAULT '{}',           -- one per unit, printed "S/N: …" under the description
  warranty       TEXT,                                   -- the WTY column ("1 Year", "6 Months — agent")
  quantity       NUMERIC(10,2) NOT NULL,
  unit_price     NUMERIC(12,2) NOT NULL,                 -- LKR
  amount         NUMERIC(14,2) NOT NULL,                 -- round(quantity × unit_price, 2)
  stock_taken    INT NOT NULL DEFAULT 0,                 -- units this line took from inventory
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoice_items_quantity_valid CHECK (quantity > 0 AND quantity <= 100000),
  CONSTRAINT invoice_items_price_valid    CHECK (unit_price >= 0 AND unit_price <= 100000000 AND amount >= 0),
  CONSTRAINT invoice_items_stock_valid    CHECK (stock_taken BETWEEN 0 AND 1000000 AND position >= 0),
  -- at most one serial per whole unit (≥ 1 for a fractional quantity), ≤ 100 characters each
  CONSTRAINT invoice_items_serials_valid  CHECK (
        cardinality(serial_numbers) <= GREATEST(trunc(quantity), 1)
    AND array_position(serial_numbers, NULL) IS NULL
    AND NOT jsonb_path_exists(to_jsonb(serial_numbers), '$[*] ? (@ like_regex "^.{101}" flag "s")')),
  CONSTRAINT invoice_items_text_lengths   CHECK (
        char_length(btrim(description)) BETWEEN 1 AND 1000
    AND (warranty       IS NULL OR char_length(warranty)       <= 80))
);
CREATE INDEX IF NOT EXISTS invoice_items_invoice_idx ON public.invoice_items (invoice_id, position, id);
CREATE INDEX IF NOT EXISTS invoice_items_variant_idx ON public.invoice_items (variant_id) WHERE variant_id IS NOT NULL;

-- 25's unit register: a unit sold on an invoice line points at it (the column comes from 25).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_units_invoice_item_id_fkey') THEN
    ALTER TABLE public.product_units ADD CONSTRAINT product_units_invoice_item_id_fkey
      FOREIGN KEY (invoice_item_id) REFERENCES public.invoice_items (id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.invoice_payments (
  id          SERIAL PRIMARY KEY,
  invoice_id  INT NOT NULL REFERENCES public.invoices (id) ON DELETE CASCADE,
  amount      NUMERIC(14,2) NOT NULL,
  paid_on     DATE NOT NULL,                             -- Sri Lanka calendar day the money arrived
  method      TEXT NOT NULL,
  reference   TEXT,                                      -- transfer / cheque / card slip no.
  note        TEXT,
  created_by  UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoice_payments_amount_valid CHECK (amount > 0 AND amount <= 1000000000000),
  CONSTRAINT invoice_payments_method_valid CHECK (method IN ('cash', 'bank_transfer', 'card', 'cheque', 'online', 'other')),
  CONSTRAINT invoice_payments_text_lengths CHECK (
        (reference IS NULL OR char_length(reference) <= 120)
    AND (note      IS NULL OR char_length(note)      <= 500))
);
CREATE INDEX IF NOT EXISTS invoice_payments_invoice_idx ON public.invoice_payments (invoice_id, paid_on, id);
CREATE INDEX IF NOT EXISTS invoice_payments_paid_on_idx ON public.invoice_payments (paid_on);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Touch triggers
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.invoice_settings_touch() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := (SELECT c.id FROM public.customers c WHERE c.id = auth.uid());
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.invoice_settings_touch() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoice_settings_touch ON public.invoice_settings;
CREATE TRIGGER invoice_settings_touch BEFORE UPDATE ON public.invoice_settings
  FOR EACH ROW EXECUTE FUNCTION public.invoice_settings_touch();

DROP TRIGGER IF EXISTS invoices_touch ON public.invoices;
CREATE TRIGGER invoices_touch BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Row-level security: admins read; every write below is an RPC
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.invoice_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_items    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;

-- Sealed from anon. Signed-in users may SELECT (RLS: admins only) and UPDATE the settings row
-- (RLS: admins only); nobody inserts, deletes or truncates through the API.
REVOKE ALL ON public.invoice_settings, public.invoices, public.invoice_items, public.invoice_payments FROM anon, authenticated;
GRANT SELECT ON public.invoice_settings, public.invoices, public.invoice_items, public.invoice_payments TO authenticated;
GRANT UPDATE ON public.invoice_settings TO authenticated;
REVOKE ALL ON SEQUENCE public.invoices_id_seq, public.invoice_items_id_seq, public.invoice_payments_id_seq
  FROM anon, authenticated;

DROP POLICY IF EXISTS invoice_settings_admin_read ON public.invoice_settings;
CREATE POLICY invoice_settings_admin_read ON public.invoice_settings
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS invoice_settings_admin_update ON public.invoice_settings;
CREATE POLICY invoice_settings_admin_update ON public.invoice_settings
  FOR UPDATE TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));
DROP POLICY IF EXISTS invoices_admin_read ON public.invoices;
CREATE POLICY invoices_admin_read ON public.invoices
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS invoice_items_admin_read ON public.invoice_items;
CREATE POLICY invoice_items_admin_read ON public.invoice_items
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS invoice_payments_admin_read ON public.invoice_payments;
CREATE POLICY invoice_payments_admin_read ON public.invoice_payments
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The settings row — the client's workbook, verbatim (inserted once; never overwritten)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO public.invoice_settings (
  id, number_prefix, number_digits, next_number, address_lines, phone, email, website,
  default_notes, closing_title, closing_line, footer_tagline)
VALUES (
  TRUE, 'INV-', 4, 1,
  ARRAY['3F14, UNITY PLAZA BUILDING,', 'No. 2, GALLE ROAD,', 'COLOMBO 4, SRI LANKA'],
  '+94 76 074 4952', 'anan@dockonesolutions.com', 'www.dockonesolutions.com',
  ARRAY[
    'Please make payment according to the agreed payment terms.',
    'Kindly send payment confirmation to anan@dockonesolutions.com.',
    'The warranty period and provider are stated against each item.',
    'Please report faulty or incorrect items promptly. We will resolve the issue according to law.',
    'Warranty does not cover normal use or depletion of toner, ink cartridges, and ribbons. Manufacturing defects remain subject to applicable warranty and legal rights.',
    'Warranty does not cover damage caused by misuse, liquid spills, power surges, or unauthorized repairs, subject to applicable law.',
    'The warranty period shall be 14 working days shorter than the stated warranty period.',
    'Please retain your invoice or other proof of purchase for warranty claims.',
    'The invoice should be kept until the warranty period ends.',
    'For inquiries, contact +94 76 074 4952.'],
  'Thank You!', 'For choosing DockOne Solutions', 'OUR VISION | YOUR SOLUTION')
ON CONFLICT (id) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Internal helpers (no grants)
-- ─────────────────────────────────────────────────────────────────────────────

-- prefix || n zero-padded to `digits` (never truncated: 12345 with 4 digits stays 12345).
CREATE OR REPLACE FUNCTION public._invoice_number(p_prefix TEXT, p_n INT, p_digits INT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(p_prefix, '')
      || CASE WHEN char_length(p_n::TEXT) >= p_digits THEN p_n::TEXT ELSE lpad(p_n::TEXT, p_digits, '0') END
$$;
REVOKE ALL ON FUNCTION public._invoice_number(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;

-- 'YYYY-MM-DD' → DATE (2000–2100). NULL/absent → NULL; anything else → 22023 `<code>:<label> …`.
CREATE OR REPLACE FUNCTION public._invoice_json_date(p_code TEXT, p_value JSONB, p_label TEXT)
RETURNS DATE
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v TEXT;
  d DATE;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_value) = 'string' THEN
    v := btrim(p_value #>> '{}');
  END IF;
  IF v ~ '^\d{4}-\d{2}-\d{2}$' THEN
    BEGIN
      d := v::DATE;
    EXCEPTION WHEN others THEN
      d := NULL;
    END;
  END IF;
  IF d IS NULL OR d < DATE '2000-01-01' OR d > DATE '2100-12-31' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('%s:%s must be a date (YYYY-MM-DD).', p_code, p_label);
  END IF;
  RETURN d;
END $$;
REVOKE ALL ON FUNCTION public._invoice_json_date(TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;

-- A quantity: a number above 0, at most 100,000, at most 2 decimals.
CREATE OR REPLACE FUNCTION public._invoice_json_qty(p_code TEXT, p_value JSONB, p_label TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v NUMERIC;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_value) = 'number' THEN
    v := (p_value #>> '{}')::NUMERIC;
  END IF;
  IF v IS NULL OR v <= 0 OR v > 100000 OR v <> round(v, 2) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('%s:%s must be a number above 0 (at most 100,000, up to 2 decimals).', p_code, p_label);
  END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public._invoice_json_qty(TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._invoice_json_uuid(p_code TEXT, p_value JSONB, p_label TEXT)
RETURNS UUID
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v TEXT;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_value) = 'string' THEN
    v := btrim(p_value #>> '{}');
  END IF;
  IF v IS NULL OR v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('%s:%s must be an account id.', p_code, p_label);
  END IF;
  RETURN v::UUID;
END $$;
REVOKE ALL ON FUNCTION public._invoice_json_uuid(TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;

-- A list of text lines (notes): each trimmed, blanks dropped, ≤ p_max_items of ≤ p_max_len.
CREATE OR REPLACE FUNCTION public._invoice_json_lines(p_code TEXT, p_value JSONB, p_label TEXT, p_max_items INT, p_max_len INT)
RETURNS TEXT[]
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_in  TEXT[];
  v_out TEXT[] := '{}';
  t     TEXT;
BEGIN
  v_in := public._admin_json_text_array(p_code, p_value, p_label, p_max_items);
  FOREACH t IN ARRAY v_in LOOP
    t := NULLIF(btrim(t, E' \t\r\n'), '');
    CONTINUE WHEN t IS NULL;
    IF char_length(t) > p_max_len THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('%s:Each of the %s can be at most %s characters.', p_code, lower(p_label), p_max_len);
    END IF;
    v_out := v_out || t;
  END LOOP;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public._invoice_json_lines(TEXT, JSONB, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;

-- "Rs. 12,500.00" for messages.
CREATE OR REPLACE FUNCTION public._invoice_rs(p_amount NUMERIC)
RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT 'Rs. ' || btrim(to_char(COALESCE(p_amount, 0), 'FM999,999,999,999,990.00'))
$$;
REVOKE ALL ON FUNCTION public._invoice_rs(NUMERIC) FROM PUBLIC, anon, authenticated;

-- The ONLY writer of the derived money columns and payment_status (P6: one implementation).
CREATE OR REPLACE FUNCTION public._invoice_recalc(p_invoice_id INT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv     public.invoices;
  v_sub   NUMERIC;
  v_count INT;
  v_paid  NUMERIC;
  v_disc  NUMERIC;
  v_tax   NUMERIC;
  v_total NUMERIC;
  v_bal   NUMERIC;
  v_sns   TEXT;
BEGIN
  SELECT * INTO inv FROM public.invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT COALESCE(sum(it.amount), 0), count(*)::INT,
         COALESCE(string_agg(array_to_string(it.serial_numbers, ' '), ' ' ORDER BY it.position), '')
    INTO v_sub, v_count, v_sns
    FROM public.invoice_items it WHERE it.invoice_id = p_invoice_id;
  SELECT COALESCE(sum(pay.amount), 0) INTO v_paid
    FROM public.invoice_payments pay WHERE pay.invoice_id = p_invoice_id;
  v_disc := CASE WHEN inv.discount_type = 'percent' THEN round(v_sub * inv.discount_value / 100, 2)
                 ELSE LEAST(inv.discount_value, v_sub) END;
  v_tax := CASE WHEN inv.tax_type = 'percent' THEN round((v_sub - v_disc) * inv.tax_value / 100, 2)
                ELSE inv.tax_value END;
  v_total := v_sub - v_disc + v_tax;
  v_bal := GREATEST(v_total - v_paid, 0);
  UPDATE public.invoices
     SET subtotal = v_sub, discount_amount = v_disc, tax_amount = v_tax, total = v_total,
         amount_paid = v_paid, balance_due = v_bal, item_count = v_count, serial_search = btrim(v_sns),
         payment_status = CASE WHEN inv.status = 'issued' AND v_bal = 0 THEN 'paid'
                               WHEN v_paid > 0 THEN 'partial'
                               ELSE 'unpaid' END
   WHERE id = p_invoice_id;
END $$;
REVOKE ALL ON FUNCTION public._invoice_recalc(INT) FROM PUBLIC, anon, authenticated;

-- What every RPC returns: {invoice: {…row}, items: [… in order], payments: [… by date]}.
CREATE OR REPLACE FUNCTION public._invoice_json(p_invoice_id INT)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
           'invoice',  to_jsonb(i),
           'items',    COALESCE((SELECT jsonb_agg(to_jsonb(it) ORDER BY it.position, it.id)
                                   FROM public.invoice_items it WHERE it.invoice_id = i.id), '[]'::jsonb),
           'payments', COALESCE((SELECT jsonb_agg(to_jsonb(pay) ORDER BY pay.paid_on, pay.id)
                                   FROM public.invoice_payments pay WHERE pay.invoice_id = i.id), '[]'::jsonb))
    FROM public.invoices i
   WHERE i.id = p_invoice_id
$$;
REVOKE ALL ON FUNCTION public._invoice_json(INT) FROM PUBLIC, anon, authenticated;

-- Take an invoice's catalogue lines out of stock (caller holds the invoice row lock).
-- Tracked variants only (an inventory row); an untracked variant or a free-text line takes nothing.
CREATE OR REPLACE FUNCTION public._invoice_take_stock(p_invoice_id INT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r RECORD;
BEGIN
  -- 1. Lock this invoice's inventory rows in the global order.
  PERFORM 1 FROM public.inventory inv
    WHERE inv.variant_id IN (SELECT it.variant_id FROM public.invoice_items it
                              WHERE it.invoice_id = p_invoice_id AND it.variant_id IS NOT NULL)
    ORDER BY inv.product_id, inv.variant_id
    FOR UPDATE;
  -- 2. Stock moves in whole units.
  SELECT it.position, it.description INTO r
    FROM public.invoice_items it
    JOIN public.inventory inv ON inv.variant_id = it.variant_id
   WHERE it.invoice_id = p_invoice_id AND it.quantity <> trunc(it.quantity)
   ORDER BY it.position, it.id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('invalid_quantity:Line %s (“%s”) is a stock-tracked item, so its quantity must be a whole number.',
                       r.position + 1, left(r.description, 60));
  END IF;
  -- 3. Enough on hand for every variant (lines of the same variant add up).
  SELECT x.qty, inv.stock_level,
         p.name || CASE WHEN p.variant_count > 1 THEN ' (' || v.name || ')' ELSE '' END AS label
    INTO r
    FROM (SELECT it.variant_id, sum(it.quantity)::INT AS qty
            FROM public.invoice_items it
           WHERE it.invoice_id = p_invoice_id AND it.variant_id IS NOT NULL
           GROUP BY it.variant_id) x
    JOIN public.inventory inv ON inv.variant_id = x.variant_id
    JOIN public.product_variants v ON v.id = x.variant_id
    JOIN public.products p ON p.id = v.product_id
   WHERE inv.stock_level < x.qty
   ORDER BY inv.product_id, inv.variant_id
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('insufficient_stock:Only %s of “%s” in stock — this invoice needs %s. Lower the quantity, update the stock in Inventory, or switch off “Take items out of stock”.',
                       r.stock_level, left(r.label, 120), r.qty);
  END IF;
  -- 4. Take it, and remember exactly what each line took.
  UPDATE public.inventory inv
     SET stock_level = inv.stock_level - x.qty
    FROM (SELECT it.variant_id, sum(it.quantity)::INT AS qty
            FROM public.invoice_items it
           WHERE it.invoice_id = p_invoice_id AND it.variant_id IS NOT NULL
           GROUP BY it.variant_id) x
   WHERE inv.variant_id = x.variant_id;
  UPDATE public.invoice_items it
     SET stock_taken = it.quantity::INT
   WHERE it.invoice_id = p_invoice_id AND it.variant_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.inventory inv WHERE inv.variant_id = it.variant_id);
  UPDATE public.invoices SET stock_deducted = TRUE WHERE id = p_invoice_id;
END $$;
REVOKE ALL ON FUNCTION public._invoice_take_stock(INT) FROM PUBLIC, anon, authenticated;

-- Put back exactly what the lines took (caller holds the invoice row lock). A variant that is no
-- longer tracked stays untracked; the cap mirrors inventory_levels_valid.
CREATE OR REPLACE FUNCTION public._invoice_return_stock(p_invoice_id INT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.inventory inv
    WHERE inv.variant_id IN (SELECT it.variant_id FROM public.invoice_items it
                              WHERE it.invoice_id = p_invoice_id AND it.stock_taken > 0 AND it.variant_id IS NOT NULL)
    ORDER BY inv.product_id, inv.variant_id
    FOR UPDATE;
  UPDATE public.inventory inv
     SET stock_level = LEAST(inv.stock_level + x.qty, 1000000)
    FROM (SELECT it.variant_id, sum(it.stock_taken)::INT AS qty
            FROM public.invoice_items it
           WHERE it.invoice_id = p_invoice_id AND it.stock_taken > 0 AND it.variant_id IS NOT NULL
           GROUP BY it.variant_id) x
   WHERE inv.variant_id = x.variant_id;
  UPDATE public.invoice_items SET stock_taken = 0 WHERE invoice_id = p_invoice_id AND stock_taken > 0;
  UPDATE public.invoices SET stock_deducted = FALSE WHERE id = p_invoice_id;
END $$;
REVOKE ALL ON FUNCTION public._invoice_return_stock(INT) FROM PUBLIC, anon, authenticated;

-- Sell the units an ISSUED invoice lists (caller holds the invoice row lock, after any inventory
-- locks). Per serial on a catalogue line, matched within the line's product (any case):
--   in stock, same variant             → sold to the line;
--   in stock under another variant     → refused (serial_other_variant);
--   sold to a web-order line of the order this invoice was made for → also held by the line;
--   sold anywhere else                 → refused (serial_sold);
--   not in the register                → printed only (older stock).
CREATE OR REPLACE FUNCTION public._invoice_link_units(p_invoice_id INT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_order TEXT;
  r       RECORD;
  u       public.product_units;
BEGIN
  SELECT order_id INTO v_order FROM public.invoices WHERE id = p_invoice_id;
  PERFORM 1 FROM public.product_units pu
    WHERE (pu.product_id, upper(pu.serial_number)) IN (
            SELECT it.product_id, upper(sn)
              FROM public.invoice_items it CROSS JOIN LATERAL unnest(it.serial_numbers) AS sn
             WHERE it.invoice_id = p_invoice_id AND it.product_id IS NOT NULL)
    ORDER BY pu.id
    FOR UPDATE;
  FOR r IN
    SELECT it.id AS item_id, it.position, it.product_id, it.variant_id, it.description, sn AS serial
      FROM public.invoice_items it CROSS JOIN LATERAL unnest(it.serial_numbers) AS sn
     WHERE it.invoice_id = p_invoice_id AND it.product_id IS NOT NULL
     ORDER BY it.position, it.id
  LOOP
    SELECT * INTO u FROM public.product_units pu WHERE pu.product_id = r.product_id AND upper(pu.serial_number) = upper(r.serial);
    CONTINUE WHEN NOT FOUND OR u.invoice_item_id = r.item_id;
    IF u.status = 'in_stock' THEN
      IF r.variant_id IS NOT NULL AND u.variant_id <> r.variant_id THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = format('serial_other_variant:Line %s: S/N %s is in stock under another variant of this product. Pick the right item, or move the serial in Products.',
                           r.position + 1, u.serial_number);
      END IF;
      UPDATE public.product_units SET status = 'sold', invoice_item_id = r.item_id, sold_at = now() WHERE id = u.id;
    ELSIF u.invoice_item_id IS NULL AND u.order_item_id IS NOT NULL AND v_order IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.id = u.order_item_id AND oi.order_id = v_order) THEN
      UPDATE public.product_units SET invoice_item_id = r.item_id WHERE id = u.id;
    ELSE
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('serial_sold:Line %s: S/N %s was sold %s.', r.position + 1, u.serial_number, public._unit_sold_where(u));
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public._invoice_link_units(INT) FROM PUBLIC, anon, authenticated;

-- Give back the units an invoice holds: in stock again unless a web order still holds them.
CREATE OR REPLACE FUNCTION public._invoice_release_units(p_invoice_id INT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.product_units pu
    WHERE pu.invoice_item_id IN (SELECT it.id FROM public.invoice_items it WHERE it.invoice_id = p_invoice_id)
    ORDER BY pu.id
    FOR UPDATE;
  UPDATE public.product_units pu
     SET invoice_item_id = NULL,
         status  = CASE WHEN pu.order_item_id IS NULL THEN 'in_stock' ELSE 'sold' END,
         sold_at = CASE WHEN pu.order_item_id IS NULL THEN NULL ELSE pu.sold_at END
   WHERE pu.invoice_item_id IN (SELECT it.id FROM public.invoice_items it WHERE it.invoice_id = p_invoice_id);
END $$;
REVOKE ALL ON FUNCTION public._invoice_release_units(INT) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. admin_save_invoice(p_invoice JSONB, p_items JSONB DEFAULT NULL) → JSONB
-- ─────────────────────────────────────────────────────────────────────────────
-- p_invoice  object. No `id` = CREATE a draft: absent keys start from invoice_settings (notes,
--            payment terms, VAT / tax rate, due days after the invoice date, stock and bank-details
--            switches) or the column defaults (invoice date = today in Sri Lanka). With `id` =
--            UPDATE: only the keys present change (null clears an optional field).
--            Keys: id, expected_updated_at (refuse with invoice_changed when the row's updated_at
--            differs — another tab saved first), issue_date, due_date, reference, order_id,
--            customer_id, bill_to_name, bill_to_address, bill_to_city, bill_to_postal_code,
--            bill_to_phone, bill_to_email, payment_terms, notes[], show_bank_details,
--            discount_type ('amount'|'percent'), discount_value, tax_type, tax_value,
--            deduct_stock, internal_note. Derived keys (number, status, totals …) are refused.
--            ISSUED: issue_date, order_id, discount_*, tax_*, deduct_stock must stay as they are.
--            VOID: nothing changes.
-- p_items    NULL = leave the lines alone. Otherwise the COMPLETE list (≤ 200), in print order:
--            {variant_id?, product_id?, description, serial_numbers? [one per unit], warranty?,
--             quantity, unit_price}. A variant's product is taken from the variant. A line lists at
--            most one serial per whole unit; a serial appears once per invoice. DRAFT: the lines
--            are replaced. ISSUED: the same lines (each with its `id`, none added or removed) —
--            only description, serial_numbers, warranty and the order may change; changed serials
--            are re-matched against the unit register (_invoice_link_units).
-- Returns _invoice_json() + {created}.
CREATE OR REPLACE FUNCTION public.admin_save_invoice(p_invoice JSONB, p_items JSONB DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_keys CONSTANT TEXT[] := ARRAY['id', 'expected_updated_at', 'issue_date', 'due_date', 'reference', 'order_id',
    'customer_id', 'bill_to_name', 'bill_to_address', 'bill_to_city', 'bill_to_postal_code', 'bill_to_phone',
    'bill_to_email', 'payment_terms', 'notes', 'show_bank_details', 'discount_type', 'discount_value',
    'tax_type', 'tax_value', 'deduct_stock', 'internal_note'];
  c_derived CONSTANT TEXT[] := ARRAY['number', 'status', 'payment_status', 'subtotal', 'discount_amount',
    'tax_amount', 'total', 'amount_paid', 'balance_due', 'item_count', 'stock_deducted', 'issued_at',
    'voided_at', 'void_reason', 'created_by', 'created_at', 'updated_at', 'serial_search'];
  c_item_keys CONSTANT TEXT[] := ARRAY['id', 'product_id', 'variant_id', 'description',
    'serial_numbers', 'warranty', 'quantity', 'unit_price'];
  c_i CONSTANT TEXT := 'invalid_invoice';
  c_l CONSTANT TEXT := 'invalid_item';
  v_id        INT;
  v_create    BOOLEAN;
  inv         public.invoices;
  s           public.invoice_settings;
  v_settings  BOOLEAN := FALSE;
  v_status    TEXT;
  v_label     TEXT;
  v_key       TEXT;
  v_n         INT;
  i           INT;
  e           JSONB;
  v_line      TEXT;
  -- header values
  v_expected  TIMESTAMPTZ;
  v_issue     DATE;
  v_due       DATE;
  v_reference TEXT;
  v_order     TEXT;
  v_customer  UUID;
  v_name      TEXT;
  v_address   TEXT;
  v_city      TEXT;
  v_postal    TEXT;
  v_phone     TEXT;
  v_email     TEXT;
  v_terms     TEXT;
  v_notes     TEXT[];
  v_bank      BOOLEAN;
  v_dtype     TEXT;
  v_dvalue    NUMERIC;
  v_ttype     TEXT;
  v_tvalue    NUMERIC;
  v_deduct    BOOLEAN;
  v_internal  TEXT;
  -- lines
  v_line_ids  INT[];
  v_seen      INT[] := '{}';
  v_old       public.invoice_items;
  v_lid       INT;
  v_pid       INT;
  v_vid       INT;
  v_desc      TEXT;
  v_serials   TEXT[];
  v_all_sn    TEXT[] := '{}';      -- every serial on the invoice (upper case): one line each
  v_sn        TEXT;
  v_wty       TEXT;
  v_qty       NUMERIC;
  v_price     NUMERIC;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can save invoices.';
  END IF;

  -- ── 1. The invoice object ─────────────────────────────────────────────────
  IF p_invoice IS NULL OR jsonb_typeof(p_invoice) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:The invoice must be a JSON object.';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_invoice) LOOP
    IF NOT (v_key = ANY (c_keys)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('invalid_invoice:The field “%s” can''t be saved here%s.', left(v_key, 40),
                         CASE WHEN v_key = ANY (c_derived) THEN ' (the database works it out)' ELSE '' END);
    END IF;
  END LOOP;

  v_id        := public._admin_json_int(c_i, p_invoice -> 'id', 'The invoice id', 1, 2147483647);
  v_issue     := public._invoice_json_date(c_i, p_invoice -> 'issue_date', 'The invoice date');
  v_due       := public._invoice_json_date(c_i, p_invoice -> 'due_date', 'The due date');
  v_reference := public._admin_json_text(c_i, p_invoice -> 'reference', 'The reference', 120);
  v_order     := upper(public._admin_json_text(c_i, p_invoice -> 'order_id', 'The order number', 40));
  v_customer  := public._invoice_json_uuid(c_i, p_invoice -> 'customer_id', 'The customer');
  v_name      := public._admin_json_text(c_i, p_invoice -> 'bill_to_name', 'The client name', 200);
  v_address   := public._admin_json_text(c_i, p_invoice -> 'bill_to_address', 'The address', 500);
  v_city      := public._admin_json_text(c_i, p_invoice -> 'bill_to_city', 'The city', 120);
  v_postal    := public._admin_json_text(c_i, p_invoice -> 'bill_to_postal_code', 'The postal code', 20);
  v_phone     := public._admin_json_text(c_i, p_invoice -> 'bill_to_phone', 'The contact number', 50);
  v_email     := lower(public._admin_json_text(c_i, p_invoice -> 'bill_to_email', 'The email', 254));
  v_terms     := public._admin_json_text(c_i, p_invoice -> 'payment_terms', 'The payment terms', 2000);
  v_notes     := public._invoice_json_lines(c_i, p_invoice -> 'notes', 'Notes', 20, 500);
  v_bank      := public._admin_json_bool(c_i, p_invoice -> 'show_bank_details', '“Show bank details”');
  v_dtype     := public._admin_json_text(c_i, p_invoice -> 'discount_type', 'The discount type', 10);
  v_dvalue    := public._admin_json_money(c_i, p_invoice -> 'discount_value', 'The discount');
  v_ttype     := public._admin_json_text(c_i, p_invoice -> 'tax_type', 'The VAT / tax type', 10);
  v_tvalue    := public._admin_json_money(c_i, p_invoice -> 'tax_value', 'The VAT / tax');
  v_deduct    := public._admin_json_bool(c_i, p_invoice -> 'deduct_stock', '“Take items out of stock”');
  v_internal  := public._admin_json_text(c_i, p_invoice -> 'internal_note', 'The internal note', 2000);

  IF p_invoice ? 'expected_updated_at' AND jsonb_typeof(p_invoice -> 'expected_updated_at') <> 'null' THEN
    BEGIN
      v_expected := (p_invoice ->> 'expected_updated_at')::TIMESTAMPTZ;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:expected_updated_at must be a timestamp.';
    END;
  END IF;
  IF p_invoice ? 'issue_date' AND v_issue IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:The invoice date is required.';
  END IF;
  IF (p_invoice ? 'show_bank_details' AND v_bank IS NULL) OR (p_invoice ? 'deduct_stock' AND v_deduct IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:Switches must be true or false.';
  END IF;
  IF (p_invoice ? 'discount_type' AND COALESCE(v_dtype, '') NOT IN ('amount', 'percent'))
     OR (p_invoice ? 'tax_type' AND COALESCE(v_ttype, '') NOT IN ('amount', 'percent')) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:A discount or VAT / tax is either an amount or a percent.';
  END IF;
  IF v_order IS NOT NULL AND v_order !~ '^DO-[0-9]{1,12}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:The order number looks like DO-10042.';
  END IF;

  -- ── 2. Create, or lock and update ─────────────────────────────────────────
  v_create := v_id IS NULL;
  IF v_create THEN
    SELECT * INTO s FROM public.invoice_settings WHERE id;
    v_settings := FOUND;
    v_issue := COALESCE(v_issue, (now() AT TIME ZONE 'Asia/Colombo')::DATE);
    INSERT INTO public.invoices (
      issue_date, due_date, reference, order_id, customer_id,
      bill_to_name, bill_to_address, bill_to_city, bill_to_postal_code, bill_to_phone, bill_to_email,
      payment_terms, notes, show_bank_details, discount_type, discount_value, tax_type, tax_value,
      deduct_stock, internal_note, created_by)
    VALUES (
      v_issue,
      CASE WHEN p_invoice ? 'due_date' THEN v_due
           WHEN v_settings AND s.default_due_days IS NOT NULL THEN v_issue + s.default_due_days END,
      v_reference, v_order, v_customer,
      v_name, v_address, v_city, v_postal, v_phone, v_email,
      CASE WHEN p_invoice ? 'payment_terms' THEN v_terms WHEN v_settings THEN s.default_payment_terms END,
      CASE WHEN p_invoice ? 'notes' THEN v_notes WHEN v_settings THEN s.default_notes ELSE '{}'::TEXT[] END,
      COALESCE(v_bank, CASE WHEN v_settings THEN s.default_show_bank_details END, FALSE),
      COALESCE(v_dtype, 'amount'), COALESCE(v_dvalue, 0),
      COALESCE(v_ttype, 'percent'),
      CASE WHEN p_invoice ? 'tax_value' THEN COALESCE(v_tvalue, 0)
           WHEN v_settings AND COALESCE(v_ttype, 'percent') = 'percent' THEN s.default_tax_rate
           ELSE 0 END,
      COALESCE(v_deduct, CASE WHEN v_settings THEN s.default_deduct_stock END, TRUE),
      v_internal,
      (SELECT c.id FROM public.customers c WHERE c.id = auth.uid()))
    RETURNING id, status INTO v_id, v_status;
  ELSE
    SELECT * INTO inv FROM public.invoices WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'invoice_not_found:This invoice no longer exists — it may have been deleted in another tab.';
    END IF;
    v_label := COALESCE(inv.number, 'This invoice');
    IF v_expected IS NOT NULL AND inv.updated_at IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('invoice_changed:%s was changed somewhere else (another tab or admin) after you opened it. Reload it to see the latest version, then make your change again.', v_label);
    END IF;
    IF inv.status = 'void' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is void and can no longer be changed.', v_label);
    END IF;
    IF inv.status = 'issued' AND (
         (p_invoice ? 'issue_date'     AND v_issue  IS DISTINCT FROM inv.issue_date)
      OR (p_invoice ? 'order_id'       AND v_order  IS DISTINCT FROM inv.order_id)
      OR (p_invoice ? 'discount_type'  AND v_dtype  IS DISTINCT FROM inv.discount_type)
      OR (p_invoice ? 'discount_value' AND COALESCE(v_dvalue, 0) <> inv.discount_value)
      OR (p_invoice ? 'tax_type'       AND v_ttype  IS DISTINCT FROM inv.tax_type)
      OR (p_invoice ? 'tax_value'      AND COALESCE(v_tvalue, 0) <> inv.tax_value)
      OR (p_invoice ? 'deduct_stock'   AND v_deduct IS DISTINCT FROM inv.deduct_stock)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('invoice_locked:%s is issued, so its date, discount, VAT / tax and stock setting are fixed. Move it back to draft to change them.', v_label);
    END IF;
    UPDATE public.invoices SET
      issue_date          = CASE WHEN p_invoice ? 'issue_date'          THEN v_issue                 ELSE issue_date END,
      due_date            = CASE WHEN p_invoice ? 'due_date'            THEN v_due                   ELSE due_date END,
      reference           = CASE WHEN p_invoice ? 'reference'           THEN v_reference             ELSE reference END,
      order_id            = CASE WHEN p_invoice ? 'order_id'            THEN v_order                 ELSE order_id END,
      customer_id         = CASE WHEN p_invoice ? 'customer_id'         THEN v_customer              ELSE customer_id END,
      bill_to_name        = CASE WHEN p_invoice ? 'bill_to_name'        THEN v_name                  ELSE bill_to_name END,
      bill_to_address     = CASE WHEN p_invoice ? 'bill_to_address'     THEN v_address               ELSE bill_to_address END,
      bill_to_city        = CASE WHEN p_invoice ? 'bill_to_city'        THEN v_city                  ELSE bill_to_city END,
      bill_to_postal_code = CASE WHEN p_invoice ? 'bill_to_postal_code' THEN v_postal                ELSE bill_to_postal_code END,
      bill_to_phone       = CASE WHEN p_invoice ? 'bill_to_phone'       THEN v_phone                 ELSE bill_to_phone END,
      bill_to_email       = CASE WHEN p_invoice ? 'bill_to_email'       THEN v_email                 ELSE bill_to_email END,
      payment_terms       = CASE WHEN p_invoice ? 'payment_terms'       THEN v_terms                 ELSE payment_terms END,
      notes               = CASE WHEN p_invoice ? 'notes'               THEN v_notes                 ELSE notes END,
      show_bank_details   = CASE WHEN p_invoice ? 'show_bank_details'   THEN v_bank                  ELSE show_bank_details END,
      discount_type       = CASE WHEN p_invoice ? 'discount_type'       THEN v_dtype                 ELSE discount_type END,
      discount_value      = CASE WHEN p_invoice ? 'discount_value'      THEN COALESCE(v_dvalue, 0)   ELSE discount_value END,
      tax_type            = CASE WHEN p_invoice ? 'tax_type'            THEN v_ttype                 ELSE tax_type END,
      tax_value           = CASE WHEN p_invoice ? 'tax_value'           THEN COALESCE(v_tvalue, 0)   ELSE tax_value END,
      deduct_stock        = CASE WHEN p_invoice ? 'deduct_stock'        THEN v_deduct                ELSE deduct_stock END,
      internal_note       = CASE WHEN p_invoice ? 'internal_note'       THEN v_internal              ELSE internal_note END
    WHERE id = v_id;
    v_status := inv.status;
  END IF;
  v_label := COALESCE(inv.number, 'This invoice');

  -- ── 3. The lines ──────────────────────────────────────────────────────────
  IF p_items IS NOT NULL AND jsonb_typeof(p_items) <> 'null' THEN
    IF jsonb_typeof(p_items) <> 'array' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_item:The lines must be a list.';
    END IF;
    v_n := jsonb_array_length(p_items);
    IF v_n > 200 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_item:An invoice can have at most 200 lines.';
    END IF;

    IF v_status = 'draft' THEN
      DELETE FROM public.invoice_items WHERE invoice_id = v_id;
      FOR i IN 0 .. v_n - 1 LOOP
        e := p_items -> i;
        v_line := format('Line %s', i + 1);
        IF jsonb_typeof(e) <> 'object' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_item:%s must be an object.', v_line);
        END IF;
        FOR v_key IN SELECT jsonb_object_keys(e) LOOP
          IF NOT (v_key = ANY (c_item_keys)) THEN
            RAISE EXCEPTION USING ERRCODE = '22023',
              MESSAGE = format('invalid_item:%s: the field “%s” can''t be saved here.', v_line, left(v_key, 40));
          END IF;
        END LOOP;
        v_vid := public._admin_json_int(c_l, e -> 'variant_id', v_line || ': the catalogue item', 1, 2147483647);
        v_pid := public._admin_json_int(c_l, e -> 'product_id', v_line || ': the product', 1, 2147483647);
        IF v_vid IS NOT NULL THEN
          SELECT pv.product_id INTO v_pid FROM public.product_variants pv WHERE pv.id = v_vid;
          IF NOT FOUND THEN
            RAISE EXCEPTION USING ERRCODE = '22023',
              MESSAGE = format('invalid_item:%s: that catalogue item no longer exists. Remove the line and add the product again, or type it as a custom line.', v_line);
          END IF;
        ELSIF v_pid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = v_pid) THEN
          RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = format('invalid_item:%s: that product no longer exists. Remove the line and add it again.', v_line);
        END IF;
        v_desc    := public._admin_json_text(c_l, e -> 'description', v_line || ': the description', 1000, TRUE);
        v_serials := public._serials_from_json(c_l, e -> 'serial_numbers', v_line, 200);
        v_wty     := public._admin_json_text(c_l, e -> 'warranty', v_line || ': the warranty', 80);
        v_qty     := public._invoice_json_qty(c_l, e -> 'quantity', v_line || ': the quantity');
        v_price   := public._admin_json_money(c_l, e -> 'unit_price', v_line || ': the unit price');
        IF v_qty IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_item:%s needs a quantity.', v_line);
        END IF;
        IF v_price IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_item:%s needs a unit price (0 for no charge).', v_line);
        END IF;
        IF v_price > 100000000 THEN
          RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = format('invalid_item:%s: the unit price can be at most Rs. 100,000,000.', v_line);
        END IF;
        IF cardinality(v_serials) > GREATEST(trunc(v_qty), 1) THEN
          RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = format('too_many_serials:%s has %s serial numbers for a quantity of %s.', v_line, cardinality(v_serials), trunc(v_qty));
        END IF;
        FOREACH v_sn IN ARRAY v_serials LOOP
          IF upper(v_sn) = ANY (v_all_sn) THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('duplicate_serial:S/N %s is on two lines.', v_sn);
          END IF;
          v_all_sn := v_all_sn || upper(v_sn);
        END LOOP;
        INSERT INTO public.invoice_items (invoice_id, position, product_id, variant_id, description,
                                          serial_numbers, warranty, quantity, unit_price, amount)
        VALUES (v_id, i, v_pid, v_vid, v_desc, v_serials, v_wty, v_qty, v_price, round(v_qty * v_price, 2));
      END LOOP;

    ELSE  -- issued: the same lines; their text and order only
      SELECT COALESCE(array_agg(it.id), '{}') INTO v_line_ids FROM public.invoice_items it WHERE it.invoice_id = v_id;
      IF v_n <> cardinality(v_line_ids) THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = format('invoice_locked:%s is issued, so lines can''t be added or removed. Move it back to draft to change them.', v_label);
      END IF;
      FOR i IN 0 .. v_n - 1 LOOP
        e := p_items -> i;
        v_line := format('Line %s', i + 1);
        IF jsonb_typeof(e) <> 'object' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_item:%s must be an object.', v_line);
        END IF;
        FOR v_key IN SELECT jsonb_object_keys(e) LOOP
          IF NOT (v_key = ANY (c_item_keys)) THEN
            RAISE EXCEPTION USING ERRCODE = '22023',
              MESSAGE = format('invalid_item:%s: the field “%s” can''t be saved here.', v_line, left(v_key, 40));
          END IF;
        END LOOP;
        v_lid := public._admin_json_int(c_l, e -> 'id', v_line || ': the line id', 1, 2147483647);
        IF v_lid IS NULL OR NOT (v_lid = ANY (v_line_ids)) OR v_lid = ANY (v_seen) THEN
          RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = format('invoice_locked:%s is issued, so lines can''t be added or removed. Move it back to draft to change them.', v_label);
        END IF;
        v_seen := v_seen || v_lid;
        SELECT * INTO v_old FROM public.invoice_items WHERE id = v_lid;
        IF (e ? 'quantity'   AND public._invoice_json_qty(c_l, e -> 'quantity', v_line || ': the quantity') IS DISTINCT FROM v_old.quantity)
        OR (e ? 'unit_price' AND public._admin_json_money(c_l, e -> 'unit_price', v_line || ': the unit price') IS DISTINCT FROM v_old.unit_price)
        OR (e ? 'variant_id' AND public._admin_json_int(c_l, e -> 'variant_id', v_line || ': the catalogue item', 1, 2147483647) IS DISTINCT FROM v_old.variant_id)
        OR (e ? 'product_id' AND v_old.variant_id IS NULL
            AND public._admin_json_int(c_l, e -> 'product_id', v_line || ': the product', 1, 2147483647) IS DISTINCT FROM v_old.product_id) THEN
          RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = format('invoice_locked:%s is issued, so its quantities, prices and catalogue items are fixed. Move it back to draft to change them.', v_label);
        END IF;
        v_serials := CASE WHEN e ? 'serial_numbers' THEN public._serials_from_json(c_l, e -> 'serial_numbers', v_line, 200)
                          ELSE v_old.serial_numbers END;
        IF cardinality(v_serials) > GREATEST(trunc(v_old.quantity), 1) THEN
          RAISE EXCEPTION USING ERRCODE = '22023',
            MESSAGE = format('too_many_serials:%s has %s serial numbers for a quantity of %s.', v_line, cardinality(v_serials), trunc(v_old.quantity));
        END IF;
        FOREACH v_sn IN ARRAY v_serials LOOP
          IF upper(v_sn) = ANY (v_all_sn) THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('duplicate_serial:S/N %s is on two lines.', v_sn);
          END IF;
          v_all_sn := v_all_sn || upper(v_sn);
        END LOOP;
        UPDATE public.invoice_items SET
          position       = i,
          description    = CASE WHEN e ? 'description' THEN public._admin_json_text(c_l, e -> 'description', v_line || ': the description', 1000, TRUE) ELSE description END,
          serial_numbers = v_serials,
          warranty       = CASE WHEN e ? 'warranty'    THEN public._admin_json_text(c_l, e -> 'warranty', v_line || ': the warranty', 80) ELSE warranty END
        WHERE id = v_lid;
      END LOOP;
      -- the serials may have changed: match them against the unit register again
      PERFORM public._invoice_release_units(v_id);
      PERFORM public._invoice_link_units(v_id);
    END IF;
  END IF;

  PERFORM public._invoice_recalc(v_id);
  RETURN public._invoice_json(v_id) || jsonb_build_object('created', v_create);
END $$;
REVOKE ALL ON FUNCTION public.admin_save_invoice(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_invoice(JSONB, JSONB) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Lifecycle: issue, back to draft, void, delete
-- ─────────────────────────────────────────────────────────────────────────────

-- Draft → issued. Needs the client's name and at least one line. Takes the stock (when
-- deduct_stock) and — the first time — the next free number. One transaction: a refusal (stock,
-- validation) leaves the number unused, so numbers have no gaps.
CREATE OR REPLACE FUNCTION public.admin_issue_invoice(p_invoice_id INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv      public.invoices;
  s        public.invoice_settings;
  v_n      INT;
  v_number TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can issue invoices.';
  END IF;
  SELECT * INTO inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invoice_not_found:This invoice no longer exists — it may have been deleted in another tab.';
  END IF;
  IF inv.status = 'issued' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_already_issued:%s is already issued.', inv.number);
  END IF;
  IF inv.status = 'void' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is void and can no longer be issued.', inv.number);
  END IF;
  IF COALESCE(btrim(inv.bill_to_name), '') = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invoice_incomplete:Add the client''s name before issuing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invoice_items it WHERE it.invoice_id = inv.id) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invoice_incomplete:Add at least one line before issuing.';
  END IF;

  IF inv.deduct_stock THEN
    PERFORM public._invoice_take_stock(inv.id);
  END IF;
  -- the listed serials leave with this invoice (whether or not it counts stock)
  PERFORM public._invoice_link_units(inv.id);

  IF inv.number IS NULL THEN
    SELECT * INTO s FROM public.invoice_settings WHERE id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'invoice_settings_missing:The invoice numbering row is missing — run 26_invoices.sql again.';
    END IF;
    -- The next number nobody uses (the counter may have been set back by hand).
    v_n := s.next_number;
    LOOP
      v_number := public._invoice_number(s.number_prefix, v_n, s.number_digits);
      EXIT WHEN NOT EXISTS (SELECT 1 FROM public.invoices x WHERE x.number = v_number);
      v_n := v_n + 1;
    END LOOP;
    UPDATE public.invoice_settings SET next_number = v_n + 1 WHERE id;
  END IF;

  UPDATE public.invoices
     SET status = 'issued',
         number = COALESCE(number, v_number),
         issued_at = COALESCE(issued_at, now())
   WHERE id = inv.id;
  PERFORM public._invoice_recalc(inv.id);
  RETURN public._invoice_json(inv.id);
END $$;
REVOKE ALL ON FUNCTION public.admin_issue_invoice(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_issue_invoice(INT) TO authenticated;

-- Issued → draft (keeps its number), so quantities and prices can change. Only while no payment
-- is recorded; the stock and the serials it took go back.
CREATE OR REPLACE FUNCTION public.admin_revert_invoice(p_invoice_id INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv  public.invoices;
  v_np INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can change invoices.';
  END IF;
  SELECT * INTO inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invoice_not_found:This invoice no longer exists — it may have been deleted in another tab.';
  END IF;
  IF inv.status = 'void' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is void and can no longer be changed.', inv.number);
  END IF;
  IF inv.status = 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invoice_not_issued:This invoice is already a draft.';
  END IF;
  SELECT count(*)::INT INTO v_np FROM public.invoice_payments pay WHERE pay.invoice_id = inv.id;
  IF v_np > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('invoice_has_payments:%s has %s payment%s recorded. Delete %s first to move it back to draft.',
                       inv.number, v_np, CASE WHEN v_np = 1 THEN '' ELSE 's' END, CASE WHEN v_np = 1 THEN 'it' ELSE 'them' END);
  END IF;
  IF inv.stock_deducted THEN
    PERFORM public._invoice_return_stock(inv.id);
  END IF;
  PERFORM public._invoice_release_units(inv.id);
  UPDATE public.invoices SET status = 'draft' WHERE id = inv.id;
  PERFORM public._invoice_recalc(inv.id);
  RETURN public._invoice_json(inv.id);
END $$;
REVOKE ALL ON FUNCTION public.admin_revert_invoice(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revert_invoice(INT) TO authenticated;

-- A numbered invoice (issued, or moved back to draft) → void: returns the stock and the serials it
-- took and stays on record. Payments must be deleted first (refund the client). A never-issued draft is deleted.
CREATE OR REPLACE FUNCTION public.admin_void_invoice(p_invoice_id INT, p_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv      public.invoices;
  v_np     INT;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, ''), E' \t\r\n'), '');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can void invoices.';
  END IF;
  SELECT * INTO inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invoice_not_found:This invoice no longer exists — it may have been deleted in another tab.';
  END IF;
  IF inv.status = 'void' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is already void.', inv.number);
  END IF;
  IF inv.number IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invoice_not_issued:This draft was never issued, so there is nothing to void — delete it instead.';
  END IF;
  IF char_length(v_reason) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:The reason can be at most 500 characters.';
  END IF;
  SELECT count(*)::INT INTO v_np FROM public.invoice_payments pay WHERE pay.invoice_id = inv.id;
  IF v_np > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('invoice_has_payments:%s has %s payment%s recorded. Refund the client and delete %s first, then void it.',
                       inv.number, v_np, CASE WHEN v_np = 1 THEN '' ELSE 's' END, CASE WHEN v_np = 1 THEN 'it' ELSE 'them' END);
  END IF;
  IF inv.stock_deducted THEN
    PERFORM public._invoice_return_stock(inv.id);
  END IF;
  PERFORM public._invoice_release_units(inv.id);
  UPDATE public.invoices SET status = 'void', voided_at = now(), void_reason = v_reason WHERE id = inv.id;
  PERFORM public._invoice_recalc(inv.id);
  RETURN public._invoice_json(inv.id);
END $$;
REVOKE ALL ON FUNCTION public.admin_void_invoice(INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_void_invoice(INT, TEXT) TO authenticated;

-- Only a draft that never had a number. Returns {deleted_id}.
CREATE OR REPLACE FUNCTION public.admin_delete_invoice(p_invoice_id INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv public.invoices;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can delete invoices.';
  END IF;
  SELECT * INTO inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invoice_not_found:This invoice no longer exists — it may have been deleted in another tab.';
  END IF;
  IF inv.number IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('invoice_numbered:%s has been issued, so it stays on record — void it instead.', inv.number);
  END IF;
  DELETE FROM public.invoices WHERE id = inv.id;
  RETURN jsonb_build_object('deleted_id', inv.id);
END $$;
REVOKE ALL ON FUNCTION public.admin_delete_invoice(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_invoice(INT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Payments
-- ─────────────────────────────────────────────────────────────────────────────

-- Money received against an ISSUED invoice: above 0, at most the balance due, dated today or
-- earlier (Sri Lanka). Returns _invoice_json().
CREATE OR REPLACE FUNCTION public.admin_record_invoice_payment(p_invoice_id INT, p_amount NUMERIC, p_paid_on DATE,
                                                               p_method TEXT, p_reference TEXT DEFAULT NULL,
                                                               p_note TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv         public.invoices;
  v_method    TEXT := lower(btrim(COALESCE(p_method, '')));
  v_reference TEXT := NULLIF(btrim(COALESCE(p_reference, ''), E' \t\r\n'), '');
  v_note      TEXT := NULLIF(btrim(COALESCE(p_note, ''), E' \t\r\n'), '');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can record payments.';
  END IF;
  SELECT * INTO inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invoice_not_found:This invoice no longer exists — it may have been deleted in another tab.';
  END IF;
  IF inv.status = 'void' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is void — it can''t take payments.', inv.number);
  END IF;
  IF inv.status = 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invoice_not_issued:Issue the invoice before recording a payment.';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_payment:Enter the amount received, in rupees (above 0).';
  END IF;
  IF inv.balance_due <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('overpayment:%s is already paid in full.', inv.number);
  END IF;
  IF p_amount > inv.balance_due THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('overpayment:The balance due on %s is %s — a payment can''t be more than that.', inv.number, public._invoice_rs(inv.balance_due));
  END IF;
  IF p_paid_on IS NULL OR p_paid_on < DATE '2000-01-01' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_payment:Choose the date the payment was received.';
  END IF;
  IF p_paid_on > (now() AT TIME ZONE 'Asia/Colombo')::DATE THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_payment:The payment date can''t be in the future.';
  END IF;
  IF v_method NOT IN ('cash', 'bank_transfer', 'card', 'cheque', 'online', 'other') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_payment:Choose how the payment was made.';
  END IF;
  IF char_length(v_reference) > 120 OR char_length(v_note) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid_payment:The reference can be at most 120 characters and the note at most 500.';
  END IF;
  INSERT INTO public.invoice_payments (invoice_id, amount, paid_on, method, reference, note, created_by)
  VALUES (inv.id, p_amount, p_paid_on, v_method, v_reference, v_note,
          (SELECT c.id FROM public.customers c WHERE c.id = auth.uid()));
  PERFORM public._invoice_recalc(inv.id);
  RETURN public._invoice_json(inv.id);
END $$;
REVOKE ALL ON FUNCTION public.admin_record_invoice_payment(INT, NUMERIC, DATE, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_record_invoice_payment(INT, NUMERIC, DATE, TEXT, TEXT, TEXT) TO authenticated;

-- A payment recorded by mistake (or refunded). Returns _invoice_json() of its invoice.
CREATE OR REPLACE FUNCTION public.admin_delete_invoice_payment(p_payment_id INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_invoice INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can delete payments.';
  END IF;
  SELECT pay.invoice_id INTO v_invoice FROM public.invoice_payments pay WHERE pay.id = p_payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'payment_not_found:This payment no longer exists — it may have been deleted in another tab.';
  END IF;
  PERFORM 1 FROM public.invoices WHERE id = v_invoice FOR UPDATE;   -- invoice first, like every writer
  DELETE FROM public.invoice_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'payment_not_found:This payment no longer exists — it may have been deleted in another tab.';
  END IF;
  PERFORM public._invoice_recalc(v_invoice);
  RETURN public._invoice_json(v_invoice);
END $$;
REVOKE ALL ON FUNCTION public.admin_delete_invoice_payment(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_invoice_payment(INT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Lookups for the invoice builder and the list
-- ─────────────────────────────────────────────────────────────────────────────

-- Catalogue variants for an invoice line. Every word of the term must appear in the brand, name,
-- variant, SKU, card spec line, slug, category or option values (so "lenovo v15" or a model number
-- works). A term that IS the serial number of an in-stock unit (a scanned box label) finds that
-- unit's variant first and returns the serial, so the line is added with it; then an exact SKU,
-- SKU prefixes, active items, names starting with the term. Inactive items are included (and
-- flagged): the showroom may invoice what the website doesn't show. Empty term → active items in
-- store order. units_in_stock = serial-numbered units of the variant on the shelf (25).
CREATE OR REPLACE FUNCTION public.admin_invoice_product_search(p_term TEXT, p_limit INT DEFAULT 12)
RETURNS TABLE (variant_id INT, product_id INT, product_name TEXT, brand TEXT, variant_name TEXT,
               variant_count INT, sku TEXT, price NUMERIC, image_url TEXT, warranty_months INT,
               category_name TEXT, product_is_active BOOLEAN, variant_is_active BOOLEAN,
               tracked BOOLEAN, stock_level INT, exact_sku BOOLEAN, serial_number TEXT, units_in_stock INT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_term  TEXT := left(btrim(regexp_replace(COALESCE(p_term, ''), '\s+', ' ', 'g')), 100);
  v_lower TEXT;
  v_words TEXT[];
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 12), 1), 50);
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can search the catalogue here.';
  END IF;
  v_lower := lower(v_term);
  v_words := CASE WHEN v_term = '' THEN '{}'::TEXT[] ELSE string_to_array(v_lower, ' ') END;
  RETURN QUERY
  SELECT v.id, p.id, p.name, p.brand, v.name, p.variant_count, v.sku, v.price, p.image_url, p.warranty_months,
         c.name, p.is_active, v.is_active, (inv.variant_id IS NOT NULL), inv.stock_level,
         (v.sku IS NOT NULL AND lower(v.sku) = v_lower),
         hit.serial_number, un.n
    FROM public.product_variants v
    JOIN public.products p ON p.id = v.product_id
    LEFT JOIN public.categories c ON c.id = p.category_id
    LEFT JOIN public.inventory inv ON inv.variant_id = v.id
    LEFT JOIN LATERAL (
      SELECT pu.serial_number FROM public.product_units pu
       WHERE v_term <> '' AND pu.variant_id = v.id AND pu.status = 'in_stock' AND upper(pu.serial_number) = upper(v_term)
       LIMIT 1) hit ON TRUE
    CROSS JOIN LATERAL (
      SELECT count(*)::INT AS n FROM public.product_units pu WHERE pu.variant_id = v.id AND pu.status = 'in_stock') un
    CROSS JOIN LATERAL (
      SELECT lower(concat_ws(' ', p.brand, p.name, v.name, v.sku, p.subtitle, p.slug, c.name,
                             (SELECT string_agg(o.value, ' ') FROM jsonb_each_text(v.option_values) o))) AS hay) h
   WHERE hit.serial_number IS NOT NULL OR NOT EXISTS (SELECT 1 FROM unnest(v_words) w WHERE strpos(h.hay, w) = 0)
   ORDER BY (hit.serial_number IS NOT NULL) DESC,
            (v.sku IS NOT NULL AND lower(v.sku) = v_lower) DESC,
            (v_lower <> '' AND v.sku IS NOT NULL AND starts_with(lower(v.sku), v_lower)) DESC,
            (p.is_active AND v.is_active) DESC,
            (v_lower <> '' AND starts_with(lower(p.brand || ' ' || p.name), v_lower)) DESC,
            (v_lower <> '' AND starts_with(lower(p.name), v_lower)) DESC,
            CASE WHEN v_lower = '' THEN p.sort_order END,
            lower(p.name), v.position, v.id
   LIMIT v_limit;
END $$;
REVOKE ALL ON FUNCTION public.admin_invoice_product_search(TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_invoice_product_search(TEXT, INT) TO authenticated;

-- Clients to bill: people invoiced before (newest details first) and registered customers.
-- Every word must appear in the name, email, phone, city or company line. Duplicates (same email,
-- or same name and phone) collapse to the most recent. Empty term → the latest invoiced clients.
CREATE OR REPLACE FUNCTION public.admin_invoice_client_search(p_term TEXT, p_limit INT DEFAULT 8)
RETURNS TABLE (source TEXT, customer_id UUID, name TEXT, address TEXT, city TEXT, postal_code TEXT,
               phone TEXT, email TEXT, last_invoiced_at TIMESTAMPTZ, invoice_count INT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_term  TEXT := left(btrim(regexp_replace(COALESCE(p_term, ''), '\s+', ' ', 'g')), 100);
  v_words TEXT[];
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 8), 1), 25);
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can search clients.';
  END IF;
  v_words := CASE WHEN v_term = '' THEN '{}'::TEXT[] ELSE string_to_array(lower(v_term), ' ') END;
  RETURN QUERY
  WITH billed AS (
    SELECT 'invoice'::TEXT AS source, i.customer_id, btrim(i.bill_to_name) AS name, i.bill_to_address AS address,
           i.bill_to_city AS city, i.bill_to_postal_code AS postal_code, i.bill_to_phone AS phone,
           i.bill_to_email AS email, i.updated_at AS last_invoiced_at,
           count(*) OVER (PARTITION BY lower(btrim(i.bill_to_name)), COALESCE(i.bill_to_email, ''), COALESCE(i.bill_to_phone, ''))::INT AS invoice_count,
           row_number() OVER (PARTITION BY lower(btrim(i.bill_to_name)), COALESCE(i.bill_to_email, ''), COALESCE(i.bill_to_phone, '')
                              ORDER BY i.updated_at DESC, i.id DESC) AS rn
      FROM public.invoices i
     WHERE COALESCE(btrim(i.bill_to_name), '') <> ''
  ), registered AS (
    SELECT 'customer'::TEXT AS source, cu.id AS customer_id,
           COALESCE(NULLIF(btrim(concat_ws(' ', cu.first_name, cu.last_name)), ''), cu.email) AS name,
           cu.street AS address, cu.city, cu.postal_code, cu.phone, cu.email,
           NULL::TIMESTAMPTZ AS last_invoiced_at, 0 AS invoice_count, 1::BIGINT AS rn
      FROM public.customers cu
  ), candidates AS (
    SELECT b.source, b.customer_id, b.name, b.address, b.city, b.postal_code, b.phone, b.email, b.last_invoiced_at, b.invoice_count
      FROM billed b WHERE b.rn = 1
    UNION ALL
    SELECT r.source, r.customer_id, r.name, r.address, r.city, r.postal_code, r.phone, r.email, r.last_invoiced_at, r.invoice_count
      FROM registered r
  ), matched AS (
    SELECT x.*,
           row_number() OVER (PARTITION BY COALESCE(lower(x.email), lower(x.name) || '|' || COALESCE(x.phone, ''))
                              ORDER BY (x.source = 'invoice') DESC, x.last_invoiced_at DESC NULLS LAST) AS dup
      FROM candidates x
     WHERE NOT EXISTS (SELECT 1 FROM unnest(v_words) w
                        WHERE strpos(lower(concat_ws(' ', x.name, x.email, x.phone, x.city)), w) = 0)
  )
  -- A past client whose email belongs to an account is linked to it.
  SELECT m.source,
         COALESCE(m.customer_id, (SELECT cu.id FROM public.customers cu WHERE lower(cu.email) = lower(m.email))),
         m.name, m.address, m.city, m.postal_code, m.phone, m.email, m.last_invoiced_at, m.invoice_count
    FROM matched m
   WHERE m.dup = 1
   ORDER BY m.last_invoiced_at DESC NULLS LAST, lower(m.name)
   LIMIT v_limit;
END $$;
REVOKE ALL ON FUNCTION public.admin_invoice_client_search(TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_invoice_client_search(TEXT, INT) TO authenticated;

-- The list's headline figures (Sri Lanka days). Definitions (shown as the KPI hints):
--   outstanding  issued invoices with a balance due: count and Σ balance_due
--   overdue      those whose due date is before today
--   drafts       draft invoices
--   issued_30d   invoices issued (invoice date) in the last 30 days, today included: count, Σ total
--   received_30d Σ payments dated in the last 30 days on invoices that are still issued
CREATE OR REPLACE FUNCTION public.admin_invoice_summary()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_today DATE := (now() AT TIME ZONE 'Asia/Colombo')::DATE;
  v_out   JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can see invoice figures.';
  END IF;
  SELECT jsonb_build_object(
           'today',             v_today,
           'outstanding_count', count(*) FILTER (WHERE i.status = 'issued' AND i.balance_due > 0),
           'outstanding_total', COALESCE(sum(i.balance_due) FILTER (WHERE i.status = 'issued' AND i.balance_due > 0), 0),
           'overdue_count',     count(*) FILTER (WHERE i.status = 'issued' AND i.balance_due > 0 AND i.due_date < v_today),
           'overdue_total',     COALESCE(sum(i.balance_due) FILTER (WHERE i.status = 'issued' AND i.balance_due > 0 AND i.due_date < v_today), 0),
           'draft_count',       count(*) FILTER (WHERE i.status = 'draft'),
           'issued_30d_count',  count(*) FILTER (WHERE i.status = 'issued' AND i.issue_date > v_today - 30),
           'issued_30d_total',  COALESCE(sum(i.total) FILTER (WHERE i.status = 'issued' AND i.issue_date > v_today - 30), 0),
           'received_30d_total', (SELECT COALESCE(sum(pay.amount), 0)
                                    FROM public.invoice_payments pay
                                    JOIN public.invoices pi ON pi.id = pay.invoice_id AND pi.status = 'issued'
                                   WHERE pay.paid_on > v_today - 30))
    INTO v_out
    FROM public.invoices i;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_invoice_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_invoice_summary() TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 26_invoices
--   Nothing to configure. Apply after 01–25 (it uses 23's field readers, 07's orders and 25's units).
--   Then, in admin → Invoices → "Template & numbering": set the NEXT NUMBER to carry on from the
--   last invoice you wrote by hand (e.g. 154 → INV-0154), and check the address, contacts and the
--   ten notes (copied from the invoice workbook).
--   "Take items out of stock" (on by default) makes issuing an invoice reduce stock exactly like a
--   web order; switch it off per invoice for something the website already sold (an invoice
--   made from a web order starts with it off).
--   Verification:
--     SELECT number_prefix, next_number, cardinality(default_notes) FROM public.invoice_settings;  -- INV-, 1, 10
--     SELECT p.oid::regprocedure, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can
--       FROM pg_proc p WHERE p.proname LIKE 'admin\_%invoice%';                                  -- all false
--     SELECT has_table_privilege('anon', 'public.invoices', 'SELECT');                          -- false
--     -- numbers have no gaps (run any time):
--     SELECT number FROM public.invoices WHERE number IS NOT NULL ORDER BY number;
--     -- live probes (anon key is public): refused
--     curl -s "$SUPABASE_URL/rest/v1/invoices?select=*" -H "apikey: $ANON"                     -- permission denied
--     curl -s "$SUPABASE_URL/rest/v1/rpc/admin_save_invoice" -H "apikey: $ANON" \
--          -H "Content-Type: application/json" -d '{"p_invoice":{}}'                            -- 42501
-- ═════════════════════════════════════════════════════════════════════════════
