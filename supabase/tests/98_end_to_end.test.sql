-- 98_end_to_end.test.sql — one shopper's whole story across the FULL chain (seed catalogue included):
-- seed catalogue present → quote → checkout autosave → guest place_order (COD) → the autosave row is
-- converted → guest tracking + confirmation page → admin marks out_for_delivery, then delivered →
-- the shopper signs up, confirms the email and the guest order links → their review is a verified
-- purchase → a second (signed-in) order is cancelled and stock, discount use and lifetime value all
-- reverse → retention runs with the secret and refuses without it; orders survive.
-- Uses whatever products seed 30 provides (the first visible product with an active variant) and
-- pins the shop settings, stock level and discount it needs, so a later seed change cannot break it.
\ir _helpers.sql

CREATE FUNCTION pg_temp.j(p_name text) RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('t.' || p_name)::jsonb $$;
CREATE FUNCTION pg_temp.v(p_name text) RETURNS text LANGUAGE sql AS $$ SELECT current_setting('t.' || p_name) $$;

-- ── 0. the seed catalogue is present ────────────────────────────────────────
SELECT pg_temp.ok((SELECT count(*) FROM public.products WHERE is_active AND variant_count > 0) >= 1,
                  'the seed catalogue is present (at least one visible product)');
SELECT set_config('t.pid', (SELECT p.id FROM public.products p
                              JOIN public.product_variants v ON v.product_id = p.id AND v.is_active
                             WHERE p.is_active AND p.variant_count > 0 ORDER BY p.id, v.position, v.id LIMIT 1)::text, false);
SELECT set_config('t.vid', (SELECT v.id FROM public.product_variants v
                             WHERE v.product_id = pg_temp.v('pid')::int AND v.is_active ORDER BY v.position, v.id LIMIT 1)::text, false);
SELECT set_config('t.price', (SELECT price FROM public.product_variants WHERE id = pg_temp.v('vid')::int)::text, false);
SELECT set_config('t.pname', (SELECT name FROM public.products WHERE id = pg_temp.v('pid')::int), false);
-- pin what the story depends on
UPDATE public.store_settings SET delivery_fee = 450, free_delivery_threshold = 15000, cod_enabled = TRUE, cod_max_total = NULL;
INSERT INTO public.inventory (variant_id, stock_level, low_stock_threshold) VALUES (pg_temp.v('vid')::int, 20, 3)
ON CONFLICT (variant_id) DO UPDATE SET stock_level = 20;
INSERT INTO public.discounts (code, title, kind, value, usage_limit) VALUES ('E2E10', 'End to end', 'percentage', 10, 10);
SELECT set_config('t.owner', pg_temp.new_user('owner@e2e.test')::text, false);
SELECT pg_temp.make_admin(pg_temp.v('owner')::uuid);
INSERT INTO public.app_config (name, value) VALUES ('maintenance', 'mt_secret_0123456789abcdefghij')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;
CREATE FUNCTION pg_temp.items(p_qty int) RETURNS jsonb LANGUAGE sql AS
  $$ SELECT jsonb_build_array(jsonb_build_object('product_id', pg_temp.v('pid')::int, 'variant_id', pg_temp.v('vid')::int, 'quantity', p_qty)) $$;
CREATE FUNCTION pg_temp.stock() RETURNS int LANGUAGE sql AS $$ SELECT stock_level FROM public.inventory WHERE variant_id = pg_temp.v('vid')::int $$;
CREATE FUNCTION pg_temp.uses() RETURNS int LANGUAGE sql AS $$ SELECT usage_count FROM public.discounts WHERE code = 'E2E10' $$;

