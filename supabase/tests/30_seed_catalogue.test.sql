-- 30_seed_catalogue.test.sql — the DEMO catalogue carries exactly what the approved design showed
-- (names, spec lines, prices, compare-at prices, merchandising lists, category cards, collection
-- tiles, existing art) and nothing invented (no descriptions, tags, warranties, extra variants,
-- SKUs, stock, costs, ratings); specs hold only facts written in the spec line or the name;
-- re-running is a no-op and the header's delete statement removes the demo cleanly.
\ir _helpers.sql
\ir _demo_only.sql

CREATE TEMP TABLE design (art text, slug text, category text, price numeric, compare_at numeric, sort_order int, attributes jsonb);
INSERT INTO design VALUES
  ('lap-01', 'vanta-g15-gaming-laptop', 'laptops', 489900, 549900, 10,
   '{"specs":{"cpu":"Ryzen 7","gpu":"RTX 4060","ram_gb":16,"storage_gb":1000,"storage_type":"SSD"},"use_cases":["gaming"]}'),
  ('lap-02', 'aeroslim-14-ultrabook', 'laptops', 329900, 369900, 40,
   '{"specs":{"cpu":"Core Ultra 5","ram_gb":16,"storage_gb":512,"weight_kg":1.2}}'),
  ('lap-03', 'forge-studio-16-creator-laptop', 'laptops', 724900, 799900, 140,
   '{"specs":{"cpu":"Core Ultra 9","gpu":"RTX 4070","ram_gb":32,"storage_gb":1000},"use_cases":["creative"]}'),
  ('lap-04', 'campus-13-everyday-laptop', 'laptops', 164900, 189900, 70,
   '{"specs":{"cpu":"Core i3","ram_gb":8,"storage_gb":256,"storage_type":"SSD"},"use_cases":["everyday"]}'),
  ('sto-01', 'bolt-x-portable-ssd-1tb', 'storage', 28900, 36500, 50,
   '{"specs":{"capacity_gb":1000,"type":"Portable SSD","interface":"USB-C 3.2","speed_mbps":1050,"rugged":"IP65"}}'),
  ('sto-02', 'atlas-slim-external-hdd-2tb', 'storage', 24500, 28900, 90,
   '{"specs":{"capacity_gb":2000,"type":"External HDD","interface":"USB 3.0"}}'),
  ('sto-03', 'duolink-flash-drive-128gb', 'storage', 4450, 5900, 150,
   '{"specs":{"capacity_gb":128,"type":"Flash drive","interface":"USB-C + USB-A"}}'),
  ('sto-04', 'vault-desktop-backup-drive-8tb', 'storage', 64900, 74900, 110,
   '{"specs":{"capacity_gb":8000,"type":"Desktop drive","interface":"USB 3.2"},"use_cases":["backup"]}'),
  ('key-01', 'kairo-75-wireless-mechanical-keyboard', 'keyboards', 32900, 38900, 30,
   '{"specs":{"switch":"Mechanical","hot_swap":true,"connectivity":["Tri-mode wireless"]}}'),
  ('key-02', 'onyx-pro-full-size-rgb-keyboard', 'keyboards', 21900, 27500, 60,
   '{"specs":{"layout":"Full-size","switch":"Linear red","backlight":"RGB"}}'),
  ('key-03', 'feather-slim-wireless-keyboard', 'keyboards', 12900, 15500, 130,
   '{"specs":{"connectivity":["Multi-device Bluetooth"]}}'),
  ('key-04', 'volt-60-compact-keyboard-acid-lime', 'keyboards', 18500, 22900, 100,
   '{"specs":{"layout":"60%","keycaps":"PBT"}}'),
  ('mou-01', 'glide-mx-ergonomic-wireless-mouse', 'mice', 24900, 29900, 20,
   '{"specs":{"dpi_max":8000,"connectivity":["Wireless"]},"use_cases":["ergonomic"]}'),
  ('mou-02', 'aero-lite-gaming-mouse-58g', 'mice', 14900, 18900, 80,
   '{"specs":{"dpi_max":26000,"weight_g":58},"use_cases":["gaming"]}'),
  ('mou-03', 'grip-vertical-ergonomic-mouse', 'mice', 9900, 12500, 160,
   '{"specs":{"grip":"vertical","silent":true},"use_cases":["ergonomic"]}'),
  ('mou-04', 'pebble-go-travel-mouse', 'mice', 5450, 6900, 120,
   '{"specs":{"connectivity":["Bluetooth"],"silent":true},"use_cases":["mobile"]}');
