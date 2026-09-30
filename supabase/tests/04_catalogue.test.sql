-- 04_catalogue.test.sql — variant model B from-price rollup, derived-column pin, images/tags
-- normalisation, rule collections re-evaluated both ways, public-read RLS, admin-only writes,
-- sealed cost prices, storage buckets.
\ir _helpers.sql

-- fixtures (superuser) --------------------------------------------------------
SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);

INSERT INTO public.categories (id, name) VALUES ('test-cat', 'Test Category'), ('test-cat-b', 'Second Test Category');
INSERT INTO public.categories (id, name, is_active) VALUES ('test-hidden', 'Hidden Category', FALSE);
INSERT INTO public.products (slug, brand, name, category_id, tags, image_urls,
                             price, compare_at_price, variant_count, default_variant_id, rating_avg, rating_count)
VALUES ('test-alpha', 'TestBrand', 'Alpha Widget', 'test-cat', ARRAY[' Gaming ', 'gaming', 'RGB', '', NULL],
        ARRAY['/images/products/a.webp', ' /images/products/b.webp ', '/images/products/a.webp', ''],
        5, 6, 7, 8, 4, 9);
INSERT INTO public.products (slug, brand, name, category_id) VALUES ('test-beta', 'OtherBrand', 'Beta Gadget', 'test-cat');

-- ── insert normalisation + pinned derived columns ───────────────────────────
SELECT pg_temp.ok((SELECT price = 0 AND compare_at_price IS NULL AND variant_count = 0 AND default_variant_id IS NULL
                          AND rating_avg = 0 AND rating_count = 0 FROM public.products WHERE slug = 'test-alpha'),
                  'derived columns ignore inserted values (price/compare/variants/ratings start empty)');
SELECT pg_temp.eq((SELECT tags FROM public.products WHERE slug = 'test-alpha'), ARRAY['gaming', 'rgb'],
                  'tags are trimmed, lower-cased, de-duplicated, empties dropped');
SELECT pg_temp.eq((SELECT image_urls FROM public.products WHERE slug = 'test-alpha'),
                  ARRAY['/images/products/a.webp', '/images/products/b.webp'], 'gallery trimmed and de-duplicated in order');
SELECT pg_temp.eq((SELECT image_url FROM public.products WHERE slug = 'test-alpha'), '/images/products/a.webp',
                  'image_url = image_urls[1]');
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT count(*) FROM public.products WHERE slug = 'test-alpha'), 0::bigint,
                  'a product with no variants is invisible to shoppers');
SELECT pg_temp.logout();

-- ── from-price rollup ───────────────────────────────────────────────────────
INSERT INTO public.product_variants (product_id, sku, name, option_values, price, compare_at_price, position, is_active)
SELECT p.id, v.sku, v.name, v.opts::jsonb, v.price, v.cmp, v.pos, v.active
  FROM public.products p,
       (VALUES ('T-A-BASE', 'Base', '{"Size":"S"}', 1000, 1200, 0, TRUE),
               ('T-A-PLUS', 'Plus', '{"Size":"M"}', 1500, 1400, 1, TRUE),
               ('T-A-MAX',  'Max',  '{"Size":"L"}',  900, NULL, 2, FALSE)) AS v(sku, name, opts, price, cmp, pos, active)
 WHERE p.slug = 'test-alpha';
SELECT pg_temp.eq((SELECT format('%s/%s/%s/%s', p.price, p.compare_at_price, p.variant_count,
                                 (SELECT sku FROM public.product_variants WHERE id = p.default_variant_id))
                     FROM public.products p WHERE p.slug = 'test-alpha'),
                  '1000.00/1200.00/2/T-A-BASE', 'from-price = cheapest ACTIVE variant (inactive 900 ignored), its compare-at, count 2');
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT count(*) FROM public.products WHERE slug = 'test-alpha'), 1::bigint, 'with active variants the product is visible');
SELECT pg_temp.eq((SELECT string_agg(v.name, ',' ORDER BY v.position) FROM public.product_variants v
                     JOIN public.products p ON p.id = v.product_id WHERE p.slug = 'test-alpha'),
                  'Base,Plus', 'shoppers see active variants only');
SELECT pg_temp.logout();

