-- ═════════════════════════════════════════════════════════════════════════════
-- 31_seed_storefront.sql — Dock One Solutions
--
--   ██ DEMO — replace or delete before launch ██
--   The approved homepage and chrome copy, moved out of the old components into the database and
--   NOTHING MORE (owner's rule "don't make things up", BUILD_SPEC §3 / §9 WP-B, blueprint P15):
--   Hero.tsx (3 slides + the perks strip), PromoGrid.tsx (4 bento tiles), TrustRow.tsx,
--   OrderYourWay.tsx, SignalSection.tsx (store status), NewArrivals.tsx (feature tile), Ticker.tsx
--   and the old src/data/site.ts (contact placeholders, delivery rule, "We accept" labels).
--
--   PLACEHOLDERS — replace them before launch (admin → Store settings): phone +94 11 234 5678,
--   WhatsApp +94 77 123 4567, email hello@dockone.lk, address and showroom pickup address
--   "No. 42, Galle Road, Colombo 03". They are the approved design's placeholder contact details,
--   not the store's real ones.
--   Bank transfer is NOT a placeholder: 03_store_settings fills the store's real bank account (given
--   by the owner), so the checkout offers it and the homepage lines that promise it are shown. This
--   seed does not touch the bank columns.
--   The delivery rule (Rs. 450, free from Rs. 15,000) is already 03's column default = the old
--   site.ts values, so this seed leaves those two columns alone.
--
--   Honesty fixes (P15) — REMOVED, never rewritten into new claims:
--     "-40%" and "Up to 40% off" (the deepest seeded discount is 24.6 %: DuoLink 4,450 vs 5,900),
--     "— or split it into 3 interest-free instalments", the "Pay in 3 / Interest-free instalments"
--     way, the "Pay in 3 instalments" ticker line, "Cards" and "instalments" from the perks strip,
--     "Encrypted checkout — cards," from the trust row, "Orders_dispatched 10K+" and
--     "Satisfaction 99%" from the store status, the invented testimonial ("Rashmi Fernando,
--     Verified buyer · Kandy", 5.0 from 1,284 reviews — the panel shows a real featured review or
--     an owner-entered testimonial only) and the VISA / MASTERCARD / AMEX / INSTALMENTS labels.
--     flash_sale_ends_at stays NULL: the old countdown restarted every midnight (a fake deadline),
--     so the flash-deals section stays hidden until the owner sets a real end time.
--  Figures CORRECTED to what seed 30 actually carries (the design's numbers contradicted it; the
--  wording is unchanged): hero "from Rs. 164,900" -> 329,900 (the cheapest ultrabook / creator /
--  gaming laptop; 164,900 is the everyday Campus 13), "SSDs up to 25% off" -> 21% (the only SSD,
--  Bolt X, is 20.8 % off, which the product card rounds to -21 %; 24.6 % is a flash drive),
--  "Hot-swap mechanical from Rs. 12,900" -> 32,900 (the only hot-swap keyboard), "Ergonomic &
--  ultralight from Rs. 5,450" -> 9,900 (5,450 is the travel mouse). They are demo marketing lines:
--  edit them in admin -> Homepage whenever real prices change.
--   Settings-backed facts are placeholders the storefront fills from store_settings (P6, one
--   source of truth): {free_delivery_threshold} → the free-delivery threshold (rendered as a price),
--   {returns_window_days} → the returns window. A line that uses one is hidden while that setting is
--   off, and list items carry `requires` (cod | bank_transfer | pickup | whatsapp | phone) so a
--   promise is shown only while the checkout / contact details can keep it.
--
--   To remove the demo content (run in the SQL editor — every homepage section hides itself when its
--   rows are gone):
--     DELETE FROM public.hero_slides WHERE title IN (E'Grand opening\nsale{violet:_}',
--       E'Next-gen\nlaptops{violet:.}', E'Build your\nbattle {lime:station}');
--     DELETE FROM public.promo_tiles WHERE slot BETWEEN 1 AND 4;
--     DELETE FROM public.content_blocks
--      WHERE key IN ('hero_perks', 'trust_row', 'order_your_way', 'store_status', 'new_arrivals_feature');
--     UPDATE public.store_settings SET phone = NULL, whatsapp = NULL, email = NULL, address = NULL,
--       pickup_address = NULL, pickup_note = NULL, ticker_items = '{}', accepted_payment_labels = '{}',
--       flash_sale_title = NULL;
--   The app_config marker 'seed_31_storefront_demo' stays, so re-running the migrations never brings
--   the demo back (delete that row only if you deliberately want to re-seed).
--
-- PURPOSE      Seed store_settings (contact placeholders, pickup, ticker, "We accept" labels, the
--              flash-deals heading), 3 hero slides, 4 promo tiles and the content blocks hero_perks,
--              trust_row, order_your_way, store_status and new_arrivals_feature (shapes: SQL_NOTES §16;
--              validated by src/lib/content.ts). The testimonial block is deliberately NOT seeded.
-- DEPENDS ON   01_foundation (app_config), 03_store_settings, 16_storefront_content. The product slugs
--              named in the blocks come from 30_seed_catalogue and are resolved at read time (a missing
--              or hidden product simply hides that artwork / the feature tile).
-- ENABLES      the homepage, top bar, ticker and footer rendering today's approved content from the DB.
-- RULES        no SERIAL ids; never overwrites what the owner already set (only NULL/empty settings
--              columns, slides only into an EMPTY table, ON CONFLICT DO NOTHING for tiles and blocks);
--              one atomic DO block guarded by an app_config marker; self-verifying (RAISE ⇒ the whole
--              seed rolls back).
-- SAFE TO RE-RUN: yes (a second run is a no-op).
-- ═════════════════════════════════════════════════════════════════════════════

