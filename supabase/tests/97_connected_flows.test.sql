-- 97_connected_flows.test.sql — the shop as ONE system: a delivery from a supplier → stock, ledger
-- and warranty; an advance (pre-order) receipt → the invoice made later → issued for the rest; an
-- in-store sale → stock, serials, customer warranty, the reports; a website order → its invoice,
-- serials added later, warranty, payment, refund; a hand-made invoice for a web order never takes
-- stock twice; deleting a draft never deletes a receipt.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.today', ((now() AT TIME ZONE 'Asia/Colombo')::date)::text, false);
UPDATE public.app_config SET value = (now() - interval '400 days')::text WHERE name = 'stock_ledger_started';

INSERT INTO public.categories (id, name) VALUES ('cf-cat', 'Connected tests');
INSERT INTO public.products (slug, brand, name, category_id, warranty_months) VALUES ('cf-laptop', 'CfBrand', 'Cf Laptop', 'cf-cat', 12);
INSERT INTO public.product_variants (product_id, sku, name, price) SELECT id, 'CF-LT', 'Standard', 200000 FROM public.products WHERE slug = 'cf-laptop';
SELECT set_config('t.v', (SELECT id::text FROM public.product_variants WHERE sku = 'CF-LT'), false);
SELECT set_config('t.p', (SELECT product_id::text FROM public.product_variants WHERE sku = 'CF-LT'), false);
INSERT INTO public.inventory (variant_id, stock_level) VALUES (current_setting('t.v')::int, 0);
INSERT INTO public.product_costs (variant_id, cost_price) VALUES (current_setting('t.v')::int, 150000);
INSERT INTO public.product_units (variant_id, product_id, serial_number)
SELECT current_setting('t.v')::int, 0, sn FROM unnest(ARRAY['CF-001', 'CF-002', 'CF-003', 'CF-004']) sn;

CREATE FUNCTION pg_temp.inv(p_id text) RETURNS public.invoices LANGUAGE sql AS $$ SELECT * FROM public.invoices WHERE id = current_setting(p_id)::int $$;
CREATE FUNCTION pg_temp.stock() RETURNS int LANGUAGE sql AS $$ SELECT stock_level FROM public.inventory WHERE variant_id = current_setting('t.v')::int $$;
CREATE FUNCTION pg_temp.unit(p_sn text) RETURNS public.product_units LANGUAGE sql SECURITY DEFINER AS $$ SELECT * FROM public.product_units WHERE serial_number = p_sn $$;
CREATE FUNCTION pg_temp.moves() RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT COALESCE(string_agg(format('%s:%s', movement_type, qty_in - qty_out), ' ' ORDER BY occurred_at, id), '')
    FROM public.stock_movements WHERE variant_id = current_setting('t.v')::int AND movement_type <> 'opening'
$$;
CREATE FUNCTION pg_temp.wty(p_sn text) RETURNS public.unit_warranties LANGUAGE sql SECURITY DEFINER AS $$
  SELECT w.* FROM public.unit_warranties w JOIN public.product_units u ON u.id = w.unit_id WHERE u.serial_number = p_sn
$$;
CREATE FUNCTION pg_temp.wty_count(p_sup int) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
  SELECT count(*) FROM public.unit_warranties w JOIN public.product_units u ON u.id = w.unit_id
   WHERE u.variant_id = current_setting('t.v')::int AND w.supplier_id = p_sup