UPDATE public.product_variants SET is_active = TRUE WHERE sku = 'T-A-MAX';
SELECT pg_temp.eq((SELECT format('%s/%s/%s', price, COALESCE(compare_at_price::text, 'null'), variant_count) FROM public.products WHERE slug = 'test-alpha'),
                  '900.00/null/3', 'activating a cheaper variant lowers the from-price; no compare-at when the variant has none');
UPDATE public.product_variants SET price = 2000 WHERE sku = 'T-A-MAX';
SELECT pg_temp.eq((SELECT format('%s/%s', price, compare_at_price) FROM public.products WHERE slug = 'test-alpha'),
                  '1000.00/1200.00', 're-pricing a variant re-derives the from-price');
UPDATE public.product_variants SET price = 1000 WHERE sku = 'T-A-PLUS';
SELECT pg_temp.eq((SELECT (SELECT sku FROM public.product_variants WHERE id = p.default_variant_id) FROM public.products p WHERE p.slug = 'test-alpha'),
                  'T-A-BASE', 'price ties resolve to the lowest position');
UPDATE public.product_variants SET price = 1500 WHERE sku = 'T-A-PLUS';
UPDATE public.product_variants SET is_active = FALSE WHERE sku = 'T-A-BASE';
SELECT pg_temp.eq((SELECT format('%s/%s/%s', price, COALESCE(compare_at_price::text, 'null'), variant_count) FROM public.products WHERE slug = 'test-alpha'),
                  '1500.00/null/2', 'compare-at shown only when > price (1400 < 1500 is dropped)');
UPDATE public.product_variants SET is_active = FALSE WHERE sku IN ('T-A-PLUS', 'T-A-MAX');
SELECT pg_temp.ok((SELECT variant_count = 0 AND default_variant_id IS NULL AND price = 1500 FROM public.products WHERE slug = 'test-alpha'),
                  'no active variant: count 0, no default, last price kept');
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT count(*) FROM public.products WHERE slug = 'test-alpha'), 0::bigint, '…and the product disappears for shoppers');
SELECT pg_temp.logout();
UPDATE public.product_variants SET is_active = TRUE WHERE sku IN ('T-A-BASE', 'T-A-PLUS');
SELECT pg_temp.eq((SELECT format('%s/%s/%s', price, compare_at_price, variant_count) FROM public.products WHERE slug = 'test-alpha'),
                  '1000.00/1200.00/2', 're-activating restores the from-price');
DELETE FROM public.product_variants WHERE sku = 'T-A-MAX';
INSERT INTO public.product_variants (product_id, sku, name, price)
SELECT id, 'T-B-ONLY', 'Standard', 700 FROM public.products WHERE slug = 'test-beta';
UPDATE public.product_variants SET product_id = (SELECT id FROM public.products WHERE slug = 'test-beta') WHERE sku = 'T-A-PLUS';
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s/%s', slug, price, variant_count), ' ' ORDER BY slug)
                     FROM public.products WHERE slug IN ('test-alpha', 'test-beta')),
                  'test-alpha:1000.00/1 test-beta:700.00/2', 'moving a variant re-derives both products');

-- derived columns cannot be written directly — not by an admin, not by the SQL editor
SELECT pg_temp.login(current_setting('t.owner')::uuid);
UPDATE public.products SET price = 1, compare_at_price = 2, variant_count = 99, default_variant_id = NULL,
                           rating_avg = 5, rating_count = 10, name = 'Alpha Widget Mk2'
 WHERE slug = 'test-alpha';
SELECT pg_temp.logout();
SELECT pg_temp.ok((SELECT price = 1000 AND compare_at_price = 1200 AND variant_count = 1 AND default_variant_id IS NOT NULL
                          AND rating_avg = 0 AND rating_count = 0 AND name = 'Alpha Widget Mk2'
                     FROM public.products WHERE slug = 'test-alpha'),
                  'admin writes to derived columns are restored; ordinary columns go through');
UPDATE public.products SET price = 3 WHERE slug = 'test-alpha';
SELECT pg_temp.eq((SELECT price FROM public.products WHERE slug = 'test-alpha'), 1000::numeric, 'superuser writes to price are restored too');