DO $seed$
DECLARE
  c_marker    CONSTANT TEXT := 'seed_31_storefront_demo';
  c_address   CONSTANT TEXT := 'No. 42, Galle Road, Colombo 03';
  c_ticker    CONSTANT TEXT[] := ARRAY['Grand opening sale', 'Island-wide delivery', 'Cash on delivery',
                                       'Official warranty', '{returns_window_days}-day easy returns'];
  c_labels    CONSTANT TEXT[] := ARRAY['COD', 'BANK TRANSFER'];
  -- Claims the store cannot back (P15): card/instalment payments, "encrypted", invented figures.
  c_forbidden CONSTANT TEXT := '(instal|interest[- ]free|pay in 3|encrypt|\m(visa|master ?card|amex)\M|\mcards?\M|10k\+|99 ?%|40 ?%|verified buyer)';
  v_slides    INT := 0;
  v_tiles     INT := 0;
  v_blocks    TEXT[];
  v_n         INT;
  v_bad       TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_config WHERE name = c_marker) THEN
    RAISE NOTICE '31_seed_storefront: already applied (app_config %) — skipped', c_marker;
    RETURN;
  END IF;

  -- ── 0. The constants themselves never carry a claim the checkout can't honour ────────────────
  SELECT string_agg(x, ' | ') INTO v_bad FROM unnest(c_ticker || c_labels) AS x WHERE x ~* c_forbidden;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '31_seed_storefront: ticker/label copy makes a claim the store cannot back: %', v_bad;
  END IF;

  -- ── 1. store_settings: the old site.ts values, only where the row still holds nothing ─────────
  UPDATE public.store_settings SET
    phone                   = COALESCE(phone, '+94 11 234 5678'),
    whatsapp                = COALESCE(whatsapp, '+94 77 123 4567'),
    email                   = COALESCE(email, 'hello@dockone.lk'),
    address                 = COALESCE(address, c_address),
    -- showroom pickup: OrderYourWay's "Showroom pickup — Collect in Colombo 03, same day"
    pickup_address          = COALESCE(pickup_address, c_address),
    pickup_note             = COALESCE(pickup_note, 'Collect in Colombo 03, same day'),
    ticker_items            = CASE WHEN cardinality(ticker_items) = 0 THEN c_ticker ELSE ticker_items END,
    accepted_payment_labels = CASE WHEN cardinality(accepted_payment_labels) = 0 THEN c_labels ELSE accepted_payment_labels END,
    -- the section heading of FlashDeals.tsx; the end time stays NULL (see the header)
    flash_sale_title        = COALESCE(flash_sale_title, 'Flash deals')
   WHERE id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '31_seed_storefront: the store_settings row is missing — re-run 03_store_settings.sql first';
  END IF;

  -- ── 2. Hero slides (Hero.tsx) — only into an EMPTY table, never beside the owner's own ────────
  --   Links: the old in-page placeholders pointed at sections; they now open the real routes
  --   (/shop?filter=deals, /shop?category=laptops, /shop?filter=new). "/#categories" and
  --   "/#best-sellers" stay: they are sections of the homepage itself.
  IF NOT EXISTS (SELECT 1 FROM public.hero_slides) THEN
    INSERT INTO public.hero_slides (image_url, fallback_scene, tone, background, chip, eyebrow, title, body,
                                    cta_label, cta_href, secondary_label, secondary_href, readout, position)
    VALUES
      ('/images/hero/opening.webp', 'night', 'dark', '#07070b', 'Grand opening', 'Launch prices, limited time',
       E'Grand opening\nsale{violet:_}',
       'Laptops, storage, keyboards and mice at launch prices — with official warranty, cash on delivery and island-wide delivery.',
       'Shop the sale', '/shop?filter=deals', 'Browse categories', '/#categories',
       ARRAY['X_06.9271', 'Y_79.8612', 'Z_CMB.01'], 10),
      ('/images/hero/laptops.webp', 'paper', 'light', '#f6f7f9', 'New season', 'Work. Create. Play.',
       E'Next-gen\nlaptops{violet:.}',
       'Ultrabooks, creator rigs and gaming machines from Rs. 329,900.',
       'Shop laptops', '/shop?category=laptops', 'See new arrivals', '/shop?filter=new',
       ARRAY['CPU_ULTRA.9', 'RAM_32GB', 'SSD_1TB'], 20),
      ('/images/hero/gear.webp', 'violet', 'dark', '#040110', 'Keyboards + mice', 'Desk gear that keeps up',
       E'Build your\nbattle {lime:station}',
       'Hot-swap mechanical keyboards, ultralight gaming mice and the fast storage to back it all up.',
       'Shop desk gear', '/#categories', 'View best sellers', '/#best-sellers',
       ARRAY['SW_LINEAR.RED', 'DPI_26000', 'POLL_8KHZ'], 30);
    GET DIAGNOSTICS v_slides = ROW_COUNT;
  END IF;

  -- ── 3. Promo tiles (PromoGrid.tsx) — the bento geometry per slot stays in code ────────────────
  --   object-position = the old Tailwind object-[…] classes; hrefs = the category pages (the old
  --   tiles all pointed at a "/#flash-deals" placeholder).
  INSERT INTO public.promo_tiles (slot, image_url, fallback_scene, tone, background, eyebrow, title_lines, body,
                                  cta_label, href, image_position)
  VALUES
    (1, '/images/promo/laptops.webp', 'night', 'dark', '#010102', 'Limited time offer', ARRAY['Forge', 'Studio 16'],
        'Creator power from Rs. 724,900', 'Shop laptops', '/shop?category=laptops', '85% bottom'),
    (2, '/images/promo/storage.webp', 'violet', 'dark', '#7d20fc', 'Mega deal', ARRAY['SSDs up to', '21% off'],
        'Portable, rugged, 1050MB/s', 'Shop storage', '/shop?category=storage', 'center 88%'),
    (3, '/images/promo/keyboards.webp', 'paper', 'light', '#d2d2ed', 'Keyboards', ARRAY['Type', 'louder.'],
        'Hot-swap mechanical from Rs. 32,900', 'Shop keyboards', '/shop?category=keyboards', 'right 78%'),
    (4, '/images/promo/mice.webp', 'lime', 'light', '#e4fbae', 'Mice', ARRAY['Aim', 'sharper.'],
        'Ergonomic & ultralight from Rs. 9,900', 'Shop mice', '/shop?category=mice', 'right 80%')
  ON CONFLICT (slot) DO NOTHING;
  GET DIAGNOSTICS v_tiles = ROW_COUNT;

  -- ── 4. Content blocks (shapes validated by src/lib/content.ts; SQL_NOTES §16) ───────────────
  WITH inserted AS (
    INSERT INTO public.content_blocks (key, data) VALUES
      -- Hero.tsx perks strip ("Cards, COD & instalments" → "COD")
      ('hero_perks', $json${"items": [
         {"icon": "truck",   "title": "Free delivery",  "text": "Orders over {free_delivery_threshold}"},
         {"icon": "shield",  "title": "Secure payment", "text": "COD", "requires": ["cod"]},
         {"icon": "returns", "title": "Easy returns",   "text": "{returns_window_days}-day return window"}
       ]}$json$::jsonb),
      -- TrustRow.tsx ("Encrypted checkout — cards, COD and bank transfer." → "COD and bank transfer.")
      ('trust_row', $json${"items": [
         {"icon": "secure",   "title": "Secure payment", "text": "COD and bank transfer.", "requires": ["cod", "bank_transfer"]},
         {"icon": "delivery", "title": "Island-wide delivery", "text": "Same-day Colombo dispatch, 1–3 days everywhere else."},
         {"icon": "returns",  "title": "{returns_window_days}-day easy returns", "text": "Changed your mind? Send it back, hassle-free."},
         {"icon": "support",  "title": "Expert support", "text": "Real tech people on call, chat and WhatsApp."},
         {"icon": "warranty", "title": "Official warranty", "text": "Genuine products with full manufacturer warranty."}
       ]}$json$::jsonb),
      -- OrderYourWay.tsx (the "Pay in 3" way removed; art = the two cut-outs it showed)
      ('order_your_way', $json${
         "title": "Order your way",
         "body": "Checkout online, message us on WhatsApp or walk into the showroom — same prices, same warranty.",
         "items": [
           {"icon": "cod",      "title": "Cash on delivery", "text": "Pay when it reaches your door", "requires": ["cod"]},
           {"icon": "whatsapp", "title": "WhatsApp orders",  "text": "Send a list, we'll do the rest", "requires": ["whatsapp"]},
           {"icon": "store",    "title": "Showroom pickup",  "text": "Collect in Colombo 03, same day", "requires": ["pickup"]}
         ],
         "art": {"top": "atlas-slim-external-hdd-2tb", "bottom": "aero-lite-gaming-mouse-58g"}
       }$json$::jsonb),
      -- SignalSection.tsx store status (the invented "10K+" and "99%" rows removed)
      ('store_status', $json${"rows": [
         {"label": "Districts_covered", "value": "25 / 25", "level": 1},
         {"label": "Support", "value": "Online", "level": 0.72}
       ], "banner": "All systems operational"}$json$::jsonb),
      -- NewArrivals.tsx feature tile
      ('new_arrivals_feature', $json${"product": "forge-studio-16-creator-laptop", "title": "Forge Studio 16", "kicker": "The creator flagship"}$json$::jsonb)
    ON CONFLICT (key) DO NOTHING
    RETURNING key)
  SELECT COALESCE(array_agg(key ORDER BY key), '{}') INTO v_blocks FROM inserted;

  INSERT INTO public.app_config (name, value) VALUES (c_marker, to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))
  ON CONFLICT (name) DO NOTHING;

  -- ── 5. Self-verification: any failure rolls the whole seed back ──────────────────────────────
  -- 5a. what this run inserted is complete and live
  IF v_slides NOT IN (0, 3) THEN
    RAISE EXCEPTION '31_seed_storefront: expected 3 hero slides, inserted %', v_slides;
  END IF;
  IF v_slides = 3 THEN
    SELECT count(*) INTO v_n FROM public.hero_slides
     WHERE is_active AND starts_at IS NULL AND ends_at IS NULL AND cta_href IS NOT NULL AND image_url LIKE '/images/hero/%';
    IF v_n <> 3 THEN RAISE EXCEPTION '31_seed_storefront: the 3 demo slides are not all live (found %)', v_n; END IF;
  END IF;
  SELECT count(*) INTO v_n FROM public.promo_tiles WHERE slot BETWEEN 1 AND 4;
  IF v_n <> 4 THEN RAISE EXCEPTION '31_seed_storefront: expected 4 promo tiles, found %', v_n; END IF;
  SELECT string_agg(k, ', ') INTO v_bad
    FROM unnest(ARRAY['hero_perks', 'trust_row', 'order_your_way', 'store_status', 'new_arrivals_feature']) AS k
   WHERE NOT EXISTS (SELECT 1 FROM public.content_blocks b WHERE b.key = k);
  IF v_bad IS NOT NULL THEN RAISE EXCEPTION '31_seed_storefront: content blocks missing: %', v_bad; END IF;

  -- 5b. nothing this run wrote claims what the store cannot back (P15)
  SELECT string_agg(format('slide %s', s.id), ', ') INTO v_bad
    FROM public.hero_slides s
   WHERE v_slides = 3
     AND concat_ws(' ', s.chip, s.eyebrow, s.title, s.body, s.cta_label, s.secondary_label) ~* c_forbidden;
  IF v_bad IS NULL THEN
    SELECT string_agg(format('tile %s', t.slot), ', ') INTO v_bad
      FROM public.promo_tiles t
     WHERE v_tiles = 4
       AND concat_ws(' ', t.eyebrow, array_to_string(t.title_lines, ' '), t.body, t.cta_label) ~* c_forbidden;
  END IF;
  IF v_bad IS NULL THEN
    SELECT string_agg(b.key, ', ') INTO v_bad
      FROM public.content_blocks b
     WHERE b.key = ANY (v_blocks) AND b.data::TEXT ~* c_forbidden;
  END IF;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION '31_seed_storefront: seeded copy makes a claim the store cannot back: %', v_bad;
  END IF;

  -- 5c. no invented testimonial (a quote must come from a real customer)
  IF 'testimonial' = ANY (v_blocks) THEN
    RAISE EXCEPTION '31_seed_storefront: a testimonial must come from a real customer, never from a seed';
  END IF;

  RAISE NOTICE '31_seed_storefront: seeded settings placeholders, % hero slide(s), % promo tile(s) and content blocks % (DEMO)',
    v_slides, v_tiles, v_blocks;
END $seed$;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 31_seed_storefront (DEMO)
--   Before launch: replace the placeholder phone / WhatsApp / email / address (admin → Store
--   settings), check the pickup address (the bank account from 03 is real — nothing to replace),
--   then edit or delete the demo slides, tiles and blocks (admin → Homepage). Set a real
--   flash-sale end time when you run one — until then the flash-deals section stays hidden.
--   Verification:
--     SELECT phone, whatsapp, email, address, pickup_address, pickup_note, ticker_items,
--            accepted_payment_labels, flash_sale_title, flash_sale_ends_at FROM public.store_settings;
--     SELECT position, chip, cta_href, secondary_href FROM public.hero_slides ORDER BY position, id;
--     SELECT slot, title_lines, href FROM public.promo_tiles ORDER BY slot;
--     SELECT key, jsonb_pretty(data) FROM public.content_blocks ORDER BY key;
--     SELECT value FROM public.app_config WHERE name = 'seed_31_storefront_demo';   -- when it ran
-- ═════════════════════════════════════════════════════════════════════════════
