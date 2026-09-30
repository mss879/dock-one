-- 31_seed_storefront.test.sql — the DEMO homepage/chrome content: exactly the approved copy with
-- the P15 fixes (nothing the checkout can't honour, no invented figures or testimonial), the contact
-- placeholders, honest payment/pickup state, live slides/tiles for anon, blocks that name real seed
-- products, idempotent re-runs, and a seed that never overwrites the owner's own values.
\ir _helpers.sql

-- ── 1. store_settings ────────────────────────────────────────────────────────
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.app_config WHERE name = 'seed_31_storefront_demo'), 'the seed marker is recorded');
SELECT pg_temp.ok((SELECT phone = '+94 11 234 5678' AND whatsapp = '+94 77 123 4567' AND email = 'hello@dockone.lk'
                          AND address = 'No. 42, Galle Road, Colombo 03' FROM public.store_settings),
                  'contact placeholders = the old site.ts values');
SELECT pg_temp.ok((SELECT delivery_fee = 450 AND free_delivery_threshold = 15000 FROM public.store_settings),
                  'delivery rule Rs. 450, free from Rs. 15,000 (03 defaults = the old site.ts values)');
SELECT pg_temp.ok((SELECT pickup_enabled AND pickup_address = 'No. 42, Galle Road, Colombo 03'
                          AND pickup_note = 'Collect in Colombo 03, same day' FROM public.store_settings),
                  'showroom pickup from the existing copy + the address placeholder');
SELECT pg_temp.ok((SELECT bank_transfer_enabled AND bank_transfer_instructions IS NULL AND bank_account_name = 'Dock One Solutions Pvt Ltd'
                          AND bank_name = 'Bank of Ceylon' AND bank_branch = 'Vishaka' AND bank_account_number = '79503030'
                          FROM public.store_settings),
                  'bank transfer on with the store''s real account from 03 (the seed adds no bank details of its own)');
SELECT pg_temp.eq((SELECT ticker_items FROM public.store_settings),
                  ARRAY['Grand opening sale', 'Island-wide delivery', 'Cash on delivery', 'Official warranty', '{returns_window_days}-day easy returns'],
                  'ticker = Ticker.tsx without "Up to 40% off" and "Pay in 3 instalments"');
SELECT pg_temp.eq((SELECT accepted_payment_labels FROM public.store_settings), ARRAY['COD', 'BANK TRANSFER'],
                  '"We accept" = COD and bank transfer only (no card or instalment labels)');
SELECT pg_temp.ok((SELECT flash_sale_title = 'Flash deals' AND flash_sale_ends_at IS NULL FROM public.store_settings),
                  'flash-deals heading kept, NO invented end time (the section stays hidden)');
SELECT pg_temp.ok((SELECT socials = '{}'::jsonb AND business_reg_no IS NULL AND announcement IS NULL AND map_url IS NULL
                          AND opening_hours IS NULL AND cod_enabled AND returns_window_days = 7 FROM public.store_settings),
                  'nothing else invented (socials, registration no., hours, map, announcement)');

-- The checkout's view of the seeded state: COD, pickup and bank transfer (the real account) are all offered.
SELECT pg_temp.login_anon();
SELECT set_config('t.q', public.quote_order(
  (SELECT jsonb_build_array(jsonb_build_object('product_id', p.id, 'variant_id', p.default_variant_id, 'quantity', 1))
     FROM public.products p WHERE p.is_active AND p.variant_count > 0 ORDER BY p.id LIMIT 1), NULL, 'delivery')::text, false);
SELECT pg_temp.eq(format('%s|%s|%s', current_setting('t.q')::jsonb ->> 'cod_available', current_setting('t.q')::jsonb ->> 'pickup_available',
                         current_setting('t.q')::jsonb ->> 'bank_transfer_available'), 'true|true|true',
                  'quote_order: COD, pickup and bank transfer available');
SELECT pg_temp.logout();

-- ── 2. hero slides ───────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT string_agg(chip, ' | ' ORDER BY position, id) FROM public.hero_slides), 'Grand opening | New season | Keyboards + mice',
                  'anon sees the three Hero.tsx slides, in order');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(title, ' | ' ORDER BY position) FROM public.hero_slides),
                  E'Grand opening\nsale{violet:_} | Next-gen\nlaptops{violet:.} | Build your\nbattle {lime:station}',
                  'titles in the safe mini-markup, "-40%" removed');
SELECT pg_temp.eq((SELECT body FROM public.hero_slides WHERE chip = 'New season'), 'Ultrabooks, creator rigs and gaming machines from Rs. 329,900.',
                  'slide 2 body without the instalment offer');
SELECT pg_temp.eq((SELECT string_agg(cta_href || ' ' || secondary_href, ' | ' ORDER BY position) FROM public.hero_slides),
                  '/shop?filter=deals /#categories | /shop?category=laptops /shop?filter=new | /#categories /#best-sellers',
                  'slide links: real routes instead of the old /#flash-deals and /#new-arrivals placeholders');
