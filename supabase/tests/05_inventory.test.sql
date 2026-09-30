-- 05_inventory.test.sql — stock per variant, sealed table, narrow public availability window,
-- in-stock product list.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);

-- fixtures: P1 (A tracked+low, B tracked, C untracked, D tracked but inactive variant),
-- P2 inactive product, P3 only variant sold out, P4 untracked only
INSERT INTO public.categories (id, name) VALUES ('inv-cat', 'Inventory tests');
INSERT INTO public.products (slug, brand, name, category_id) VALUES
  ('inv-p1', 'InvBrand', 'P1', 'inv-cat'), ('inv-p2', 'InvBrand', 'P2', 'inv-cat'),
  ('inv-p3', 'InvBrand', 'P3', 'inv-cat'), ('inv-p4', 'InvBrand', 'P4', 'inv-cat');
INSERT INTO public.product_variants (product_id, sku, name, price, position, is_active)
SELECT p.id, v.sku, v.name, v.price, v.pos, v.active
  FROM (VALUES ('inv-p1', 'INV-A', 'A', 100, 0, TRUE), ('inv-p1', 'INV-B', 'B', 110, 1, TRUE),
               ('inv-p1', 'INV-C', 'C', 120, 2, TRUE), ('inv-p1', 'INV-D', 'D', 130, 3, FALSE),
               ('inv-p2', 'INV-E', 'E', 100, 0, TRUE),
               ('inv-p3', 'INV-F', 'F', 100, 0, TRUE),
               ('inv-p4', 'INV-G', 'G', 100, 0, TRUE)) AS v(slug, sku, name, price, pos, active)
  JOIN public.products p ON p.slug = v.slug;
UPDATE public.products SET is_active = FALSE WHERE slug = 'inv-p2';
SELECT set_config('t.inv_ids', (SELECT array_agg(id ORDER BY id) FROM public.products WHERE slug LIKE 'inv-p%')::text, false);

-- product_id is always the variant's product, whatever the writer sends
INSERT INTO public.inventory (variant_id, product_id, stock_level, low_stock_threshold)
SELECT v.id, (SELECT id FROM public.products WHERE slug = 'inv-p4'), s.lvl, 3
  FROM (VALUES ('INV-A', 2), ('INV-B', 10), ('INV-D', 50), ('INV-E', 5), ('INV-F', 0)) AS s(sku, lvl)
  JOIN public.product_variants v ON v.sku = s.sku;
SELECT pg_temp.eq((SELECT count(*) FROM public.inventory i JOIN public.product_variants v ON v.id = i.variant_id
                    WHERE i.product_id <> v.product_id), 0::bigint,
                  'inventory.product_id is corrected to the variant''s product');
SELECT pg_temp.eq((SELECT low_stock_threshold FROM public.inventory i JOIN public.product_variants v ON v.id = i.variant_id
                    WHERE v.sku = 'INV-A'), 3, 'default low-stock threshold is 3');
SELECT pg_temp.throws('INSERT INTO public.inventory (variant_id, product_id, stock_level) VALUES (-1, 1, 1)', '23503',
                      'inventory rows need a real variant');
SELECT pg_temp.throws($$UPDATE public.inventory SET stock_level = -1
                         WHERE variant_id = (SELECT id FROM public.product_variants WHERE sku = 'INV-A')$$,
                      '23514', 'stock can never go negative');

-- ── sealed table ────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT * FROM public.inventory', '42501', 'anon cannot read inventory');
SELECT pg_temp.throws('UPDATE public.inventory SET stock_level = 999', '42501', 'anon cannot write inventory');
SELECT pg_temp.throws('DELETE FROM public.inventory', '42501', 'anon cannot delete inventory');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.inventory), 0::bigint, 'a shopper sees no inventory rows');
SELECT pg_temp.eq(pg_temp.affected('UPDATE public.inventory SET stock_level = 999'), 0::bigint, 'a shopper cannot restock');
SELECT pg_temp.throws($$INSERT INTO public.inventory (variant_id, product_id, stock_level)
                        SELECT id, product_id, 5 FROM public.product_variants WHERE sku = 'INV-C'$$, '42501',
                      'a shopper cannot start tracking a variant');
SELECT pg_temp.throws('TRUNCATE public.inventory', '42501', 'a shopper cannot truncate inventory');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.ok((SELECT count(*) >= 5 FROM public.inventory), 'the admin sees inventory');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.inventory SET stock_level = 2
                                     WHERE variant_id = (SELECT id FROM public.product_variants WHERE sku = 'INV-A')$$),
                  1::bigint, 'the admin edits stock');
SELECT pg_temp.logout();

-- ── get_product_availability: shape, filtering, flags ───────────────────────
SELECT pg_temp.eq(pg_get_function_result('public.get_product_availability(integer[])'::regprocedure),
                  'TABLE(product_id integer, variant_id integer, stock_level integer, low_stock boolean)',
                  'availability returns exactly (product_id, variant_id, stock_level, low_stock) — never the threshold');
SELECT pg_temp.login_anon();
SELECT set_config('t.avail', (SELECT COALESCE(jsonb_agg(to_jsonb(a)), '[]')::text
                                FROM public.get_product_availability(current_setting('t.inv_ids')::int[]) a), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(v.sku || '=' || (e ->> 'stock_level') || '/' || (e ->> 'low_stock'), ',' ORDER BY v.sku)
                     FROM jsonb_array_elements(current_setting('t.avail')::jsonb) e
                     JOIN public.product_variants v ON v.id = (e ->> 'variant_id')::int
                                                  AND v.product_id = (e ->> 'product_id')::int),
                  'INV-A=2/true,INV-B=10/false,INV-F=0/false',
                  'anon availability: tracked active variants of visible products; sold-out is not "low"');
