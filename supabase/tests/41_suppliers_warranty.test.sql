-- 41_suppliers_warranty.test.sql — suppliers (visible only with "Suppliers"), stock received from a
-- supplier with the month, warranty records per unit (customer warranty filled in on sale, cleared if
-- the sale is undone), supplier fields hidden from staff without "Suppliers", and the search filters.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.today', ((now() AT TIME ZONE 'Asia/Colombo')::date)::text, false);
UPDATE public.app_config SET value = (now() - interval '400 days')::text WHERE name = 'stock_ledger_started';

INSERT INTO public.categories (id, name) VALUES ('sw-cat', 'Warranty tests');
INSERT INTO public.products (slug, brand, name, category_id, warranty_months) VALUES ('sw-laptop', 'SwBrand', 'Sw Laptop', 'sw-cat', 12);
INSERT INTO public.product_variants (product_id, sku, name, price) SELECT id, 'SW-LT', 'Standard', 100000 FROM public.products WHERE slug = 'sw-laptop';
SELECT set_config('t.v', (SELECT id::text FROM public.product_variants WHERE sku = 'SW-LT'), false);
INSERT INTO public.inventory (variant_id, stock_level) VALUES (current_setting('t.v')::int, 0);
INSERT INTO public.product_units (variant_id, product_id, serial_number)
SELECT current_setting('t.v')::int, 0, sn FROM unnest(ARRAY['SW-001', 'SW-002', 'SW-003']) sn;
CREATE FUNCTION pg_temp.req(p_method text, p_path text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.method', p_method, false), set_config('request.path', p_path, false)
$$;
CREATE FUNCTION pg_temp.unit(p_sn text) RETURNS int LANGUAGE sql AS $$ SELECT id FROM public.product_units WHERE serial_number = p_sn $$;

-- ── suppliers ───────────────────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO public.suppliers (name, contact_person, phone, email) VALUES ('Redline Distributors', 'Kasun', '0112345678', 'sales@redline.lk')$$),
                  1::bigint, 'the admin registers a supplier');
SELECT set_config('t.sup', (SELECT id::text FROM public.suppliers WHERE name = 'Redline Distributors'), false);
SELECT pg_temp.throws($$INSERT INTO public.suppliers (name) VALUES ('redline distributors')$$, '23505', 'names are unique (any case)');
SELECT set_config('t.clerk', (public.admin_create_staff('clerk@shop.test', 'Clerk2026x', 'Clerk', '{"warranty":"edit","inventory":"edit"}') ->> 'user_id'), false);
SELECT set_config('t.buyer', (public.admin_create_staff('buyer@shop.test', 'Buyer2026x', 'Buyer', '{"warranty":"edit","inventory":"edit","suppliers":"edit"}') ->> 'user_id'), false);
SELECT pg_temp.login(current_setting('t.clerk')::uuid);
SELECT pg_temp.req('GET', '/suppliers');
SELECT pg_temp.eq((SELECT count(*) FROM public.suppliers), 0::bigint, 'staff without "Suppliers" see no suppliers');
SELECT pg_temp.req('GET', '/inventory');
SELECT pg_temp.eq((SELECT count(*) FROM public.suppliers), 0::bigint, '… whatever section they are in');
SELECT pg_temp.login(current_setting('t.buyer')::uuid);
SELECT pg_temp.req('GET', '/suppliers');
SELECT pg_temp.eq((SELECT count(*) FROM public.suppliers), 1::bigint, 'staff with "Suppliers" do');
SELECT pg_temp.req('DELETE', '/suppliers');
SELECT pg_temp.eq(pg_temp.affected('DELETE FROM public.suppliers'), 0::bigint, 'but never delete one');

-- ── stock received from the supplier, stamped on the units ──────────────────
SELECT pg_temp.req('POST', '/rpc/admin_record_stock_receipt');
SELECT set_config('t.rec', public.admin_record_stock_receipt(current_setting('t.v')::int, 3, current_setting('t.sup')::int, DATE '2026-09-17',
  'GRN-55', NULL, NULL, ARRAY[pg_temp.unit('SW-001'), pg_temp.unit('SW-002'), pg_temp.unit('SW-003')],
  jsonb_build_object('supplier_start', '2026-09', 'supplier_expiry', '2027-09-16', 'supplier_coverage', 'Parts and labour, agent warranty'))::text, false);
