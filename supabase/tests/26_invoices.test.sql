-- 26_invoices.test.sql — the invoice settings row (from the workbook), privileges, draft saves
-- (settings defaults, money and rounding, lines replaced, validation, the optimistic lock), issuing
-- (gapless numbers, stock taken, refusals that leave nothing behind), the issued lock, payments,
-- back to draft, void, delete, deleted catalogue items, the lookups, the summary — and serial
-- numbers (one per unit: sold to the line on issue, given back on draft/void, refused when sold
-- elsewhere, found by a scan).
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('nimal@shop.test')::text, false);
UPDATE public.customers SET first_name = 'Nimal', last_name = 'Perera', phone = '+94771234567', city = 'Kandy'
 WHERE id = current_setting('t.shopper')::uuid;

INSERT INTO public.categories (id, name) VALUES ('inv-cat', 'Invoice tests');
INSERT INTO public.products (slug, brand, name, category_id, warranty_months)
VALUES ('inv-laptop', 'InvBrand', 'Inv Laptop 15', 'inv-cat', 12),
       ('inv-mouse', 'InvBrand', 'Inv Mouse', 'inv-cat', NULL);
INSERT INTO public.product_variants (product_id, sku, name, price, position)
SELECT p.id, v.sku, v.name, v.price, v.pos
  FROM public.products p
  JOIN (VALUES ('inv-laptop', 'INV-LT-8', '8GB / 256GB', 150000, 0),
               ('inv-laptop', 'INV-LT-16', '16GB / 512GB', 180000, 1),
               ('inv-mouse', 'INV-MS-1', 'Standard', 2500, 0)) AS v(slug, sku, name, price, pos) ON v.slug = p.slug;
SELECT set_config('t.v8', (SELECT id::text FROM public.product_variants WHERE sku = 'INV-LT-8'), false);
SELECT set_config('t.v16', (SELECT id::text FROM public.product_variants WHERE sku = 'INV-LT-16'), false);
SELECT set_config('t.vms', (SELECT id::text FROM public.product_variants WHERE sku = 'INV-MS-1'), false);
INSERT INTO public.inventory (variant_id, stock_level) VALUES
  (current_setting('t.v8')::int, 5),      -- tracked: 5 on hand
  (current_setting('t.vms')::int, 10);    -- tracked: 10 on hand (16GB stays untracked)
-- two serial-numbered units of the 8GB on the shelf (25's register)
INSERT INTO public.product_units (variant_id, product_id, serial_number)
SELECT current_setting('t.v8')::int, 0, sn FROM unnest(ARRAY['SN-A1', 'SN-A2']) AS sn;
CREATE FUNCTION pg_temp.unit(p_serial text) RETURNS text LANGUAGE sql AS $$
  SELECT format('%s|%s', status, CASE WHEN invoice_item_id IS NULL THEN '-' ELSE 'line' END)
    FROM public.product_units WHERE upper(serial_number) = upper(p_serial) ORDER BY id LIMIT 1
$$;

CREATE FUNCTION pg_temp.stock(p_variant text) RETURNS int LANGUAGE sql AS $$
  SELECT stock_level FROM public.inventory WHERE variant_id = current_setting(p_variant)::int
$$;
CREATE FUNCTION pg_temp.inv(p_id text) RETURNS public.invoices LANGUAGE sql AS $$
  SELECT * FROM public.invoices WHERE id = current_setting(p_id)::int
$$;

-- ── 1. the settings row, from the client's workbook ─────────────────────────
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s|%s|%s', number_prefix, number_digits, next_number, address_lines[1],
                                 phone, cardinality(default_notes), footer_tagline) FROM public.invoice_settings),
                  'INV-|4|1|3F14, UNITY PLAZA BUILDING,|+94 76 074 4952|10|OUR VISION | YOUR SOLUTION',
                  'one settings row: numbering INV-0001, the workbook header and its ten notes');
SELECT pg_temp.eq((SELECT default_notes[7] FROM public.invoice_settings),
                  'The warranty period shall be 14 working days shorter than the stated warranty period.',
                  'notes are stored verbatim, without their numbers');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', default_tax_rate, default_deduct_stock, default_show_bank_details) FROM public.invoice_settings),
                  '0.00|t|f', 'defaults: no VAT / tax, take stock, no bank details');

-- ── 2. privileges ───────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT 1 FROM public.invoices LIMIT 1', '42501', 'anon cannot read invoices');
SELECT pg_temp.throws('SELECT 1 FROM public.invoice_settings LIMIT 1', '42501', 'anon cannot read the invoice settings');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{}')$$, '42501', 'anon cannot execute admin_save_invoice');
SELECT pg_temp.throws($$SELECT * FROM public.admin_invoice_product_search('x')$$, '42501', 'anon cannot search the catalogue for invoices');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.invoice_settings), 0::bigint, 'a shopper sees no settings row (RLS)');
SELECT pg_temp.eq(pg_temp.affected('UPDATE public.invoice_settings SET next_number = 50'), 0::bigint, 'a shopper cannot change the numbering (RLS: 0 rows)');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{"bill_to_name":"x"}')$$, '42501',
                      'a shopper is refused by the in-body admin check', 'not_authorised:%');