-- ratings writer (for 11_reviews)
SELECT public._apply_product_rating((SELECT id FROM public.products WHERE slug = 'test-alpha'), 4.456, 3);
SELECT pg_temp.eq((SELECT format('%s/%s', rating_avg, rating_count) FROM public.products WHERE slug = 'test-alpha'),
                  '4.46/3', '_apply_product_rating writes the rounded average and count');
SELECT public._apply_product_rating((SELECT id FROM public.products WHERE slug = 'test-alpha'), 9, 2);
SELECT pg_temp.eq((SELECT rating_avg FROM public.products WHERE slug = 'test-alpha'), 5.00::numeric, 'average clamped to 5');
SELECT public._apply_product_rating((SELECT id FROM public.products WHERE slug = 'test-alpha'), 4, 0);
SELECT pg_temp.eq((SELECT format('%s/%s', rating_avg, rating_count) FROM public.products WHERE slug = 'test-alpha'),
                  '0.00/0', 'zero reviews → average 0');
SELECT pg_temp.ok(COALESCE(current_setting('app.catalogue_rollup', true), '') <> 'on', 'the rollup flag does not leak past the writer');
SELECT pg_temp.ok(NOT has_function_privilege('anon', 'public._apply_product_rating(integer,numeric,integer)', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'public._apply_product_rating(integer,numeric,integer)', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'public.refresh_product_from_price(integer)', 'EXECUTE'),
                  'rollup writers are internal');

-- ── variant constraints ─────────────────────────────────────────────────────
SELECT pg_temp.throws($$INSERT INTO public.product_variants (product_id, name, price)
                        SELECT id, 'BASE', 1 FROM public.products WHERE slug = 'test-alpha'$$, '23505',
                      'variant names are unique per product (case-insensitive)');
SELECT pg_temp.throws($$INSERT INTO public.product_variants (product_id, sku, name, price)
                        SELECT id, 'T-A-BASE', 'Dup', 1 FROM public.products WHERE slug = 'test-beta'$$, '23505', 'SKUs are unique');
SELECT pg_temp.throws($$INSERT INTO public.product_variants (product_id, name, price)
                        SELECT id, 'Neg', -1 FROM public.products WHERE slug = 'test-beta'$$, '23514', 'negative variant price refused');
SELECT pg_temp.throws($$INSERT INTO public.product_variants (product_id, name, price, option_values)
                        SELECT id, 'Obj', 1, '{"Memory":16}' FROM public.products WHERE slug = 'test-beta'$$, '23514',
                      'option_values must be string-valued');
SELECT pg_temp.throws($$INSERT INTO public.product_variants (product_id, name, price, sku)
                        SELECT id, 'Sp', 1, 'HAS SPACE' FROM public.products WHERE slug = 'test-beta'$$, '23514', 'SKUs cannot contain whitespace');

-- ── images, tags, slugs ─────────────────────────────────────────────────────
UPDATE public.products SET image_url = '/images/products/b.webp' WHERE slug = 'test-alpha';
SELECT pg_temp.eq((SELECT image_urls FROM public.products WHERE slug = 'test-alpha'),
                  ARRAY['/images/products/b.webp', '/images/products/a.webp'], 'setting image_url moves it to the front of the gallery');
UPDATE public.products SET image_urls = ARRAY['https://abc.supabase.co/storage/v1/object/public/product-images/products/1/0.webp']
 WHERE slug = 'test-alpha';
SELECT pg_temp.eq((SELECT image_url FROM public.products WHERE slug = 'test-alpha'),
                  'https://abc.supabase.co/storage/v1/object/public/product-images/products/1/0.webp', 'editing the gallery updates image_url');
UPDATE public.products SET image_url = NULL WHERE slug = 'test-alpha';
SELECT pg_temp.ok((SELECT image_url IS NULL AND image_urls = '{}' FROM public.products WHERE slug = 'test-alpha'),
                  'clearing the only image empties the gallery (no placeholder)');
INSERT INTO public.products (slug, brand, name, image_url) VALUES ('test-gamma', 'TestBrand', 'Gamma', '/images/products/g.webp');
SELECT pg_temp.eq((SELECT image_urls FROM public.products WHERE slug = 'test-gamma'), ARRAY['/images/products/g.webp'],
                  'inserting only image_url seeds the gallery');
