-- ═════════════════════════════════════════════════════════════════════════════
-- 30_seed_catalogue.sql — Dock One Solutions
--
--   ██ DEMO — replace or delete before launch ██
--   The approved storefront design's placeholder catalogue, moved into the database and NOTHING
--   MORE (owner's rule "don't make things up", BUILD_SPEC §3, blueprint §7.3 "guessing is worse
--   than omitting", P15). Every value below comes from the old static files that drew the
--   approved design — src/data/products.ts (names, slugs, spec lines, prices, compare-at prices,
--   the flash-deal / new-arrival / best-seller lists and their order), the category cards
--   (CategoryPopouts: name, tagline, scene, hero product) and the collection tiles
--   (Collections.tsx: title, tile line, back/front products) — plus the image files that already
--   exist in public/images/**.
--
--   Deliberately NOT seeded (they would be invented): descriptions, highlights, in-the-box lists,
--   tags, warranty terms, SKUs, extra variants/configurations, stock rows (no inventory row =
--   not tracked = always sells, blueprint §7.3 — the owner enters real stock in the admin),
--   cost prices, reviews/ratings (the old 4.8 ★ / 212 figures were placeholders), category and
--   collection descriptions, and rule-driven collections.
--
--   To remove the demo catalogue (run in the SQL editor; variants and collection memberships
--   cascade; past order lines keep their name/price snapshots):
--     DELETE FROM public.collections WHERE id IN ('work-from-home', 'gaming-zone', 'campus-kit', 'creator-studio');
--     DELETE FROM public.products WHERE slug IN ('vanta-g15-gaming-laptop', 'aeroslim-14-ultrabook',
--       'forge-studio-16-creator-laptop', 'campus-13-everyday-laptop', 'bolt-x-portable-ssd-1tb',
--       'atlas-slim-external-hdd-2tb', 'duolink-flash-drive-128gb', 'vault-desktop-backup-drive-8tb',
--       'kairo-75-wireless-mechanical-keyboard', 'onyx-pro-full-size-rgb-keyboard',
--       'feather-slim-wireless-keyboard', 'volt-60-compact-keyboard-acid-lime',
--       'glide-mx-ergonomic-wireless-mouse', 'aero-lite-gaming-mouse-58g',
--       'grip-vertical-ergonomic-mouse', 'pebble-go-travel-mouse');
--   The four categories (laptops, storage, keyboards, mice) are the store's real departments and
--   are meant to stay; edit their copy in the admin panel. The app_config marker row
--   'seed_30_catalogue_demo' stays too, so re-running the migrations never brings the demo back
--   (delete that row only if you deliberately want to re-seed).
--
-- PURPOSE      4 categories (name, tagline, scene, stage image, hero product), 16 products
--              (brand = the product-line word already in the name, subtitle = the design's spec
--              line, art = the existing tile + cut-out files, merchandising flags and row order
--              from the design's lists) with EXACTLY ONE "Standard" variant each at the design's
--              price / compare-at price, attributes.specs holding only facts written in the spec
--              line or the name, use_cases only where the name says it, and the 4 homepage
--              collections with their two tile products as members.
-- DEPENDS ON   01_foundation (app_config), 04_catalogue, 05_inventory, 06_catalogue_search.
-- ENABLES      every catalogue surface with real rows; WP-B's seed 31 (homepage content)
--              references these slugs.
-- RULES        references rows by slug only (never SERIAL ids), ON CONFLICT DO NOTHING, one
--              atomic DO block guarded by an app_config marker, self-verifying at the end
--              (RAISE EXCEPTION ⇒ the whole seed rolls back).
-- SAFE TO RE-RUN: yes (second run is a no-op).
-- ═════════════════════════════════════════════════════════════════════════════

DO $seed$
DECLARE
  c_marker CONSTANT TEXT := 'seed_30_catalogue_demo';
  c_slugs  CONSTANT TEXT[] := ARRAY[
    'vanta-g15-gaming-laptop', 'aeroslim-14-ultrabook', 'forge-studio-16-creator-laptop',
    'campus-13-everyday-laptop', 'bolt-x-portable-ssd-1tb', 'atlas-slim-external-hdd-2tb',
    'duolink-flash-drive-128gb', 'vault-desktop-backup-drive-8tb',
    'kairo-75-wireless-mechanical-keyboard', 'onyx-pro-full-size-rgb-keyboard',
    'feather-slim-wireless-keyboard', 'volt-60-compact-keyboard-acid-lime',
    'glide-mx-ergonomic-wireless-mouse', 'aero-lite-gaming-mouse-58g',
    'grip-vertical-ergonomic-mouse', 'pebble-go-travel-mouse'];
  c_collections CONSTANT TEXT[] := ARRAY['work-from-home', 'gaming-zone', 'campus-kit', 'creator-studio'];
  v_bad    TEXT;
  v_n      INT;
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_config WHERE name = c_marker) THEN
    RAISE NOTICE '30_seed_catalogue: already applied (app_config %) — skipped', c_marker;
    RETURN;
  END IF;

  -- ── 1. Categories: the four pop-out cards (no description: the design has none) ───────────
  INSERT INTO public.categories (id, name, tagline, stage_image_url, scene, sort_order)
  VALUES
    ('laptops',   'Laptops',   'Ultrabooks, creator & gaming',   '/images/stages/laptops.webp',   'night',  10),
    ('storage',   'Storage',   'Portable SSDs, HDDs & flash',    '/images/stages/storage.webp',   'paper',  20),
    ('keyboards', 'Keyboards', 'Mechanical, wireless & compact', '/images/stages/keyboards.webp', 'lime',   30),
    ('mice',      'Mice',      'Ergonomic, gaming & travel',     '/images/stages/mice.webp',      'violet', 40)
  ON CONFLICT (id) DO NOTHING;

  -- ── 2. Products (price columns are derived from the variant in step 3) ─────────────────────
  --   flags: is_flash_deal = flashDealIds · is_bestseller = bestSellerIds · is_new = isNew
  --   sort_order reproduces the flash-deal and best-seller row orders; created_at is staggered
  --   so "newest first" gives the new-arrivals order (key-04, sto-04, mou-04, key-03, lap-03).
  --   specs: only what the spec line / name states (storage sizes in decimal GB: 1TB = 1000).
  INSERT INTO public.products (
    slug, brand, name, subtitle, category_id, image_urls, cutout_url, attributes,
    is_new, is_bestseller, is_flash_deal, sort_order, created_at)
  SELECT d.slug, d.brand, d.name, d.subtitle, d.category_id,
         ARRAY['/images/products/' || d.art || '.webp'], '/images/cutouts/' || d.art || '.webp',
         d.attributes::jsonb, d.is_new, d.is_bestseller, d.is_flash_deal, d.sort_order,
         now() - make_interval(days => d.age_days)
    FROM (VALUES
      ('vanta-g15-gaming-laptop', 'Vanta', 'Vanta G15 Gaming Laptop', 'Ryzen 7 · RTX 4060 · 16GB · 1TB SSD', 'laptops', 'lap-01',
       '{"specs":{"cpu":"Ryzen 7","gpu":"RTX 4060","ram_gb":16,"storage_gb":1000,"storage_type":"SSD"},"use_cases":["gaming"]}',
       FALSE, TRUE, FALSE, 10, 60),
      ('aeroslim-14-ultrabook', 'AeroSlim', 'AeroSlim 14 Ultrabook', 'Core Ultra 5 · 16GB · 512GB · 1.2kg', 'laptops', 'lap-02',
       '{"specs":{"cpu":"Core Ultra 5","ram_gb":16,"storage_gb":512,"weight_kg":1.2}}',
       FALSE, FALSE, TRUE, 40, 55),
      ('forge-studio-16-creator-laptop', 'Forge', 'Forge Studio 16 Creator Laptop', 'Core Ultra 9 · RTX 4070 · 32GB · 1TB', 'laptops', 'lap-03',
       '{"specs":{"cpu":"Core Ultra 9","gpu":"RTX 4070","ram_gb":32,"storage_gb":1000},"use_cases":["creative"]}',
       TRUE, FALSE, FALSE, 140, 5),
      ('campus-13-everyday-laptop', 'Campus', 'Campus 13 Everyday Laptop', 'Core i3 · 8GB · 256GB SSD', 'laptops', 'lap-04',
       '{"specs":{"cpu":"Core i3","ram_gb":8,"storage_gb":256,"storage_type":"SSD"},"use_cases":["everyday"]}',
       FALSE, TRUE, TRUE, 70, 50),
      ('bolt-x-portable-ssd-1tb', 'Bolt X', 'Bolt X Portable SSD 1TB', 'USB-C 3.2 · 1050MB/s · IP65', 'storage', 'sto-01',
       '{"specs":{"capacity_gb":1000,"type":"Portable SSD","interface":"USB-C 3.2","speed_mbps":1050,"rugged":"IP65"}}',
       FALSE, TRUE, TRUE, 50, 45),
      ('atlas-slim-external-hdd-2tb', 'Atlas', 'Atlas Slim External HDD 2TB', 'USB 3.0 · 2.5-inch · Aluminium', 'storage', 'sto-02',
       '{"specs":{"capacity_gb":2000,"type":"External HDD","interface":"USB 3.0"}}',
       FALSE, FALSE, TRUE, 90, 40),
      ('duolink-flash-drive-128gb', 'DuoLink', 'DuoLink Flash Drive 128GB', 'USB-C + USB-A · Metal body', 'storage', 'sto-03',
       '{"specs":{"capacity_gb":128,"type":"Flash drive","interface":"USB-C + USB-A"}}',
       FALSE, FALSE, FALSE, 150, 35),
      ('vault-desktop-backup-drive-8tb', 'Vault', 'Vault Desktop Backup Drive 8TB', 'USB 3.2 · Auto-backup software', 'storage', 'sto-04',
       '{"specs":{"capacity_gb":8000,"type":"Desktop drive","interface":"USB 3.2"},"use_cases":["backup"]}',
       TRUE, FALSE, FALSE, 110, 2),
      ('kairo-75-wireless-mechanical-keyboard', 'Kairo', 'Kairo 75 Wireless Mechanical Keyboard', 'Hot-swap · Gasket mount · Tri-mode', 'keyboards', 'key-01',
       '{"specs":{"switch":"Mechanical","hot_swap":true,"connectivity":["Tri-mode wireless"]}}',
       FALSE, TRUE, FALSE, 30, 42),
      ('onyx-pro-full-size-rgb-keyboard', 'Onyx', 'Onyx Pro Full-Size RGB Keyboard', 'Linear red switches · Aluminium plate', 'keyboards', 'key-02',
       '{"specs":{"layout":"Full-size","switch":"Linear red","backlight":"RGB"}}',
       FALSE, FALSE, TRUE, 60, 38),
      ('feather-slim-wireless-keyboard', 'Feather', 'Feather Slim Wireless Keyboard', 'Low-profile · Multi-device Bluetooth', 'keyboards', 'key-03',
       '{"specs":{"connectivity":["Multi-device Bluetooth"]}}',
       TRUE, FALSE, FALSE, 130, 4),
      ('volt-60-compact-keyboard-acid-lime', 'Volt', 'Volt 60 Compact Keyboard — Acid Lime', '60% · PBT keycaps · Coiled cable', 'keyboards', 'key-04',
       '{"specs":{"layout":"60%","keycaps":"PBT"}}',
       TRUE, FALSE, FALSE, 100, 1),
      ('glide-mx-ergonomic-wireless-mouse', 'Glide', 'Glide MX Ergonomic Wireless Mouse', '8K DPI · Metal scroll wheel · USB-C', 'mice', 'mou-01',
       '{"specs":{"dpi_max":8000,"connectivity":["Wireless"]},"use_cases":["ergonomic"]}',
       FALSE, TRUE, FALSE, 20, 58),
      ('aero-lite-gaming-mouse-58g', 'Aero Lite', 'Aero Lite Gaming Mouse 58g', '26K sensor · Honeycomb shell', 'mice', 'mou-02',
       '{"specs":{"dpi_max":26000,"weight_g":58},"use_cases":["gaming"]}',
       FALSE, FALSE, TRUE, 80, 33),
      ('grip-vertical-ergonomic-mouse', 'Grip', 'Grip Vertical Ergonomic Mouse', '57° grip angle · Silent clicks', 'mice', 'mou-03',
       '{"specs":{"grip":"vertical","silent":true},"use_cases":["ergonomic"]}',
       FALSE, FALSE, FALSE, 160, 30),
      ('pebble-go-travel-mouse', 'Pebble', 'Pebble Go Travel Mouse', 'Bluetooth · Silent · 12-month battery', 'mice', 'mou-04',
       '{"specs":{"connectivity":["Bluetooth"],"silent":true},"use_cases":["mobile"]}',
       TRUE, FALSE, FALSE, 120, 3)
    ) AS d(slug, brand, name, subtitle, category_id, art, attributes, is_new, is_bestseller, is_flash_deal, sort_order, age_days)
  ON CONFLICT (slug) DO NOTHING;

  -- ── 3. Exactly one "Standard" variant per product at the design's price ────────────────────
  INSERT INTO public.product_variants (product_id, name, price, compare_at_price, position)
  SELECT p.id, 'Standard', v.price, v.compare_at, 0
    FROM (VALUES
      ('vanta-g15-gaming-laptop',               489900, 549900),
      ('aeroslim-14-ultrabook',                 329900, 369900),
      ('forge-studio-16-creator-laptop',        724900, 799900),
      ('campus-13-everyday-laptop',             164900, 189900),
      ('bolt-x-portable-ssd-1tb',                28900,  36500),
      ('atlas-slim-external-hdd-2tb',            24500,  28900),
      ('duolink-flash-drive-128gb',               4450,   5900),
      ('vault-desktop-backup-drive-8tb',         64900,  74900),
      ('kairo-75-wireless-mechanical-keyboard',  32900,  38900),
      ('onyx-pro-full-size-rgb-keyboard',        21900,  27500),
      ('feather-slim-wireless-keyboard',         12900,  15500),
      ('volt-60-compact-keyboard-acid-lime',     18500,  22900),
      ('glide-mx-ergonomic-wireless-mouse',      24900,  29900),
      ('aero-lite-gaming-mouse-58g',             14900,  18900),
      ('grip-vertical-ergonomic-mouse',           9900,  12500),
      ('pebble-go-travel-mouse',                  5450,   6900)
    ) AS v(slug, price, compare_at)
    JOIN public.products p ON p.slug = v.slug
   WHERE NOT EXISTS (SELECT 1 FROM public.product_variants x WHERE x.product_id = p.id)
  ON CONFLICT DO NOTHING;

  -- ── 4. Category heroes (the cut-out that fronts each pop-out card) ──────────────────────────
  UPDATE public.categories c
     SET hero_product_id = p.id
    FROM (VALUES ('laptops', 'aeroslim-14-ultrabook'), ('storage', 'bolt-x-portable-ssd-1tb'),
                 ('keyboards', 'kairo-75-wireless-mechanical-keyboard'),
                 ('mice', 'glide-mx-ergonomic-wireless-mouse')) AS h(category_id, slug)
    JOIN public.products p ON p.slug = h.slug
   WHERE c.id = h.category_id AND c.hero_product_id IS NULL;

  -- ── 5. Collections: the four homepage tiles, [back, front] tile products as the members ────
  INSERT INTO public.collections (id, title, subtitle, type, rules, match, kind, is_featured, feature_product_ids, sort_order)
  SELECT c.id, c.title, c.subtitle, 'manual', '[]'::jsonb, 'any', 'curated', TRUE,
         ARRAY(SELECT p.id FROM unnest(c.art) WITH ORDINALITY AS a(slug, ord)
                 JOIN public.products p ON p.slug = a.slug ORDER BY a.ord),
         c.sort_order
    FROM (VALUES
      ('work-from-home', 'Work from home', 'Essentials for productivity', ARRAY['aeroslim-14-ultrabook', 'feather-slim-wireless-keyboard'], 10),
      ('gaming-zone',    'Gaming zone',    'Level up your setup',         ARRAY['onyx-pro-full-size-rgb-keyboard', 'aero-lite-gaming-mouse-58g'], 20),
      ('campus-kit',     'Campus kit',     'Student-budget picks',        ARRAY['campus-13-everyday-laptop', 'duolink-flash-drive-128gb'], 30),
      ('creator-studio', 'Creator studio', 'Render, edit, back up',       ARRAY['forge-studio-16-creator-laptop', 'vault-desktop-backup-drive-8tb'], 40)
    ) AS c(id, title, subtitle, art, sort_order)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.product_collections (product_id, collection_id, position, source)
  SELECT p.id, c.id, f.ord::INT - 1, 'manual'
    FROM public.collections c
    CROSS JOIN LATERAL unnest(c.feature_product_ids) WITH ORDINALITY AS f(product_id, ord)
    JOIN public.products p ON p.id = f.product_id
   WHERE c.id = ANY (c_collections)
  ON CONFLICT (product_id, collection_id) DO NOTHING;

  INSERT INTO public.app_config (name, value) VALUES (c_marker, to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))
  ON CONFLICT (name) DO NOTHING;

  -- ── 6. Self-verification: any failure rolls the whole seed back ──────────────────────────────
  -- 6a. every design product exists with exactly the design's price and compare-at price
  SELECT string_agg(format('%s (price %s/%s, compare %s/%s)', e.slug, p.price, e.price, p.compare_at_price, e.compare_at), '; ')
    INTO v_bad
    FROM (VALUES
      ('vanta-g15-gaming-laptop', 489900, 549900), ('aeroslim-14-ultrabook', 329900, 369900),
      ('forge-studio-16-creator-laptop', 724900, 799900), ('campus-13-everyday-laptop', 164900, 189900),
      ('bolt-x-portable-ssd-1tb', 28900, 36500), ('atlas-slim-external-hdd-2tb', 24500, 28900),
      ('duolink-flash-drive-128gb', 4450, 5900), ('vault-desktop-backup-drive-8tb', 64900, 74900),
      ('kairo-75-wireless-mechanical-keyboard', 32900, 38900), ('onyx-pro-full-size-rgb-keyboard', 21900, 27500),
      ('feather-slim-wireless-keyboard', 12900, 15500), ('volt-60-compact-keyboard-acid-lime', 18500, 22900),
      ('glide-mx-ergonomic-wireless-mouse', 24900, 29900), ('aero-lite-gaming-mouse-58g', 14900, 18900),
      ('grip-vertical-ergonomic-mouse', 9900, 12500), ('pebble-go-travel-mouse', 5450, 6900)
    ) AS e(slug, price, compare_at)
    LEFT JOIN public.products p ON p.slug = e.slug
   WHERE p.id IS NULL OR p.price <> e.price OR p.compare_at_price IS DISTINCT FROM e.compare_at::NUMERIC;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '30_seed_catalogue: from-price mismatch or missing product: %', v_bad;
  END IF;

  -- 6b. every demo product is visible and purchasable, with art and specs — and carries nothing
  --     the design did not have (no description, tags, warranty, highlights, in-the-box list)
  SELECT string_agg(p.slug, ', ') INTO v_bad
    FROM public.products p
   WHERE p.slug = ANY (c_slugs)
     AND (NOT p.is_active OR p.variant_count <> 1 OR p.default_variant_id IS NULL
          OR p.image_url IS NULL OR p.image_url <> p.image_urls[1] OR cardinality(p.image_urls) <> 1
          OR p.cutout_url IS NULL OR p.category_id IS NULL OR p.subtitle IS NULL
          OR jsonb_typeof(p.attributes -> 'specs') IS DISTINCT FROM 'object' OR p.attributes -> 'specs' = '{}'::jsonb
          OR p.attributes ?| ARRAY['highlights', 'in_the_box']
          OR p.description IS NOT NULL OR cardinality(p.tags) <> 0 OR p.warranty_months IS NOT NULL
          OR p.is_featured OR p.rating_count <> 0);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '30_seed_catalogue: products incomplete or carrying invented data: %', v_bad;
  END IF;

  -- 6c. counts: 16 products, 16 variants — one "Standard" per product, no SKU, no options
  SELECT count(*) INTO v_n FROM public.products WHERE slug = ANY (c_slugs);
  IF v_n <> 16 THEN RAISE EXCEPTION '30_seed_catalogue: expected 16 demo products, found %', v_n; END IF;
  SELECT count(*) INTO v_n
    FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
   WHERE p.slug = ANY (c_slugs) AND v.name = 'Standard' AND v.sku IS NULL AND v.option_values = '{}'::jsonb
     AND v.is_active AND v.weight_g IS NULL;
  IF v_n <> 16 THEN RAISE EXCEPTION '30_seed_catalogue: expected 16 plain "Standard" variants, found %', v_n; END IF;
  SELECT count(*) INTO v_n FROM public.categories
   WHERE id IN ('laptops', 'storage', 'keyboards', 'mice') AND is_active AND hero_product_id IS NOT NULL;
  IF v_n <> 4 THEN RAISE EXCEPTION '30_seed_catalogue: expected 4 categories with a hero, found %', v_n; END IF;

  -- 6d. nothing stock-tracked or costed: stock and cost prices are the owner's to enter
  SELECT count(*) INTO v_n
    FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
   WHERE p.slug = ANY (c_slugs)
     AND (EXISTS (SELECT 1 FROM public.inventory i WHERE i.variant_id = v.id)
          OR EXISTS (SELECT 1 FROM public.product_costs c WHERE c.variant_id = v.id));
  IF v_n <> 0 THEN RAISE EXCEPTION '30_seed_catalogue: % demo variants have invented stock or cost rows', v_n; END IF;

  -- 6e. the four homepage collections: featured, manual, two tile products = the two members
  SELECT string_agg(c.id, ', ') INTO v_bad
    FROM public.collections c
   WHERE c.id = ANY (c_collections)
     AND (NOT c.is_featured OR NOT c.is_active OR c.type <> 'manual' OR cardinality(c.feature_product_ids) <> 2
          OR c.description IS NOT NULL
          OR ARRAY(SELECT pc.product_id FROM public.product_collections pc
                    WHERE pc.collection_id = c.id ORDER BY pc.position) <> c.feature_product_ids);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '30_seed_catalogue: homepage collection incomplete: %', v_bad;
  END IF;

  RAISE NOTICE '30_seed_catalogue: seeded 4 categories, 16 products (one Standard variant each) and 4 collections (DEMO)';
END $seed$;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 30_seed_catalogue (DEMO)
--   Before launch: replace every demo product with real ones (admin → Products) or delete them
--   with the statement in the header. Real photography goes to the product-images bucket.
--   Stock: no demo variant is stock-tracked (no inventory rows), so each sells without limit
--   until the owner enters a stock level in the admin (Products / Inventory tabs).
--   Verification:
--     SELECT slug, price, compare_at_price, variant_count, attributes FROM public.products ORDER BY sort_order;
--     SELECT count(*) FROM public.inventory;                                        -- 0 until the owner adds stock
--     SELECT value FROM public.app_config WHERE name = 'seed_30_catalogue_demo';   -- when it ran
-- ═════════════════════════════════════════════════════════════════════════════