SELECT pg_temp.throws($$SELECT public.admin_invoice_summary()$$, '42501', 'a shopper cannot read the invoice figures', 'not_authorised:%');
SELECT pg_temp.throws($$SELECT * FROM public.admin_invoice_client_search('a')$$, '42501', 'a shopper cannot search clients', 'not_authorised:%');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$INSERT INTO public.invoices (bill_to_name) VALUES ('direct')$$, '42501', 'even an admin cannot insert invoices directly (RPCs only)');
SELECT pg_temp.throws($$INSERT INTO public.invoice_items (invoice_id, description, quantity, unit_price, amount) VALUES (1, 'x', 1, 1, 1)$$,
                      '42501', 'nor lines');
SELECT pg_temp.throws($$DELETE FROM public.invoice_settings$$, '42501', 'nobody deletes the settings row');
SELECT pg_temp.logout();

-- ── 3. a draft: settings defaults, snapshots, money ─────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.r1', public.admin_save_invoice(
  '{"bill_to_name":"  Acme Holdings  ","bill_to_email":"Accounts@Acme.LK","bill_to_phone":"0112 345 678","bill_to_city":"Colombo 03",
    "bill_to_address":"12, Main Street,\nKollupitiya"}',
  jsonb_build_array(
    jsonb_build_object('variant_id', current_setting('t.v8')::int, 'product_id', 999999, 'description', 'Inv Laptop 15 — 8GB / 256GB',
                       'warranty', '1 Year', 'quantity', 2, 'unit_price', 150000),
    jsonb_build_object('description', 'Setup & data transfer', 'quantity', 1.5, 'unit_price', 2500.5)))::text, false);
SELECT pg_temp.logout();
SELECT set_config('t.id1', current_setting('t.r1')::jsonb #>> '{invoice,id}', false);

SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', r ->> 'created', r #>> '{invoice,status}', r #> '{invoice,number}', jsonb_array_length(r -> 'items'))
                     FROM (SELECT current_setting('t.r1')::jsonb AS r) x),
                  'true|draft|null|2', 'create returns {invoice, items, payments, created}: a draft with no number');
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s', bill_to_name, bill_to_email, bill_to_address, issue_date = (now() AT TIME ZONE 'Asia/Colombo')::date,
                                 created_by = current_setting('t.owner')::uuid)
                     FROM pg_temp.inv('t.id1')),
                  E'Acme Holdings|accounts@acme.lk|12, Main Street,\nKollupitiya|t|t',
                  'trimmed name, lower-cased email, line breaks kept, dated today (Sri Lanka), created by the admin');
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s|%s', cardinality(notes), due_date, payment_terms, deduct_stock, show_bank_details, tax_value)
                     FROM pg_temp.inv('t.id1')),
                  '10|||t|f|0.00', 'absent keys start from the settings (notes, stock, bank, tax) — no due date by default');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s:%s', position, product_id = (SELECT id FROM public.products WHERE slug = 'inv-laptop'),
                                            amount, stock_taken), ' ' ORDER BY position)
                     FROM public.invoice_items WHERE invoice_id = current_setting('t.id1')::int),
                  '0:t:300000.00:0 1::3750.75:0',
                  'a variant line takes its product from the variant (not the caller); a free-text line links nothing; amounts are qty × price');
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s|%s|%s', subtotal, discount_amount, tax_amount, total, balance_due, item_count, payment_status)
                     FROM pg_temp.inv('t.id1')),
                  '303750.75|0.00|0.00|303750.75|303750.75|2|unpaid', 'the database derives the totals');

-- rounding: 3 × 333.33 = 999.99 · 10 % = 99.999 → 100.00 · 18 % of 899.99 = 161.9982 → 162.00
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_save_invoice(jsonb_build_object('id', current_setting('t.id1')::int, 'discount_type', 'percent', 'discount_value', 10,
                                                    'tax_type', 'percent', 'tax_value', 18),
                                 '[{"description":"Widget","quantity":3,"unit_price":333.33}]');
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', subtotal, discount_amount, tax_amount, total) FROM pg_temp.inv('t.id1')),
                  '999.99|100.00|162.00|1061.99', 'percent discount and VAT / tax round half up to cents, tax on (subtotal − discount)');
SELECT pg_temp.eq((SELECT count(*) FROM public.invoice_items WHERE invoice_id = current_setting('t.id1')::int), 1::bigint,
                  'a draft''s lines are replaced by the list sent');
SELECT public.admin_save_invoice(jsonb_build_object('id', current_setting('t.id1')::int, 'discount_type', 'amount', 'discount_value', 5000,
                                                    'tax_type', 'amount', 'tax_value', 250));
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', subtotal, discount_amount, tax_amount, total) FROM pg_temp.inv('t.id1')),
                  '999.99|999.99|250.00|250.00', 'an amount discount is capped at the subtotal; an amount tax is added as is');
SELECT pg_temp.eq((SELECT count(*) FROM public.invoice_items WHERE invoice_id = current_setting('t.id1')::int), 1::bigint,
                  'p_items NULL leaves the lines alone');