CREATE TEMP VIEW d_to_id AS SELECT d.art, p.id FROM design d JOIN public.products p ON p.slug = d.slug;
GRANT SELECT ON design, d_to_id TO anon, authenticated;

SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.app_config WHERE name = 'seed_30_catalogue_demo'), 'the seed marker row exists');

-- ── what shoppers see ───────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT count(*) FROM public.products p JOIN design d ON d.slug = p.slug), 16::bigint, 'all 16 demo products are visible to anon');
SELECT pg_temp.eq((SELECT count(*) FROM public.products p JOIN design d ON d.slug = p.slug
                    WHERE p.price = d.price AND p.compare_at_price = d.compare_at AND p.category_id = d.category), 16::bigint,
                  'every from-price and compare-at equals the approved design (and categories match)');
SELECT pg_temp.eq((SELECT string_agg(d.slug, ',') FROM public.products p JOIN design d ON d.slug = p.slug
                    WHERE p.image_url <> '/images/products/' || d.art || '.webp' OR p.cutout_url <> '/images/cutouts/' || d.art || '.webp'
                       OR p.image_urls <> ARRAY[p.image_url]), NULL::text, 'tile + cut-out art point at the existing public/images files');
SELECT pg_temp.eq((SELECT p.name || ' | ' || p.brand || ' | ' || p.subtitle FROM public.products p WHERE p.slug = 'vanta-g15-gaming-laptop'),
                  'Vanta G15 Gaming Laptop | Vanta | Ryzen 7 · RTX 4060 · 16GB · 1TB SSD', 'name, brand (the line word in the name) and the design''s spec line');
SELECT pg_temp.eq((SELECT string_agg(p.brand, ',' ORDER BY d.art) FROM public.products p JOIN design d ON d.slug = p.slug),
                  'Kairo,Onyx,Feather,Volt,Vanta,AeroSlim,Forge,Campus,Glide,Aero Lite,Grip,Pebble,Bolt X,Atlas,DuoLink,Vault',
                  'brands are the product-line words already in the names');
SELECT pg_temp.eq((SELECT count(*) FROM public.products p JOIN design d ON d.slug = p.slug WHERE p.name ILIKE p.brand || '%'), 16::bigint,
                  'every name starts with its brand');
SELECT pg_temp.eq((SELECT string_agg(c.id || ':' || c.stage_image_url || ':' || c.scene, ',' ORDER BY c.sort_order) FROM public.categories c
                    WHERE c.id IN ('laptops', 'storage', 'keyboards', 'mice')),
                  'laptops:/images/stages/laptops.webp:night,storage:/images/stages/storage.webp:paper,keyboards:/images/stages/keyboards.webp:lime,mice:/images/stages/mice.webp:violet',
                  'categories: order, stage images and fallback scenes as designed');
SELECT pg_temp.eq((SELECT string_agg(c.id || '=' || p.slug, ',' ORDER BY c.sort_order) FROM public.categories c JOIN public.products p ON p.id = c.hero_product_id
                    WHERE c.id IN ('laptops', 'storage', 'keyboards', 'mice')),
                  'laptops=aeroslim-14-ultrabook,storage=bolt-x-portable-ssd-1tb,keyboards=kairo-75-wireless-mechanical-keyboard,mice=glide-mx-ergonomic-wireless-mouse',
                  'category hero products as designed');
