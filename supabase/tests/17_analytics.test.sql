-- 17_analytics.test.sql — track_event (allowlist exactly the 12 types, clamps, page stripped of
-- query/fragment, customer from auth.uid(), per-session and global throttles, never raises) and the
-- eight admin aggregates: non-admins refused (42501), exact figures on fixtures that straddle the
-- Asia/Colombo midnight (business days), cancelled orders excluded, windows clamped.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);
CREATE FUNCTION pg_temp.j(p_name text) RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('t.' || p_name)::jsonb $$;
-- Colombo-local timestamps relative to "today" in Colombo
CREATE FUNCTION pg_temp.today() RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'Asia/Colombo')::date $$;
CREATE FUNCTION pg_temp.local(p_days_ago int, p_time time) RETURNS timestamptz LANGUAGE sql AS
  $$ SELECT ((pg_temp.today() - p_days_ago) + p_time)::timestamp AT TIME ZONE 'Asia/Colombo' $$;

-- ── the allowlist is exactly BUILD_SPEC §5 EventType ────────────────────────
SELECT pg_temp.eq((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'analytics_events_type_valid'),
  $$CHECK ((event_type = ANY (ARRAY['page_view'::text, 'product_view'::text, 'category_view'::text, 'collection_view'::text, 'search'::text, 'add_to_cart'::text, 'remove_from_cart'::text, 'begin_checkout'::text, 'wishlist_add'::text, 'finder_complete'::text, 'assistant_open'::text, 'newsletter_signup'::text])))$$,
  'the CHECK allowlist is exactly the 12 EventType values');
SELECT pg_temp.eq(public._business_tz(), 'Asia/Colombo', 'the business time zone');
SELECT pg_temp.ok(NOT has_function_privilege('anon', 'public._business_tz()', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'public._business_window_start(integer)', 'EXECUTE'),
                  'the time helpers are internal');
SELECT pg_temp.eq(public._business_window_start(1), (pg_temp.today()::timestamp AT TIME ZONE 'Asia/Colombo'),
                  'a 1-day window starts at Colombo midnight today');
SELECT pg_temp.eq(public._business_window_start(7), ((pg_temp.today() - 6)::timestamp AT TIME ZONE 'Asia/Colombo'),
                  'a 7-day window starts at Colombo midnight 6 days ago');
SELECT pg_temp.eq(public._business_window_start(0), public._business_window_start(1), 'windows clamp up to 1 day');
SELECT pg_temp.eq(public._business_window_start(9999), public._business_window_start(365), 'windows clamp down to 365 days');

-- ── track_event ─────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT public.track_event('10000000-0000-0000-0000-000000000001', 'page_view', NULL, NULL, '/shop?q=secret@mail.com#top');
SELECT public.track_event('10000000-0000-0000-0000-000000000001', 'product_view', 7, NULL, '/product/7');
SELECT public.track_event('10000000-0000-0000-0000-000000000001', 'purchase', NULL, 1000, '/');        -- not a client event
SELECT public.track_event('10000000-0000-0000-0000-000000000001', 'PAGE_VIEW', NULL, NULL, '/');       -- case matters
SELECT public.track_event(NULL, 'page_view', NULL, NULL, '/');                                         -- no session
SELECT public.track_event('10000000-0000-0000-0000-000000000001', NULL, NULL, NULL, '/');              -- no type
SELECT public.track_event('10000000-0000-0000-0000-000000000001', 'add_to_cart', -5, 'NaN', repeat('/x', 300), '"scalar"');
SELECT public.track_event('10000000-0000-0000-0000-000000000001', 'begin_checkout', 0, 200000000, '/checkout',
                          jsonb_build_object('big', repeat('z', 3000)));
SELECT public.track_event('10000000-0000-0000-0000-000000000001', 'search', NULL, 3, '/shop', '{"query":"SSD","results":3}');
SELECT pg_temp.throws('SELECT * FROM public.analytics_events', '42501', 'anon cannot read events');
SELECT pg_temp.throws($$INSERT INTO public.analytics_events (event_type, session_id) VALUES ('page_view', gen_random_uuid())$$,
                      '42501', 'anon cannot insert events directly');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT public.track_event('10000000-0000-0000-0000-000000000002', 'wishlist_add', 3, 12900.5, '/product/3', '{"list":"favorite"}');
