-- 16_storefront_content.test.sql — hero slides (public = active + inside the schedule window),
-- promo tiles (slots 1–4), content blocks (keys, JSON shape, updated_by), link / colour / image /
-- object-position constraints, RLS, get_best_sellers (units sold in non-cancelled orders inside
-- the window, topped up with is_bestseller, no duplicates, visible products only, clamps) and the
-- Homepage tab's one-statement reorders (admin_reorder_hero_slides, admin_set_featured_collections).
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);

-- Seed 31 (DEMO) fills these three tables; this file tests 16 on its own fixtures.
DELETE FROM public.hero_slides;
DELETE FROM public.promo_tiles;
DELETE FROM public.content_blocks;

-- ── hero slides ─────────────────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO public.hero_slides
    (image_url, fallback_scene, tone, background, chip, eyebrow, title, body, cta_label, cta_href, secondary_label, secondary_href, readout, position, is_active, starts_at, ends_at)
  VALUES
    ('/images/hero/opening.webp', 'night', 'dark', '#07070b', 'Grand opening', 'Launch prices', 'Grand opening\nsale{violet:_}', 'Body', 'Shop the sale', '/#flash-deals', 'Browse categories', '/#categories', ARRAY['X_06.9271','Y_79.8612'], 10, TRUE, NULL, NULL),
    (NULL, 'paper', 'light', '#f6f7f9', 'New season', NULL, 'Next-gen\nlaptops{violet:.}', NULL, 'Shop laptops', '/shop?category=laptops', NULL, NULL, '{}', 20, TRUE, now() - interval '1 day', now() + interval '1 day'),
    (NULL, 'violet', 'dark', '#040110', NULL, NULL, 'Future slide', NULL, NULL, NULL, NULL, NULL, '{}', 30, TRUE, now() + interval '1 day', NULL),
    (NULL, 'lime', 'light', '#e4fbae', NULL, NULL, 'Expired slide', NULL, NULL, NULL, NULL, NULL, '{}', 40, TRUE, NULL, now() - interval '1 minute'),
    (NULL, 'night', 'dark', '#000', NULL, NULL, 'Inactive slide', NULL, 'Go', 'https://example.com/x', NULL, NULL, '{}', 5, FALSE, NULL, NULL)$$),
  5::bigint, 'the admin inserts slides');
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT string_agg(title, ' | ' ORDER BY position, id) FROM public.hero_slides),
                  E'Grand opening\\nsale{violet:_} | Next-gen\\nlaptops{violet:.}',
                  'anon sees only active slides inside their window, in order');
SELECT pg_temp.throws($$UPDATE public.hero_slides SET title = 'x'$$, '42501', 'anon cannot update slides');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title) VALUES ('#000', 'x')$$, '42501', 'anon cannot insert slides');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.hero_slides), 2::bigint, 'a shopper sees the same two live slides');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.hero_slides SET title = 'x'$$), 0::bigint, 'a shopper cannot update slides');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.hero_slides), 5::bigint, 'the admin sees every slide (scheduled, expired, inactive)');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.hero_slides SET starts_at = NULL WHERE title = 'Future slide'$$), 1::bigint,
                  'the admin reschedules a slide');
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT count(*) FROM public.hero_slides), 3::bigint, 'a slide whose window opened is live');

