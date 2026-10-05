-- 25_serial_numbers.test.sql — the unit register: privileges, recording serials per variant
-- (replace semantics, moves, duplicates, sold units protected), assigning serials to a web-order
-- line at fulfilment (in-stock units, unrecorded serials, other variants, limits), and a
-- cancelled order giving its serials back.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);

INSERT INTO public.categories (id, name) VALUES ('sn-cat', 'Serial tests');
INSERT INTO public.products (slug, brand, name, category_id) VALUES ('sn-laptop', 'SnBrand', 'Sn Laptop', 'sn-cat'), ('sn-other', 'SnBrand', 'Sn Other', 'sn-cat');
INSERT INTO public.product_variants (product_id, name, price, position)
SELECT p.id, v.name, v.price, v.pos FROM public.products p
  JOIN (VALUES ('sn-laptop', '8GB', 100000, 0), ('sn-laptop', '16GB', 120000, 1), ('sn-other', 'Standard', 5000, 0)) AS v(slug, name, price, pos)
    ON v.slug = p.slug;
SELECT set_config('t.pid', (SELECT id::text FROM public.products WHERE slug = 'sn-laptop'), false);
SELECT set_config('t.pother', (SELECT id::text FROM public.products WHERE slug = 'sn-other'), false);
SELECT set_config('t.v8', (SELECT v.id::text FROM public.product_variants v JOIN public.products p ON p.id = v.product_id WHERE p.slug = 'sn-laptop' AND v.name = '8GB'), false);
SELECT set_config('t.v16', (SELECT v.id::text FROM public.product_variants v JOIN public.products p ON p.id = v.product_id WHERE p.slug = 'sn-laptop' AND v.name = '16GB'), false);
SELECT set_config('t.vother', (SELECT v.id::text FROM public.product_variants v JOIN public.products p ON p.id = v.product_id WHERE p.slug = 'sn-other'), false);
INSERT INTO public.inventory (variant_id, stock_level) VALUES (current_setting('t.v8')::int, 5), (current_setting('t.v16')::int, 2);

CREATE FUNCTION pg_temp.serials(p_variant text, p_status text DEFAULT 'in_stock') RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(serial_number, ',' ORDER BY serial_number), '') FROM public.product_units
   WHERE variant_id = current_setting(p_variant)::int AND status = p_status
$$;
CREATE FUNCTION pg_temp.set_serials(p_v8 jsonb, p_v16 jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.admin_set_product_serials(current_setting('t.pid')::int,
           jsonb_build_array(jsonb_build_object('variant_id', current_setting('t.v8')::int, 'serials', p_v8))
           || CASE WHEN p_v16 IS NULL THEN '[]'::jsonb
                   ELSE jsonb_build_array(jsonb_build_object('variant_id', current_setting('t.v16')::int, 'serials', p_v16)) END)
$$;

-- ── 1. privileges ───────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT 1 FROM public.product_units LIMIT 1', '42501', 'anon cannot read the unit register');
SELECT pg_temp.throws($$SELECT public.admin_set_product_serials(1, '[]')$$, '42501', 'anon cannot record serials');
SELECT pg_temp.throws($$SELECT public.admin_assign_order_serials(1, '[]')$$, '42501', 'anon cannot assign serials');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.product_units), 0::bigint, 'a shopper sees no units (RLS)');
SELECT pg_temp.throws(format($$SELECT public.admin_set_product_serials(%s, '[]')$$, current_setting('t.pid')), '42501',
                      'a shopper is refused by the in-body admin check', 'not_authorised:%');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws(format($$INSERT INTO public.product_units (variant_id, serial_number) VALUES (%s, 'X')$$, current_setting('t.v8')),
                      '42501', 'even an admin writes units only through the RPCs');

-- ── 2. recording serials (the product editor) ───────────────────────────────
SELECT set_config('t.r1', pg_temp.set_serials('["  SN-A1 ", "SN-A2", "", "SN-A3"]', '["SN-B1"]')::text, false);
SELECT pg_temp.eq(pg_temp.serials('t.v8'), 'SN-A1,SN-A2,SN-A3', 'serials are recorded trimmed, blanks dropped');
SELECT pg_temp.eq(pg_temp.serials('t.v16'), 'SN-B1', 'per variant');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_units WHERE product_id = current_setting('t.pid')::int AND created_by = current_setting('t.owner')::uuid),
                  4::bigint, 'each unit knows its product and who recorded it');
