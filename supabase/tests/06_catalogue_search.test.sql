-- 06_catalogue_search.test.sql — ranking, prefix matching, plurals, filler words, typo fallback,
-- clamping, hostile input, visibility, vector maintenance, facets.
-- Runs on its OWN fixtures (categories qs-*, made-up words such as "glimmer", "plaxboard",
-- "zentor") so it never depends on seed 30's demo data — the seed rows are still present and
-- simply never match these words.
\ir _helpers.sql
\ir _demo_only.sql

-- ── fixtures ────────────────────────────────────────────────────────────────
INSERT INTO public.categories (id, name, sort_order) VALUES
  ('qs-glim', 'Glimmers', 900), ('qs-plax', 'Plaxes', 910), ('qs-disk', 'Zeddisks', 920);
INSERT INTO public.products (slug, brand, name, subtitle, description, category_id, tags, attributes, sort_order) VALUES
  ('qs-vortan-9', 'Vortan', 'Vortan 9 Gaming Glimmer', 'Zentor 7 · QTX 4090 · 16GB', NULL, 'qs-glim', '{}', '{}', 910),
  ('qs-arlo-slim', 'Arlo', 'Arlo Slim Glimmer', 'Zentor 5 · 8GB', NULL, 'qs-glim', '{}', '{}', 920),
  ('qs-quarkbolt', 'Quarkbolt', 'Quarkbolt Flarnable Zeddisk 1TB', 'Zentor-C · 1050MB/s', NULL, 'qs-disk', '{}',
   '{"specs":{"rugged":"IP68"}}', 930),
  ('qs-trundle', 'Trundle', 'Trundle Backup Zeddisk 4TB', 'Zentor 3 · Desk', 'A plain fixture drive.', 'qs-disk', '{}', '{}', 940),
  ('qs-mektra', 'Mektra', 'Mektra Plaxboard 75', 'Hot-swap · Zentor switches', NULL, 'qs-plax', '{}', '{}', 950),
  ('qs-onvo', 'Onvo', 'Onvo Plaxboard Pro', 'Linear switches', NULL, 'qs-plax', '{}', '{}', 960),
  ('qs-fethra', 'Fethra', 'Fethra Plaxboard Slim', 'Low-profile', NULL, 'qs-plax', '{}', '{}', 970),
  ('qs-voltra', 'Voltra', 'Voltra Plaxboard 60', 'Compact', NULL, 'qs-plax', '{}', '{}', 980);
INSERT INTO public.product_variants (product_id, sku, name, option_values, price, position)
SELECT p.id, v.sku, v.name, v.options::jsonb, v.price, v.pos
  FROM (VALUES
    ('qs-vortan-9',  'QSV-X15-16', '16GB',     '{"Memory":"16GB"}', 1000, 0),
    ('qs-vortan-9',  'QSV-X15-32', '32GB',     '{"Memory":"32GB"}', 1200, 1),
    ('qs-arlo-slim', 'QSA-1',      'Standard', '{}',                 900, 0),
    ('qs-quarkbolt', 'QSQ-1',      'Standard', '{}',                 500, 0),
    ('qs-trundle',   'QST-1',      'Standard', '{}',                 800, 0),
    ('qs-mektra',    'QSM-SAND',   'Graphite', '{"Colour":"Graphite"}', 330, 0),
    ('qs-mektra',    'QSM-NIGHT',  'Midnight', '{"Colour":"Midnight"}', 330, 1),
    ('qs-onvo',      'QSO-1',      'Standard', '{}',                 220, 0),
    ('qs-fethra',    'QSF-1',      'Standard', '{}',                 129, 0),
    ('qs-voltra',    'QSVL-1',     'Standard', '{}',                 185, 0)
  ) AS v(slug, sku, name, options, price, pos)
  JOIN public.products p ON p.slug = v.slug;

-- helper: slugs of a search, in rank order (runs as the current role)
CREATE OR REPLACE FUNCTION pg_temp.search_slugs(p_q text, p_limit int DEFAULT 24, p_offset int DEFAULT 0)
RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(p.slug, ',' ORDER BY s.ord), '')
    FROM (SELECT r.product_id, row_number() OVER () AS ord FROM public.search_products(p_q, p_limit, p_offset) r) s
    JOIN public.products p ON p.id = s.product_id
$$;
CREATE OR REPLACE FUNCTION pg_temp.search_total(p_q text) RETURNS int LANGUAGE sql AS $$
  SELECT COALESCE(max(total_count), 0) FROM public.search_products(p_q, 48, 0)