SELECT pg_temp.throws($$UPDATE public.products SET image_urls = ARRAY['javascript:alert(1)'] WHERE slug = 'test-alpha'$$,
                      '22023', 'javascript: image URLs refused', 'invalid_image_url:%');
SELECT pg_temp.throws($$UPDATE public.products SET image_urls = ARRAY['//evil.example/x.png'] WHERE slug = 'test-alpha'$$,
                      '22023', 'protocol-relative image URLs refused', 'invalid_image_url:%');
SELECT pg_temp.throws($$UPDATE public.products SET image_urls = ARRAY['/\evil.example/x.png'] WHERE slug = 'test-alpha'$$,
                      '22023', 'backslash tricks ("/\host" = "//host" in browsers) refused', 'invalid_image_url:%');
SELECT pg_temp.throws($$UPDATE public.categories SET stage_image_url = '//evil.example/s.webp' WHERE id = 'test-cat-b'$$,
                      '23514', 'category stage images follow the same URL rule');
SELECT pg_temp.throws($$UPDATE public.products SET cutout_url = 'http://plain.example/x.png' WHERE slug = 'test-alpha'$$,
                      '22023', 'non-https cut-out URLs refused', 'invalid_image_url:%');
SELECT pg_temp.throws($$UPDATE public.products SET image_urls = array_fill('/images/x.webp'::text, ARRAY[1]) ||
                        ARRAY(SELECT '/images/p' || g || '.webp' FROM generate_series(1, 12) g) WHERE slug = 'test-alpha'$$,
                      '22023', 'at most 12 gallery images', 'invalid_image_url:%');
SELECT pg_temp.throws($$UPDATE public.products SET tags = ARRAY(SELECT 't' || g FROM generate_series(1, 31) g) WHERE slug = 'test-alpha'$$,
                      '22023', 'at most 30 tags', 'invalid_tags:%');
SELECT pg_temp.throws($$INSERT INTO public.products (slug, brand, name) VALUES ('Bad Slug', 'B', 'N')$$, '23514', 'slugs must be lower-case-kebab');
SELECT pg_temp.throws($$INSERT INTO public.products (slug, brand, name) VALUES ('test-alpha', 'B', 'N')$$, '23505', 'slugs are unique');
SELECT pg_temp.throws($$INSERT INTO public.products (slug, brand, name, attributes) VALUES ('test-arr', 'B', 'N', '[]')$$, '23514',
                      'attributes must be a JSON object');
SELECT pg_temp.throws($$INSERT INTO public.products (slug, brand, name) VALUES ('test-blank', '  ', 'N')$$, '23514', 'brand is required');

-- ── categories ──────────────────────────────────────────────────────────────
SELECT pg_temp.throws($$DELETE FROM public.categories WHERE id = 'test-cat'$$, '23503', 'a category with products cannot be deleted');
UPDATE public.categories SET hero_product_id = (SELECT id FROM public.products WHERE slug = 'test-gamma') WHERE id = 'test-cat-b';
DELETE FROM public.products WHERE slug = 'test-gamma';
SELECT pg_temp.eq((SELECT hero_product_id FROM public.categories WHERE id = 'test-cat-b'), NULL::int, 'deleting the hero product clears hero_product_id');
SELECT pg_temp.throws($$INSERT INTO public.categories (id, name, scene) VALUES ('test-x', 'X', 'neon')$$, '23514', 'scene must be night/paper/lime/violet');

-- ── rule collections: product side ──────────────────────────────────────────
INSERT INTO public.collections (id, title, type, rules, match) VALUES
  ('rule-tag',   'Tag rule',   'automated', '[{"field":"tag","relation":"equals","value":"Gaming"}]', 'any'),
  ('rule-brand', 'Brand rule', 'automated', '[{"field":"brand","relation":"equals","value":"testbrand"}]', 'any'),
  ('rule-cat',   'Cat rule',   'automated', '[{"field":"category","relation":"equals","value":"test-cat"}]', 'any'),
  ('rule-price', 'Price rule', 'automated', '[{"field":"price","relation":"lt","value":1100}]', 'any'),
  ('rule-new',   'New rule',   'automated', '[{"field":"is_new","relation":"equals","value":true}]', 'any'),
  ('rule-flash', 'Flash rule', 'automated', '[{"field":"is_flash_deal","relation":"equals","value":"true"}]', 'any'),
  ('rule-all',   'All rule',   'automated', '[{"field":"brand","relation":"equals","value":"TestBrand"},{"field":"price","relation":"gt","value":"900"}]', 'all'),
  ('rule-not',   'Not rule',   'automated', '[{"field":"brand","relation":"not_equals","value":"TestBrand"}]', 'any'),
  ('rule-empty', 'Empty rule', 'automated', '[]', 'any');
