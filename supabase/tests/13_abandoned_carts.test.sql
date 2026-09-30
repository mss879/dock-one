-- 13_abandoned_carts.test.sql — autosave capture (catalogue-resolved lines, sanitised address and
-- currency, email guard, never after conversion, ≤ 25 open carts), place_order converting the
-- autosave row, the secret-gated exclusive claim (later-order and later-cart exclusion, windows,
-- opt-outs, suppressions), release, the restore link (no address/phone), stop → a person-level
-- suppression that survives a new cart, grandfathering marker, RLS.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);
INSERT INTO public.app_config (name, value) VALUES ('cart_recovery', 'cr_secret_0123456789abcdefghij')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;

-- ── fixtures: two visible products (one with two variants) and a hidden one ─────
INSERT INTO public.categories (id, name) VALUES ('ac-cat', 'Carts');
INSERT INTO public.products (slug, brand, name, category_id, image_urls) VALUES
  ('ac-a', 'AcBrand', 'Ac Alpha',  'ac-cat', ARRAY['/images/products/ac-a.webp']),
  ('ac-b', 'AcBrand', 'Ac Beta',   'ac-cat', '{}'),
  ('ac-h', 'AcBrand', 'Ac Hidden', 'ac-cat', '{}');
INSERT INTO public.product_variants (product_id, sku, name, price) VALUES
  ((SELECT id FROM public.products WHERE slug = 'ac-a'), 'AC-A',   'Standard', 1000),
  ((SELECT id FROM public.products WHERE slug = 'ac-b'), 'AC-B-1', '8GB',      2000),
  ((SELECT id FROM public.products WHERE slug = 'ac-b'), 'AC-B-2', '16GB',     2500),
  ((SELECT id FROM public.products WHERE slug = 'ac-h'), 'AC-H',   'Standard',  900);
UPDATE public.products SET is_active = FALSE WHERE slug = 'ac-h';
SELECT set_config('t.a',  (SELECT id FROM public.products WHERE slug = 'ac-a')::text, false);
SELECT set_config('t.b',  (SELECT id FROM public.products WHERE slug = 'ac-b')::text, false);
SELECT set_config('t.h',  (SELECT id FROM public.products WHERE slug = 'ac-h')::text, false);
SELECT set_config('t.a1', (SELECT id FROM public.product_variants WHERE sku = 'AC-A')::text, false);
SELECT set_config('t.b1', (SELECT id FROM public.product_variants WHERE sku = 'AC-B-1')::text, false);
SELECT set_config('t.b2', (SELECT id FROM public.product_variants WHERE sku = 'AC-B-2')::text, false);
SELECT set_config('t.h1', (SELECT id FROM public.product_variants WHERE sku = 'AC-H')::text, false);

CREATE FUNCTION pg_temp.id(p text) RETURNS int LANGUAGE sql AS $$ SELECT current_setting('t.' || p)::int $$;
CREATE FUNCTION pg_temp.line(p_product text, p_variant text, p_qty int) RETURNS jsonb LANGUAGE sql AS
  $$ SELECT jsonb_build_object('product_id', pg_temp.id(p_product), 'variant_id', pg_temp.id(p_variant), 'quantity', p_qty) $$;
CREATE FUNCTION pg_temp.one_line() RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_array(pg_temp.line('a', 'a1', 1)) $$;
-- capture with defaults (as whatever role is current)
CREATE FUNCTION pg_temp.cap(p_id uuid, p_email text, p_items jsonb DEFAULT NULL, p_first text DEFAULT 'Cy') RETURNS uuid
  LANGUAGE sql AS $$ SELECT public.capture_abandoned_cart(p_id, p_email, p_first, NULL, NULL, NULL,
                                                          COALESCE(p_items, pg_temp.one_line()), 0) $$;
CREATE FUNCTION pg_temp.cart(p_id uuid) RETURNS public.abandoned_carts LANGUAGE sql AS
  $$ SELECT * FROM public.abandoned_carts WHERE id = p_id $$;
