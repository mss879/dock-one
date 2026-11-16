-- 49_card_payments.test.sql — card payments through WebXPay: the card vocabulary on orders, the
-- owner's switch in place_order, begin_card_payment, mark_order_paid (amount checks, idempotence,
-- review holds), record_card_payment_failure, view_order's card_payment, the admin's manual
-- "paid", the card receipt on a web-order invoice, RLS on payment_attempts and the privacy line.
\ir _helpers.sql

-- ═════════════════════════════════════════════════════════════════════════════
-- Fixtures (as the superuser)
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.eq((SELECT char_length(value) FROM public.app_config WHERE name = 'payments'), 64,
                  'the migration created the payments secret (64 hex characters)');
SELECT pg_temp.eq((SELECT card_payments_enabled FROM public.store_settings WHERE id), FALSE,
                  'card payment starts switched OFF');
UPDATE public.app_config SET value = 'pay_secret_0123456789abcdefghij' WHERE name = 'payments';

SELECT set_config('t.owner', pg_temp.new_user('owner49@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper49@shop.test', TRUE)::text, false);

UPDATE public.store_settings
   SET delivery_fee = 450, free_delivery_threshold = 15000, cod_enabled = TRUE, cod_max_total = NULL,
       pickup_enabled = TRUE, pickup_address = '12 Showroom Lane, Colombo 03';

INSERT INTO public.categories (id, name) VALUES ('qa49-cat', 'QA 49');
INSERT INTO public.products (slug, brand, name, category_id) VALUES ('qa49-dock', 'QaBrand', 'Qa49 Dock', 'qa49-cat');
INSERT INTO public.product_variants (product_id, sku, name, price, position, is_active)
SELECT p.id, 'Q49-DOCK', 'Standard', 12500, 0, TRUE FROM public.products p WHERE p.slug = 'qa49-dock';
INSERT INTO public.inventory (variant_id, product_id, stock_level, low_stock_threshold)
SELECT v.id, v.product_id, 30, 2 FROM public.product_variants v WHERE v.sku = 'Q49-DOCK';
INSERT INTO public.discounts (code, title, kind, value, min_requirement, is_active, assistant_only)
VALUES ('FREE49', 'Everything free', 'percentage', 100, 0, TRUE, FALSE);

CREATE FUNCTION pg_temp.items(p_qty int DEFAULT 1) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_array(jsonb_build_object('product_id', v.product_id, 'variant_id', v.id, 'quantity', p_qty))
    FROM public.product_variants v WHERE v.sku = 'Q49-DOCK'