$$;
CREATE OR REPLACE FUNCTION pg_temp.sorted(p_csv text) RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(x, ',' ORDER BY x), '') FROM unnest(string_to_array(NULLIF(p_csv, ''), ',')) x
$$;

SELECT pg_temp.eq((SELECT count(*) FROM public.products WHERE search_vector IS NULL), 0::bigint, 'every product has a search vector');
SELECT pg_temp.ok(has_function_privilege('anon', 'public.search_products(text,integer,integer)', 'EXECUTE')
              AND has_function_privilege('anon', 'public.catalogue_facets(text)', 'EXECUTE'), 'search + facets are public');
SELECT pg_temp.ok(NOT has_function_privilege('anon', 'public._search_tsquery(text)', 'EXECUTE')
              AND NOT has_function_privilege('anon', 'public.product_search_document(public.products)', 'EXECUTE')
              AND NOT has_function_privilege('anon', 'public._quote_tsquery_lexeme(text)', 'EXECUTE'), 'search internals are not');
SELECT pg_temp.eq(pg_get_function_result('public.search_products(text,integer,integer)'::regprocedure),
                  'TABLE(product_id integer, rank real, total_count integer)', 'search_products returns (product_id, rank, total_count)');

SELECT pg_temp.login_anon();
-- ── relevance ───────────────────────────────────────────────────────────────
SELECT pg_temp.ok(split_part(pg_temp.search_slugs('zeddisk'), ',', 1) IN ('qs-quarkbolt', 'qs-trundle')
              AND pg_temp.search_total('zeddisk') = 2, '"zeddisk" finds the two drives');
SELECT pg_temp.eq(pg_temp.sorted(pg_temp.search_slugs('plaxb', 4)), 'qs-fethra,qs-mektra,qs-onvo,qs-voltra',
                  '"plaxb" (prefix) finds the four plaxboards');
SELECT pg_temp.eq(pg_temp.sorted(pg_temp.search_slugs('Plaxboards', 4)), 'qs-fethra,qs-mektra,qs-onvo,qs-voltra',
                  'plural "Plaxboards" folds to the singular (case-insensitive)');
SELECT pg_temp.ok(split_part(pg_temp.search_slugs('gaming glimmer'), ',', 1) = 'qs-vortan-9', '"gaming glimmer" → the gaming glimmer first');
SELECT pg_temp.eq(pg_temp.search_slugs('glimmer for gaming'), pg_temp.search_slugs('gaming glimmer'), 'filler words ("for") are ignored');
SELECT pg_temp.eq(pg_temp.search_slugs('Arlo'), 'qs-arlo-slim', 'brand search is exact');
SELECT pg_temp.ok(split_part(pg_temp.search_slugs('qtx 4090'), ',', 1) = 'qs-vortan-9', 'model numbers match (qtx 4090)');
SELECT pg_temp.eq(pg_temp.search_slugs('ip68'), 'qs-quarkbolt', 'spec values from attributes are searchable');
SELECT pg_temp.ok(pg_temp.sorted(pg_temp.search_slugs('plaxes')) = 'qs-fethra,qs-mektra,qs-onvo,qs-voltra'
              AND pg_temp.search_total('plaxes') = 4, 'the category name finds its products ("plaxes")');
SELECT pg_temp.ok(position('qs-mektra' IN pg_temp.search_slugs('graphite')) > 0, 'variant names are searchable ("graphite")');
SELECT pg_temp.ok(position('qs-vortan-9' IN pg_temp.search_slugs('QSV-X15-32')) > 0, 'SKUs are searchable');
SELECT pg_temp.ok(position('qs-vortan-9' IN pg_temp.search_slugs('32gb glimmer')) > 0, 'option values are searchable');
SELECT pg_temp.ok(split_part(pg_temp.search_slugs('vortan'), ',', 1) = 'qs-vortan-9'
              AND (SELECT rank FROM public.search_products('vortan', 1, 0)) >= 0.5,
                  'a name/brand that starts with the query gets the 0.5 boost');

