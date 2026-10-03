-- 23_admin_catalogue.test.sql — admin_save_product (atomic product + variants + costs + stock;
-- stock untouched unless supplied), admin_set_collection_products (hand-picked members + order),
-- the admin list views (RLS), and the tile-art cleanup when a product is deleted.
\ir _helpers.sql
\ir _demo_only.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);
INSERT INTO public.categories (id, name) VALUES ('adm-cat', 'Admin tests'), ('adm-cat-2', 'Admin tests two');

-- ── 1. only an admin may call the RPCs ──────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.admin_save_product('{"slug":"adm-x","brand":"B","name":"N"}', '[{"name":"Standard","price":1}]')$$,
                      '42501', 'anon cannot execute admin_save_product');
SELECT pg_temp.throws($$SELECT public.admin_set_collection_products('work-from-home', '{}')$$,
                      '42501', 'anon cannot execute admin_set_collection_products');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_save_product('{"slug":"adm-x","brand":"B","name":"N"}', '[{"name":"Standard","price":1}]')$$,
                      '42501', 'a signed-in shopper is refused by the in-body admin check', 'not_authorised:%');
SELECT pg_temp.throws($$SELECT public.admin_set_collection_products('work-from-home', '{}')$$,
                      '42501', 'a shopper cannot change collection members', 'not_authorised:%');
SELECT pg_temp.logout();
SELECT pg_temp.throws($$SELECT public.admin_save_product('{"slug":"adm-x","brand":"B","name":"N"}', '[{"name":"Standard","price":1}]')$$,
                      '42501', 'no JWT (SQL editor session) is not an admin either', 'not_authorised:%');
SELECT pg_temp.eq((SELECT count(*) FROM public.products WHERE slug = 'adm-x'), 0::bigint, 'refused calls wrote nothing');

-- ── 2. create: product + variants + costs + stock in one call ───────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.r1', public.admin_save_product(
  '{"slug":"adm-laptop","brand":"AdmBrand","name":"Adm Laptop","subtitle":"i5 · 16GB","category_id":"adm-cat",
    "tags":[" Laptop ","laptop","Office"],"image_urls":["/images/products/a.webp","/images/products/b.webp"],
    "attributes":{"specs":{"ram_gb":16,"custom_key":"kept"},"highlights":["Light"]},"warranty_months":12,
    "is_new":true,"sort_order":5,"seo_title":"Adm Laptop — test"}',
  '[{"name":"16GB / 512GB","sku":"ADM-16-512","option_values":{"Memory":" 16GB ","Storage":"512GB","Blank":"  "},
     "price":200000,"compare_at_price":220000,"cost_price":150000,"track_stock":true,"stock_level":7,"low_stock_threshold":2},
    {"name":"32GB / 1TB","sku":"ADM-32-1T","price":250000,"cost_price":190000}]')::text, false);
SELECT pg_temp.logout();
SELECT set_config('t.pid', current_setting('t.r1')::jsonb ->> 'product_id', false);
SELECT set_config('t.v1', current_setting('t.r1')::jsonb #>> '{variants,0,id}', false);
SELECT set_config('t.v2', current_setting('t.r1')::jsonb #>> '{variants,1,id}', false);

SELECT pg_temp.eq((SELECT format('%s|%s|%s', r ->> 'created', jsonb_array_length(r -> 'variants'), r #>> '{variants,0,name}')
                     FROM (SELECT current_setting('t.r1')::jsonb AS r) s),
                  'true|2|16GB / 512GB', 'create returns the new id, created=true and the variant ids in list order');
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s|%s|%s|%s', slug, brand, category_id, tags, image_url, is_new, sort_order, attributes #>> '{specs,custom_key}')
                     FROM public.products WHERE id = current_setting('t.pid')::int),
                  'adm-laptop|AdmBrand|adm-cat|{laptop,office}|/images/products/a.webp|t|5|kept',
                  'the product row: tags normalised by 04, image_url = image_urls[1], attributes kept as sent');
SELECT pg_temp.eq((SELECT format('%s/%s/%s/%s', price, compare_at_price, variant_count, default_variant_id = current_setting('t.v1')::int)
                     FROM public.products WHERE id = current_setting('t.pid')::int),
                  '200000.00/220000.00/2/t', 'derived from-price, compare-at, count and default come from the variants');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s', name, position, option_values), ' ' ORDER BY position)
                     FROM public.product_variants WHERE product_id = current_setting('t.pid')::int),
                  '16GB / 512GB:0:{"Memory": "16GB", "Storage": "512GB"} 32GB / 1TB:1:{}',
                  'positions follow the list; option names/values trimmed and blank ones dropped');
