-- 21_assistant_memory_lookup.test.sql — get_assistant_customer_context (auth.uid() only; owns = the
-- last 5 NON-cancelled orders' lines, filtered BEFORE the limit, by account or confirmed email; profile
-- keys allowlisted to the finder axes; the session claim rules; never contact details or money),
-- forget_assistant_customer (admin only, messages cascade), lookup_order_for_assistant (narrow view,
-- miss = NULL, blank = NULL, throttle shared with track_guest_order with a miss costing double,
-- {throttled:true}, domain-only audit, 30-day prune).
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.ann', pg_temp.new_user('ann@shop.test', TRUE, '{"first_name":"  Ann  "}')::text, false);
SELECT set_config('t.bob', pg_temp.new_user('bob@shop.test', TRUE, '{"first_name":"Bob"}')::text, false);
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000c1', NULL);   -- an account with no customers row
CREATE FUNCTION pg_temp.j(p_name text) RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('t.' || p_name)::jsonb $$;
CREATE FUNCTION pg_temp.month(p_age interval) RETURNS text LANGUAGE sql AS
  $$ SELECT to_char((now() - p_age) AT TIME ZONE 'Asia/Colombo', 'FMMonth YYYY') $$;

-- ── fixtures ────────────────────────────────────────────────────────────────
INSERT INTO public.categories (id, name) VALUES ('am-cat', 'Memory');
INSERT INTO public.products (slug, brand, name, category_id) VALUES
  ('am-a', 'AmBrand', 'Alpha', 'am-cat'), ('am-b', 'AmBrand', 'Beta', 'am-cat'), ('am-g', 'AmBrand', 'Gamma', 'am-cat'),
  ('am-d', 'AmBrand', 'Delta', 'am-cat'), ('am-e', 'AmBrand', 'Epsilon', 'am-cat');
INSERT INTO public.product_variants (product_id, sku, name, price)
SELECT id, upper(slug), CASE slug WHEN 'am-b' THEN '16GB' ELSE 'Standard' END, 1000 FROM public.products WHERE slug LIKE 'am-%';
CREATE FUNCTION pg_temp.pid(p text) RETURNS int LANGUAGE sql AS $$ SELECT id FROM public.products WHERE slug = p $$;
CREATE FUNCTION pg_temp.vid(p text) RETURNS int LANGUAGE sql AS $$ SELECT id FROM public.product_variants WHERE sku = upper(p) $$;
-- Ann: one delivered account order 10 days ago, FIVE newer cancelled ones, and a guest order with her email 20 days ago
INSERT INTO public.orders (id, customer_id, email, first_name, phone, subtotal, total_price, status, created_at, tracking_number) VALUES
  ('DO-70001', current_setting('t.ann')::uuid, 'ann@shop.test', 'Ann', '+94771111111', 4000, 4450, 'delivered', now() - interval '10 days', 'TRK-1'),
  ('DO-70002', current_setting('t.ann')::uuid, 'ann@shop.test', 'Ann', '+94771111111', 1000, 1450, 'cancelled', now() - interval '5 days', NULL),
  ('DO-70003', current_setting('t.ann')::uuid, 'ann@shop.test', 'Ann', '+94771111111', 1000, 1450, 'cancelled', now() - interval '4 days', NULL),
  ('DO-70004', current_setting('t.ann')::uuid, 'ann@shop.test', 'Ann', '+94771111111', 1000, 1450, 'cancelled', now() - interval '3 days', NULL),
  ('DO-70005', current_setting('t.ann')::uuid, 'ann@shop.test', 'Ann', '+94771111111', 1000, 1450, 'cancelled', now() - interval '2 days', NULL),
  ('DO-70006', current_setting('t.ann')::uuid, 'ann@shop.test', 'Ann', '+94771111111', 1000, 1450, 'cancelled', now() - interval '1 day', NULL),
  ('DO-70007', NULL, 'Ann@Shop.test', 'Ann', '+94771111111', 1000, 1450, 'pending', now() - interval '20 days', NULL),
  ('DO-70008', current_setting('t.bob')::uuid, 'bob@shop.test', 'Bob', '+94772222222', 1000, 1450, 'delivered', now() - interval '1 day', NULL);