SELECT pg_temp.eq((SELECT string_agg(image_url || '@' || background || '/' || tone || '/' || fallback_scene, ' ' ORDER BY position) FROM public.hero_slides),
                  '/images/hero/opening.webp@#07070b/dark/night /images/hero/laptops.webp@#f6f7f9/light/paper /images/hero/gear.webp@#040110/dark/violet',
                  'slide art, edge colours, tones and fallback scenes = Hero.tsx');
SELECT pg_temp.eq((SELECT readout FROM public.hero_slides WHERE chip = 'Keyboards + mice'), ARRAY['SW_LINEAR.RED', 'DPI_26000', 'POLL_8KHZ'],
                  'HUD readout lines kept');

-- ── 3. promo tiles ───────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT string_agg(slot || ':' || href, ' ' ORDER BY slot) FROM public.promo_tiles),
                  '1:/shop?category=laptops 2:/shop?category=storage 3:/shop?category=keyboards 4:/shop?category=mice',
                  'anon sees 4 tiles linking to their category pages');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(array_to_string(title_lines, '/'), ' | ' ORDER BY slot) FROM public.promo_tiles),
                  'Forge/Studio 16 | SSDs up to/21% off | Type/louder. | Aim/sharper.', 'tile titles = PromoGrid.tsx');
SELECT pg_temp.eq((SELECT string_agg(image_position, ' | ' ORDER BY slot) FROM public.promo_tiles),
                  '85% bottom | center 88% | right 78% | right 80%', 'object positions = the old object-[…] classes');
-- The price figures in the tile/slide copy must match the seeded catalogue (P15).
SELECT pg_temp.eq((SELECT max(round((1 - v.price / v.compare_at_price) * 100))::int
                     FROM public.product_variants v JOIN public.products p ON p.id = v.product_id
                    WHERE p.is_active AND v.is_active AND v.compare_at_price > v.price
                      AND p.category_id = 'storage' AND p.name ILIKE '%SSD%'), 21,
                  '"SSDs up to 21% off" = the deepest SSD discount, rounded like the product card badge');
SELECT pg_temp.eq((SELECT min(p.price)::int FROM public.products p
                    WHERE p.is_active AND p.category_id = 'keyboards' AND p.subtitle ILIKE '%hot-swap%'), 32900,
                  '"Hot-swap mechanical from Rs. 32,900" = the cheapest hot-swap keyboard');
SELECT pg_temp.eq((SELECT min(p.price)::int FROM public.products p
                    WHERE p.is_active AND p.category_id = 'mice' AND (p.name ILIKE '%ergonomic%' OR p.name ILIKE '%58g%')), 9900,
                  '"Ergonomic & ultralight from Rs. 9,900" = the cheapest ergonomic / ultralight mouse');
SELECT pg_temp.eq((SELECT min(p.price)::int FROM public.products p
                    WHERE p.is_active AND p.category_id = 'laptops'
                      AND (p.name ILIKE '%ultrabook%' OR p.name ILIKE '%creator%' OR p.name ILIKE '%gaming%')), 329900,
                  '"... from Rs. 329,900" = the cheapest ultrabook / creator / gaming laptop');
SELECT pg_temp.eq((SELECT min(p.price)::int FROM public.products p
                    WHERE p.is_active AND p.slug = 'forge-studio-16-creator-laptop'), 724900,
                  '"Creator power from Rs. 724,900" = the Forge Studio 16 price');

-- ── 4. content blocks ────────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT string_agg(key, ',' ORDER BY key) FROM public.content_blocks),
                  'hero_perks,new_arrivals_feature,order_your_way,store_status,trust_row', 'five blocks, and NO testimonial');
SELECT pg_temp.eq((SELECT jsonb_path_query_array(data, '$.items[*].title') FROM public.content_blocks WHERE key = 'hero_perks'),
                  '["Free delivery", "Secure payment", "Easy returns"]'::jsonb, 'hero perks');