-- ── 1. quote (what the basket and checkout show) ────────────────────────────
SELECT pg_temp.login_anon();
SELECT set_config('t.quote', public.quote_order(pg_temp.items(2), 'e2e10', 'delivery')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.ok((pg_temp.j('quote') ->> 'orderable')::boolean
              AND (pg_temp.j('quote') ->> 'subtotal')::numeric = 2 * pg_temp.v('price')::numeric
              AND (pg_temp.j('quote') -> 'discount' ->> 'valid')::boolean,
                  'the quote prices two units from the catalogue and accepts the code');

-- ── 2. checkout autosave, then a guest COD order ────────────────────────────
SELECT pg_temp.login_anon();
SELECT public.capture_abandoned_cart('e2e00000-0000-0000-0000-000000000001', 'Nimal@E2E.test', 'Nimal', 'Perera', '077 123 4567',
                                     '{"street":"12 Galle Road","city":"Colombo 03","district":"Colombo"}', pg_temp.items(2), 0);
SELECT set_config('t.o1', public.place_order('Nimal@E2E.test', 'Nimal', 'Perera', '077 123 4567',
         '{"street":"12 Galle Road","city":"Colombo 03","district":"Colombo","postal_code":"00300"}', pg_temp.items(2), 'E2E10',
         'e2e00000-0000-0000-0000-000000000001', 'LKR', 1, 'cod', 'delivery', 'Call before delivery')::text, false);
SELECT pg_temp.logout();
SELECT set_config('t.oid1', pg_temp.j('o1') ->> 'order_id', false);
SELECT pg_temp.ok(pg_temp.v('oid1') ~ '^DO-[0-9]+$', 'a DO- order number');
SELECT pg_temp.ok((pg_temp.j('o1') ->> 'subtotal')::numeric        = (pg_temp.j('quote') ->> 'subtotal')::numeric
              AND (pg_temp.j('o1') ->> 'shipping_fee')::numeric    = (pg_temp.j('quote') ->> 'shipping_fee')::numeric
              AND (pg_temp.j('o1') ->> 'discount_amount')::numeric = (pg_temp.j('quote') ->> 'discount_amount')::numeric
              AND (pg_temp.j('o1') ->> 'total')::numeric           = (pg_temp.j('quote') ->> 'total')::numeric,
                  'the order charges exactly what the quote showed (subtotal, delivery, discount, total)');
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('o1') ->> 'payment_method', pg_temp.j('o1') ->> 'payment_status', pg_temp.j('o1') ->> 'phone'),
                  'cod|pending_collection|+94771234567', 'COD is pending collection; the phone is stored in E.164');
SELECT pg_temp.eq(pg_temp.stock(), 18, 'stock decremented by 2');
SELECT pg_temp.eq(pg_temp.uses(), 1, 'the discount use was counted');
SELECT pg_temp.eq((SELECT concat_ws('|', converted::text, converted_order_id) FROM public.abandoned_carts WHERE id = 'e2e00000-0000-0000-0000-000000000001'),
                  'true|' || pg_temp.v('oid1'), 'the checkout autosave row is converted and linked to the order');

-- ── 3. guest tracking and the confirmation page ─────────────────────────────
SELECT set_config('t.tok', (SELECT view_token FROM public.orders WHERE id = pg_temp.v('oid1'))::text, false);
SELECT pg_temp.login_anon();
SELECT set_config('t.track1', COALESCE(public.track_guest_order(pg_temp.v('oid1'), 'NIMAL@e2e.test')::text, ''), false);
SELECT set_config('t.view1', COALESCE(public.view_order(pg_temp.v('oid1'), pg_temp.v('tok')::uuid)::text, ''), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('track1') ->> 'status', pg_temp.j('track1') -> 'items' -> 0 ->> 'product_name',
                            (pg_temp.j('track1') ? 'shipping_address')::text, (pg_temp.j('track1') ? 'phone')::text),
                  'pending|' || pg_temp.v('pname') || '|false|false', 'guest tracking: status and items, never the address or phone');
SELECT pg_temp.eq(pg_temp.j('view1') ->> 'first_name', 'Nimal', 'the view token unlocks the confirmation page');

-- ── 4. the admin moves it out for delivery, then delivered ──────────────────
SELECT pg_temp.login(pg_temp.v('owner')::uuid);
SELECT pg_temp.throws(format('SELECT public.admin_set_order_status(%L, %L)', pg_temp.v('oid1'), 'out_for_delivery'), '22023',
                      'out for delivery needs a tracking number', 'tracking_required:%');
SELECT set_config('t.s1', public.admin_set_order_status(pg_temp.v('oid1'), 'out_for_delivery', 'TRK-E2E-1')::text, false);
SELECT set_config('t.s2', public.admin_set_order_status(pg_temp.v('oid1'), 'delivered')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('s1') ->> 'status', pg_temp.j('s1') ->> 'amount_due', pg_temp.j('s2') ->> 'status'),
                  concat_ws('|', 'out_for_delivery', pg_temp.j('o1') ->> 'total', 'delivered'),
                  'out for delivery (COD amount due = the total), then delivered');
SELECT pg_temp.eq((SELECT string_agg(status, ' > ' ORDER BY created_at, id) FROM public.order_tracking WHERE order_id = pg_temp.v('oid1')),
                  'Order placed > Out for delivery > Delivered', 'the shopper''s timeline');