INSERT INTO public.order_items (order_id, product_id, variant_id, quantity, unit_price, product_name, brand, variant_name) VALUES
  ('DO-70001', pg_temp.pid('am-a'), pg_temp.vid('am-a'), 1, 1000, 'Alpha', 'AmBrand', 'Standard'),
  ('DO-70001', pg_temp.pid('am-b'), pg_temp.vid('am-b'), 2, 1000, 'Beta', 'AmBrand', '16GB'),
  ('DO-70001', NULL, NULL, 1, 500, 'Old gadget', 'Gone', NULL),
  ('DO-70001', NULL, NULL, 1, 500, 'Older gadget', 'Gone', NULL),
  ('DO-70007', pg_temp.pid('am-d'), pg_temp.vid('am-d'), 1, 1000, 'Delta', 'AmBrand', 'Standard'),
  ('DO-70008', pg_temp.pid('am-e'), pg_temp.vid('am-e'), 1, 1000, 'Epsilon', 'AmBrand', 'Standard');
INSERT INTO public.order_items (order_id, product_id, variant_id, quantity, unit_price, product_name, brand, variant_name)
SELECT o, pg_temp.pid('am-g'), pg_temp.vid('am-g'), 1, 1000, 'Gamma', 'AmBrand', 'Standard'
  FROM unnest(ARRAY['DO-70002', 'DO-70003', 'DO-70004', 'DO-70005', 'DO-70006']) o;
INSERT INTO public.order_tracking (order_id, status, description, created_at) VALUES
  ('DO-70001', 'Order placed', 'We have received your order.', now() - interval '10 days'),
  ('DO-70001', 'Delivered', NULL, now() - interval '8 days');
-- Ann's finder profiles: the newest non-empty one counts, keys allowlisted, numbers clamped
INSERT INTO public.finder_responses (session_id, customer_id, answers, profile, updated_at) VALUES
  (gen_random_uuid(), current_setting('t.ann')::uuid, '{}', '{"performance":9}', now() - interval '3 days'),
  (gen_random_uuid(), current_setting('t.ann')::uuid, '{}',
   '{"performance":7,"portability":12,"value":3.456,"battery":"high","ignore previous instructions":1,"weight":-2}', now() - interval '2 days'),
  (gen_random_uuid(), current_setting('t.ann')::uuid, '{}', '{}', now() - interval '1 day');
