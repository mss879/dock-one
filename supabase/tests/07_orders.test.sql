-- 07_orders.test.sql — the order ledger: shape and vocabularies, owner RLS (by account OR verified
-- email), the column guard, the sealed order-number sequence, snapshots that survive catalogue
-- deletes, and confirmation-gated guest-order linking against the REAL orders table.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.ana', pg_temp.new_user('ana@shop.test')::text, false);
SELECT set_config('t.ben', pg_temp.new_user('ben@shop.test')::text, false);

-- ── shape ───────────────────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT start_value FROM pg_sequences WHERE schemaname = 'public' AND sequencename = 'order_number_seq'),
                  10001::bigint, 'order numbers start at 10001');
SELECT pg_temp.eq((SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'orders'),
                  'id,customer_id,email,first_name,last_name,phone,status,fulfillment,shipping_address,customer_note,subtotal,shipping_fee,discount_id,discount_code,discount_amount,total_price,packing_charges,currency,exchange_rate,payment_method,payment_status,payment_ref,tracking_number,tracking_url,view_token,created_at,updated_at',
                  'orders has exactly the documented columns');
SELECT pg_temp.eq((SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'order_items'),
                  'id,order_id,product_id,variant_id,quantity,unit_price,product_name,brand,variant_name,sku,image_url,created_at',
                  'order_items has exactly the documented columns');
SELECT pg_temp.eq((SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'order_tracking'),
                  'id,order_id,status,location,description,created_at', 'order_tracking has exactly the documented columns');

-- Fixtures written with no JWT (as a job / the SQL editor would): the guard lets them through.
INSERT INTO public.categories (id, name) VALUES ('ord-cat', 'Orders');
INSERT INTO public.products (slug, brand, name, category_id) VALUES ('ord-p1', 'OrdBrand', 'Ord One', 'ord-cat'),
                                                                   ('ord-p2', 'OrdBrand', 'Ord Two', 'ord-cat');
INSERT INTO public.product_variants (product_id, sku, name, price)
SELECT id, upper(slug), 'Standard', 1000 FROM public.products WHERE slug IN ('ord-p1', 'ord-p2');
INSERT INTO public.orders (id, customer_id, email, first_name, phone, subtotal, total_price) VALUES
  ('DO-20001', current_setting('t.ana')::uuid, 'ana@shop.test', 'Ana', '+94771111111', 1000, 1450),
  ('DO-20002', NULL, 'ANA@Shop.test', 'Ana', '+94771111111', 2000, 2450),
  ('DO-20003', current_setting('t.ben')::uuid, 'ben@shop.test', 'Ben', '+94772222222', 3000, 3450),
  ('DO-20004', NULL, 'stranger@shop.test', 'Stan', '+94773333333', 4000, 4450);
INSERT INTO public.order_items (order_id, product_id, variant_id, quantity, unit_price, product_name, brand, variant_name, sku)
SELECT o.id, p.id, v.id, 1, 1000, p.name, p.brand, v.name, v.sku
  FROM (VALUES ('DO-20001', 'ord-p1'), ('DO-20002', 'ord-p2'), ('DO-20003', 'ord-p1'), ('DO-20004', 'ord-p2')) AS o(id, slug)
  JOIN public.products p ON p.slug = o.slug
  JOIN public.product_variants v ON v.product_id = p.id;
INSERT INTO public.order_tracking (order_id, status, description)
SELECT id, 'Order placed', 'We have received your order.' FROM public.orders WHERE id LIKE 'DO-2000%';

SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s|%s|%s|%s', status, fulfillment, currency, exchange_rate, payment_method, payment_status,
                                 shipping_address, view_token IS NOT NULL)
                     FROM public.orders WHERE id = 'DO-20004'),
                  'pending|delivery|LKR|1.000000|cod|pending_collection|{}|t', 'order defaults: pending, delivery, LKR, COD, a view token');