SELECT pg_temp.eq((SELECT string_agg(c.cost_price::text, ',' ORDER BY v.position) FROM public.product_costs c
                     JOIN public.product_variants v ON v.id = c.variant_id WHERE v.product_id = current_setting('t.pid')::int),
                  '150000.00,190000.00', 'cost prices written per variant');
SELECT pg_temp.eq((SELECT string_agg(format('%s=%s/%s', i.variant_id = current_setting('t.v1')::int, i.stock_level, i.low_stock_threshold), ',')
                     FROM public.inventory i WHERE i.product_id = current_setting('t.pid')::int),
                  't=7/2', 'stock written only where supplied: variant 1 tracked 7 (threshold 2), variant 2 untracked');

-- ── 3. edit without stock fields: stock is NEVER reset ──────────────────────
UPDATE public.inventory SET stock_level = 5 WHERE variant_id = current_setting('t.v1')::int;   -- two sold meanwhile
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int, 'name', 'Adm Laptop Mk2'),
         jsonb_build_array(jsonb_build_object('id', current_setting('t.v1')::int, 'name', '16GB / 512GB', 'price', 199000),
                           jsonb_build_object('id', current_setting('t.v2')::int, 'name', '32GB / 1TB', 'price', 249000)));
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s/%s', stock_level, low_stock_threshold) FROM public.inventory WHERE variant_id = current_setting('t.v1')::int),
                  '5/2', 'editing prices leaves stock exactly as it was (5, not 7, not reset)');
SELECT pg_temp.eq((SELECT count(*) FROM public.inventory WHERE variant_id = current_setting('t.v2')::int), 0::bigint,
                  'an untracked variant stays untracked');
SELECT pg_temp.eq((SELECT string_agg(c.cost_price::text, ',' ORDER BY v.position) FROM public.product_costs c
                     JOIN public.product_variants v ON v.id = c.variant_id WHERE v.product_id = current_setting('t.pid')::int),
                  '150000.00,190000.00', 'omitted cost prices are untouched');
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', name, subtitle, price, compare_at_price) FROM public.products WHERE id = current_setting('t.pid')::int),
                  'Adm Laptop Mk2|i5 · 16GB|199000.00|220000.00',
                  'only the keys sent change (subtitle kept); an omitted compare-at price is kept');

SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int, 'is_featured', true), NULL);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s', p.is_featured, (SELECT count(*) FROM public.product_variants v WHERE v.product_id = p.id))
                     FROM public.products p WHERE p.id = current_setting('t.pid')::int),
                  't|2', 'p_variants NULL = a product-only save, variants untouched');

-- ── 4. stock fields when they ARE supplied ──────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         jsonb_build_array(jsonb_build_object('id', current_setting('t.v1')::int, 'name', '16GB / 512GB', 'price', 199000, 'low_stock_threshold', 4),
                           jsonb_build_object('id', current_setting('t.v2')::int, 'name', '32GB / 1TB', 'price', 249000, 'track_stock', true,
                                              'cost_price', NULL)));
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(format('%s/%s', stock_level, low_stock_threshold), ',' ORDER BY variant_id)
                     FROM public.inventory WHERE product_id = current_setting('t.pid')::int),
                  '5/4,0/3', 'threshold alone keeps the stock (5/4); tracking switched on starts at the column defaults (0/3)');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_costs WHERE variant_id = current_setting('t.v2')::int), 0::bigint,
                  'cost_price: null clears the cost row');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         jsonb_build_array(jsonb_build_object('id', current_setting('t.v1')::int, 'name', '16GB / 512GB', 'price', 199000, 'track_stock', false),
                           jsonb_build_object('id', current_setting('t.v2')::int, 'name', '32GB / 1TB', 'price', 249000, 'stock_level', 12)));
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s', variant_id = current_setting('t.v2')::int, stock_level), ',')
                     FROM public.inventory WHERE product_id = current_setting('t.pid')::int),
                  't:12', 'track_stock false removes the row (untracked); a stock figure alone writes it');