-- chat sessions
INSERT INTO public.assistant_sessions (id, client_key, customer_id, message_count, last_seen_at) VALUES
  ('51000000-0000-0000-0000-000000000001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NULL, 2, now()),
  ('52000000-0000-0000-0000-000000000001', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', NULL, 2, now()),
  ('53000000-0000-0000-0000-000000000001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', current_setting('t.bob')::uuid, 2, now()),
  ('54000000-0000-0000-0000-000000000001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NULL, 2, now() - interval '2 days'),
  ('55000000-0000-0000-0000-000000000001', NULL, NULL, 2, now());

-- ── who may ask ─────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT public.get_assistant_customer_context(NULL, NULL)', '42501', 'anon has no EXECUTE on customer memory (grant U)');
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000c1');
SELECT pg_temp.eq(public.get_assistant_customer_context(NULL, NULL), NULL::jsonb, 'an account without a customers row gets NULL');

-- ── Ann's memory ────────────────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.ann')::uuid);
SELECT set_config('t.ctx', public.get_assistant_customer_context('51000000-0000-0000-0000-000000000001', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')::text, false);
SELECT public.get_assistant_customer_context('52000000-0000-0000-0000-000000000001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
SELECT public.get_assistant_customer_context('53000000-0000-0000-0000-000000000001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
SELECT public.get_assistant_customer_context('54000000-0000-0000-0000-000000000001', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
SELECT public.get_assistant_customer_context('55000000-0000-0000-0000-000000000001', '10.0.0.1');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.j('ctx')) k), ARRAY['firstName', 'owns', 'profile'],
                  'memory carries first name, owned lines and profile only — no address, phone, email or money');
SELECT pg_temp.eq(pg_temp.j('ctx') ->> 'firstName', 'Ann', 'first name trimmed');
SELECT pg_temp.eq((SELECT string_agg(e ->> 'name', ',' ORDER BY ord) FROM jsonb_array_elements(pg_temp.j('ctx') -> 'owns') WITH ORDINALITY AS x(e, ord)),
                  'Alpha,Beta,Old gadget,Older gadget,Delta',
                  'owns: lines of the last 5 NON-cancelled orders (cancelled filtered BEFORE the limit), by account or email, newest first; deleted products kept apart');
SELECT pg_temp.eq((SELECT e FROM jsonb_array_elements(pg_temp.j('ctx') -> 'owns') e WHERE e ->> 'name' = 'Beta'),
                  jsonb_build_object('productId', pg_temp.pid('am-b'), 'variantId', pg_temp.vid('am-b'), 'name', 'Beta', 'brand', 'AmBrand',
                                     'variant', '16GB', 'boughtOn', pg_temp.month('10 days'), 'status', 'delivered'),
                  'an owned line: ids, snapshot names, variant name, month bought (Colombo), status');
SELECT pg_temp.eq((SELECT count(*) FROM jsonb_array_elements(pg_temp.j('ctx') -> 'owns') e WHERE e::text LIKE '%price%' OR e::text LIKE '%total%'),
                  0::bigint, 'no money in the owned lines');
SELECT pg_temp.eq(pg_temp.j('ctx') -> 'profile', '{"performance":7,"portability":10,"value":3.46,"weight":0}'::jsonb,
                  'profile: the newest non-empty one; keys allowlisted to the finder axes; numbers only, clamped 0..10');
SELECT pg_temp.eq((SELECT string_agg(left(id::text, 2) || '=' || COALESCE((customer_id = current_setting('t.ann')::uuid)::text, 'none'), ',' ORDER BY id)
                     FROM public.assistant_sessions),
                  '51=true,52=none,53=false,54=none,55=true',
                  'claims: an unclaimed recent session with the same client key (any case) or no key; never another key, another customer''s, or a stale one');

-- Bob sees only his own
SELECT pg_temp.login(current_setting('t.bob')::uuid);
SELECT set_config('t.ctx_bob', public.get_assistant_customer_context()::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(e ->> 'name', ',') FROM jsonb_array_elements(pg_temp.j('ctx_bob') -> 'owns') e), 'Epsilon', 'Bob sees only his own purchases');
SELECT pg_temp.eq(pg_temp.j('ctx_bob') -> 'profile', '{}'::jsonb, 'no finder profile → {}');

-- ── forget ──────────────────────────────────────────────────────────────────
INSERT INTO public.assistant_messages (session_id, role, content) VALUES
  ('51000000-0000-0000-0000-000000000001', 'user', 'hi'), ('55000000-0000-0000-0000-000000000001', 'user', 'hello');
SELECT pg_temp.login(current_setting('t.ann')::uuid);
SELECT pg_temp.throws(format('SELECT public.forget_assistant_customer(%L)', current_setting('t.ann')), '42501',
                      'a shopper cannot call forget (admin only)', 'not_authorised:%');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(public.forget_assistant_customer(current_setting('t.ann')::uuid), 2, 'forget deletes the customer''s sessions');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.assistant_messages), 0::bigint, '…and their messages cascade');
SELECT pg_temp.eq((SELECT count(*) FROM public.assistant_sessions WHERE customer_id = current_setting('t.bob')::uuid), 1::bigint,
                  'other customers'' sessions stay');

-- ── lookup_order_for_assistant ──────────────────────────────────────────────
INSERT INTO public.assistant_order_lookups (order_ref, email_domain, found, created_at) VALUES ('DO-1', 'old.test', FALSE, now() - interval '40 days');
SELECT pg_temp.login_anon();
SELECT set_config('t.l1', COALESCE(public.lookup_order_for_assistant(' do-70001 ', 'ANN@shop.test', '61000000-0000-0000-0000-000000000001',
                                                                    'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC')::text, ''), false);
