-- ═════════════════════════════════════════════════════════════════════════════
-- 53_invoice_extras.sql — Dock One Solutions
--
-- PURPOSE      What the client asked for (Website changes, November 2026 — 03 Invoices, quotations
--              and receipts):
--   SIGNATURE LINES   invoices.show_signature_lines — the "Signature lines" box on an invoice or a
--                     quotation prints two dotted lines, "Received in Good Order & Condition" and
--                     "Authorised Signature". New documents start from
--                     invoice_settings.default_show_signature_lines (Template & numbering).
--   PAID = FINAL      A finalised (issued) invoice marked PAID can be changed only by the owner:
--                     staff changes are refused by the database (triggers below), whatever screen
--                     or API they come from. Payments, receipts and the system's own bookkeeping
--                     (totals, the thank-you email flag, serials synced from a web order) still work.
--   BONUS             invoices.bonus — an internal amount under Invoice Details, never printed,
--                     added to the staff member's commission total. invoices.sales_staff_id — who
--                     the sale counts for (empty = whoever made the invoice). Both are the owner's
--                     to set.
--   COMMISSION        staff_accounts.commission_percent (owner sets it in admin → Staff) and
--                     admin_staff_commission_report(from, to) — owner only: per person, the issued
--                     invoices dated in the period, their sales (subtotal − discount, before VAT /
--                     tax), what is paid, commission = sales × the person's %, bonuses, total.
--                     Shop sales only (website orders' invoices count only when the owner names a
--                     sales staff on them).
--
-- REPLACES     admin_save_document (44 — start from 44's), admin_list_staff (39).
--              RE-RUN 53 AFTER ANY RE-RUN OF 39, 40 OR 44.
-- DEPENDS ON   26, 28, 40, 44 (invoices, documents), 39 (staff accounts, is_full_admin).
-- ERRORS       22023 invoice_locked:… (staff changing a paid invoice), invalid_invoice:…,
--              invoice_void:…; 42501 not_authorised:… (bonus / sales staff / commission by staff).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.invoice_settings ADD COLUMN IF NOT EXISTS default_show_signature_lines BOOLEAN NOT NULL DEFAULT FALSE;

-- What a new invoice / quotation starts from (the Template's default).
CREATE OR REPLACE FUNCTION public._invoice_signature_default() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT s.default_show_signature_lines FROM public.invoice_settings s WHERE s.id), FALSE)
$$;
REVOKE ALL ON FUNCTION public._invoice_signature_default() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS show_signature_lines BOOLEAN NOT NULL DEFAULT public._invoice_signature_default();
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS bonus          NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS sales_staff_id UUID REFERENCES public.customers (id) ON DELETE SET NULL;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_bonus_valid') THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_bonus_valid CHECK (bonus >= 0 AND bonus <= 100000000);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS invoices_sales_staff_idx ON public.invoices (sales_staff_id) WHERE sales_staff_id IS NOT NULL;

ALTER TABLE public.staff_accounts ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(5,2);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_accounts_commission_valid') THEN
    ALTER TABLE public.staff_accounts ADD CONSTRAINT staff_accounts_commission_valid
      CHECK (commission_percent IS NULL OR commission_percent BETWEEN 0 AND 100);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Paid = final: only the owner changes an issued invoice marked paid
-- ─────────────────────────────────────────────────────────────────────────────
-- Refused for a signed-in non-owner (staff) when the invoice is issued and paid:
--   invoices       any change except the bookkeeping the system does itself (totals, payment
--                  status, serial search text, stock flag, thank-you email time);
--   invoice_items  any added, removed or changed line.
-- Changes made by other triggers (pg_trigger_depth() > 1 — e.g. a serial number assigned to the
-- web order an invoice came from) and by the SQL editor / jobs (no signed-in user) pass.
CREATE OR REPLACE FUNCTION public._invoice_paid_lock() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_system CONSTANT TEXT[] := ARRAY['payment_status', 'subtotal', 'discount_amount', 'tax_amount', 'total',
    'amount_paid', 'balance_due', 'item_count', 'serial_search', 'stock_deducted', 'updated_at', 'thank_you_sent_at'];
  inv public.invoices;
BEGIN
  IF auth.uid() IS NULL OR pg_trigger_depth() > 1 OR public.is_full_admin() THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_TABLE_NAME = 'invoices' THEN
    IF OLD.doc_type = 'invoice' AND OLD.status = 'issued' AND OLD.payment_status = 'paid'
       AND (to_jsonb(NEW) - c_system) IS DISTINCT FROM (to_jsonb(OLD) - c_system) THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('invoice_locked:%s is paid, so it is final — only the owner can change it.', OLD.number);
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO inv FROM public.invoices
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
  IF FOUND AND inv.doc_type = 'invoice' AND inv.status = 'issued' AND inv.payment_status = 'paid'
     AND (TG_OP <> 'UPDATE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('invoice_locked:%s is paid, so it is final — only the owner can change it.', inv.number);
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION public._invoice_paid_lock() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoices_15_paid_lock ON public.invoices;
CREATE TRIGGER invoices_15_paid_lock BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._invoice_paid_lock();
DROP TRIGGER IF EXISTS invoice_items_15_paid_lock ON public.invoice_items;
CREATE TRIGGER invoice_items_15_paid_lock BEFORE INSERT OR UPDATE OR DELETE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public._invoice_paid_lock();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. admin_save_document — 44's, plus signature lines, bonus and sales staff
-- ─────────────────────────────────────────────────────────────────────────────
-- p_doc gains: show_signature_lines (true/false — invoices and quotations), bonus (rupees, ≥ 0)
-- and sales_staff_id (an owner or staff account; null = whoever made the invoice) — invoices only;
-- the last two are the owner's to change (42501 for staff).
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
                               'show_signature_lines', 'bonus', 'sales_staff_id'])) THEN
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
    OR (p_doc ? 'sales_staff_id' AND v_staff IS DISTINCT FROM cur.sales_staff_id)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is void and can no longer be changed.', cur.number);
  END IF;
  IF v_valid IS NOT NULL AND v_valid < cur.issue_date THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:“Valid until” can''t be before the quotation date.';
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Commission
-- ─────────────────────────────────────────────────────────────────────────────
-- 39's staff list, with each person's commission %.
CREATE OR REPLACE FUNCTION public.admin_list_staff()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out JSONB;
BEGIN
  PERFORM public._staff_require_admin();
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', s.user_id, 'email', c.email, 'name', s.display_name, 'permissions', s.permissions,
           'is_active', s.is_active, 'last_sign_in_at', u.last_sign_in_at, 'created_at', s.created_at,
           'commission_percent', s.commission_percent)
         ORDER BY s.is_active DESC, s.created_at DESC), '[]'::jsonb)
    INTO v_out
    FROM public.staff_accounts s
    JOIN public.customers c ON c.id = s.user_id
    LEFT JOIN auth.users u ON u.id = s.user_id;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_list_staff() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_staff() TO authenticated;

