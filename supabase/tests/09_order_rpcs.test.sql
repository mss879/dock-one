-- 09_order_rpcs.test.sql — quote_order, place_order, validate_discount, track_guest_order,
-- view_order, admin_set_order_status, admin_set_payment_status.
-- Blueprint Appendix B.2 groups 4–7 and 10 adapted to variant model B, LKR, the settings-driven
-- delivery rule and payment methods, plus concurrency checks over dblink (deadlock-safe lock
-- order, no oversell) when the dblink extension is available.
\ir _helpers.sql

-- ═════════════════════════════════════════════════════════════════════════════
-- Fixtures (as the superuser)
-- ═════════════════════════════════════════════════════════════════════════════
SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test', TRUE, '{"first_name":"Sam","last_name":"Silva"}')::text, false);

UPDATE public.store_settings
   SET delivery_fee = 450, free_delivery_threshold = 15000, cod_enabled = TRUE, cod_max_total = NULL,
       bank_transfer_enabled = TRUE, bank_account_name = 'QA Traders (Pvt) Ltd', bank_name = 'QA Bank',
       bank_branch = 'Colombo 03', bank_account_number = '0001 2345 6789',
       bank_transfer_instructions = 'Send the slip to qa@shop.test.',
       pickup_enabled = TRUE, pickup_address = '12 Showroom Lane, Colombo 03', pickup_note = 'Bring your order number.';

INSERT INTO public.categories (id, name) VALUES ('qa-cat', 'QA');
INSERT INTO public.products (slug, brand, name, category_id, image_urls) VALUES
  ('qa-laptop', 'QaBrand', 'Qa Laptop', 'qa-cat', ARRAY['/images/products/qa-laptop.webp']),
  ('qa-mouse',  'QaBrand', 'Qa Mouse',  'qa-cat', ARRAY['/images/products/qa-mouse.webp']),
  ('qa-drive',  'QaBrand', 'Qa Drive',  'qa-cat', '{}'),
  ('qa-dock',   'QaBrand', 'Qa Dock',   'qa-cat', '{}'),
  ('qa-hidden', 'QaBrand', 'Qa Hidden', 'qa-cat', '{}'),
  ('qa-cable',  'QaBrand', 'Qa Cable',  'qa-cat', '{}'),
  ('qa-pad',    'QaBrand', 'Qa Pad',    'qa-cat', '{}'),
  ('qa-last',   'QaBrand', 'Qa Last',   'qa-cat', '{}'),
  ('qa-one',    'QaBrand', 'Qa One',    'qa-cat', '{}');
-- Deadlock pair: Y must sort before X (smaller product id), so insert Y first.
INSERT INTO public.products (slug, brand, name, category_id) VALUES ('qa-dl-y', 'QaBrand', 'Qa Deadlock Y', 'qa-cat');
INSERT INTO public.products (slug, brand, name, category_id) VALUES ('qa-dl-x', 'QaBrand', 'Qa Deadlock X', 'qa-cat');
INSERT INTO public.product_variants (product_id, sku, name, price, compare_at_price, position, is_active)
SELECT p.id, v.sku, v.name, v.price, v.cmp, v.pos, v.active
  FROM (VALUES ('qa-laptop', 'Q-LAP-16',   '16GB',     7500,  8000, 0, TRUE),
               ('qa-laptop', 'Q-LAP-32',   '32GB',     14999, NULL, 1, TRUE),
               ('qa-mouse',  'Q-MOUSE',    'Standard', 5000,  6000, 0, TRUE),
               ('qa-drive',  'Q-DRIVE',    'Standard', 2500,  NULL, 0, TRUE),
               ('qa-dock',   'Q-DOCK',     'Standard', 15001, NULL, 0, TRUE),
               ('qa-hidden', 'Q-HIDDEN',   'Standard', 1000,  NULL, 0, TRUE),
               ('qa-cable',  'Q-CABLE-1M', '1 m',      1000,  NULL, 0, TRUE),
               ('qa-cable',  'Q-CABLE-2M', '2 m',      1200,  NULL, 1, FALSE),
               ('qa-pad',    'Q-PAD',      'Standard', 5450,  NULL, 0, TRUE),
               ('qa-last',   'Q-LAST',     'Standard', 3000,  NULL, 0, TRUE),
               ('qa-one',    'Q-ONE',      'Standard', 3000,  NULL, 0, TRUE),
               ('qa-dl-y',   'Q-DL-Y',     'Standard', 100,   NULL, 0, TRUE),
               ('qa-dl-x',   'Q-DL-X',     'Standard', 100,   NULL, 0, TRUE))
       AS v(slug, sku, name, price, cmp, pos, active)
  JOIN public.products p ON p.slug = v.slug;
UPDATE public.products SET is_active = FALSE WHERE slug = 'qa-hidden';
-- Stock: LAP-16 20 (ok), LAP-32 3 (low: threshold 3), DRIVE 0 (out), CABLE-1M 50, LAST 1, ONE 1,
-- deadlock pair 100 each. MOUSE, DOCK, PAD are untracked (always sell).
INSERT INTO public.inventory (variant_id, product_id, stock_level, low_stock_threshold)
SELECT v.id, v.product_id, s.lvl, s.thr
  FROM (VALUES ('Q-LAP-16', 20, 2), ('Q-LAP-32', 3, 3), ('Q-DRIVE', 0, 3), ('Q-CABLE-1M', 50, 3),
               ('Q-LAST', 1, 3), ('Q-ONE', 1, 3), ('Q-DL-Y', 100, 3), ('Q-DL-X', 100, 3)) AS s(sku, lvl, thr)
  JOIN public.product_variants v ON v.sku = s.sku;

INSERT INTO public.discounts (code, title, kind, value, min_requirement, starts_at, ends_at, usage_limit, is_active, assistant_only)
VALUES ('ten10',   'Ten percent',     'percentage',   10,   0,     NULL,                       NULL,                     NULL, TRUE,  FALSE),
       ('PAD15',   'Fifteen percent', 'percentage',   15,   0,     NULL,                       NULL,                     NULL, TRUE,  FALSE),
       ('BIG1000', 'Big spender',     'fixed_amount', 1000, 20000, NULL,                       NULL,                     1,    TRUE,  FALSE),
       ('ONCE',    'Single use',      'percentage',   5,    0,     NULL,                       NULL,                     1,    TRUE,  FALSE),
       ('EXPIRED', 'Over',            'percentage',   5,    0,     now() - interval '10 days', now() - interval '1 day', NULL, TRUE,  FALSE),
       ('SOON',    'Not yet',         'percentage',   5,    0,     now() + interval '1 day',   NULL,                     NULL, TRUE,  FALSE),
       ('OFFCODE', 'Switched off',    'percentage',   5,    0,     NULL,                       NULL,                     NULL, FALSE, FALSE),
       ('CHAT15',  'Assistant only',  'percentage',   15,   0,     NULL,                       NULL,                     5,    TRUE,  TRUE);