-- constraints
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title, cta_label, cta_href) VALUES ('#000', 'x', 'Go', 'javascript:alert(1)')$$,
                      '23514', 'a javascript: link', '%hero_slides_links_valid%');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title, cta_label, cta_href) VALUES ('#000', 'x', 'Go', '//evil.example')$$,
                      '23514', 'a protocol-relative link', '%hero_slides_links_valid%');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title, cta_label, cta_href) VALUES ('#000', 'x', 'Go', '/\evil.example')$$,
                      '23514', 'a backslash link', '%hero_slides_links_valid%');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title, cta_label, cta_href) VALUES ('#000', 'x', 'Go', 'http://example.com')$$,
                      '23514', 'a plain-http link', '%hero_slides_links_valid%');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title, cta_label) VALUES ('#000', 'x', 'Go')$$,
                      '23514', 'a label without a link', '%hero_slides_links_valid%');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title, secondary_href) VALUES ('#000', 'x', '/shop')$$,
                      '23514', 'a link without a label', '%hero_slides_links_valid%');
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO public.hero_slides (background, title, cta_label, cta_href, is_active) VALUES ('#000', 'x', 'Home', '/', FALSE)$$),
                  1::bigint, 'the bare "/" is a valid link');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title) VALUES ('red', 'x')$$, '23514', 'a non-hex background', '%hero_slides_background_valid%');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title) VALUES ('#07070b;x', 'x')$$, '23514', 'a background with extra CSS', '%hero_slides_background_valid%');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title, fallback_scene) VALUES ('#000', 'x', 'space')$$, '23514', 'scene vocabulary', '%hero_slides_scene_valid%');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title, tone) VALUES ('#000', 'x', 'grey')$$, '23514', 'tone vocabulary', '%hero_slides_tone_valid%');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title, image_url) VALUES ('#000', 'x', 'data:image/png;base64,AAA')$$, '23514', 'a data: image', '%hero_slides_image_valid%');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title, starts_at, ends_at) VALUES ('#000', 'x', now(), now() - interval '1 hour')$$,
                      '23514', 'a window that ends before it starts', '%hero_slides_schedule_valid%');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title, readout) VALUES ('#000', 'x', ARRAY['1','2','3','4','5','6','7'])$$,
                      '23514', 'more than 6 readout lines', '%hero_slides_readout_valid%');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (background, title) VALUES ('#000', '   ')$$, '23514', 'a blank title', '%hero_slides_text_lengths%');
SELECT pg_temp.throws($$INSERT INTO public.hero_slides (title) VALUES ('x')$$, '23502', 'the background is required');

-- ── promo tiles ─────────────────────────────────────────────────────────────
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO public.promo_tiles (slot, image_url, fallback_scene, tone, background, eyebrow, title_lines, body, cta_label, href, image_position, is_active) VALUES
    (1, '/images/promo/laptops.webp', 'night', 'dark', '#010102', 'Limited time offer', ARRAY['Forge','Studio 16'], 'Creator power', 'Shop laptops', '/shop?category=laptops', '85% bottom', TRUE),
    (2, NULL, 'violet', 'dark', '#7d20fc', 'Mega deal', ARRAY['SSDs'], NULL, 'Shop storage', '/shop?category=storage', 'center 88%', TRUE),
    (3, NULL, 'paper', 'light', '#d2d2ed', 'Keyboards', ARRAY['Type','louder.'], NULL, NULL, '/shop?category=keyboards', NULL, FALSE)$$),
  3::bigint, 'the admin fills promo slots');
SELECT pg_temp.throws($$INSERT INTO public.promo_tiles (slot, background, title_lines, href) VALUES (5, '#000', ARRAY['x'], '/shop')$$,
                      '23514', 'only slots 1–4 exist', '%promo_tiles_slot_valid%');
SELECT pg_temp.throws($$INSERT INTO public.promo_tiles (slot, background, title_lines, href) VALUES (1, '#000', ARRAY['x'], '/shop')$$,
                      '23505', 'one tile per slot', '%promo_tiles_pkey%');
SELECT pg_temp.throws($$INSERT INTO public.promo_tiles (slot, background, title_lines, href, image_position) VALUES (4, '#000', ARRAY['x'], '/shop', '50%; background:url(x)')$$,
                      '23514', 'object-position cannot smuggle CSS', '%promo_tiles_position_valid%');
SELECT pg_temp.throws($$INSERT INTO public.promo_tiles (slot, background, title_lines, href) VALUES (4, '#000', '{}', '/shop')$$,
                      '23514', 'a tile needs a title line', '%promo_tiles_title_valid%');
SELECT pg_temp.throws($$INSERT INTO public.promo_tiles (slot, background, title_lines, href) VALUES (4, '#000', ARRAY['x','  '], '/shop')$$,
                      '23514', 'a blank title line', '%promo_tiles_title_valid%');
SELECT pg_temp.throws($$INSERT INTO public.promo_tiles (slot, background, title_lines, href) VALUES (4, '#000', ARRAY['x'], 'javascript:void(0)')$$,
                      '23514', 'a javascript: tile link', '%promo_tiles_href_valid%');
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT string_agg(slot::text, ',' ORDER BY slot) FROM public.promo_tiles), '1,2', 'anon sees active tiles only');
SELECT pg_temp.throws($$DELETE FROM public.promo_tiles$$, '42501', 'anon cannot delete tiles');

