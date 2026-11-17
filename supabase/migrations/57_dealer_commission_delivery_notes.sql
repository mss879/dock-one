-- ═════════════════════════════════════════════════════════════════════════════
-- 57_dealer_commission_delivery_notes.sql — Dock One Solutions
--
-- PURPOSE      The client's two invoicing change requests (November 2026):
--   DEALER COMMISSION  "If a dealer sends a customer and wants a commission, he can have it, and it
--                      is mentioned on the invoice for easy reference." 53's commission (staff % and
--                      the internal BONUS) gains the dealer: invoices.dealer_name — who referred the
--                      customer — and the dealer's commission, in rupees or as a % of the sale
--                      (dealer_commission_type 'amount' | 'percent', dealer_commission_value; a % is
--                      of the sales before VAT / tax and after discounts, like staff commission).
--                      Set under Invoice details by anyone who can edit the invoice (paid = final
--                      for staff still applies, 53). Internal, like the BONUS: never printed on the
--                      invoice or its WhatsApp PDF. admin_dealer_names() suggests the names already
--                      used. admin_staff_commission_report (53's, owner only) adds the dealers: per
--                      dealer and per invoice, for the issued invoices dated in the period.
--   DELIVERY NOTES     "When staff are on the way to deliver, a delivery note confirming the products
--                      are delivered can be made and sent from any invoice (walk-in sales don't need
--                      one)." delivery_notes: at most one per issued invoice, numbered DN-0001
--                      (invoice_settings.delivery_note_prefix / delivery_note_next_number, the
--                      invoice digits), with the delivery date, who it is delivered to, their
--                      number and address (filled from the invoice) and a note. Its items are the
--                      invoice's lines (no prices). admin_save_delivery_note makes or updates it
--                      (staff with Invoices → edit, the owner); admin_delete_delivery_note — the
--                      owner only. It is a separate record, so making one never changes the invoice
--                      (a paid invoice stays final, 53).
--
-- REPLACES     admin_save_document (53's — start from 53's), admin_staff_commission_report (53's).
--              RE-RUN 57 AFTER ANY RE-RUN OF 53 (and so after 39, 40 or 44, which need 53 again).
-- DEPENDS ON   23 (JSON readers), 26, 28, 40, 44 (invoices, documents), 39 (staff), 53.
-- ERRORS       22023 invalid_invoice:… (dealer), invalid_delivery_note:…, invoice_not_found:…,
--              delivery_note_needs_issue:…, invoice_void:…, delivery_note_not_found:…;
--              42501 not_authorised:…
-- SAFE TO RE-RUN: yes (dealers, delivery notes and the numbering are kept).
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Dealer commission on invoices
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS dealer_name             TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS dealer_commission_type  TEXT NOT NULL DEFAULT 'amount';
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS dealer_commission_value NUMERIC(12,2) NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_dealer_valid') THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_dealer_valid CHECK (
          (dealer_name IS NULL OR char_length(btrim(dealer_name)) BETWEEN 1 AND 120)
      AND dealer_commission_type IN ('amount', 'percent')
      AND dealer_commission_value >= 0 AND dealer_commission_value <= 100000000
      AND (dealer_commission_type = 'amount' OR dealer_commission_value <= 100)
      AND (dealer_name IS NOT NULL OR dealer_commission_value = 0));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS invoices_dealer_idx ON public.invoices (lower(btrim(dealer_name))) WHERE dealer_name IS NOT NULL;

-- The dealer's commission in rupees: a % is of the sales before VAT / tax, after discounts.
CREATE OR REPLACE FUNCTION public._invoice_dealer_commission(p_type TEXT, p_value NUMERIC, p_sales NUMERIC)
RETURNS NUMERIC
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_type = 'percent' THEN round(COALESCE(p_sales, 0) * COALESCE(p_value, 0) / 100, 2)
              ELSE COALESCE(p_value, 0) END
$$;
REVOKE ALL ON FUNCTION public._invoice_dealer_commission(TEXT, NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. admin_save_document — 53's, plus the dealer and their commission
-- ─────────────────────────────────────────────────────────────────────────────
-- p_doc gains (invoices only; anyone who may edit the invoice): dealer_name (text ≤ 120, null = no
-- dealer), dealer_commission_type ('amount' | 'percent') and dealer_commission_value (rupees, or a %
-- from 0 to 100). A commission needs a dealer's name.
CREATE OR REPLACE FUNCTION public.admin_save_document(p_invoice JSONB, p_items JSONB DEFAULT NULL, p_sale JSONB DEFAULT NULL, p_doc JSONB DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_i      CONSTANT TEXT := 'invalid_invoice';
  v_id     INT;
  cur      public.invoices;
  v_found  BOOLEAN := FALSE;
  v_type   TEXT;
  v_valid  DATE;
  v_comp   TEXT;
  v_sig    BOOLEAN;
  v_bonus  NUMERIC;
  v_staff  UUID;
  v_dealer TEXT;
  v_dtype  TEXT;
  v_dval   NUMERIC;
  v_eff_name  TEXT;
  v_eff_type  TEXT;
  v_eff_value NUMERIC;
  v_key    TEXT;
  v_saved  JSONB;
  i        INT;
  e        JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t save invoices or quotations.';
  END IF;
  IF p_doc IS NOT NULL AND jsonb_typeof(p_doc) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:The document settings must be a JSON object.';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(COALESCE(p_doc, '{}'::jsonb)) LOOP
    IF NOT (v_key = ANY (ARRAY['doc_type', 'valid_until', 'bill_to_company',
                               'show_signature_lines', 'bonus', 'sales_staff_id',
                               'dealer_name', 'dealer_commission_type', 'dealer_commission_value'])) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_invoice:The field “%s” can''t be saved here.', left(v_key, 40));
    END IF;
  END LOOP;
  v_id := public._admin_json_int(c_i, COALESCE(p_invoice, '{}'::jsonb) -> 'id', 'The invoice id', 1, 2147483647);
  IF v_id IS NOT NULL THEN
    SELECT * INTO cur FROM public.invoices WHERE id = v_id FOR UPDATE;
    v_found := FOUND;
  END IF;
  v_type := lower(COALESCE(NULLIF(p_doc ->> 'doc_type', ''), CASE WHEN v_found THEN cur.doc_type END, 'invoice'));
  IF v_type NOT IN ('invoice', 'quotation') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:Choose Invoice or Quotation.';
  END IF;
  IF NOT public.staff_can(public._doc_area(v_type), 'edit') AND current_setting('request.path', true) IS NOT NULL
     AND current_setting('request.path', true) <> '' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = format('not_authorised:Your account can''t edit %s.', CASE WHEN v_type = 'quotation' THEN 'quotations' ELSE 'invoices' END);
  END IF;
  IF v_found THEN
    IF cur.number IS NOT NULL AND cur.doc_type <> v_type THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('doc_type_locked:%s is numbered, so it stays a %s.%s', cur.number, cur.doc_type,
                         CASE WHEN cur.doc_type = 'quotation' THEN ' Use “Convert to invoice” instead.' ELSE '' END);
    END IF;
    IF cur.doc_type = 'quotation' AND cur.converted_invoice_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('quotation_converted:%s was converted into an invoice, so it can''t be changed.', COALESCE(cur.number, 'This quotation'));
    END IF;
  END IF;
  -- invoices: inventory products only (drafts; an issued invoice's lines can't change anyway)
  IF v_type = 'invoice' AND (NOT v_found OR cur.status = 'draft')
     AND p_items IS NOT NULL AND jsonb_typeof(p_items) = 'array'
     AND NOT ((v_found AND cur.order_id IS NOT NULL)
              OR (NOT v_found AND NULLIF(btrim(COALESCE(p_invoice ->> 'order_id', '')), '') IS NOT NULL)) THEN
    FOR i IN 0 .. jsonb_array_length(p_items) - 1 LOOP
      e := p_items -> i;
      IF jsonb_typeof(e) = 'object' AND (NOT (e ? 'variant_id') OR jsonb_typeof(e -> 'variant_id') = 'null') THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = format('custom_line:Line %s (“%s”) is not an inventory product. Invoices can only contain products from the inventory — pick the product and its variant, or save this as a quotation.',
                           i + 1, left(COALESCE(e ->> 'description', ''), 60));
      END IF;
    END LOOP;
  END IF;
  v_valid := public._invoice_json_date(c_i, p_doc -> 'valid_until', 'Valid until');
  v_comp  := public._admin_json_text(c_i, p_doc -> 'bill_to_company', 'The company', 200);
  -- 53: signature lines (any document); bonus and sales staff (invoices — the owner's to set)
  v_sig   := public._admin_json_bool(c_i, p_doc -> 'show_signature_lines', 'Signature lines');
  v_bonus := public._admin_json_money(c_i, p_doc -> 'bonus', 'The bonus');
  IF v_bonus > 100000000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:The bonus can be at most Rs. 100,000,000.';
  END IF;
  v_staff := public._invoice_json_uuid(c_i, p_doc -> 'sales_staff_id', 'The sales staff');
  IF v_staff IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.customers c
        WHERE c.id = v_staff AND (c.is_admin OR EXISTS (SELECT 1 FROM public.staff_accounts s WHERE s.user_id = c.id))) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:Choose the owner or a staff account as the sales staff.';
  END IF;
  IF ((p_doc ? 'bonus' AND COALESCE(v_bonus, 0) IS DISTINCT FROM COALESCE(CASE WHEN v_found THEN cur.bonus END, 0))
      OR (p_doc ? 'sales_staff_id' AND v_staff IS DISTINCT FROM CASE WHEN v_found THEN cur.sales_staff_id END))
     AND NOT public.is_full_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only the owner sets the bonus and who the sale counts for.';
  END IF;
  -- 57: the dealer who referred the customer and their commission (invoices; anyone who may edit it)
  v_dealer := public._admin_json_text(c_i, p_doc -> 'dealer_name', 'The dealer', 120);
  IF p_doc ? 'dealer_commission_type' THEN
    v_dtype := lower(NULLIF(btrim(COALESCE(p_doc ->> 'dealer_commission_type', '')), ''));
    IF v_dtype IS NULL OR v_dtype NOT IN ('amount', 'percent') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:The dealer''s commission is an amount in rupees or a percentage.';
    END IF;
  END IF;
  v_dval := public._admin_json_money(c_i, p_doc -> 'dealer_commission_value', 'The dealer''s commission');

  IF v_type = 'quotation' THEN
    v_saved := public.admin_save_invoice(
      CASE WHEN p_invoice ? 'deduct_stock' THEN p_invoice - 'deduct_stock' ELSE p_invoice END, p_items);
  ELSE
    v_saved := public.admin_save_invoice_sale(p_invoice, p_items, p_sale);
  END IF;
  v_id := (v_saved -> 'invoice' ->> 'id')::INT;
  SELECT * INTO cur FROM public.invoices WHERE id = v_id;
  IF cur.status = 'void' AND (
       (p_doc ? 'show_signature_lines' AND v_sig IS DISTINCT FROM cur.show_signature_lines)
    OR (p_doc ? 'bonus' AND COALESCE(v_bonus, 0) IS DISTINCT FROM cur.bonus)
    OR (p_doc ? 'sales_staff_id' AND v_staff IS DISTINCT FROM cur.sales_staff_id)
    OR (p_doc ? 'dealer_name' AND v_dealer IS DISTINCT FROM cur.dealer_name)
    OR (p_doc ? 'dealer_commission_type' AND v_dtype IS DISTINCT FROM cur.dealer_commission_type)
    OR (p_doc ? 'dealer_commission_value' AND COALESCE(v_dval, 0) IS DISTINCT FROM cur.dealer_commission_value)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is void and can no longer be changed.', cur.number);
  END IF;
  IF v_valid IS NOT NULL AND v_valid < cur.issue_date THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:“Valid until” can''t be before the quotation date.';
  END IF;
  -- 57: the dealer's commission as it will be saved (what was sent, else what the invoice has)
  IF v_type = 'invoice' AND (p_doc ? 'dealer_name' OR p_doc ? 'dealer_commission_type' OR p_doc ? 'dealer_commission_value') THEN
    v_eff_name  := CASE WHEN p_doc ? 'dealer_name' THEN v_dealer ELSE cur.dealer_name END;
    v_eff_type  := CASE WHEN p_doc ? 'dealer_commission_type' THEN v_dtype ELSE cur.dealer_commission_type END;
    v_eff_value := CASE WHEN p_doc ? 'dealer_commission_value' THEN COALESCE(v_dval, 0) ELSE cur.dealer_commission_value END;
    IF v_eff_type = 'percent' AND v_eff_value > 100 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:A dealer''s commission in % is from 0 to 100.';
    END IF;
    IF v_eff_value > 100000000 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:The dealer''s commission can be at most Rs. 100,000,000.';
    END IF;
    IF v_eff_name IS NULL AND v_eff_value > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:Name the dealer the commission is for.';
    END IF;
  END IF;
  -- switching a draft's type swaps the default terms (only while they are still the defaults)
  UPDATE public.invoices i
     SET doc_type        = v_type,
         valid_until     = CASE WHEN v_type = 'quotation'
                                THEN CASE WHEN p_doc ? 'valid_until' THEN v_valid ELSE i.valid_until END END,
         bill_to_company = CASE WHEN p_doc ? 'bill_to_company' THEN v_comp ELSE i.bill_to_company END,
         show_signature_lines = CASE WHEN p_doc ? 'show_signature_lines' AND v_sig IS NOT NULL THEN v_sig
                                     ELSE i.show_signature_lines END,
         bonus           = CASE WHEN v_type = 'invoice' AND p_doc ? 'bonus' THEN COALESCE(v_bonus, 0) ELSE i.bonus END,
         sales_staff_id  = CASE WHEN v_type = 'invoice' AND p_doc ? 'sales_staff_id' THEN v_staff ELSE i.sales_staff_id END,
         dealer_name     = CASE WHEN v_type = 'invoice' AND p_doc ? 'dealer_name' THEN v_dealer ELSE i.dealer_name END,
         dealer_commission_type  = CASE WHEN v_type = 'invoice' AND p_doc ? 'dealer_commission_type' THEN v_dtype
                                        ELSE i.dealer_commission_type END,
         dealer_commission_value = CASE WHEN v_type = 'invoice' AND p_doc ? 'dealer_commission_value' THEN COALESCE(v_dval, 0)
                                        ELSE i.dealer_commission_value END,
         notes = CASE WHEN v_type <> i.doc_type AND i.status = 'draft' AND NOT (p_invoice ? 'notes')
                       AND i.notes = (CASE WHEN i.doc_type = 'quotation' THEN s.quote_notes ELSE s.default_notes END)
                      THEN CASE WHEN v_type = 'quotation' THEN s.quote_notes ELSE s.default_notes END
                      ELSE i.notes END
    FROM public.invoice_settings s
   WHERE i.id = v_id AND s.id;
  PERFORM public._invoice_recalc(v_id);
  RETURN public._invoice_json(v_id) || jsonb_build_object('created', COALESCE((v_saved ->> 'created')::BOOLEAN, FALSE));
END $$;
REVOKE ALL ON FUNCTION public.admin_save_document(JSONB, JSONB, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_document(JSONB, JSONB, JSONB, JSONB) TO authenticated;

-- The dealer names already used on invoices (latest first, one spelling each — the latest), for the
-- invoice screen's suggestions. ["ABC Computers", …] (at most 200)
CREATE OR REPLACE FUNCTION public.admin_dealer_names()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t see the dealers.';
  END IF;
  SELECT COALESCE(jsonb_agg(d.name ORDER BY d.last_date DESC, d.last_id DESC), '[]'::jsonb) INTO v_out
    FROM (SELECT (array_agg(btrim(i.dealer_name) ORDER BY i.issue_date DESC, i.id DESC))[1] AS name,
                 max(i.issue_date) AS last_date, max(i.id) AS last_id
            FROM public.invoices i
           WHERE i.dealer_name IS NOT NULL AND i.doc_type = 'invoice'
           GROUP BY lower(btrim(i.dealer_name))
           ORDER BY max(i.issue_date) DESC, max(i.id) DESC
           LIMIT 200) d;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_dealer_names() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_dealer_names() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The commission report — 53's, plus the dealers
-- ─────────────────────────────────────────────────────────────────────────────
-- admin_staff_commission_report(from, to) — OWNER ONLY. 53's staff part, unchanged:
-- Issued invoices (not void, not quotations) dated from..to (Sri Lanka days, inclusive), counted for
-- COALESCE(sales_staff_id, created_by); website orders' invoices only when a sales staff is named.
-- {from, to, rows: [{user_id, name, role, commission_percent, invoices, sales, paid, commission,
--   bonus, total}], invoices: [{id, number, issue_date, client, user_id, sales, paid, payment_status,
--   bonus, commission}], totals: {invoices, sales, paid, commission, bonus, total}}
-- sales = subtotal − discount (before VAT / tax); commission = round(sales × % / 100, 2) per invoice.
-- 57 adds the dealers — every issued invoice dated in the period that names a dealer (any channel):
--   dealers: [{name, invoices, sales, paid, commission}] (one per dealer, names matched ignoring case
--   and spaces at the ends; the latest spelling), dealer_invoices: [{id, number, issue_date, client,
--   dealer, sales, paid, payment_status, commission_type, commission_value, commission}],
--   dealer_totals: {invoices, sales, paid, commission}.
CREATE OR REPLACE FUNCTION public.admin_staff_commission_report(p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out    JSONB;
  v_dealer JSONB;
BEGIN
  IF NOT public.is_full_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only the owner can see staff commission.';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 3660 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_range:Choose a date range of up to ten years.';
  END IF;
  WITH lines AS (
    SELECT i.id, i.number, i.issue_date, i.bill_to_name AS client, COALESCE(i.sales_staff_id, i.created_by) AS user_id,
           i.subtotal - i.discount_amount AS sales, i.amount_paid AS paid, i.payment_status, i.bonus,
           round((i.subtotal - i.discount_amount) * COALESCE(s.commission_percent, 0) / 100, 2) AS commission
      FROM public.invoices i
      LEFT JOIN public.staff_accounts s ON s.user_id = COALESCE(i.sales_staff_id, i.created_by)
     WHERE i.doc_type = 'invoice' AND i.status = 'issued'
       AND i.issue_date BETWEEN p_from AND p_to
       AND (i.channel = 'store' OR i.sales_staff_id IS NOT NULL)
  ), per AS (
    SELECT l.user_id,
           CASE WHEN c.is_admin THEN 'owner' WHEN st.user_id IS NOT NULL THEN 'staff' ELSE 'other' END AS role,
           CASE WHEN c.is_admin THEN 0 WHEN st.user_id IS NOT NULL THEN 1 ELSE 2 END AS role_rank,
           COALESCE(st.display_name, NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email, 'Unknown') AS name,
           st.commission_percent AS pct, count(*)::INT AS n, sum(l.sales) AS sales, sum(l.paid) AS paid,
           sum(l.commission) AS commission, sum(l.bonus) AS bonus
      FROM lines l
      LEFT JOIN public.customers c ON c.id = l.user_id
      LEFT JOIN public.staff_accounts st ON st.user_id = l.user_id
     GROUP BY l.user_id, c.is_admin, st.user_id, st.display_name, c.first_name, c.last_name, c.email, st.commission_percent
  )
  SELECT jsonb_build_object(
           'from', p_from, 'to', p_to,
           'rows', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'user_id', r.user_id, 'name', r.name, 'role', r.role, 'commission_percent', r.pct,
                     'invoices', r.n, 'sales', r.sales, 'paid', r.paid, 'commission', r.commission, 'bonus', r.bonus,
                     'total', r.commission + r.bonus) ORDER BY r.role_rank, r.name) FROM per r), '[]'::jsonb),
           'invoices', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                     'id', l.id, 'number', l.number, 'issue_date', l.issue_date, 'client', l.client, 'user_id', l.user_id,
                     'sales', l.sales, 'paid', l.paid, 'payment_status', l.payment_status, 'bonus', l.bonus,
                     'commission', l.commission) ORDER BY l.issue_date, l.id) FROM lines l), '[]'::jsonb),
           'totals', (SELECT jsonb_build_object('invoices', count(*), 'sales', COALESCE(sum(sales), 0), 'paid', COALESCE(sum(paid), 0),
                                                'commission', COALESCE(sum(commission), 0), 'bonus', COALESCE(sum(bonus), 0),
                                                'total', COALESCE(sum(commission + bonus), 0)) FROM lines))
    INTO v_out;

  -- 57: the dealers
  WITH dl AS (
    SELECT i.id, i.number, i.issue_date, i.bill_to_name AS client, btrim(i.dealer_name) AS dealer,
           lower(btrim(i.dealer_name)) AS dealer_key,
           i.subtotal - i.discount_amount AS sales, i.amount_paid AS paid, i.payment_status,
           i.dealer_commission_type AS ctype, i.dealer_commission_value AS cvalue,
           public._invoice_dealer_commission(i.dealer_commission_type, i.dealer_commission_value, i.subtotal - i.discount_amount) AS commission
      FROM public.invoices i
     WHERE i.doc_type = 'invoice' AND i.status = 'issued' AND i.dealer_name IS NOT NULL
       AND i.issue_date BETWEEN p_from AND p_to
  ), per_dealer AS (
    SELECT (array_agg(d.dealer ORDER BY d.issue_date DESC, d.id DESC))[1] AS name, count(*)::INT AS n,
           sum(d.sales) AS sales, sum(d.paid) AS paid, sum(d.commission) AS commission
      FROM dl d
     GROUP BY d.dealer_key
  )
  SELECT jsonb_build_object(
           'dealers', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'name', p.name, 'invoices', p.n, 'sales', p.sales, 'paid', p.paid, 'commission', p.commission)
                        ORDER BY lower(p.name)) FROM per_dealer p), '[]'::jsonb),
           'dealer_invoices', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                        'id', d.id, 'number', d.number, 'issue_date', d.issue_date, 'client', d.client, 'dealer', d.dealer,
                        'sales', d.sales, 'paid', d.paid, 'payment_status', d.payment_status,
                        'commission_type', d.ctype, 'commission_value', d.cvalue, 'commission', d.commission)
                        ORDER BY d.issue_date, d.id) FROM dl d), '[]'::jsonb),
           'dealer_totals', (SELECT jsonb_build_object('invoices', count(*), 'sales', COALESCE(sum(sales), 0),
                                                       'paid', COALESCE(sum(paid), 0), 'commission', COALESCE(sum(commission), 0))
                               FROM dl))
    INTO v_dealer;
  RETURN v_out || v_dealer;