SELECT pg_temp.throws($$INSERT INTO public.analytics_events (event_type, session_id) VALUES ('page_view', gen_random_uuid())$$,
                      '42501', 'a shopper cannot insert events directly');
SELECT pg_temp.eq((SELECT count(*) FROM public.analytics_events), 0::bigint, 'a shopper reads no events');
SELECT pg_temp.logout();

SELECT pg_temp.eq((SELECT count(*) FROM public.analytics_events), 6::bigint,
                  'six allowlisted events stored; purchase, wrong case, NULL session and NULL type dropped without an error');
SELECT pg_temp.eq((SELECT page FROM public.analytics_events WHERE event_type = 'page_view'), '/shop',
                  'the page keeps only the path: query string and fragment removed');
SELECT pg_temp.eq((SELECT concat_ws('|', COALESCE(product_id::text, '∅'), COALESCE(value::text, '∅'), char_length(page)::text, metadata::text)
                     FROM public.analytics_events WHERE event_type = 'add_to_cart'),
                  '∅|∅|200|{}', 'bad product id and NaN value dropped, page capped at 200, non-object metadata → {}');
SELECT pg_temp.eq((SELECT concat_ws('|', COALESCE(product_id::text, '∅'), COALESCE(value::text, '∅'), metadata::text)
                     FROM public.analytics_events WHERE event_type = 'begin_checkout'),
                  '∅|∅|{}', 'product id 0 dropped, value over 100 000 000 dropped, metadata over 2 KB → {}');
SELECT pg_temp.eq((SELECT concat_ws('|', customer_id::text, product_id::text, value::text, metadata ->> 'list')
                     FROM public.analytics_events WHERE event_type = 'wishlist_add'),
                  concat_ws('|', current_setting('t.shopper'), '3', '12900.50', 'favorite'),
                  'a signed-in shopper''s events carry auth.uid(); value rounded to 2 dp');
SELECT pg_temp.eq((SELECT count(*) FROM public.analytics_events WHERE customer_id IS NOT NULL), 1::bigint, 'anonymous events carry no customer');

-- per-session throttle: 300 per hour (pre-filled to 299, then two events → one kept)
INSERT INTO public.rate_limit_hits (bucket) SELECT 'events:sess:20000000-0000-0000-0000-000000000001' FROM generate_series(1, 299);
SELECT pg_temp.login_anon();
SELECT public.track_event('20000000-0000-0000-0000-000000000001', 'page_view', NULL, NULL, '/one');
SELECT public.track_event('20000000-0000-0000-0000-000000000001', 'page_view', NULL, NULL, '/two');
SELECT public.track_event('20000000-0000-0000-0000-000000000001', 'purchase', NULL, NULL, '/three');   -- dropped before the throttle
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(page, ',') FROM public.analytics_events WHERE session_id = '20000000-0000-0000-0000-000000000001'),
                  '/one', 'the 301st event of a session within the hour is dropped');
-- global throttle: 50 000 per hour
INSERT INTO public.rate_limit_hits (bucket) SELECT 'events:global' FROM generate_series(1, 50000 - (SELECT count(*) FROM public.rate_limit_hits WHERE bucket = 'events:global'));
SELECT pg_temp.login_anon();
SELECT public.track_event('30000000-0000-0000-0000-000000000001', 'page_view', NULL, NULL, '/busy');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.analytics_events WHERE session_id = '30000000-0000-0000-0000-000000000001'), 0::bigint,
                  'past the store-wide hourly cap events are dropped (and nothing raises)');
DELETE FROM public.rate_limit_hits;
DELETE FROM public.analytics_events;