CREATE FUNCTION pg_temp.j(p_name text) RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('t.' || p_name)::jsonb $$;
CREATE FUNCTION pg_temp.claim(p_stage int, p_min_age int DEFAULT 60, p_gap int DEFAULT 60, p_secret text DEFAULT 'cr_secret_0123456789abcdefghij')
  RETURNS jsonb LANGUAGE sql AS
  $$ SELECT public.claim_abandoned_carts_for_recovery(p_secret, p_stage::smallint, p_min_age, p_gap, 336, 20) $$;
CREATE FUNCTION pg_temp.ids(p jsonb) RETURNS text LANGUAGE sql AS
  $$ SELECT COALESCE(string_agg(left(e ->> 'id', 8), ',' ORDER BY e ->> 'id'), '') FROM jsonb_array_elements(p) e $$;

-- ── privileges ──────────────────────────────────────────────────────────────
SELECT pg_temp.ok(has_function_privilege('anon', 'public.capture_abandoned_cart(uuid,text,text,text,text,jsonb,jsonb,numeric,text,numeric)', 'EXECUTE')
              AND has_function_privilege('anon', 'public.claim_abandoned_carts_for_recovery(text,smallint,integer,integer,integer,integer)', 'EXECUTE')
              AND has_function_privilege('anon', 'public.release_abandoned_cart_recovery(text,uuid,smallint)', 'EXECUTE')
              AND has_function_privilege('anon', 'public.get_recovery_cart(uuid)', 'EXECUTE')
              AND has_function_privilege('anon', 'public.stop_cart_recovery(uuid)', 'EXECUTE'),
                  'the five cart functions are callable with the anon key (the claim/release are secret-gated)');
SELECT pg_temp.ok(NOT has_table_privilege('anon', 'public.abandoned_carts', 'SELECT')
              AND NOT has_table_privilege('anon', 'public.abandoned_carts', 'INSERT'), 'anon holds no privilege on abandoned_carts');
SELECT pg_temp.eq((SELECT count(*) FROM public.app_config WHERE name = 'cart_recovery_backfilled_at'), 1::bigint,
                  'the grandfathering backfill ran once and left its marker');

-- ── capture: the browser names ids; the catalogue decides the rest ──────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(public.capture_abandoned_cart('11111111-1111-1111-1111-111111111111', ' Cart@Shop.TEST ', ' Cy ', '', '  ',
  jsonb_build_object('street', ' 12 Galle Road ', 'city', 'Colombo 03', 'district', 'colombo', 'postal_code', '00300',
                     'country', 'Sri Lanka', 'evil', '<script>', 'phone', '0771234567'),
  jsonb_build_array(
    pg_temp.line('a', 'a1', 2) || '{"name":"FREE LAPTOP","price":1,"image":"javascript:alert(1)"}',
    pg_temp.line('b', 'b2', 1),
    pg_temp.line('h', 'h1', 1),                       -- hidden product: dropped
    pg_temp.line('a', 'b1', 1),                       -- a variant of another product: dropped
    '{"junk":true}'::jsonb,                           -- malformed: dropped
    '"not an object"'::jsonb,                         -- malformed: dropped
    pg_temp.line('b', 'b2', 20),                      -- the same variant again: merged and capped at 10
    pg_temp.line('b', 'b1', 0)),                      -- zero quantity: dropped
  1, 'usd', 0.0033),
  '11111111-1111-1111-1111-111111111111'::uuid, 'capture answers the cart id');
SELECT pg_temp.logout();
SELECT pg_temp.eq((pg_temp.cart('11111111-1111-1111-1111-111111111111')).cart_items,
                  jsonb_build_array(
                    jsonb_build_object('product_id', pg_temp.id('a'), 'variant_id', pg_temp.id('a1'), 'quantity', 2,
                                       'name', 'Ac Alpha', 'variant_name', 'Standard', 'price', 1000,
                                       'image', '/images/products/ac-a.webp'),
                    jsonb_build_object('product_id', pg_temp.id('b'), 'variant_id', pg_temp.id('b2'), 'quantity', 10,
                                       'name', 'Ac Beta', 'variant_name', '16GB', 'price', 2500, 'image', NULL)),
                  'lines are re-read from the catalogue (names, prices, images), bad/hidden lines dropped, repeats merged and capped');