CREATE TEMP VIEW members AS
  SELECT pc.collection_id, string_agg(p.slug, ',' ORDER BY p.slug) AS slugs
    FROM public.product_collections pc JOIN public.products p ON p.id = pc.product_id
   WHERE p.slug LIKE 'test-%' AND pc.collection_id LIKE 'rule-%'   -- ignore seeded rule collections
   GROUP BY pc.collection_id;
SELECT pg_temp.eq((SELECT jsonb_object_agg(collection_id, slugs) FROM members),
                  '{"rule-tag":"test-alpha","rule-brand":"test-alpha","rule-cat":"test-alpha,test-beta","rule-price":"test-alpha,test-beta","rule-all":"test-alpha","rule-not":"test-beta"}'::jsonb,
                  'rules evaluate tag / brand / category / price / all / not_equals on creation (case-insensitive)');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_collections WHERE collection_id = 'rule-empty'), 0::bigint,
                  'an automated collection with no rules has no members');
SELECT pg_temp.eq((SELECT DISTINCT source FROM public.product_collections WHERE collection_id = 'rule-tag'), 'rule', 'rule rows are marked source=rule');

UPDATE public.products SET tags = ARRAY['office'] WHERE slug = 'test-alpha';
SELECT pg_temp.eq((SELECT slugs FROM members WHERE collection_id = 'rule-tag'), NULL::text, 'product side: tag change removes the rule membership');
UPDATE public.products SET is_new = TRUE, is_flash_deal = TRUE WHERE slug = 'test-alpha';
SELECT pg_temp.eq((SELECT string_agg(collection_id || '=' || slugs, ' ' ORDER BY collection_id) FROM members WHERE collection_id IN ('rule-new', 'rule-flash')),
                  'rule-flash=test-alpha rule-new=test-alpha', 'product side: is_new / is_flash_deal flags join their rule collections');
UPDATE public.products SET is_new = FALSE WHERE slug = 'test-alpha';
SELECT pg_temp.eq((SELECT slugs FROM members WHERE collection_id = 'rule-new'), NULL::text, 'product side: clearing is_new leaves the collection');
UPDATE public.products SET category_id = 'test-cat-b' WHERE slug = 'test-beta';
SELECT pg_temp.eq((SELECT slugs FROM members WHERE collection_id = 'rule-cat'), 'test-alpha', 'product side: category change re-evaluates');
UPDATE public.product_variants SET price = 850 WHERE sku = 'T-A-BASE';
SELECT pg_temp.eq((SELECT string_agg(collection_id || '=' || slugs, ' ' ORDER BY collection_id) FROM members WHERE collection_id IN ('rule-all', 'rule-price')),
                  'rule-price=test-alpha,test-beta', 'product side: a variant price change moves the from-price across rule thresholds');
UPDATE public.products SET brand = 'OtherBrand' WHERE slug = 'test-alpha';
SELECT pg_temp.eq((SELECT string_agg(collection_id || '=' || slugs, ' ' ORDER BY collection_id) FROM members WHERE collection_id IN ('rule-brand', 'rule-not')),
                  'rule-not=test-alpha,test-beta', 'product side: brand change re-evaluates equals and not_equals');

-- ── rule collections: collection side ───────────────────────────────────────
UPDATE public.collections SET rules = '[{"field":"tag","relation":"equals","value":"office"}]' WHERE id = 'rule-tag';
SELECT pg_temp.eq((SELECT slugs FROM members WHERE collection_id = 'rule-tag'), 'test-alpha', 'collection side: a rule change re-evaluates every product');
INSERT INTO public.product_collections (product_id, collection_id, source)
SELECT id, 'rule-tag', 'manual' FROM public.products WHERE slug = 'test-beta';
UPDATE public.collections SET match = 'all' WHERE id = 'rule-tag';
SELECT pg_temp.eq((SELECT string_agg(p.slug || ':' || pc.source, ',' ORDER BY p.slug) FROM public.product_collections pc
                     JOIN public.products p ON p.id = pc.product_id WHERE pc.collection_id = 'rule-tag'),
                  'test-alpha:rule,test-beta:manual', 'manual rows in an automated collection survive re-evaluation');