-- ── fixtures for the aggregates ─────────────────────────────────────────────
UPDATE public.products SET is_active = FALSE;                   -- isolate from any seed catalogue
DELETE FROM public.inventory;
INSERT INTO public.categories (id, name) VALUES ('an-cat', 'Analytics');
INSERT INTO public.products (slug, brand, name, category_id) VALUES
  ('an-1', 'AnBrand', 'An One', 'an-cat'), ('an-2', 'AnBrand', 'An Two', 'an-cat'), ('an-3', 'AnBrand', 'An Three', 'an-cat');
INSERT INTO public.product_variants (product_id, sku, name, price)
SELECT id, upper(slug) || v, 'V' || v, 1000 FROM public.products, generate_series(1, 2) v WHERE slug LIKE 'an-%';
UPDATE public.products SET is_active = FALSE WHERE slug = 'an-3';
CREATE FUNCTION pg_temp.pid(p text) RETURNS int LANGUAGE sql AS $$ SELECT id FROM public.products WHERE slug = p $$;
CREATE FUNCTION pg_temp.vid(p text) RETURNS int LANGUAGE sql AS $$ SELECT id FROM public.product_variants WHERE sku = p $$;
-- orders straddling Colombo midnight: 00:15 today is still "yesterday" in UTC
INSERT INTO public.orders (id, email, first_name, phone, subtotal, total_price, status, packing_charges, created_at) VALUES
  ('DO-50001', 'a@shop.test', 'A', '+94771111111', 1000, 1000, 'pending',   0,   pg_temp.local(0, '00:15')),
  ('DO-50002', 'b@shop.test', 'B', '+94771111111', 3000, 3000, 'delivered', 250, pg_temp.local(0, '10:00')),
  ('DO-50003', 'c@shop.test', 'C', '+94771111111', 2000, 2000, 'accepted',  0,   pg_temp.local(1, '23:30')),
  ('DO-50004', 'd@shop.test', 'D', '+94771111111', 5000, 5000, 'cancelled', 0,   pg_temp.local(1, '12:00')),
  ('DO-50005', 'e@shop.test', 'E', '+94771111111', 7000, 7000, 'delivered', 0,   pg_temp.local(40, '12:00'));
INSERT INTO public.order_items (order_id, product_id, variant_id, quantity, unit_price, product_name) VALUES
  ('DO-50002', pg_temp.pid('an-2'), pg_temp.vid('AN-21'), 4, 750, 'An Two'),
  ('DO-50003', pg_temp.pid('an-1'), pg_temp.vid('AN-11'), 1, 2000, 'An One'),
  ('DO-50004', pg_temp.pid('an-1'), pg_temp.vid('AN-11'), 10, 500, 'An One');     -- cancelled: never counts
-- events: S1 walks the whole funnel, S2 views, S3 only lands; one product view 40 days ago
SELECT pg_temp.login_anon();
SELECT public.track_event('a0000000-0000-0000-0000-000000000001', 'page_view');
SELECT public.track_event('a0000000-0000-0000-0000-000000000001', 'product_view', pg_temp.pid('an-1'));
SELECT public.track_event('a0000000-0000-0000-0000-000000000001', 'add_to_cart', pg_temp.pid('an-1'), 1000);
SELECT public.track_event('a0000000-0000-0000-0000-000000000001', 'begin_checkout', NULL, 1000);
SELECT public.track_event('a0000000-0000-0000-0000-000000000002', 'page_view');
SELECT public.track_event('a0000000-0000-0000-0000-000000000002', 'product_view', pg_temp.pid('an-1'));
SELECT public.track_event('a0000000-0000-0000-0000-000000000002', 'product_view', pg_temp.pid('an-1'));
SELECT public.track_event('a0000000-0000-0000-0000-000000000002', 'product_view', pg_temp.pid('an-2'));
SELECT public.track_event('a0000000-0000-0000-0000-000000000003', 'page_view');
SELECT public.track_event('a0000000-0000-0000-0000-000000000003', 'search', NULL, 3, '/shop', '{"query":"SSD ","results":3}');
SELECT public.track_event('a0000000-0000-0000-0000-000000000003', 'search', NULL, 2, '/shop', '{"query":"ssd","results":2}');
SELECT public.track_event('a0000000-0000-0000-0000-000000000003', 'search', NULL, 0, '/shop', '{"query":"Thunderbolt   Dock","results":0}');
SELECT public.track_event('a0000000-0000-0000-0000-000000000003', 'search', NULL, NULL, '/shop', '{"query":"thunderbolt dock","results":0}');
SELECT public.track_event('a0000000-0000-0000-0000-000000000003', 'search', NULL, NULL, '/shop', '{"query":"MX Keys","results":"0"}');
SELECT public.track_event('a0000000-0000-0000-0000-000000000003', 'search', NULL, 0, '/shop', '{"query":"webcam"}');
SELECT public.track_event('a0000000-0000-0000-0000-000000000003', 'search', NULL, 0, '/shop', '{"query":"   "}');
SELECT pg_temp.logout();
INSERT INTO public.analytics_events (event_type, session_id, product_id, created_at)
VALUES ('product_view', 'a0000000-0000-0000-0000-000000000004', pg_temp.pid('an-2'), now() - interval '40 days');
-- stock: an-1/V1 low (2 ≤ 3), an-2/V1 sold out, an-2/V2 fine, an-3 (inactive product) sold out
INSERT INTO public.inventory (variant_id, stock_level, low_stock_threshold) VALUES
  (pg_temp.vid('AN-11'), 2, 3), (pg_temp.vid('AN-21'), 0, 3), (pg_temp.vid('AN-22'), 10, 3), (pg_temp.vid('AN-31'), 0, 3);