END $$;
REVOKE ALL ON FUNCTION public.admin_staff_commission_report(DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_staff_commission_report(DATE, DATE) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Delivery notes
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.invoice_settings ADD COLUMN IF NOT EXISTS delivery_note_prefix      TEXT NOT NULL DEFAULT 'DN-';
ALTER TABLE public.invoice_settings ADD COLUMN IF NOT EXISTS delivery_note_next_number INT  NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_settings_delivery_notes_valid') THEN
    ALTER TABLE public.invoice_settings ADD CONSTRAINT invoice_settings_delivery_notes_valid CHECK (
          char_length(delivery_note_prefix) <= 12 AND delivery_note_prefix ~ '^[A-Za-z0-9/#._-]*$'
      AND delivery_note_next_number BETWEEN 1 AND 999999999);
  END IF;
END $$;

-- One per invoice, made when its items are delivered. Its items are the invoice's lines.
CREATE TABLE IF NOT EXISTS public.delivery_notes (
  id               SERIAL PRIMARY KEY,
  invoice_id       INT NOT NULL REFERENCES public.invoices (id) ON DELETE CASCADE,
  number           TEXT NOT NULL,                       -- DN-0001
  delivered_on     DATE NOT NULL DEFAULT ((now() AT TIME ZONE 'Asia/Colombo')::date),
  recipient_name   TEXT NOT NULL,                       -- "Deliver to" (from the invoice's client)
  recipient_phone  TEXT,
  delivery_address TEXT,
  note             TEXT,
  created_by       UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  updated_by       UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delivery_notes_invoice_key UNIQUE (invoice_id),
  CONSTRAINT delivery_notes_number_key  UNIQUE (number),
  CONSTRAINT delivery_notes_valid CHECK (
        char_length(number) BETWEEN 1 AND 40
    AND char_length(btrim(recipient_name)) BETWEEN 1 AND 200
    AND (recipient_phone  IS NULL OR char_length(recipient_phone)  <= 50)
    AND (delivery_address IS NULL OR char_length(delivery_address) <= 1000)
    AND (note             IS NULL OR char_length(note)             <= 1000)
    AND delivered_on BETWEEN DATE '2000-01-01' AND DATE '2100-12-31')
);
DROP TRIGGER IF EXISTS delivery_notes_touch ON public.delivery_notes;
CREATE TRIGGER delivery_notes_touch BEFORE UPDATE ON public.delivery_notes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Read by admins (and staff with Invoices → view, staff_api_map below); written only by the RPCs.
ALTER TABLE public.delivery_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.delivery_notes FROM anon, authenticated;
GRANT SELECT ON public.delivery_notes TO authenticated;
REVOKE ALL ON SEQUENCE public.delivery_notes_id_seq FROM anon, authenticated;
DROP POLICY IF EXISTS delivery_notes_admin_read ON public.delivery_notes;
CREATE POLICY delivery_notes_admin_read ON public.delivery_notes
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

-- The next free delivery note number (locks the settings row, like 40's _document_take_number).
CREATE OR REPLACE FUNCTION public._delivery_note_take_number()
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s        public.invoice_settings;
  v_n      INT;
  v_number TEXT;
BEGIN
  SELECT * INTO s FROM public.invoice_settings WHERE id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invoice_settings_missing:The invoice numbering row is missing — run 26_invoices.sql again.';
  END IF;
  v_n := s.delivery_note_next_number;
  LOOP
    v_number := public._invoice_number(s.delivery_note_prefix, v_n, s.number_digits);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.delivery_notes d WHERE d.number = v_number);
    v_n := v_n + 1;
  END LOOP;
  UPDATE public.invoice_settings SET delivery_note_next_number = v_n + 1 WHERE id;
  RETURN v_number;
END $$;
REVOKE ALL ON FUNCTION public._delivery_note_take_number() FROM PUBLIC, anon, authenticated;

-- admin_save_delivery_note(invoice id, p) — makes the invoice's delivery note (numbered), or
-- updates it. The invoice must be issued (not a draft, quotation or void).
-- p: {delivered_on 'YYYY-MM-DD', recipient_name, recipient_phone, delivery_address, note} — all
-- optional; a new one fills what is missing from the invoice (today, its client, phone and address).
-- Returns the delivery note row + {created}.
CREATE OR REPLACE FUNCTION public.admin_save_delivery_note(p_invoice_id INT, p JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_d     CONSTANT TEXT := 'invalid_delivery_note';
  inv     public.invoices;
  dn      public.delivery_notes;
  v_found BOOLEAN;
  v_key   TEXT;
  v_date  DATE;
  v_name  TEXT;
  v_phone TEXT;
  v_addr  TEXT;
  v_note  TEXT;
BEGIN
  IF NOT public.is_admin() OR NOT public.staff_can('invoices', 'edit') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t make delivery notes.';
  END IF;
  p := COALESCE(p, '{}'::jsonb);
  IF jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_delivery_note:The delivery note must be a JSON object.';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p) LOOP
    IF NOT (v_key = ANY (ARRAY['delivered_on', 'recipient_name', 'recipient_phone', 'delivery_address', 'note'])) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_delivery_note:The field “%s” can''t be saved here.', left(v_key, 40));
    END IF;
  END LOOP;
  SELECT * INTO inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND OR inv.doc_type <> 'invoice' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invoice_not_found:That invoice no longer exists.';
  END IF;
  IF inv.status = 'void' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is void, so its delivery note can''t be made or changed.', inv.number);
  END IF;
  IF inv.status <> 'issued' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'delivery_note_needs_issue:Issue the invoice first — a delivery note is made from an issued invoice.';
  END IF;
  v_date  := public._invoice_json_date(c_d, p -> 'delivered_on', 'The delivery date');
  v_name  := public._admin_json_text(c_d, p -> 'recipient_name', 'Deliver to', 200);
  v_phone := public._admin_json_text(c_d, p -> 'recipient_phone', 'The contact number', 50);
  v_addr  := public._admin_json_text(c_d, p -> 'delivery_address', 'The delivery address', 1000);
  v_note  := public._admin_json_text(c_d, p -> 'note', 'The note', 1000);
  IF p ? 'delivered_on' AND v_date IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_delivery_note:The delivery date is required.';
  END IF;
  IF p ? 'recipient_name' AND v_name IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_delivery_note:Say who it is delivered to.';
  END IF;

  SELECT * INTO dn FROM public.delivery_notes WHERE invoice_id = inv.id FOR UPDATE;
  v_found := FOUND;
  IF NOT v_found THEN
    v_name := COALESCE(v_name, NULLIF(btrim(inv.bill_to_name), ''), NULLIF(btrim(inv.bill_to_company), ''));
    IF v_name IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_delivery_note:Say who it is delivered to.';
    END IF;
    INSERT INTO public.delivery_notes (invoice_id, number, delivered_on, recipient_name, recipient_phone, delivery_address, note,
                                       created_by, updated_by)
    VALUES (inv.id, public._delivery_note_take_number(),
            COALESCE(v_date, (now() AT TIME ZONE 'Asia/Colombo')::date),
            left(v_name, 200),
            CASE WHEN p ? 'recipient_phone' THEN v_phone ELSE left(NULLIF(btrim(inv.bill_to_phone), ''), 50) END,
            CASE WHEN p ? 'delivery_address' THEN v_addr
                 ELSE left(NULLIF(concat_ws(E'\n', NULLIF(btrim(inv.bill_to_address), ''),
                                            NULLIF(concat_ws(' ', NULLIF(btrim(inv.bill_to_city), ''), NULLIF(btrim(inv.bill_to_postal_code), '')), '')), ''), 1000) END,
            v_note,
            (SELECT c.id FROM public.customers c WHERE c.id = auth.uid()),
            (SELECT c.id FROM public.customers c WHERE c.id = auth.uid()))
    RETURNING * INTO dn;
  ELSE
    UPDATE public.delivery_notes d
       SET delivered_on     = CASE WHEN p ? 'delivered_on' THEN v_date ELSE d.delivered_on END,
           recipient_name   = CASE WHEN p ? 'recipient_name' THEN v_name ELSE d.recipient_name END,
           recipient_phone  = CASE WHEN p ? 'recipient_phone' THEN v_phone ELSE d.recipient_phone END,
           delivery_address = CASE WHEN p ? 'delivery_address' THEN v_addr ELSE d.delivery_address END,
           note             = CASE WHEN p ? 'note' THEN v_note ELSE d.note END,
           updated_by       = (SELECT c.id FROM public.customers c WHERE c.id = auth.uid())
     WHERE d.id = dn.id
    RETURNING * INTO dn;
  END IF;
  RETURN to_jsonb(dn) || jsonb_build_object('created', NOT v_found);
END $$;
REVOKE ALL ON FUNCTION public.admin_save_delivery_note(INT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_delivery_note(INT, JSONB) TO authenticated;

-- The owner removes an invoice's delivery note (made by mistake). Its number is not used again.
CREATE OR REPLACE FUNCTION public.admin_delete_delivery_note(p_invoice_id INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  dn public.delivery_notes;
BEGIN
  IF NOT public.is_full_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only the owner can delete a delivery note.';
  END IF;
  DELETE FROM public.delivery_notes WHERE invoice_id = p_invoice_id RETURNING * INTO dn;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'delivery_note_not_found:This invoice has no delivery note.';
  END IF;
  RETURN jsonb_build_object('deleted_id', dn.id, 'number', dn.number, 'invoice_id', dn.invoice_id);
END $$;
REVOKE ALL ON FUNCTION public.admin_delete_delivery_note(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_delivery_note(INT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Staff map: delivery notes and dealer names belong to Invoices. Deleting a delivery note and
--    the commission report stay the owner's (not in the map = closed to staff).
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM public.staff_api_map WHERE migration = '57';
INSERT INTO public.staff_api_map (kind, name, area, view_level, edit_level, migration) VALUES
  ('table', 'delivery_notes',           'invoices', 'view', 'admin', '57'),
  ('rpc',   'admin_save_delivery_note', 'invoices', 'view', 'edit',  '57'),
  ('rpc',   'admin_dealer_names',       'invoices', 'view', 'view',  '57');

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 57_dealer_commission_delivery_notes
--   Run after 01–56 (it replaces 53's admin_save_document and admin_staff_commission_report — run
--   57 again after any re-run of 53, and so after 39, 40 or 44 too). Nothing changes on invoices
--   already made: no dealer, no delivery note. The first delivery note is DN-0001 (the invoice
--   number's digits); to start elsewhere:
--     UPDATE public.invoice_settings SET delivery_note_prefix = 'DN-', delivery_note_next_number = 1 WHERE id;
--   Verification:
--     SELECT count(*) FILTER (WHERE dealer_name IS NOT NULL), count(*) FROM public.invoices;      -- 0, all
--     SELECT delivery_note_prefix, delivery_note_next_number FROM public.invoice_settings;        -- DN- · 1
--     SELECT count(*) FROM public.delivery_notes;                                                 -- 0
--     SELECT count(*) FROM public.staff_api_map WHERE migration = '57';                           -- 3
-- ═════════════════════════════════════════════════════════════════════════════