SELECT pg_temp.ok((SELECT count(DISTINCT view_token) = 4 FROM public.orders WHERE id LIKE 'DO-2000%'), 'every order gets its own view token');

-- ── constraints (named, for the admin error map) ─────────────────────────────
SELECT pg_temp.throws($$INSERT INTO public.orders (id, email, phone) VALUES ('ORD-1', 'x@y.lk', '+94771111111')$$, '23514',
                      'ids look like DO-<number>', '%orders_id_format%');
SELECT pg_temp.throws($$UPDATE public.orders SET status = 'lost' WHERE id = 'DO-20004'$$, '23514',
                      'one status vocabulary', '%orders_status_valid%');
SELECT pg_temp.throws($$UPDATE public.orders SET fulfillment = 'drone' WHERE id = 'DO-20004'$$, '23514',
                      'fulfillment is delivery or pickup', '%orders_fulfillment_valid%');
SELECT pg_temp.throws($$UPDATE public.orders SET payment_method = 'card' WHERE id = 'DO-20004'$$, '23514',
                      'no card payments', '%orders_payment_method_valid%');
SELECT pg_temp.throws($$UPDATE public.orders SET payment_status = 'authorized' WHERE id = 'DO-20004'$$, '23514',
                      'payment status vocabulary', '%orders_payment_status_valid%');
SELECT pg_temp.throws($$UPDATE public.orders SET payment_method = 'bank_transfer' WHERE id = 'DO-20004'$$, '23514',
                      'a bank transfer cannot be "pending collection"', '%orders_payment_pair_valid%');
SELECT pg_temp.throws($$UPDATE public.orders SET total_price = -1 WHERE id = 'DO-20004'$$, '23514', 'no negative money', '%orders_money_valid%');
SELECT pg_temp.throws($$UPDATE public.orders SET currency = 'lkr' WHERE id = 'DO-20004'$$, '23514', 'ISO currency codes', '%orders_currency_valid%');
SELECT pg_temp.throws($$UPDATE public.orders SET tracking_url = 'javascript:alert(1)' WHERE id = 'DO-20004'$$, '23514',
                      'tracking links are https only', '%orders_text_lengths%');
SELECT pg_temp.throws($$INSERT INTO public.orders (id, email, phone) VALUES ('DO-29999', 'x@y.lk', NULL)$$, '23502', 'the phone is required');
SELECT pg_temp.throws($$INSERT INTO public.order_items (order_id, quantity, unit_price, product_name) VALUES ('DO-20004', 0, 1, 'X')$$, '23514',
                      'order lines need a positive quantity', '%order_items_quantity_valid%');
SELECT pg_temp.throws($$INSERT INTO public.order_tracking (order_id, status) VALUES ('DO-20004', '  ')$$, '23514',
                      'timeline rows need a label', '%order_tracking_text_lengths%');

-- ── anon: the ledger is sealed ───────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT * FROM public.orders', '42501', 'anon cannot read orders');
SELECT pg_temp.throws('SELECT * FROM public.order_items', '42501', 'anon cannot read order lines');
SELECT pg_temp.throws('SELECT * FROM public.order_tracking', '42501', 'anon cannot read timelines');
SELECT pg_temp.throws($$INSERT INTO public.orders (id, email, phone, total_price) VALUES ('DO-1', 'x@y.lk', '1', 0)$$, '42501',
                      'anon cannot forge an order');
SELECT pg_temp.throws($$SELECT nextval('public.order_number_seq')$$, '42501', 'anon cannot take order numbers');
SELECT pg_temp.logout();

-- ── owners: by account OR by their verified sign-in email ────────────────────
SELECT pg_temp.login(current_setting('t.ana')::uuid);
SELECT pg_temp.eq((SELECT string_agg(id, ',' ORDER BY id) FROM public.orders), 'DO-20001,DO-20002',
                  'Ana sees her account order and the guest order placed with her email (case-insensitive)');