-- sku → {p: product id, v: variant id}, readable by any role (psql vars don't reach DO blocks).
SELECT set_config('t.ids', (SELECT jsonb_object_agg(v.sku, jsonb_build_object('p', v.product_id, 'v', v.id))
                              FROM public.product_variants v WHERE v.sku LIKE 'Q-%')::text, false);

CREATE FUNCTION pg_temp.pid(p_sku text) RETURNS int LANGUAGE sql AS
  $$ SELECT (current_setting('t.ids')::jsonb -> p_sku ->> 'p')::int $$;
CREATE FUNCTION pg_temp.vid(p_sku text) RETURNS int LANGUAGE sql AS
  $$ SELECT (current_setting('t.ids')::jsonb -> p_sku ->> 'v')::int $$;
CREATE FUNCTION pg_temp.it(p_sku text, p_qty int DEFAULT 1) RETURNS jsonb LANGUAGE sql AS
  $$ SELECT jsonb_build_object('product_id', pg_temp.pid(p_sku), 'variant_id', pg_temp.vid(p_sku), 'quantity', p_qty) $$;
CREATE FUNCTION pg_temp.its(VARIADIC p jsonb[]) RETURNS jsonb LANGUAGE sql AS $$ SELECT to_jsonb(p) $$;
CREATE FUNCTION pg_temp.addr() RETURNS jsonb LANGUAGE sql AS
  $$ SELECT '{"street":"12 Galle Road","city":"Colombo 03","district":"Colombo","postal_code":"00300"}'::jsonb $$;
-- place_order with sensible defaults (runs as the CURRENT role).
CREATE FUNCTION pg_temp.po(p_items jsonb, p_code text DEFAULT NULL, p_method text DEFAULT 'cod',
                           p_fulfillment text DEFAULT 'delivery', p_email text DEFAULT 'Guest@Shop.test')
RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.place_order(p_email, 'Gia', 'Perera', '077 123 4567', pg_temp.addr(), p_items, p_code,
                            NULL, 'LKR', 1, p_method, p_fulfillment, NULL)
$$;
CREATE FUNCTION pg_temp.j(p_name text) RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('t.' || p_name)::jsonb $$;
CREATE FUNCTION pg_temp.stock(p_sku text) RETURNS int LANGUAGE sql AS
  $$ SELECT stock_level FROM public.inventory WHERE variant_id = pg_temp.vid(p_sku) $$;
CREATE FUNCTION pg_temp.uses(p_code text) RETURNS int LANGUAGE sql AS
  $$ SELECT usage_count FROM public.discounts WHERE code = p_code $$;
-- compact summary of a quote's lines: "line/reason/stock/level"
CREATE FUNCTION pg_temp.qsum(q jsonb) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(format('%s/%s/%s/%s', l ->> 'line', COALESCE(l ->> 'reason', 'ok'), COALESCE(l ->> 'stock', '-'),
                           COALESCE(l ->> 'stock_level', '-')), ' ' ORDER BY (l ->> 'line')::int)
    FROM jsonb_array_elements(q -> 'lines') l
$$;

SELECT pg_temp.eq((SELECT count(*) FROM public.product_variants WHERE sku LIKE 'Q-%'), 13::bigint, 'fixtures: 13 variants');

-- ═════════════════════════════════════════════════════════════════════════════
-- A. quote_order — authoritative, read-only
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT set_config('t.q1', public.quote_order(pg_temp.its(
         pg_temp.it('Q-LAP-32', 1),
         pg_temp.it('Q-MOUSE', 2),
         pg_temp.it('Q-DRIVE', 1),
         jsonb_build_object('product_id', pg_temp.pid('Q-HIDDEN'), 'variant_id', pg_temp.vid('Q-HIDDEN'), 'quantity', 1),
         jsonb_build_object('product_id', 999999, 'variant_id', 1, 'quantity', 1),
         jsonb_build_object('product_id', pg_temp.pid('Q-CABLE-2M'), 'variant_id', pg_temp.vid('Q-CABLE-2M'), 'quantity', 1),
         jsonb_build_object('product_id', pg_temp.pid('Q-MOUSE'), 'variant_id', pg_temp.vid('Q-LAP-16'), 'quantity', 1),
         pg_temp.it('Q-LAP-16', 99)), 'ten10', 'delivery')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.qsum(pg_temp.j('q1')),
                  '1/ok/low/3 2/ok/ok/- 3/out_of_stock/out/- 4/inactive/-/- 5/unknown_product/-/- 6/invalid_variant/-/- 7/invalid_variant/-/- 8/ok/ok/-',
                  'quote: per-line reasons and stock bands; the exact level only when low');
SELECT pg_temp.eq(pg_temp.j('q1') -> 'lines' -> 0 ->> 'product_name' || ' / ' || (pg_temp.j('q1') -> 'lines' -> 0 ->> 'variant_name')
                  || ' / ' || (pg_temp.j('q1') -> 'lines' -> 0 ->> 'unit_price') || ' / ' || (pg_temp.j('q1') -> 'lines' -> 0 ->> 'slug'),
                  'Qa Laptop / 32GB / 14999.00 / qa-laptop', 'quote: names, variant and price come from the database');
SELECT pg_temp.eq((pg_temp.j('q1') -> 'lines' -> 1 ->> 'compare_at_price')::numeric || '/' || (pg_temp.j('q1') -> 'lines' -> 1 ->> 'line_total'),
                  '6000.00/10000.00', 'quote: compare-at price and line total');
SELECT pg_temp.ok((pg_temp.j('q1') -> 'lines' -> 3 ->> 'product_name') IS NULL AND (pg_temp.j('q1') -> 'lines' -> 3 ->> 'unit_price') IS NULL,
                  'quote: an inactive product reveals neither its name nor its price');
SELECT pg_temp.eq(pg_temp.j('q1') -> 'lines' -> 5 ->> 'product_name', 'Qa Cable', 'quote: an inactive variant of a visible product names the product');
SELECT pg_temp.eq((pg_temp.j('q1') -> 'lines' -> 7 ->> 'quantity')::int, 10, 'quote: quantity clamped to 10');
SELECT pg_temp.eq(format('%s|%s|%s|%s|%s|%s', pg_temp.j('q1') ->> 'subtotal', pg_temp.j('q1') ->> 'shipping_fee',
                         pg_temp.j('q1') ->> 'discount_amount', pg_temp.j('q1') ->> 'total', pg_temp.j('q1') ->> 'orderable',
                         pg_temp.j('q1') ->> 'currency'),
                  '99999.00|0.00|10000.00|89999.00|false|LKR',
                  'quote: subtotal counts available lines only; 10% rounded to whole rupees; not orderable');
SELECT pg_temp.eq(pg_temp.j('q1') -> 'discount', '{"code":"TEN10","valid":true,"amount":10000.00,"reason":null,"minimum":null}'::jsonb,
                  'quote: discount verdict {code, valid, amount, reason, minimum} without the internal id');
SELECT pg_temp.eq(pg_temp.stock('Q-LAP-32') || '/' || pg_temp.uses('TEN10') || '/' || (SELECT count(*) FROM public.orders),
                  '3/0/0', 'quote never mutates: stock, discount uses and orders untouched');

SELECT pg_temp.login_anon();
SELECT set_config('t.q2', public.quote_order(pg_temp.its(pg_temp.it('Q-LAP-32', 2), pg_temp.it('Q-LAP-32', 2)))::text, false);
SELECT set_config('t.q3', public.quote_order(pg_temp.its(pg_temp.it('Q-LAP-32', 5)))::text, false);
SELECT set_config('t.q4', public.quote_order((SELECT jsonb_agg(pg_temp.it('Q-MOUSE', 1)) FROM generate_series(1, 60)))::text, false);
SELECT set_config('t.q5', public.quote_order('{"not":"an array"}'::jsonb)::text, false);
SELECT set_config('t.q6', public.quote_order(NULL)::text, false);
SELECT set_config('t.q7', public.quote_order('[1, "x", {"product_id":"abc","variant_id":2,"quantity":1}]'::jsonb)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.qsum(pg_temp.j('q2')), '1/insufficient_stock/low/3 2/insufficient_stock/low/3',
                  'quote: the same variant on two lines is checked against stock as one quantity');
SELECT pg_temp.eq(pg_temp.qsum(pg_temp.j('q3')) || ' ' || (pg_temp.j('q3') ->> 'orderable'), '1/insufficient_stock/low/3 false',
                  'quote: asking for more than is left reports insufficient_stock with the level');
SELECT pg_temp.eq(jsonb_array_length(pg_temp.j('q4') -> 'lines') || '/' || (pg_temp.j('q4') ->> 'orderable'), '50/false',
                  'quote: at most 50 lines are quoted and a longer cart is not orderable');
SELECT pg_temp.eq(format('%s|%s|%s|%s', pg_temp.j('q5') -> 'lines', pg_temp.j('q5') ->> 'subtotal', pg_temp.j('q5') ->> 'shipping_fee',
                         pg_temp.j('q5') ->> 'orderable'), '[]|0.00|0.00|false', 'quote: a non-array is an empty, unorderable quote (never an error)');
SELECT pg_temp.eq(pg_temp.j('q6') ->> 'orderable', 'false', 'quote: NULL items never raise');
SELECT pg_temp.eq(pg_temp.qsum(pg_temp.j('q7')), '1/unknown_product/-/- 2/unknown_product/-/- 3/unknown_product/-/-',
                  'quote: malformed lines are reported, not raised');
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('q1') -> 'lines' -> 7 ->> 'quantity_adjusted', pg_temp.j('q1') -> 'lines' -> 0 ->> 'quantity_adjusted'),
                  'true|false', 'quote: a clamped quantity is flagged quantity_adjusted');

-- `orderable` means "place_order would accept exactly this cart" — quantities included.
SELECT pg_temp.login_anon();
SELECT set_config('t.q8', public.quote_order(pg_temp.its(pg_temp.it('Q-MOUSE', 6), pg_temp.it('Q-MOUSE', 5)))::text, false);
SELECT set_config('t.q9', public.quote_order(pg_temp.its(pg_temp.it('Q-MOUSE', 11)))::text, false);
SELECT set_config('t.q10', public.quote_order(jsonb_build_array(jsonb_build_object('product_id', pg_temp.pid('Q-MOUSE'),
                                                                                    'variant_id', pg_temp.vid('Q-MOUSE'))))::text, false);
SELECT set_config('t.q11', public.quote_order(pg_temp.its(pg_temp.it('Q-MOUSE', 10), pg_temp.it('Q-LAP-16', 1)))::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s|%s|%s', pg_temp.j('q8') -> 'lines' -> 0 ->> 'available', pg_temp.j('q8') -> 'lines' -> 0 ->> 'quantity_adjusted',
                         pg_temp.j('q8') -> 'lines' -> 1 ->> 'quantity_adjusted', pg_temp.j('q8') ->> 'orderable'),
                  'true|false|false|false', 'quote: one variant totalling 11 over two lines is not orderable (place_order says invalid_quantity)');
SELECT pg_temp.eq(format('%s|%s|%s|%s', pg_temp.j('q9') -> 'lines' -> 0 ->> 'quantity', pg_temp.j('q9') -> 'lines' -> 0 ->> 'quantity_adjusted',
                         pg_temp.j('q9') -> 'lines' -> 0 ->> 'line_total', pg_temp.j('q9') ->> 'orderable'),
                  '10|true|50000.00|false', 'quote: 11 is clamped to 10 and priced as 10, flagged, and not orderable until the cart adopts it');
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('q10') -> 'lines' -> 0 ->> 'quantity', pg_temp.j('q10') -> 'lines' -> 0 ->> 'quantity_adjusted',
                         pg_temp.j('q10') ->> 'orderable'),
                  '1|true|false', 'quote: a missing quantity reads as 1 (flagged)');
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('q11') -> 'lines' -> 0 ->> 'quantity_adjusted', pg_temp.j('q11') ->> 'orderable',
                         pg_temp.j('q11') ->> 'total'),
                  'false|true|57500.00', 'quote: exactly 10 of a variant is orderable');

-- The delivery rule on both sides of the threshold (the rule lives in store_settings).
SELECT pg_temp.login_anon();
SELECT set_config('t.q_under', public.quote_order(pg_temp.its(pg_temp.it('Q-LAP-32', 1)))::text, false);
SELECT set_config('t.q_at', public.quote_order(pg_temp.its(pg_temp.it('Q-LAP-16', 2)))::text, false);
SELECT set_config('t.q_over', public.quote_order(pg_temp.its(pg_temp.it('Q-DOCK', 1)))::text, false);
SELECT set_config('t.q_pick', public.quote_order(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, 'pickup')::text, false);
SELECT set_config('t.q_disc', public.quote_order(pg_temp.its(pg_temp.it('Q-LAP-16', 2)), 'TEN10')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s|%s|%s|%s', pg_temp.j('q_under') ->> 'subtotal', pg_temp.j('q_under') ->> 'shipping_fee',
                         pg_temp.j('q_under') ->> 'total', pg_temp.j('q_under') ->> 'amount_to_free_delivery', pg_temp.j('q_under') ->> 'delivery_fee'),
                  '14999.00|450.00|15449.00|1.00|450.00', 'quote: 14,999 pays the 450 delivery fee (1 rupee short)');
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('q_at') ->> 'subtotal', pg_temp.j('q_at') ->> 'shipping_fee', pg_temp.j('q_at') ->> 'amount_to_free_delivery'),
                  '15000.00|0.00|0.00', 'quote: EXACTLY the threshold delivers free ("<" semantics)');
SELECT pg_temp.eq(pg_temp.j('q_over') ->> 'shipping_fee', '0.00', 'quote: above the threshold delivers free');
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('q_pick') ->> 'fulfillment', pg_temp.j('q_pick') ->> 'shipping_fee', pg_temp.j('q_pick') ->> 'total'),
                  'pickup|0.00|5000.00', 'quote: showroom pickup pays no delivery');
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('q_disc') ->> 'discount_amount', pg_temp.j('q_disc') ->> 'shipping_fee', pg_temp.j('q_disc') ->> 'total'),
                  '1500.00|0.00|13500.00', 'quote: delivery is decided on the PRE-discount subtotal');
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('q_under') ->> 'cod_available', pg_temp.j('q_under') ->> 'bank_transfer_available',
                         pg_temp.j('q_under') ->> 'pickup_available'), 'true|true|true', 'quote: payment/pickup availability flags');