-- ── 4. validation ───────────────────────────────────────────────────────────
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{"colour":"red"}')$$, '22023', 'unknown keys are refused',
                      'invalid_invoice:The field “colour” can''t be saved here.');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{"total":5}')$$, '22023', 'derived keys are refused', '%works it out%');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{"issue_date":"2026-02-30"}')$$, '22023', 'an impossible date is refused',
                      'invalid_invoice:The invoice date must be a date%');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{"issue_date":"2026-10-06","due_date":"2026-10-01"}')$$, '23514',
                      'a due date before the invoice date is refused', '%invoices_dates_valid%');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{"bill_to_email":"not-an-email"}')$$, '23514', 'a malformed email is refused', '%invoices_email_valid%');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{"discount_type":"percent","discount_value":120}')$$, '23514',
                      'a discount above 100 % is refused', '%invoices_discount_valid%');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{"discount_type":"fixed"}')$$, '22023', 'discount types are amount or percent', 'invalid_invoice:%');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{"order_id":"X-1"}')$$, '22023', 'order numbers look like DO-10042', '%DO-10042%');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{"order_id":"do-99999999"}')$$, '23503', 'an unknown order is refused (FK)', '%invoices_order_id_fkey%');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{}', '[{"quantity":1,"unit_price":1}]')$$, '22023', 'a line needs a description',
                      'invalid_item:Line 1: the description is required.');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{}', '[{"description":"x","quantity":0,"unit_price":1}]')$$, '22023',
                      'a quantity must be above 0', 'invalid_item:Line 1: the quantity must be a number above 0%');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{}', '[{"description":"x","quantity":1.234,"unit_price":1}]')$$, '22023',
                      'quantities have at most 2 decimals', 'invalid_item:%');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{}', '[{"description":"x","quantity":1}]')$$, '22023', 'a line needs a unit price',
                      'invalid_item:Line 1 needs a unit price%');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{}', '[{"description":"x","quantity":1,"unit_price":1,"variant_id":99999999}]')$$, '22023',
                      'a vanished catalogue item is reported', '%no longer exists%');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{}', '[{"description":"x","quantity":1,"unit_price":1,"colour":"red"}]')$$, '22023',
                      'unknown line keys are refused', 'invalid_item:Line 1: the field “colour”%');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{}', (SELECT jsonb_agg('{"description":"x","quantity":1,"unit_price":1}'::jsonb) FROM generate_series(1, 201)))$$,
                      '22023', 'at most 200 lines', '%at most 200 lines%');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{"id":99999999}')$$, '22023', 'an unknown id is reported', 'invoice_not_found:%');
SELECT pg_temp.eq((SELECT count(*) FROM public.invoices), 1::bigint, 'refused saves created nothing');

-- the optimistic lock: a save based on an older copy is refused
SELECT set_config('t.seen', (SELECT updated_at::text FROM pg_temp.inv('t.id1')), false);
SELECT public.admin_save_invoice(jsonb_build_object('id', current_setting('t.id1')::int, 'expected_updated_at', current_setting('t.seen'),
                                                    'reference', 'PO-77'));
SELECT pg_temp.eq((SELECT reference FROM pg_temp.inv('t.id1')), 'PO-77', 'a save with the current updated_at goes through');
SELECT pg_temp.throws(format($$SELECT public.admin_save_invoice('{"id":%s,"expected_updated_at":"%s","reference":"PO-78"}')$$,
                             current_setting('t.id1'), current_setting('t.seen')),
                      '22023', 'a save from a stale copy is refused', 'invoice_changed:%');

-- ── 5. issue: number, stock, refusals that leave nothing behind ─────────────
SELECT public.admin_save_invoice(
  jsonb_build_object('id', current_setting('t.id1')::int, 'discount_type', 'amount', 'discount_value', 0, 'tax_type', 'percent', 'tax_value', 0),
  jsonb_build_array(
    jsonb_build_object('variant_id', current_setting('t.v8')::int, 'description', 'Inv Laptop 15 — 8GB / 256GB',
                       'warranty', '1 Year', 'quantity', 2, 'unit_price', 150000),
    jsonb_build_object('variant_id', current_setting('t.v16')::int, 'description', 'Inv Laptop 15 — 16GB / 512GB', 'quantity', 1, 'unit_price', 180000),
    jsonb_build_object('description', 'Setup & data transfer', 'quantity', 1.5, 'unit_price', 2500.5)));
SELECT set_config('t.i1', public.admin_issue_invoice(current_setting('t.id1')::int)::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s', number, status, issued_at IS NOT NULL, stock_deducted, total) FROM pg_temp.inv('t.id1')),
                  'INV-0001|issued|t|t|483750.75', 'issuing gives the first number and takes the stock');