SELECT pg_temp.eq((SELECT string_agg(order_id, ',' ORDER BY order_id) FROM public.order_items), 'DO-20001,DO-20002',
                  'Ana sees only her order lines');
SELECT pg_temp.eq((SELECT string_agg(order_id, ',' ORDER BY order_id) FROM public.order_tracking), 'DO-20001,DO-20002',
                  'Ana sees only her timelines');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.orders SET first_name = 'Hacked', status = 'delivered'$$), 0::bigint,
                  'an owner cannot update orders (no UPDATE policy)');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.orders$$), 0::bigint, 'an owner cannot delete orders');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.order_tracking$$), 0::bigint, 'an owner cannot delete timeline rows');
SELECT pg_temp.throws($$INSERT INTO public.orders (id, email, phone) VALUES ('DO-29998', 'ana@shop.test', '1')$$, '42501',
                      'an owner cannot insert an order', 'order_insert_managed%');
SELECT pg_temp.throws($$INSERT INTO public.order_tracking (order_id, status) VALUES ('DO-20001', 'Delivered')$$, '42501',
                      'an owner cannot write their own timeline');
SELECT pg_temp.throws($$SELECT nextval('public.order_number_seq')$$, '42501', 'a shopper cannot take order numbers');
SELECT pg_temp.throws('TRUNCATE public.orders CASCADE', '42501', 'a shopper cannot truncate orders');
SELECT pg_temp.login(current_setting('t.ben')::uuid);
SELECT pg_temp.eq((SELECT string_agg(id, ',' ORDER BY id) FROM public.orders), 'DO-20003', 'Ben sees only his order');

-- ── admin: reads everything; the guard keeps status/money/payment in the RPCs ─
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.ok((SELECT count(*) >= 4 FROM public.orders), 'the admin reads every order');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.orders SET first_name = 'Stanley', last_name = 'S', phone = '+94774444444',
                                        customer_note = 'Leave with the guard', shipping_address = '{"street":"1 New Rd","city":"Galle","district":"Galle"}'
                                     WHERE id = 'DO-20004'$$), 1::bigint,
                  'the admin corrects contact details directly');
SELECT pg_temp.throws($$UPDATE public.orders SET status = 'cancelled' WHERE id = 'DO-20004'$$, '22023',
                      'status changes only through admin_set_order_status', 'order_field_managed:status%');
SELECT pg_temp.throws($$UPDATE public.orders SET payment_status = 'paid' WHERE id = 'DO-20004'$$, '22023',
                      'payment changes only through admin_set_payment_status', 'order_field_managed:payment_status%');
SELECT pg_temp.throws($$UPDATE public.orders SET tracking_number = 'X' WHERE id = 'DO-20004'$$, '22023',
                      'tracking changes only through the RPC (timeline row + email)', 'order_field_managed:tracking_number%');
SELECT pg_temp.throws($$UPDATE public.orders SET customer_id = NULL WHERE id = 'DO-20001'$$, '22023',
                      'ownership is not re-assignable by hand', 'order_field_managed:customer_id%');
SELECT pg_temp.throws($$UPDATE public.orders SET view_token = gen_random_uuid() WHERE id = 'DO-20001'$$, '22023',
                      'the view token is pinned', 'order_field_managed:view_token%');
SELECT pg_temp.throws($$INSERT INTO public.orders (id, email, phone) VALUES ('DO-29997', 'x@y.lk', '+94771111111')$$, '42501',
                      'even an admin cannot insert orders (they come from place_order)', 'order_insert_managed%');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.orders SET first_name = first_name WHERE id LIKE 'DO-2000%'$$), 4::bigint,
                  'an update that leaves managed columns unchanged passes (a full-row form save is fine)');
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO public.order_tracking (order_id, status, location, description)
                                      VALUES ('DO-20004', 'Update', 'Colombo hub', 'Sorted for delivery.')$$), 1::bigint,
                  'the admin may add a manual timeline row');