-- ── 5. atomic: a bad variant fails the whole save ───────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_save_product(
         jsonb_build_object('id', current_setting('t.pid')::int, 'name', 'Should Not Stick', 'tags', jsonb_build_array('sticky')),
         jsonb_build_array(jsonb_build_object('id', current_setting('t.v1')::int, 'name', 'Renamed Should Not Stick', 'price', 1, 'cost_price', 1),
                           jsonb_build_object('id', current_setting('t.v2')::int, 'name', '32GB / 1TB', 'price', 249000, 'stock_level', 99),
                           jsonb_build_object('name', 'Too Dear', 'price', 200000000)))$$,
                      '23514', 'a variant the CHECK refuses (price over 100,000,000) fails the call after earlier writes ran');
SELECT pg_temp.throws($$SELECT public.admin_save_product(
         jsonb_build_object('id', current_setting('t.pid')::int, 'name', 'Should Not Stick'),
         jsonb_build_array(jsonb_build_object('id', current_setting('t.v1')::int, 'name', '16GB / 512GB', 'price', 1),
                           jsonb_build_object('name', 'Nameless price', 'price', -5)))$$,
                      '22023', 'a negative price is refused before anything is written', 'invalid_variant:%');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s|%s', p.name, p.tags, p.price) FROM public.products p WHERE p.id = current_setting('t.pid')::int),
                  'Adm Laptop Mk2|{laptop,office}|199000.00', 'rolled back: product name, tags and from-price unchanged');
SELECT pg_temp.eq((SELECT string_agg(format('%s=%s', name, price), ',' ORDER BY position) FROM public.product_variants
                    WHERE product_id = current_setting('t.pid')::int),
                  '16GB / 512GB=199000.00,32GB / 1TB=249000.00', 'rolled back: no variant renamed, re-priced or added');
SELECT pg_temp.ok((SELECT stock_level = 12 FROM public.inventory WHERE variant_id = current_setting('t.v2')::int)
              AND (SELECT count(*) = 1 FROM public.product_costs WHERE variant_id = current_setting('t.v1')::int
                      AND cost_price = 150000),
                  'rolled back: stock and cost untouched');

-- ── 6. variant diff: referenced by orders → deactivated; otherwise deleted ──
INSERT INTO public.orders (id, email, first_name, phone, subtotal, total_price)
VALUES ('DO-90001', 'buyer@shop.test', 'Buyer', '+94771234567', 249000, 249000);
INSERT INTO public.order_items (order_id, product_id, variant_id, quantity, unit_price, product_name, brand, variant_name, sku)
SELECT 'DO-90001', v.product_id, v.id, 1, v.price, 'Adm Laptop Mk2', 'AdmBrand', v.name, v.sku
  FROM public.product_variants v WHERE v.id = current_setting('t.v2')::int;
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.r2', public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         jsonb_build_array(jsonb_build_object('id', current_setting('t.v1')::int, 'name', '16GB / 512GB', 'price', 199000),
                           jsonb_build_object('name', 'Temp', 'sku', 'ADM-TEMP', 'price', 1000)))::text, false);
SELECT set_config('t.v3', current_setting('t.r2')::jsonb #>> '{variants,1,id}', false);
SELECT set_config('t.r3', public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         jsonb_build_array(jsonb_build_object('id', current_setting('t.v1')::int, 'name', '16GB / 512GB', 'price', 199000)))::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.r2')::jsonb -> 'deactivated_variant_ids', jsonb_build_array(current_setting('t.v2')::int),
                  'a removed variant that an order references is reported as deactivated');