SELECT pg_temp.eq(current_setting('t.i1')::jsonb #>> '{invoice,number}', 'INV-0001', 'issue returns the invoice');
SELECT pg_temp.eq((SELECT next_number FROM public.invoice_settings), 2, 'the counter moves on');
SELECT pg_temp.eq(pg_temp.stock('t.v8'), 3, 'the tracked variant lost 2 units');
SELECT pg_temp.eq((SELECT count(*) FROM public.inventory WHERE variant_id = current_setting('t.v16')::int), 0::bigint, 'an untracked variant stays untracked');
SELECT pg_temp.eq((SELECT string_agg(stock_taken::text, ',' ORDER BY position) FROM public.invoice_items WHERE invoice_id = current_setting('t.id1')::int),
                  '2,0,0', 'each line remembers what it took');
SELECT pg_temp.throws(format('SELECT public.admin_issue_invoice(%s)', current_setting('t.id1')), '22023', 'issuing twice is refused',
                      'invoice_already_issued:INV-0001 is already issued.');

-- not enough stock: refused, and the number is NOT used up
SELECT set_config('t.id2', (public.admin_save_invoice('{"bill_to_name":"Beta Traders"}',
  jsonb_build_array(jsonb_build_object('variant_id', current_setting('t.v8')::int, 'description', 'Inv Laptop 15', 'quantity', 4, 'unit_price', 150000)))
  #>> '{invoice,id}'), false);
SELECT pg_temp.throws(format('SELECT public.admin_issue_invoice(%s)', current_setting('t.id2')), '22023', 'more than the stock on hand is refused',
                      'insufficient_stock:Only 3 of “Inv Laptop 15 (8GB / 256GB)” in stock — this invoice needs 4.%');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', status, number, next_number) FROM pg_temp.inv('t.id2'), public.invoice_settings),
                  'draft||2', 'the refused issue left the draft, the counter (no gap) …');
SELECT pg_temp.eq(pg_temp.stock('t.v8'), 3, '… and the stock untouched');
-- a stock-tracked line moves whole units
SELECT set_config('t.id3', (public.admin_save_invoice('{"bill_to_name":"Gamma"}',
  jsonb_build_array(jsonb_build_object('variant_id', current_setting('t.v8')::int, 'description', 'Half a laptop', 'quantity', 1.5, 'unit_price', 1)))
  #>> '{invoice,id}'), false);
SELECT pg_temp.throws(format('SELECT public.admin_issue_invoice(%s)', current_setting('t.id3')), '22023', 'a fractional quantity of a tracked item is refused',
                      'invalid_quantity:Line 1 (“Half a laptop”)%');
-- incomplete drafts
SELECT set_config('t.id4', (public.admin_save_invoice('{}', '[{"description":"x","quantity":1,"unit_price":1}]') #>> '{invoice,id}'), false);
SELECT pg_temp.throws(format('SELECT public.admin_issue_invoice(%s)', current_setting('t.id4')), '22023', 'issuing needs the client''s name',
                      'invoice_incomplete:Add the client''s name before issuing.');
SELECT public.admin_save_invoice(jsonb_build_object('id', current_setting('t.id4')::int, 'bill_to_name', 'Delta'), '[]');
SELECT pg_temp.throws(format('SELECT public.admin_issue_invoice(%s)', current_setting('t.id4')), '22023', 'issuing needs a line',
                      'invoice_incomplete:Add at least one line before issuing.');
-- switching stock off issues without touching inventory
SELECT public.admin_save_invoice(jsonb_build_object('id', current_setting('t.id2')::int, 'deduct_stock', false));
SELECT public.admin_issue_invoice(current_setting('t.id2')::int);
SELECT pg_temp.eq((SELECT format('%s|%s', number, stock_deducted) FROM pg_temp.inv('t.id2')), 'INV-0002|f', 'without stock taking: the next number, no stock');
SELECT pg_temp.eq(pg_temp.stock('t.v8'), 3, 'stock unchanged by an invoice that does not take stock');

-- ── 6. an issued invoice: money fixed, words editable ───────────────────────
SELECT pg_temp.throws(format($$SELECT public.admin_save_invoice('{"id":%s,"discount_value":100}')$$, current_setting('t.id1')), '22023',
                      'the discount of an issued invoice is fixed', 'invoice_locked:INV-0001 is issued%');
SELECT pg_temp.throws(format($$SELECT public.admin_save_invoice('{"id":%s,"issue_date":"2026-01-01"}')$$, current_setting('t.id1')), '22023',
                      'so is its date', 'invoice_locked:%');
-- the full form with unchanged locked values goes through, and the client details change
SELECT public.admin_save_invoice(jsonb_build_object('id', current_setting('t.id1')::int, 'issue_date', (SELECT issue_date FROM pg_temp.inv('t.id1')),
                                                    'discount_type', 'amount', 'discount_value', 0, 'tax_type', 'percent', 'tax_value', 0,
                                                    'deduct_stock', true, 'bill_to_name', 'Acme Holdings (Pvt) Ltd'),
  (SELECT jsonb_agg(jsonb_build_object('id', id, 'variant_id', variant_id, 'description', description || ' — boxed', 'quantity', quantity,
                                       'unit_price', unit_price, 'serial_numbers', CASE WHEN position = 0 THEN '["sn-a1", "SN-A2"]'::jsonb END) ORDER BY position)
     FROM public.invoice_items WHERE invoice_id = current_setting('t.id1')::int));
SELECT pg_temp.eq((SELECT format('%s|%s|%s', bill_to_name, total, status) FROM pg_temp.inv('t.id1')),
                  'Acme Holdings (Pvt) Ltd|483750.75|issued', 'client details of an issued invoice can be corrected');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', description, serial_numbers, stock_taken) FROM public.invoice_items
                    WHERE invoice_id = current_setting('t.id1')::int AND position = 0),
                  'Inv Laptop 15 — 8GB / 256GB — boxed|{sn-a1,SN-A2}|2', 'line words and serial numbers can be added after issuing');
SELECT pg_temp.eq(pg_temp.unit('SN-A1') || ' ' || pg_temp.unit('SN-A2'), 'sold|line sold|line',
                  'serials added to an issued invoice sell those units to the line (matched in any case)');
SELECT pg_temp.eq((SELECT serial_search FROM pg_temp.inv('t.id1')), 'sn-a1 SN-A2', 'the invoice can be found by its serials');
SELECT pg_temp.throws(format($$SELECT public.admin_save_invoice('{"id":%s}', (SELECT jsonb_agg(jsonb_build_object('id', id, 'description', description, 'quantity', quantity + 1)) FROM public.invoice_items WHERE invoice_id = %s))$$,
                             current_setting('t.id1'), current_setting('t.id1')),
                      '22023', 'quantities of an issued invoice are fixed', 'invoice_locked:%quantities, prices%');
SELECT pg_temp.throws(format($$SELECT public.admin_save_invoice('{"id":%s}', (SELECT jsonb_agg(jsonb_build_object('id', id, 'description', description)) FROM public.invoice_items WHERE invoice_id = %s AND position < 2))$$,
                             current_setting('t.id1'), current_setting('t.id1')),
                      '22023', 'lines of an issued invoice cannot be removed', 'invoice_locked:%added or removed%');

-- ── 7. payments ─────────────────────────────────────────────────────────────
SELECT pg_temp.throws(format($$SELECT public.admin_record_invoice_payment(%s, 100, (now() AT TIME ZONE 'Asia/Colombo')::date, 'cash')$$, current_setting('t.id4')),
                      '22023', 'a draft takes no payments', 'invoice_not_issued:%');
SELECT public.admin_record_invoice_payment(current_setting('t.id1')::int, 100000, (now() AT TIME ZONE 'Asia/Colombo')::date, 'cash', ' RCPT-9 ', '  ');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', payment_status, amount_paid, balance_due) FROM pg_temp.inv('t.id1')),
                  'partial|100000.00|383750.75', 'a part payment: partially paid, the balance falls');
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', method, reference, note, created_by = current_setting('t.owner')::uuid) FROM public.invoice_payments
                    WHERE invoice_id = current_setting('t.id1')::int),
                  'cash|RCPT-9||t', 'the payment row: trimmed reference, blank note dropped, recorded by the admin');
SELECT pg_temp.throws(format($$SELECT public.admin_record_invoice_payment(%s, 400000, (now() AT TIME ZONE 'Asia/Colombo')::date, 'cash')$$, current_setting('t.id1')),
                      '22023', 'more than the balance is refused',
                      'overpayment:The balance due on INV-0001 is Rs. 383,750.75 — a payment can''t be more than that.');
SELECT pg_temp.throws(format($$SELECT public.admin_record_invoice_payment(%s, 10, (now() AT TIME ZONE 'Asia/Colombo')::date + 2, 'cash')$$, current_setting('t.id1')),
                      '22023', 'a payment dated in the future is refused', 'invalid_payment:%future%');
SELECT pg_temp.throws(format($$SELECT public.admin_record_invoice_payment(%s, 10, (now() AT TIME ZONE 'Asia/Colombo')::date, 'crypto')$$, current_setting('t.id1')),
                      '22023', 'an unknown method is refused', 'invalid_payment:%');
SELECT pg_temp.throws(format($$SELECT public.admin_record_invoice_payment(%s, 0.001, (now() AT TIME ZONE 'Asia/Colombo')::date, 'cash')$$, current_setting('t.id1')),
                      '22023', 'amounts are in rupees and cents', 'invalid_payment:%');
SELECT public.admin_record_invoice_payment(current_setting('t.id1')::int, 383750.75, (now() AT TIME ZONE 'Asia/Colombo')::date - 1, 'bank_transfer', 'BOC-123');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', payment_status, amount_paid, balance_due) FROM pg_temp.inv('t.id1')),
                  'paid|483750.75|0.00', 'paid in full');