UPDATE public.store_settings SET pickup_enabled = FALSE, cod_max_total = 10000, bank_account_number = NULL;
SELECT pg_temp.login_anon();
SELECT set_config('t.q_off', public.quote_order(pg_temp.its(pg_temp.it('Q-LAP-32', 1)), NULL, 'pickup')::text, false);
SELECT set_config('t.q_code', public.quote_order(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), 'BIG1000')::text, false);
SELECT pg_temp.logout();
UPDATE public.store_settings SET pickup_enabled = TRUE, cod_max_total = NULL, bank_account_number = '0001 2345 6789';
SELECT pg_temp.eq(format('%s|%s|%s|%s|%s', pg_temp.j('q_off') ->> 'fulfillment', pg_temp.j('q_off') ->> 'shipping_fee',
                         pg_temp.j('q_off') ->> 'pickup_available', pg_temp.j('q_off') ->> 'cod_available',
                         pg_temp.j('q_off') ->> 'bank_transfer_available'),
                  'delivery|450.00|false|false|false',
                  'quote: pickup off → a delivery quote; COD over its cap and bank transfer without an account number are unavailable');
SELECT pg_temp.eq(pg_temp.j('q_code') -> 'discount', '{"code":"BIG1000","valid":false,"amount":0,"reason":"minimum_not_met","minimum":20000.00}'::jsonb,
                  'quote: minimum_not_met carries the minimum');

-- ═════════════════════════════════════════════════════════════════════════════
-- B. place_order — the happy path as a guest (anon), and the quote agrees with it
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT set_config('t.q_o1', public.quote_order(pg_temp.its(pg_temp.it('Q-MOUSE', 1), pg_temp.it('Q-LAP-16', 2)), 'ten10')::text, false);
SELECT set_config('t.o1', pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1), pg_temp.it('Q-LAP-16', 2)), 'ten10')::text, false);
SELECT set_config('t.o2', pg_temp.po(pg_temp.its(pg_temp.it('Q-LAP-32', 1)))::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.j('o1') ->> 'order_id', 'DO-10001', 'the first order is DO-10001');
SELECT pg_temp.eq(pg_temp.j('o2') ->> 'order_id', 'DO-10002', 'order numbers are sequential');
SELECT pg_temp.eq(format('%s|%s|%s|%s|%s|%s|%s', pg_temp.j('o1') ->> 'subtotal', pg_temp.j('o1') ->> 'shipping_fee',
                         pg_temp.j('o1') ->> 'discount_amount', pg_temp.j('o1') ->> 'total', pg_temp.j('o1') ->> 'payment_method',
                         pg_temp.j('o1') ->> 'payment_status', pg_temp.j('o1') ->> 'fulfillment'),
                  '20000.00|0.00|2000.00|18000.00|cod|pending_collection|delivery',
                  'place_order: DB-priced subtotal, free delivery over 15,000, 10% off; COD starts pending_collection');
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('q_o1') ->> 'subtotal', pg_temp.j('q_o1') ->> 'shipping_fee', pg_temp.j('q_o1') ->> 'total'),
                  format('%s|%s|%s', pg_temp.j('o1') ->> 'subtotal', pg_temp.j('o1') ->> 'shipping_fee', pg_temp.j('o1') ->> 'total'),
                  'quote_order and place_order agree on the same cart');
SELECT pg_temp.eq(pg_temp.j('q_o1') ->> 'orderable', 'true', 'the quote said orderable for the cart place_order accepted');
SELECT pg_temp.eq(format('%s|%s|%s|%s|%s', pg_temp.j('o2') ->> 'subtotal', pg_temp.j('o2') ->> 'shipping_fee', pg_temp.j('o2') ->> 'total',
                         pg_temp.j('o2') ->> 'discount_amount', pg_temp.j('o2') ->> 'discount_code'),
                  '14999.00|450.00|15449.00|0.00|', 'place_order: 14,999 pays the delivery fee');
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s|%s|%s|%s|%s', o.email, o.first_name, o.last_name, o.phone, o.customer_id,
                                 o.discount_code, o.discount_id IS NOT NULL, o.status, o.view_token::text = pg_temp.j('o1') ->> 'view_token')
                     FROM public.orders o WHERE o.id = 'DO-10001'),
                  'guest@shop.test|Gia|Perera|+94771234567||TEN10|t|pending|t',
                  'the order row: lower-cased email, names, E.164 phone, guest (no customer), redeemed code, view token');
SELECT pg_temp.eq((SELECT shipping_address FROM public.orders WHERE id = 'DO-10001'),
                  '{"street":"12 Galle Road","city":"Colombo 03","district":"Colombo","postal_code":"00300","country":"Sri Lanka"}'::jsonb,
                  'the shipping address is stored normalised (known keys only)');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s:%s:%s:%s:%s', i.product_name, i.brand, i.variant_name, i.sku, i.quantity, i.unit_price,
                                            COALESCE(i.image_url, '-')), ' | ' ORDER BY i.id)
                     FROM public.order_items i WHERE i.order_id = 'DO-10001'),
                  'Qa Laptop:QaBrand:16GB:Q-LAP-16:2:7500.00:/images/products/qa-laptop.webp | Qa Mouse:QaBrand:Standard:Q-MOUSE:1:5000.00:/images/products/qa-mouse.webp',
                  'order items: snapshots, charged unit prices, and lines written in (product_id, variant_id) lock order');
SELECT pg_temp.eq((SELECT string_agg(status || ':' || COALESCE(description, ''), ',') FROM public.order_tracking WHERE order_id = 'DO-10001'),
                  'Order placed:We have received your order.', 'the first timeline row');
SELECT pg_temp.eq(pg_temp.stock('Q-LAP-16') || '/' || pg_temp.stock('Q-LAP-32') || '/' || pg_temp.uses('TEN10'), '18/2/1',
                  'tracked stock decremented; the discount use counted once');
SELECT pg_temp.eq(jsonb_array_length(pg_temp.j('o1') -> 'items') || '/' || (pg_temp.j('o1') ->> 'phone') || '/' || (pg_temp.j('o1') ->> 'email'),
                  '2/+94771234567/guest@shop.test', 'place_order returns the server-resolved items and contact for the emails');

-- ═════════════════════════════════════════════════════════════════════════════
-- C. Delivery rule and discounts through place_order
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT set_config('t.o3', pg_temp.po(pg_temp.its(pg_temp.it('Q-LAP-16', 2)))::text, false);
SELECT set_config('t.o4', pg_temp.po(pg_temp.its(pg_temp.it('Q-DOCK', 1)))::text, false);
SELECT set_config('t.o5', pg_temp.po(pg_temp.its(pg_temp.it('Q-LAP-16', 2)), 'TEN10')::text, false);
SELECT set_config('t.o6', pg_temp.po(pg_temp.its(pg_temp.it('Q-PAD', 1)), 'pad15')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('o3') ->> 'shipping_fee', pg_temp.j('o3') ->> 'total'), '0.00|15000.00',
                  'place_order: exactly 15,000 delivers free');
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('o4') ->> 'shipping_fee', pg_temp.j('o4') ->> 'total'), '0.00|15001.00',
                  'place_order: 15,001 delivers free');
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('o5') ->> 'discount_amount', pg_temp.j('o5') ->> 'shipping_fee', pg_temp.j('o5') ->> 'total'),
                  '1500.00|0.00|13500.00', 'place_order: a code never costs free delivery (pre-discount subtotal)');
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('o6') ->> 'discount_amount', pg_temp.j('o6') ->> 'total'), '818.00|5082.00',
                  'place_order: 15% of 5,450 = 817.50 is rounded to 818 whole rupees');

-- ═════════════════════════════════════════════════════════════════════════════
-- D. Showroom pickup
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT set_config('t.o7', pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, 'cod', 'pickup')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s|%s|%s', pg_temp.j('o7') ->> 'fulfillment', pg_temp.j('o7') ->> 'shipping_fee', pg_temp.j('o7') ->> 'total',
                         pg_temp.j('o7') -> 'shipping_address'),
                  'pickup|0.00|5000.00|{}', 'pickup: no delivery fee under the threshold, no address stored');
UPDATE public.store_settings SET pickup_enabled = FALSE;
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, 'cod', 'pickup')$$, 'P0001',
                      'pickup refused while pickup is switched off', 'pickup_unavailable');
SELECT pg_temp.logout();
UPDATE public.store_settings SET pickup_enabled = TRUE, pickup_address = '  ';
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, 'cod', 'pickup')$$, 'P0001',
                      'pickup refused while no pickup address is set (never offer what cannot be honoured)', 'pickup_unavailable');
SELECT pg_temp.logout();
UPDATE public.store_settings SET pickup_address = '12 Showroom Lane, Colombo 03';

-- ═════════════════════════════════════════════════════════════════════════════
-- E. Payment methods: the client sends a METHOD, never a status
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT set_config('t.o8', pg_temp.po(pg_temp.its(pg_temp.it('Q-CABLE-1M', 1)), NULL, ' Bank_Transfer ')::text, false);
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, 'card')$$, 'P0001',
                      'an unknown payment method is refused', 'unsupported_payment_method');
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, NULL)$$, 'P0001',
                      'a NULL payment method does not slip through', 'unsupported_payment_method');
-- the blueprint's 12-argument call with a forged status: the 12th argument is the fulfilment now
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)),
                                                  NULL, NULL, 'LKR', 1, 'cod', 'paid')$$, 'P0001',
                      'a forged positional "paid" status is refused', 'invalid_fulfillment');
SELECT pg_temp.throws($$SELECT public.place_order(p_email => 'a@b.lk', p_first_name => 'A', p_last_name => 'B', p_phone => '0771234567',
                                                  p_shipping => pg_temp.addr(), p_items => pg_temp.its(pg_temp.it('Q-MOUSE', 1)),
                                                  p_payment_method => 'cod', p_payment_status => 'paid')$$, '42883',
                      'there is no p_payment_status parameter to forge (PostgREST answers PGRST202)');
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('o8') ->> 'payment_method', pg_temp.j('o8') ->> 'payment_status', pg_temp.j('o8') ->> 'total'),
                  'bank_transfer|awaiting_transfer|1450.00', 'bank transfer starts awaiting_transfer (method trimmed and lower-cased)');
SELECT pg_temp.eq((SELECT count(*) FROM pg_proc WHERE proname = 'place_order' AND pronamespace = 'public'::regnamespace), 1::bigint,
                  'exactly one place_order overload exists (no stale signature left callable)');
SELECT pg_temp.throws($$UPDATE public.orders SET payment_status = 'awaiting_transfer' WHERE id = 'DO-10001'$$, '23514',
                      'the payment pair CHECK refuses a COD order awaiting a transfer', '%orders_payment_pair_valid%');