SELECT pg_temp.ok((SELECT bool_and(NOT (e ? 'low_stock_threshold')) FROM jsonb_array_elements(current_setting('t.avail')::jsonb) e),
                  'no threshold in the payload');

-- ≤ 24 distinct products per call: the 24 smallest distinct ids of the request
INSERT INTO public.products (slug, brand, name) SELECT 'cap-' || lpad(g::text, 2, '0'), 'CapBrand', 'Cap ' || g FROM generate_series(1, 26) g;
INSERT INTO public.product_variants (product_id, sku, name, price)
SELECT id, 'CAP-' || id, 'Standard', 10 FROM public.products WHERE slug LIKE 'cap-%';
INSERT INTO public.inventory (variant_id, product_id, stock_level)
SELECT v.id, v.product_id, 7 FROM public.product_variants v WHERE v.sku LIKE 'CAP-%';
SELECT set_config('t.cap_ids', (SELECT array_agg(id ORDER BY id DESC) || array_agg(id ORDER BY id)
                                  FROM public.products WHERE slug LIKE 'cap-%')::text, false);
SELECT set_config('t.cap_expected', (SELECT array_agg(id ORDER BY id) FROM (SELECT id FROM public.products WHERE slug LIKE 'cap-%' ORDER BY id LIMIT 24) s)::text, false);
SELECT pg_temp.login_anon();
SELECT set_config('t.cap_got', (SELECT array_agg(DISTINCT a.product_id ORDER BY a.product_id)
                                  FROM public.get_product_availability(current_setting('t.cap_ids')::int[]) a)::text, false);
SELECT pg_temp.eq(current_setting('t.cap_got')::int[], current_setting('t.cap_expected')::int[],
                  'a request for 26 products (with duplicates) answers for the 24 smallest distinct ids only');
SELECT pg_temp.eq((SELECT count(*) FROM public.get_product_availability(NULL)), 0::bigint, 'NULL input → no rows, no error');
SELECT pg_temp.eq((SELECT count(*) FROM public.get_product_availability('{}')), 0::bigint, 'empty input → no rows');
SELECT pg_temp.eq((SELECT count(*) FROM public.get_product_availability(ARRAY[NULL, NULL]::int[])), 0::bigint, 'NULL ids are ignored');
SELECT pg_temp.eq((SELECT count(*) FROM public.get_product_availability(ARRAY[-5, 0, 2147483647])), 0::bigint, 'unknown ids answer nothing');

-- ── list_in_stock_product_ids ───────────────────────────────────────────────
SELECT pg_temp.logout();
SELECT set_config('t.p1', (SELECT id FROM public.products WHERE slug = 'inv-p1')::text, false);
SELECT set_config('t.p2', (SELECT id FROM public.products WHERE slug = 'inv-p2')::text, false);
SELECT set_config('t.p3', (SELECT id FROM public.products WHERE slug = 'inv-p3')::text, false);
SELECT set_config('t.p4', (SELECT id FROM public.products WHERE slug = 'inv-p4')::text, false);
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT string_agg(CASE product_id WHEN current_setting('t.p1')::int THEN 'p1' WHEN current_setting('t.p2')::int THEN 'p2'
                                                     WHEN current_setting('t.p3')::int THEN 'p3' WHEN current_setting('t.p4')::int THEN 'p4' END,
                                     ',' ORDER BY product_id)
                     FROM public.list_in_stock_product_ids()
                    WHERE product_id IN (current_setting('t.p1')::int, current_setting('t.p2')::int,
                                         current_setting('t.p3')::int, current_setting('t.p4')::int)),
                  'p1,p4', 'in stock = visible AND some active variant untracked or with stock > 0 (sold-out P3 and inactive P2 excluded)');
SELECT pg_temp.logout();
UPDATE public.inventory SET stock_level = 0 WHERE variant_id IN (SELECT id FROM public.product_variants WHERE sku IN ('INV-A', 'INV-B'));
SELECT pg_temp.login_anon();
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.list_in_stock_product_ids() WHERE product_id = current_setting('t.p1')::int),
                  'an untracked active variant keeps a product in stock');
SELECT pg_temp.logout();
UPDATE public.product_variants SET is_active = FALSE WHERE sku = 'INV-C';
UPDATE public.inventory SET stock_level = 4 WHERE variant_id = (SELECT id FROM public.product_variants WHERE sku = 'INV-F');
SELECT pg_temp.login_anon();
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.list_in_stock_product_ids() WHERE product_id = current_setting('t.p1')::int)
              AND EXISTS (SELECT 1 FROM public.list_in_stock_product_ids() WHERE product_id = current_setting('t.p3')::int),
                  'sold out once every active variant is at 0; restocking brings a product back');
SELECT pg_temp.logout();

-- ── cascades ────────────────────────────────────────────────────────────────
DELETE FROM public.product_variants WHERE sku = 'INV-B';
SELECT pg_temp.eq((SELECT count(*) FROM public.inventory i LEFT JOIN public.product_variants v ON v.id = i.variant_id WHERE v.id IS NULL),
                  0::bigint, 'deleting a variant deletes its stock row');
DELETE FROM public.products WHERE slug = 'inv-p3';
SELECT pg_temp.eq((SELECT count(*) FROM public.inventory WHERE product_id = current_setting('t.p3')::int), 0::bigint,
                  'deleting a product deletes its stock rows');
SELECT pg_temp.ok(has_function_privilege('anon', 'public.get_product_availability(integer[])', 'EXECUTE')
              AND has_function_privilege('anon', 'public.list_in_stock_product_ids()', 'EXECUTE')
              AND NOT has_function_privilege('anon', 'public.inventory_set_product()', 'EXECUTE'),
                  'availability functions are public; the trigger function is not');