-- The owner sets a staff member's commission % (null = none).
CREATE OR REPLACE FUNCTION public.admin_set_staff_commission(p_user_id UUID, p_percent NUMERIC)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.staff_accounts;
BEGIN
  PERFORM public._staff_require_admin();
  IF p_percent IS NOT NULL AND NOT (p_percent >= 0 AND p_percent <= 100 AND p_percent = round(p_percent, 2)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_staff:Commission is a percentage from 0 to 100 (up to 2 decimals).';
  END IF;
  UPDATE public.staff_accounts SET commission_percent = p_percent, updated_by = auth.uid()
   WHERE user_id = p_user_id
  RETURNING * INTO s;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'staff_not_found:That staff account no longer exists.';
  END IF;
  RETURN jsonb_build_object('user_id', s.user_id, 'commission_percent', s.commission_percent);
END $$;
REVOKE ALL ON FUNCTION public.admin_set_staff_commission(UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_staff_commission(UUID, NUMERIC) TO authenticated;

-- Names of the people a sale can count for (the owner's accounts and every staff account) — for the
-- invoice screen. [{user_id, name, role: owner | staff, is_active}]
CREATE OR REPLACE FUNCTION public.admin_staff_names()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t see the staff list.';
  END IF;
  SELECT COALESCE(jsonb_agg(x.obj ORDER BY x.role_rank, x.active DESC, x.name), '[]'::jsonb) INTO v_out
    FROM (SELECT jsonb_build_object('user_id', c.id, 'role', 'owner', 'is_active', TRUE,
                   'name', COALESCE(NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email)) AS obj,
                 0 AS role_rank, TRUE AS active, COALESCE(NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email) AS name
            FROM public.customers c WHERE c.is_admin
          UNION ALL
          SELECT jsonb_build_object('user_id', s.user_id, 'role', 'staff', 'is_active', s.is_active, 'name', s.display_name),
                 1, s.is_active, s.display_name
            FROM public.staff_accounts s
           WHERE NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = s.user_id AND c.is_admin)) x;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_staff_names() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_staff_names() TO authenticated;

-- admin_staff_commission_report(from, to) — OWNER ONLY.
-- Issued invoices (not void, not quotations) dated from..to (Sri Lanka days, inclusive), counted for
-- COALESCE(sales_staff_id, created_by); website orders' invoices only when a sales staff is named.
-- {from, to, rows: [{user_id, name, role, commission_percent, invoices, sales, paid, commission,
--   bonus, total}], invoices: [{id, number, issue_date, client, user_id, sales, paid, payment_status,
--   bonus, commission}], totals: {invoices, sales, paid, commission, bonus, total}}
-- sales = subtotal − discount (before VAT / tax); commission = round(sales × % / 100, 2) per invoice.
CREATE OR REPLACE FUNCTION public.admin_staff_commission_report(p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out JSONB;
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
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_staff_commission_report(DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_staff_commission_report(DATE, DATE) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Staff map: the names list is part of Invoices / Quotations (view). Commission and the staff
--    list stay the owner's (not in the map = closed to staff).
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM public.staff_api_map WHERE migration = '53';
INSERT INTO public.staff_api_map (kind, name, area, view_level, edit_level, migration) VALUES
  ('rpc', 'admin_staff_names', 'invoices',   'view', 'view', '53'),
  ('rpc', 'admin_staff_names', 'quotations', 'view', 'view', '53'),
  ('rpc', 'admin_staff_names', 'receipts',   'view', 'view', '53');

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 53_invoice_extras
--   Run after 01–52 (it replaces 44's admin_save_document and 39's admin_list_staff — run 53 again
--   after any re-run of 39, 40 or 44). Then: Invoices → Template & numbering → "Print signature
--   lines on new documents" if the shop wants them by default; Staff → each person's Commission %.
--   Verification:
--     SELECT count(*) FILTER (WHERE show_signature_lines), count(*) FROM public.invoices;   -- 0, all
--     SELECT display_name, commission_percent FROM public.staff_accounts;
--     SELECT tgname FROM pg_trigger WHERE tgname LIKE '%paid_lock%';                         -- 2 rows
-- ═════════════════════════════════════════════════════════════════════════════