-- ── content blocks ──────────────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO public.content_blocks (key, data) VALUES
    ('trust_row', '[{"title":"Official warranty"}]'), ('store_status', '{"open":true}')$$), 2::bigint, 'the admin writes blocks');
SELECT pg_temp.throws($$INSERT INTO public.content_blocks (key, data) VALUES ('Bad-Key', '{}')$$, '23514', 'key format', '%content_blocks_key_format%');
SELECT pg_temp.throws($$INSERT INTO public.content_blocks (key, data) VALUES ('scalar', '"text"')$$, '23514', 'data must be an object or array', '%content_blocks_data_valid%');
SELECT pg_temp.throws(format('INSERT INTO public.content_blocks (key, data) VALUES (%L, %L)', 'huge', jsonb_build_object('x', repeat('y', 40000))),
                      '23514', 'data over 32 KB', '%content_blocks_data_valid%');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT updated_by FROM public.content_blocks WHERE key = 'trust_row'), current_setting('t.owner')::uuid,
                  'updated_by records the admin who saved');
UPDATE public.content_blocks SET data = '{"open":false}' WHERE key = 'store_status';
SELECT pg_temp.eq((SELECT updated_by FROM public.content_blocks WHERE key = 'store_status'), NULL::uuid, 'an SQL-editor edit records no admin');
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT count(*) FROM public.content_blocks), 2::bigint, 'anon reads every block');
SELECT pg_temp.throws($$UPDATE public.content_blocks SET data = '{}'$$, '42501', 'anon cannot edit blocks');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.content_blocks SET data = '{}'$$), 0::bigint, 'a shopper cannot edit blocks');
SELECT pg_temp.throws($$INSERT INTO public.content_blocks (key, data) VALUES ('x', '{}')$$, '42501', 'a shopper cannot add blocks');
SELECT pg_temp.logout();

-- ── get_best_sellers ────────────────────────────────────────────────────────
-- Isolate from any seed catalogue: only this file's products are visible.
UPDATE public.products SET is_active = FALSE;
INSERT INTO public.categories (id, name) VALUES ('bs-cat', 'Best sellers');
INSERT INTO public.products (slug, brand, name, category_id, is_bestseller, sort_order)
SELECT 'bs-' || n, 'BsBrand', 'Bs ' || n, 'bs-cat', n IN (2, 5, 6, 7), 100 - n FROM generate_series(1, 9) n;
INSERT INTO public.product_variants (product_id, sku, name, price)
SELECT id, upper(slug), 'Standard', 1000 FROM public.products WHERE slug LIKE 'bs-%';
UPDATE public.products SET is_active = FALSE WHERE slug IN ('bs-7', 'bs-8');                       -- hidden
UPDATE public.product_variants SET is_active = FALSE WHERE sku = 'BS-9';                            -- no active variant
CREATE FUNCTION pg_temp.pid(n int) RETURNS int LANGUAGE sql AS $$ SELECT id FROM public.products WHERE slug = 'bs-' || n $$;
CREATE FUNCTION pg_temp.sale(p_order text, p_n int, p_qty int, p_status text, p_age interval) RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.orders (id, email, first_name, phone, subtotal, total_price, status, created_at)
  VALUES (p_order, 'bs@shop.test', 'B', '+94771111111', 1000 * p_qty, 1000 * p_qty, p_status, now() - p_age);
  INSERT INTO public.order_items (order_id, product_id, variant_id, quantity, unit_price, product_name)
  SELECT p_order, pg_temp.pid(p_n), v.id, p_qty, 1000, 'Bs ' || p_n FROM public.product_variants v WHERE v.product_id = pg_temp.pid(p_n);
