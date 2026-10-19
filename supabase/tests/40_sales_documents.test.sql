-- 40_sales_documents.test.sql — invoices need inventory lines; receipts (numbered, methods, card
-- account / cheque number, partial payments, advances linked later, voided never deleted, void and
-- back-to-draft blocked by receipts, staff limits); quotations (own numbers, custom lines, no
-- balance, conversion within validity, admin-only matching); website invoices from web orders
-- (same numbering, receipts from the order's payment, void on cancel); the sales report; and
-- quotation requests from the website with their private link.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.today', ((now() AT TIME ZONE 'Asia/Colombo')::date)::text, false);

INSERT INTO public.categories (id, name) VALUES ('sd-cat', 'Sales doc tests');
INSERT INTO public.products (slug, brand, name, category_id, warranty_months) VALUES
  ('sd-laptop', 'SdBrand', 'Sd Laptop', 'sd-cat', 12), ('sd-mouse', 'SdBrand', 'Sd Mouse', 'sd-cat', 6);
INSERT INTO public.product_variants (product_id, sku, name, price)
SELECT p.id, v.sku, 'Standard', v.price FROM public.products p
  JOIN (VALUES ('sd-laptop', 'SD-LT', 100000), ('sd-mouse', 'SD-MS', 5000)) AS v(slug, sku, price) ON v.slug = p.slug;
SELECT set_config('t.vlt', (SELECT id::text FROM public.product_variants WHERE sku = 'SD-LT'), false);
SELECT set_config('t.vms', (SELECT id::text FROM public.product_variants WHERE sku = 'SD-MS'), false);
SELECT set_config('t.plt', (SELECT product_id::text FROM public.product_variants WHERE sku = 'SD-LT'), false);
INSERT INTO public.inventory (variant_id, stock_level) VALUES (current_setting('t.vlt')::int, 10), (current_setting('t.vms')::int, 20);
INSERT INTO public.product_costs (variant_id, cost_price) VALUES (current_setting('t.vlt')::int, 70000), (current_setting('t.vms')::int, 3000);

CREATE FUNCTION pg_temp.inv(p_id text) RETURNS public.invoices LANGUAGE sql AS $$ SELECT * FROM public.invoices WHERE id = current_setting(p_id)::int $$;
CREATE FUNCTION pg_temp.line(p_var text, p_qty numeric, p_price numeric, p_desc text DEFAULT 'Item') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('variant_id', current_setting(p_var)::int, 'description', p_desc, 'quantity', p_qty, 'unit_price', p_price)
$$;
CREATE FUNCTION pg_temp.receipt(p jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT public.admin_record_receipt(p) $$;
CREATE FUNCTION pg_temp.req(p_method text, p_path text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.method', p_method, false), set_config('request.path', p_path, false)
$$;

-- ── 1. invoices: inventory products only ───────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_save_document('{"bill_to_name":"Acme"}', '[{"description":"Custom thing","quantity":1,"unit_price":10}]', '{"sale_type":"cash"}', '{"doc_type":"invoice"}')$$,
                      '22023', 'an invoice refuses a custom line', 'custom_line:Line 1 (“Custom thing”) is not an inventory product.%');
SELECT set_config('t.i1', (public.admin_save_document('{"bill_to_name":"Acme Holdings"}',
  jsonb_build_array(pg_temp.line('t.vlt', 1, 100000, 'Sd Laptop')), '{"sale_type":"credit","upfront_amount":0,"credit_days":30}', '{"doc_type":"invoice"}')
  #>> '{invoice,id}'), false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', doc_type, channel, status) FROM pg_temp.inv('t.i1')), 'invoice|store|draft', 'an in-store invoice draft');
SELECT public.admin_issue_invoice(current_setting('t.i1')::int);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', number, total, balance_due) FROM pg_temp.inv('t.i1')), 'INV-0001|100000.00|100000.00', 'issued in the invoice numbering');
SELECT pg_temp.eq((SELECT unit_cost::text FROM public.invoice_items WHERE invoice_id = current_setting('t.i1')::int), '70000.00', 'the line keeps the cost at the time');

-- ── 2. receipts ─────────────────────────────────────────────────────────────
SELECT pg_temp.throws(format($$SELECT pg_temp.receipt('{"invoice_id":%s,"amount":1000,"method":"card"}')$$, current_setting('t.i1')), '22023',
                      'a card payment needs its receiving account', 'invalid_receipt:For a card payment%');
SELECT pg_temp.throws(format($$SELECT pg_temp.receipt('{"invoice_id":%s,"amount":1000,"method":"cheque"}')$$, current_setting('t.i1')), '22023',
                      'a cheque needs its number', 'invalid_receipt:For a cheque%');
SELECT pg_temp.throws(format($$SELECT pg_temp.receipt('{"invoice_id":%s,"amount":1000,"method":"crypto"}')$$, current_setting('t.i1')), '22023',
                      'only cash, card, cheque or bank transfer', 'invalid_receipt:Choose how it was paid%');
SELECT set_config('t.r1', pg_temp.receipt(jsonb_build_object('invoice_id', current_setting('t.i1')::int, 'amount', 40000, 'method', 'cash'))::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', r #>> '{receipt,receipt_number}', r #>> '{invoice,invoice,payment_status}', r #>> '{invoice,invoice,balance_due}')
                     FROM (SELECT current_setting('t.r1')::jsonb AS r) x),
                  'RCT-00001|partial|60000.00', 'a numbered receipt: Rs 100,000 invoice, 40,000 paid, 60,000 outstanding');
SELECT pg_temp.eq((SELECT payer_name FROM public.invoice_payments WHERE receipt_number = 'RCT-00001'), 'Acme Holdings', 'the payer defaults to the client');
SELECT pg_temp.receipt(jsonb_build_object('invoice_id', current_setting('t.i1')::int, 'amount', 20000, 'method', 'card', 'card_account', 'Sampath POS 1'));
SELECT pg_temp.receipt(jsonb_build_object('invoice_id', current_setting('t.i1')::int, 'amount', 15000, 'method', 'cheque', 'cheque_number', 'CHQ-889911'));
SELECT pg_temp.throws(format($$SELECT pg_temp.receipt('{"invoice_id":%s,"amount":30000,"method":"bank_transfer"}')$$, current_setting('t.i1')), '22023',
                      'more than the balance is refused', 'overpayment:%');
-- an advance, recorded first and linked later
SELECT set_config('t.adv', (pg_temp.receipt('{"amount":25000,"method":"bank_transfer","payer_name":"Acme Holdings","reference":"BOC-77"}') #>> '{receipt,id}'), false);
SELECT pg_temp.eq((SELECT format('%s|%s', receipt_number, invoice_id IS NULL) FROM public.invoice_payments WHERE id = current_setting('t.adv')::int),
                  'RCT-00004|t', 'a receipt without an invoice (advance)');
SELECT public.admin_allocate_receipt(current_setting('t.adv')::int, current_setting('t.i1')::int);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', payment_status, amount_paid, balance_due) FROM pg_temp.inv('t.i1')), 'paid|100000.00|0.00',
                  'linking it settles the same invoice — no new sale');
SELECT pg_temp.throws(format('SELECT public.admin_allocate_receipt(%s, %s)', current_setting('t.adv'), current_setting('t.i1')), '22023',
                      'a receipt links once', 'receipt_linked:%');
-- void / back to draft are blocked by receipts
SELECT pg_temp.throws(format($$SELECT public.admin_void_invoice(%s, 'Client cancelled')$$, current_setting('t.i1')), '22023',
                      'a paid invoice cannot be voided', 'invoice_has_payments:INV-0001 has 4 payments%');
SELECT pg_temp.throws(format('SELECT public.admin_revert_invoice(%s)', current_setting('t.i1')), '22023',
                      'nor go back to draft', 'invoice_has_payments:%');

-- staff with Invoices + Receipts (edit): record and link, but never void a receipt or a paid invoice
SELECT set_config('t.staff', (public.admin_create_staff('cashier@shop.test', 'Cashier2026', 'Cashier',
  '{"invoices":"edit","quotations":"edit","receipts":"edit"}') ->> 'user_id'), false);
SELECT pg_temp.login(current_setting('t.staff')::uuid);
SELECT pg_temp.req('POST', '/rpc/admin_void_receipt');
SELECT pg_temp.throws($$SELECT public.admin_void_receipt((SELECT min(id) FROM public.invoice_payments), 'oops')$$, '42501',
                      'staff cannot void a receipt', 'not_authorised:Only an admin can void a receipt.');
SELECT pg_temp.req('POST', '/rpc/admin_void_invoice');
SELECT pg_temp.throws(format($$SELECT public.admin_void_invoice(%s, 'x')$$, current_setting('t.i1')), '22023', 'nor void a paid invoice', 'invoice_has_payments:%');
SELECT pg_temp.req('POST', '/rpc/admin_delete_invoice_payment');
SELECT pg_temp.throws($$SELECT public.admin_delete_invoice_payment((SELECT min(id) FROM public.invoice_payments))$$, '42501', 'nor delete a payment');
-- a cash sale issued by staff: going back to draft needs an admin
SELECT pg_temp.req('POST', '/rpc/admin_save_document');
SELECT set_config('t.i2', (public.admin_save_document('{"bill_to_name":"Walk-in"}', jsonb_build_array(pg_temp.line('t.vms', 2, 5000, 'Sd Mouse')),
  '{"sale_type":"cash"}', '{"doc_type":"invoice"}') #>> '{invoice,id}'), false);
SELECT pg_temp.req('POST', '/rpc/admin_issue_invoice');
SELECT public.admin_issue_invoice(current_setting('t.i2')::int);
SELECT pg_temp.req('POST', '/rpc/admin_revert_invoice');
SELECT pg_temp.throws(format('SELECT public.admin_revert_invoice(%s)', current_setting('t.i2')), '42501',
                      'staff cannot take a paid cash sale back to draft', 'not_authorised:%only an admin%');
SELECT pg_temp.req('', '');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_revert_invoice(current_setting('t.i2')::int);
SELECT pg_temp.eq((SELECT format('%s|%s', status, void_reason) FROM public.invoice_payments WHERE invoice_id = current_setting('t.i2')::int),
                  'void|Invoice moved back to draft', 'an admin can: the sale receipt is voided, not deleted');
SELECT public.admin_issue_invoice(current_setting('t.i2')::int);
SELECT pg_temp.eq((SELECT string_agg(status, ',' ORDER BY id) FROM public.invoice_payments WHERE invoice_id = current_setting('t.i2')::int),
                  'void,valid', 'issued again: a new receipt, the old one kept');
-- an admin voids a receipt: the balance comes back
SELECT public.admin_void_receipt((SELECT id FROM public.invoice_payments WHERE receipt_number = 'RCT-00001'), 'Counted twice');
SELECT pg_temp.eq((SELECT format('%s|%s', payment_status, balance_due) FROM pg_temp.inv('t.i1')), 'partial|40000.00', 'void receipts don''t count');
SELECT pg_temp.throws($$SELECT public.admin_void_receipt((SELECT id FROM public.invoice_payments WHERE receipt_number = 'RCT-00001'), 'again')$$, '22023',
                      'a receipt is voided once', 'receipt_void:%');

-- ── 3. quotations ───────────────────────────────────────────────────────────
SELECT set_config('t.q1', (public.admin_save_document('{"bill_to_name":"BigCo"}',
  jsonb_build_array(pg_temp.line('t.vlt', 5, 95000, 'Sd Laptop'),
                    jsonb_build_object('description', 'Outsourced projector', 'quantity', 1, 'unit_price', 250000)),
  '{"sale_type":"cash"}', '{"doc_type":"quotation","bill_to_company":"BigCo (Pvt) Ltd"}') #>> '{invoice,id}'), false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s', doc_type, sale_type IS NULL, deduct_stock, total, balance_due) FROM pg_temp.inv('t.q1')),
                  'quotation|t|f|725000.00|0.00', 'a quotation allows custom lines, takes no stock and owes nothing');
SELECT pg_temp.eq((SELECT notes[1] FROM pg_temp.inv('t.q1')), 'This quotation is valid until the date shown above.', 'with the quotation terms');
SELECT public.admin_issue_invoice(current_setting('t.q1')::int);
SELECT pg_temp.eq((SELECT format('%s|%s', number, valid_until - issue_date) FROM pg_temp.inv('t.q1')), 'QT-0001|14', 'its own numbering; valid 14 days');
SELECT pg_temp.eq((SELECT stock_level FROM public.inventory WHERE variant_id = current_setting('t.vlt')::int), 9, 'no stock moved for the quotation');
SELECT pg_temp.eq((SELECT (public.admin_invoice_summary() ->> 'issued_30d_count')::int), 2, 'quotations are not counted as invoices');
SELECT pg_temp.throws(format($$SELECT public.admin_save_document('{"id":%s}', NULL, NULL, '{"doc_type":"invoice"}')$$, current_setting('t.q1')), '22023',
                      'a numbered quotation does not turn into an invoice by switching', 'doc_type_locked:%Convert to invoice%');
SELECT pg_temp.throws(format($$SELECT pg_temp.receipt('{"invoice_id":%s,"amount":10,"method":"cash"}')$$, current_setting('t.q1')), '22023',
                      'a quotation takes no payments', 'invalid_receipt:%');
-- conversion: staff can't match custom lines
SELECT pg_temp.login(current_setting('t.staff')::uuid);
SELECT pg_temp.req('POST', '/rpc/admin_convert_quotation');
SELECT pg_temp.throws(format('SELECT public.admin_convert_quotation(%s)', current_setting('t.q1')), '42501',
                      'staff cannot convert while a line is not in the inventory', 'needs_admin_match:QT-0001 has 1 line that is not in the inventory%');
SELECT pg_temp.req('', '');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws(format('SELECT public.admin_convert_quotation(%s)', current_setting('t.q1')), '22023', 'even an admin must match it', 'needs_admin_match:%');
SELECT set_config('t.c1', public.admin_convert_quotation(current_setting('t.q1')::int,
  jsonb_build_object((SELECT id::text FROM public.invoice_items WHERE invoice_id = current_setting('t.q1')::int AND variant_id IS NULL), current_setting('t.vms')::int))::text, false);
SELECT set_config('t.ci', current_setting('t.c1')::jsonb #>> '{invoice,id}', false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s', doc_type, status, reference, quotation_id = current_setting('t.q1')::int, total) FROM pg_temp.inv('t.ci')),
                  'invoice|draft|QT-0001|t|725000.00', 'converted: a draft invoice made from the quotation, prices kept');
SELECT pg_temp.eq((SELECT count(*) FROM public.invoice_items WHERE invoice_id = current_setting('t.ci')::int AND variant_id IS NULL), 0::bigint, 'every line is an inventory product now');
SELECT pg_temp.eq((SELECT converted_invoice_id::text FROM pg_temp.inv('t.q1')), current_setting('t.ci'), 'the quotation stays, linked');
SELECT pg_temp.throws(format('SELECT public.admin_convert_quotation(%s)', current_setting('t.q1')), '22023', 'converted once', 'quotation_converted:%');
-- an expired quotation can't be converted
SELECT set_config('t.q2', (public.admin_save_document(jsonb_build_object('bill_to_name', 'Late', 'issue_date', current_setting('t.today')::date - 30),
  jsonb_build_array(pg_temp.line('t.vms', 1, 5000)), NULL, '{"doc_type":"quotation"}') #>> '{invoice,id}'), false);
SELECT public.admin_issue_invoice(current_setting('t.q2')::int);
SELECT pg_temp.throws(format('SELECT public.admin_convert_quotation(%s)', current_setting('t.q2')), '22023', 'an expired quotation is not converted', 'quotation_expired:%');
-- a draft may switch type; then the invoice rule applies
SELECT set_config('t.q3', (public.admin_save_document('{"bill_to_name":"Switcher"}', jsonb_build_array(pg_temp.line('t.vms', 1, 5000)), NULL,
  '{"doc_type":"quotation"}') #>> '{invoice,id}'), false);
SELECT public.admin_save_document(jsonb_build_object('id', current_setting('t.q3')::int), NULL, '{"sale_type":"cash"}', '{"doc_type":"invoice"}');
SELECT pg_temp.eq((SELECT format('%s|%s', doc_type, notes[1] <> 'This quotation is valid until the date shown above.') FROM pg_temp.inv('t.q3')), 'invoice|t',
                  'a draft quotation becomes an invoice draft (with the invoice terms)');

-- ── 4. website sales ────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT set_config('t.o1', public.place_order('buyer@shop.test', 'Kamal', 'Silva', '0771234567', '{"street":"1 Galle Road","city":"Colombo 03","district":"Colombo"}',
  jsonb_build_array(jsonb_build_object('product_id', current_setting('t.plt')::int, 'variant_id', current_setting('t.vlt')::int, 'quantity', 1))) ->> 'order_id', false);
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.invoices WHERE order_id = current_setting('t.o1')), 0::bigint, 'a placed order has no invoice yet');
SELECT public.admin_set_order_status(current_setting('t.o1'), 'out_for_delivery', 'TRK-9');
SELECT set_config('t.wi', (SELECT id::text FROM public.invoices WHERE order_id = current_setting('t.o1')), false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s', doc_type, channel, status, number, total = (SELECT total_price FROM public.orders WHERE id = current_setting('t.o1')))
                     FROM pg_temp.inv('t.wi')),
                  'invoice|website|issued|INV-0003|t', 'handed over: a website invoice in the same numbering, for the order total');
SELECT pg_temp.eq((SELECT format('%s|%s', payment_status, stock_deducted) FROM pg_temp.inv('t.wi')), 'unpaid|f', 'cash on delivery not collected yet; stock not taken twice');
SELECT public.admin_set_payment_status(current_setting('t.o1'), 'paid', NULL);
SELECT pg_temp.eq((SELECT format('%s|%s', method, note) FROM public.invoice_payments WHERE invoice_id = current_setting('t.wi')::int),
                  format('cash|Web order %s', current_setting('t.o1')), 'marking the order paid records a receipt (COD → cash)');
SELECT pg_temp.eq((SELECT payment_status FROM pg_temp.inv('t.wi')), 'paid', 'and the invoice is paid');
SELECT public.admin_set_order_status(current_setting('t.o1'), 'cancelled');
SELECT pg_temp.eq((SELECT format('%s|%s', status, void_reason) FROM pg_temp.inv('t.wi')), format('void|Web order %s cancelled', current_setting('t.o1')),
                  'cancelling the order voids its invoice (kept, with the reason)');
SELECT pg_temp.eq((SELECT string_agg(status, ',') FROM public.invoice_payments WHERE invoice_id = current_setting('t.wi')::int), 'void', 'and its receipt');

-- ── 5. the sales report ─────────────────────────────────────────────────────
SELECT set_config('t.rep', public.admin_sales_report(current_setting('t.today')::date - 1, current_setting('t.today')::date, 'all')::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', t ->> 'invoice_count', t ->> 'sales_total', t ->> 'void_count', t ->> 'cost_total')
                     FROM (SELECT current_setting('t.rep')::jsonb -> 'totals' AS t) x),
                  '2|110000.00|1|76000.00', 'issued invoices only (the void one apart); cost of the items');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s', m ->> 'method', m ->> 'total'), ',' ORDER BY m ->> 'method')
                     FROM jsonb_array_elements(current_setting('t.rep')::jsonb -> 'by_method') m),
                  'bank_transfer:25000.00,card:20000.00,cash:10000.00,cheque:15000.00', 'paid by method (valid receipts)');
SELECT pg_temp.eq((SELECT format('%s|%s', a ->> 'account', a ->> 'total') FROM jsonb_array_elements(current_setting('t.rep')::jsonb -> 'card_accounts') a),
                  'Sampath POS 1|20000.00', 'card payments by receiving account');
SELECT pg_temp.eq((SELECT format('%s|%s', c ->> 'cheque_number', c ->> 'invoice_number') FROM jsonb_array_elements(current_setting('t.rep')::jsonb -> 'cheques') c),
                  'CHQ-889911|INV-0001', 'cheques with their numbers and invoices');
SELECT pg_temp.eq((SELECT format('%s|%s', t ->> 'credit_sales_count', t ->> 'outstanding_total') FROM (SELECT current_setting('t.rep')::jsonb -> 'totals' AS t) x),
                  '1|40000.00', 'credit sales and what is still owed');
SELECT pg_temp.eq((SELECT format('%s|%s', i ->> 'status', i ->> 'void_reason') FROM jsonb_array_elements(current_setting('t.rep')::jsonb -> 'invoices') i WHERE i ->> 'channel' = 'website'),
                  format('void|Web order %s cancelled', current_setting('t.o1')), 'void invoices are listed with their reason');
SELECT pg_temp.eq((public.admin_sales_report(current_setting('t.today')::date, current_setting('t.today')::date, 'website') -> 'totals' ->> 'invoice_count'), '0',
                  'website only');
SELECT pg_temp.throws($$SELECT public.admin_sales_report(current_date, current_date, 'mars')$$, '22023', 'an unknown channel', 'invalid_range:%');

-- ── 6. quotation requests from the website ──────────────────────────────────
SELECT set_config('t.i1tok', (SELECT view_token::text FROM public.invoices WHERE id = current_setting('t.i1')::int), false);
SELECT pg_temp.login_anon();
SELECT pg_temp.throws(format($$SELECT public.request_quotation('{"name":"A","email":"bad","phone":"0771234567"}', '[{"variant_id":%s,"quantity":1}]')$$, current_setting('t.vms')),
                      '22023', 'a bad email', 'invalid_email:%');
SELECT pg_temp.throws($$SELECT public.request_quotation('{"name":"A","email":"a@b.lk","phone":"0771234567"}', '[]')$$, '22023', 'no products', 'invalid_quote_request:%');
SELECT set_config('t.wq', public.request_quotation(
  '{"name":"Ruwan","company":"Ruwan Traders","email":"Ruwan@Traders.lk","phone":"077 123 4567","note":"Need by Friday"}',
  jsonb_build_array(jsonb_build_object('variant_id', current_setting('t.vlt')::int, 'quantity', 3),
                    jsonb_build_object('variant_id', current_setting('t.vms')::int, 'quantity', 2)))::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', q ->> 'number', q ->> 'total', q ->> 'email') FROM (SELECT current_setting('t.wq')::jsonb AS q) x),
                  'QT-0003|310000.00|ruwan@traders.lk', 'a numbered quotation priced from the catalogue');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', p #>> '{quotation,bill_to_company}', jsonb_array_length(p -> 'items'), p #>> '{items,0,warranty}')
                     FROM (SELECT public.get_public_quotation((current_setting('t.wq')::jsonb ->> 'id')::int, (current_setting('t.wq')::jsonb ->> 'token')::uuid) AS p) x),
                  'Ruwan Traders|2|1 Year', 'its private link shows it (with each item''s warranty)');
SELECT pg_temp.eq(public.get_public_quotation((current_setting('t.wq')::jsonb ->> 'id')::int, gen_random_uuid()), NULL::jsonb, 'a wrong token shows nothing');
SELECT pg_temp.eq(public.get_public_quotation(current_setting('t.i1')::int, current_setting('t.i1tok')::uuid),
                  NULL::jsonb, 'invoices are never shown through it');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s|%s', channel, status, request_note) FROM public.invoices WHERE id = (current_setting('t.wq')::jsonb ->> 'id')::int),
                  'website|issued|Need by Friday', 'it lands in Quotations as a website request');