-- carts created in the window (+ one outside)
INSERT INTO public.abandoned_carts (id, email, cart_items, total_price, recovery_stage, converted, converted_order_id, recovery_opted_out, created_at) VALUES
  (gen_random_uuid(), 'r1@shop.test', '[{"product_id":1}]', 3000, 1, TRUE,  'DO-50002', FALSE, now() - interval '2 days'),
  (gen_random_uuid(), 'r2@shop.test', '[{"product_id":1}]', 1000, 3, FALSE, NULL,       FALSE, now() - interval '5 days'),
  (gen_random_uuid(), 'r3@shop.test', '[]',                 0,    0, FALSE, NULL,       TRUE,  now() - interval '1 day'),
  (gen_random_uuid(), 'r4@shop.test', '[{"product_id":1}]', 5000, 2, TRUE,  'DO-50004', FALSE, now() - interval '3 days'),
  (gen_random_uuid(), 'r5@shop.test', '[{"product_id":1}]', 9000, 3, TRUE,  'DO-50005', FALSE, now() - interval '60 days');
-- subscribers
INSERT INTO public.newsletter_subscribers (email, source, created_at, unsubscribed_at) VALUES
  ('n1@shop.test', 'home', now() - interval '1 day', NULL),
  ('n2@shop.test', 'home', now(), now()),
  ('n3@shop.test', 'footer', now(), NULL),
  ('n4@shop.test', 'finder', now() - interval '60 days', NULL);

-- ── non-admins are refused ──────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws('SELECT public.admin_sales_overview(NULL, NULL)', '42501', 'shopper: admin_sales_overview refused', 'not_authorised:%');
SELECT pg_temp.throws('SELECT public.admin_funnel(30)', '42501', 'shopper: admin_funnel refused', 'not_authorised:%');
SELECT pg_temp.throws('SELECT public.admin_top_products(30, 10)', '42501', 'shopper: admin_top_products refused', 'not_authorised:%');
SELECT pg_temp.throws('SELECT public.admin_search_terms(30, 10)', '42501', 'shopper: admin_search_terms refused', 'not_authorised:%');
SELECT pg_temp.throws('SELECT public.admin_low_stock(50)', '42501', 'shopper: admin_low_stock refused', 'not_authorised:%');
SELECT pg_temp.throws('SELECT public.admin_recovery_stats(30)', '42501', 'shopper: admin_recovery_stats refused', 'not_authorised:%');
SELECT pg_temp.throws('SELECT public.admin_newsletter_growth(30)', '42501', 'shopper: admin_newsletter_growth refused', 'not_authorised:%');
SELECT pg_temp.throws('SELECT public.admin_order_status_counts()', '42501', 'shopper: admin_order_status_counts refused', 'not_authorised:%');
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT public.admin_sales_overview(NULL, NULL)', '42501', 'anon: no EXECUTE on admin aggregates');
SELECT pg_temp.throws('SELECT public.admin_order_status_counts()', '42501', 'anon: no EXECUTE on admin_order_status_counts');