SELECT pg_temp.throws(format($$SELECT public.admin_record_invoice_payment(%s, 1, (now() AT TIME ZONE 'Asia/Colombo')::date, 'cash')$$, current_setting('t.id1')),
                      '22023', 'nothing more can be paid', 'overpayment:INV-0001 is already paid in full.');
SELECT pg_temp.throws(format('SELECT public.admin_revert_invoice(%s)', current_setting('t.id1')), '22023', 'back to draft is refused while payments exist',
                      'invoice_has_payments:INV-0001 has 2 payments recorded. Delete them first%');
SELECT pg_temp.throws(format('SELECT public.admin_void_invoice(%s)', current_setting('t.id1')), '22023', 'void is refused while payments exist',
                      'invoice_has_payments:%');
SELECT public.admin_delete_invoice_payment((SELECT max(id) FROM public.invoice_payments));
SELECT pg_temp.eq((SELECT format('%s|%s', payment_status, balance_due) FROM pg_temp.inv('t.id1')), 'partial|383750.75', 'deleting a payment re-opens the balance');
SELECT pg_temp.throws('SELECT public.admin_delete_invoice_payment(99999999)', '22023', 'an unknown payment is reported', 'payment_not_found:%');
SELECT public.admin_delete_invoice_payment((SELECT max(id) FROM public.invoice_payments));

-- ── 8. back to draft and issue again: same number, stock returned and re-taken ──
SELECT public.admin_revert_invoice(current_setting('t.id1')::int);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', status, number, stock_deducted, payment_status) FROM pg_temp.inv('t.id1')),
                  'draft|INV-0001|f|unpaid', 'back to draft keeps the number');
SELECT pg_temp.eq(pg_temp.stock('t.v8'), 5, 'and returns the 2 units');
SELECT pg_temp.eq(pg_temp.unit('SN-A1') || ' ' || pg_temp.unit('SN-A2'), 'in_stock|- in_stock|-', 'and its serials go back on the shelf');
SELECT pg_temp.eq((SELECT sum(stock_taken) FROM public.invoice_items WHERE invoice_id = current_setting('t.id1')::int), 0::bigint, 'lines hold no stock any more');
SELECT pg_temp.throws(format('SELECT public.admin_revert_invoice(%s)', current_setting('t.id1')), '22023', 'a draft cannot go back to draft', 'invoice_not_issued:%');
SELECT public.admin_save_invoice(jsonb_build_object('id', current_setting('t.id1')::int, 'discount_value', 750.75),
  jsonb_build_array(jsonb_build_object('variant_id', current_setting('t.v8')::int, 'description', 'Inv Laptop 15 — 8GB / 256GB', 'quantity', 1, 'unit_price', 150000)));