UPDATE public.store_settings SET cod_enabled = FALSE;
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)))$$, 'P0001',
                      'COD refused while it is switched off in store_settings', 'unsupported_payment_method');
SELECT pg_temp.logout();
UPDATE public.store_settings SET cod_enabled = TRUE, bank_account_number = NULL;
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, 'bank_transfer')$$, 'P0001',
                      'bank transfer refused while no account number is set (the note alone is not enough)', 'unsupported_payment_method');
SELECT pg_temp.logout();
UPDATE public.store_settings SET bank_account_number = '0001 2345 6789', bank_name = NULL;
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, 'bank_transfer')$$, 'P0001',
                      'bank transfer refused while the bank is not named', 'unsupported_payment_method');
SELECT pg_temp.logout();
UPDATE public.store_settings SET bank_name = 'QA Bank', bank_account_name = NULL;
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, 'bank_transfer')$$, 'P0001',
                      'bank transfer refused while the account name is missing', 'unsupported_payment_method');
SELECT pg_temp.logout();
-- The branch and the extra note are optional: name + bank + number are enough to pay.
UPDATE public.store_settings SET bank_account_name = 'QA Traders (Pvt) Ltd', bank_branch = NULL, bank_transfer_instructions = NULL;
SELECT pg_temp.login_anon();
SELECT set_config('t.q_bank_min', public.quote_order(pg_temp.its(pg_temp.it('Q-MOUSE', 1)))::text, false);
SELECT set_config('t.o_bank_min', pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, 'bank_transfer')::text, false);
SELECT set_config('t.v_bank_min', public.view_order(pg_temp.j('o_bank_min') ->> 'order_id', (pg_temp.j('o_bank_min') ->> 'view_token')::uuid)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('q_bank_min') ->> 'bank_transfer_available', pg_temp.j('o_bank_min') ->> 'payment_status'),
                  'true|awaiting_transfer', 'bank transfer without a branch or note: offered and accepted');
SELECT pg_temp.eq(pg_temp.j('v_bank_min') -> 'bank_transfer',
                  '{"branch": null, "bank_name": "QA Bank", "account_name": "QA Traders (Pvt) Ltd", "instructions": null, "account_number": "0001 2345 6789"}'::jsonb,
                  'view_order: the optional branch and note come back as null');
UPDATE public.store_settings SET bank_branch = 'Colombo 03', bank_transfer_instructions = 'Send the slip to qa@shop.test.';
UPDATE public.store_settings SET bank_transfer_enabled = FALSE;
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, 'bank_transfer')$$, 'P0001',
                      'bank transfer refused while switched off', 'unsupported_payment_method');
SELECT pg_temp.logout();
UPDATE public.store_settings SET bank_transfer_enabled = TRUE, cod_max_total = 20000;
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-DOCK', 1), pg_temp.it('Q-MOUSE', 1)))$$, 'P0001',
                      'COD above the owner''s cap is refused with the cap', 'cod_limit_exceeded:20000.00');
SELECT set_config('t.o_cap', pg_temp.po(pg_temp.its(pg_temp.it('Q-DOCK', 1), pg_temp.it('Q-MOUSE', 1)), NULL, 'bank_transfer')::text, false);
SELECT pg_temp.logout();
UPDATE public.store_settings SET cod_max_total = NULL;
SELECT pg_temp.eq(pg_temp.j('o_cap') ->> 'total', '20001.00', 'the COD cap does not apply to bank transfer');

-- ═════════════════════════════════════════════════════════════════════════════
-- F. Stock
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-DRIVE', 1)))$$, 'P0001',
                      'sold out: out_of_stock names a single-variant product', 'out_of_stock:Qa Drive');
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1), pg_temp.it('Q-LAP-32', 5)))$$, 'P0001',
                      'more than is left: out_of_stock names the product AND the variant', 'out_of_stock:Qa Laptop (32GB)');
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-LAP-32', 1), pg_temp.it('Q-LAP-32', 2)))$$, 'P0001',
                      'the same variant split over two lines is checked as one quantity', 'out_of_stock:Qa Laptop (32GB)');
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 6), pg_temp.it('Q-MOUSE', 5)))$$, 'P0001',
                      'split lines cannot beat the 10-per-variant cap', 'invalid_quantity');
SELECT set_config('t.o9', pg_temp.po(pg_temp.its(pg_temp.it('Q-LAST', 1)))::text, false);
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-LAST', 1)))$$, 'P0001',
                      'the last unit sells once', 'out_of_stock:Qa Last');
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.stock('Q-LAP-32') || '/' || pg_temp.stock('Q-LAST') || '/' || pg_temp.stock('Q-LAP-16'), '2/0/14',
                  'refusals roll back every decrement (only successful orders took stock)');
SELECT pg_temp.eq((SELECT count(*) FROM public.order_items WHERE sku IN ('Q-DOCK', 'Q-MOUSE', 'Q-PAD')) > 0
                  AND (SELECT count(*) FROM public.inventory WHERE variant_id IN (pg_temp.vid('Q-DOCK'), pg_temp.vid('Q-MOUSE'), pg_temp.vid('Q-PAD'))) = 0,
                  TRUE, 'untracked variants (no inventory row) always sell');

-- ═════════════════════════════════════════════════════════════════════════════
-- G. Discount redemption: counted once, here only
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT set_config('t.o10', pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), 'once')::text, false);
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-CABLE-1M', 1)), 'ONCE')$$, 'P0001',
                      'a used-up code is refused', 'discount_exhausted');
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), 'BIG1000')$$, 'P0001',
                      'minimum not met carries the minimum', 'discount_minimum_not_met:20000.00');
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), 'EXPIRED')$$, 'P0001', 'an expired code is invalid', 'invalid_discount_code');
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), 'SOON')$$, 'P0001', 'a code that has not started is invalid', 'invalid_discount_code');
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), 'OFFCODE')$$, 'P0001', 'an inactive code is invalid', 'invalid_discount_code');
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), 'NOPE')$$, 'P0001', 'an unknown code is invalid', 'invalid_discount_code');
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), 'bad code!')$$, 'P0001', 'a malformed code is invalid', 'invalid_discount_code');
SELECT set_config('t.o11', pg_temp.po(pg_temp.its(pg_temp.it('Q-DOCK', 1), pg_temp.it('Q-MOUSE', 1)), 'BIG1000')::text, false);
SELECT set_config('t.o12', pg_temp.po(pg_temp.its(pg_temp.it('Q-CABLE-1M', 1)), 'CHAT15')::text, false);
SELECT set_config('t.o_blank', pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)), '   ')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.uses('ONCE') || '/' || pg_temp.stock('Q-CABLE-1M'), '1/48',
                  'the refused ONCE order kept neither the discount use nor the cable (only the CHAT15 order took one: 49 → 48)');
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('o11') ->> 'discount_amount', pg_temp.j('o11') ->> 'shipping_fee', pg_temp.j('o11') ->> 'total'),
                  '1000.00|0.00|19001.00', 'a fixed-amount code');
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('o12') ->> 'discount_amount', pg_temp.j('o12') ->> 'total'), '150.00|1300.00',
                  'an assistant-only code is redeemable by whoever holds it (capped by its limit)');
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('o_blank') ->> 'discount_amount', COALESCE(pg_temp.j('o_blank') ->> 'discount_code', 'none')), '0.00|none',
                  'a blank code is no code');
SELECT pg_temp.eq(format('%s/%s/%s', pg_temp.uses('BIG1000'), pg_temp.uses('CHAT15'), pg_temp.uses('TEN10')), '1/1/2',
                  'each redemption counted exactly once');

-- ═════════════════════════════════════════════════════════════════════════════
-- H. Validation codes (every refusal is a machine code; nothing is written)
-- ═════════════════════════════════════════════════════════════════════════════
SELECT set_config('t.orders_before', (SELECT count(*) FROM public.orders)::text, false);
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.place_order('not-an-email', 'A', 'B', '0771234567', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)))$$,
                      'P0001', 'invalid_email', 'invalid_email');
SELECT pg_temp.throws($$SELECT public.place_order(repeat('a', 250) || '@shop.test', 'A', 'B', '0771234567', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)))$$,
                      'P0001', 'an over-long email is invalid', 'invalid_email');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', '  ', 'B', '0771234567', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)))$$,
                      'P0001', 'a first name is required (the courier asks for someone)', 'invalid_name');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', 'call me', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)))$$,
                      'P0001', 'letters are not a phone number', 'invalid_phone');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '12345', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)))$$,
                      'P0001', 'too short for a phone number', 'invalid_phone');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', NULL, pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)))$$,
                      'P0001', 'the phone is required', 'invalid_phone');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', '{}'::jsonb, pg_temp.its(pg_temp.it('Q-MOUSE', 1)))$$,
                      'P0001', 'delivery needs an address', 'invalid_shipping_address');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', '{"street":"1 Main St","city":"Kandy"}'::jsonb, pg_temp.its(pg_temp.it('Q-MOUSE', 1)))$$,
                      'P0001', 'delivery needs a district', 'invalid_shipping_address');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', '{"street":"1 Main St","city":"Kandy","district":"Kandyy"}'::jsonb, pg_temp.its(pg_temp.it('Q-MOUSE', 1)))$$,
                      'P0001', 'the district must be one of the 25', 'invalid_shipping_address');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', '{"street":"1 Main St","city":"Chennai","district":"Colombo","country":"India"}'::jsonb, pg_temp.its(pg_temp.it('Q-MOUSE', 1)))$$,
                      'P0001', 'delivery is within Sri Lanka only', 'invalid_shipping_address');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', '["1 Main St"]'::jsonb, pg_temp.its(pg_temp.it('Q-MOUSE', 1)))$$,
                      'P0001', 'the address must be an object', 'invalid_shipping_address');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', '{"street":{"x":1},"city":"Kandy","district":"Kandy"}'::jsonb, pg_temp.its(pg_temp.it('Q-MOUSE', 1)))$$,
                      'P0001', 'address fields must be text', 'invalid_shipping_address');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, NULL, 'LKR', 1, 'cod', 'drone')$$,
                      'P0001', 'an unknown fulfilment is refused', 'invalid_fulfillment');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, NULL, 'LKR', 1, 'cod', 'delivery', repeat('n', 1001))$$,
                      'P0001', 'a note over 1000 characters is refused', 'invalid_note');
SELECT pg_temp.throws($$SELECT pg_temp.po('{"not":"an array"}'::jsonb)$$, 'P0001', 'items must be an array', 'invalid_items');
SELECT pg_temp.throws($$SELECT pg_temp.po(NULL)$$, 'P0001', 'items are required', 'invalid_items');
SELECT pg_temp.throws($$SELECT pg_temp.po('[]'::jsonb)$$, 'P0001', 'at least one line', 'invalid_items');
SELECT pg_temp.throws($$SELECT pg_temp.po((SELECT jsonb_agg(pg_temp.it('Q-MOUSE', 1)) FROM generate_series(1, 51)))$$, 'P0001',
                      'at most 50 lines', 'invalid_items');
