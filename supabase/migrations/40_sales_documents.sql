-- ═════════════════════════════════════════════════════════════════════════════
-- 40_sales_documents.sql — Dock One Solutions
--
-- PURPOSE      Receipts, quotations, website-sale invoices and the sales report.
--
--   RECEIPTS     Every payment received is a RECEIPT with its own number (RCT-00001, never reused,
--                never deleted). invoice_payments (26) is the receipt register: it gains
--                receipt_number, payer, card receiving account, cheque number and a status
--                (valid | void + reason). A receipt may be recorded on its own (an advance) and
--                linked to an invoice later. An invoice's paid amount counts VALID receipts only.
--                Mistakes are voided by an ADMIN (with a reason), never deleted.
--   QUOTATIONS   invoices.doc_type = 'quotation': their own numbers (QT-0001), heading, terms and
--                validity date (valid_until); custom (non-inventory) lines allowed; no stock, no
--                payments. A valid, saved quotation is CONVERTED into a new draft invoice; any
--                custom line must first be matched to an inventory product BY AN ADMIN.
--                Website visitors can request one (request_quotation, via /api/quotation): it is
--                priced from the catalogue, numbered and viewable / printable through a private
--                link (get_public_quotation).
--   INVOICES     doc_type = 'invoice': every line must be an inventory product (variant) — custom
--                lines are refused when saving a draft or issuing. channel = 'store' | 'website'.
--                A web order gets its invoice automatically, in the SAME numbering (INV-…), when it
--                is handed over (out for delivery / shipped / delivered; pickup: collected), and
--                its payment becomes a receipt when the order is marked paid. Each issued line keeps
--                the item's cost at the time (unit_cost) for the sales report.
--   VOID / DRAFT An invoice with any valid receipt can't be voided (void the receipts first —
--                admins only). Moving an issued invoice back to draft voids the receipt taken at the
--                sale, and only an admin may do that.
--   REPORT       admin_sales_report(from, to, channel): invoiced sales (store / website / both),
--                cost of the items, how they were paid (cash, card + receiving account, bank
--                transfer, cheque + cheque numbers, credit outstanding) and every invoice in the
--                period incl. void ones with their reasons.
--
-- DEPENDS ON   26, 28 (invoices), 25 (units), 07/09 (orders), 38 (ledger), 39 (staff, staff_api_map).
-- REPLACES     26/28: _invoice_recalc, _invoice_sale_payment, admin_issue_invoice, admin_revert_invoice,
--              admin_void_invoice, admin_record_invoice_payment, admin_delete_invoice_payment,
--              admin_invoice_summary. Re-run 40 after re-running 26 or 28.
-- ERRORS       22023 custom_line, doc_type_locked, quotation_expired, quotation_converted,
--              needs_admin_match, receipt_*, invalid_receipt, invalid_quote_request …; 42501 not_authorised.
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Columns
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.invoice_settings ADD COLUMN IF NOT EXISTS quote_prefix        TEXT NOT NULL DEFAULT 'QT-';
ALTER TABLE public.invoice_settings ADD COLUMN IF NOT EXISTS quote_next_number   INT  NOT NULL DEFAULT 1;
ALTER TABLE public.invoice_settings ADD COLUMN IF NOT EXISTS quote_valid_days    INT  NOT NULL DEFAULT 14;
ALTER TABLE public.invoice_settings ADD COLUMN IF NOT EXISTS quote_notes         TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE public.invoice_settings ADD COLUMN IF NOT EXISTS receipt_prefix      TEXT NOT NULL DEFAULT 'RCT-';
ALTER TABLE public.invoice_settings ADD COLUMN IF NOT EXISTS receipt_digits      INT  NOT NULL DEFAULT 5;
ALTER TABLE public.invoice_settings ADD COLUMN IF NOT EXISTS receipt_next_number INT  NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_settings_docs_valid') THEN
    ALTER TABLE public.invoice_settings ADD CONSTRAINT invoice_settings_docs_valid CHECK (
          char_length(quote_prefix) <= 12 AND quote_prefix ~ '^[A-Za-z0-9/#._-]*$'
      AND char_length(receipt_prefix) <= 12 AND receipt_prefix ~ '^[A-Za-z0-9/#._-]*$'
      AND quote_next_number BETWEEN 1 AND 999999999 AND receipt_next_number BETWEEN 1 AND 999999999
      AND receipt_digits BETWEEN 1 AND 10 AND quote_valid_days BETWEEN 1 AND 365
      AND cardinality(quote_notes) <= 20 AND array_position(quote_notes, NULL) IS NULL);
  END IF;
END $$;
-- Quotation terms, once (editable in admin → Invoices → Template & numbering).
UPDATE public.invoice_settings
   SET quote_notes = ARRAY[
         'This quotation is valid until the date shown above.',
         'Prices are in Sri Lankan Rupees (LKR) and may change after the validity date.',
         'Availability is confirmed when the order is placed. Items not in stock are sourced on order.',
         'To accept this quotation, contact us quoting the quotation number.']
 WHERE id AND cardinality(quote_notes) = 0
   AND NOT EXISTS (SELECT 1 FROM public.app_config WHERE name = 'docs_40_quote_notes');
INSERT INTO public.app_config (name, value) VALUES ('docs_40_quote_notes', 'set') ON CONFLICT (name) DO NOTHING;

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS doc_type             TEXT NOT NULL DEFAULT 'invoice';
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS channel              TEXT NOT NULL DEFAULT 'store';
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS valid_until          DATE;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS bill_to_company      TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS request_note         TEXT;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS quotation_id         INT REFERENCES public.invoices (id) ON DELETE SET NULL;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS converted_invoice_id INT REFERENCES public.invoices (id) ON DELETE SET NULL;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS converted_at         TIMESTAMPTZ;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS view_token           UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS thank_you_sent_at    TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_doc_type_valid') THEN
    ALTER TABLE public.invoices ADD CONSTRAINT invoices_doc_type_valid CHECK (
          doc_type IN ('invoice', 'quotation') AND channel IN ('store', 'website')
      AND (doc_type = 'invoice' OR (stock_deducted = FALSE AND sale_type IS NULL))
      AND (valid_until IS NULL OR valid_until >= issue_date)
      AND (bill_to_company IS NULL OR char_length(bill_to_company) <= 200)
      AND (request_note IS NULL OR char_length(request_note) <= 1000));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS invoices_doc_idx ON public.invoices (doc_type, issue_date DESC, id DESC);

ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(12,2);   -- cost when issued (sales report)

-- invoice_payments = the receipt register
ALTER TABLE public.invoice_payments ALTER COLUMN invoice_id DROP NOT NULL;
ALTER TABLE public.invoice_payments ADD COLUMN IF NOT EXISTS receipt_number TEXT;
ALTER TABLE public.invoice_payments ADD COLUMN IF NOT EXISTS payer_name     TEXT;
ALTER TABLE public.invoice_payments ADD COLUMN IF NOT EXISTS card_account   TEXT;     -- card: the account / terminal it was received into
ALTER TABLE public.invoice_payments ADD COLUMN IF NOT EXISTS cheque_number  TEXT;
ALTER TABLE public.invoice_payments ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'valid';
ALTER TABLE public.invoice_payments ADD COLUMN IF NOT EXISTS voided_at      TIMESTAMPTZ;
ALTER TABLE public.invoice_payments ADD COLUMN IF NOT EXISTS voided_by      UUID REFERENCES public.customers (id) ON DELETE SET NULL;
ALTER TABLE public.invoice_payments ADD COLUMN IF NOT EXISTS void_reason    TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_payments_receipt_valid') THEN
    ALTER TABLE public.invoice_payments ADD CONSTRAINT invoice_payments_receipt_valid CHECK (
          status IN ('valid', 'void')
      AND (status = 'valid' OR (voided_at IS NOT NULL AND void_reason IS NOT NULL))
      AND (payer_name    IS NULL OR char_length(payer_name)    <= 200)
      AND (card_account  IS NULL OR char_length(card_account)  <= 120)
      AND (cheque_number IS NULL OR char_length(cheque_number) <= 60)
      AND (void_reason   IS NULL OR char_length(void_reason)   <= 500));
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS invoice_payments_receipt_key ON public.invoice_payments (receipt_number) WHERE receipt_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoice_payments_unallocated_idx ON public.invoice_payments (paid_on DESC, id DESC) WHERE invoice_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Numbering
-- ─────────────────────────────────────────────────────────────────────────────
-- The next free number for an invoice or a quotation (locks the settings row; gapless because it
-- is taken inside the issuing transaction).
CREATE OR REPLACE FUNCTION public._document_take_number(p_doc_type TEXT)
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
  v_n := CASE WHEN p_doc_type = 'quotation' THEN s.quote_next_number ELSE s.next_number END;
  LOOP
    v_number := public._invoice_number(CASE WHEN p_doc_type = 'quotation' THEN s.quote_prefix ELSE s.number_prefix END, v_n, s.number_digits);
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.invoices x WHERE x.number = v_number);
    v_n := v_n + 1;
  END LOOP;
  IF p_doc_type = 'quotation' THEN
    UPDATE public.invoice_settings SET quote_next_number = v_n + 1 WHERE id;
  ELSE
    UPDATE public.invoice_settings SET next_number = v_n + 1 WHERE id;
  END IF;
  RETURN v_number;