$$;
-- place_order as the CURRENT role.
CREATE FUNCTION pg_temp.po(p_method text, p_fulfillment text DEFAULT 'delivery', p_code text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.place_order('Card@Shop.test', 'Nimal', 'Fernando', '077 123 4567',
                            '{"street":"5 Flower Road","city":"Colombo 07","district":"Colombo"}'::jsonb,
                            pg_temp.items(), p_code, NULL, 'LKR', 1, p_method, p_fulfillment, NULL)
$$;
CREATE FUNCTION pg_temp.j(p_name text) RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('t.' || p_name)::jsonb $$;
CREATE FUNCTION pg_temp.secret() RETURNS text LANGUAGE sql AS $$ SELECT 'pay_secret_0123456789abcdefghij' $$;
CREATE FUNCTION pg_temp.begin(p_order text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.begin_card_payment(pg_temp.secret(), p_order, (SELECT view_token FROM public.orders WHERE id = p_order))
$$;
-- WebXPay's answer in the shape the route sends.
CREATE FUNCTION pg_temp.result(p_requested text, p_paid text, p_ref text DEFAULT 'T315972024I13', p_code text DEFAULT '00',
                               p_message text DEFAULT '00 - APPROVED', p_source text DEFAULT 'return') RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('requested_amount', p_requested, 'paid_amount', p_paid, 'gateway_ref', p_ref, 'gateway_status', p_code,
                            'gateway_message', p_message, 'gateway_id', '93', 'gateway_time', '2026-11-16 10:16:28', 'source', p_source)
$$;
CREATE FUNCTION pg_temp.attempt(p_reference text) RETURNS public.payment_attempts LANGUAGE sql AS
  $$ SELECT * FROM public.payment_attempts WHERE reference = p_reference $$;
CREATE FUNCTION pg_temp.ord(p_order text) RETURNS public.orders LANGUAGE sql AS $$ SELECT * FROM public.orders WHERE id = p_order $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- A. The card vocabulary on orders
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT set_config('t.cod', pg_temp.po('cod')::text, false);
SELECT pg_temp.logout();
SELECT set_config('t.cod_id', pg_temp.j('cod') ->> 'order_id', false);
SELECT pg_temp.throws(format($$UPDATE public.orders SET payment_method = 'crypto' WHERE id = %L$$, current_setting('t.cod_id')), '23514',
                      'an unknown method is still refused', '%orders_payment_method_valid%');
SELECT pg_temp.throws(format($$UPDATE public.orders SET payment_method = 'card' WHERE id = %L$$, current_setting('t.cod_id')), '23514',
                      'a card order cannot be "pending collection"', '%orders_payment_pair_valid%');
SELECT pg_temp.throws(format($$UPDATE public.orders SET payment_status = 'awaiting_payment' WHERE id = %L$$, current_setting('t.cod_id')), '23514',
                      'a COD order cannot await a card payment', '%orders_payment_pair_valid%');
SELECT pg_temp.throws(format($$UPDATE public.orders SET payment_method = 'card', payment_status = 'awaiting_transfer' WHERE id = %L$$, current_setting('t.cod_id')), '23514',
                      'a card order cannot await a transfer', '%orders_payment_pair_valid%');

-- ═════════════════════════════════════════════════════════════════════════════
-- B. place_order: the owner's switch, the starting status, WebXPay's Rs. 1 minimum
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT pg_temp.po('card')$$, 'P0001', 'card is refused while the switch is off', 'unsupported_payment_method');
SELECT pg_temp.logout();
UPDATE public.store_settings SET card_payments_enabled = TRUE;
SELECT pg_temp.login_anon();
SELECT set_config('t.c1', pg_temp.po(' Card ')::text, false);
SELECT pg_temp.throws($$SELECT pg_temp.po('card', 'pickup', 'FREE49')$$, 'P0001', 'a Rs. 0 basket cannot pay by card', 'unsupported_payment_method');
SELECT pg_temp.logout();
SELECT set_config('t.c1_id', pg_temp.j('c1') ->> 'order_id', false);
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('c1') ->> 'payment_method', pg_temp.j('c1') ->> 'payment_status', pg_temp.j('c1') ->> 'total'),
                  'card|awaiting_payment|12950.00', 'a card order starts awaiting_payment (method trimmed and lower-cased)');
SELECT pg_temp.eq((SELECT stock_level FROM public.inventory i JOIN public.product_variants v ON v.id = i.variant_id WHERE v.sku = 'Q49-DOCK'), 28,
                  'the card order reserved its stock at placement (like every order)');

-- ═════════════════════════════════════════════════════════════════════════════
-- C. begin_card_payment
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT pg_temp.throws(format($$SELECT public.begin_card_payment('wrong-secret-0123456789xyz', %L, gen_random_uuid())$$, current_setting('t.c1_id')),
                      'P0001', 'a wrong secret is unauthorized', 'unauthorized');
SELECT pg_temp.throws(format($$SELECT public.begin_card_payment(NULL, %L, gen_random_uuid())$$, current_setting('t.c1_id')),
                      'P0001', 'no secret is unauthorized', 'unauthorized');
SELECT pg_temp.eq(public.begin_card_payment(pg_temp.secret(), current_setting('t.c1_id'), gen_random_uuid()), NULL::jsonb,
                  'a wrong view token finds nothing (NULL)');