SELECT pg_temp.eq((pg_temp.cart('11111111-1111-1111-1111-111111111111')).total_price, 27000.00::numeric,
                  'total_price is the catalogue subtotal (2 × 1000 + 10 × 2500), never the client''s figure');
SELECT pg_temp.eq((pg_temp.cart('11111111-1111-1111-1111-111111111111')).shipping_address,
                  '{"street":"12 Galle Road","city":"Colombo 03","district":"Colombo","postal_code":"00300","country":"Sri Lanka"}'::jsonb,
                  'the address keeps only the checkout keys, trimmed, district canonical');
SELECT pg_temp.eq((SELECT concat_ws('|', c.email, c.first_name, COALESCE(c.last_name, '∅'), COALESCE(c.phone, '∅'), c.currency,
                                    c.exchange_rate::text, c.recovery_opted_out::text)
                     FROM pg_temp.cart('11111111-1111-1111-1111-111111111111') c),
                  'cart@shop.test|Cy|∅|∅|USD|0.003300|false', 'email lower-cased, blanks → NULL, display currency recorded, not opted out');

-- the email guard: another address cannot overwrite (the answer is the same id)
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(pg_temp.cap('11111111-1111-1111-1111-111111111111', 'attacker@x.test', '[]'::jsonb, 'X'),
                  '11111111-1111-1111-1111-111111111111'::uuid, 'a hijack attempt gets the same answer');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT concat_ws('|', c.email, c.first_name, jsonb_array_length(c.cart_items)::text)
                     FROM pg_temp.cart('11111111-1111-1111-1111-111111111111') c),
                  'cart@shop.test|Cy|2', '…and changed nothing');

-- the same shopper's next autosave updates the cart and its abandonment time
UPDATE public.abandoned_carts SET updated_at = now() - interval '1 day' WHERE id = '11111111-1111-1111-1111-111111111111';
SELECT pg_temp.login_anon();
SELECT pg_temp.cap('11111111-1111-1111-1111-111111111111', 'CART@shop.test',
                   jsonb_build_array(pg_temp.line('a', 'a1', 2), pg_temp.line('b', 'b2', 10)), 'Cyril');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT concat_ws('|', c.first_name, (c.updated_at > now() - interval '1 minute')::text)
                     FROM pg_temp.cart('11111111-1111-1111-1111-111111111111') c),
                  'Cyril|true', 'the same address (any case) updates the cart and moves updated_at');

-- refusals
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.capture_abandoned_cart(NULL, 'a@b.lk', 'A', NULL, NULL, NULL, '[]', 0)$$, 'P0001', 'NULL id', 'invalid_input');
SELECT pg_temp.throws($$SELECT public.capture_abandoned_cart(gen_random_uuid(), 'not-an-email', 'A', NULL, NULL, NULL, '[]', 0)$$,
                      'P0001', 'bad email', 'invalid_input');
SELECT pg_temp.throws($$SELECT public.capture_abandoned_cart(gen_random_uuid(), 'a@b.lk', 'A', NULL, NULL, NULL, '{"a":1}', 0)$$,
                      'P0001', 'items not an array', 'invalid_input');
SELECT pg_temp.throws($$SELECT public.capture_abandoned_cart(gen_random_uuid(), 'a@b.lk', 'A', NULL, NULL, NULL, NULL, 0)$$,
                      'P0001', 'items NULL', 'invalid_input');
SELECT pg_temp.throws(format('SELECT public.capture_abandoned_cart(gen_random_uuid(), %L, %L, NULL, NULL, NULL, %L, 0)', 'a@b.lk', 'A',
                             (SELECT jsonb_agg(pg_temp.line('a', 'a1', 1)) FROM generate_series(1, 51))), 'P0001', 'more than 50 lines', 'invalid_input');