SELECT pg_temp.eq(current_setting('t.r1')::jsonb #> '{variants,0,in_stock}', '["SN-A1", "SN-A2", "SN-A3"]'::jsonb, 'the result lists them in entry order');
SELECT set_config('t.idA2', (SELECT id::text FROM public.product_units WHERE serial_number = 'SN-A2'), false);
SELECT pg_temp.set_serials('["SN-A2", "SN-A4"]');
SELECT pg_temp.eq(pg_temp.serials('t.v8'), 'SN-A2,SN-A4', 'the list REPLACES the in-stock serials (A1, A3 removed; A4 added)');
SELECT pg_temp.eq((SELECT id::text FROM public.product_units WHERE serial_number = 'SN-A2'), current_setting('t.idA2'), 'a kept serial keeps its row');
SELECT pg_temp.eq(pg_temp.serials('t.v16'), 'SN-B1', 'a variant that is not listed is untouched');
SELECT pg_temp.set_serials('["SN-A2"]', '["SN-B1", "sn-a4"]');
SELECT pg_temp.eq(pg_temp.serials('t.v8') || ' | ' || pg_temp.serials('t.v16'), 'SN-A2 | SN-B1,sn-a4', 'a serial can move between two listed variants (any case)');
SELECT pg_temp.throws($$SELECT pg_temp.set_serials('["SN-X", "sn-x"]')$$, '22023', 'a serial listed twice is refused', 'duplicate_serial:%listed twice%');
SELECT pg_temp.throws($$SELECT pg_temp.set_serials('["SN-B1"]')$$, '22023', 'a serial in stock under a variant not in the call is refused',
                      'serial_taken:S/N SN-B1 is already in stock under another variant%');
SELECT pg_temp.throws($$SELECT pg_temp.set_serials('["SN-A2"]', '["SN-A2"]')$$, '22023', 'one serial under two variants is refused', 'duplicate_serial:%two variants%');
SELECT pg_temp.throws(format($$SELECT public.admin_set_product_serials(%s, jsonb_build_array(jsonb_build_object('variant_id', %s, 'serials', '[]'::jsonb)))$$,
                             current_setting('t.pid'), current_setting('t.vother')),
                      '22023', 'a variant of another product is refused', 'variant_not_in_product:%');
SELECT pg_temp.throws($$SELECT pg_temp.set_serials(to_jsonb(ARRAY[repeat('x', 101)]))$$, '22023', 'a serial is at most 100 characters', 'invalid_serials:%');
SELECT pg_temp.throws($$SELECT public.admin_set_product_serials(99999999, '[]')$$, '22023', 'an unknown product is reported', 'product_not_found:%');
-- another product may use the same serial
SELECT public.admin_set_product_serials(current_setting('t.pother')::int,
         jsonb_build_array(jsonb_build_object('variant_id', current_setting('t.vother')::int, 'serials', '["SN-A2"]'::jsonb)));
SELECT pg_temp.eq(pg_temp.serials('t.vother'), 'SN-A2', 'serials are unique within a product, not across products');

-- ── 3. a web order: assign serials at fulfilment ────────────────────────────
SELECT pg_temp.set_serials('["SN-A2", "SN-A5", "SN-A6"]', '["SN-B1", "sn-a4"]');
SELECT pg_temp.login_anon();
SELECT set_config('t.o1', public.place_order('buyer@shop.test', 'Kamal', 'Silva', '0771234567',
         '{"street":"1 Galle Road","city":"Colombo 03","district":"Colombo"}',
         jsonb_build_array(jsonb_build_object('product_id', current_setting('t.pid')::int, 'variant_id', current_setting('t.v8')::int, 'quantity', 2)))::text, false);
SELECT pg_temp.logout();
SELECT set_config('t.oid', current_setting('t.o1')::jsonb ->> 'order_id', false);
SELECT set_config('t.item', (SELECT id::text FROM public.order_items WHERE order_id = current_setting('t.oid')), false);
SELECT pg_temp.eq((SELECT stock_level FROM public.inventory WHERE variant_id = current_setting('t.v8')::int), 3,
                  'checkout takes the COUNT (5 → 3); the units stay in stock until serials are assigned');
SELECT pg_temp.eq(pg_temp.serials('t.v8'), 'SN-A2,SN-A5,SN-A6', 'three units still on the shelf');

SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.a1', public.admin_assign_order_serials(current_setting('t.item')::bigint, '["sn-a5", "SN-OLD-1"]')::text, false);
SELECT pg_temp.eq(current_setting('t.a1')::jsonb -> 'serials', '["SN-A5", "SN-OLD-1"]'::jsonb,
                  'an in-stock unit is matched in any case; an unrecorded serial is recorded');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', status, order_item_id::text = current_setting('t.item'), sold_at IS NOT NULL) FROM public.product_units WHERE serial_number = 'SN-A5'),
                  'sold|t|t', 'the unit is sold to the order line');