SELECT pg_temp.logout();
SELECT pg_temp.throws(format($$SELECT pg_temp.begin(%L)$$, current_setting('t.cod_id')), 'P0001', 'a COD order has no card payment', 'not_card_order');
SELECT set_config('t.b1', pg_temp.begin(current_setting('t.c1_id'))::text, false);
SELECT set_config('t.ref1', pg_temp.j('b1') ->> 'reference', false);
SELECT pg_temp.ok(current_setting('t.ref1') ~ ('^' || current_setting('t.c1_id') || '-[0-9A-F]{12}$'),
                  'the reference is the order number plus 12 random hex characters');
SELECT pg_temp.eq(format('%s|%s|%s|%s|%s|%s', pg_temp.j('b1') ->> 'amount', pg_temp.j('b1') ->> 'currency', pg_temp.j('b1') ->> 'email',
                         pg_temp.j('b1') ->> 'phone', pg_temp.j('b1') ->> 'last_name', pg_temp.j('b1') -> 'shipping_address' ->> 'city'),
                  '12950.00|LKR|card@shop.test|+94771234567|Fernando|Colombo 07', 'the form data: amount = the order total, contact and address');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', status, amount, provider) FROM pg_temp.attempt(current_setting('t.ref1'))), 'started|12950.00|webxpay',
                  'an attempt row is opened, started, for the order total');
SELECT set_config('t.b2', pg_temp.begin(current_setting('t.c1_id'))::text, false);
SELECT pg_temp.ok(pg_temp.j('b2') ->> 'reference' <> current_setting('t.ref1'), 'every Pay opens a new attempt with a new reference');
UPDATE public.store_settings SET card_payments_enabled = FALSE;
SELECT pg_temp.throws(format($$SELECT pg_temp.begin(%L)$$, current_setting('t.c1_id')), 'P0001', 'switched off: no new attempt', 'card_unavailable');
UPDATE public.store_settings SET card_payments_enabled = TRUE;
-- 10 an hour per order (2 used above)
SELECT pg_temp.begin(current_setting('t.c1_id')) FROM generate_series(1, 8);
SELECT pg_temp.throws(format($$SELECT pg_temp.begin(%L)$$, current_setting('t.c1_id')), 'P0001', 'the 11th attempt within an hour is refused', 'too_many_attempts');
DELETE FROM public.payment_attempts WHERE order_id = current_setting('t.c1_id') AND reference NOT IN (current_setting('t.ref1'), pg_temp.j('b2') ->> 'reference');

-- ═════════════════════════════════════════════════════════════════════════════
-- D. mark_order_paid — only the full amount, for a real reference, marks the order paid
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT pg_temp.throws(format($$SELECT public.mark_order_paid('wrong-secret-0123456789xyz', %L, pg_temp.result('12950.00', '12950.00'))$$, current_setting('t.ref1')),
                      'P0001', 'mark_order_paid needs the secret', 'unauthorized');
SELECT pg_temp.eq(public.mark_order_paid(pg_temp.secret(), 'DO-1-000000000000', pg_temp.result('12950.00', '12950.00')) ->> 'outcome', 'unknown_reference',
                  'an unknown reference changes nothing');
-- A forged request: WebXPay was asked for Rs. 1 against a real reference.
SELECT set_config('t.m0', public.mark_order_paid(pg_temp.secret(), current_setting('t.ref1'), pg_temp.result('1.00', '1.00'))::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('m0') ->> 'outcome', (pg_temp.ord(current_setting('t.c1_id'))).payment_status,
                         (pg_temp.attempt(current_setting('t.ref1'))).status),
                  'review|awaiting_payment|review', 'a payment for the wrong amount is held for review; the order stays unpaid');
SELECT pg_temp.ok((pg_temp.attempt(current_setting('t.ref1'))).review_reason LIKE 'WebXPay was asked for Rs. 1.00, but this attempt was for Rs. 12950.00.%',
                  'the review reason says what was wrong');
-- A short charge on the second attempt.
SELECT set_config('t.ref2', pg_temp.j('b2') ->> 'reference', false);
SELECT set_config('t.m1', public.mark_order_paid(pg_temp.secret(), current_setting('t.ref2'), pg_temp.result('12950.00', '12000.00'))::text, false);
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('m1') ->> 'outcome', (pg_temp.ord(current_setting('t.c1_id'))).payment_status), 'review|awaiting_payment',
                  'WebXPay charging less than the total is held for review');