SELECT pg_temp.eq((SELECT format('%s|%s', is_active, sku) FROM public.product_variants WHERE id = current_setting('t.v2')::int),
                  'f|ADM-32-1T', '…and it still exists, inactive (the order line keeps its link)');
SELECT pg_temp.eq((SELECT count(*) FROM public.order_items WHERE order_id = 'DO-90001' AND variant_id = current_setting('t.v2')::int),
                  1::bigint, 'the order line still points at its variant');
SELECT pg_temp.eq(current_setting('t.r3')::jsonb -> 'deleted_variant_ids', jsonb_build_array(current_setting('t.v3')::int),
                  'a removed variant nobody ordered is deleted');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_variants WHERE id = current_setting('t.v3')::int), 0::bigint, '…and gone');
SELECT pg_temp.eq((SELECT format('%s/%s', variant_count, price) FROM public.products WHERE id = current_setting('t.pid')::int),
                  '1/199000.00', 'the from-price rollup follows (one active variant left)');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         jsonb_build_array(jsonb_build_object('id', current_setting('t.v1')::int, 'name', '16GB / 512GB', 'price', 199000),
                           jsonb_build_object('name', '32gb / 1tb', 'price', 5)))$$,
                      '22023', 'a new variant cannot take the name of a kept (order-referenced) one', 'variant_name_taken:%');
SELECT pg_temp.throws($$SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         jsonb_build_array(jsonb_build_object('id', current_setting('t.v1')::int, 'name', '16GB / 512GB', 'price', 199000),
                           jsonb_build_object('name', 'Other', 'sku', 'ADM-32-1T', 'price', 5)))$$,
                      '22023', '…nor its SKU', 'sku_taken:%');
-- listing the kept variant again brings it back
SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         jsonb_build_array(jsonb_build_object('id', current_setting('t.v1')::int, 'name', '16GB / 512GB', 'price', 199000),
                           jsonb_build_object('id', current_setting('t.v2')::int, 'name', '32GB / 1TB', 'price', 249000, 'is_active', true)));
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT variant_count FROM public.products WHERE id = current_setting('t.pid')::int), 2, 'a kept variant can be re-activated');

-- ── 7. swaps, conflicts and refusals ────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.other', (public.admin_save_product('{"slug":"adm-other","brand":"OtherMaker","name":"Other Maker Widget"}',
                                                        '[{"name":"Standard","sku":"ADM-OTHER-1","price":500}]') ->> 'product_id'), false);
SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         jsonb_build_array(jsonb_build_object('id', current_setting('t.v1')::int, 'name', '32GB / 1TB', 'sku', 'ADM-32-1T', 'price', 199000),
                           jsonb_build_object('id', current_setting('t.v2')::int, 'name', '16GB / 512GB', 'sku', 'ADM-16-512', 'price', 249000)));
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(format('%s=%s/%s', id = current_setting('t.v1')::int, name, sku), ',' ORDER BY id)
                     FROM public.product_variants WHERE product_id = current_setting('t.pid')::int),
                  't=32GB / 1TB/ADM-32-1T,f=16GB / 512GB/ADM-16-512',
                  'two variants can swap names and SKUs in one save (no half-way unique clash)');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         jsonb_build_array(jsonb_build_object('id', current_setting('t.v1')::int, 'name', 'A', 'sku', 'ADM-OTHER-1', 'price', 1)))$$,
                      '22023', 'a SKU another product uses is refused with its name', 'sku_taken:%Other Maker Widget%');
