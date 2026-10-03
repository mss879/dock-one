-- 36_seed_inventory_update.test.sql — the second stock list's additions on top of 34: two new
-- items that wait (switched off) for a price, the three stock corrections, the colour / naming /
-- tag details; corrections never overwrite stock that changed since 34; re-running is a no-op.
\ir _helpers.sql

CREATE TEMP VIEW v AS
  SELECT p.slug, v.name, v.price, v.is_active, v.option_values, i.stock_level, s.colour, s.price_note
    FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
    LEFT JOIN public.inventory i ON i.variant_id = v.id
    LEFT JOIN public.variant_sourcing s ON s.variant_id = v.id;

-- ── new items: in stock, unpriced, switched off ─────────────────────────────
SELECT pg_temp.eq((SELECT format('%s|%s|%s', price, is_active, stock_level) FROM v WHERE slug = 'asus-vivobook-e1504fa-bq2909'),
                  '0.00|f|1', 'E1504FA: 1 in stock, no price, switched off');
SELECT pg_temp.eq((SELECT variant_count FROM public.products WHERE slug = 'asus-vivobook-e1504fa-bq2909'), 0,
                  'E1504FA stays hidden from shoppers until priced');
SELECT pg_temp.eq((SELECT official_title FROM public.product_sourcing s JOIN public.products p ON p.id = s.product_id
                    WHERE p.slug = 'asus-vivobook-e1504fa-bq2909'), 'E1504FA', 'E1504FA carries its brand match');
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', price, is_active, stock_level, option_values ->> 'Colour') FROM v
                    WHERE slug = 'jbl-tune-730bt' AND name = 'White'),
                  '0.00|f|1|White', 'Tune 730BT White: 1 in stock, switched off until priced');
SELECT pg_temp.eq((SELECT price FROM public.products WHERE slug = 'jbl-tune-730bt'), 17000::numeric,
                  'Tune 730BT still sells Black at its price');

-- ── stock corrections ───────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT string_agg(slug || ':' || stock_level, ',' ORDER BY slug) FROM v
                    WHERE (slug, name) IN (('asus-vivobook-a1504va-bq541', 'Standard'),
                                           ('logitech-mk270-wireless-keyboard-mouse-combo', 'Standard'),
                                           ('sandisk-cruzer-blade-cz50', '16GB'))),
                  'asus-vivobook-a1504va-bq541:2,logitech-mk270-wireless-keyboard-mouse-combo:3,sandisk-cruzer-blade-cz50:1',
                  'the stock list''s counts win');
SELECT pg_temp.ok((SELECT price_note LIKE '%the first workbook said 1.%' FROM v WHERE slug = 'asus-vivobook-a1504va-bq541'),
                  'the first workbook''s count is kept in the note');

-- ── details ─────────────────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT string_agg(colour, ',') FROM v WHERE slug = 'blackshadow-keyboard'), 'Black,Black', 'Blackshadow is Black');
SELECT pg_temp.eq((SELECT string_agg(name || ':' || stock_level, ',' ORDER BY name) FROM v WHERE slug = 'seagate-one-touch-portable-hdd'),
                  '1TB:2,2TB:3', 'One Touch 2TB variant renamed, 3 units');
SELECT pg_temp.eq((SELECT count(*) FROM public.products WHERE 'gaming laptop' = ANY (tags)), 4::bigint, 'four gaming laptops tagged');

-- ── re-run is a no-op ───────────────────────────────────────────────────────
\ir ../migrations/36_seed_inventory_update.sql
SELECT pg_temp.eq((SELECT count(*) FROM v WHERE slug = 'jbl-tune-730bt'), 2::bigint, 're-run adds nothing');

-- ── a correction never overwrites stock that changed since 34 ───────────────
DELETE FROM public.app_config WHERE name = 'seed_36_inventory_update';
UPDATE public.inventory SET stock_level = 0
 WHERE variant_id = (SELECT v.id FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
                      WHERE p.slug = 'asus-vivobook-a1504va-bq541');
\ir ../migrations/36_seed_inventory_update.sql
SELECT pg_temp.eq((SELECT stock_level FROM v WHERE slug = 'asus-vivobook-a1504va-bq541'), 0,
                  'stock sold since 34 is left alone');