-- The real thing on a fresh attempt.
SELECT set_config('t.ref3', pg_temp.begin(current_setting('t.c1_id')) ->> 'reference', false);
SELECT pg_temp.login_anon();
SELECT set_config('t.m2', public.mark_order_paid(pg_temp.secret(), current_setting('t.ref3'), pg_temp.result('12950.00', '12950.00'))::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s|%s|%s', pg_temp.j('m2') ->> 'outcome', pg_temp.j('m2') ->> 'first', pg_temp.j('m2') ->> 'payment_status',
                         pg_temp.j('m2') ->> 'payment_ref'),
                  'paid|true|paid|T315972024I13', 'the full amount marks the order paid, once, with WebXPay''s reference');
SELECT pg_temp.eq(format('%s|%s|%s|%s', (pg_temp.ord(current_setting('t.c1_id'))).payment_status, (pg_temp.ord(current_setting('t.c1_id'))).status,
                         (pg_temp.attempt(current_setting('t.ref3'))).status, (pg_temp.attempt(current_setting('t.ref3'))).gateway_message),
                  'paid|pending|approved|00 - APPROVED', 'order paid (status unchanged for the owner), attempt approved with WebXPay''s words');
SELECT pg_temp.eq((SELECT format('%s|%s', status, description) FROM public.order_tracking WHERE order_id = current_setting('t.c1_id') ORDER BY id DESC LIMIT 1),
                  'Payment received|Paid by card.', 'the shopper''s timeline says so');
SELECT pg_temp.eq(format('%s|%s|%s|%s', pg_temp.j('m2') ->> 'email', pg_temp.j('m2') ->> 'phone', jsonb_array_length(pg_temp.j('m2') -> 'items'),
                         pg_temp.j('m2') -> 'items' -> 0 ->> 'line_total'),
                  'card@shop.test|+94771234567|1|12500.00', 'the answer carries what the confirmation and owner emails need');
SELECT pg_temp.ok((pg_temp.j('m2') ->> 'view_token')::uuid = (pg_temp.ord(current_setting('t.c1_id'))).view_token, '…and the view token for the order page');
-- The same answer again (the shopper refreshes): nothing new, no second email.
SELECT set_config('t.m3', public.mark_order_paid(pg_temp.secret(), current_setting('t.ref3'), pg_temp.result('12950.00', '12950.00'))::text, false);
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('m3') ->> 'outcome', pg_temp.j('m3') ->> 'first'), 'paid|false', 'a repeat is idempotent (first = false)');
SELECT pg_temp.eq((SELECT count(*) FROM public.order_tracking WHERE order_id = current_setting('t.c1_id') AND status = 'Payment received'), 1::bigint,
                  'still one "Payment received" row');
-- A second, separate payment for an order already paid is held (the owner refunds it).
SELECT set_config('t.m4', public.mark_order_paid(pg_temp.secret(), current_setting('t.ref1'), pg_temp.result('12950.00', '12950.00', 'T999'))::text, false);
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('m4') ->> 'outcome', (pg_temp.attempt(current_setting('t.ref1'))).review_reason),
                  'review|The order was already paid: if this is a second payment, refund it in WebXPay.', 'a second payment is held for a refund');
SELECT pg_temp.eq((pg_temp.ord(current_setting('t.c1_id'))).payment_ref, 'T315972024I13', 'the order keeps the reference of the payment that counted');
SELECT pg_temp.throws(format($$SELECT pg_temp.begin(%L)$$, current_setting('t.c1_id')), 'P0001', 'a paid order cannot start another payment', 'already_paid');

-- ═════════════════════════════════════════════════════════════════════════════
-- E. record_card_payment_failure, and view_order's card_payment
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT set_config('t.c2', pg_temp.po('card', 'pickup')::text, false);
SELECT pg_temp.logout();
SELECT set_config('t.c2_id', pg_temp.j('c2') ->> 'order_id', false);
SELECT set_config('t.c2_tok', pg_temp.j('c2') ->> 'view_token', false);
SELECT pg_temp.eq(public.view_order(current_setting('t.c2_id'), current_setting('t.c2_tok')::uuid) -> 'card_payment', 'null'::jsonb,
                  'view_order: no attempt yet → card_payment null');