END $$;
REVOKE ALL ON FUNCTION public._document_take_number(TEXT) FROM PUBLIC, anon, authenticated;

-- Every receipt gets the next receipt number (existing payments are numbered once, oldest first).
CREATE OR REPLACE FUNCTION public._receipt_number() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s      public.invoice_settings;
  v_n    INT;
  v_num  TEXT;
BEGIN
  IF NEW.receipt_number IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO s FROM public.invoice_settings WHERE id FOR UPDATE;
  v_n := COALESCE(s.receipt_next_number, 1);
  LOOP
    v_num := public._invoice_number(COALESCE(s.receipt_prefix, 'RCT-'), v_n, COALESCE(s.receipt_digits, 5));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.receipt_number = v_num);
    v_n := v_n + 1;
  END LOOP;
  UPDATE public.invoice_settings SET receipt_next_number = v_n + 1 WHERE id;
  NEW.receipt_number := v_num;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._receipt_number() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoice_payments_10_receipt_number ON public.invoice_payments;
CREATE TRIGGER invoice_payments_10_receipt_number BEFORE INSERT ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public._receipt_number();
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id FROM public.invoice_payments WHERE receipt_number IS NULL ORDER BY created_at, id LOOP
    UPDATE public.invoice_payments p
       SET receipt_number = (SELECT public._invoice_number(s.receipt_prefix, s.receipt_next_number, s.receipt_digits) FROM public.invoice_settings s WHERE s.id)
     WHERE p.id = r.id;
    UPDATE public.invoice_settings SET receipt_next_number = receipt_next_number + 1 WHERE id;
  END LOOP;
END $$;

-- A web order's invoice is a website sale; so is any invoice made from one.
CREATE OR REPLACE FUNCTION public._invoice_channel() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.order_id IS NOT NULL THEN
    NEW.channel := 'website';
  END IF;
  IF NEW.doc_type = 'quotation' THEN
    NEW.deduct_stock := FALSE;
    NEW.sale_type := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._invoice_channel() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoices_05_channel ON public.invoices;
CREATE TRIGGER invoices_05_channel BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._invoice_channel();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Replaced 26 / 28 internals
-- ─────────────────────────────────────────────────────────────────────────────
-- Valid receipts only; a quotation owes nothing (it is not a sale).
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
    FROM public.invoice_payments pay WHERE pay.invoice_id = p_invoice_id AND pay.status = 'valid';
  v_disc := CASE WHEN inv.discount_type = 'percent' THEN round(v_sub * inv.discount_value / 100, 2)
                 ELSE LEAST(inv.discount_value, v_sub) END;
  v_tax := CASE WHEN inv.tax_type = 'percent' THEN round((v_sub - v_disc) * inv.tax_value / 100, 2)
                ELSE inv.tax_value END;
  v_total := v_sub - v_disc + v_tax;
  v_bal := CASE WHEN inv.doc_type = 'quotation' THEN 0 ELSE GREATEST(v_total - v_paid, 0) END;
  UPDATE public.invoices
     SET subtotal = v_sub, discount_amount = v_disc, tax_amount = v_tax, total = v_total,
         amount_paid = v_paid, balance_due = v_bal, item_count = v_count, serial_search = btrim(v_sns),
         payment_status = CASE WHEN inv.doc_type = 'quotation' THEN 'unpaid'
                               WHEN inv.status = 'issued' AND v_bal = 0 THEN 'paid'
                               WHEN v_paid > 0 THEN 'partial'
                               ELSE 'unpaid' END
   WHERE id = p_invoice_id;
END $$;
REVOKE ALL ON FUNCTION public._invoice_recalc(INT) FROM PUBLIC, anon, authenticated;

-- 28's: the payment taken at the sale becomes a receipt. Never for a quotation; earlier sale
-- receipts are voided by back-to-draft, never deleted.
CREATE OR REPLACE FUNCTION public._invoice_sale_payment() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_today  DATE := (now() AT TIME ZONE 'Asia/Colombo')::DATE;
  v_amount NUMERIC := CASE WHEN NEW.sale_type = 'credit' THEN NEW.upfront_amount ELSE NEW.total END;
  v_method TEXT := CASE NEW.sale_type WHEN 'cash' THEN 'cash' WHEN 'card' THEN 'card' ELSE NEW.upfront_method END;