-- ── typo fallback (pg_trgm) ─────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    PERFORM pg_temp.ok(pg_temp.search_total('plaxbord') = 4 AND pg_temp.search_slugs('plaxbord') LIKE '%qs-%',
                       'typo "plaxbord" falls back to fuzzy matching');
    PERFORM pg_temp.ok(split_part(pg_temp.search_slugs('flarnible zeddisk'), ',', 1) = 'qs-quarkbolt', 'typo "flarnible zeddisk" finds the drive');
  ELSE
    RAISE NOTICE 'SKIP: pg_trgm not installed — fuzzy fallback not tested';
  END IF;
END $$;
SELECT pg_temp.eq(pg_temp.search_slugs('xyzzyqq'), '', 'nonsense finds nothing');

-- ── paging and clamping ─────────────────────────────────────────────────────
SELECT pg_temp.ok(pg_temp.search_total('zentor') >= 5, '"zentor" matches several fixtures');
SELECT pg_temp.eq((SELECT count(*) FROM public.search_products('zentor', 48, 0)), pg_temp.search_total('zentor')::bigint,
                  'total_count equals the number of matches');
SELECT pg_temp.ok((SELECT count(DISTINCT total_count) = 1 FROM public.search_products('zentor', 48, 0)), 'total_count is repeated on every row');
SELECT pg_temp.ok(pg_temp.search_slugs('zentor', 2, 0) <> '' AND pg_temp.search_slugs('zentor', 2, 2) <> ''
              AND pg_temp.search_slugs('zentor', 2, 0) || ',' || pg_temp.search_slugs('zentor', 2, 2) = pg_temp.search_slugs('zentor', 4, 0),
                  'pages are stable and contiguous');
SELECT pg_temp.eq((SELECT count(*) FROM public.search_products('zentor', 2, 1000)), 0::bigint, 'a page past the end is empty');
SELECT pg_temp.eq((SELECT count(*) FROM public.search_products('glimmer', 0, 0)), 1::bigint, 'limit < 1 is clamped to 1');
SELECT pg_temp.eq((SELECT count(*) FROM public.search_products('glimmer', -3, -9)), 1::bigint, 'negative limit/offset are clamped');
SELECT pg_temp.eq((SELECT count(*) FROM public.search_products('a', 1000, 0)) <= 48, TRUE, 'limit is capped at 48');
SELECT pg_temp.eq((SELECT count(*) FROM public.search_products('glimmer', NULL, NULL)), pg_temp.search_total('glimmer')::bigint,
                  'NULL limit/offset use the defaults (24 from 0)');
SELECT set_config('t.glimmer_total', pg_temp.search_total('glimmer')::text, false);