SELECT pg_temp.eq(public.view_order(current_setting('t.cod_id'), (pg_temp.ord(current_setting('t.cod_id'))).view_token) -> 'card_payment', 'null'::jsonb,
                  'view_order: a COD order has no card_payment');
SELECT set_config('t.ref4', pg_temp.begin(current_setting('t.c2_id')) ->> 'reference', false);
SELECT pg_temp.eq(public.view_order(current_setting('t.c2_id'), current_setting('t.c2_tok')::uuid) -> 'card_payment' ->> 'status', 'started',
                  'view_order: the latest attempt is started');
SELECT pg_temp.login_anon();
SELECT pg_temp.throws(format($$SELECT public.record_card_payment_failure('wrong-secret-0123456789xyz', %L, '{}')$$, current_setting('t.ref4')),
                      'P0001', 'record_card_payment_failure needs the secret', 'unauthorized');
SELECT set_config('t.f1', public.record_card_payment_failure(pg_temp.secret(), current_setting('t.ref4'),
                                                             pg_temp.result('12500.00', NULL, 'T372016I24522', '15', 'No such issuer'))::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s|%s|%s', pg_temp.j('f1') ->> 'outcome', (pg_temp.ord(current_setting('t.c2_id'))).payment_status,
                         (pg_temp.attempt(current_setting('t.ref4'))).status, (pg_temp.attempt(current_setting('t.ref4'))).gateway_status),
                  'declined|awaiting_payment|declined|15', 'a decline is recorded; the order stays awaiting payment');
SELECT pg_temp.eq(public.view_order(current_setting('t.c2_id'), current_setting('t.c2_tok')::uuid) -> 'card_payment' ->> 'message', 'No such issuer',
                  'view_order: a declined attempt carries WebXPay''s reason for the shopper');
-- The shopper retried inside WebXPay with the same reference and paid: approved wins.
SELECT set_config('t.m5', public.mark_order_paid(pg_temp.secret(), current_setting('t.ref4'), pg_temp.result('12500.00', '12500.00', 'T372016I24599'))::text, false);
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('m5') ->> 'outcome', pg_temp.j('m5') ->> 'first', (pg_temp.ord(current_setting('t.c2_id'))).payment_status),
                  'paid|true|paid', 'an approval after a decline (same reference) marks the order paid');
SELECT set_config('t.f2', public.record_card_payment_failure(pg_temp.secret(), current_setting('t.ref4'), pg_temp.result('12500.00', NULL, 'X', '15', 'Late decline'))::text, false);
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('f2') ->> 'outcome', (pg_temp.attempt(current_setting('t.ref4'))).status), 'paid|approved',
                  'a later decline never undoes a payment');
SELECT pg_temp.ok(public.view_order(current_setting('t.c2_id'), current_setting('t.c2_tok')::uuid) -> 'card_payment' ->> 'message' IS NULL,
                  'view_order: an approved attempt carries no message');

-- A held payment says nothing internal to the shopper.
SELECT pg_temp.ok(public.view_order(current_setting('t.c1_id'), (pg_temp.ord(current_setting('t.c1_id'))).view_token) -> 'card_payment' ->> 'message' IS NULL
                  AND public.view_order(current_setting('t.c1_id'), (pg_temp.ord(current_setting('t.c1_id'))).view_token) -> 'card_payment' ->> 'status' IN ('approved', 'review'),
                  'view_order: a held attempt shows its status without the internal reason');