SELECT pg_temp.eq((SELECT data #>> '{items,0,text}' FROM public.content_blocks WHERE key = 'hero_perks'), 'Orders over {free_delivery_threshold}',
                  'the free-delivery perk reads the threshold from store_settings');
SELECT pg_temp.eq((SELECT data #>> '{items,1,text}' FROM public.content_blocks WHERE key = 'hero_perks'), 'COD',
                  '"Cards, COD & instalments" → "COD"');
SELECT pg_temp.eq((SELECT jsonb_array_length(data -> 'items') FROM public.content_blocks WHERE key = 'trust_row'), 5, 'five trust-row items');
SELECT pg_temp.eq((SELECT data #> '{items,0}' FROM public.content_blocks WHERE key = 'trust_row'),
                  '{"icon": "secure", "text": "COD and bank transfer.", "title": "Secure payment", "requires": ["cod", "bank_transfer"]}'::jsonb,
                  'the payment trust item drops "Encrypted checkout — cards," and is shown only while COD and bank transfer are both offered');
SELECT pg_temp.eq((SELECT jsonb_path_query_array(data, '$.items[*].title') FROM public.content_blocks WHERE key = 'order_your_way'),
                  '["Cash on delivery", "WhatsApp orders", "Showroom pickup"]'::jsonb, 'order-your-way ways without "Pay in 3"');
SELECT pg_temp.eq((SELECT jsonb_path_query_array(data, '$.items[*].requires[0]') FROM public.content_blocks WHERE key = 'order_your_way'),
                  '["cod", "whatsapp", "pickup"]'::jsonb, 'each way is shown only while the store offers it');
SELECT pg_temp.eq((SELECT jsonb_path_query_array(data, '$.rows[*].label') FROM public.content_blocks WHERE key = 'store_status'),
                  '["Districts_covered", "Support"]'::jsonb, 'store status without the invented 10K+ orders / 99% satisfaction rows');
SELECT pg_temp.eq((SELECT data FROM public.content_blocks WHERE key = 'new_arrivals_feature'),
                  '{"product": "forge-studio-16-creator-laptop", "title": "Forge Studio 16", "kicker": "The creator flagship"}'::jsonb,
                  'new-arrivals feature = NewArrivals.tsx');
-- every product slug a block names is a real, visible seed product (the new-arrivals one is flagged new)
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.products p, public.content_blocks b
                           WHERE b.key = 'new_arrivals_feature' AND p.slug = b.data ->> 'product' AND p.is_active AND p.is_new),
                  'the feature product exists and is a new arrival');
SELECT pg_temp.eq((SELECT count(*) FROM public.products p, public.content_blocks b
                    WHERE b.key = 'order_your_way' AND p.slug IN (b.data #>> '{art,top}', b.data #>> '{art,bottom}') AND p.is_active),
                  2::bigint, 'both order-your-way cut-outs name real products');

-- ── 5. honesty: nothing seeded claims what the store cannot back (P15) ───────
SELECT pg_temp.eq((
  SELECT string_agg(src, ', ') FROM (
    SELECT 'slide ' || id AS src, concat_ws(' ', chip, eyebrow, title, body, cta_label, secondary_label) AS txt FROM public.hero_slides
    UNION ALL SELECT 'tile ' || slot, concat_ws(' ', eyebrow, array_to_string(title_lines, ' '), body, cta_label) FROM public.promo_tiles
    UNION ALL SELECT 'block ' || key, data::text FROM public.content_blocks
    UNION ALL SELECT 'settings', concat_ws(' ', array_to_string(ticker_items, ' '), array_to_string(accepted_payment_labels, ' '), announcement)
      FROM public.store_settings) s
   WHERE txt ~* '(instal|interest[- ]free|pay in 3|encrypt|\m(visa|master ?card|amex)\M|\mcards?\M|10k\+|99 ?%|40 ?%|verified buyer)'),
  NULL::text, 'no card, instalment, "encrypted", 10K+, 99 %, 40 % or "verified buyer" claim anywhere in the seeded content');

-- ── 6. idempotent, and never overwrites the owner ───────────────────────────
\ir ../migrations/31_seed_storefront.sql
SELECT pg_temp.eq((SELECT count(*) FROM public.hero_slides), 3::bigint, 'a second run adds no slides');
SELECT pg_temp.eq((SELECT count(*) FROM public.content_blocks), 5::bigint, 'a second run adds no blocks');

-- With the marker gone (a deliberate re-seed), the owner's values still win.
DELETE FROM public.app_config WHERE name = 'seed_31_storefront_demo';
UPDATE public.store_settings SET phone = '+94 11 000 0000', ticker_items = ARRAY['Owner line'], accepted_payment_labels = '{}';
UPDATE public.content_blocks SET data = '{"items": [{"icon": "truck", "title": "Owner perk", "text": ""}]}' WHERE key = 'hero_perks';
DELETE FROM public.promo_tiles WHERE slot = 4;
DELETE FROM public.hero_slides WHERE chip = 'New season';
\ir ../migrations/31_seed_storefront.sql
SELECT pg_temp.ok((SELECT phone = '+94 11 000 0000' AND ticker_items = ARRAY['Owner line'] FROM public.store_settings),
                  're-seeding keeps the owner''s phone and ticker');
SELECT pg_temp.eq((SELECT accepted_payment_labels FROM public.store_settings), ARRAY['COD', 'BANK TRANSFER'], 'and fills only what is empty');
SELECT pg_temp.eq((SELECT data #>> '{items,0,title}' FROM public.content_blocks WHERE key = 'hero_perks'), 'Owner perk', 'an existing block is never overwritten');
SELECT pg_temp.eq((SELECT count(*) FROM public.promo_tiles), 4::bigint, 'a missing tile slot is filled again');
SELECT pg_temp.eq((SELECT count(*) FROM public.hero_slides), 2::bigint, 'slides are only seeded into an EMPTY table (never beside the owner''s)');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.app_config WHERE name = 'seed_31_storefront_demo'), 'the marker is recorded again');
