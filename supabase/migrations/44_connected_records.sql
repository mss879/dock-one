-- ═════════════════════════════════════════════════════════════════════════════
-- 44_connected_records.sql — Dock One Solutions
--
-- PURPOSE      Joins up the October additions with the records that already existed, so they
--              behave as one system.
--   1. Advance payments (pre-orders, deposits) link to the invoice while it is still being
--      made. A receipt recorded in Receipts with no invoice can be linked to a DRAFT invoice;
--      issuing it then collects only what is left (cash / card) or puts only the rest on credit.
--      Moving the invoice back to draft keeps those advances linked. A linked receipt can be
--      unlinked again (back to "not linked") — on an issued invoice by the owner only. Deleting a
--      draft never deletes a receipt: its receipts simply become unlinked.
--   2. Website orders ↔ invoices, stock, serial numbers and warranty:
--      · an invoice made for a web order never takes stock again (the order already did);
--      · an invoice made by hand for a web order may carry its delivery line;
--      · the website invoice is created at the next order step if creating it failed earlier;
--      · cancelling an order also voids a numbered draft invoice for it; a REFUND voids the
--        website invoice too (it no longer shows as unpaid or as a sale);
--      · website invoice lines carry the product's warranty (WTY column);
--      · serial numbers assigned to (or changed on) an order AFTER it was invoiced update that invoice;
--      · a serial recorded as sold straight away also gets its customer warranty;
--      · an invoice made by hand for a web order takes its payment from the order (no "cash at
--        the sale" receipt), and a web order can have only one issued invoice.
--   3. Quotations, warranty and staff:
--      · an invoice converted from a website quotation REQUEST counts as an in-store sale;
--      · re-saving an issued invoice no longer restarts its serials' customer warranty;
--      · moving a document back to draft needs edit on that kind of document (staff);
--      · staff making invoices / quotations can see stock levels (read only) for the stock hints.
-- DEPENDS ON   25, 26, 28, 38, 39, 40, 41.
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Advance payments
-- ─────────────────────────────────────────────────────────────────────────────
-- A deleted draft hands its receipts back as unlinked (26 had ON DELETE CASCADE).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_payments_invoice_id_fkey' AND confdeltype = 'c') THEN
    ALTER TABLE public.invoice_payments DROP CONSTRAINT invoice_payments_invoice_id_fkey;
    ALTER TABLE public.invoice_payments
      ADD CONSTRAINT invoice_payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices (id) ON DELETE SET NULL;
  END IF;
END $$;

-- TRUE when the receipt was linked while the invoice was a draft (an advance taken before the sale).
ALTER TABLE public.invoice_payments ADD COLUMN IF NOT EXISTS linked_as_advance BOOLEAN NOT NULL DEFAULT FALSE;

-- Valid receipts on an invoice that were NOT taken at the sale itself.
CREATE OR REPLACE FUNCTION public._invoice_prepaid(p_invoice_id INT) RETURNS NUMERIC
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(sum(amount), 0) FROM public.invoice_payments
   WHERE invoice_id = p_invoice_id AND status = 'valid' AND source <> 'sale'
$$;
REVOKE ALL ON FUNCTION public._invoice_prepaid(INT) FROM PUBLIC, anon, authenticated;

-- 40's sale payment, less any advance already linked: cash / card collect only the rest; credit
-- takes "paid now" on top of the advance, capped at what is left.
CREATE OR REPLACE FUNCTION public._invoice_sale_payment() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_today   DATE := (now() AT TIME ZONE 'Asia/Colombo')::DATE;
  v_prepaid NUMERIC;
  v_amount  NUMERIC;
  v_method  TEXT := CASE NEW.sale_type WHEN 'cash' THEN 'cash' WHEN 'card' THEN 'card' ELSE NEW.upfront_method END;
BEGIN
  IF NEW.sale_type IS NULL OR NEW.doc_type <> 'invoice' THEN
    RETURN NULL;
  END IF;
  v_prepaid := public._invoice_prepaid(NEW.id);
  IF v_prepaid > NEW.total THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('advance_exceeds_total:The advance receipts linked (%s) are more than the invoice total (%s). Unlink one first.',
                       public._invoice_rs(v_prepaid), public._invoice_rs(NEW.total));
  END IF;
  v_amount := CASE WHEN NEW.sale_type = 'credit' THEN LEAST(NEW.upfront_amount, NEW.total - v_prepaid) ELSE NEW.total - v_prepaid END;
  IF v_amount > 0 AND NOT EXISTS (SELECT 1 FROM public.invoice_payments p
                                   WHERE p.invoice_id = NEW.id AND p.source = 'sale' AND p.status = 'valid') THEN
    INSERT INTO public.invoice_payments (invoice_id, amount, paid_on, method, note, source, payer_name, created_by)
    VALUES (NEW.id, v_amount, LEAST(NEW.issue_date, v_today), v_method,
            CASE
              WHEN NEW.sale_type = 'credit' THEN format('Paid at the sale — balance on credit, due %s', to_char(NEW.due_date, 'DD Mon YYYY'))
              WHEN v_prepaid > 0 THEN format('Balance paid at the sale (advance %s received earlier)', public._invoice_rs(v_prepaid))
              ELSE 'Paid in full at the sale' END,
            'sale', NEW.bill_to_name, (SELECT c.id FROM public.customers c WHERE c.id = auth.uid()));
  END IF;
  PERFORM public._invoice_recalc(NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._invoice_sale_payment() FROM PUBLIC, anon, authenticated;

-- 40's link: now also to a DRAFT invoice (an advance for the sale being prepared).
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
  IF inv.status = 'void' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is void.', inv.number);
  END IF;
  IF inv.status = 'draft' AND inv.total <= 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invoice_empty:Add the items to the invoice first, then link the advance.';
  END IF;
  IF rc.amount > inv.balance_due THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('overpayment:%s is %s but the balance due on %s is %s.', rc.receipt_number, public._invoice_rs(rc.amount),
                       COALESCE(inv.number, 'this invoice'), public._invoice_rs(inv.balance_due));
  END IF;
  UPDATE public.invoice_payments
     SET invoice_id = inv.id, payer_name = COALESCE(payer_name, inv.bill_to_name), linked_as_advance = (inv.status = 'draft')
   WHERE id = rc.id;
  PERFORM public._invoice_recalc(inv.id);
  RETURN public._invoice_json(inv.id);
END $$;
REVOKE ALL ON FUNCTION public.admin_allocate_receipt(INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_allocate_receipt(INT, INT) TO authenticated;

-- Take a receipt off its invoice again (it becomes "not linked" and can be used elsewhere).
-- Draft invoice: anyone who can link receipts. Issued invoice: the owner only. Receipts taken at
-- the sale itself stay with their invoice.
CREATE OR REPLACE FUNCTION public.admin_unlink_receipt(p_receipt_id INT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv public.invoices;
  rc  public.invoice_payments;
BEGIN
  IF NOT public.is_admin() OR NOT (public.staff_can('receipts', 'edit') OR public.staff_can('invoices', 'edit')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t change receipts.';
  END IF;
  SELECT * INTO rc FROM public.invoice_payments WHERE id = p_receipt_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'receipt_not_found:That receipt no longer exists.';
  END IF;
  IF rc.invoice_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('receipt_unlinked:%s isn''t linked to an invoice.', rc.receipt_number);
  END IF;
  SELECT * INTO inv FROM public.invoices WHERE id = rc.invoice_id FOR UPDATE;   -- invoice first, like every writer
  SELECT * INTO rc FROM public.invoice_payments WHERE id = p_receipt_id FOR UPDATE;
  IF rc.status <> 'valid' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('receipt_void:%s is void.', rc.receipt_number);
  END IF;
  IF rc.source = 'sale' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('receipt_at_sale:%s was taken at the sale and belongs to %s.', rc.receipt_number, inv.number);
  END IF;
  IF inv.status = 'void' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invoice_void:%s is void.', inv.number);
  END IF;
  IF inv.status = 'issued' AND NOT public.is_full_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = format('not_authorised:%s is issued, so only the owner can take a receipt off it.', inv.number);
  END IF;
  UPDATE public.invoice_payments SET invoice_id = NULL, linked_as_advance = FALSE WHERE id = rc.id;
  PERFORM public._invoice_recalc(inv.id);
  RETURN public._invoice_json(inv.id);
END $$;
REVOKE ALL ON FUNCTION public.admin_unlink_receipt(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_unlink_receipt(INT) TO authenticated;

-- 40's back-to-draft: advances linked before the sale stay linked; receipts recorded AFTER the
-- sale still block it (void or unlink them first). Staff need edit on that kind of document.
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
  IF current_setting('request.path', true) IS NOT NULL AND current_setting('request.path', true) <> ''
     AND NOT public.staff_can(public._doc_area(inv.doc_type), 'edit') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t change this kind of document.';
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
  SELECT count(*) FILTER (WHERE pay.source = 'manual' AND NOT pay.linked_as_advance)::INT, count(*) FILTER (WHERE pay.source = 'sale')::INT
    INTO v_manual, v_sale
    FROM public.invoice_payments pay WHERE pay.invoice_id = inv.id AND pay.status = 'valid';
  IF v_manual > 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('invoice_has_payments:%s has %s receipt%s recorded after the sale. An admin must void or unlink %s (Payments) before it can go back to draft.',
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

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Website orders ↔ invoices, stock, serial numbers and warranty
-- ─────────────────────────────────────────────────────────────────────────────

-- 40's save: an invoice made by hand for a web order may keep its "Delivery" line (no product).
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


-- 40's website invoice, with each line's warranty words (the WTY column) from the product.
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
    SELECT oi.*, COALESCE((SELECT array_agg(pu.serial_number ORDER BY pu.id) FROM public.product_units pu WHERE pu.order_item_id = oi.id), '{}') AS serials,
           public._warranty_words((SELECT p.warranty_months FROM public.products p WHERE p.id = oi.product_id)) AS wty
      FROM public.order_items oi WHERE oi.order_id = o.id ORDER BY oi.id
  LOOP
    INSERT INTO public.invoice_items (invoice_id, position, product_id, variant_id, description, warranty, serial_numbers, quantity, unit_price, amount)
    VALUES (v_id, v_pos, r.product_id, r.variant_id,
            left(concat_ws(' — ', CASE WHEN r.brand IS NOT NULL AND lower(r.product_name) NOT LIKE lower(r.brand) || '%' THEN r.brand || ' ' || r.product_name ELSE r.product_name END,
                           NULLIF(r.variant_name, 'Standard')), 1000),
            r.wty, r.serials[1:GREATEST(r.quantity, 1)], r.quantity, r.unit_price, round(r.quantity * r.unit_price, 2));
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

-- 40's order → invoice sync. Changes: the invoice is (re)tried at any later step while the order
-- is handed over and has none; cancel also voids a numbered draft for the order (stock it took is
-- returned); a refund voids the invoice as well as its receipts.
CREATE OR REPLACE FUNCTION public._web_invoice_sync() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv     public.invoices;
  v_paid  BOOLEAN;
  v_why   TEXT;
BEGIN
  SELECT * INTO inv FROM public.invoices i
   WHERE i.order_id = NEW.id AND i.doc_type = 'invoice' AND (i.status = 'issued' OR (i.status = 'draft' AND i.number IS NOT NULL))
   ORDER BY (i.status = 'issued') DESC, i.id DESC LIMIT 1;

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
    v_why := CASE WHEN NEW.status = 'cancelled' AND NEW.status IS DISTINCT FROM OLD.status THEN format('Web order %s cancelled', NEW.id)
                  ELSE format('Web order %s refunded', NEW.id) END;
    UPDATE public.invoice_payments SET status = 'void', voided_at = now(), voided_by = auth.uid(), void_reason = v_why
     WHERE invoice_id = inv.id AND status = 'valid';
    IF inv.stock_deducted THEN
      PERFORM public._invoice_return_stock(inv.id);
    END IF;
    PERFORM public._invoice_release_units(inv.id);
    UPDATE public.invoices SET status = 'void', voided_at = now(), void_reason = v_why WHERE id = inv.id;
    PERFORM public._invoice_recalc(inv.id);
    RETURN NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND public._stock_issued_status(NEW.status, NEW.fulfillment) AND inv.id IS NULL THEN
    BEGIN
      PERFORM public._web_invoice_create(NEW.id);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '_web_invoice_sync %: the invoice was not created (%)', NEW.id, SQLERRM;
    END;
    RETURN NULL;
  END IF;

  IF NEW.payment_status IS DISTINCT FROM OLD.payment_status AND NEW.payment_status = 'paid' AND inv.id IS NOT NULL AND inv.status = 'issued' THEN
    PERFORM public._web_invoice_receipt(inv.id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._web_invoice_sync() FROM PUBLIC, anon, authenticated;

-- Serial numbers assigned to (or taken off) an order AFTER it was invoiced: the invoice line shows
-- the order line's serials; a unit taken off the order goes back to stock.
CREATE OR REPLACE FUNCTION public._unit_order_to_invoice() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_item BIGINT;
  v_line INT;
  v_qty  NUMERIC;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.order_item_id IS NOT DISTINCT FROM OLD.order_item_id THEN
    RETURN NULL;
  END IF;
  v_item := COALESCE(NEW.order_item_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.order_item_id END);
  IF v_item IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT it.id, it.quantity INTO v_line, v_qty
    FROM public.order_items oi
    JOIN public.invoices i ON i.order_id = oi.order_id AND i.doc_type = 'invoice' AND i.status <> 'void'
    JOIN public.invoice_items it ON it.invoice_id = i.id AND it.variant_id = oi.variant_id
   WHERE oi.id = v_item
   ORDER BY (i.status = 'issued') DESC, i.id DESC, it.position
   LIMIT 1;
  IF v_line IS NULL THEN
    RETURN NULL;
  END IF;
  UPDATE public.product_units SET invoice_item_id = v_line
   WHERE order_item_id = v_item AND status = 'sold' AND invoice_item_id IS NULL;
  UPDATE public.product_units SET invoice_item_id = NULL, status = 'in_stock', sold_at = NULL
   WHERE invoice_item_id = v_line AND order_item_id IS NULL;
  UPDATE public.invoice_items it
     SET serial_numbers = COALESCE((SELECT array_agg(x.serial_number ORDER BY x.id)
                                      FROM (SELECT pu.serial_number, pu.id FROM public.product_units pu
                                             WHERE pu.invoice_item_id = v_line ORDER BY pu.id LIMIT GREATEST(floor(v_qty)::INT, 0)) x), '{}')
   WHERE it.id = v_line;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._unit_order_to_invoice() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS product_units_92_order_to_invoice ON public.product_units;
CREATE TRIGGER product_units_92_order_to_invoice AFTER INSERT OR UPDATE OF order_item_id ON public.product_units
  FOR EACH ROW EXECUTE FUNCTION public._unit_order_to_invoice();


-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Invoices ↔ orders, quotations, warranty and staff sections
-- ─────────────────────────────────────────────────────────────────────────────
-- An invoice for a web order takes its PAYMENT from the order too: no "paid at the sale" type;
-- the order's payment becomes its receipt (marked paid in Orders), like the automatic invoice.
CREATE OR REPLACE FUNCTION public._invoice_order_no_stock() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.order_id IS NOT NULL THEN
    NEW.deduct_stock   := FALSE;
    NEW.sale_type      := NULL;
    NEW.upfront_amount := 0;
    NEW.credit_days    := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._invoice_order_no_stock() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoices_06_order_no_stock ON public.invoices;
CREATE TRIGGER invoices_06_order_no_stock BEFORE INSERT OR UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._invoice_order_no_stock();

-- One issued invoice per web order (a second would count the sale twice).
CREATE OR REPLACE FUNCTION public._invoice_one_per_order() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_other TEXT;
BEGIN
  IF NEW.order_id IS NOT NULL AND NEW.doc_type = 'invoice' AND NEW.status = 'issued' AND OLD.status IS DISTINCT FROM 'issued' THEN
    SELECT number INTO v_other FROM public.invoices
     WHERE order_id = NEW.order_id AND doc_type = 'invoice' AND status = 'issued' AND id <> NEW.id LIMIT 1;
    IF v_other IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('order_invoiced:Web order %s is already invoiced as %s. Void that one first, or open it instead.', NEW.order_id, v_other);
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._invoice_one_per_order() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS invoices_07_one_per_order ON public.invoices;
CREATE TRIGGER invoices_07_one_per_order BEFORE UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._invoice_one_per_order();

-- 44 §1's sale payment, plus: an invoice for a web order gets its receipt from the order's payment.
CREATE OR REPLACE FUNCTION public._invoice_sale_payment() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_today   DATE := (now() AT TIME ZONE 'Asia/Colombo')::DATE;
  v_prepaid NUMERIC;
  v_amount  NUMERIC;
  v_method  TEXT := CASE NEW.sale_type WHEN 'cash' THEN 'cash' WHEN 'card' THEN 'card' ELSE NEW.upfront_method END;
BEGIN
  IF NEW.doc_type <> 'invoice' THEN
    RETURN NULL;
  END IF;
  IF NEW.order_id IS NOT NULL THEN
    PERFORM public._invoice_recalc(NEW.id);
    PERFORM public._web_invoice_receipt(NEW.id);
    RETURN NULL;
  END IF;
  IF NEW.sale_type IS NULL THEN
    RETURN NULL;
  END IF;
  v_prepaid := public._invoice_prepaid(NEW.id);
  IF v_prepaid > NEW.total THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('advance_exceeds_total:The advance receipts linked (%s) are more than the invoice total (%s). Unlink one first.',
                       public._invoice_rs(v_prepaid), public._invoice_rs(NEW.total));
  END IF;
  v_amount := CASE WHEN NEW.sale_type = 'credit' THEN LEAST(NEW.upfront_amount, NEW.total - v_prepaid) ELSE NEW.total - v_prepaid END;
  IF v_amount > 0 AND NOT EXISTS (SELECT 1 FROM public.invoice_payments p
                                   WHERE p.invoice_id = NEW.id AND p.source = 'sale' AND p.status = 'valid') THEN
    INSERT INTO public.invoice_payments (invoice_id, amount, paid_on, method, note, source, payer_name, created_by)
    VALUES (NEW.id, v_amount, LEAST(NEW.issue_date, v_today), v_method,
            CASE
              WHEN NEW.sale_type = 'credit' THEN format('Paid at the sale — balance on credit, due %s', to_char(NEW.due_date, 'DD Mon YYYY'))
              WHEN v_prepaid > 0 THEN format('Balance paid at the sale (advance %s received earlier)', public._invoice_rs(v_prepaid))
              ELSE 'Paid in full at the sale' END,
            'sale', NEW.bill_to_name, (SELECT c.id FROM public.customers c WHERE c.id = auth.uid()));
  END IF;
  PERFORM public._invoice_recalc(NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._invoice_sale_payment() FROM PUBLIC, anon, authenticated;

-- 40's channel rule, plus: an invoice with no web order behind it is an in-store sale — a website
-- QUOTATION request converted into an invoice is sold in the shop, not online.
CREATE OR REPLACE FUNCTION public._invoice_channel() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.order_id IS NOT NULL THEN
    NEW.channel := 'website';
  ELSIF NEW.doc_type = 'invoice' AND NEW.channel = 'website' THEN
    NEW.channel := 'store';
  END IF;
  IF NEW.doc_type = 'quotation' THEN
    NEW.deduct_stock := FALSE;
    NEW.sale_type := NULL;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._invoice_channel() FROM PUBLIC, anon, authenticated;
UPDATE public.invoices SET channel = 'store' WHERE doc_type = 'invoice' AND order_id IS NULL AND channel = 'website';

-- 41's customer warranty: re-saving an issued invoice releases and re-links its serials within one
-- transaction — that must not restart the warranty from today. The "sale undone" clearing now
-- runs at the end of the transaction, and only if the unit really stayed in stock.
CREATE OR REPLACE FUNCTION public._unit_customer_warranty() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_months INT;
  v_start  DATE := COALESCE((NEW.sold_at AT TIME ZONE 'Asia/Colombo')::DATE, (now() AT TIME ZONE 'Asia/Colombo')::DATE);
  v_words  TEXT;
BEGIN
  IF NEW.status <> 'sold' OR (TG_OP = 'UPDATE' AND OLD.status = 'sold') THEN
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
    SET customer_coverage = EXCLUDED.customer_coverage,
        customer_start    = CASE WHEN public.unit_warranties.customer_start IS NULL THEN EXCLUDED.customer_start ELSE public.unit_warranties.customer_start END,
        customer_expiry   = CASE WHEN public.unit_warranties.customer_start IS NULL THEN EXCLUDED.customer_expiry ELSE public.unit_warranties.customer_expiry END,
        customer_auto     = TRUE
    WHERE public.unit_warranties.customer_start IS NULL OR public.unit_warranties.customer_auto;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._unit_customer_warranty() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS product_units_90_customer_warranty ON public.product_units;
CREATE TRIGGER product_units_90_customer_warranty AFTER INSERT OR UPDATE OF status ON public.product_units
  FOR EACH ROW EXECUTE FUNCTION public._unit_customer_warranty();

CREATE OR REPLACE FUNCTION public._unit_customer_warranty_clear() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.product_units WHERE id = NEW.id AND status = 'in_stock') THEN
    UPDATE public.unit_warranties
       SET customer_start = NULL, customer_expiry = NULL, customer_coverage = NULL, customer_auto = FALSE
     WHERE unit_id = NEW.id AND customer_auto;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public._unit_customer_warranty_clear() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS product_units_91_customer_warranty_clear ON public.product_units;
CREATE CONSTRAINT TRIGGER product_units_91_customer_warranty_clear AFTER UPDATE OF status ON public.product_units
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.status = 'sold' AND NEW.status = 'in_stock')
  EXECUTE FUNCTION public._unit_customer_warranty_clear();

-- ─────────────────────────────────────────────────────────────────────────────
-- Staff sections for this file (39)
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM public.staff_api_map WHERE migration = '44';
INSERT INTO public.staff_api_map (kind, name, area, view_level, edit_level, migration)
SELECT k, n, a, v, e, '44'
  FROM (VALUES
    ('rpc', 'admin_unlink_receipt', 'receipts', 'view', 'edit'),
    ('rpc', 'admin_unlink_receipt', 'invoices', 'view', 'edit'),
    ('table', 'admin_inventory', 'invoices', 'view', 'admin'),
    ('table', 'admin_inventory', 'quotations', 'view', 'admin')
  ) AS t (k, n, a, v, e);