$$;
CREATE FUNCTION pg_temp.line(p_qty int, p_serials text[] DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('variant_id', current_setting('t.v')::int, 'product_id', current_setting('t.p')::int, 'description', 'Cf Laptop',
                            'quantity', p_qty, 'unit_price', 200000, 'serial_numbers', to_jsonb(p_serials))
$$;

-- ── 1. a delivery from a supplier ───────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
INSERT INTO public.suppliers (name) VALUES ('Cf Distributors');
SELECT set_config('t.sup', (SELECT id::text FROM public.suppliers WHERE name = 'Cf Distributors'), false);
SELECT public.admin_record_stock_receipt(current_setting('t.v')::int, 4, current_setting('t.sup')::int, current_setting('t.today')::date,
  'GRN-1', NULL, NULL, (SELECT array_agg(id ORDER BY id) FROM public.product_units WHERE variant_id = current_setting('t.v')::int),
  jsonb_build_object('supplier_start', current_setting('t.today'), 'supplier_expiry', (current_setting('t.today')::date + 365)::text, 'supplier_coverage', 'Agent warranty'));
SELECT pg_temp.eq(pg_temp.stock(), 4, 'the delivery puts 4 into stock');
SELECT pg_temp.eq(pg_temp.moves(), 'received:4', 'the stock movement report sees it as received');
SELECT pg_temp.eq(pg_temp.wty_count(current_setting('t.sup')::int), 4::bigint,
                  'each serial carries the supplier warranty');
SELECT pg_temp.eq((SELECT format('%s|%s', r ->> 'quantity', r ->> 'value') FROM jsonb_array_elements(public.admin_inventory_value_report(NULL, NULL, NULL, current_setting('t.v')::int) -> 'rows') r),
                  '4|800000.00', 'and the inventory value report counts it (4 × Rs 200,000)');

-- ── 2. an advance (pre-order) → the invoice made later ──────────────────────
SELECT set_config('t.adv', (public.admin_record_receipt('{"amount": 50000, "method": "cash", "payer_name": "Nimal Stores"}') #>> '{receipt,id}'), false);
SELECT pg_temp.eq((SELECT invoice_id IS NULL FROM public.invoice_payments WHERE id = current_setting('t.adv')::int), true, 'an advance has no invoice yet');
SELECT set_config('t.i1', (public.admin_save_document('{"bill_to_name":"Nimal Stores"}', jsonb_build_array(pg_temp.line(1, ARRAY['CF-001'])),
  '{"sale_type":"cash"}', '{"doc_type":"invoice"}') #>> '{invoice,id}'), false);
SELECT public.admin_allocate_receipt(current_setting('t.adv')::int, current_setting('t.i1')::int);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', status, amount_paid, balance_due) FROM pg_temp.inv('t.i1')), 'draft|50000.00|150000.00',
                  'the advance links to the DRAFT invoice: 50,000 of 200,000 already paid');
SELECT public.admin_issue_invoice(current_setting('t.i1')::int);
SELECT pg_temp.eq((SELECT format('%s|%s', amount, note) FROM public.invoice_payments WHERE invoice_id = current_setting('t.i1')::int AND source = 'sale'),
                  '150000.00|Balance paid at the sale (advance Rs. 50,000.00 received earlier)', 'issuing as cash collects only the rest');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', payment_status, amount_paid, balance_due) FROM pg_temp.inv('t.i1')), 'paid|200000.00|0.00', 'paid in full, no double payment');
SELECT pg_temp.eq(pg_temp.stock(), 3, 'the in-store sale takes the laptop out of stock');
SELECT pg_temp.eq(pg_temp.moves(), 'received:4 sale:-1', 'the ledger records the sale');
SELECT pg_temp.eq((SELECT format('%s|%s', status, invoice_item_id IS NOT NULL) FROM pg_temp.unit('CF-001')), 'sold|t', 'its serial is sold on the invoice line');
SELECT pg_temp.eq((SELECT format('%s|%s', customer_start::text = current_setting('t.today'), customer_auto) FROM pg_temp.wty('CF-001')), 't|t', 'the customer warranty starts today');
-- back to draft keeps the advance (it was paid before the sale); the sale receipt is voided
SELECT public.admin_revert_invoice(current_setting('t.i1')::int);
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s', source, status), ',' ORDER BY id) FROM public.invoice_payments WHERE invoice_id = current_setting('t.i1')::int),
                  'manual:valid,sale:void', 'back to draft: the advance stays, the sale payment is voided');
SELECT pg_temp.eq(format('%s|%s', pg_temp.stock(), (pg_temp.unit('CF-001')).status), '4|in_stock', 'and stock + serial come back');
SELECT pg_temp.eq((SELECT customer_start FROM pg_temp.wty('CF-001')), NULL::date, 'the automatic customer warranty is cleared');
SELECT public.admin_issue_invoice(current_setting('t.i1')::int);
SELECT pg_temp.eq((SELECT format('%s|%s', payment_status, (SELECT count(*) FROM public.invoice_payments WHERE invoice_id = current_setting('t.i1')::int AND status = 'valid'))
                     FROM pg_temp.inv('t.i1')), 'paid|2', 'issued again: advance + a new sale payment for the rest');
-- re-saving the issued invoice (e.g. fixing the client's name) keeps the warranty start date
SELECT pg_temp.logout();
UPDATE public.unit_warranties SET customer_start = current_setting('t.today')::date - 10 WHERE unit_id = (pg_temp.unit('CF-001')).id;
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_save_document(jsonb_build_object('id', current_setting('t.i1')::int, 'bill_to_name', 'Nimal Stores (Pvt) Ltd'),
  jsonb_build_array(pg_temp.line(1, ARRAY['CF-001']) || jsonb_build_object('id', (SELECT id FROM public.invoice_items WHERE invoice_id = current_setting('t.i1')::int))),
  NULL, '{"doc_type":"invoice"}');
SELECT pg_temp.eq((SELECT customer_start FROM pg_temp.wty('CF-001')), current_setting('t.today')::date - 10, 're-saving an issued invoice does not restart the warranty');
SELECT pg_temp.eq((SELECT format('%s|%s', status, bill_to_name) FROM pg_temp.inv('t.i1')), 'issued|Nimal Stores (Pvt) Ltd', 'the change is saved');

-- an advance bigger than what is left can't be linked; a draft that is deleted hands its receipt back
SELECT set_config('t.adv2', (public.admin_record_receipt('{"amount": 30000, "method": "bank_transfer", "payer_name": "Sunil"}') #>> '{receipt,id}'), false);
SELECT set_config('t.i2', (public.admin_save_document('{"bill_to_name":"Sunil"}', jsonb_build_array(pg_temp.line(1)), '{"sale_type":"cash"}', '{"doc_type":"invoice"}')
  #>> '{invoice,id}'), false);
SELECT public.admin_allocate_receipt(current_setting('t.adv2')::int, current_setting('t.i2')::int);
SELECT public.admin_delete_invoice(current_setting('t.i2')::int);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', status, invoice_id IS NULL, receipt_number IS NOT NULL) FROM public.invoice_payments WHERE id = current_setting('t.adv2')::int),
                  'valid|t|t', 'deleting the draft never deletes the receipt — it is unlinked again');
SELECT pg_temp.logout();

-- ── 3. a website order ──────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT set_config('t.o1', public.place_order('buyer@shop.test', 'Kamal', 'Silva', '0771234567', '{"street":"1 Galle Road","city":"Colombo 03","district":"Colombo"}',
  jsonb_build_array(jsonb_build_object('product_id', current_setting('t.p')::int, 'variant_id', current_setting('t.v')::int, 'quantity', 1))) ->> 'order_id', false);
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.stock(), 2, 'the website order holds one more laptop (3 → 2)');
SELECT public.admin_set_order_status(current_setting('t.o1'), 'out_for_delivery', 'TRK-1');
SELECT set_config('t.wi', (SELECT id::text FROM public.invoices WHERE order_id = current_setting('t.o1') AND status = 'issued'), false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', channel, deduct_stock, stock_deducted) FROM pg_temp.inv('t.wi')), 'website|f|f', 'handed over: a website invoice that takes no stock');
SELECT pg_temp.eq(pg_temp.stock(), 2, 'stock is not taken twice');
SELECT pg_temp.eq((SELECT warranty FROM public.invoice_items WHERE invoice_id = current_setting('t.wi')::int AND variant_id = current_setting('t.v')::int), '1 Year',
                  'the website invoice line shows the warranty (WTY)');
-- the serial is assigned after the invoice was made → it reaches the invoice, and the warranty starts
SELECT public.admin_assign_order_serials((SELECT id FROM public.order_items WHERE order_id = current_setting('t.o1')), '["CF-002"]');
SELECT pg_temp.eq((SELECT serial_numbers FROM public.invoice_items WHERE invoice_id = current_setting('t.wi')::int AND variant_id = current_setting('t.v')::int),
                  ARRAY['CF-002'], 'a serial assigned later is added to the website invoice');
SELECT pg_temp.eq((SELECT (invoice_item_id IS NOT NULL) FROM pg_temp.unit('CF-002')), true, 'and linked to its line');
SELECT pg_temp.eq((SELECT format('%s|%s', customer_coverage, supplier_coverage) FROM pg_temp.wty('CF-002')),
                  '1 Year|Agent warranty', 'one record: customer warranty from the sale, supplier warranty from the delivery');
-- a serial that was never recorded, sold straight to the order, also gets its customer warranty
SELECT public.admin_assign_order_serials((SELECT id FROM public.order_items WHERE order_id = current_setting('t.o1')), '["CF-NEW-9"]');
SELECT pg_temp.eq((SELECT customer_coverage FROM pg_temp.wty('CF-NEW-9')), '1 Year',
                  'a serial recorded as sold straight away has its customer warranty');
SELECT pg_temp.eq((SELECT serial_numbers FROM public.invoice_items WHERE invoice_id = current_setting('t.wi')::int AND variant_id = current_setting('t.v')::int),
                  ARRAY['CF-NEW-9'], 'replacing the order''s serial replaces it on the invoice too');
SELECT pg_temp.eq(format('%s|%s', (pg_temp.unit('CF-002')).status, (SELECT customer_start IS NULL FROM pg_temp.wty('CF-002'))), 'in_stock|t',
                  'the replaced unit is back in stock, its customer warranty cleared');
SELECT public.admin_set_payment_status(current_setting('t.o1'), 'paid', NULL);
SELECT pg_temp.eq((SELECT payment_status FROM pg_temp.inv('t.wi')), 'paid', 'paying the order pays its invoice (receipt)');
SELECT set_config('t.rep', public.admin_sales_report(current_setting('t.today')::date, current_setting('t.today')::date, 'all')::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', t ->> 'invoice_count', t ->> 'sales_total', t ->> 'website_total')
                     FROM (SELECT current_setting('t.rep')::jsonb -> 'totals' AS t) x),
                  '2|400000.00|200000.00', 'the sales report shows the shop sale and the website sale together');
SELECT public.admin_set_payment_status(current_setting('t.o1'), 'refunded', NULL);
SELECT pg_temp.eq((SELECT format('%s|%s', status, void_reason) FROM pg_temp.inv('t.wi')), format('void|Web order %s refunded', current_setting('t.o1')),
                  'a refund voids the website invoice (no longer a sale, not shown as owed)');
SELECT pg_temp.eq((SELECT (public.admin_sales_report(current_setting('t.today')::date, current_setting('t.today')::date, 'all') -> 'totals' ->> 'sales_total')),
                  '200000.00', 'and the sales report drops it');

-- ── 4. an invoice made by hand for a web order ─────────────────────────────
SELECT pg_temp.login_anon();
SELECT set_config('t.o2', public.place_order('buyer2@shop.test', 'Ruwan', 'Perera', '0779999999', '{"street":"2 Main St","city":"Kandy","district":"Kandy"}',
  jsonb_build_array(jsonb_build_object('product_id', current_setting('t.p')::int, 'variant_id', current_setting('t.v')::int, 'quantity', 1))) ->> 'order_id', false);
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.mi', (public.admin_save_document(
  jsonb_build_object('bill_to_name', 'Ruwan Perera', 'order_id', current_setting('t.o2'), 'deduct_stock', true),
  jsonb_build_array(pg_temp.line(1), '{"description":"Delivery","quantity":1,"unit_price":450}'::jsonb),
  '{"sale_type":"cash"}', '{"doc_type":"invoice"}') #>> '{invoice,id}'), false);
SELECT pg_temp.eq((SELECT format('%s|%s', channel, deduct_stock) FROM pg_temp.inv('t.mi')), 'website|f',
                  'a hand-made invoice for a web order may keep its delivery line and never takes stock');
SELECT public.admin_issue_invoice(current_setting('t.mi')::int);
SELECT pg_temp.eq(pg_temp.stock(), 1, 'issuing it leaves stock alone (the order already took it)');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', sale_type IS NULL, payment_status, (SELECT count(*) FROM public.invoice_payments WHERE invoice_id = current_setting('t.mi')::int))
                     FROM pg_temp.inv('t.mi')), 't|unpaid|0', 'no "cash at the sale" receipt: the order isn''t paid yet');
SELECT set_config('t.mi2', (public.admin_save_document(jsonb_build_object('bill_to_name', 'Ruwan Perera', 'order_id', current_setting('t.o2')),
  jsonb_build_array(pg_temp.line(1)), NULL, '{"doc_type":"invoice"}') #>> '{invoice,id}'), false);
SELECT pg_temp.throws(format('SELECT public.admin_issue_invoice(%s)', current_setting('t.mi2')), '22023', 'a second invoice for the same order is refused', 'order_invoiced:%');
SELECT public.admin_set_order_status(current_setting('t.o2'), 'out_for_delivery', 'TRK-2');
SELECT pg_temp.eq((SELECT count(*) FROM public.invoices WHERE order_id = current_setting('t.o2') AND status = 'issued'), 1::bigint,
                  'hand-over does not make a second invoice');
SELECT public.admin_set_payment_status(current_setting('t.o2'), 'paid', NULL);
SELECT pg_temp.eq((SELECT format('%s|%s', payment_status, (SELECT method FROM public.invoice_payments WHERE invoice_id = current_setting('t.mi')::int AND status = 'valid'))
                     FROM pg_temp.inv('t.mi')), 'paid|cash', 'marking the order paid records the receipt on the hand-made invoice');
SELECT pg_temp.eq(pg_temp.moves(), 'received:4 sale:-1 sale_reversal:1 sale:-1 sale:-1 sale:-1', 'the ledger: one sale per real sale');
SELECT pg_temp.logout();
SELECT pg_temp.ok((SELECT public._stock_balance(current_setting('t.v')::int) = pg_temp.stock() + public._stock_reserved(current_setting('t.v')::int)),
                  'stock count, reservations and the ledger agree');

-- ── 5. a website quotation request converted into a sale counts as a shop sale ─
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.q', (public.admin_save_document('{"bill_to_name":"Lanka Logistics"}', jsonb_build_array(pg_temp.line(1)), NULL, '{"doc_type":"quotation"}')
  #>> '{invoice,id}'), false);
SELECT public.admin_issue_invoice(current_setting('t.q')::int);
SELECT pg_temp.logout();
UPDATE public.invoices SET channel = 'website' WHERE id = current_setting('t.q')::int;   -- as request_quotation stores it
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.qi', (public.admin_convert_quotation(current_setting('t.q')::int, '{}') #>> '{invoice,id}'), false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', doc_type, channel, quotation_id::text = current_setting('t.q')) FROM pg_temp.inv('t.qi')), 'invoice|store|t',
                  'the invoice from a website quotation request is an in-store sale, linked to its quotation');
SELECT pg_temp.logout();