-- ── 5. sign up; the guest order links only once the email is confirmed ──────
SELECT set_config('t.nimal', pg_temp.new_user('nimal@e2e.test', FALSE, '{"first_name":"Nimal"}')::text, false);
SELECT pg_temp.eq((SELECT customer_id FROM public.orders WHERE id = pg_temp.v('oid1')), NULL::uuid, 'not linked before the email is confirmed');
UPDATE auth.users SET email_confirmed_at = now() WHERE id = pg_temp.v('nimal')::uuid;
SELECT pg_temp.eq((SELECT customer_id FROM public.orders WHERE id = pg_temp.v('oid1')), pg_temp.v('nimal')::uuid, 'confirming the email links the guest order');
SELECT pg_temp.eq((SELECT concat_ws('|', total_spent::text, orders_count::text) FROM public.customers WHERE id = pg_temp.v('nimal')::uuid),
                  concat_ws('|', (pg_temp.j('o1') ->> 'total')::numeric(12,2)::text, '1'), 'the account adopts the order''s history');
SELECT pg_temp.login(pg_temp.v('nimal')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.orders), 1::bigint, 'the dashboard (owner RLS) shows the linked order');

-- ── 6. the review is a verified purchase ────────────────────────────────────
SELECT set_config('t.rev', public.submit_review(pg_temp.v('pid')::int, 5, 'Exactly as described', 'Fast delivery and exactly as described.', NULL)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('rev') ->> 'status', pg_temp.j('rev') ->> 'is_verified_purchase'), 'pending|true',
                  'the review waits for moderation and carries the verified-purchase flag');

-- ── 7. a second order, signed in, is cancelled: everything reverses ─────────
SELECT pg_temp.login(pg_temp.v('nimal')::uuid);
SELECT set_config('t.o2', public.place_order('nimal@e2e.test', 'Nimal', 'Perera', '0771234567',
         '{"street":"12 Galle Road","city":"Colombo 03","district":"Colombo"}', pg_temp.items(1), 'E2E10',
         NULL, 'USD', 0.0033, 'cod', 'delivery', NULL)::text, false);
SELECT pg_temp.logout();
SELECT set_config('t.oid2', pg_temp.j('o2') ->> 'order_id', false);
SELECT pg_temp.eq(concat_ws('|', pg_temp.stock()::text, pg_temp.uses()::text,
                            (SELECT concat_ws('/', total_spent::text, orders_count::text) FROM public.customers WHERE id = pg_temp.v('nimal')::uuid)),
                  concat_ws('|', '17', '2', ((pg_temp.j('o1') ->> 'total')::numeric + (pg_temp.j('o2') ->> 'total')::numeric)::numeric(12,2)::text || '/2'),
                  'the signed-in order: stock −1, a second discount use, lifetime value and count up');
SELECT pg_temp.eq((SELECT customer_id FROM public.orders WHERE id = pg_temp.v('oid2')), pg_temp.v('nimal')::uuid, 'the signed-in order belongs to the account');
SELECT pg_temp.login(pg_temp.v('owner')::uuid);
SELECT set_config('t.c2', public.admin_set_order_status(pg_temp.v('oid2'), 'cancelled', NULL, NULL, NULL, 'Customer changed their mind')::text, false);
SELECT pg_temp.throws(format('SELECT public.admin_set_order_status(%L, %L)', pg_temp.v('oid2'), 'pending'), '22023',
                      'a cancelled order is final', 'invalid_transition:%');
SELECT pg_temp.logout();
SELECT pg_temp.eq(concat_ws('|', pg_temp.stock()::text, pg_temp.uses()::text,
                            (SELECT concat_ws('/', total_spent::text, orders_count::text) FROM public.customers WHERE id = pg_temp.v('nimal')::uuid)),
                  concat_ws('|', '18', '1', (pg_temp.j('o1') ->> 'total')::numeric(12,2)::text || '/1'),
                  'cancelling restored the stock, returned the discount use and reversed the lifetime value');
SELECT pg_temp.eq((SELECT status FROM public.order_tracking WHERE order_id = pg_temp.v('oid2') ORDER BY id DESC LIMIT 1), 'Cancelled',
                  'the cancellation is on the timeline');

-- ── 8. the analytics and recovery figures see the story ─────────────────────
SELECT pg_temp.login(pg_temp.v('owner')::uuid);
SELECT set_config('t.sales', public.admin_sales_overview(NULL, NULL)::text, false);
SELECT set_config('t.rec', public.admin_recovery_stats(30)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('sales') ->> 'orders', pg_temp.j('sales') ->> 'cancelled', (pg_temp.j('sales') ->> 'revenue')::numeric::text),
                  concat_ws('|', '1', '1', (pg_temp.j('o1') ->> 'total')::numeric::text),
                  'the dashboard counts the delivered order as revenue and the cancelled one as cancelled');
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('rec') ->> 'captured', pg_temp.j('rec') ->> 'converted'), '1|1', 'recovery stats see the converted autosave');