-- currency is recorded only when usable
SELECT pg_temp.cap('c0000000-0000-0000-0000-000000000001', 'cur@shop.test');
SELECT public.capture_abandoned_cart('c0000000-0000-0000-0000-000000000002', 'cur@shop.test', 'A', NULL, NULL, NULL, pg_temp.one_line(), 0, 'XYZ', 2);
SELECT public.capture_abandoned_cart('c0000000-0000-0000-0000-000000000003', 'cur@shop.test', 'A', NULL, NULL, NULL, pg_temp.one_line(), 0, 'USD', 0);
SELECT public.capture_abandoned_cart('c0000000-0000-0000-0000-000000000004', 'cur@shop.test', 'A', NULL, NULL, NULL, pg_temp.one_line(), 0, 'LKR', 5);
SELECT public.capture_abandoned_cart('c0000000-0000-0000-0000-000000000005', 'cur@shop.test', 'A', NULL, NULL, NULL, pg_temp.one_line(), 0, 'gbp', 0.0025);
SELECT public.capture_abandoned_cart('c0000000-0000-0000-0000-000000000006', 'cur@shop.test', 'A', NULL, NULL, NULL, pg_temp.one_line(), 0, 'EUR', 'NaN');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(currency || ' ' || exchange_rate::text, ',' ORDER BY id) FROM public.abandoned_carts WHERE email = 'cur@shop.test'),
                  'LKR 1.000000,LKR 1.000000,LKR 1.000000,LKR 1.000000,GBP 0.002500,LKR 1.000000',
                  'default LKR; unknown code, zero/NaN rate → LKR/1; LKR is always rate 1');
SELECT pg_temp.eq((pg_temp.cart('c0000000-0000-0000-0000-000000000001')).shipping_address, NULL::jsonb, 'no address → NULL');

-- ≤ 25 open carts per address; autosaves of an existing cart are always allowed
SELECT pg_temp.login_anon();
DO $$ BEGIN FOR i IN 1..25 LOOP PERFORM pg_temp.cap(gen_random_uuid(), 'many@shop.test'); END LOOP; END $$;
SELECT pg_temp.throws(format('SELECT pg_temp.cap(%L, %L)', gen_random_uuid(), 'Many@Shop.test'), 'P0001',
                      'the 26th open cart for one address is refused', 'too_many_carts');
SELECT pg_temp.logout();
SELECT set_config('t.many1', (SELECT id FROM public.abandoned_carts WHERE email = 'many@shop.test' ORDER BY id LIMIT 1)::text, false);
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(pg_temp.cap(current_setting('t.many1')::uuid, 'many@shop.test', NULL, 'Again'), current_setting('t.many1')::uuid,
                  'an autosave of an existing cart is still allowed at the cap');
SELECT pg_temp.logout();
SELECT pg_temp.eq((pg_temp.cart(current_setting('t.many1')::uuid)).first_name, 'Again', '…and it was written');
UPDATE public.abandoned_carts SET converted = TRUE WHERE id = current_setting('t.many1')::uuid;
SELECT pg_temp.login_anon();
SELECT pg_temp.ok(pg_temp.cap(gen_random_uuid(), 'many@shop.test') IS NOT NULL, 'converted carts do not count towards the cap');
SELECT pg_temp.logout();

-- ── place_order marks the checkout autosave row converted (09 + this table) ──
SELECT pg_temp.login_anon();
SELECT pg_temp.cap('22222222-2222-2222-2222-222222222222', 'buyer@shop.test');
SELECT pg_temp.cap('12121212-1212-1212-1212-121212121212', 'other@shop.test');
SELECT set_config('t.o1', public.place_order('Buyer@Shop.test', 'Bea', 'Silva', '0771234567',
         '{"street":"1 Temple Road","city":"Kandy","district":"Kandy"}', pg_temp.one_line(), NULL,
         '22222222-2222-2222-2222-222222222222', 'LKR', 1, 'cod', 'delivery', NULL)::text, false);
SELECT set_config('t.o2', public.place_order('someone.else@shop.test', 'Sam', NULL, '0771234567',
         '{"street":"2 Temple Road","city":"Kandy","district":"Kandy"}', pg_temp.one_line(), NULL,
         '12121212-1212-1212-1212-121212121212', 'LKR', 1, 'cod', 'delivery', NULL)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT concat_ws('|', c.converted::text, c.converted_order_id, (c.updated_at > now() - interval '1 minute')::text)
                     FROM pg_temp.cart('22222222-2222-2222-2222-222222222222') c),
                  'true|' || (pg_temp.j('o1') ->> 'order_id') || '|true', 'the buyer''s autosave row is converted and linked to the order');