UPDATE public.collections SET type = 'manual' WHERE id = 'rule-tag';
SELECT pg_temp.eq((SELECT string_agg(p.slug || ':' || pc.source, ',' ORDER BY p.slug) FROM public.product_collections pc
                     JOIN public.products p ON p.id = pc.product_id WHERE pc.collection_id = 'rule-tag'),
                  'test-beta:manual', 'switching to manual drops rule rows and keeps manual ones');
UPDATE public.collections SET type = 'automated' WHERE id = 'rule-tag';
SELECT pg_temp.eq((SELECT slugs FROM members WHERE collection_id = 'rule-tag'), 'test-alpha,test-beta', 'switching back to automated re-applies the rules');

-- validation (22023 + readable message)
SELECT pg_temp.throws($$INSERT INTO public.collections (id, title, type, rules) VALUES ('bad-1', 'B', 'automated', '[{"field":"colour","relation":"equals","value":"red"}]')$$,
                      '22023', 'unknown rule field refused', 'invalid_collection_rules:%');
SELECT pg_temp.throws($$INSERT INTO public.collections (id, title, type, rules) VALUES ('bad-2', 'B', 'automated', '[{"field":"tag","relation":"contains","value":"x"}]')$$,
                      '22023', 'unsupported relation refused', 'invalid_collection_rules:%');
SELECT pg_temp.throws($$INSERT INTO public.collections (id, title, type, rules) VALUES ('bad-3', 'B', 'automated', '[{"field":"price","relation":"lt","value":"cheap"}]')$$,
                      '22023', 'non-numeric price refused', 'invalid_collection_rules:%');
SELECT pg_temp.throws($$INSERT INTO public.collections (id, title, type, rules) VALUES ('bad-4', 'B', 'automated', '[{"field":"is_new","relation":"equals","value":"maybe"}]')$$,
                      '22023', 'non-boolean flag value refused', 'invalid_collection_rules:%');
SELECT pg_temp.throws($$INSERT INTO public.collections (id, title, type, rules) VALUES ('bad-5', 'B', 'automated', '{"field":"tag"}')$$,
                      '22023', 'rules must be an array', 'invalid_collection_rules:%');
SELECT pg_temp.throws($$INSERT INTO public.collections (id, title, type, rules) VALUES ('bad-6', 'B', 'automated', '[{"field":"tag","relation":"equals","value":"  "}]')$$,
                      '22023', 'a rule needs a value', 'invalid_collection_rules:%');
SELECT pg_temp.throws($$INSERT INTO public.collections (id, title, feature_product_ids) VALUES ('bad-7', 'B', ARRAY[1,2,3])$$,
                      '23514', 'at most two feature products');
INSERT INTO public.collections (id, title, feature_product_ids) VALUES ('test-dupe-art', 'Dupe', ARRAY[5, 5, 7]);
SELECT pg_temp.eq((SELECT feature_product_ids FROM public.collections WHERE id = 'test-dupe-art'), ARRAY[5, 7], 'feature ids de-duplicated in order');
SELECT pg_temp.throws($$INSERT INTO public.collections (id, title) VALUES ('Bad Id', 'B')$$, '23514', 'collection ids are slugs');

-- ── public reads (anon) ─────────────────────────────────────────────────────
UPDATE public.products SET is_active = FALSE WHERE slug = 'test-beta';
UPDATE public.collections SET is_active = FALSE WHERE id = 'rule-not';
INSERT INTO public.product_costs (variant_id, cost_price) SELECT id, 600 FROM public.product_variants WHERE sku = 'T-A-BASE';
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT string_agg(id, ',' ORDER BY id) FROM public.categories WHERE id LIKE 'test-%'), 'test-cat,test-cat-b',
                  'anon sees active categories only');
SELECT pg_temp.eq((SELECT string_agg(slug, ',') FROM public.products WHERE slug LIKE 'test-%'), 'test-alpha', 'anon sees active, purchasable products only');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
                    WHERE p.slug = 'test-beta'), 0::bigint, 'anon sees no variants of an inactive product');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_variants WHERE sku IN ('T-B-ONLY', 'T-A-PLUS')), 0::bigint,
                  '…even when querying the variants table directly');