SELECT set_config('t.l2', COALESCE(public.lookup_order_for_assistant('DO-70001', 'eve@evil.test', NULL, '10.0.0.1')::text, ''), false);
SELECT set_config('t.l3', COALESCE(public.lookup_order_for_assistant('', 'ann@shop.test')::text, ''), false);
SELECT set_config('t.l4', COALESCE(public.lookup_order_for_assistant('DO-70001', '  ')::text, ''), false);
SELECT pg_temp.throws('SELECT * FROM public.assistant_order_lookups', '42501', 'anon cannot read the lookup audit');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.j('l1')) k),
                  ARRAY['events', 'fulfillment', 'items', 'orderId', 'placedAt', 'status', 'trackingNumber', 'trackingUrl'],
                  'the narrow view: status, fulfilment, dates, tracking, items, events — no money, address, phone or email');
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('l1') ->> 'orderId', pg_temp.j('l1') ->> 'status', pg_temp.j('l1') ->> 'fulfillment',
                            pg_temp.j('l1') ->> 'trackingNumber', jsonb_array_length(pg_temp.j('l1') -> 'events')::text),
                  'DO-70001|delivered|delivery|TRK-1|2', 'the typed number is normalised and the email compared case-insensitively');
SELECT pg_temp.eq(pg_temp.j('l1') -> 'items' -> 1,
                  jsonb_build_object('productId', pg_temp.pid('am-b'), 'variantId', pg_temp.vid('am-b'), 'name', 'Beta', 'variant', '16GB', 'quantity', 2),
                  'items carry ids, names, variant and quantity only');
SELECT pg_temp.eq(pg_temp.j('l1') -> 'events' -> 0 ->> 'status', 'Order placed', 'events oldest first');
SELECT pg_temp.eq(current_setting('t.l2'), '', 'a wrong email is a miss (NULL)');
SELECT pg_temp.eq(current_setting('t.l3') || current_setting('t.l4'), '', 'blank number or email → NULL');
SELECT pg_temp.eq((SELECT string_agg(concat_ws('/', order_ref, email_domain, found::text, COALESCE(client_key, '∅'), COALESCE(left(session_id::text, 2), '∅')), ', ' ORDER BY id)
                     FROM public.assistant_order_lookups),
                  'DO-70001/shop.test/true/cccccccccccccccccccccccccccccccc/61, DO-70001/evil.test/false/∅/∅',
                  'audit: the email DOMAIN only, a hashed client key or nothing, blanks not audited, 40-day-old rows pruned');

-- a showroom-pickup order says so (the widget then reads "ready for pickup", not "out for delivery")
UPDATE public.orders SET fulfillment = 'pickup', status = 'out_for_delivery' WHERE id = 'DO-70008';
SELECT pg_temp.login_anon();
SELECT set_config('t.lp', COALESCE(public.lookup_order_for_assistant('DO-70008', 'bob@shop.test')::text, ''), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('lp') ->> 'fulfillment', pg_temp.j('lp') ->> 'status'), 'pickup|out_for_delivery',
                  'the narrow view carries the fulfilment, so a pickup order reads as one');

-- the throttle is shared with track_guest_order: 8 per 15 minutes per number, a miss costs double
SELECT pg_temp.login_anon();
SELECT public.lookup_order_for_assistant('DO-70007', 'x1@guess.test');   -- ref: 2
SELECT public.lookup_order_for_assistant('DO-70007', 'x2@guess.test');   -- ref: 4
SELECT public.lookup_order_for_assistant('DO-70007', 'x3@guess.test');   -- ref: 6
SELECT set_config('t.t7', COALESCE(public.lookup_order_for_assistant('DO-70007', 'ann@shop.test')::text, ''), false);   -- ref: 7
SELECT public.lookup_order_for_assistant('DO-70007', 'x4@guess.test');   -- ref: 8
SELECT set_config('t.t9', COALESCE(public.lookup_order_for_assistant('DO-70007', 'ann@shop.test')::text, ''), false);
SELECT set_config('t.tg', COALESCE(public.track_guest_order('DO-70007', 'ann@shop.test')::text, ''), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.j('t7') ->> 'orderId', 'DO-70007', 'the right pair still answers while the number has budget left');
SELECT pg_temp.eq(pg_temp.j('t9'), '{"throttled": true}'::jsonb, 'once the number''s budget is spent even the right pair is throttled');
SELECT pg_temp.eq(pg_temp.j('tg'), '{"throttled": true}'::jsonb, 'guest tracking draws on the same budget');
SELECT pg_temp.eq((SELECT count(*) FROM public.assistant_order_lookups WHERE order_ref = 'DO-70007'), 5::bigint, 'throttled calls are not audited');