SELECT pg_temp.eq((pg_temp.cart('12121212-1212-1212-1212-121212121212')).converted, FALSE,
                  'an order with a different email never converts someone else''s cart');
SELECT pg_temp.login_anon();
SELECT pg_temp.cap('22222222-2222-2222-2222-222222222222', 'buyer@shop.test', '[]'::jsonb, 'Changed');
SELECT pg_temp.logout();
SELECT pg_temp.eq((pg_temp.cart('22222222-2222-2222-2222-222222222222')).first_name, 'Cy', 'a converted cart is never overwritten by a later autosave');

-- ── the recovery claim ──────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.cap('33333333-3333-3333-3333-333333333333', 'bought@shop.test');
SELECT pg_temp.cap('44444444-4444-4444-4444-444444444444', 'twice@shop.test');
SELECT pg_temp.cap('55555555-5555-5555-5555-555555555555', 'twice@shop.test');
SELECT pg_temp.cap('66666666-6666-6666-6666-666666666666', 'optout@shop.test');
SELECT pg_temp.cap('77777777-7777-7777-7777-777777777777', 'empty@shop.test', '[]'::jsonb);
SELECT pg_temp.cap('88888888-8888-8888-8888-888888888888', 'old@shop.test');
SELECT pg_temp.cap('99999999-9999-9999-9999-999999999999', 'supp@shop.test');
SELECT pg_temp.cap('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'young@shop.test');
SELECT pg_temp.logout();
UPDATE public.abandoned_carts SET updated_at = now() - interval '2 hours'
 WHERE id IN ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555',
              '66666666-6666-6666-6666-666666666666', '77777777-7777-7777-7777-777777777777', '99999999-9999-9999-9999-999999999999',
              '12121212-1212-1212-1212-121212121212');
UPDATE public.abandoned_carts SET updated_at = now() - interval '3 hours' WHERE id = '44444444-4444-4444-4444-444444444444';
UPDATE public.abandoned_carts SET updated_at = now() - interval '15 days' WHERE id = '88888888-8888-8888-8888-888888888888';
UPDATE public.abandoned_carts SET recovery_opted_out = TRUE WHERE id = '66666666-6666-6666-6666-666666666666';
INSERT INTO public.email_suppressions (email, reason) VALUES ('supp@shop.test', 'all');
-- bought@shop.test placed an order after abandoning (and other@shop.test did not)
INSERT INTO public.orders (id, email, first_name, phone, subtotal, total_price) VALUES ('DO-77001', 'Bought@Shop.test', 'B', '+94771111111', 1000, 1450);
-- other@shop.test's cart (12121212) is due too; keep it out of this check by giving it a later empty cart
SELECT pg_temp.login_anon();
SELECT pg_temp.cap('12121212-0000-0000-0000-000000000000', 'other@shop.test', '[]'::jsonb);
SELECT pg_temp.logout();
SELECT set_config('t.c1_updated', (pg_temp.cart('11111111-1111-1111-1111-111111111111')).updated_at::text, false);

SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT pg_temp.claim(1, 60, 60, 'wrong-secret-0123456789abcdef')$$, 'P0001', 'a wrong secret claims nothing', 'unauthorized');
SELECT pg_temp.throws($$SELECT pg_temp.claim(1, 60, 60, NULL)$$, 'P0001', 'no secret claims nothing', 'unauthorized');
SELECT pg_temp.throws($$SELECT pg_temp.claim(1, 60, 60, 'short')$$, 'P0001', 'a short secret claims nothing', 'unauthorized');
SELECT pg_temp.throws($$SELECT pg_temp.claim(0)$$, 'P0001', 'stage 0 is refused', 'invalid_stage');
SELECT pg_temp.throws($$SELECT pg_temp.claim(10)$$, 'P0001', 'stage 10 is refused', 'invalid_stage');
SELECT set_config('t.claim1', pg_temp.claim(1)::text, false);
SELECT set_config('t.claim1b', pg_temp.claim(1)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.ids(pg_temp.j('claim1')), '11111111,55555555',
                  'stage 1 claims exactly the due carts: not converted/bought-since/older-of-two/opted-out/empty/too-old/suppressed/too-young');