SELECT pg_temp.eq((SELECT string_agg(c.name || ' — ' || c.tagline, ' | ' ORDER BY c.sort_order) FROM public.categories c WHERE c.id IN ('laptops', 'storage', 'keyboards', 'mice')),
                  'Laptops — Ultrabooks, creator & gaming | Storage — Portable SSDs, HDDs & flash | Keyboards — Mechanical, wireless & compact | Mice — Ergonomic, gaming & travel',
                  'category names and taglines as designed');
SELECT pg_temp.eq((SELECT count(*) FROM public.categories c WHERE c.id IN ('laptops', 'storage', 'keyboards', 'mice')
                    AND (c.description IS NOT NULL OR c.seo_title IS NOT NULL OR c.seo_description IS NOT NULL)), 0::bigint,
                  'no invented category descriptions or SEO copy');
SELECT pg_temp.eq((SELECT string_agg((c ->> 'count'), ',') FROM jsonb_array_elements(public.catalogue_facets(NULL) -> 'categories') c
                    WHERE c ->> 'id' IN ('laptops', 'storage', 'keyboards', 'mice')), '4,4,4,4', 'real category counts (4 each), not the old placeholders');

-- merchandising, in the order the homepage shows it
SELECT pg_temp.eq((SELECT string_agg(d.art, ',' ORDER BY p.sort_order, p.id) FROM public.products p JOIN design d ON d.slug = p.slug WHERE p.is_flash_deal),
                  'lap-02,sto-01,key-02,lap-04,mou-02,sto-02', 'flash deals = flashDealIds, in order');
SELECT pg_temp.eq((SELECT string_agg(d.art, ',' ORDER BY p.sort_order, p.id) FROM public.products p JOIN design d ON d.slug = p.slug WHERE p.is_bestseller),
                  'lap-01,mou-01,key-01,sto-01,lap-04', 'best sellers = bestSellerIds, in order');
SELECT pg_temp.eq((SELECT string_agg(d.art, ',' ORDER BY p.created_at DESC) FROM public.products p JOIN design d ON d.slug = p.slug WHERE p.is_new),
                  'key-04,sto-04,mou-04,key-03,lap-03', 'new arrivals = newArrivalIds + isNew, newest first');
SELECT pg_temp.eq((SELECT count(*) FROM public.products p JOIN design d ON d.slug = p.slug WHERE p.is_featured), 0::bigint,
                  'no product flag the design did not have');
SELECT pg_temp.eq((SELECT count(*) FROM public.products p JOIN design d ON d.slug = p.slug WHERE p.sort_order = d.sort_order), 16::bigint,
                  'sort orders reproduce every homepage row order');

-- variants (model B): exactly one plain "Standard" variant per product at today's price
SELECT pg_temp.eq((SELECT count(*) FROM public.product_variants v JOIN public.products p ON p.id = v.product_id JOIN design d ON d.slug = p.slug),
                  16::bigint, 'exactly 16 demo variants — one per product');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_variants v JOIN public.products p ON p.id = v.product_id JOIN design d ON d.slug = p.slug
                    WHERE v.name = 'Standard' AND v.sku IS NULL AND v.option_values = '{}'::jsonb AND v.position = 0
                      AND v.weight_g IS NULL AND v.price = d.price AND v.compare_at_price = d.compare_at
                      AND p.variant_count = 1 AND p.default_variant_id = v.id), 16::bigint,
                  'each is "Standard", at the design price/compare-at, with no invented SKU, options or weight');

-- specs (BUILD_SPEC §4.4): only facts written in the spec line or the name
SELECT pg_temp.eq((SELECT string_agg(d.art || ' → ' || p.attributes::text, '; ' ORDER BY d.art)
                     FROM public.products p JOIN design d ON d.slug = p.slug WHERE p.attributes <> d.attributes), NULL::text,
                  'attributes are exactly the parsed specs (+ use_cases only where the name says it)');
SELECT pg_temp.eq((SELECT string_agg(DISTINCT u, ',' ORDER BY u) FROM public.products p JOIN design d ON d.slug = p.slug,
                          jsonb_array_elements_text(p.attributes -> 'use_cases') u),
                  'backup,creative,ergonomic,everyday,gaming,mobile', 'use_cases come only from name words (Gaming, Creator, Everyday, Travel, Ergonomic, Backup)');