-- ── hostile / empty input never errors ──────────────────────────────────────
SELECT pg_temp.eq((SELECT count(*) FROM public.search_products(NULL)), 0::bigint, 'NULL query → nothing');
SELECT pg_temp.eq((SELECT count(*) FROM public.search_products('   ')), 0::bigint, 'blank query → nothing');
SELECT pg_temp.eq((SELECT count(*) FROM public.search_products($q$'" & | ! :* () <-> \ $$ --$q$)), 0::bigint,
                  'tsquery operators and quotes in the input are inert');
SELECT pg_temp.ok((SELECT count(*) >= 0 FROM public.search_products(repeat('zeddisk ', 500))), 'very long queries are truncated, not rejected');
SELECT set_config('t.big_started', clock_timestamp()::text, false);
SELECT pg_temp.ok((SELECT count(*) >= 0 FROM public.search_products(repeat('plaxboard ', 200000)))
              AND (public.catalogue_facets(repeat('x', 1000000)) ->> 'total')::int = 0
              AND clock_timestamp() - current_setting('t.big_started')::timestamptz < interval '2 seconds',
                  'megabyte-sized inputs are truncated before any work (fast, no error)');
SELECT pg_temp.ok((SELECT count(*) >= 0 FROM public.search_products($q$o'neil it's plaxb's$q$)), 'apostrophes are handled');
SELECT pg_temp.ok(position('qs-mektra' IN pg_temp.search_slugs($q$plaxb's$q$)) > 0, 'one-letter fragments are dropped ("plaxb''s" → plaxb)');
SELECT pg_temp.ok((SELECT count(*) >= 0 FROM public.search_products('ශ්‍රී ලංකා தமிழ்')), 'Sinhala/Tamil input does not error');

-- ── visibility ──────────────────────────────────────────────────────────────
SELECT pg_temp.logout();
UPDATE public.products SET is_active = FALSE WHERE slug = 'qs-vortan-9';
UPDATE public.product_variants SET is_active = FALSE WHERE product_id = (SELECT id FROM public.products WHERE slug = 'qs-arlo-slim');
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(pg_temp.search_slugs('vortan'), '', 'inactive products are never returned');
SELECT pg_temp.eq(pg_temp.search_slugs('arlo'), '', 'products without an active variant are never returned');
SELECT pg_temp.eq(pg_temp.search_total('glimmer'), current_setting('t.glimmer_total')::int - 2, 'totals count visible products only');

-- ── the vector follows the data ─────────────────────────────────────────────
SELECT pg_temp.logout();
UPDATE public.product_variants SET name = 'Zephyr blue' WHERE sku = 'QSM-NIGHT';
UPDATE public.categories SET name = 'Plaxes & pointers' WHERE id = 'qs-plax';
UPDATE public.products SET tags = tags || ARRAY['quokka'] WHERE slug = 'qs-trundle';
UPDATE public.products SET description = 'Wombat approved.' WHERE slug = 'qs-quarkbolt';
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(pg_temp.search_slugs('zephyr'), 'qs-mektra', 'renaming a variant re-indexes its product');
SELECT pg_temp.eq(pg_temp.search_total('pointers'), 4, 'renaming a category re-indexes its products');
SELECT pg_temp.eq(pg_temp.search_slugs('quokka'), 'qs-trundle', 'tag edits are indexed');
SELECT pg_temp.eq(pg_temp.search_slugs('wombat'), 'qs-quarkbolt', 'description edits are indexed');
SELECT pg_temp.logout();
DELETE FROM public.product_variants WHERE sku = 'QSM-NIGHT';
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(pg_temp.search_slugs('zephyr'), '', 'deleting a variant drops its terms');

-- ── facets ──────────────────────────────────────────────────────────────────
SELECT set_config('t.f_all', public.catalogue_facets(NULL)::text, false);
SELECT set_config('t.f_plax', public.catalogue_facets('QS-PLAX ')::text, false);
SELECT set_config('t.f_none', public.catalogue_facets('no-such-category')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg((c ->> 'id') || '=' || (c ->> 'count'), ',' ORDER BY ord)
                     FROM jsonb_array_elements(current_setting('t.f_all')::jsonb -> 'categories') WITH ORDINALITY AS x(c, ord)
                    WHERE c ->> 'id' LIKE 'qs-%'),
                  'qs-glim=0,qs-plax=4,qs-disk=2', 'category counts are real visible counts (zeros included), in sort order');
SELECT pg_temp.eq((current_setting('t.f_all')::jsonb ->> 'total')::bigint,
                  (SELECT count(*) FROM public.products WHERE is_active AND variant_count > 0), 'total counts visible products');
SELECT pg_temp.eq(jsonb_array_length(current_setting('t.f_all')::jsonb -> 'categories')::bigint,
                  (SELECT count(*) FROM public.categories WHERE is_active), 'every active category is listed');
SELECT pg_temp.eq((current_setting('t.f_plax')::jsonb ->> 'total')::int, 4, 'category scoping (trimmed, case-insensitive)');
SELECT pg_temp.eq((SELECT string_agg(b ->> 'brand', ',' ORDER BY ord) FROM jsonb_array_elements(current_setting('t.f_plax')::jsonb -> 'brands') WITH ORDINALITY AS x(b, ord)),
                  'Fethra,Mektra,Onvo,Voltra', 'brands within the category, alphabetical');
SELECT pg_temp.eq(current_setting('t.f_plax')::jsonb -> 'price', '{"min": 129.00, "max": 330.00}'::jsonb, 'price range within the category');
SELECT pg_temp.ok((current_setting('t.f_none')::jsonb ->> 'total')::int = 0 AND current_setting('t.f_none')::jsonb -> 'price' -> 'min' = 'null'::jsonb
              AND jsonb_array_length(current_setting('t.f_none')::jsonb -> 'categories') = (SELECT count(*) FROM public.categories WHERE is_active),
                  'unknown category: empty scope, categories still listed');
UPDATE public.products SET brand = 'mektra ' WHERE slug = 'qs-onvo';
SELECT pg_temp.eq((SELECT string_agg((b ->> 'brand') || ':' || (b ->> 'count'), ',' ORDER BY ord)
                     FROM jsonb_array_elements(public.catalogue_facets('qs-plax') -> 'brands') WITH ORDINALITY AS x(b, ord)),
                  'Fethra:1,Mektra:2,Voltra:1', 'brands group case-insensitively (trimmed)');