SELECT pg_temp.throws($$SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         '[{"name":"Same","price":1},{"name":"same ","price":2}]')$$, '22023', 'duplicate variant names in one list', 'duplicate_variant_name:%');
SELECT pg_temp.throws($$SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         '[{"name":"A","sku":"DUP-1","price":1},{"name":"B","sku":"DUP-1","price":2}]')$$, '22023', 'duplicate SKUs in one list', 'duplicate_sku:%');
SELECT pg_temp.throws($$SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         '[{"name":"A","sku":"HAS SPACE","price":1}]')$$, '22023', 'SKUs with spaces', 'invalid_variant:%');
SELECT pg_temp.throws($$SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         jsonb_build_array(jsonb_build_object('id', (SELECT id FROM public.product_variants WHERE sku = 'ADM-OTHER-1'), 'name', 'Stolen', 'price', 1)))$$,
                      '22023', 'a variant of ANOTHER product cannot be moved or edited through this product', 'invalid_variant:%');
SELECT pg_temp.throws($$SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int), '[]')$$,
                      '22023', 'an empty variant list is refused', 'variants_required:%');
SELECT pg_temp.throws($$SELECT public.admin_save_product('{"slug":"adm-empty","brand":"B","name":"N"}', NULL)$$,
                      '22023', 'a new product needs variants', 'variants_required:%');
SELECT pg_temp.throws($$SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int, 'price', 1), NULL)$$,
                      '22023', 'derived columns (price) cannot be sent', 'invalid_product:%database works it out%');
SELECT pg_temp.throws($$SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         '[{"name":"A","price":1,"barcode":"x"}]')$$, '22023', 'unknown variant fields are refused', 'invalid_variant:%');
SELECT pg_temp.throws($$SELECT public.admin_save_product('{"slug":"Bad Slug","brand":"B","name":"N"}', '[{"name":"Standard","price":1}]')$$,
                      '22023', 'slug format is checked with a readable message', 'invalid_slug:%');
SELECT pg_temp.throws($$SELECT public.admin_save_product('{"slug":"adm-laptop","brand":"B","name":"N"}', '[{"name":"Standard","price":1}]')$$,
                      '23505', 'a taken slug surfaces as the unique constraint (products_slug_key)', '%products_slug_key%');
SELECT pg_temp.throws($$SELECT public.admin_save_product('{"id":2147483000,"name":"Ghost"}', NULL)$$,
                      '22023', 'saving a product that no longer exists', 'product_not_found:%');
SELECT pg_temp.throws($$SELECT public.admin_save_product('{"slug":"adm-bad-img","brand":"B","name":"N","image_urls":["javascript:alert(1)"]}', '[{"name":"Standard","price":1}]')$$,
                      '22023', '04''s image rules still apply', 'invalid_image_url:%');
SELECT pg_temp.throws($$SELECT public.admin_save_product('{"slug":"adm-bad-cat","brand":"B","name":"N","category_id":"no-such-cat"}', '[{"name":"Standard","price":1}]')$$,
                      '23503', 'an unknown category surfaces as the FK (products_category_id_fkey)', '%products_category_id_fkey%');
SELECT pg_temp.throws($$SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         '[{"name":"A","price":1,"stock_level":-1}]')$$, '22023', 'negative stock is refused', 'invalid_stock:%');
SELECT pg_temp.throws($$SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.pid')::int),
         '[{"name":"A","price":1,"option_values":{"Memory":16}}]')$$, '22023', 'option values must be text', 'invalid_variant:%');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.products WHERE slug IN ('adm-empty', 'adm-bad-img', 'adm-bad-cat', 'bad slug')), 0::bigint,
                  'refused creates left nothing behind');
SELECT pg_temp.eq((SELECT format('%s|%s', name, sku) FROM public.product_variants WHERE product_id = current_setting('t.other')::int),
                  'Standard|ADM-OTHER-1', 'the other product''s variant was not touched by the refused cross-product edit');

-- ── 8. admin_set_collection_products ────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.p2', (public.admin_save_product('{"slug":"adm-mouse","brand":"OtherBrand","name":"Adm Mouse","category_id":"adm-cat-2"}',
                                                     '[{"name":"Standard","price":1000}]') ->> 'product_id'), false);