SELECT pg_temp.eq((SELECT count(*) FROM public.products p JOIN design d ON d.slug = p.slug
                    WHERE p.description IS NOT NULL OR cardinality(p.tags) > 0 OR p.warranty_months IS NOT NULL
                       OR p.attributes ?| ARRAY['highlights', 'in_the_box'] OR p.seo_title IS NOT NULL OR p.seo_description IS NOT NULL),
                  0::bigint, 'no invented descriptions, tags, warranties, highlights, in-the-box lists or SEO copy');
SELECT pg_temp.eq((SELECT count(*) FROM public.products p JOIN design d ON d.slug = p.slug
                    WHERE (p.category_id = 'laptops' AND jsonb_typeof(p.attributes #> '{specs,ram_gb}') <> 'number')
                       OR (p.category_id = 'storage' AND jsonb_typeof(p.attributes #> '{specs,capacity_gb}') <> 'number')
                       OR (p.attributes #>> '{specs,grip}' IS NOT NULL AND p.attributes #>> '{specs,grip}' NOT IN ('palm', 'claw', 'fingertip', 'vertical'))),
                  0::bigint, 'numbers are numbers (sizes in decimal GB), enums hold allowed values');

-- ratings: nothing invented
SELECT pg_temp.eq((SELECT count(*) FROM public.products p JOIN design d ON d.slug = p.slug WHERE p.rating_avg <> 0 OR p.rating_count <> 0), 0::bigint,
                  'no seeded ratings (the old 4.x ★ figures were placeholders)');

-- collections
SELECT pg_temp.eq((SELECT string_agg(c.id || '[' || array_to_string(ARRAY(SELECT d.art FROM unnest(c.feature_product_ids) WITH ORDINALITY f(id, ord)
                                                                             JOIN d_to_id d ON d.id = f.id ORDER BY f.ord), '/') || ']',
                                     ',' ORDER BY c.sort_order)
                     FROM public.collections c WHERE c.is_featured),
                  'work-from-home[lap-02/key-03],gaming-zone[key-02/mou-02],campus-kit[lap-04/sto-03],creator-studio[lap-03/sto-04]',
                  'the four homepage collections, in order, with [back/front] tile art as designed');
SELECT pg_temp.eq((SELECT string_agg(c.title || ' — ' || c.subtitle, ' | ' ORDER BY c.sort_order) FROM public.collections c WHERE c.is_featured),
                  'Work from home — Essentials for productivity | Gaming zone — Level up your setup | Campus kit — Student-budget picks | Creator studio — Render, edit, back up',
                  'collection titles and tile text as designed');
SELECT pg_temp.eq((SELECT string_agg(x.id || '=' || x.members, ',' ORDER BY x.id)
                     FROM (SELECT c.id, string_agg(d.art, '/' ORDER BY pc.position) AS members
                             FROM public.collections c
                             JOIN public.product_collections pc ON pc.collection_id = c.id
                             JOIN d_to_id d ON d.id = pc.product_id
                            GROUP BY c.id) x),
                  'campus-kit=lap-04/sto-03,creator-studio=lap-03/sto-04,gaming-zone=key-02/mou-02,work-from-home=lap-02/key-03',
                  'members are exactly the two tile products (back first) — no invented extra members');
SELECT pg_temp.eq((SELECT count(*) FROM public.collections c WHERE c.description IS NOT NULL OR c.type <> 'manual'), 0::bigint,
                  'no invented collection descriptions or rule-driven collections');
SELECT pg_temp.eq((SELECT count(*) FROM public.get_product_availability(ARRAY(SELECT id FROM d_to_id))), 0::bigint,
                  'no demo variant is stock-tracked (availability lists tracked variants only)');
SELECT pg_temp.eq((SELECT count(*) FROM public.list_in_stock_product_ids() s JOIN d_to_id d ON d.id = s.product_id), 16::bigint,
                  'untracked means always sells: every demo product is in stock');
SELECT pg_temp.logout();

-- ── what only the owner sees: no invented stock, costs or reviews ────────────
SELECT pg_temp.eq((SELECT count(*) FROM public.inventory i JOIN public.product_variants v ON v.id = i.variant_id
                     JOIN public.products p ON p.id = v.product_id JOIN design d ON d.slug = p.slug), 0::bigint,
                  'no inventory rows (no invented stock numbers)');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_costs c JOIN public.product_variants v ON v.id = c.variant_id
                     JOIN public.products p ON p.id = v.product_id JOIN design d ON d.slug = p.slug), 0::bigint,
                  'no product_costs rows (no invented cost prices)');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_reviews), 0::bigint, 'no seeded reviews');

-- ── re-running the seed is a no-op ──────────────────────────────────────────
SELECT set_config('t.before', (SELECT count(*) FROM public.products)::text || '/' || (SELECT count(*) FROM public.product_variants)::text
                              || '/' || (SELECT count(*) FROM public.product_collections)::text || '/' || (SELECT count(*) FROM public.collections)::text, false);
\ir ../migrations/30_seed_catalogue.sql
SELECT pg_temp.eq((SELECT count(*) FROM public.products)::text || '/' || (SELECT count(*) FROM public.product_variants)::text
                  || '/' || (SELECT count(*) FROM public.product_collections)::text || '/' || (SELECT count(*) FROM public.collections)::text,
                  current_setting('t.before'), 'applying the seed again changes nothing');

-- ── the header's delete statement removes the demo cleanly (and it stays removed) ──
SELECT set_config('t.demo_products', (SELECT array_agg(p.id) FROM public.products p JOIN design d ON d.slug = p.slug)::text, false);
SELECT set_config('t.demo_variants', (SELECT array_agg(v.id) FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
                                        JOIN design d ON d.slug = p.slug)::text, false);
BEGIN;
DELETE FROM public.collections WHERE id IN ('work-from-home', 'gaming-zone', 'campus-kit', 'creator-studio');
DELETE FROM public.products WHERE slug IN ('vanta-g15-gaming-laptop', 'aeroslim-14-ultrabook',
  'forge-studio-16-creator-laptop', 'campus-13-everyday-laptop', 'bolt-x-portable-ssd-1tb',
  'atlas-slim-external-hdd-2tb', 'duolink-flash-drive-128gb', 'vault-desktop-backup-drive-8tb',
  'kairo-75-wireless-mechanical-keyboard', 'onyx-pro-full-size-rgb-keyboard',
  'feather-slim-wireless-keyboard', 'volt-60-compact-keyboard-acid-lime',
  'glide-mx-ergonomic-wireless-mouse', 'aero-lite-gaming-mouse-58g',
  'grip-vertical-ergonomic-mouse', 'pebble-go-travel-mouse');
SELECT pg_temp.ok((SELECT count(*) FROM public.products p JOIN design d ON d.slug = p.slug) = 0
              AND (SELECT count(*) FROM public.product_variants WHERE id = ANY (current_setting('t.demo_variants')::int[])) = 0
              AND (SELECT count(*) FROM public.product_collections WHERE product_id = ANY (current_setting('t.demo_products')::int[])) = 0
              AND (SELECT count(*) FROM public.collections WHERE id IN ('work-from-home', 'gaming-zone', 'campus-kit', 'creator-studio')) = 0
              AND (SELECT count(*) FROM public.categories WHERE hero_product_id = ANY (current_setting('t.demo_products')::int[])) = 0
              AND (SELECT count(*) FROM public.categories WHERE id IN ('laptops', 'storage', 'keyboards', 'mice')) = 4,
                  'the delete statement removes products, variants, collections, memberships and hero links (categories stay)');
\ir ../migrations/30_seed_catalogue.sql
SELECT pg_temp.eq((SELECT count(*) FROM public.products p JOIN design d ON d.slug = p.slug), 0::bigint,
                  'after deletion, re-running migrations does not resurrect the demo (marker row)');
ROLLBACK;