SELECT pg_temp.eq((SELECT count(*) FROM public.collections WHERE id = 'rule-not'), 0::bigint, 'anon does not see inactive collections');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_collections WHERE collection_id = 'rule-not'), 0::bigint,
                  'anon does not see memberships of inactive collections');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_collections pc JOIN public.products p ON p.id = pc.product_id
                    WHERE p.slug = 'test-beta'), 0::bigint, 'anon does not see memberships of hidden products');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_collections WHERE collection_id = 'rule-tag'), 1::bigint,
                  'membership rows of hidden products are filtered out of visible collections');
SELECT pg_temp.throws('SELECT * FROM public.product_costs', '42501', 'cost prices are sealed from anon');
-- anon writes: never
SELECT pg_temp.throws($$INSERT INTO public.categories (id, name) VALUES ('anon-cat', 'X')$$, '42501', 'anon cannot insert categories');
SELECT pg_temp.throws($$UPDATE public.categories SET name = 'X'$$, '42501', 'anon cannot update categories');
SELECT pg_temp.throws($$DELETE FROM public.categories$$, '42501', 'anon cannot delete categories');
SELECT pg_temp.throws($$INSERT INTO public.products (slug, brand, name) VALUES ('anon-p', 'X', 'X')$$, '42501', 'anon cannot insert products');
SELECT pg_temp.throws($$UPDATE public.products SET name = 'X'$$, '42501', 'anon cannot update products');
SELECT pg_temp.throws($$DELETE FROM public.products$$, '42501', 'anon cannot delete products');
SELECT pg_temp.throws($$INSERT INTO public.product_variants (product_id, name, price) VALUES (1, 'X', 1)$$, '42501', 'anon cannot insert variants');
SELECT pg_temp.throws($$UPDATE public.product_variants SET price = 1$$, '42501', 'anon cannot re-price variants');
SELECT pg_temp.throws($$DELETE FROM public.product_variants$$, '42501', 'anon cannot delete variants');
SELECT pg_temp.throws($$INSERT INTO public.collections (id, title) VALUES ('anon-c', 'X')$$, '42501', 'anon cannot insert collections');
SELECT pg_temp.throws($$UPDATE public.collections SET title = 'X'$$, '42501', 'anon cannot update collections');
SELECT pg_temp.throws($$INSERT INTO public.product_collections (product_id, collection_id) VALUES (1, 'rule-tag')$$, '42501', 'anon cannot add memberships');
SELECT pg_temp.throws($$DELETE FROM public.product_collections$$, '42501', 'anon cannot delete memberships');
SELECT pg_temp.throws($$INSERT INTO public.product_costs (variant_id, cost_price) VALUES (1, 1)$$, '42501', 'anon cannot write cost prices');
SELECT pg_temp.throws('TRUNCATE public.products', '42501', 'anon cannot truncate products');

-- ── signed-in shopper: reads like anon, writes nothing ──────────────────────
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.product_costs), 0::bigint, 'a shopper sees no cost prices');
SELECT pg_temp.eq((SELECT string_agg(slug, ',') FROM public.products WHERE slug LIKE 'test-%'), 'test-alpha', 'a shopper sees what anon sees');
SELECT pg_temp.throws($$INSERT INTO public.products (slug, brand, name) VALUES ('shopper-p', 'X', 'X')$$, '42501', 'a shopper cannot insert products (RLS)');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.products SET name = 'X' WHERE slug = 'test-alpha'$$), 0::bigint, 'a shopper update touches 0 products');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.products WHERE slug = 'test-alpha'$$), 0::bigint, 'a shopper delete touches 0 products');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.product_variants SET price = 1 WHERE sku = 'T-A-BASE'$$), 0::bigint, 'a shopper cannot re-price variants');
SELECT pg_temp.throws($$INSERT INTO public.product_costs (variant_id, cost_price) SELECT id, 1 FROM public.product_variants WHERE sku = 'T-A-BASE'$$,
                      '42501', 'a shopper cannot write cost prices');