SELECT public.admin_issue_invoice(current_setting('t.id1')::int);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', number, total, stock_deducted) FROM pg_temp.inv('t.id1')), 'INV-0001|149249.25|t',
                  'issued again: the same number, the new figures');
SELECT pg_temp.eq((SELECT next_number FROM public.invoice_settings), 3, 'no number was used up by issuing again');
SELECT pg_temp.eq(pg_temp.stock('t.v8'), 4, 'the new quantity was taken');

-- ── 9. void, delete ─────────────────────────────────────────────────────────
SELECT public.admin_void_invoice(current_setting('t.id1')::int, '  Client cancelled  ');
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', status, number, void_reason, voided_at IS NOT NULL) FROM pg_temp.inv('t.id1')),
                  'void|INV-0001|Client cancelled|t', 'void keeps the number and the reason');
SELECT pg_temp.eq(pg_temp.stock('t.v8'), 5, 'void returns the stock');
SELECT pg_temp.throws(format($$SELECT public.admin_save_invoice('{"id":%s,"reference":"x"}')$$, current_setting('t.id1')), '22023',
                      'a void invoice cannot change', 'invoice_void:INV-0001 is void%');
SELECT pg_temp.throws(format('SELECT public.admin_issue_invoice(%s)', current_setting('t.id1')), '22023', 'nor be issued', 'invoice_void:%');
SELECT pg_temp.throws(format('SELECT public.admin_void_invoice(%s)', current_setting('t.id1')), '22023', 'nor voided twice', 'invoice_void:%');
SELECT pg_temp.throws(format($$SELECT public.admin_record_invoice_payment(%s, 1, (now() AT TIME ZONE 'Asia/Colombo')::date, 'cash')$$, current_setting('t.id1')),
                      '22023', 'nor take payments', 'invoice_void:%');
SELECT pg_temp.throws(format('SELECT public.admin_delete_invoice(%s)', current_setting('t.id1')), '22023', 'a numbered invoice is never deleted',
                      'invoice_numbered:INV-0001 has been issued, so it stays on record — void it instead.');
SELECT pg_temp.throws(format('SELECT public.admin_void_invoice(%s)', current_setting('t.id3')), '22023', 'a never-issued draft is deleted, not voided',
                      'invoice_not_issued:%');
SELECT pg_temp.eq((SELECT public.admin_delete_invoice(current_setting('t.id3')::int) ->> 'deleted_id'), current_setting('t.id3'), 'a never-issued draft can be deleted');
SELECT pg_temp.eq((SELECT count(*) FROM public.invoice_items WHERE invoice_id = current_setting('t.id3')::int), 0::bigint, 'its lines went with it');

-- ── 10. numbering: skip numbers in use, prefix and digits from the settings ─
UPDATE public.invoice_settings SET next_number = 1 WHERE id;       -- the admin sets the counter back by mistake
SELECT pg_temp.eq((SELECT updated_by FROM public.invoice_settings), current_setting('t.owner')::uuid, 'a settings edit records the admin');
SELECT public.admin_save_invoice(jsonb_build_object('id', current_setting('t.id4')::int),
  '[{"description":"Labour","quantity":1,"unit_price":5000}]');
SELECT public.admin_issue_invoice(current_setting('t.id4')::int);
SELECT pg_temp.eq((SELECT format('%s|%s', number, next_number) FROM pg_temp.inv('t.id4'), public.invoice_settings),
                  'INV-0003|4', 'numbers already in use are skipped — never a duplicate');