INSERT INTO public.collections (id, title) VALUES ('adm-manual', 'Hand-picked');
INSERT INTO public.collections (id, title, type, rules) VALUES
  ('adm-auto', 'By rule', 'automated', '[{"field":"brand","relation":"equals","value":"admbrand"}]');
SELECT public.admin_set_collection_products('adm-manual', ARRAY[current_setting('t.p2')::int, current_setting('t.pid')::int]);
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s', product_id = current_setting('t.pid')::int, position, source), ',' ORDER BY position)
                     FROM public.product_collections WHERE collection_id = 'adm-manual'),
                  'f:0:manual,t:1:manual', 'members are written in the given order (positions 0, 1)');
SELECT public.admin_set_collection_products('adm-manual', ARRAY[current_setting('t.pid')::int]);
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s', product_id = current_setting('t.pid')::int, position), ',')
                     FROM public.product_collections WHERE collection_id = 'adm-manual'),
                  't:0', 'a product left out is removed; the rest re-numbered');
SELECT pg_temp.eq((SELECT format('%s:%s', position, source) FROM public.product_collections
                    WHERE collection_id = 'adm-auto' AND product_id = current_setting('t.pid')::int),
                  '100000:rule', 'rule rows sort after hand-picked ones (position 100000)');
SELECT set_config('t.r4', public.admin_set_collection_products('adm-auto', ARRAY[current_setting('t.pid')::int, current_setting('t.p2')::int])::text, false);
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s', product_id = current_setting('t.pid')::int, position, source), ',' ORDER BY position)
                     FROM public.product_collections WHERE collection_id = 'adm-auto'),
                  't:0:manual,f:1:manual', 'hand-picking a rule member turns its row manual; extra picks join an automated collection');
SELECT pg_temp.eq(current_setting('t.r4')::jsonb ->> 'member_count', '2', 'the result reports the member count');
SELECT public.admin_set_collection_products('adm-auto', '{}');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s', product_id = current_setting('t.pid')::int, source), ',')
                     FROM public.product_collections WHERE collection_id = 'adm-auto'),
                  't:rule', 'clearing the picks: the rule-matching product falls back to its rule row, the other leaves');
SELECT pg_temp.throws($$SELECT public.admin_set_collection_products('adm-manual', ARRAY[2147483000])$$, '22023',
                      'unknown products are refused', 'unknown_product:%');
SELECT pg_temp.throws($$SELECT public.admin_set_collection_products('adm-manual', ARRAY[current_setting('t.pid')::int, current_setting('t.pid')::int])$$,
                      '22023', 'a product listed twice is refused', 'invalid_products:%');
SELECT pg_temp.throws($$SELECT public.admin_set_collection_products('adm-nope', '{}')$$, '22023',
                      'an unknown collection is refused', 'collection_not_found:%');
SELECT pg_temp.logout();

-- ── 9. the admin list views ─────────────────────────────────────────────────
UPDATE public.inventory SET stock_level = 1, low_stock_threshold = 3 WHERE variant_id = current_setting('t.v2')::int;
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s|%s|%s', variants_total, tracked_variants, stock_total, low_stock_variants, has_low_stock,
                                 category_name, position('ADM-16-512' IN skus) > 0)
                     FROM public.admin_product_list WHERE id = current_setting('t.pid')::int),
                  '2|1|1|1|t|Admin tests|t', 'admin_product_list: variant count, tracked count, stock total, low stock, category, SKUs');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', tracked_variants, COALESCE(stock_total::text, 'null'), has_low_stock)
                     FROM public.admin_product_list WHERE id = current_setting('t.p2')::int),
                  '0|null|f', 'an untracked product: no stock total, not low');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s', tracked, COALESCE(stock_level::text, '-'), is_low), ',' ORDER BY is_low DESC, stock_level NULLS LAST, variant_id)
                     FROM public.admin_inventory WHERE product_id = current_setting('t.pid')::int),
                  't:1:t,f:-:f', 'admin_inventory: one row per variant, tracked or not; low first');