SELECT pg_temp.eq(jsonb_array_length(pg_temp.j('claim1b')), 0, 'a second claim of the same stage gets nothing (exclusive claim)');
SELECT pg_temp.eq((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.j('claim1') -> 0) k),
                  ARRAY['abandoned_at', 'cart_items', 'currency', 'email', 'first_name', 'id', 'last_name', 'token', 'total_price'],
                  'the claim payload: no phone, no address');
SELECT pg_temp.eq((SELECT e ->> 'token' FROM jsonb_array_elements(pg_temp.j('claim1')) e WHERE e ->> 'id' LIKE '11111111%'),
                  (pg_temp.cart('11111111-1111-1111-1111-111111111111')).recovery_token::text, 'the claim carries the restore token');
SELECT pg_temp.eq((SELECT concat_ws('|', c.recovery_stage::text, (c.last_recovery_at > now() - interval '1 minute')::text,
                                    (c.updated_at::text = current_setting('t.c1_updated'))::text)
                     FROM pg_temp.cart('11111111-1111-1111-1111-111111111111') c),
                  '1|true|true', 'claiming stamps the stage and last_recovery_at and leaves updated_at alone');

-- stage 2 waits for the gap; with no gap it claims the stage-1 carts
SELECT pg_temp.login_anon();
SELECT set_config('t.claim2a', pg_temp.claim(2, 60, 60)::text, false);
SELECT set_config('t.claim2b', pg_temp.claim(2, 60, 0)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(jsonb_array_length(pg_temp.j('claim2a')), 0, 'stage 2 respects the minimum gap after stage 1');
SELECT pg_temp.eq(pg_temp.ids(pg_temp.j('claim2b')), '11111111,55555555', 'with the gap satisfied stage 2 claims the stage-1 carts');

-- a missing secret row keeps the job closed
DELETE FROM public.app_config WHERE name = 'cart_recovery';
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT pg_temp.claim(1)$$, 'P0001', 'no app_config secret → unauthorized even with the right value', 'unauthorized');
SELECT pg_temp.logout();
INSERT INTO public.app_config (name, value) VALUES ('cart_recovery', 'cr_secret_0123456789abcdefghij');

-- ── release ─────────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.release_abandoned_cart_recovery('nope-nope-nope-nope-nope', '11111111-1111-1111-1111-111111111111', 2::smallint)$$,
                      'P0001', 'release needs the secret', 'unauthorized');
SELECT pg_temp.eq(public.release_abandoned_cart_recovery('cr_secret_0123456789abcdefghij', '11111111-1111-1111-1111-111111111111', 1::smallint),
                  FALSE, 'releasing a stage the cart is no longer at does nothing');
SELECT pg_temp.eq(public.release_abandoned_cart_recovery('cr_secret_0123456789abcdefghij', '11111111-1111-1111-1111-111111111111', 2::smallint),
                  TRUE, 'releasing the current stage hands the cart back');
SELECT pg_temp.eq(public.release_abandoned_cart_recovery('cr_secret_0123456789abcdefghij', NULL, 2::smallint), FALSE, 'NULL id → FALSE');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT concat_ws('|', c.recovery_stage::text, COALESCE(c.last_recovery_at::text, '∅'))
                     FROM pg_temp.cart('11111111-1111-1111-1111-111111111111') c),
                  '1|∅', 'released: back to stage 1, last_recovery_at cleared');

-- ── the restore link ────────────────────────────────────────────────────────
SELECT set_config('t.tok1', (pg_temp.cart('11111111-1111-1111-1111-111111111111')).recovery_token::text, false);
SELECT pg_temp.login_anon();
SELECT set_config('t.rc', public.get_recovery_cart(current_setting('t.tok1')::uuid)::text, false);
SELECT set_config('t.rc0', public.get_recovery_cart(gen_random_uuid())::text, false);
SELECT set_config('t.rcn', public.get_recovery_cart(NULL)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(pg_temp.j('rc')) k),
                  ARRAY['cart_items', 'converted', 'first_name', 'found', 'opted_out'],
                  'the restore view: items and first name only — never the address, phone or email');