UPDATE public.invoice_settings SET number_prefix = 'DO/INV/', number_digits = 5 WHERE id;
SELECT set_config('t.id5', (public.admin_save_invoice('{"bill_to_name":"Epsilon","issue_date":"2026-01-10"}',
  '[{"description":"Repair","quantity":1,"unit_price":1000}]') #>> '{invoice,id}'), false);
SELECT public.admin_issue_invoice(current_setting('t.id5')::int);
SELECT pg_temp.eq((SELECT number FROM pg_temp.inv('t.id5')), 'DO/INV/00004', 'a new prefix and width apply to the next invoice');
SELECT pg_temp.throws($$UPDATE public.invoice_settings SET number_prefix = 'IN V' WHERE id$$, '23514', 'prefixes have no spaces',
                      '%invoice_settings_numbering_valid%');
SELECT pg_temp.throws($$UPDATE public.invoice_settings SET default_notes = array_fill('x'::text, ARRAY[21]) WHERE id$$, '23514', 'at most 20 notes',
                      '%invoice_settings_lists_valid%');
-- new defaults reach new invoices
UPDATE public.invoice_settings SET default_due_days = 14, default_tax_rate = 18, default_deduct_stock = false,
                                   default_payment_terms = '50% advance' WHERE id;
SELECT set_config('t.r6', public.admin_save_invoice('{"bill_to_name":"Zeta","issue_date":"2026-03-01"}')::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s', r #>> '{invoice,due_date}', r #>> '{invoice,tax_type}', r #>> '{invoice,tax_value}',
                                 r #>> '{invoice,deduct_stock}', r #>> '{invoice,payment_terms}')
                     FROM (SELECT current_setting('t.r6')::jsonb AS r) x),
                  '2026-03-15|percent|18.00|false|50% advance', 'a new invoice starts from the current defaults');

-- ── 11. a deleted catalogue item: the line keeps its words; void still works ─
SELECT set_config('t.id7', (public.admin_save_invoice('{"bill_to_name":"Eta"}',
  jsonb_build_array(jsonb_build_object('variant_id', current_setting('t.vms')::int, 'description', 'Inv Mouse', 'quantity', 2, 'unit_price', 2500)))
  #>> '{invoice,id}'), false);
SELECT public.admin_save_invoice(jsonb_build_object('id', current_setting('t.id7')::int, 'deduct_stock', true));
SELECT public.admin_issue_invoice(current_setting('t.id7')::int);
SELECT pg_temp.eq(pg_temp.stock('t.vms'), 8, 'the mouse stock was taken');
SELECT pg_temp.logout();
DELETE FROM public.products WHERE slug = 'inv-mouse';
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', description, variant_id, product_id, amount) FROM public.invoice_items WHERE invoice_id = current_setting('t.id7')::int),
                  'Inv Mouse|||5000.00', 'deleting the product keeps the invoice line (snapshot)');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_void_invoice(current_setting('t.id7')::int);
SELECT pg_temp.eq((SELECT status FROM pg_temp.inv('t.id7')), 'void', 'voiding with the item gone still works (nothing to return)');

-- ── 12. lookups ─────────────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', variant_id = current_setting('t.v16')::int, exact_sku, tracked, warranty_months)
                     FROM public.admin_invoice_product_search('inv-lt-16') LIMIT 1),
                  't|t|f|12', 'an exact SKU (any case) comes first — what a barcode scanner types');
SELECT pg_temp.eq((SELECT string_agg(sku, ',') FROM public.admin_invoice_product_search('invbrand  8GB')),
                  'INV-LT-8', 'every word must match somewhere (brand + variant)');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', tracked, stock_level, variant_count) FROM public.admin_invoice_product_search('INV-LT-8') LIMIT 1),
                  't|5|2', 'results carry stock and the variant count');
SELECT pg_temp.eq((SELECT count(*) FROM public.admin_invoice_product_search('no-such-thing-xyz')), 0::bigint, 'no match → no rows');
SELECT pg_temp.eq((SELECT count(*) <= 3 FROM public.admin_invoice_product_search('', 3)), true, 'the limit applies');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', source, name, invoice_count) FROM public.admin_invoice_client_search('acme')),
                  'invoice|Acme Holdings (Pvt) Ltd|1', 'past clients are found by name, latest details first');
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', source, name, customer_id = current_setting('t.shopper')::uuid, city)
                     FROM public.admin_invoice_client_search('nimal kandy')),
                  'customer|Nimal Perera|t|Kandy', 'registered customers are found too, with their account id');
SELECT public.admin_save_invoice('{"bill_to_name":"Nimal Perera","bill_to_email":"nimal@shop.test","bill_to_phone":"0771234567"}');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', count(*), min(source), bool_and(customer_id = current_setting('t.shopper')::uuid))
                     FROM public.admin_invoice_client_search('nimal')),
                  '1|invoice|t', 'one entry per client (same email): the invoiced details win, linked to the account');

-- ── 13. the summary ─────────────────────────────────────────────────────────
SELECT set_config('t.id8', (public.admin_save_invoice(
  jsonb_build_object('bill_to_name', 'Theta', 'issue_date', (now() AT TIME ZONE 'Asia/Colombo')::date - 10,
                     'due_date', (now() AT TIME ZONE 'Asia/Colombo')::date - 3, 'tax_value', 0),
  '[{"description":"Overdue work","quantity":1,"unit_price":1000}]') #>> '{invoice,id}'), false);
SELECT public.admin_issue_invoice(current_setting('t.id8')::int);
SELECT public.admin_record_invoice_payment(current_setting('t.id8')::int, 400, (now() AT TIME ZONE 'Asia/Colombo')::date, 'cash');
SELECT set_config('t.sum', public.admin_invoice_summary()::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s', s ->> 'overdue_count', s ->> 'overdue_total') FROM (SELECT current_setting('t.sum')::jsonb AS s) x),
                  '1|600.00', 'overdue = issued, unpaid balance, due before today');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', s ->> 'outstanding_count', (s ->> 'outstanding_total')::numeric, s ->> 'draft_count')
                     FROM (SELECT current_setting('t.sum')::jsonb AS s) x),
                  (SELECT format('%s|%s|%s', count(*) FILTER (WHERE status = 'issued' AND balance_due > 0),
                                 COALESCE(sum(balance_due) FILTER (WHERE status = 'issued' AND balance_due > 0), 0),
                                 count(*) FILTER (WHERE status = 'draft')) FROM public.invoices),
                  'outstanding and drafts match the rows');
SELECT pg_temp.eq((SELECT (s ->> 'received_30d_total')::numeric FROM (SELECT current_setting('t.sum')::jsonb AS s) x), 400.00,
                  'received in the last 30 days counts payments on issued invoices only');
SELECT pg_temp.logout();