SELECT pg_temp.eq((SELECT format('%s:%s', variant_id = current_setting('t.v2')::int, is_low) FROM public.admin_inventory
                    ORDER BY is_low DESC, stock_level NULLS LAST, variant_id LIMIT 1),
                  't:t', 'store-wide, "low stock first" puts the low row on top');
SELECT pg_temp.eq((SELECT is_low FROM public.admin_inventory WHERE variant_id = current_setting('t.v2')::int), TRUE,
                  'sold down to the threshold or below counts as low for the admin');
UPDATE public.product_variants SET is_active = FALSE WHERE id = current_setting('t.v2')::int;
SELECT pg_temp.eq((SELECT format('%s|%s', i.is_low, l.has_low_stock) FROM public.admin_inventory i
                     JOIN public.admin_product_list l ON l.id = i.product_id WHERE i.variant_id = current_setting('t.v2')::int),
                  'f|f', 'a variant that is off sale is not "low" (same rule as 17''s admin_low_stock)');
UPDATE public.product_variants SET is_active = TRUE WHERE id = current_setting('t.v2')::int;
SELECT pg_temp.eq((SELECT count(*) FROM public.admin_product_list), (SELECT count(*) FROM public.products),
                  'the admin sees every product in the list view (inactive included)');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT COALESCE(sum(tracked_variants), 0) FROM public.admin_product_list), 0::bigint,
                  'a shopper sees no stock through the view (inventory RLS)');
SELECT pg_temp.eq((SELECT count(*) FROM public.admin_inventory WHERE tracked), 0::bigint, 'a shopper sees no tracked rows');
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT * FROM public.admin_product_list', '42501', 'anon cannot read admin_product_list');
SELECT pg_temp.throws('SELECT * FROM public.admin_inventory', '42501', 'anon cannot read admin_inventory');
SELECT pg_temp.logout();
SELECT pg_temp.ok(NOT has_table_privilege('anon', 'public.admin_inventory', 'SELECT')
              AND NOT has_table_privilege('anon', 'public.admin_product_list', 'SELECT')
              AND has_table_privilege('authenticated', 'public.admin_inventory', 'SELECT')
              AND NOT has_table_privilege('authenticated', 'public.admin_inventory', 'INSERT')
              AND NOT has_table_privilege('authenticated', 'public.admin_product_list', 'UPDATE')
              AND NOT has_table_privilege('authenticated', 'public.admin_product_list', 'DELETE'),
                  'the views are read-only, for signed-in users only');
SELECT pg_temp.ok((SELECT bool_and(COALESCE(reloptions, '{}') @> ARRAY['security_invoker=true']) FROM pg_class
                    WHERE oid IN ('public.admin_product_list'::regclass, 'public.admin_inventory'::regclass)),
                  'both views run with the caller''s rights (security_invoker)');

-- ── 10. a deleted product leaves collection tile art ────────────────────────
UPDATE public.collections SET feature_product_ids = ARRAY[current_setting('t.p2')::int, current_setting('t.pid')::int] WHERE id = 'adm-manual';
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.products WHERE id = current_setting('t.p2')::int$$), 1::bigint, 'the admin deletes a product');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT feature_product_ids FROM public.collections WHERE id = 'adm-manual'), ARRAY[current_setting('t.pid')::int],
                  'the deleted product left feature_product_ids; the other tile product stays');

-- ── 11. grants ──────────────────────────────────────────────────────────────
SELECT pg_temp.ok(has_function_privilege('authenticated', 'public.admin_save_product(jsonb,jsonb)', 'EXECUTE')
              AND NOT has_function_privilege('anon', 'public.admin_save_product(jsonb,jsonb)', 'EXECUTE')
              AND has_function_privilege('authenticated', 'public.admin_set_collection_products(text,integer[])', 'EXECUTE')
              AND NOT has_function_privilege('anon', 'public.admin_set_collection_products(text,integer[])', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'public._admin_json_text(text,jsonb,text,integer,boolean)', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'public._refresh_collection_rule_members(text)', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'public.products_forget_collection_art()', 'EXECUTE'),
                  'grant U for the two RPCs; helpers and triggers are internal');