SELECT pg_temp.throws($$DELETE FROM public.orders WHERE id = 'DO-20004'$$, '42501',
                      'the admin cannot delete an order (cancel it: restock + reversals)', 'order_delete_managed%');
SELECT pg_temp.throws($$UPDATE public.order_items SET unit_price = 1 WHERE order_id = 'DO-20004'$$, '42501',
                      'the admin cannot re-price an order line', 'order_items_managed%');
SELECT pg_temp.throws($$UPDATE public.order_items SET quantity = quantity + 1 WHERE order_id = 'DO-20004'$$, '42501',
                      'the admin cannot change a line quantity', 'order_items_managed%');
SELECT pg_temp.throws($$INSERT INTO public.order_items (order_id, quantity, unit_price, product_name) VALUES ('DO-20004', 1, 1, 'Extra')$$, '42501',
                      'the admin cannot add a line to a placed order', 'order_items_managed%');
SELECT pg_temp.throws($$DELETE FROM public.order_items WHERE order_id = 'DO-20004'$$, '42501',
                      'the admin cannot remove a line from a placed order', 'order_items_managed%');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.order_items SET quantity = quantity WHERE order_id = 'DO-20004'$$), 1::bigint,
                  'a no-op save of a line passes');
SELECT pg_temp.logout();
SELECT pg_temp.ok((SELECT updated_at > created_at FROM public.orders WHERE id = 'DO-20004'), 'updated_at is touched');
SELECT pg_temp.ok(NOT has_sequence_privilege('authenticated', 'public.order_number_seq', 'USAGE')
              AND NOT has_sequence_privilege('anon', 'public.order_number_seq', 'USAGE')
              AND NOT has_sequence_privilege('authenticated', 'public.order_number_seq', 'UPDATE'),
                  'no API role can use or reset the order-number sequence');

-- ── snapshots survive catalogue deletes ──────────────────────────────────────
DELETE FROM public.products WHERE slug = 'ord-p1';
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', product_id, variant_id, product_name, sku) FROM public.order_items WHERE order_id = 'DO-20001'),
                  '||Ord One|ORD-P1', 'deleting a product keeps the line readable (ids cleared, snapshots kept)');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.products WHERE slug = 'ord-p2'$$), 1::bigint,
                  'the admin deletes a product that has order lines (ON DELETE SET NULL passes the line guard)');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s:%s', order_id, COALESCE(product_id::text, '-'), COALESCE(variant_id::text, '-'), product_name), ','
                                     ORDER BY order_id)
                     FROM public.order_items WHERE order_id IN ('DO-20002', 'DO-20004')),
                  'DO-20002:-:-:Ord Two,DO-20004:-:-:Ord Two', 'both links cleared, the snapshot kept');
-- the owner can still remove a test order from the SQL editor (no JWT); its lines and timeline cascade
INSERT INTO public.orders (id, email, first_name, phone, subtotal, total_price) VALUES ('DO-29990', 'test@shop.test', 'Test', '+94770000000', 1, 1);
INSERT INTO public.order_items (order_id, quantity, unit_price, product_name) VALUES ('DO-29990', 1, 1, 'Test line');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.orders WHERE id = 'DO-29990'$$), 1::bigint, 'the SQL editor can delete a test order');
SELECT pg_temp.eq((SELECT count(*) FROM public.order_items WHERE order_id = 'DO-29990'), 0::bigint, 'its lines cascade');