SELECT pg_temp.throws($$INSERT INTO public.product_collections (product_id, collection_id) SELECT id, 'rule-empty' FROM public.products WHERE slug = 'test-alpha'$$,
                      '42501', 'a shopper cannot add memberships');
SELECT pg_temp.throws('TRUNCATE public.product_variants', '42501', 'a shopper cannot truncate');

-- ── admin: full catalogue control ───────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.products WHERE slug IN ('test-alpha', 'test-beta')), 2::bigint, 'the admin sees inactive products');
SELECT pg_temp.eq((SELECT count(*) FROM public.categories WHERE id = 'test-hidden'), 1::bigint, 'the admin sees inactive categories');
SELECT pg_temp.eq((SELECT cost_price FROM public.product_costs c JOIN public.product_variants v ON v.id = c.variant_id WHERE v.sku = 'T-A-BASE'),
                  600::numeric, 'the admin reads cost prices');
INSERT INTO public.products (slug, brand, name, category_id, price) VALUES ('test-admin-made', 'AdminBrand', 'Admin Made', 'test-cat', 12345);
INSERT INTO public.product_variants (product_id, sku, name, price)
SELECT id, 'T-ADM-1', 'Standard', 4321 FROM public.products WHERE slug = 'test-admin-made';
INSERT INTO public.product_costs (variant_id, cost_price) SELECT id, 3000 FROM public.product_variants WHERE sku = 'T-ADM-1';
INSERT INTO public.product_collections (product_id, collection_id) SELECT id, 'rule-empty' FROM public.products WHERE slug = 'test-admin-made';
SELECT pg_temp.eq((SELECT price FROM public.products WHERE slug = 'test-admin-made'), 4321::numeric,
                  'admin-created product: price comes from its variant, not the insert');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.products WHERE slug = 'test-admin-made'$$), 1::bigint, 'the admin deletes a product');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.product_variants WHERE sku = 'T-ADM-1'), 0::bigint, 'deleting a product cascades its variants');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_costs c LEFT JOIN public.product_variants v ON v.id = c.variant_id WHERE v.id IS NULL),
                  0::bigint, '…and their cost rows');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_collections pc LEFT JOIN public.products p ON p.id = pc.product_id WHERE p.id IS NULL),
                  0::bigint, '…and their collection memberships');

-- ── category slug rename cascades ───────────────────────────────────────────
UPDATE public.categories SET id = 'test-cat-renamed' WHERE id = 'test-cat';
SELECT pg_temp.eq((SELECT category_id FROM public.products WHERE slug = 'test-alpha'), 'test-cat-renamed', 'renaming a category slug follows through to products');

-- ── storage buckets + admin-only writes ─────────────────────────────────────
SELECT pg_temp.eq((SELECT string_agg(id || ':' || public, ',' ORDER BY id) FROM storage.buckets WHERE id IN ('product-images', 'content-images')),
                  'content-images:true,product-images:true', 'both image buckets exist and are public');
SELECT pg_temp.ok((SELECT bool_and(allowed_mime_types @> ARRAY['image/webp'] AND NOT allowed_mime_types @> ARRAY['image/svg+xml']
                                   AND file_size_limit = 5242880)
                     FROM storage.buckets WHERE id IN ('product-images', 'content-images')),
                  'buckets accept raster images only (no SVG), 5 MB cap');
INSERT INTO storage.buckets (id, name, public) VALUES ('someone-elses', 'someone-elses', FALSE);
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$INSERT INTO storage.objects (bucket_id, name) VALUES ('product-images', 'products/1/evil.webp')$$, '42501', 'anon cannot upload images');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws($$INSERT INTO storage.objects (bucket_id, name) VALUES ('product-images', 'products/1/evil.webp')$$, '42501', 'a shopper cannot upload images');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO storage.objects (bucket_id, name) VALUES ('product-images', 'products/1/0.webp')$$), 1::bigint,
                  'the admin uploads to product-images');
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO storage.objects (bucket_id, name) VALUES ('content-images', 'hero/1.webp')$$), 1::bigint,
                  'the admin uploads to content-images');
SELECT pg_temp.throws($$INSERT INTO storage.objects (bucket_id, name) VALUES ('someone-elses', 'x.webp')$$, '42501',
                      'the catalogue policy does not open other buckets');
SELECT pg_temp.logout();