SELECT pg_temp.eq((SELECT format('%s|%s', status, variant_id::text = current_setting('t.v8')) FROM public.product_units WHERE serial_number = 'SN-OLD-1'),
                  'sold|t', 'an older unit without a record is recorded as sold, under the line''s variant');
SELECT pg_temp.eq(pg_temp.serials('t.v8'), 'SN-A2,SN-A6', 'the shelf now holds two');
SELECT pg_temp.throws(format($$SELECT public.admin_assign_order_serials(%s, '["SN-A2", "SN-A6", "SN-A5"]')$$, current_setting('t.item')), '22023',
                      'no more serials than the quantity', 'too_many_serials:3 serial numbers for 2 units%');
SELECT pg_temp.throws(format($$SELECT public.admin_assign_order_serials(%s, '["SN-B1"]')$$, current_setting('t.item')), '22023',
                      'a unit of another variant is refused', 'serial_other_variant:S/N SN-B1%');
SELECT public.admin_assign_order_serials(current_setting('t.item')::bigint, '["SN-A6", "SN-A5"]');
SELECT pg_temp.eq(pg_temp.serials('t.v8'), 'SN-A2,SN-OLD-1', 'a serial taken off the line goes back in stock (SN-OLD-1), the new one leaves (SN-A6)');
SELECT pg_temp.eq(pg_temp.serials('t.v8', 'sold'), 'SN-A5,SN-A6', 'the line holds exactly the serials sent');
-- a sold unit can't be put back in stock by the product editor
SELECT pg_temp.throws($$SELECT pg_temp.set_serials('["SN-A2", "SN-A5"]')$$, '22023', 'a sold serial can''t be listed as in stock',
                      'serial_sold:S/N SN-A5 was sold on order DO-%');
SELECT pg_temp.set_serials('["SN-A2"]');
SELECT pg_temp.eq(pg_temp.serials('t.v8', 'sold'), 'SN-A5,SN-A6', 'the editor never touches sold units');
-- a second order can't take a serial the first one holds
SELECT pg_temp.logout();
SELECT pg_temp.login_anon();
SELECT set_config('t.o2', public.place_order('buyer2@shop.test', 'Ravi', 'Kumar', '0771234568',
         '{"street":"2 Galle Road","city":"Colombo 03","district":"Colombo"}',
         jsonb_build_array(jsonb_build_object('product_id', current_setting('t.pid')::int, 'variant_id', current_setting('t.v8')::int, 'quantity', 1)))::text, false);
SELECT pg_temp.logout();
SELECT set_config('t.item2', (SELECT id::text FROM public.order_items WHERE order_id = current_setting('t.o2')::jsonb ->> 'order_id'), false);
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws(format($$SELECT public.admin_assign_order_serials(%s, '["SN-A6"]')$$, current_setting('t.item2')), '22023',
                      'a serial sold to another order is refused', 'serial_sold:S/N SN-A6 was sold on order DO-%');
SELECT pg_temp.throws('SELECT public.admin_assign_order_serials(99999999999, ''[]'')', '22023', 'an unknown line is reported', 'order_item_not_found:%');

-- ── 4. cancelling the order gives the serials back ──────────────────────────
SELECT public.admin_set_order_status(current_setting('t.oid'), 'cancelled');
SELECT pg_temp.eq(pg_temp.serials('t.v8'), 'SN-A2,SN-A5,SN-A6', 'a cancelled order''s serials are back in stock');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_units WHERE order_item_id = current_setting('t.item')::bigint), 0::bigint, 'and unlinked from the line');
SELECT pg_temp.throws(format($$SELECT public.admin_assign_order_serials(%s, '["SN-A2"]')$$, current_setting('t.item')), '22023',
                      'a cancelled order takes no serials', 'order_cancelled:%');
SELECT pg_temp.eq((SELECT public.admin_assign_order_serials(current_setting('t.item2')::bigint, '["SN-A6"]') -> 'serials'), '["SN-A6"]'::jsonb,
                  'the freed serial can now go with the other order');
SELECT pg_temp.logout();

-- ── 5. deleting the variant removes its units ───────────────────────────────
DELETE FROM public.products WHERE slug = 'sn-other';
SELECT pg_temp.eq((SELECT count(*) FROM public.product_units WHERE product_id = current_setting('t.pother')::int), 0::bigint,
                  'a deleted product takes its unit records with it');