-- ── the figures ─────────────────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.s2', public.admin_sales_overview(pg_temp.today() - 1, pg_temp.today())::text, false);
SELECT set_config('t.s2r', public.admin_sales_overview(pg_temp.today(), pg_temp.today() - 1)::text, false);
SELECT set_config('t.sd', public.admin_sales_overview(NULL, NULL)::text, false);
SELECT set_config('t.sl', public.admin_sales_overview(pg_temp.today() - 400, pg_temp.today())::text, false);
SELECT set_config('t.f', public.admin_funnel(30)::text, false);
SELECT set_config('t.tp', public.admin_top_products(30, 10)::text, false);
SELECT set_config('t.st', public.admin_search_terms(30, 10)::text, false);
SELECT set_config('t.ls', public.admin_low_stock(50)::text, false);
SELECT set_config('t.rs', public.admin_recovery_stats(30)::text, false);
SELECT set_config('t.ng', public.admin_newsletter_growth(30)::text, false);
SELECT set_config('t.oc', public.admin_order_status_counts()::text, false);
SELECT pg_temp.logout();

SELECT pg_temp.eq(concat_ws('|', pg_temp.j('s2') ->> 'revenue', pg_temp.j('s2') ->> 'orders', pg_temp.j('s2') ->> 'aov', pg_temp.j('s2') ->> 'cancelled'),
                  '6000.00|3|2000.00|1', 'sales: revenue = non-cancelled total_price (packing charges excluded), orders, AOV, cancelled');
SELECT pg_temp.eq(pg_temp.j('s2') -> 'daily',
                  jsonb_build_array(jsonb_build_object('day', pg_temp.today() - 1, 'orders', 1, 'revenue', 2000),
                                    jsonb_build_object('day', pg_temp.today(), 'orders', 2, 'revenue', 4000)),
                  'daily buckets are Colombo business days (00:15 local today counts as today)');
SELECT pg_temp.eq(pg_temp.j('s2r') - 'daily', pg_temp.j('s2') - 'daily', 'reversed dates are swapped');
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('sd') ->> 'from', pg_temp.j('sd') ->> 'to', jsonb_array_length(pg_temp.j('sd') -> 'daily')::text,
                            pg_temp.j('sd') ->> 'revenue', pg_temp.j('sd') ->> 'timezone', pg_temp.j('sd') ->> 'currency'),
                  concat_ws('|', pg_temp.today() - 29, pg_temp.today(), '30', '6000.00', 'Asia/Colombo', 'LKR'),
                  'default range: the last 30 business days including today, one daily entry per day');
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('sl') ->> 'from', jsonb_array_length(pg_temp.j('sl') -> 'daily')::text, pg_temp.j('sl') ->> 'revenue'),
                  concat_ws('|', pg_temp.today() - 365, '366', '13000.00'), 'ranges are clamped to the last 366 days');

SELECT pg_temp.eq(pg_temp.j('f') - 'since' - 'timezone',
                  '{"days":30,"sessions":3,"product_view":2,"add_to_cart":1,"begin_checkout":1,"orders":3}'::jsonb,
                  'funnel: distinct sessions per step in the window; orders = non-cancelled orders in the window');

SELECT pg_temp.eq(pg_temp.j('tp') -> 'top_viewed',
                  jsonb_build_array(
                    jsonb_build_object('product_id', pg_temp.pid('an-1'), 'slug', 'an-1', 'name', 'An One', 'brand', 'AnBrand', 'views', 3, 'units_sold', 1),
                    jsonb_build_object('product_id', pg_temp.pid('an-2'), 'slug', 'an-2', 'name', 'An Two', 'brand', 'AnBrand', 'views', 1, 'units_sold', 4)),
                  'top viewed (views in the window; the 40-day-old view is outside) with units sold beside');
