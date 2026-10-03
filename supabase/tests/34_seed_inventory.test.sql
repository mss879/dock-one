-- 34_seed_inventory.test.sql — the real catalogue from the client's workbook: the counts, prices
-- and stock totals match the sheet; variant families are grouped; price ranges use the lower
-- figure; the unpriced 16GB Cruzer Blade is switched off; the demo catalogue is hidden (not
-- deleted); the sourcing tables are admin-only; re-running is a no-op.
-- (Cost and dealer prices live in the git-ignored 35_seed_inventory_costs.sql — not tested here.)
\ir _helpers.sql

CREATE TEMP VIEW real AS
  SELECT p.* FROM public.products p
   WHERE EXISTS (SELECT 1 FROM public.variant_sourcing s JOIN public.product_variants v ON v.id = s.variant_id
                  WHERE v.product_id = p.id);

-- ── counts and totals = the workbook ────────────────────────────────────────
SELECT pg_temp.eq((SELECT count(*) FROM real), 59::bigint, '59 products');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_variants v JOIN real p ON p.id = v.product_id), 86::bigint,
                  '86 variants = the 86 stock rows');
SELECT pg_temp.eq((SELECT sum(v.price) FROM public.product_variants v JOIN real p ON p.id = v.product_id), 6241300::numeric,
                  'selling prices total Rs. 6,241,300 (ranges at their lower figure)');
SELECT pg_temp.eq((SELECT sum(i.stock_level) FROM public.inventory i JOIN real p ON p.id = i.product_id), 268::bigint,
                  'stock totals 268 units (the Quantity column)');
SELECT pg_temp.eq((SELECT count(*) FROM public.inventory i JOIN real p ON p.id = i.product_id), 86::bigint,
                  'every variant is stock-tracked');
SELECT pg_temp.eq((SELECT string_agg(DISTINCT s.source_row::text, ',') IS NOT NULL
                     AND count(DISTINCT s.source_row) = 86 AND min(s.source_row) = 6 AND max(s.source_row) = 91
                     FROM public.variant_sourcing s), TRUE, 'each workbook row 6–91 is exactly one variant');

-- ── visibility: every real product is live and purchasable ──────────────────
SELECT pg_temp.eq((SELECT count(*) FROM real WHERE is_active AND variant_count > 0 AND price > 0 AND default_variant_id IS NOT NULL),
                  59::bigint, 'all 59 products are live with a from-price');
SELECT pg_temp.eq((SELECT count(*) FROM public.products
                    WHERE slug IN ('vanta-g15-gaming-laptop', 'bolt-x-portable-ssd-1tb', 'pebble-go-travel-mouse') AND NOT is_active),
                  3::bigint, 'demo products are hidden, not deleted');
SELECT pg_temp.eq((SELECT count(*) FROM public.products p JOIN public.app_config c ON c.name = 'seed_30_catalogue_demo'
                    WHERE p.slug LIKE 'vanta-%' OR p.slug LIKE 'aeroslim-%'), 2::bigint, 'demo rows still exist');

-- ── families, ranges, the switched-off variant ──────────────────────────────
SELECT pg_temp.eq((SELECT string_agg(v.name || '=' || v.price::int || '/' || i.stock_level, ', ' ORDER BY v.position)
                     FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
                     JOIN public.inventory i ON i.variant_id = v.id
                    WHERE p.slug = 'fujifilm-instax-mini-12'),
                  'Lilac Purple=31000/2, Mint Green=31000/1, Pastel Blue=31000/1', 'instax mini 12: three colour variants, own stock');
SELECT pg_temp.eq((SELECT string_agg(v.option_values ->> 'Graphics', ', ' ORDER BY v.position)
                     FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
                    WHERE p.slug = 'msi-cyborg-15-core-7-240h'),
                  'RTX 5060 8GB, RTX 5070 8GB', 'MSI Cyborg 15 (Core 7 240H): GPU variants');
SELECT pg_temp.eq((SELECT p.price FROM public.products p WHERE p.slug = 'msi-cyborg-15-core-7-240h'), 515000::numeric,
                  'from-price is the cheapest variant');
SELECT pg_temp.eq((SELECT v.price || ' | ' || s.price_note
                     FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
                     JOIN public.variant_sourcing s ON s.variant_id = v.id
                    WHERE p.slug = 'asus-vivobook-a1504va-bq541'),
                  '215000.00 | Final selling range in the stock list: 215,000-220,000 (shop price set to the lower figure).',
                  'a price range becomes the lower figure, the range is kept');
SELECT pg_temp.eq((SELECT NOT v.is_active AND v.price = 0 AND i.stock_level = 0
                     FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
                     JOIN public.inventory i ON i.variant_id = v.id
                    WHERE p.slug = 'sandisk-cruzer-blade-cz50' AND v.name = '16GB'), TRUE,
                  'unpriced 16GB Cruzer Blade is switched off');
SELECT pg_temp.eq((SELECT p.price FROM public.products p WHERE p.slug = 'sandisk-cruzer-blade-cz50'), 4700::numeric,
                  'Cruzer Blade still sells its 128GB variant');

-- ── departments ─────────────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT string_agg(id, ',' ORDER BY sort_order) FROM public.categories WHERE is_active),
                  'laptops,storage,keyboards,mice,monitors,audio,power-charging,cameras,components', 'nine departments in order');
SELECT pg_temp.eq((SELECT name FROM public.categories WHERE id = 'mice'), 'Mice & Mousepads', 'mice renamed');
SELECT pg_temp.eq((SELECT string_agg(c.id || ':' || n, ',' ORDER BY c.sort_order)
                     FROM (SELECT category_id, count(*) n FROM real GROUP BY 1) x JOIN public.categories c ON c.id = x.category_id),
                  'laptops:13,storage:13,keyboards:6,mice:6,monitors:3,audio:5,power-charging:7,cameras:4,components:2',
                  'products per department');

-- ── nothing invented ────────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT count(*) FROM real WHERE description IS NOT NULL OR warranty_months IS NOT NULL
                     OR cardinality(image_urls) > 0 OR is_new OR is_bestseller OR is_flash_deal OR is_featured), 0::bigint,
                  'no descriptions, warranty, images or merchandising flags invented');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_variants v JOIN real p ON p.id = v.product_id WHERE v.sku IS NOT NULL),
                  0::bigint, 'no SKUs invented');
SELECT pg_temp.eq((SELECT attributes -> 'highlights' FROM public.products WHERE slug = 'jbl-live-770nc'),
                  '["Wireless Over-Ear Headphones with True Adaptive Noise Cancelling"]'::jsonb,
                  'highlights are the brand''s verbatim excerpt');
SELECT pg_temp.ok((SELECT review_notes LIKE 'HOLD:%' FROM public.product_sourcing s JOIN public.products p ON p.id = s.product_id
                    WHERE p.slug = 'iron-hawk-tri-mode-gaming-keyboard') IS NOT NULL, 'Iron Hawk carries its HOLD note');

-- ── admin-only sourcing ─────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT 1 FROM public.product_sourcing LIMIT 1', '42501', 'anon cannot read product_sourcing');
SELECT pg_temp.throws('SELECT 1 FROM public.variant_sourcing LIMIT 1', '42501', 'anon cannot read variant_sourcing');
SELECT pg_temp.logout();

-- ── re-run is a no-op ───────────────────────────────────────────────────────
\ir ../migrations/34_seed_inventory.sql
SELECT pg_temp.eq((SELECT count(*) FROM real), 59::bigint, 're-run adds nothing');