SELECT pg_temp.eq(concat_ws('|', pg_temp.j('rc') ->> 'found', pg_temp.j('rc') ->> 'first_name', jsonb_array_length(pg_temp.j('rc') -> 'cart_items')::text),
                  'true|Cyril|2', 'the restore view carries the lines');
SELECT pg_temp.eq(pg_temp.j('rc0'), '{"found": false}'::jsonb, 'an unknown token → {found:false}');
SELECT pg_temp.eq(pg_temp.j('rcn'), '{"found": false}'::jsonb, 'a NULL token → {found:false}');

-- ── stop: the person is suppressed, and it survives a NEW cart ──────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(public.stop_cart_recovery(gen_random_uuid()), TRUE, 'stop with an unknown token answers TRUE (no enumeration)');
SELECT pg_temp.eq(public.stop_cart_recovery(NULL), TRUE, 'stop with a NULL token answers TRUE');
SELECT pg_temp.eq(public.stop_cart_recovery(current_setting('t.tok1')::uuid), TRUE, 'stop with the real token answers TRUE');
SELECT pg_temp.cap('dddddddd-dddd-dddd-dddd-dddddddddddd', 'CART@Shop.Test', NULL, 'NewCart');
SELECT pg_temp.cap('dddddddd-dddd-dddd-dddd-dddddddddddd', 'cart@shop.test', NULL, 'NewCart2');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.email_suppressions WHERE email = 'cart@shop.test' AND reason = 'cart_recovery'), 1::bigint,
                  'stop writes a person-level suppression');
SELECT pg_temp.eq((SELECT count(*) FROM public.email_suppressions), 2::bigint, 'unknown/NULL tokens suppressed nobody (only cart@ and the fixture supp@)');
SELECT pg_temp.eq((SELECT string_agg(recovery_opted_out::text, ',') FROM public.abandoned_carts
                    WHERE email = 'cart@shop.test' AND id <> 'dddddddd-dddd-dddd-dddd-dddddddddddd'), 'true',
                  'every existing cart of that address is opted out');
SELECT pg_temp.eq((SELECT concat_ws('|', c.first_name, c.recovery_opted_out::text) FROM pg_temp.cart('dddddddd-dddd-dddd-dddd-dddddddddddd') c),
                  'NewCart2|true', 'a NEW cart from the suppressed address is born opted out, and an autosave never clears it');
-- even if an admin clears the flag by hand, the suppression still keeps the claim away
UPDATE public.abandoned_carts SET recovery_opted_out = FALSE, updated_at = now() - interval '2 hours',
                                  recovery_stage = 0 WHERE email = 'cart@shop.test';
SELECT pg_temp.login_anon();
SELECT set_config('t.claim3', pg_temp.claim(1)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.ok(pg_temp.ids(pg_temp.j('claim3')) NOT LIKE '%11111111%' AND pg_temp.ids(pg_temp.j('claim3')) NOT LIKE '%dddddddd%',
                  'a suppressed person is never claimed, whatever the cart flag says');

-- ── RLS ─────────────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT * FROM public.abandoned_carts', '42501', 'anon cannot read carts');
SELECT pg_temp.throws($$INSERT INTO public.abandoned_carts (id, email) VALUES (gen_random_uuid(), 'x@y.lk')$$, '42501', 'anon cannot insert carts');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.abandoned_carts), 0::bigint, 'a shopper reads no carts');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.abandoned_carts SET recovery_opted_out = FALSE$$), 0::bigint, 'a shopper updates no carts');
SELECT pg_temp.throws($$INSERT INTO public.abandoned_carts (id, email) VALUES (gen_random_uuid(), 'x@y.lk')$$, '42501', 'a shopper cannot insert carts');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.ok((SELECT count(*) FROM public.abandoned_carts) > 30, 'the admin reads every cart');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.abandoned_carts SET recovery_opted_out = TRUE WHERE email = 'young@shop.test'$$), 1::bigint,
                  'the admin can opt a cart out');
SELECT pg_temp.logout();