SELECT pg_temp.throws($$SELECT pg_temp.po('[1]'::jsonb)$$, 'P0001', 'a line must be an object', 'invalid_items');
SELECT pg_temp.throws($$SELECT pg_temp.po(jsonb_build_array(jsonb_build_object('product_id', pg_temp.pid('Q-MOUSE'), 'quantity', 1)))$$, 'P0001',
                      'every line names its variant (model B)', 'invalid_items');
SELECT pg_temp.throws($$SELECT pg_temp.po('[{"product_id":"abc","variant_id":1,"quantity":1}]'::jsonb)$$, 'P0001',
                      'ids must be integers', 'invalid_items');
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 0)))$$, 'P0001', 'quantity 0', 'invalid_quantity');
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 11)))$$, 'P0001', 'quantity above MAX_QTY (10)', 'invalid_quantity');
SELECT pg_temp.throws($$SELECT pg_temp.po(jsonb_build_array(jsonb_build_object('product_id', pg_temp.pid('Q-MOUSE'), 'variant_id', pg_temp.vid('Q-MOUSE'), 'quantity', 1.5)))$$,
                      'P0001', 'fractional quantity', 'invalid_quantity');
SELECT pg_temp.throws($$SELECT pg_temp.po(jsonb_build_array(jsonb_build_object('product_id', pg_temp.pid('Q-HIDDEN'), 'variant_id', pg_temp.vid('Q-HIDDEN'), 'quantity', 1)))$$,
                      'P0001', 'an inactive product is unknown to shoppers', 'unknown_product:' || pg_temp.pid('Q-HIDDEN'));
SELECT pg_temp.throws($$SELECT pg_temp.po('[{"product_id":999999,"variant_id":1,"quantity":1}]'::jsonb)$$, 'P0001',
                      'a product that does not exist', 'unknown_product:999999');
SELECT pg_temp.throws($$SELECT pg_temp.po(jsonb_build_array(jsonb_build_object('product_id', pg_temp.pid('Q-CABLE-2M'), 'variant_id', pg_temp.vid('Q-CABLE-2M'), 'quantity', 1)))$$,
                      'P0001', 'an inactive variant', 'invalid_variant:Qa Cable');
SELECT pg_temp.throws($$SELECT pg_temp.po(jsonb_build_array(jsonb_build_object('product_id', pg_temp.pid('Q-MOUSE'), 'variant_id', pg_temp.vid('Q-LAP-16'), 'quantity', 1)))$$,
                      'P0001', 'a variant of ANOTHER product (the price cannot be borrowed)', 'invalid_variant:Qa Mouse');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, NULL, 'XYZ', 1)$$,
                      'P0001', 'an unsupported display currency', 'invalid_currency');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, NULL, NULL, 1)$$,
                      'P0001', 'a NULL currency', 'invalid_currency');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, NULL, 'USD', 0)$$,
                      'P0001', 'a zero exchange rate', 'invalid_exchange_rate');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, NULL, 'USD', 'NaN')$$,
                      'P0001', 'a NaN exchange rate', 'invalid_exchange_rate');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, NULL, 'USD', 1001)$$,
                      'P0001', 'an absurd exchange rate', 'invalid_exchange_rate');
SELECT pg_temp.throws($$SELECT public.place_order('a@b.lk', 'A', 'B', '0771234567', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL, NULL, 'LKR', 2)$$,
                      'P0001', 'LKR is always rate 1', 'invalid_exchange_rate');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.orders)::text, current_setting('t.orders_before'), 'no refused call wrote an order');
BEGIN;
DELETE FROM public.store_settings;
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT pg_temp.po(pg_temp.its(pg_temp.it('Q-MOUSE', 1)))$$, 'P0001',
                      'no settings row → fail closed', 'store_unavailable');
SELECT pg_temp.logout();
ROLLBACK;

-- Accepted variants of the inputs.
SELECT pg_temp.login_anon();
SELECT set_config('t.o13', public.place_order('intl@shop.test', 'Ivy', NULL, '+44 20 7946 0958', pg_temp.addr(),
                                              pg_temp.its(pg_temp.it('Q-MOUSE', 1)))::text, false);
SELECT set_config('t.o14', public.place_order('usd@shop.test', 'Uma', 'U', '0094 (77) 123-4567',
                                              '{"street":" 5 Temple Rd ","city":"Kandy","district":"kandy","postal_code":20000,"country":"sri lanka","extra":"dropped"}'::jsonb,
                                              ('[{"product_id":"' || pg_temp.pid('Q-MOUSE') || '","variant_id":"' || pg_temp.vid('Q-MOUSE') || '","quantity":"2"}]')::jsonb,
                                              NULL, NULL, 'usd', 0.003024, 'COD', 'DELIVERY', '  Call before 5pm  ')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.j('o13') ->> 'phone', '+442079460958', 'an international (+44) number is accepted in E.164');
SELECT pg_temp.eq(format('%s|%s|%s|%s|%s|%s', pg_temp.j('o14') ->> 'phone', pg_temp.j('o14') -> 'shipping_address', pg_temp.j('o14') ->> 'currency',
                         pg_temp.j('o14') ->> 'exchange_rate', pg_temp.j('o14') ->> 'customer_note', pg_temp.j('o14') ->> 'subtotal'),
                  '+94771234567|{"city": "Kandy", "street": "5 Temple Rd", "country": "Sri Lanka", "district": "Kandy", "postal_code": "20000"}|USD|0.003024|Call before 5pm|10000.00',
                  'numeric strings, 0094 phones, lower-case district/country/method/fulfilment and display currency are normalised; unknown keys dropped');
SELECT pg_temp.eq((SELECT format('%s|%s', currency, exchange_rate) FROM public.orders WHERE id = pg_temp.j('o14') ->> 'order_id'),
                  'USD|0.003024', 'the display currency and rate are recorded (the charge stays LKR)');

-- The phone rule, case by case. `lk` = what normalizeLkPhone() in src/lib/sri-lanka.ts returns
-- for the same input (captured by running that function under Node): every number it accepts
-- must be stored as the SAME E.164 string; `db` differs only where it returns null and the
-- input is an international "+"/"00" number.
SELECT pg_temp.eq((SELECT string_agg(format('%s → %s (want %s)', t.input, COALESCE(public._normalize_phone(t.input), 'NULL'),
                                            COALESCE(COALESCE(t.intl, t.lk), 'NULL')), '; ')
                     FROM (VALUES ('077 123 4567',      '+94771234567', NULL),
                                  ('0771234567',        '+94771234567', NULL),
                                  ('+94 77 123 4567',   '+94771234567', NULL),
                                  ('0094771234567',     '+94771234567', NULL),
                                  ('94771234567',       '+94771234567', NULL),
                                  ('771234567',         '+94771234567', NULL),
                                  ('011 234 5678',      '+94112345678', NULL),
                                  ('+94 077 123 4567',  '+94771234567', NULL),
                                  ('0094 077 123 4567', '+94771234567', NULL),
                                  ('00771234567',       '+94771234567', NULL),   -- NOT "+771234567"
                                  ('(077) 123-4567',    '+94771234567', NULL),
                                  ('077.123.4567',      '+94771234567', NULL),
                                  ('  +94771234567  ',  '+94771234567', NULL),
                                  ('+44 20 7946 0958',  NULL,           '+442079460958'),
                                  ('0044 20 7946 0958', NULL,           '+442079460958'),
                                  ('+1 (415) 555-2671', NULL,           '+14155552671'),
                                  ('+94 12 34',         NULL,           NULL),
                                  ('+9477123456789',    NULL,           NULL),   -- a bad +94 number is not "international"
                                  ('+0771234567',       NULL,           NULL),
                                  ('1 415 555 2671',    NULL,           NULL),   -- international needs "+" or "00"
                                  ('077 1234 5678',     NULL,           NULL),
                                  ('12345',             NULL,           NULL),
                                  ('call me',           NULL,           NULL),
                                  ('',                  NULL,           NULL)) AS t(input, lk, intl)
                    WHERE public._normalize_phone(t.input) IS DISTINCT FROM COALESCE(t.intl, t.lk)), NULL::text,
                  'phones: Sri Lankan numbers normalise exactly as normalizeLkPhone(); only "+"/"00" non-94 numbers are added');

-- ═════════════════════════════════════════════════════════════════════════════
-- I. A signed-in buyer: the order belongs to the account and rolls up lifetime value
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT set_config('t.o15', pg_temp.po(pg_temp.its(pg_temp.it('Q-LAP-16', 1)), NULL, 'cod', 'delivery', 'shopper@shop.test')::text, false);
SELECT set_config('t.o16', pg_temp.po(pg_temp.its(pg_temp.it('Q-LAP-16', 2), pg_temp.it('Q-MOUSE', 1)), 'TEN10', 'cod', 'delivery', 'shopper@shop.test')::text, false);
SELECT pg_temp.eq((SELECT string_agg(id, ',' ORDER BY id) FROM public.orders),
                  (pg_temp.j('o15') ->> 'order_id') || ',' || (pg_temp.j('o16') ->> 'order_id'),
                  'the shopper sees exactly their own orders (RLS)');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT customer_id FROM public.orders WHERE id = pg_temp.j('o15') ->> 'order_id'), current_setting('t.shopper')::uuid,
                  'a signed-in order carries the account id');
SELECT pg_temp.eq((SELECT total_spent::text || '/' || orders_count FROM public.customers WHERE id = current_setting('t.shopper')::uuid),
                  '25950.00/2', 'customer rollup: 7,950 + 18,000 over 2 orders');
SELECT pg_temp.eq(pg_temp.stock('Q-LAP-16') || '/' || pg_temp.uses('TEN10'), '11/3', 'stock and discount after the signed-in orders');