-- ── 14. serial numbers on lines ─────────────────────────────────────────────
INSERT INTO public.product_units (variant_id, product_id, serial_number) VALUES (current_setting('t.v16')::int, 0, 'SN-B9');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', variant_id = current_setting('t.v8')::int, serial_number, units_in_stock)
                     FROM public.admin_invoice_product_search('sn-a1') LIMIT 1),
                  't|SN-A1|2', 'scanning an in-stock serial finds its variant first and returns the serial');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{"bill_to_name":"Iota"}',
                        '[{"description":"x","quantity":1,"unit_price":1,"serial_numbers":["A","B"]}]')$$, '22023',
                      'one serial per whole unit', 'too_many_serials:Line 1 has 2 serial numbers for a quantity of 1.');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{"bill_to_name":"Iota"}',
                        '[{"description":"x","quantity":1,"unit_price":1,"serial_numbers":["A"]},
                          {"description":"y","quantity":1,"unit_price":1,"serial_numbers":["a"]}]')$$, '22023',
                      'a serial appears once per invoice', 'duplicate_serial:S/N a is on two lines.');
SELECT pg_temp.throws($$SELECT public.admin_save_invoice('{"bill_to_name":"Iota"}',
                        '[{"description":"x","quantity":2,"unit_price":1,"serial_numbers":["A","a"]}]')$$, '22023',
                      'nor twice on one line', 'duplicate_serial:%');
SELECT set_config('t.id9', (public.admin_save_invoice(
  '{"bill_to_name":"Kappa","tax_value":0,"deduct_stock":true}',
  jsonb_build_array(
    jsonb_build_object('variant_id', current_setting('t.v8')::int, 'description', 'Inv Laptop 15', 'quantity', 2, 'unit_price', 150000,
                       'serial_numbers', '["SN-A1", "LEGACY-77"]'::jsonb),
    jsonb_build_object('description', 'Bag (free text)', 'quantity', 1, 'unit_price', 0, 'serial_numbers', '["BAG-1"]'::jsonb)))
  #>> '{invoice,id}'), false);
SELECT pg_temp.eq(pg_temp.unit('SN-A1'), 'in_stock|-', 'a DRAFT doesn''t sell its serials');
SELECT public.admin_issue_invoice(current_setting('t.id9')::int);
SELECT pg_temp.eq(pg_temp.unit('SN-A1'), 'sold|line', 'issuing sells the listed unit to the line');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_units WHERE serial_number IN ('LEGACY-77', 'BAG-1')), 0::bigint,
                  'a serial that isn''t in the register (older stock, free text) is only printed');
SELECT pg_temp.eq((SELECT count(*) FROM public.admin_invoice_product_search('SN-A1') WHERE serial_number IS NOT NULL), 0::bigint,
                  'a sold unit no longer scans as in stock');
SELECT pg_temp.eq(pg_temp.stock('t.v8'), 3, 'the count moved too (deduct_stock)');
-- another invoice can't sell the same unit
SELECT set_config('t.id10', (public.admin_save_invoice('{"bill_to_name":"Lambda","tax_value":0,"deduct_stock":false}',
  jsonb_build_array(jsonb_build_object('variant_id', current_setting('t.v8')::int, 'description', 'Inv Laptop 15', 'quantity', 1,
                                       'unit_price', 150000, 'serial_numbers', '["sn-a1"]'::jsonb))) #>> '{invoice,id}'), false);
SELECT pg_temp.throws(format('SELECT public.admin_issue_invoice(%s)', current_setting('t.id10')), '22023', 'a serial sold on another invoice is refused',
                      'serial_sold:Line 1: S/N SN-A1 was sold on %');
SELECT pg_temp.eq((SELECT format('%s|%s', status, number) FROM pg_temp.inv('t.id10')), 'draft|', 'the refused issue changed nothing');
-- a unit of another variant is refused
SELECT public.admin_save_invoice(jsonb_build_object('id', current_setting('t.id10')::int),
  jsonb_build_array(jsonb_build_object('variant_id', current_setting('t.v8')::int, 'description', 'Inv Laptop 15', 'quantity', 1,
                                       'unit_price', 150000, 'serial_numbers', '["SN-B9"]'::jsonb)));
SELECT pg_temp.throws(format('SELECT public.admin_issue_invoice(%s)', current_setting('t.id10')), '22023', 'a unit of another variant is refused',
                      'serial_other_variant:Line 1: S/N SN-B9%');
-- correcting a serial on the issued invoice re-matches the register
SELECT public.admin_save_invoice(jsonb_build_object('id', current_setting('t.id9')::int),
  (SELECT jsonb_agg(jsonb_build_object('id', id, 'description', description, 'quantity', quantity, 'unit_price', unit_price, 'variant_id', variant_id,
                                       'serial_numbers', CASE WHEN position = 0 THEN '["SN-A2", "LEGACY-77"]'::jsonb ELSE to_jsonb(serial_numbers) END)
                    ORDER BY position)
     FROM public.invoice_items WHERE invoice_id = current_setting('t.id9')::int));
SELECT pg_temp.eq(pg_temp.unit('SN-A1') || ' ' || pg_temp.unit('SN-A2'), 'in_stock|- sold|line',
                  'a serial taken off an issued line goes back; the new one is sold');
SELECT public.admin_void_invoice(current_setting('t.id9')::int);
SELECT pg_temp.eq(pg_temp.unit('SN-A2'), 'in_stock|-', 'void gives the serials back');
SELECT pg_temp.logout();