SELECT pg_temp.eq(pg_temp.j('tp') -> 'top_sold',
                  jsonb_build_array(
                    jsonb_build_object('product_id', pg_temp.pid('an-2'), 'slug', 'an-2', 'name', 'An Two', 'brand', 'AnBrand', 'units_sold', 4, 'views', 1),
                    jsonb_build_object('product_id', pg_temp.pid('an-1'), 'slug', 'an-1', 'name', 'An One', 'brand', 'AnBrand', 'units_sold', 1, 'views', 3)),
                  'top sold (cancelled lines excluded) with views beside');

SELECT pg_temp.eq(pg_temp.j('st') -> 'top',
                  '[{"term":"ssd","searches":2,"zero_results":0},{"term":"thunderbolt dock","searches":2,"zero_results":2},
                    {"term":"mx keys","searches":1,"zero_results":1},{"term":"webcam","searches":1,"zero_results":1}]'::jsonb,
                  'search terms normalised (case, spaces); blank queries ignored');
SELECT pg_temp.eq(pg_temp.j('st') -> 'zero_results',
                  '[{"term":"thunderbolt dock","searches":2},{"term":"mx keys","searches":1},{"term":"webcam","searches":1}]'::jsonb,
                  'zero-result searches from metadata.results (number or numeric string) or, when absent, value');
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('st') ->> 'total_searches', pg_temp.j('st') ->> 'zero_result_searches'), '6|4', 'search totals');

SELECT pg_temp.eq(pg_temp.j('ls'),
                  jsonb_build_object('total', 2, 'items', jsonb_build_array(
                    jsonb_build_object('product_id', pg_temp.pid('an-2'), 'variant_id', pg_temp.vid('AN-21'), 'product_name', 'An Two',
                                       'variant_name', 'V1', 'sku', 'AN-21', 'stock_level', 0, 'low_stock_threshold', 3),
                    jsonb_build_object('product_id', pg_temp.pid('an-1'), 'variant_id', pg_temp.vid('AN-11'), 'product_name', 'An One',
                                       'variant_name', 'V1', 'sku', 'AN-11', 'stock_level', 2, 'low_stock_threshold', 3))),
                  'low stock: tracked active variants of active products at/under the threshold, sold out first');

SELECT pg_temp.eq(pg_temp.j('rs') - 'since',
                  '{"days":30,"captured":4,"with_items":3,"reminded_1":3,"reminded_2":2,"reminded_3":1,"converted":2,
                    "converted_after_reminder":2,"opted_out":1,"recovered_revenue":3000.00}'::jsonb,
                  'recovery: carts created in the window; recovered revenue excludes the cancelled order');

SELECT pg_temp.eq(pg_temp.j('ng') - 'since' - 'by_source' - 'daily',
                  '{"days":30,"total":4,"active":3,"new":3,"unsubscribed":1}'::jsonb, 'newsletter totals');
SELECT pg_temp.eq(pg_temp.j('ng') -> 'by_source',
                  '[{"source":"home","total":2,"active":1,"new":2},{"source":"finder","total":1,"active":1,"new":0},
                    {"source":"footer","total":1,"active":1,"new":1}]'::jsonb, 'newsletter by source, largest first');
SELECT pg_temp.eq(concat_ws('|', jsonb_array_length(pg_temp.j('ng') -> 'daily')::text,
                            (SELECT sum((d ->> 'new')::int)::text FROM jsonb_array_elements(pg_temp.j('ng') -> 'daily') d)),
                  '30|3', 'daily sign-ups: one entry per business day, summing to the new count');

SELECT pg_temp.eq(pg_temp.j('oc'),
                  '{"total":5,"open":2,"counts":{"pending":1,"processing":0,"accepted":1,"fulfilled":0,"shipped":0,
                    "out_for_delivery":0,"delivered":2,"cancelled":1}}'::jsonb,
                  'order status counts (every status listed) and open = not delivered and not cancelled');