BEGIN
  IF NEW.sale_type IS NULL OR NEW.doc_type <> 'invoice' THEN
    RETURN NULL;
  END IF;
  IF v_amount > 0 AND NOT EXISTS (SELECT 1 FROM public.invoice_payments p
                                   WHERE p.invoice_id = NEW.id AND p.source = 'sale' AND p.status = 'valid') THEN
    INSERT INTO public.invoice_payments (invoice_id, amount, paid_on, method, note, source, payer_name, created_by)
    VALUES (NEW.id, v_amount, LEAST(NEW.issue_date, v_today), v_method,
            CASE NEW.sale_type
              WHEN 'credit' THEN format('Paid at the sale — balance on credit, due %s', to_char(NEW.due_date, 'DD Mon YYYY'))
              ELSE 'Paid in full at the sale' END,
            'sale', NEW.bill_to_name, (SELECT c.id FROM public.customers c WHERE c.id = auth.uid()));
  END IF;
  PERFORM public._invoice_recalc(NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._invoice_sale_payment() FROM PUBLIC, anon, authenticated;

-- Which section a document belongs to (staff permissions).
CREATE OR REPLACE FUNCTION public._doc_area(p_doc_type TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_doc_type = 'quotation' THEN 'quotations' ELSE 'invoices' END
$$;
REVOKE ALL ON FUNCTION public._doc_area(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._doc_label(p_inv public.invoices) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT COALESCE(p_inv.number, CASE WHEN p_inv.doc_type = 'quotation' THEN 'This quotation' ELSE 'This invoice' END)
$$;
REVOKE ALL ON FUNCTION public._doc_label(public.invoices) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Lifecycle (replaces 26 / 28)
-- ─────────────────────────────────────────────────────────────────────────────
-- Draft → issued. Invoices: inventory lines only, stock, serials, the item costs, INV- number.
-- Quotations: QT- number and a validity date; nothing else moves.
CREATE OR REPLACE FUNCTION public.admin_issue_invoice(p_invoice_id INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv      public.invoices;
  s        public.invoice_settings;
  v_number TEXT;
  r        RECORD;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin or staff can issue invoices.';
  END IF;
  SELECT * INTO inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invoice_not_found:This invoice no longer exists — it may have been deleted in another tab.';
  END IF;
  IF current_setting('request.path', true) IS NOT NULL AND current_setting('request.path', true) <> ''
     AND NOT public.staff_can(public._doc_area(inv.doc_type), 'edit') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t issue this kind of document.';
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

  IF inv.doc_type = 'invoice' THEN
    SELECT it.position, it.description INTO r FROM public.invoice_items it
     WHERE it.invoice_id = inv.id AND it.variant_id IS NULL ORDER BY it.position LIMIT 1;
    IF FOUND AND inv.order_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('custom_line:Line %s (“%s”) is not an inventory product. Invoices can only contain products from the inventory — pick the product and variant, or make a quotation instead.',
                         r.position + 1, left(r.description, 60));
    END IF;
    IF inv.deduct_stock THEN
      PERFORM public._invoice_take_stock(inv.id);
    END IF;
    PERFORM public._invoice_link_units(inv.id);
    UPDATE public.invoice_items it
       SET unit_cost = pc.cost_price
      FROM public.product_costs pc
     WHERE it.invoice_id = inv.id AND it.variant_id = pc.variant_id AND it.unit_cost IS NULL;
  END IF;

  IF inv.number IS NULL THEN
    v_number := public._document_take_number(inv.doc_type);
  END IF;
  SELECT * INTO s FROM public.invoice_settings WHERE id;
  UPDATE public.invoices
     SET status = 'issued',
         number = COALESCE(number, v_number),
         issued_at = COALESCE(issued_at, now()),
         valid_until = CASE WHEN doc_type = 'quotation'
                            THEN COALESCE(valid_until, issue_date + COALESCE(s.quote_valid_days, 14)) END
   WHERE id = inv.id;
  PERFORM public._invoice_recalc(inv.id);
  RETURN public._invoice_json(inv.id);
END $$;
REVOKE ALL ON FUNCTION public.admin_issue_invoice(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_issue_invoice(INT) TO authenticated;

-- Issued → draft. Refused while a receipt recorded after the sale is valid. The receipt taken at
-- the sale is voided (kept, with its number) — and only an admin may do that.
CREATE OR REPLACE FUNCTION public.admin_revert_invoice(p_invoice_id INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv      public.invoices;
  v_manual INT;
  v_sale   INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin or staff can change invoices.';
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
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invoice_not_issued:This is already a draft.';
  END IF;
  IF inv.doc_type = 'quotation' AND inv.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('quotation_converted:%s was converted into an invoice, so it stays as it is.', inv.number);
  END IF;
  SELECT count(*) FILTER (WHERE pay.source = 'manual')::INT, count(*) FILTER (WHERE pay.source = 'sale')::INT
    INTO v_manual, v_sale
    FROM public.invoice_payments pay WHERE pay.invoice_id = inv.id AND pay.status = 'valid';
  IF v_manual > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('invoice_has_payments:%s has %s receipt%s recorded after the sale. An admin must void %s (Receipts) before it can go back to draft.',
                       inv.number, v_manual, CASE WHEN v_manual = 1 THEN '' ELSE 's' END, CASE WHEN v_manual = 1 THEN 'it' ELSE 'them' END);
  END IF;
  IF v_sale > 0 AND NOT public.is_full_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = format('not_authorised:%s has a payment recorded, so only an admin can move it back to draft.', inv.number);
  END IF;
  UPDATE public.invoice_payments
     SET status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = 'Invoice moved back to draft'
   WHERE invoice_id = inv.id AND source = 'sale' AND status = 'valid';
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

-- Void (kept on record with its number and the reason). Refused while ANY valid receipt is linked.
CREATE OR REPLACE FUNCTION public.admin_void_invoice(p_invoice_id INT, p_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv      public.invoices;
  v_np     INT;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, ''), E' \t\r\n'), '');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin or staff can void documents.';
  END IF;
  SELECT * INTO inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invoice_not_found:This invoice no longer exists — it may have been deleted in another tab.';
  END IF;
  IF current_setting('request.path', true) IS NOT NULL AND current_setting('request.path', true) <> ''
     AND NOT public.staff_can(public._doc_area(inv.doc_type), 'edit') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t void this kind of document.';
  END IF;
  IF inv.status = 'void' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is already void.', inv.number);
  END IF;
  IF inv.number IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invoice_not_issued:This draft was never issued, so there is nothing to void.';
  END IF;
  SELECT count(*)::INT INTO v_np FROM public.invoice_payments pay WHERE pay.invoice_id = inv.id AND pay.status = 'valid';
  IF v_np > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('invoice_has_payments:%s has %s payment%s (receipt%s) linked, so it can''t be voided. An admin must void the receipt%s first.',
                       inv.number, v_np, CASE WHEN v_np = 1 THEN '' ELSE 's' END, CASE WHEN v_np = 1 THEN '' ELSE 's' END, CASE WHEN v_np = 1 THEN '' ELSE 's' END);
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:Give the reason for voiding — it stays on record.';
  END IF;
  IF char_length(v_reason) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:The reason can be at most 500 characters.';
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Receipts
-- ─────────────────────────────────────────────────────────────────────────────
-- p_receipt: {invoice_id?, amount, paid_on, method (cash | card | cheque | bank_transfer),
--             card_account (card), cheque_number (cheque), reference, payer_name, note}
-- Returns {receipt: {…}, invoice: _invoice_json() or null}.
CREATE OR REPLACE FUNCTION public.admin_record_receipt(p_receipt JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_keys    CONSTANT TEXT[] := ARRAY['invoice_id', 'amount', 'paid_on', 'method', 'card_account', 'cheque_number',
                                     'reference', 'payer_name', 'note'];
  c_r       CONSTANT TEXT := 'invalid_receipt';
  v_key     TEXT;
  v_inv_id  INT;
  inv       public.invoices;
  v_amount  NUMERIC;
  v_paid_on DATE;
  v_method  TEXT;
  v_card    TEXT;
  v_cheque  TEXT;
  v_ref     TEXT;
  v_payer   TEXT;
  v_note    TEXT;
  v_id      INT;
BEGIN
  IF NOT public.is_admin() OR NOT (public.staff_can('receipts', 'edit') OR public.staff_can('invoices', 'edit')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t record receipts.';
  END IF;
  IF p_receipt IS NULL OR jsonb_typeof(p_receipt) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_receipt:The receipt must be a JSON object.';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_receipt) LOOP
    IF NOT (v_key = ANY (c_keys)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_receipt:The field “%s” can''t be saved here.', left(v_key, 40));
    END IF;
  END LOOP;
  v_inv_id  := public._admin_json_int(c_r, p_receipt -> 'invoice_id', 'The invoice', 1, 2147483647);
  v_amount  := public._admin_json_money(c_r, p_receipt -> 'amount', 'The amount');
  v_paid_on := public._invoice_json_date(c_r, p_receipt -> 'paid_on', 'The date received');
  v_method  := lower(COALESCE(public._admin_json_text(c_r, p_receipt -> 'method', 'The payment method', 20), ''));
  v_card    := public._admin_json_text(c_r, p_receipt -> 'card_account', 'The receiving account', 120);
  v_cheque  := public._admin_json_text(c_r, p_receipt -> 'cheque_number', 'The cheque number', 60);
  v_ref     := public._admin_json_text(c_r, p_receipt -> 'reference', 'The reference', 120);
  v_payer   := public._admin_json_text(c_r, p_receipt -> 'payer_name', 'Received from', 200);
  v_note    := public._admin_json_text(c_r, p_receipt -> 'note', 'The note', 500);
  v_paid_on := COALESCE(v_paid_on, (now() AT TIME ZONE 'Asia/Colombo')::DATE);

  IF v_amount IS NULL OR v_amount <= 0 OR v_amount > 1000000000000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_receipt:Enter the amount received, in rupees (above 0).';
  END IF;
  IF v_paid_on < DATE '2000-01-01' OR v_paid_on > (now() AT TIME ZONE 'Asia/Colombo')::DATE THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_receipt:The date received can''t be in the future.';
  END IF;
  IF v_method NOT IN ('cash', 'card', 'cheque', 'bank_transfer') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_receipt:Choose how it was paid: cash, card, cheque or bank transfer.';
  END IF;
  IF v_method = 'card' AND v_card IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_receipt:For a card payment, enter the account (or terminal) it was received into.';
  END IF;
  IF v_method = 'cheque' AND v_cheque IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_receipt:For a cheque, enter the cheque number.';
  END IF;
  IF v_method <> 'card' THEN v_card := NULL; END IF;
  IF v_method <> 'cheque' THEN v_cheque := NULL; END IF;

  IF v_inv_id IS NOT NULL THEN
    SELECT * INTO inv FROM public.invoices WHERE id = v_inv_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invoice_not_found:That invoice no longer exists.';
    END IF;
    IF inv.doc_type <> 'invoice' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_receipt:A quotation can''t take payments — convert it into an invoice first.';
    END IF;
    IF inv.status = 'void' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is void — it can''t take payments.', inv.number);
    END IF;
    IF inv.status = 'draft' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invoice_not_issued:Issue the invoice before recording a payment.';
    END IF;
    IF inv.balance_due <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('overpayment:%s is already paid in full.', inv.number);
    END IF;
    IF v_amount > inv.balance_due THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('overpayment:The balance due on %s is %s — a payment can''t be more than that.', inv.number, public._invoice_rs(inv.balance_due));
    END IF;
  END IF;

  INSERT INTO public.invoice_payments (invoice_id, amount, paid_on, method, reference, note, source,
                                       payer_name, card_account, cheque_number, created_by)
  VALUES (v_inv_id, v_amount, v_paid_on, v_method, v_ref, v_note, 'manual',
          COALESCE(v_payer, inv.bill_to_name), v_card, v_cheque,
          (SELECT c.id FROM public.customers c WHERE c.id = auth.uid()))
  RETURNING id INTO v_id;
  IF v_inv_id IS NOT NULL THEN
    PERFORM public._invoice_recalc(v_inv_id);
  END IF;
  RETURN jsonb_build_object('receipt', (SELECT to_jsonb(p) FROM public.invoice_payments p WHERE p.id = v_id),
                            'invoice', CASE WHEN v_inv_id IS NOT NULL THEN public._invoice_json(v_inv_id) END);
END $$;
REVOKE ALL ON FUNCTION public.admin_record_receipt(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_record_receipt(JSONB) TO authenticated;

-- 26's signature, kept for older screens: records a receipt against the invoice.
CREATE OR REPLACE FUNCTION public.admin_record_invoice_payment(p_invoice_id INT, p_amount NUMERIC, p_paid_on DATE,
                                                               p_method TEXT, p_reference TEXT DEFAULT NULL,
                                                               p_note TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_method TEXT := lower(btrim(COALESCE(p_method, '')));
BEGIN
  RETURN public.admin_record_receipt(jsonb_strip_nulls(jsonb_build_object(
           'invoice_id', p_invoice_id, 'amount', p_amount, 'paid_on', p_paid_on, 'method', v_method,
           'reference', p_reference, 'note', p_note,
           'card_account', CASE WHEN v_method = 'card' THEN COALESCE(NULLIF(btrim(COALESCE(p_reference, '')), ''), 'Not recorded') END,
           'cheque_number', CASE WHEN v_method = 'cheque' THEN COALESCE(NULLIF(btrim(COALESCE(p_reference, '')), ''), 'Not recorded') END))) -> 'invoice';
END $$;
REVOKE ALL ON FUNCTION public.admin_record_invoice_payment(INT, NUMERIC, DATE, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_record_invoice_payment(INT, NUMERIC, DATE, TEXT, TEXT, TEXT) TO authenticated;

-- Link an unallocated receipt (an advance) to an issued invoice.
CREATE OR REPLACE FUNCTION public.admin_allocate_receipt(p_receipt_id INT, p_invoice_id INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv public.invoices;
  rc  public.invoice_payments;
BEGIN
  IF NOT public.is_admin() OR NOT (public.staff_can('receipts', 'edit') OR public.staff_can('invoices', 'edit')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t link receipts.';
  END IF;
  SELECT * INTO inv FROM public.invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND OR inv.doc_type <> 'invoice' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invoice_not_found:That invoice no longer exists.';
  END IF;
  SELECT * INTO rc FROM public.invoice_payments WHERE id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'receipt_not_found:That receipt no longer exists.';
  END IF;
  IF rc.status <> 'valid' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('receipt_void:%s is void.', rc.receipt_number);
  END IF;
  IF rc.invoice_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('receipt_linked:%s is already linked to an invoice.', rc.receipt_number);
  END IF;
  IF inv.status <> 'issued' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invoice_not_issued:Only an issued invoice can take payments.';
  END IF;
  IF rc.amount > inv.balance_due THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('overpayment:%s is %s but the balance due on %s is %s.', rc.receipt_number, public._invoice_rs(rc.amount),
                       inv.number, public._invoice_rs(inv.balance_due));
  END IF;
  UPDATE public.invoice_payments SET invoice_id = inv.id, payer_name = COALESCE(payer_name, inv.bill_to_name) WHERE id = rc.id;
  PERFORM public._invoice_recalc(inv.id);
  RETURN public._invoice_json(inv.id);
END $$;
REVOKE ALL ON FUNCTION public.admin_allocate_receipt(INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_allocate_receipt(INT, INT) TO authenticated;

-- ADMIN ONLY: void a receipt (kept with its number; the invoice's balance comes back).
CREATE OR REPLACE FUNCTION public.admin_void_receipt(p_receipt_id INT, p_reason TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  rc       public.invoice_payments;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, ''), E' \t\r\n'), '');
BEGIN
  IF NOT public.is_full_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can void a receipt.';
  END IF;
  IF v_reason IS NULL OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_receipt:Give the reason for voiding (up to 500 characters).';
  END IF;
  SELECT * INTO rc FROM public.invoice_payments WHERE id = p_receipt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'receipt_not_found:That receipt no longer exists.';
  END IF;
  IF rc.invoice_id IS NOT NULL THEN
    PERFORM 1 FROM public.invoices WHERE id = rc.invoice_id FOR UPDATE;      -- invoice first, like every writer
  END IF;
  UPDATE public.invoice_payments
     SET status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = v_reason
   WHERE id = rc.id AND status = 'valid';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('receipt_void:%s is already void.', rc.receipt_number);
  END IF;
  IF rc.invoice_id IS NOT NULL THEN
    PERFORM public._invoice_recalc(rc.invoice_id);
  END IF;
  RETURN jsonb_build_object('receipt', (SELECT to_jsonb(p) FROM public.invoice_payments p WHERE p.id = rc.id),
                            'invoice', CASE WHEN rc.invoice_id IS NOT NULL THEN public._invoice_json(rc.invoice_id) END);
END $$;
REVOKE ALL ON FUNCTION public.admin_void_receipt(INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_void_receipt(INT, TEXT) TO authenticated;

-- 26's "delete payment" now voids the receipt (admins only) — receipts are never deleted.
CREATE OR REPLACE FUNCTION public.admin_delete_invoice_payment(p_payment_id INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out JSONB;
BEGIN
  v_out := public.admin_void_receipt(p_payment_id, 'Removed by an admin');
  RETURN COALESCE(v_out -> 'invoice', v_out);
END $$;
REVOKE ALL ON FUNCTION public.admin_delete_invoice_payment(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_invoice_payment(INT) TO authenticated;

-- Receipts received in a period (Sri Lanka days): totals by method; void ones counted apart.
CREATE OR REPLACE FUNCTION public.admin_receipts_summary(p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t see receipts.';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_range:Choose a start date on or before the end date.';
  END IF;
  SELECT jsonb_build_object(
           'total', COALESCE(sum(p.amount) FILTER (WHERE p.status = 'valid'), 0),
           'count', count(*) FILTER (WHERE p.status = 'valid'),
           'void_count', count(*) FILTER (WHERE p.status = 'void'),
           'unallocated_total', COALESCE(sum(p.amount) FILTER (WHERE p.status = 'valid' AND p.invoice_id IS NULL), 0),
           'by_method', COALESCE((SELECT jsonb_agg(jsonb_build_object('method', m.method, 'total', m.total, 'count', m.n) ORDER BY m.total DESC)
                                    FROM (SELECT x.method, sum(x.amount) AS total, count(*) AS n FROM public.invoice_payments x
                                           WHERE x.status = 'valid' AND x.paid_on BETWEEN p_from AND p_to GROUP BY x.method) m), '[]'::jsonb))
    INTO v_out
    FROM public.invoice_payments p
   WHERE p.paid_on BETWEEN p_from AND p_to;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_receipts_summary(DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_receipts_summary(DATE, DATE) TO authenticated;

-- 26's headline figures: invoices only, valid receipts only.
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
                                   WHERE pay.status = 'valid' AND pay.paid_on > v_today - 30))
    INTO v_out
    FROM public.invoices i
   WHERE i.doc_type = 'invoice';
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_invoice_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_invoice_summary() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Saving a document (the editor's call): invoice or quotation
-- ─────────────────────────────────────────────────────────────────────────────
-- p_doc: {doc_type: 'invoice' | 'quotation', valid_until, bill_to_company} (all optional).
-- A draft may switch type. A NUMBERED quotation is turned into an invoice with
-- admin_convert_quotation, never by switching. An invoice's lines must all be inventory products.
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
    IF NOT (v_key = ANY (ARRAY['doc_type', 'valid_until', 'bill_to_company'])) THEN
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
     AND NOT (v_found AND cur.order_id IS NOT NULL AND cur.channel = 'website' AND cur.created_by IS NULL) THEN
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

  IF v_type = 'quotation' THEN
    v_saved := public.admin_save_invoice(
      CASE WHEN p_invoice ? 'deduct_stock' THEN p_invoice - 'deduct_stock' ELSE p_invoice END, p_items);
  ELSE
    v_saved := public.admin_save_invoice_sale(p_invoice, p_items, p_sale);
  END IF;
  v_id := (v_saved -> 'invoice' ->> 'id')::INT;
  SELECT * INTO cur FROM public.invoices WHERE id = v_id;
  IF v_valid IS NOT NULL AND v_valid < cur.issue_date THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_invoice:“Valid until” can''t be before the quotation date.';
  END IF;
  -- switching a draft's type swaps the default terms (only while they are still the defaults)
  UPDATE public.invoices i
     SET doc_type        = v_type,
         valid_until     = CASE WHEN v_type = 'quotation'
                                THEN CASE WHEN p_doc ? 'valid_until' THEN v_valid ELSE i.valid_until END END,
         bill_to_company = CASE WHEN p_doc ? 'bill_to_company' THEN v_comp ELSE i.bill_to_company END,
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

-- A saved, still-valid quotation → a NEW draft invoice (the quotation stays, linked to it).
-- p_matches: {"<line id>": <variant id>} for every custom line — only an admin may match them.
CREATE OR REPLACE FUNCTION public.admin_convert_quotation(p_quote_id INT, p_matches JSONB DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  q        public.invoices;
  s        public.invoice_settings;
  v_today  DATE := (now() AT TIME ZONE 'Asia/Colombo')::DATE;
  v_new    INT;
  r        RECORD;
  v_vid    INT;
  v_pid    INT;
  v_custom INT;
BEGIN
  IF NOT public.is_admin() OR NOT public.staff_can('invoices', 'edit') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t create invoices.';
  END IF;
  SELECT * INTO q FROM public.invoices WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND OR q.doc_type <> 'quotation' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invoice_not_found:That quotation no longer exists.';
  END IF;
  IF q.status = 'void' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is void.', q.number);
  END IF;
  IF q.converted_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('quotation_converted:%s was already converted into %s.', COALESCE(q.number, 'This quotation'),
                       COALESCE((SELECT x.number FROM public.invoices x WHERE x.id = q.converted_invoice_id), 'a draft invoice'));
  END IF;
  SELECT * INTO s FROM public.invoice_settings WHERE id;
  IF COALESCE(q.valid_until, q.issue_date + COALESCE(s.quote_valid_days, 14)) < v_today THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('quotation_expired:%s expired on %s. Make a new quotation (or extend its validity) before converting it.',
                       COALESCE(q.number, 'This quotation'), to_char(COALESCE(q.valid_until, q.issue_date + COALESCE(s.quote_valid_days, 14)), 'DD Mon YYYY'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.invoice_items it WHERE it.invoice_id = q.id) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invoice_incomplete:The quotation has no lines.';
  END IF;
  SELECT count(*)::INT INTO v_custom FROM public.invoice_items it WHERE it.invoice_id = q.id AND it.variant_id IS NULL;
  IF v_custom > 0 THEN
    IF NOT public.is_full_admin() THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = format('needs_admin_match:%s has %s line%s that %s not in the inventory. An admin must match %s to inventory products before it can be converted.',
                         COALESCE(q.number, 'This quotation'), v_custom, CASE WHEN v_custom = 1 THEN '' ELSE 's' END,
                         CASE WHEN v_custom = 1 THEN 'is' ELSE 'are' END, CASE WHEN v_custom = 1 THEN 'it' ELSE 'them' END);
    END IF;
    IF p_matches IS NULL OR jsonb_typeof(p_matches) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'needs_admin_match:Match every custom line to an inventory product.';
    END IF;
  END IF;

  INSERT INTO public.invoices (doc_type, channel, issue_date, reference, order_id, customer_id, quotation_id,
                               bill_to_name, bill_to_company, bill_to_address, bill_to_city, bill_to_postal_code,
                               bill_to_phone, bill_to_email, payment_terms, notes, show_bank_details,
                               discount_type, discount_value, tax_type, tax_value, deduct_stock, sale_type, created_by)
  VALUES ('invoice', q.channel, v_today, q.number, q.order_id, q.customer_id, q.id,
          q.bill_to_name, q.bill_to_company, q.bill_to_address, q.bill_to_city, q.bill_to_postal_code,
          q.bill_to_phone, q.bill_to_email, q.payment_terms, COALESCE(s.default_notes, '{}'::TEXT[]), q.show_bank_details,
          q.discount_type, q.discount_value, q.tax_type, q.tax_value, COALESCE(s.default_deduct_stock, TRUE), 'cash',
          (SELECT c.id FROM public.customers c WHERE c.id = auth.uid()))
  RETURNING id INTO v_new;

  FOR r IN SELECT * FROM public.invoice_items it WHERE it.invoice_id = q.id ORDER BY it.position, it.id LOOP
    v_vid := r.variant_id;
    v_pid := r.product_id;
    IF v_vid IS NULL THEN
      v_vid := CASE WHEN jsonb_typeof(p_matches -> r.id::text) = 'number' THEN (p_matches ->> r.id::text)::INT END;
      SELECT pv.product_id INTO v_pid FROM public.product_variants pv WHERE pv.id = v_vid;
      IF v_vid IS NULL OR v_pid IS NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = format('needs_admin_match:Line %s (“%s”) needs an inventory product.', r.position + 1, left(r.description, 60));
      END IF;
    END IF;
    INSERT INTO public.invoice_items (invoice_id, position, product_id, variant_id, description, serial_numbers, warranty, quantity, unit_price, amount)
    VALUES (v_new, r.position, v_pid, v_vid, r.description, '{}', r.warranty, r.quantity, r.unit_price, r.amount);
  END LOOP;

  UPDATE public.invoices SET converted_invoice_id = v_new, converted_at = now() WHERE id = q.id;
  PERFORM public._invoice_recalc(v_new);
  RETURN public._invoice_json(v_new) || jsonb_build_object('created', TRUE, 'quotation_id', q.id);
END $$;
REVOKE ALL ON FUNCTION public.admin_convert_quotation(INT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_convert_quotation(INT, JSONB) TO authenticated;

-- The thank-you email went out (server route, once per invoice).
CREATE OR REPLACE FUNCTION public.admin_mark_thank_you_sent(p_invoice_id INT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t send invoice emails.';
  END IF;
  UPDATE public.invoices SET thank_you_sent_at = now()
   WHERE id = p_invoice_id AND doc_type = 'invoice' AND status = 'issued' AND thank_you_sent_at IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.admin_mark_thank_you_sent(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_mark_thank_you_sent(INT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Website sales: a web order's invoice and receipts
-- ─────────────────────────────────────────────────────────────────────────────
-- The receipt for a paid web order (cash on delivery → cash; transfer → bank transfer).
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
          CASE WHEN o.payment_method = 'bank_transfer' THEN 'bank_transfer' ELSE 'cash' END,
          o.payment_ref, format('Web order %s', o.id), 'manual', inv.bill_to_name,
          (SELECT c.id FROM public.customers c WHERE c.id = auth.uid()));
  PERFORM public._invoice_recalc(inv.id);
END $$;
REVOKE ALL ON FUNCTION public._web_invoice_receipt(INT) FROM PUBLIC, anon, authenticated;

-- One issued invoice (INV-…) for a handed-over web order: its lines, delivery and discount, so the
-- total equals the order total. Stock is NOT taken again (the order did that). Returns its id.
CREATE OR REPLACE FUNCTION public._web_invoice_create(p_order_id TEXT)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  o     public.orders;
  s     public.invoice_settings;
  v_id  INT;
  v_pos INT := 0;
  r     RECORD;
BEGIN
  SELECT * INTO o FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND OR EXISTS (SELECT 1 FROM public.invoices i WHERE i.order_id = o.id AND i.doc_type = 'invoice' AND i.status <> 'void') THEN
    RETURN NULL;
  END IF;
  SELECT * INTO s FROM public.invoice_settings WHERE id;
  INSERT INTO public.invoices (doc_type, channel, order_id, customer_id, issue_date, reference,
                               bill_to_name, bill_to_address, bill_to_city, bill_to_postal_code, bill_to_phone, bill_to_email,
                               notes, discount_type, discount_value, tax_type, tax_value, deduct_stock, sale_type)
  VALUES ('invoice', 'website', o.id, o.customer_id, (now() AT TIME ZONE 'Asia/Colombo')::DATE, o.id,
          COALESCE(NULLIF(btrim(concat_ws(' ', o.first_name, o.last_name)), ''), o.email),
          NULLIF(btrim(COALESCE(o.shipping_address ->> 'street', '')), ''),
          NULLIF(btrim(concat_ws(', ', NULLIF(o.shipping_address ->> 'city', ''), NULLIF(o.shipping_address ->> 'district', ''))), ''),
          NULLIF(btrim(COALESCE(o.shipping_address ->> 'postal_code', '')), ''),
          o.phone, o.email, COALESCE(s.default_notes, '{}'::TEXT[]),
          'amount', LEAST(o.discount_amount, 100000000), 'amount', 0, FALSE, NULL)
  RETURNING id INTO v_id;
  FOR r IN
    SELECT oi.*, COALESCE((SELECT array_agg(pu.serial_number ORDER BY pu.id) FROM public.product_units pu WHERE pu.order_item_id = oi.id), '{}') AS serials
      FROM public.order_items oi WHERE oi.order_id = o.id ORDER BY oi.id
  LOOP
    INSERT INTO public.invoice_items (invoice_id, position, product_id, variant_id, description, serial_numbers, quantity, unit_price, amount)
    VALUES (v_id, v_pos, r.product_id, r.variant_id,
            left(concat_ws(' — ', CASE WHEN r.brand IS NOT NULL AND lower(r.product_name) NOT LIKE lower(r.brand) || '%' THEN r.brand || ' ' || r.product_name ELSE r.product_name END,
                           NULLIF(r.variant_name, 'Standard')), 1000),
            r.serials[1:GREATEST(r.quantity, 1)], r.quantity, r.unit_price, round(r.quantity * r.unit_price, 2));
    v_pos := v_pos + 1;
  END LOOP;
  IF o.shipping_fee > 0 THEN
    INSERT INTO public.invoice_items (invoice_id, position, description, quantity, unit_price, amount)
    VALUES (v_id, v_pos, 'Delivery', 1, o.shipping_fee, o.shipping_fee);
  END IF;
  BEGIN
    PERFORM public._invoice_link_units(v_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '_web_invoice_create %: serials not linked (%)', o.id, SQLERRM;
  END;
  UPDATE public.invoice_items it SET unit_cost = pc.cost_price
    FROM public.product_costs pc WHERE it.invoice_id = v_id AND it.variant_id = pc.variant_id;
  UPDATE public.invoices SET status = 'issued', number = public._document_take_number('invoice'), issued_at = now() WHERE id = v_id;
  PERFORM public._invoice_recalc(v_id);
  PERFORM public._web_invoice_receipt(v_id);
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public._web_invoice_create(TEXT) FROM PUBLIC, anon, authenticated;

-- Order status / payment → the website invoice. A paid order's invoice is voided (with its receipts)
-- on cancel / refund — by an admin only (staff can't void a paid invoice, 39).
CREATE OR REPLACE FUNCTION public._web_invoice_sync() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv     public.invoices;
  v_paid  BOOLEAN;
BEGIN
  SELECT * INTO inv FROM public.invoices i
   WHERE i.order_id = NEW.id AND i.doc_type = 'invoice' AND i.status = 'issued' AND i.channel = 'website'
   ORDER BY i.id DESC LIMIT 1;

  IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'cancelled'
     OR (NEW.payment_status IS DISTINCT FROM OLD.payment_status AND NEW.payment_status IN ('refunded', 'void')) THEN
    IF inv.id IS NULL THEN
      RETURN NULL;
    END IF;
    v_paid := EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = inv.id AND p.status = 'valid');
    IF v_paid AND auth.uid() IS NOT NULL AND NOT public.is_full_admin() THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = format('not_authorised:%s is paid and invoiced as %s, so only an admin can cancel or refund it.', NEW.id, inv.number);
    END IF;
    UPDATE public.invoice_payments SET status = 'void', voided_at = now(), voided_by = auth.uid(),
           void_reason = CASE WHEN NEW.status = 'cancelled' THEN format('Web order %s cancelled', NEW.id) ELSE format('Web order %s refunded', NEW.id) END
     WHERE invoice_id = inv.id AND status = 'valid';
    IF NEW.status = 'cancelled' THEN
      PERFORM public._invoice_release_units(inv.id);
      UPDATE public.invoices SET status = 'void', voided_at = now(), void_reason = format('Web order %s cancelled', NEW.id) WHERE id = inv.id;
    END IF;
    PERFORM public._invoice_recalc(inv.id);
    RETURN NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND public._stock_issued_status(NEW.status, NEW.fulfillment)
     AND NOT public._stock_issued_status(OLD.status, OLD.fulfillment) AND inv.id IS NULL THEN
    BEGIN
      PERFORM public._web_invoice_create(NEW.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '_web_invoice_sync %: the invoice was not created (%)', NEW.id, SQLERRM;
    END;
    RETURN NULL;
  END IF;

  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status AND NEW.payment_status = 'paid' AND inv.id IS NOT NULL THEN
    PERFORM public._web_invoice_receipt(inv.id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._web_invoice_sync() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS orders_91_web_invoice ON public.orders;
CREATE TRIGGER orders_91_web_invoice AFTER UPDATE OF status, payment_status ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public._web_invoice_sync();

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Sales report
-- ─────────────────────────────────────────────────────────────────────────────
-- Invoices dated p_from … p_to (Sri Lanka days), channel 'all' | 'store' | 'website'.
-- totals: issued invoices only; void ones are listed with their reasons. Cost figures need
-- "Cost prices" (staff); a line without a recorded cost uses today's cost (counted in cost_estimated_lines).
CREATE OR REPLACE FUNCTION public.admin_sales_report(p_from DATE, p_to DATE, p_channel TEXT DEFAULT 'all')
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_channel TEXT := lower(COALESCE(NULLIF(btrim(p_channel), ''), 'all'));
  v_costs   BOOLEAN;
  v_out     JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t see sales reports.';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_range:Choose a start date on or before the end date.';
  END IF;
  IF v_channel NOT IN ('all', 'store', 'website') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_range:Choose website, in-store or both.';
  END IF;
  v_costs := public.staff_can('costs', 'view');

  WITH inv AS (
    SELECT i.* FROM public.invoices i
     WHERE i.doc_type = 'invoice' AND i.number IS NOT NULL AND i.status IN ('issued', 'void')
       AND i.issue_date BETWEEN p_from AND p_to AND (v_channel = 'all' OR i.channel = v_channel)
  ), cost AS (
    SELECT it.invoice_id,
           round(sum(it.quantity * COALESCE(it.unit_cost, pc.cost_price)), 2) AS cost,
           count(*) FILTER (WHERE it.variant_id IS NOT NULL AND it.unit_cost IS NULL AND pc.cost_price IS NOT NULL) AS estimated,
           count(*) FILTER (WHERE it.variant_id IS NOT NULL AND it.unit_cost IS NULL AND pc.cost_price IS NULL) AS missing
      FROM public.invoice_items it
      LEFT JOIN public.product_costs pc ON pc.variant_id = it.variant_id
     WHERE it.invoice_id IN (SELECT id FROM inv)
     GROUP BY it.invoice_id
  ), rc AS (
    SELECT p.* FROM public.invoice_payments p WHERE p.status = 'valid' AND p.invoice_id IN (SELECT id FROM inv WHERE status = 'issued')
  )
  SELECT jsonb_build_object(
    'from', p_from, 'to', p_to, 'channel', v_channel, 'generated_at', now(), 'costs_visible', v_costs,
    'totals', (SELECT jsonb_build_object(
                 'invoice_count', count(*) FILTER (WHERE inv.status = 'issued'),
                 'sales_total', COALESCE(sum(inv.total) FILTER (WHERE inv.status = 'issued'), 0),
                 'store_total', COALESCE(sum(inv.total) FILTER (WHERE inv.status = 'issued' AND inv.channel = 'store'), 0),
                 'website_total', COALESCE(sum(inv.total) FILTER (WHERE inv.status = 'issued' AND inv.channel = 'website'), 0),
                 'paid_total', COALESCE(sum(inv.amount_paid) FILTER (WHERE inv.status = 'issued'), 0),
                 'outstanding_total', COALESCE(sum(inv.balance_due) FILTER (WHERE inv.status = 'issued'), 0),
                 'credit_sales_count', count(*) FILTER (WHERE inv.status = 'issued' AND inv.sale_type = 'credit'),
                 'credit_sales_total', COALESCE(sum(inv.total) FILTER (WHERE inv.status = 'issued' AND inv.sale_type = 'credit'), 0),
                 'void_count', count(*) FILTER (WHERE inv.status = 'void'),
                 'void_total', COALESCE(sum(inv.total) FILTER (WHERE inv.status = 'void'), 0),
                 'cost_total', CASE WHEN v_costs THEN COALESCE((SELECT sum(c.cost) FROM cost c JOIN inv x ON x.id = c.invoice_id AND x.status = 'issued'), 0) END,
                 'cost_estimated_lines', CASE WHEN v_costs THEN COALESCE((SELECT sum(c.estimated) FROM cost c JOIN inv x ON x.id = c.invoice_id AND x.status = 'issued'), 0) END,
                 'cost_missing_lines', CASE WHEN v_costs THEN COALESCE((SELECT sum(c.missing) FROM cost c JOIN inv x ON x.id = c.invoice_id AND x.status = 'issued'), 0) END)
                 FROM inv),
    'by_method', COALESCE((SELECT jsonb_agg(jsonb_build_object('method', m.method, 'total', m.total, 'count', m.n) ORDER BY m.total DESC)
                             FROM (SELECT rc.method, sum(rc.amount) AS total, count(*) AS n FROM rc GROUP BY rc.method) m), '[]'::jsonb),
    'card_accounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('account', a.account, 'total', a.total, 'count', a.n) ORDER BY a.total DESC)
                                 FROM (SELECT COALESCE(rc.card_account, 'Not recorded') AS account, sum(rc.amount) AS total, count(*) AS n
                                         FROM rc WHERE rc.method = 'card' GROUP BY 1) a), '[]'::jsonb),
    'cheques', COALESCE((SELECT jsonb_agg(jsonb_build_object('receipt_number', rc.receipt_number, 'cheque_number', rc.cheque_number,
                                                             'amount', rc.amount, 'paid_on', rc.paid_on, 'payer_name', rc.payer_name,
                                                             'invoice_number', (SELECT x.number FROM inv x WHERE x.id = rc.invoice_id))
                                          ORDER BY rc.paid_on, rc.id)
                           FROM rc WHERE rc.method = 'cheque'), '[]'::jsonb),
    'invoices', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                             'id', i.id, 'number', i.number, 'issue_date', i.issue_date, 'channel', i.channel,
                             'order_id', i.order_id, 'client', i.bill_to_name, 'status', i.status, 'sale_type', i.sale_type,
                             'payment_status', i.payment_status, 'total', i.total, 'amount_paid', i.amount_paid,
                             'balance_due', i.balance_due, 'void_reason', i.void_reason, 'voided_at', i.voided_at,
                             'cost', CASE WHEN v_costs THEN (SELECT c.cost FROM cost c WHERE c.invoice_id = i.id) END,
                             'methods', (SELECT string_agg(DISTINCT p.method, ', ') FROM public.invoice_payments p WHERE p.invoice_id = i.id AND p.status = 'valid'))
                           ORDER BY i.issue_date, i.number)
                           FROM inv i), '[]'::jsonb))
    INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_sales_report(DATE, DATE, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_sales_report(DATE, DATE, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Quotation requests from the website
-- ─────────────────────────────────────────────────────────────────────────────
-- p_contact: {name, company?, email, phone, address?, city?, note?}
-- p_items:   [{variant_id, quantity}] (1–30 lines, 1–1000 each; active, priced catalogue items)
-- → {id, number, token, valid_until, total}. Called by POST /api/quotation (per-IP limits there).
CREATE OR REPLACE FUNCTION public.request_quotation(p_contact JSONB, p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_q     CONSTANT TEXT := 'invalid_quote_request';
  s       public.invoice_settings;
  v_today DATE := (now() AT TIME ZONE 'Asia/Colombo')::DATE;
  v_name  TEXT;
  v_comp  TEXT;
  v_email TEXT;
  v_phone TEXT;
  v_addr  TEXT;
  v_city  TEXT;
  v_note  TEXT;
  v_n     INT;
  v_id    INT;
  v_pos   INT := 0;
  e       JSONB;
  v_vid   INT;
  v_qty   INT;
  r       RECORD;
  v_seen  INT[] := '{}';
  v_out   public.invoices;
BEGIN
  IF NOT public._route_or_budget('request_quotation', 20, 3600) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF p_contact IS NULL OR jsonb_typeof(p_contact) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_quote_request:Your details are missing.';
  END IF;
  v_name  := public._admin_json_text('invalid_name', p_contact -> 'name', 'Your name', 120, TRUE);
  v_comp  := public._admin_json_text(c_q, p_contact -> 'company', 'The company', 200);
  v_email := lower(public._admin_json_text('invalid_email', p_contact -> 'email', 'Your email', 254, TRUE));
  v_phone := public._admin_json_text('invalid_phone', p_contact -> 'phone', 'Your phone number', 40, TRUE);
  v_addr  := public._admin_json_text(c_q, p_contact -> 'address', 'The address', 500);
  v_city  := public._admin_json_text(c_q, p_contact -> 'city', 'The city', 120);
  v_note  := public._admin_json_text(c_q, p_contact -> 'note', 'The note', 1000);
  IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_email:Enter a valid email address.';
  END IF;
  IF regexp_replace(v_phone, '[^0-9]', '', 'g') !~ '^[0-9]{9,15}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_phone:Enter a phone number we can call.';
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_quote_request:Add at least one product to the quotation.';
  END IF;
  v_n := jsonb_array_length(p_items);
  IF v_n > 30 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_quote_request:A quotation request can have at most 30 products.';
  END IF;

  SELECT * INTO s FROM public.invoice_settings WHERE id;
  INSERT INTO public.invoices (doc_type, channel, issue_date, valid_until, bill_to_name, bill_to_company, bill_to_address,
                               bill_to_city, bill_to_phone, bill_to_email, notes, request_note, deduct_stock, sale_type)
  VALUES ('quotation', 'website', v_today, v_today + COALESCE(s.quote_valid_days, 14), v_name, v_comp, v_addr,
          v_city, v_phone, v_email, COALESCE(s.quote_notes, '{}'::TEXT[]), v_note, FALSE, NULL)
  RETURNING id INTO v_id;

  FOR i IN 0 .. v_n - 1 LOOP
    e := p_items -> i;
    v_vid := public._admin_json_int(c_q, e -> 'variant_id', 'A product', 1, 2147483647);
    v_qty := public._admin_json_int(c_q, e -> 'quantity', 'A quantity', 1, 1000);
    IF v_vid IS NULL OR v_qty IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_quote_request:Each product needs a quantity from 1 to 1000.';
    END IF;
    IF v_vid = ANY (v_seen) THEN
      CONTINUE;
    END IF;
    v_seen := v_seen || v_vid;
    SELECT v.id AS variant_id, v.product_id, v.price, v.name AS variant_name, p.name AS product_name, p.brand, p.warranty_months, p.variant_count
      INTO r
      FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
     WHERE v.id = v_vid AND v.is_active AND p.is_active;
    IF NOT FOUND OR r.price <= 0 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_quote_request:One of the products is no longer available — refresh and try again.';
    END IF;
    INSERT INTO public.invoice_items (invoice_id, position, product_id, variant_id, description, warranty, quantity, unit_price, amount)
    VALUES (v_id, v_pos, r.product_id, r.variant_id,
            left(concat_ws(' — ', CASE WHEN lower(r.product_name) LIKE lower(r.brand) || '%' THEN r.product_name ELSE r.brand || ' ' || r.product_name END,
                           CASE WHEN r.variant_count > 1 OR lower(r.variant_name) <> 'standard' THEN r.variant_name END), 1000),
            CASE WHEN r.warranty_months IS NULL OR r.warranty_months <= 0 THEN NULL
                 WHEN r.warranty_months % 12 = 0 THEN (r.warranty_months / 12) || CASE WHEN r.warranty_months = 12 THEN ' Year' ELSE ' Years' END
                 ELSE r.warranty_months || CASE WHEN r.warranty_months = 1 THEN ' Month' ELSE ' Months' END END,
            v_qty, r.price, round(v_qty * r.price, 2));
    v_pos := v_pos + 1;
  END LOOP;

  UPDATE public.invoices SET status = 'issued', number = public._document_take_number('quotation'), issued_at = now() WHERE id = v_id;
  PERFORM public._invoice_recalc(v_id);
  SELECT * INTO v_out FROM public.invoices WHERE id = v_id;
  RETURN jsonb_build_object('id', v_out.id, 'number', v_out.number, 'token', v_out.view_token,
                            'valid_until', v_out.valid_until, 'total', v_out.total, 'email', v_out.bill_to_email,
                            'name', v_out.bill_to_name, 'item_count', v_out.item_count);
END $$;
REVOKE ALL ON FUNCTION public.request_quotation(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_quotation(JSONB, JSONB) TO anon, authenticated;

-- A quotation for its private link (/quotation/<id>?t=<token>): what the printed quotation shows.
CREATE OR REPLACE FUNCTION public.get_public_quotation(p_id INT, p_token UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
           'quotation', jsonb_build_object(
             'id', i.id, 'number', i.number, 'status', i.status, 'issue_date', i.issue_date, 'valid_until', i.valid_until,
             'reference', i.reference, 'bill_to_name', i.bill_to_name, 'bill_to_company', i.bill_to_company,
             'bill_to_address', i.bill_to_address, 'bill_to_city', i.bill_to_city, 'bill_to_postal_code', i.bill_to_postal_code,
             'bill_to_phone', i.bill_to_phone, 'bill_to_email', i.bill_to_email, 'payment_terms', i.payment_terms,
             'notes', i.notes, 'show_bank_details', i.show_bank_details,
             'subtotal', i.subtotal, 'discount_type', i.discount_type, 'discount_value', i.discount_value,
             'discount_amount', i.discount_amount, 'tax_type', i.tax_type, 'tax_value', i.tax_value, 'tax_amount', i.tax_amount,
             'total', i.total, 'item_count', i.item_count),
           'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('position', it.position, 'description', it.description,
                                                                  'warranty', it.warranty, 'quantity', it.quantity,
                                                                  'unit_price', it.unit_price, 'amount', it.amount, 'serial_numbers', '[]'::jsonb)
                                               ORDER BY it.position, it.id)
                                FROM public.invoice_items it WHERE it.invoice_id = i.id), '[]'::jsonb),
           'settings', (SELECT jsonb_build_object('address_lines', s.address_lines, 'phone', s.phone, 'email', s.email,
                                                  'website', s.website, 'closing_title', s.closing_title,
                                                  'closing_line', s.closing_line, 'footer_tagline', s.footer_tagline)
                          FROM public.invoice_settings s WHERE s.id))
    FROM public.invoices i
   WHERE i.id = p_id AND i.view_token = p_token AND i.doc_type = 'quotation' AND i.status = 'issued'
$$;
REVOKE ALL ON FUNCTION public.get_public_quotation(INT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_quotation(INT, UUID) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. Staff sections for this file
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM public.staff_api_map WHERE migration = '40';
INSERT INTO public.staff_api_map (kind, name, area, view_level, edit_level, migration)
SELECT k, n, a, v, e, '40'
  FROM (VALUES
    ('table', 'invoices',             'quotations', 'view', 'admin'),
    ('table', 'invoices',             'receipts',   'view', 'admin'),
    ('table', 'invoice_items',        'quotations', 'view', 'admin'),
    ('table', 'invoice_payments',     'receipts',   'view', 'admin'),
    ('table', 'invoice_settings',     'quotations', 'view', 'admin'),
    ('table', 'invoice_settings',     'receipts',   'view', 'admin'),
    ('table', 'store_settings',       'quotations', 'view', 'admin'),
    ('rpc',   'admin_save_document',        'invoices',   'view', 'edit'),
    ('rpc',   'admin_save_document',        'quotations', 'view', 'edit'),
    ('rpc',   'admin_issue_invoice',        'quotations', 'view', 'edit'),
    ('rpc',   'admin_void_invoice',         'quotations', 'view', 'edit'),
    ('rpc',   'admin_revert_invoice',       'quotations', 'view', 'edit'),
    ('rpc',   'admin_convert_quotation',    'invoices',   'view', 'edit'),
    ('rpc',   'admin_record_receipt',       'receipts',   'view', 'edit'),
    ('rpc',   'admin_record_receipt',       'invoices',   'view', 'edit'),
    ('rpc',   'admin_allocate_receipt',     'receipts',   'view', 'edit'),
    ('rpc',   'admin_allocate_receipt',     'invoices',   'view', 'edit'),
    ('rpc',   'admin_record_invoice_payment','receipts',  'view', 'edit'),
    ('rpc',   'admin_void_receipt',         'receipts',   'view', 'admin'),
    ('rpc',   'admin_receipts_summary',     'receipts',   'view', 'view'),
    ('rpc',   'admin_mark_thank_you_sent',  'invoices',   'view', 'edit'),
    ('rpc',   'admin_sales_report',         'reports',    'view', 'view'),
    ('rpc',   'admin_invoice_product_search','quotations','view', 'view'),
    ('rpc',   'admin_invoice_client_search','quotations', 'view', 'view'),
    ('rpc',   'admin_invoice_due_alerts',   'receipts',   'view', 'view')
  ) AS m(k, n, a, v, e);

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 40_sales_documents
--   Run after 39. Existing payments become receipts RCT-00001… (oldest first). Then, in admin →
--   Invoices → Template & numbering, check the quotation prefix / validity / terms and the receipt
--   prefix. Website invoices start with the next web order handed over after this runs (orders
--   delivered earlier are not invoiced retroactively).
--   Re-run 40 after any re-run of 26 or 28 (it replaces some of their functions).
--   Verification:
--     SELECT receipt_prefix, receipt_next_number, quote_prefix, quote_next_number FROM public.invoice_settings;
--     SELECT count(*) FROM public.invoice_payments WHERE receipt_number IS NULL;           -- 0
--     SELECT doc_type, channel, status, count(*) FROM public.invoices GROUP BY 1, 2, 3;
--     SELECT has_function_privilege('anon', 'public.request_quotation(jsonb,jsonb)', 'EXECUTE');   -- true
--     SELECT has_function_privilege('anon', 'public.admin_sales_report(date,date,text)', 'EXECUTE'); -- false
-- ═════════════════════════════════════════════════════════════════════════════