-- ── guest-order linking against the real table (02's triggers + 07) ──────────
-- Two guest orders for linky@, one cancelled; signup unconfirmed → nothing linked; confirmation
-- → both linked and the account adopts the NON-cancelled spend.
INSERT INTO public.orders (id, email, first_name, phone, subtotal, total_price, status) VALUES
  ('DO-20011', 'Linky@Shop.test', 'Lin', '+94775555555', 1000, 1450, 'delivered'),
  ('DO-20012', 'linky@shop.test', 'Lin', '+94775555555', 5000, 5450, 'cancelled'),
  ('DO-20013', 'linky@shop.test', 'Lin', '+94775555555', 2000, 2450, 'pending');
UPDATE public.orders SET customer_id = current_setting('t.ben')::uuid WHERE id = 'DO-20013';   -- already someone's
SELECT set_config('t.linky', pg_temp.new_user('linky@shop.test', FALSE)::text, false);
SELECT pg_temp.eq((SELECT count(*) FROM public.orders WHERE customer_id = current_setting('t.linky')::uuid), 0::bigint,
                  'guest orders are NOT linked to an unconfirmed signup');
UPDATE auth.users SET email_confirmed_at = now() WHERE id = current_setting('t.linky')::uuid;
SELECT pg_temp.eq((SELECT string_agg(id, ',' ORDER BY id) FROM public.orders WHERE customer_id = current_setting('t.linky')::uuid),
                  'DO-20011,DO-20012', 'on confirmation the email''s guest orders link to the account (through the guard)');
SELECT pg_temp.eq((SELECT customer_id FROM public.orders WHERE id = 'DO-20013'), current_setting('t.ben')::uuid,
                  'an order owned by another account is never re-linked');
SELECT pg_temp.eq((SELECT total_spent::text || '/' || orders_count FROM public.customers WHERE id = current_setting('t.linky')::uuid),
                  '1450.00/1', 'the account adopts the non-cancelled spend');
INSERT INTO public.orders (id, email, first_name, phone, subtotal, total_price) VALUES
  ('DO-20021', 'instant@shop.test', 'Ina', '+94776666666', 700, 1150);
SELECT set_config('t.instant', pg_temp.new_user('instant@shop.test', TRUE)::text, false);
SELECT pg_temp.eq((SELECT customer_id FROM public.orders WHERE id = 'DO-20021'), current_setting('t.instant')::uuid,
                  'an auto-confirmed signup links immediately');
SELECT pg_temp.login(current_setting('t.linky')::uuid);
SELECT pg_temp.eq((SELECT string_agg(id, ',' ORDER BY id) FROM public.orders), 'DO-20011,DO-20012,DO-20013',
                  'the new account sees its linked orders, plus any order placed with its verified email (owner rule: account OR email)');
SELECT pg_temp.logout();

-- ── deleting an account (or a code) detaches its orders through the guard ───
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected(format('DELETE FROM public.customers WHERE id = %L', current_setting('t.ben'))), 1::bigint,
                  'the admin deletes a customer who has orders (ON DELETE SET NULL passes the guard)');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(id || ':' || COALESCE(customer_id::text, 'null'), ',' ORDER BY id) FROM public.orders
                    WHERE id IN ('DO-20003', 'DO-20013')), 'DO-20003:null,DO-20013:null',
                  'the deleted account''s orders stay in the ledger, detached');

-- ── owner read by email requires a CONFIRMED address (hardening) ──────────────
INSERT INTO auth.users (id, email, email_confirmed_at) VALUES
  ('07000000-0000-4000-8000-00000000c0c0', 'unconfirmed.reader@shop.test', NULL);
INSERT INTO public.orders (id, customer_id, email, first_name, phone, subtotal, total_price) VALUES
  ('DO-27001', NULL, 'unconfirmed.reader@shop.test', 'Guest', '+94770000000', 100, 550);
SELECT pg_temp.login('07000000-0000-4000-8000-00000000c0c0'::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.orders WHERE id = 'DO-27001'), 0::bigint,
                  'an UNCONFIRMED sign-in email does not unlock guest orders placed with it');
SELECT pg_temp.logout();
UPDATE auth.users SET email_confirmed_at = now() WHERE id = '07000000-0000-4000-8000-00000000c0c0';
SELECT pg_temp.login('07000000-0000-4000-8000-00000000c0c0'::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.orders WHERE id = 'DO-27001'), 1::bigint,
                  'once confirmed, the owner reads the guest order placed with that email');
SELECT pg_temp.logout();