-- ═════════════════════════════════════════════════════════════════════════════
-- K. validate_discount — advisory, read-only
-- ═════════════════════════════════════════════════════════════════════════════
SELECT set_config('t.uses_before', (SELECT sum(usage_count) FROM public.discounts)::text, false);
SELECT pg_temp.login_anon();
SELECT set_config('t.vd', jsonb_build_object(
         'nope',    public.validate_discount('nope', 100),
         'blank',   public.validate_discount('', 100),
         'null',    public.validate_discount(NULL, NULL),
         'expired', public.validate_discount('expired', 100),
         'soon',    public.validate_discount('SOON', 100),
         'off',     public.validate_discount('OFFCODE', 100),
         'once',    public.validate_discount('ONCE', 100),
         'min',     public.validate_discount('BIG1000', 19999),
         'big',     public.validate_discount('big1000', 25000),
         'ten',     public.validate_discount(' ten10 ', 12345),
         'nan',     public.validate_discount('TEN10', 'NaN'),
         'neg',     public.validate_discount('TEN10', -50))::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(k || '=' || COALESCE(v ->> 'reason', 'ok') || ':' || (v ->> 'discount_amount'), ' ' ORDER BY k)
                     FROM jsonb_each(pg_temp.j('vd')) AS e(k, v)),
                  'big=exhausted:0 blank=invalid:0 expired=expired:0 min=exhausted:0 nan=ok:100000000.00 neg=ok:0.00 nope=invalid:0 null=invalid:0 off=invalid:0 once=exhausted:0 soon=invalid:0 ten=ok:1235.00',
                  'validate_discount reasons: invalid (unknown/blank/inactive/not started), expired, exhausted; amounts in whole rupees; hostile subtotals clamp');
SELECT pg_temp.eq(pg_temp.j('vd') -> 'ten', '{"valid":true,"discount_amount":1235.00,"reason":null,"minimum":null}'::jsonb,
                  'validate_discount shape: {valid, discount_amount, reason, minimum}');
SELECT pg_temp.eq((SELECT sum(usage_count) FROM public.discounts)::text, current_setting('t.uses_before'), 'validate_discount never counts a use');
UPDATE public.discounts SET usage_count = 0 WHERE code = 'BIG1000';
SELECT pg_temp.login_anon();
SELECT set_config('t.vd_min', public.validate_discount('BIG1000', 19999)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.j('vd_min'), '{"valid":false,"discount_amount":0,"reason":"minimum_not_met","minimum":20000.00}'::jsonb,
                  'minimum_not_met is the one refusal that carries a figure');

-- ═════════════════════════════════════════════════════════════════════════════
-- L. track_guest_order — both must match; throttled inside the database
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT set_config('t.t1', COALESCE(public.track_guest_order('do-10002', 'GUEST@shop.test')::text, ''), false);
SELECT set_config('t.t2', COALESCE(public.track_guest_order('#10002', 'guest@shop.test ')::text, ''), false);
SELECT set_config('t.t3', COALESCE(public.track_guest_order('DO-10002', 'x1@else.test')::text, ''), false);
SELECT set_config('t.t4', COALESCE(public.track_guest_order('DO-10002', 'x2@else.test')::text, ''), false);
SELECT set_config('t.t5', COALESCE(public.track_guest_order('DO-10002', 'x3@else.test')::text, ''), false);
SELECT set_config('t.t6', COALESCE(public.track_guest_order('DO-10002', 'guest@shop.test')::text, ''), false);
SELECT set_config('t.t_blank', COALESCE(public.track_guest_order('  ', 'guest@shop.test')::text, ''), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.j('t1') ->> 'order_id', 'DO-10002', 'tracking: number + email match (case-insensitive, "do-" accepted)');
SELECT pg_temp.eq(pg_temp.j('t2') ->> 'order_id', 'DO-10002', 'tracking: "#10002" is the same order');
SELECT pg_temp.ok(NOT (pg_temp.j('t1') ?| ARRAY['shipping_address', 'phone', 'email', 'view_token', 'customer_note', 'packing_charges', 'first_name']),
                  'tracking never returns the address, phone, email, token, note or internal costs');
SELECT pg_temp.eq(format('%s|%s|%s|%s', pg_temp.j('t1') ->> 'status', pg_temp.j('t1') ->> 'total_price', pg_temp.j('t1') ->> 'fulfillment',
                         pg_temp.j('t1') -> 'items' -> 0 ->> 'variant_name'),
                  'pending|15449.00|delivery|32GB', 'tracking: status, totals, fulfilment, items with variant names');
SELECT pg_temp.eq(jsonb_array_length(pg_temp.j('t1') -> 'timeline'), 1, 'tracking: the timeline');
SELECT pg_temp.eq(current_setting('t.t3') || current_setting('t.t4') || current_setting('t.t5'), '', 'tracking: a wrong email returns NULL');
SELECT pg_temp.eq(current_setting('t.t6'), '{"throttled": true}', 'tracking: after misses (each costing double) even the right email is throttled');
SELECT pg_temp.eq(current_setting('t.t_blank'), '', 'tracking: a blank number returns NULL');
SELECT pg_temp.eq((SELECT count(*) FROM public.rate_limit_hits WHERE bucket LIKE 'track:%' AND bucket NOT LIKE 'track:%DO-10002%'
                                                                   AND bucket NOT LIKE 'track:mail:%'), 0::bigint,
                  'a blank lookup charges no bucket');
-- the per-email bucket: this address has 3 hits; 3 misses on other numbers (up to 2 hits each) fill it
SELECT pg_temp.login_anon();
SELECT public.track_guest_order('DO-90001', 'guest@shop.test');
SELECT public.track_guest_order('DO-90002', 'guest@shop.test');
SELECT public.track_guest_order('DO-90003', 'guest@shop.test');
SELECT set_config('t.t7', COALESCE(public.track_guest_order('DO-10001', 'guest@shop.test')::text, ''), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.t7'), '{"throttled": true}', 'tracking: the email bucket throttles lookups across order numbers');

-- ═════════════════════════════════════════════════════════════════════════════
-- M. view_order — the view token is the credential
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT set_config('t.v1', COALESCE(public.view_order('DO-10001', (pg_temp.j('o1') ->> 'view_token')::uuid)::text, ''), false);
SELECT set_config('t.v7', COALESCE(public.view_order(pg_temp.j('o7') ->> 'order_id', (pg_temp.j('o7') ->> 'view_token')::uuid)::text, ''), false);
SELECT set_config('t.v8', COALESCE(public.view_order(pg_temp.j('o8') ->> 'order_id', (pg_temp.j('o8') ->> 'view_token')::uuid)::text, ''), false);
SELECT set_config('t.v_null', COALESCE(public.view_order('DO-10001', NULL)::text, ''), false);
SELECT set_config('t.v_wrong', COALESCE(public.view_order('DO-10001', gen_random_uuid())::text, ''), false);
SELECT set_config('t.v_other', COALESCE(public.view_order('DO-10002', (pg_temp.j('o1') ->> 'view_token')::uuid)::text, ''), false);
SELECT set_config('t.v_many', (SELECT count(*) FROM generate_series(1, 12) g
                                WHERE public.view_order(pg_temp.j('o3') ->> 'order_id', (pg_temp.j('o3') ->> 'view_token')::uuid) ? 'order_id')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s|%s|%s|%s', pg_temp.j('v1') ->> 'order_id', pg_temp.j('v1') ->> 'first_name', pg_temp.j('v1') -> 'shipping',
                         COALESCE(pg_temp.j('v1') ->> 'bank_transfer', 'none'), COALESCE(pg_temp.j('v1') ->> 'pickup', 'none')),
                  'DO-10001|Gia|{"city": "Colombo 03", "district": "Colombo"}|none|none',
                  'view_order: the confirmation with first name and city/district only');
SELECT pg_temp.ok(position('Galle Road' IN current_setting('t.v1')) = 0 AND position('+9477' IN current_setting('t.v1')) = 0
                  AND position('guest@shop.test' IN current_setting('t.v1')) = 0,
                  'view_order never reveals the street, phone or email');
SELECT pg_temp.eq(jsonb_array_length(pg_temp.j('v1') -> 'items') || '/' || (pg_temp.j('v1') ->> 'total_price'), '2/18000.00', 'view_order: items and totals');
SELECT pg_temp.eq(pg_temp.j('v7') -> 'pickup', '{"note": "Bring your order number.", "address": "12 Showroom Lane, Colombo 03"}'::jsonb,
                  'view_order: a pickup order shows the showroom address, no delivery address');
SELECT pg_temp.eq(pg_temp.j('v8') -> 'bank_transfer',
                  '{"branch": "Colombo 03", "bank_name": "QA Bank", "account_name": "QA Traders (Pvt) Ltd", "instructions": "Send the slip to qa@shop.test.", "account_number": "0001 2345 6789"}'::jsonb,
                  'view_order: the bank account to pay into while the transfer is awaited');
SELECT pg_temp.ok(NOT (pg_temp.j('v8') ? 'bank_transfer_instructions'), 'view_order: the old flat instructions key is gone');
SELECT pg_temp.eq(current_setting('t.v_null') || current_setting('t.v_wrong') || current_setting('t.v_other'), '',
                  'view_order: NULL, wrong or another order''s token → NULL');
SELECT pg_temp.eq(current_setting('t.v_many'), '12', 'view_order: the right token can be used again and again');
SELECT pg_temp.eq((SELECT count(*) FROM public.rate_limit_hits WHERE bucket = 'view:ref:' || (pg_temp.j('o3') ->> 'order_id')), 0::bigint,
                  'view_order: a right token costs nothing');
-- Throttle: each wrong token costs 2 of 8 per 15 min for that order number. Separate statements
-- (each call must see the previous call's hits).
SELECT pg_temp.login_anon();
SELECT set_config('t.v_miss1', COALESCE(public.view_order('DO-10004', gen_random_uuid())::text, ''), false);
SELECT public.view_order('DO-10004', gen_random_uuid());
SELECT public.view_order('DO-10004', gen_random_uuid());
SELECT public.view_order('DO-10004', gen_random_uuid());
SELECT set_config('t.v_thr', COALESCE(public.view_order('DO-10004', gen_random_uuid())::text, ''), false);
SELECT set_config('t.v_after', COALESCE(public.view_order('DO-10004', (pg_temp.j('o4') ->> 'view_token')::uuid) ->> 'order_id', ''), false);
SELECT set_config('t.v_other_ref', COALESCE(public.view_order('DO-10003', gen_random_uuid())::text, ''), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.v_miss1'), '', 'view_order: a wrong token is NULL while the order''s bucket has room');
SELECT pg_temp.eq(current_setting('t.v_thr'), '{"throttled": true}',
                  'view_order: after 4 wrong tokens (a miss costs double) further wrong tokens for that order answer throttled');
SELECT pg_temp.eq(current_setting('t.v_after'), 'DO-10004',
                  'view_order: the RIGHT token still opens the page — junk guesses on a sequential number cannot lock the shopper out');
SELECT pg_temp.eq((SELECT count(*) FROM public.rate_limit_hits WHERE bucket = 'view:ref:DO-10004'), 8::bigint,
                  'view_order: the bucket stops at its cap (throttled misses are not recorded)');
SELECT pg_temp.eq(current_setting('t.v_other_ref'), '', 'view_order: the throttle is per order number (another order is unaffected)');

-- ═════════════════════════════════════════════════════════════════════════════
-- N. admin_set_order_status — the only path that changes a status
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.admin_set_order_status('DO-10001', 'accepted')$$, '42501', 'anon cannot call the admin RPC');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_set_order_status('DO-10001', 'cancelled')$$, '42501', 'a shopper is refused inside the function (42501)');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.orders SET status = 'delivered' WHERE id = 'DO-10001'$$), 0::bigint,
                  'a shopper cannot update orders at all (no UPDATE policy: 0 rows)');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_set_order_status('DO-10001', 'shipped')$$, '22023', 'a non-assignable status', 'invalid_status:%');