-- ═════════════════════════════════════════════════════════════════════════════
-- F. Cancelled orders, the admin's manual "paid", the card receipt
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT set_config('t.c3', pg_temp.po('card')::text, false);
SELECT set_config('t.c4', pg_temp.po('card')::text, false);
SELECT pg_temp.logout();
SELECT set_config('t.c3_id', pg_temp.j('c3') ->> 'order_id', false);
SELECT set_config('t.c4_id', pg_temp.j('c4') ->> 'order_id', false);
SELECT set_config('t.ref5', pg_temp.begin(current_setting('t.c3_id')) ->> 'reference', false);
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_set_order_status(current_setting('t.c3_id'), 'cancelled');
SELECT pg_temp.logout();
SELECT pg_temp.throws(format($$SELECT pg_temp.begin(%L)$$, current_setting('t.c3_id')), 'P0001', 'a cancelled order cannot start a payment', 'order_cancelled');
SELECT set_config('t.m6', public.mark_order_paid(pg_temp.secret(), current_setting('t.ref5'), pg_temp.result('12950.00', '12950.00', 'T555'))::text, false);
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('m6') ->> 'outcome', (pg_temp.ord(current_setting('t.c3_id'))).payment_status,
                         (pg_temp.attempt(current_setting('t.ref5'))).review_reason),
                  'review|awaiting_payment|The order was cancelled before this payment arrived: refund it in WebXPay.',
                  'a payment that arrives after the cancellation is held for a refund');

-- The owner confirms a card payment WebXPay took but the site never heard about.
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.a1', public.admin_set_payment_status(current_setting('t.c4_id'), 'paid', 'T777 (checked in WebXPay)')::text, false);
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.j('a1') ->> 'previous_payment_status', pg_temp.j('a1') ->> 'payment_status', pg_temp.j('a1') ->> 'timeline_label'),
                  'awaiting_payment|paid|Payment received', 'admin: awaiting_payment → paid by hand');
-- Handed over: the website invoice's receipt is a CARD receipt with WebXPay's reference.
SELECT public.admin_set_order_status(current_setting('t.c1_id'), 'out_for_delivery', 'TRK-49');
SELECT pg_temp.eq((SELECT format('%s|%s', p.method, p.reference) FROM public.invoice_payments p
                     JOIN public.invoices i ON i.id = p.invoice_id WHERE i.order_id = current_setting('t.c1_id')),
                  'card|T315972024I13', 'a paid card order''s invoice receipt is "card", referenced with WebXPay''s number');
SELECT pg_temp.logout();

-- ═════════════════════════════════════════════════════════════════════════════
-- G. Who reads payment_attempts
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT count(*) FROM public.payment_attempts$$, '42501', 'anon cannot read payment attempts');
SELECT pg_temp.throws($$INSERT INTO public.payment_attempts (order_id, reference, amount) VALUES ('DO-1', 'DO-1-000000000000', 1)$$, '42501',
                      'anon cannot write payment attempts');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.payment_attempts), 0::bigint, 'a shopper sees no payment attempts (RLS)');
SELECT pg_temp.throws($$UPDATE public.payment_attempts SET status = 'approved'$$, '42501', 'a shopper cannot change an attempt');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.ok((SELECT count(*) FROM public.payment_attempts) >= 5, 'the admin reads every attempt');
SELECT pg_temp.throws($$UPDATE public.payment_attempts SET status = 'approved'$$, '42501', 'even the admin cannot rewrite an attempt by hand');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s|%s', area, view_level, edit_level) FROM public.staff_api_map WHERE kind = 'table' AND name = 'payment_attempts'),
                  'orders|view|admin', 'staff who may view Orders see the attempts');

-- ═════════════════════════════════════════════════════════════════════════════
-- H. The privacy page names WebXPay (once, even though verify.sh applies 49 twice)
-- ═════════════════════════════════════════════════════════════════════════════
SELECT pg_temp.eq((SELECT (char_length(content) - char_length(replace(content, '**WebXPay**', ''))) / char_length('**WebXPay**')
                     FROM public.cms_pages WHERE slug = 'privacy'),
                  1, 'the privacy page lists WebXPay exactly once');
SELECT pg_temp.ok((SELECT position(E'**Netlify** — runs this website, so it handles your requests, including your network (IP) address, when you visit.\n- **WebXPay**' IN content) > 0
                     FROM public.cms_pages WHERE slug = 'privacy'),
                  'right under the hosting line');