-- ── 9. retention: refuses without the secret, runs with it, orders survive ──
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.run_retention('not-the-secret-0123456789')$$, 'P0001', 'retention refuses a wrong secret', 'unauthorized');
SELECT set_config('t.ret', public.run_retention('mt_secret_0123456789abcdefghij')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.ok(pg_temp.j('ret') ?& ARRAY['rate_limit_hits', 'assistant_order_lookups', 'analytics_events', 'assistant_sessions',
                                           'assistant_messages', 'abandoned_carts', 'finder_responses'],
                  'retention runs with the secret and reports every table');
SELECT pg_temp.eq((SELECT count(*) FROM public.orders WHERE id IN (pg_temp.v('oid1'), pg_temp.v('oid2'))), 2::bigint, 'orders are never touched by retention');
SELECT pg_temp.eq((SELECT count(*) FROM public.abandoned_carts WHERE id = 'e2e00000-0000-0000-0000-000000000001'), 1::bigint,
                  'a fresh converted cart is kept (90 days)');

-- ── 10. the direct-call brake (01, P3): RPCs called straight against PostgREST ──
-- A caller with only the public anon key and no route token shares a small store-wide budget;
-- the app's own server clients send the HMAC route token and are never slowed down.
INSERT INTO public.app_config (name, value) VALUES ('rate_limit', 'rl_secret_0123456789abcdefghij')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;
INSERT INTO public.rate_limit_hits (bucket) SELECT 'direct:place_order' FROM generate_series(1, 20);
INSERT INTO public.rate_limit_hits (bucket) SELECT 'direct:validate_discount' FROM generate_series(1, 120);
INSERT INTO public.rate_limit_hits (bucket) SELECT 'direct:capture_abandoned_cart' FROM generate_series(1, 30);
SELECT pg_temp.login_anon();
SELECT set_config('request.headers', '', false);
SELECT pg_temp.throws($$SELECT public.place_order('brake@example.com', 'B', '', '0771234567', '{}'::jsonb, '[]'::jsonb)$$,
                      'P0001', 'a direct place_order over the store-wide budget is refused', 'rate_limited');
SELECT pg_temp.throws($$SELECT public.validate_discount('OPENING10', 10000)$$,
                      'P0001', 'direct discount guessing over the budget is refused', 'rate_limited');
SELECT pg_temp.throws($$SELECT public.capture_abandoned_cart('e2e00000-0000-0000-0000-00000000b0b0', 'victim@example.com', 'V', NULL, NULL, NULL, '[]'::jsonb, 0)$$,
                      'P0001', 'the reminder mailer cannot be fed directly once the budget is spent', 'rate_limited');
SELECT public.log_assistant_turn('e2e00000-0000-0000-0000-00000000b0b1'::uuid, 'forged turn', 'forged reply');
SELECT public.track_event('e2e00000-0000-0000-0000-00000000b0b2'::uuid, 'page_view');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.assistant_sessions WHERE id = 'e2e00000-0000-0000-0000-00000000b0b1'), 0::bigint,
                  'a direct log_assistant_turn writes nothing (no forged sessions to earn offers)');
SELECT pg_temp.eq((SELECT count(*) FROM public.analytics_events WHERE session_id = 'e2e00000-0000-0000-0000-00000000b0b2'), 0::bigint,
                  'a direct track_event writes nothing');
-- the same calls with the route token the server clients send go straight through the brake
SELECT pg_temp.login_anon();
SELECT set_config('request.headers',
                  json_build_object('x-dockone-route',
                                    encode(extensions.hmac('dockone-route-v1', 'rl_secret_0123456789abcdefghij', 'sha256'), 'hex'))::text,
                  false);
SELECT pg_temp.throws($$SELECT public.place_order('brake@example.com', 'B', '', '0771234567', '{}'::jsonb, '[]'::jsonb)$$,
                      'P0001', 'with the route token place_order reaches its own validation', 'invalid_%');
SELECT pg_temp.eq((public.validate_discount('OPENING10', 10000) ->> 'valid')::boolean, TRUE,
                  'with the route token the discount check answers normally');
SELECT public.log_assistant_turn('e2e00000-0000-0000-0000-00000000b0b1'::uuid, 'real turn', 'real reply');
SELECT set_config('request.headers', '', false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.assistant_messages WHERE session_id = 'e2e00000-0000-0000-0000-00000000b0b1'), 2::bigint,
                  'a routed log_assistant_turn is written as usual');