SELECT pg_temp.throws($$SELECT public.admin_set_order_status('DO-99999', 'accepted')$$, '22023', 'an unknown order', 'order_not_found:%');
SELECT pg_temp.throws($$SELECT public.admin_set_order_status('DO-10001', 'out_for_delivery')$$, '22023',
                      'out_for_delivery without tracking on a delivery order', 'tracking_required:%');
SELECT pg_temp.throws($$SELECT public.admin_set_order_status('DO-10001', 'accepted', NULL, 'http://track.example/1')$$, '22023',
                      'tracking links must be https', 'invalid_tracking_url:%');
SELECT pg_temp.throws($$SELECT public.admin_set_order_status('DO-10001', 'fulfilled', NULL, NULL, -1)$$, '22023',
                      'negative packing charges', 'invalid_packing_charges:%');
SELECT pg_temp.throws($$SELECT public.admin_set_order_status('DO-10001', 'accepted', NULL, NULL, NULL, repeat('x', 501))$$, '22023',
                      'an over-long note', 'invalid_note:%');
SELECT pg_temp.throws($$UPDATE public.orders SET status = 'delivered' WHERE id = 'DO-10001'$$, '22023',
                      'even an admin cannot write a status directly (no timeline, no reversal)', 'order_field_managed:status%');
SELECT pg_temp.throws($$UPDATE public.orders SET total_price = 1 WHERE id = 'DO-10001'$$, '22023',
                      'an admin cannot rewrite money', 'order_field_managed:total_price%');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.orders SET phone = '+94770000000', shipping_address = shipping_address || '{"street":"14 Galle Road"}' WHERE id = 'DO-10001'$$),
                  1::bigint, 'an admin may correct contact details directly');
SELECT set_config('t.s1', public.admin_set_order_status('DO-10001', 'accepted')::text, false);
SELECT set_config('t.s2', public.admin_set_order_status('do-10001', ' ACCEPTED ')::text, false);
SELECT set_config('t.s3', public.admin_set_order_status('DO-10001', 'accepted', NULL, NULL, NULL, 'Waiting for the courier slot.')::text, false);
SELECT set_config('t.s4', public.admin_set_order_status('DO-10001', 'fulfilled', NULL, NULL, 250)::text, false);
SELECT set_config('t.s5', public.admin_set_order_status('DO-10001', 'out_for_delivery', 'TRK-123', 'https://track.example/TRK-123')::text, false);
SELECT set_config('t.s6', public.admin_set_order_status('DO-10001', 'delivered')::text, false);
SELECT set_config('t.p1', public.admin_set_order_status(pg_temp.j('o7') ->> 'order_id', 'out_for_delivery')::text, false);
SELECT set_config('t.p2', public.admin_set_order_status(pg_temp.j('o7') ->> 'order_id', 'delivered')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s|%s|%s', pg_temp.j('s1') ->> 'status', pg_temp.j('s1') ->> 'previous_status', pg_temp.j('s1') ->> 'changed',
                         pg_temp.j('s1') ->> 'timeline_label'), 'accepted|pending|true|Accepted', 'pending → accepted');
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('s2') ->> 'changed', COALESCE(pg_temp.j('s2') ->> 'timeline_label', 'none')), 'false|none',
                  'the same status with nothing new is a no-op');
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('s3') ->> 'changed', pg_temp.j('s3') ->> 'timeline_label'), 'true|Update',
                  'a note on the same status adds an Update row');
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('s4') ->> 'timeline_label', pg_temp.j('s4') ->> 'packing_charges'), 'Packed|250.00',
                  'fulfilled records packing charges');
SELECT pg_temp.eq(format('%s|%s|%s|%s|%s|%s|%s', pg_temp.j('s5') ->> 'timeline_label', pg_temp.j('s5') ->> 'tracking_number',
                         pg_temp.j('s5') ->> 'tracking_url', pg_temp.j('s5') ->> 'email', pg_temp.j('s5') ->> 'first_name',
                         pg_temp.j('s5') ->> 'payment_method', pg_temp.j('s5') ->> 'amount_due'),
                  'Out for delivery|TRK-123|https://track.example/TRK-123|guest@shop.test|Gia|cod|18000.00',
                  'out for delivery: tracking saved; the summary carries what the email needs (COD amount due)');
SELECT pg_temp.eq(pg_temp.j('s6') ->> 'timeline_label', 'Delivered', 'delivered');
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('p1') ->> 'timeline_label', pg_temp.j('p2') ->> 'timeline_label'), 'Ready for pickup|Collected',
                  'pickup orders: no tracking needed, pickup-aware labels');
SELECT pg_temp.eq((SELECT string_agg(status || COALESCE(' — ' || description, ''), ' | ' ORDER BY created_at, id)
                     FROM public.order_tracking WHERE order_id = 'DO-10001'),
                  'Order placed — We have received your order. | Accepted | Update — Waiting for the courier slot. | Packed | Out for delivery — Tracking reference TRK-123. | Delivered',
                  'the shopper''s timeline reads like a story');

-- Cancellation reverses stock, lifetime value and the discount use — atomically.
SELECT set_config('t.c_before', format('%s/%s/%s', pg_temp.stock('Q-LAP-16'), pg_temp.uses('TEN10'),
                                       (SELECT total_spent::text || ':' || orders_count FROM public.customers WHERE id = current_setting('t.shopper')::uuid)), false);
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.c1', public.admin_set_order_status(pg_temp.j('o16') ->> 'order_id', 'cancelled', NULL, NULL, NULL, 'Cancelled at the customer''s request.')::text, false);
SELECT set_config('t.c2', public.admin_set_order_status(pg_temp.j('o16') ->> 'order_id', 'cancelled')::text, false);
SELECT pg_temp.throws(format('SELECT public.admin_set_order_status(%L, %L)', pg_temp.j('o16') ->> 'order_id', 'pending'), '22023',
                      'a cancelled order cannot be reopened', 'invalid_transition:%');
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.c_before'), '11/3/25950.00:2', 'before the cancellation');
SELECT pg_temp.eq(format('%s/%s/%s', pg_temp.stock('Q-LAP-16'), pg_temp.uses('TEN10'),
                         (SELECT total_spent::text || ':' || orders_count FROM public.customers WHERE id = current_setting('t.shopper')::uuid)),
                  '13/2/7950.00:1', 'cancel: tracked stock restocked, discount use returned, lifetime value reversed');
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('c1') ->> 'timeline_label', pg_temp.j('c2') ->> 'changed', pg_temp.stock('Q-LAP-16')),
                  'Cancelled|false|13', 'cancelling twice reverses nothing twice');
SELECT pg_temp.eq((SELECT description FROM public.order_tracking WHERE order_id = pg_temp.j('o16') ->> 'order_id' ORDER BY id DESC LIMIT 1),
                  'Cancelled at the customer''s request.', 'the cancellation note is on the timeline');
SELECT pg_temp.eq((SELECT payment_status FROM public.orders WHERE id = pg_temp.j('o16') ->> 'order_id'), 'pending_collection',
                  'cancelling does not touch the payment status (void or refund it explicitly)');

-- ═════════════════════════════════════════════════════════════════════════════
-- O. admin_set_payment_status
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_set_payment_status('DO-10001', 'paid')$$, '42501', 'a shopper cannot mark an order paid');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_set_payment_status('DO-10001', 'awaiting_transfer')$$, '22023',
                      'initial payment states cannot be assigned', 'invalid_payment_status:%');
SELECT pg_temp.throws($$SELECT public.admin_set_payment_status('DO-10001', 'refunded')$$, '22023',
                      'unpaid → refunded is refused', 'invalid_payment_transition:%');
SELECT pg_temp.throws($$SELECT public.admin_set_payment_status('DO-10001', 'void')$$, '22023',
                      'void only on a cancelled order', 'invalid_payment_transition:%cancel the order first%');
SELECT set_config('t.pay1', public.admin_set_payment_status('DO-10001', 'paid', 'CASH-001')::text, false);
SELECT set_config('t.pay2', public.admin_set_payment_status('DO-10001', 'paid')::text, false);
SELECT set_config('t.pay3', public.admin_set_payment_status('DO-10001', 'paid', 'CASH-002')::text, false);
SELECT set_config('t.pay4', public.admin_set_payment_status('DO-10001', 'refunded')::text, false);
SELECT pg_temp.throws($$SELECT public.admin_set_payment_status('DO-10001', 'paid')$$, '22023',
                      'refunded → paid is refused', 'invalid_payment_transition:%');
SELECT set_config('t.pay5', public.admin_set_payment_status(pg_temp.j('o16') ->> 'order_id', 'void')::text, false);
SELECT set_config('t.pay6', public.admin_set_payment_status(pg_temp.j('o8') ->> 'order_id', 'paid', 'BANK-REF-77')::text, false);
SELECT pg_temp.login_anon();
SELECT set_config('t.v8b', public.view_order(pg_temp.j('o8') ->> 'order_id', (pg_temp.j('o8') ->> 'view_token')::uuid)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s|%s|%s|%s', pg_temp.j('pay1') ->> 'payment_status', pg_temp.j('pay1') ->> 'previous_payment_status',
                         pg_temp.j('pay1') ->> 'payment_ref', pg_temp.j('pay1') ->> 'timeline_label', pg_temp.j('pay1') ->> 'email'),
                  'paid|pending_collection|CASH-001|Payment received|guest@shop.test', 'COD collected → paid (with a reference)');
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('pay2') ->> 'changed', pg_temp.j('pay3') ->> 'changed'), 'false|true',
                  'the same status: nothing new is a no-op; a new reference is saved');
SELECT pg_temp.eq(pg_temp.j('pay4') ->> 'timeline_label', 'Payment refunded', 'paid → refunded');
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('pay5') ->> 'payment_status', pg_temp.j('pay5') ->> 'timeline_label'), 'void|No payment due',
                  'a cancelled order''s unpaid payment can be voided');
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('pay6') ->> 'previous_payment_status', pg_temp.j('pay6') ->> 'payment_status'), 'awaiting_transfer|paid',
                  'a bank transfer received → paid');
SELECT pg_temp.eq(COALESCE(pg_temp.j('v8b') ->> 'bank_transfer', 'none'), 'none',
                  'once paid, the confirmation page stops showing the bank account');