$$;
SELECT pg_temp.sale('DO-61001', 1, 5, 'delivered', '2 days');
SELECT pg_temp.sale('DO-61002', 2, 8, 'pending', '1 day');
SELECT pg_temp.sale('DO-61003', 3, 20, 'cancelled', '1 day');      -- cancelled: never counts
SELECT pg_temp.sale('DO-61004', 4, 50, 'delivered', '200 days');   -- outside the default window
SELECT pg_temp.sale('DO-61005', 8, 3, 'delivered', '1 day');       -- hidden product
SELECT pg_temp.sale('DO-61006', 9, 9, 'delivered', '1 day');       -- no active variant
SELECT pg_temp.sale('DO-61007', 1, 1, 'accepted', '10 days');      -- adds to product 1 (5 + 1 = 6)
CREATE FUNCTION pg_temp.bs(p_limit int, p_days int) RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg((SELECT slug FROM public.products WHERE id = b.product_id) || '#' || b.rank, ',' ORDER BY b.rank), '')
    FROM public.get_best_sellers(p_limit, p_days) b $$;

SELECT pg_temp.login_anon();
SELECT pg_temp.eq(pg_temp.bs(10, 90), 'bs-2#1,bs-1#2,bs-6#3,bs-5#4',
                  'ranked by units sold in the window (8, 6), then is_bestseller top-up by sort_order; no duplicate for bs-2; cancelled/hidden/variant-less excluded');
SELECT pg_temp.eq(pg_temp.bs(10, 365), 'bs-4#1,bs-2#2,bs-1#3,bs-6#4,bs-5#5', 'a longer window counts older sales');
SELECT pg_temp.eq(pg_temp.bs(2, 90), 'bs-2#1,bs-1#2', 'the limit applies after ranking');
SELECT pg_temp.eq(pg_temp.bs(NULL, NULL), 'bs-2#1,bs-1#2,bs-6#3,bs-5#4', 'NULL arguments → 5 over 90 days');
SELECT pg_temp.eq(pg_temp.bs(0, 90), 'bs-2#1', 'limit clamped up to 1');
SELECT pg_temp.eq((SELECT count(*) FROM public.get_best_sellers(1000, 90)), 4::bigint, 'limit clamped down to 24 (only 4 qualify)');
SELECT pg_temp.eq(pg_temp.bs(10, 0), 'bs-6#1,bs-5#2,bs-2#3', 'a 1-day window (clamped from 0) sees no sales; bs-2 then tops up as a flagged best seller');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT proargnames FROM pg_proc WHERE oid = 'public.get_best_sellers(integer,integer)'::regprocedure),
                  ARRAY['p_limit', 'p_days', 'product_id', 'rank'], 'output columns are product_id and rank only (never sales figures)');

-- ── admin_reorder_hero_slides: ONE statement, existing slides only ───────────
SELECT set_config('t.s_open',   (SELECT id FROM public.hero_slides WHERE title LIKE 'Grand opening%')::text, false);
SELECT set_config('t.s_next',   (SELECT id FROM public.hero_slides WHERE title LIKE 'Next-gen%')::text, false);
SELECT set_config('t.s_future', (SELECT id FROM public.hero_slides WHERE title = 'Future slide')::text, false);
SELECT set_config('t.s_count',  (SELECT count(*) FROM public.hero_slides)::text, false);
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(public.admin_reorder_hero_slides(ARRAY[current_setting('t.s_future')::int, current_setting('t.s_open')::int,
                                                          current_setting('t.s_next')::int]) -> 'ids',
                  jsonb_build_array(current_setting('t.s_future')::int, current_setting('t.s_open')::int, current_setting('t.s_next')::int),
                  'the admin reorders the slides in one call');
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT string_agg(title, ' | ' ORDER BY position, id) FROM public.hero_slides),
                  E'Future slide | Grand opening\\nsale{violet:_} | Next-gen\\nlaptops{violet:.}', 'anon sees the live slides in the new order');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(position::text, ',' ORDER BY position)
                     FROM public.hero_slides
                    WHERE id IN (current_setting('t.s_future')::int, current_setting('t.s_open')::int, current_setting('t.s_next')::int)),
                  '10,20,30', 'positions become 10, 20, 30 in array order');
SELECT pg_temp.eq((SELECT position FROM public.hero_slides WHERE title = 'Inactive slide'), 5, 'a slide that is not listed keeps its position');

SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_reorder_hero_slides(ARRAY[]::int[])$$, '22023', 'an empty order is refused', 'invalid_slides:%');
SELECT pg_temp.throws($$SELECT public.admin_reorder_hero_slides(NULL)$$, '22023', 'a NULL order is refused', 'invalid_slides:%');
SELECT pg_temp.throws(format('SELECT public.admin_reorder_hero_slides(ARRAY[%s, %s])', current_setting('t.s_open'), current_setting('t.s_open')),
                      '22023', 'a slide listed twice is refused', 'invalid_slides:%');
SELECT pg_temp.throws(format('SELECT public.admin_reorder_hero_slides(ARRAY[%s, NULL])', current_setting('t.s_open')),
                      '22023', 'an empty entry is refused', 'invalid_slides:%');
SELECT pg_temp.throws(format('SELECT public.admin_reorder_hero_slides(ARRAY[%s, 987654])', current_setting('t.s_next')),
                      '22023', 'a deleted slide fails the whole reorder (never re-created)', 'slide_not_found:%987654%');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT position FROM public.hero_slides WHERE id = current_setting('t.s_next')::int), 30, 'a refused reorder changes nothing');
SELECT pg_temp.eq((SELECT count(*) FROM public.hero_slides), current_setting('t.s_count')::bigint, 'a refused reorder creates no slide');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws(format('SELECT public.admin_reorder_hero_slides(ARRAY[%s])', current_setting('t.s_open')),
                      '42501', 'a shopper cannot reorder slides', 'not_authorised:%');
SELECT pg_temp.login_anon();
SELECT pg_temp.throws(format('SELECT public.admin_reorder_hero_slides(ARRAY[%s])', current_setting('t.s_open')),
                      '42501', 'anon cannot reorder slides (no EXECUTE)');
SELECT pg_temp.logout();

-- ── admin_set_featured_collections: the homepage row in ONE statement ────────
INSERT INTO public.collections (id, title, is_featured, sort_order)
VALUES ('fc-a', 'FC A', FALSE, 500), ('fc-b', 'FC B', TRUE, 510), ('fc-c', 'FC C', FALSE, 520);
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(public.admin_set_featured_collections(ARRAY['fc-c', 'fc-a']) -> 'featured', '["fc-c", "fc-a"]'::jsonb,
                  'the admin features two collections, in order, in one call');
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT string_agg(id, ',' ORDER BY sort_order, title) FROM public.collections WHERE is_featured), 'fc-c,fc-a',
                  'the featured row is exactly the listed collections (every other featured one, seeds included, is unfeatured)');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(id || '=' || sort_order, ',' ORDER BY sort_order) FROM public.collections WHERE id IN ('fc-a', 'fc-c')),
                  'fc-c=10,fc-a=20', 'featured sort_order = 10, 20 … in array order');
SELECT pg_temp.ok((SELECT sort_order = 510 AND NOT is_featured FROM public.collections WHERE id = 'fc-b'),
                  'an unfeatured collection keeps its own sort_order');

SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_set_featured_collections(ARRAY['fc-a', 'no-such-collection'])$$, '22023',
                      'an unknown collection is refused', 'collection_not_found:%no-such-collection%');
SELECT pg_temp.throws($$SELECT public.admin_set_featured_collections(ARRAY['fc-a', 'fc-a'])$$, '22023', 'a collection listed twice', 'invalid_collections:%');
SELECT pg_temp.throws($$SELECT public.admin_set_featured_collections(ARRAY['fc-a', NULL])$$, '22023', 'an empty entry', 'invalid_collections:%');
SELECT pg_temp.throws($$SELECT public.admin_set_featured_collections(array_fill('fc-a'::text, ARRAY[13]))$$, '22023',
                      'at most 12 featured collections', 'invalid_collections:%12%');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(id, ',' ORDER BY sort_order) FROM public.collections WHERE is_featured), 'fc-c,fc-a',
                  'a refused call changes nothing');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(public.admin_set_featured_collections('{}') -> 'featured', '[]'::jsonb, 'an empty list is allowed');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.collections WHERE is_featured), 0::bigint, 'and features nothing');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_set_featured_collections(ARRAY['fc-a'])$$, '42501', 'a shopper cannot choose the homepage collections', 'not_authorised:%');
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.admin_set_featured_collections(ARRAY['fc-a'])$$, '42501', 'anon cannot choose the homepage collections (no EXECUTE)');
SELECT pg_temp.logout();