SELECT pg_temp.req('', '');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s|%s', movement_type, qty_in, supplier_month) FROM public.stock_movements WHERE id = (current_setting('t.rec')::jsonb ->> 'movement_id')::bigint),
                  'received|3|2026-09-01', 'a delivery with its supplier and month');
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', count(*), min(supplier_received_month), min(supplier_start), min(supplier_expiry)) FROM public.unit_warranties),
                  '3|2026-09-01|2026-09-01|2027-09-16', 'the units carry the supplier warranty');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq((SELECT d ->> 'quantity' FROM jsonb_array_elements(public.admin_supplier_deliveries(current_setting('t.sup')::int)) d), '3', 'deliveries by supplier');

-- ── sold: the customer warranty starts; undone: it goes ─────────────────────
SELECT set_config('t.i', (public.admin_save_document('{"bill_to_name":"Client"}',
  jsonb_build_array(jsonb_build_object('variant_id', current_setting('t.v')::int, 'description', 'Sw Laptop', 'quantity', 1, 'unit_price', 100000,
                                       'warranty', '1 Year — store', 'serial_numbers', '["SW-002"]'::jsonb)),
  '{"sale_type":"credit","upfront_amount":0,"credit_days":10}', '{"doc_type":"invoice"}') #>> '{invoice,id}'), false);
SELECT public.admin_issue_invoice(current_setting('t.i')::int);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s|%s', customer_start = current_setting('t.today')::date, customer_expiry = (current_setting('t.today')::date + interval '12 months')::date, customer_coverage)
                     FROM public.unit_warranties WHERE unit_id = pg_temp.unit('SW-002')),
                  't|t|1 Year — store', 'sold: customer warranty from the sale date for the product''s 12 months');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_revert_invoice(current_setting('t.i')::int);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT customer_start FROM public.unit_warranties WHERE unit_id = pg_temp.unit('SW-002')), NULL::date, 'the sale undone: the automatic customer warranty is cleared');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_issue_invoice(current_setting('t.i')::int);

-- ── search ──────────────────────────────────────────────────────────────────
SELECT set_config('t.s', public.admin_warranty_search('sw-002')::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s', s ->> 'total', s #>> '{rows,0,supplier_name}', s #>> '{rows,0,supplier_valid}', s #>> '{rows,0,customer_valid}', s #>> '{rows,0,customer_name}')
                     FROM (SELECT current_setting('t.s')::jsonb AS s) x),
                  '1|Redline Distributors|true|true|Client', 'by serial: both warranties valid today, the client named');
SELECT pg_temp.eq((public.admin_warranty_search('sw laptop', 'in_stock') ->> 'total'), '2', 'by product name, in stock only');
SELECT pg_temp.eq((public.admin_warranty_search(NULL, 'supplier_expired') ->> 'total'), '0', 'nothing expired yet');
SELECT public.admin_save_warranty(ARRAY[pg_temp.unit('SW-001')], '{"supplier_expiry":"2026-01-01","supplier_start":"2025-01"}');
SELECT pg_temp.eq((public.admin_warranty_search(NULL, 'supplier_expired') -> 'rows' -> 0 ->> 'serial_number'), 'SW-001', 'an expired supplier warranty is found');
SELECT pg_temp.throws(format($$SELECT public.admin_save_warranty(ARRAY[%s], '{"customer_start":"2026-10","customer_expiry":"2026-01-01"}')$$, pg_temp.unit('SW-003')),
                      '22023', 'an expiry before its start', 'invalid_warranty:%');
-- staff without Suppliers: no supplier details, and can't change them
SELECT pg_temp.login(current_setting('t.clerk')::uuid);
SELECT pg_temp.req('POST', '/rpc/admin_warranty_search');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', s ->> 'supplier_hidden', COALESCE(s #>> '{rows,0,supplier_name}', '∅'), COALESCE(s #>> '{rows,0,supplier_expiry}', '∅'))
                     FROM (SELECT public.admin_warranty_search('sw-002') AS s) x),
                  'true|∅|∅', 'staff without "Suppliers" see the customer warranty only');
SELECT pg_temp.req('POST', '/rpc/admin_save_warranty');
SELECT pg_temp.throws(format($$SELECT public.admin_save_warranty(ARRAY[%s], '{"supplier_coverage":"x"}')$$, pg_temp.unit('SW-003')), '42501',
                      'nor change supplier warranty details', 'not_authorised:%supplier%');
SELECT public.admin_save_warranty(ARRAY[pg_temp.unit('SW-003')], '{"customer_coverage":"Display unit — 6 months","note":"Showroom"}');
SELECT pg_temp.req('', '');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s', customer_coverage, note) FROM public.unit_warranties WHERE unit_id = pg_temp.unit('SW-003')),
                  'Display unit — 6 months|Showroom', 'but they can record the customer warranty');