SELECT pg_temp.eq((SELECT count(*) FROM public.order_tracking WHERE order_id = 'DO-10001' AND status LIKE 'Payment%'), 2::bigint,
                  'payment changes are on the timeline (reference-only edits are not)');

-- ═════════════════════════════════════════════════════════════════════════════
-- J. The checkout autosave row is converted — same shopper only (stand-in table)
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT set_config('t.o_nocart', (public.place_order('nocart@shop.test', 'Nia', NULL, '0771234567', pg_temp.addr(),
                                                     pg_temp.its(pg_temp.it('Q-MOUSE', 1)), NULL,
                                                     '33333333-3333-3333-3333-333333333333') ? 'order_id')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.ok(current_setting('t.o_nocart')::boolean,
                  'an unknown cart id never fails the order (with or without 13_abandoned_carts)');
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.abandoned_carts') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.abandoned_carts RENAME TO abandoned_carts_hidden_by_test';
  END IF;
END $$;
CREATE TABLE public.abandoned_carts (id uuid PRIMARY KEY, email text NOT NULL, converted boolean NOT NULL DEFAULT false,
                                     converted_order_id text, updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.abandoned_carts (id, email) VALUES ('11111111-1111-1111-1111-111111111111', 'cart@shop.test'),
                                                       ('22222222-2222-2222-2222-222222222222', 'someone@else.test');
SELECT pg_temp.login_anon();
SELECT set_config('t.o_cart1', public.place_order('Cart@Shop.test', 'Cy', NULL, '0771234567', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)),
                                                  NULL, '11111111-1111-1111-1111-111111111111')::text, false);
SELECT set_config('t.o_cart2', public.place_order('cart@shop.test', 'Cy', NULL, '0771234567', pg_temp.addr(), pg_temp.its(pg_temp.it('Q-MOUSE', 1)),
                                                  NULL, '22222222-2222-2222-2222-222222222222')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT converted::text || ':' || COALESCE(converted_order_id, '-') FROM public.abandoned_carts WHERE id = '11111111-1111-1111-1111-111111111111'),
                  'true:' || (pg_temp.j('o_cart1') ->> 'order_id'), 'the shopper''s own autosave row is marked converted');
SELECT pg_temp.eq((SELECT converted::text FROM public.abandoned_carts WHERE id = '22222222-2222-2222-2222-222222222222'), 'false',
                  'someone else''s cart id cannot be converted (email must match)');
ROLLBACK;

-- ═════════════════════════════════════════════════════════════════════════════
-- Q. Concurrency over dblink: deadlock-safe lock order, and no oversell
-- ═════════════════════════════════════════════════════════════════════════════
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'SKIP: dblink is not available (%) — concurrency checks skipped', SQLERRM;
END $$;

-- Scenario 1. A third session L holds the stock row of X (the LATER variant in the global order).
-- Order A lists [X, Y]; order B lists [Y, X]. With sorted locking A takes Y and waits for X, B waits
-- for Y; when L commits both complete. With input-order locking A would wait on X holding nothing,
-- B would take Y then wait on X, and after L commits A (holding X) and B (holding Y) would deadlock.
DO $$
DECLARE
  v_conn  TEXT := format('host=127.0.0.1 port=%s dbname=%s user=postgres', current_setting('port'), current_database());
  v_sql   TEXT := $q$SELECT public.place_order(%L, 'Dee', 'Lock', '0771234567', '{"street":"1 Main St","city":"Kandy","district":"Kandy"}'::jsonb, %L::jsonb)::text$q$;
  v_pid_a INT;
  v_pid_b INT;
  v_err_a TEXT;
  v_err_b TEXT;
  i       INT;
BEGIN
  IF to_regprocedure('extensions.dblink_connect(text,text)') IS NULL THEN
    RETURN;
  END IF;
  PERFORM extensions.dblink_connect('qa_l', v_conn);
  PERFORM extensions.dblink_connect('qa_a', v_conn);
  PERFORM extensions.dblink_connect('qa_b', v_conn);
  SELECT pid INTO v_pid_a FROM extensions.dblink('qa_a', 'SELECT pg_backend_pid()') AS t(pid int);
  SELECT pid INTO v_pid_b FROM extensions.dblink('qa_b', 'SELECT pg_backend_pid()') AS t(pid int);
  IF pg_temp.pid('Q-DL-Y') >= pg_temp.pid('Q-DL-X') THEN
    RAISE EXCEPTION 'FAIL: fixture — Q-DL-Y must sort before Q-DL-X';
  END IF;

  PERFORM extensions.dblink_exec('qa_l', 'BEGIN');
  PERFORM * FROM extensions.dblink('qa_l', format('SELECT stock_level FROM public.inventory WHERE variant_id = %s FOR UPDATE',
                                                  pg_temp.vid('Q-DL-X'))) AS t(s int);

  PERFORM extensions.dblink_send_query('qa_a', format(v_sql, 'dl-a@shop.test', pg_temp.its(pg_temp.it('Q-DL-X', 1), pg_temp.it('Q-DL-Y', 1))));
  FOR i IN 1..250 LOOP
    EXIT WHEN cardinality(pg_blocking_pids(v_pid_a)) > 0;
    PERFORM pg_sleep(0.02);
  END LOOP;
  IF cardinality(pg_blocking_pids(v_pid_a)) = 0 THEN
    RAISE EXCEPTION 'FAIL: concurrency setup — order A never waited for the held stock row';
  END IF;
  PERFORM extensions.dblink_send_query('qa_b', format(v_sql, 'dl-b@shop.test', pg_temp.its(pg_temp.it('Q-DL-Y', 1), pg_temp.it('Q-DL-X', 1))));
  FOR i IN 1..250 LOOP
    EXIT WHEN cardinality(pg_blocking_pids(v_pid_b)) > 0;
    PERFORM pg_sleep(0.02);
  END LOOP;
  IF cardinality(pg_blocking_pids(v_pid_b)) = 0 THEN
    RAISE EXCEPTION 'FAIL: concurrency setup — order B never waited';
  END IF;
  PERFORM extensions.dblink_exec('qa_l', 'COMMIT');

  PERFORM * FROM extensions.dblink_get_result('qa_a', false) AS t(r text);
  v_err_a := extensions.dblink_error_message('qa_a');
  PERFORM * FROM extensions.dblink_get_result('qa_a', false) AS t(r text);
  PERFORM * FROM extensions.dblink_get_result('qa_b', false) AS t(r text);
  v_err_b := extensions.dblink_error_message('qa_b');
  PERFORM * FROM extensions.dblink_get_result('qa_b', false) AS t(r text);
  PERFORM extensions.dblink_disconnect('qa_l');
  PERFORM extensions.dblink_disconnect('qa_a');
  PERFORM extensions.dblink_disconnect('qa_b');
  IF v_err_a <> 'OK' OR v_err_b <> 'OK' THEN
    RAISE EXCEPTION 'FAIL: crossed carts must both succeed — A: %, B: %', v_err_a, v_err_b;
  END IF;
  IF (SELECT count(*) FROM public.orders WHERE email IN ('dl-a@shop.test', 'dl-b@shop.test')) <> 2
     OR pg_temp.stock('Q-DL-X') <> 98 OR pg_temp.stock('Q-DL-Y') <> 98 THEN
    RAISE EXCEPTION 'FAIL: crossed carts — expected 2 orders and 98/98 stock, got %/%/%',
      (SELECT count(*) FROM public.orders WHERE email IN ('dl-a@shop.test', 'dl-b@shop.test')), pg_temp.stock('Q-DL-X'), pg_temp.stock('Q-DL-Y');
  END IF;
  RAISE NOTICE 'PASS: concurrency — crossed carts waiting on each other''s rows both complete (no deadlock)';
END $$;

-- Scenario 2. Two shoppers race for the last unit: the second waits for the first, then is refused.
DO $$
DECLARE
  v_conn  TEXT := format('host=127.0.0.1 port=%s dbname=%s user=postgres', current_setting('port'), current_database());
  v_sql   TEXT := $q$SELECT public.place_order(%L, 'Ray', 'Race', '0771234567', '{"street":"1 Main St","city":"Galle","district":"Galle"}'::jsonb, %L::jsonb)::text$q$;
  v_pid_b INT;
  v_err_b TEXT;
  i       INT;
BEGIN
  IF to_regprocedure('extensions.dblink_connect(text,text)') IS NULL THEN
    RETURN;
  END IF;
  PERFORM extensions.dblink_connect('qa_a', v_conn);
  PERFORM extensions.dblink_connect('qa_b', v_conn);
  SELECT pid INTO v_pid_b FROM extensions.dblink('qa_b', 'SELECT pg_backend_pid()') AS t(pid int);
  PERFORM extensions.dblink_exec('qa_a', 'BEGIN');
  PERFORM * FROM extensions.dblink('qa_a', format(v_sql, 'race-a@shop.test', pg_temp.its(pg_temp.it('Q-ONE', 1)))) AS t(r text);
  PERFORM extensions.dblink_send_query('qa_b', format(v_sql, 'race-b@shop.test', pg_temp.its(pg_temp.it('Q-ONE', 1))));
  FOR i IN 1..250 LOOP
    EXIT WHEN cardinality(pg_blocking_pids(v_pid_b)) > 0;
    PERFORM pg_sleep(0.02);
  END LOOP;
  IF cardinality(pg_blocking_pids(v_pid_b)) = 0 THEN
    RAISE EXCEPTION 'FAIL: race setup — the second checkout never waited for the first';
  END IF;
  PERFORM extensions.dblink_exec('qa_a', 'COMMIT');
  PERFORM * FROM extensions.dblink_get_result('qa_b', false) AS t(r text);
  v_err_b := extensions.dblink_error_message('qa_b');
  PERFORM * FROM extensions.dblink_get_result('qa_b', false) AS t(r text);
  PERFORM extensions.dblink_disconnect('qa_a');
  PERFORM extensions.dblink_disconnect('qa_b');
  IF position('out_of_stock:Qa One' IN v_err_b) = 0 THEN
    RAISE EXCEPTION 'FAIL: the second shopper should get out_of_stock, got %', v_err_b;
  END IF;
  IF pg_temp.stock('Q-ONE') <> 0 OR (SELECT count(*) FROM public.order_items WHERE sku = 'Q-ONE') <> 1 THEN
    RAISE EXCEPTION 'FAIL: the last unit sold % time(s), stock %', (SELECT count(*) FROM public.order_items WHERE sku = 'Q-ONE'), pg_temp.stock('Q-ONE');
  END IF;
  RAISE NOTICE 'PASS: concurrency — the last unit sells exactly once; the waiting checkout gets out_of_stock';
END $$;
