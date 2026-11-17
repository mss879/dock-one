-- 50_product_availability.test.sql — how each variant is sold (in stock / available to order /
-- pre-order / unavailable): the column checks, quote_order's lines, place_order's backorders,
-- stock arriving for a waiting order (moved to it on the next status change, the ledger in
-- step), cancelling puts back only what was taken (and the whole quantity for orders from before
-- the ledger), "in stock only", Notify me (request, read, take, return, staff), and a re-run.
\ir _helpers.sql

-- ═════════════════════════════════════════════════════════════════════════════
-- Fixtures (as the superuser)
-- ═════════════════════════════════════════════════════════════════════════════
SELECT set_config('t.owner', pg_temp.new_user('owner50@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);

UPDATE public.store_settings
   SET delivery_fee = 450, free_delivery_threshold = 15000, cod_enabled = TRUE, cod_max_total = NULL;

INSERT INTO public.categories (id, name) VALUES ('qa50-cat', 'QA 50');
INSERT INTO public.products (slug, brand, name, category_id)
VALUES ('qa50-stock', 'QaBrand', 'Qa50 Stocked', 'qa50-cat'),
       ('qa50-order', 'QaBrand', 'Qa50 To Order', 'qa50-cat'),
       ('qa50-source', 'QaBrand', 'Qa50 Sourced', 'qa50-cat'),
       ('qa50-pre', 'QaBrand', 'Qa50 Preorder', 'qa50-cat'),
       ('qa50-gone', 'QaBrand', 'Qa50 Unavailable', 'qa50-cat');
INSERT INTO public.product_variants (product_id, sku, name, price, position, is_active)
SELECT p.id, upper(replace(p.slug, 'qa50-', 'Q50-')), 'Standard', 1000, 0, TRUE FROM public.products p WHERE p.slug LIKE 'qa50-%';

CREATE FUNCTION pg_temp.v(p_sku text) RETURNS int LANGUAGE sql AS $$ SELECT id FROM public.product_variants WHERE sku = p_sku $$;
CREATE FUNCTION pg_temp.stock(p_sku text) RETURNS int LANGUAGE sql AS $$
  SELECT stock_level FROM public.inventory WHERE variant_id = pg_temp.v(p_sku) $$;
CREATE FUNCTION pg_temp.items(p_lines jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_agg(jsonb_build_object('product_id', v.product_id, 'variant_id', v.id, 'quantity', (l ->> 'qty')::int) ORDER BY e.ord)
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS e(l, ord)
    JOIN public.product_variants v ON v.sku = l ->> 'sku'
$$;
CREATE FUNCTION pg_temp.po(p_lines jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.place_order('wait@shop.test', 'Ama', 'Perera', '077 123 4567',
                            '{"street":"5 Flower Road","city":"Colombo 07","district":"Colombo"}'::jsonb,
                            pg_temp.items(p_lines), NULL, NULL, 'LKR', 1, 'cod', 'delivery', NULL)
$$;
CREATE FUNCTION pg_temp.line(p_order text, p_sku text) RETURNS text LANGUAGE sql AS $$
  SELECT format('q%s r%s b%s', oi.quantity, oi.stock_reserved, oi.backorder_qty)
    FROM public.order_items oi WHERE oi.order_id = p_order AND oi.variant_id = pg_temp.v(p_sku)
$$;
CREATE FUNCTION pg_temp.req(p_method text, p_path text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.method', p_method, false), set_config('request.path', p_path, false)
$$;

-- ── 1. the columns ──────────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT string_agg(DISTINCT availability, ',') FROM public.product_variants), 'stock',
                  'every variant starts as "stock" (in stock / out of stock, as before)');
SELECT pg_temp.throws($$UPDATE public.product_variants SET availability = 'soon' WHERE sku = 'Q50-STOCK'$$, '23514',
                      'an unknown mode is refused', '%product_variants_availability_valid%');
SELECT pg_temp.throws($$UPDATE public.product_variants SET wait_min_days = 10, wait_max_days = 7 WHERE sku = 'Q50-STOCK'$$, '23514',
                      'a wait whose minimum is above its maximum is refused', '%product_variants_availability_valid%');
SELECT pg_temp.throws($$UPDATE public.product_variants SET wait_max_days = 400 WHERE sku = 'Q50-STOCK'$$, '23514',
                      'a wait over a year is refused', '%product_variants_availability_valid%');

UPDATE public.product_variants SET availability = 'order', wait_min_days = 7, wait_max_days = 10 WHERE sku IN ('Q50-ORDER', 'Q50-SOURCE');
UPDATE public.product_variants SET availability = 'preorder', available_on = DATE '2026-12-20' WHERE sku = 'Q50-PRE';
UPDATE public.product_variants SET availability = 'unavailable' WHERE sku = 'Q50-GONE';
-- tracked: STOCK (2), ORDER (1), PRE (0). SOURCE and GONE are not stock-tracked.
INSERT INTO public.inventory (variant_id, product_id, stock_level, low_stock_threshold)
SELECT v.id, v.product_id, x.n, 0 FROM public.product_variants v
  JOIN (VALUES ('Q50-STOCK', 2), ('Q50-ORDER', 1), ('Q50-PRE', 0)) AS x(sku, n) ON x.sku = v.sku;

-- ── 2. quote_order: what the basket says ────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT set_config('t.q', public.quote_order(pg_temp.items('[{"sku":"Q50-STOCK","qty":3},{"sku":"Q50-ORDER","qty":3},{"sku":"Q50-SOURCE","qty":2},{"sku":"Q50-PRE","qty":1},{"sku":"Q50-GONE","qty":1}]'))::text, false);
SELECT pg_temp.logout();
CREATE FUNCTION pg_temp.ql(p_n int) RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('t.q')::jsonb -> 'lines' -> p_n $$;
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.ql(0) ->> 'available', pg_temp.ql(0) ->> 'reason', pg_temp.ql(0) ->> 'backorder'), 'false|insufficient_stock|0',
                  'a "stock" variant still needs the stock (3 asked, 2 there)');
SELECT pg_temp.eq(format('%s|%s|%s|%s|%s', pg_temp.ql(1) ->> 'available', pg_temp.ql(1) ->> 'availability', pg_temp.ql(1) ->> 'backorder',
                         pg_temp.ql(1) ->> 'wait_min_days', pg_temp.ql(1) ->> 'wait_max_days'), 'true|order|2|7|10',
                  'an "order" variant is orderable beyond its 1 in stock: 2 wait, 7–10 days');
SELECT pg_temp.eq(format('%s|%s', pg_temp.ql(2) ->> 'available', pg_temp.ql(2) ->> 'backorder'), 'true|2',
                  'an untracked "order" variant: every unit is sourced');
SELECT pg_temp.eq(format('%s|%s|%s|%s', pg_temp.ql(3) ->> 'available', pg_temp.ql(3) ->> 'availability', pg_temp.ql(3) ->> 'backorder', pg_temp.ql(3) ->> 'available_on'),
                  'true|preorder|1|2026-12-20', 'a pre-order is orderable with its expected date');
SELECT pg_temp.eq(format('%s|%s|%s', pg_temp.ql(4) ->> 'available', pg_temp.ql(4) ->> 'reason', pg_temp.ql(4) ->> 'stock'), 'false|out_of_stock|out',
                  'an "unavailable" variant is out of stock even though it is not tracked');
SELECT pg_temp.eq((current_setting('t.q')::jsonb ->> 'orderable'), 'false', 'a basket with a line that can''t be had is not orderable');

-- ── 3. place_order: backorders ──────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT pg_temp.po('[{"sku":"Q50-GONE","qty":1}]')$$, 'P0001', 'an unavailable variant can''t be ordered', 'out_of_stock:Qa50 Unavailable');
SELECT pg_temp.throws($$SELECT pg_temp.po('[{"sku":"Q50-STOCK","qty":3}]')$$, 'P0001', 'a "stock" variant can''t be ordered beyond its stock', 'out_of_stock:Qa50 Stocked');
SELECT set_config('t.a', pg_temp.po('[{"sku":"Q50-ORDER","qty":3},{"sku":"Q50-SOURCE","qty":1},{"sku":"Q50-STOCK","qty":1}]')::text, false);
SELECT pg_temp.logout();
SELECT set_config('t.a_id', current_setting('t.a')::jsonb ->> 'order_id', false);
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s', l ->> 'sku', l ->> 'backorder'), ' ' ORDER BY l ->> 'sku') FROM jsonb_array_elements(current_setting('t.a')::jsonb -> 'items') l),
                  'Q50-ORDER:2 Q50-SOURCE:1 Q50-STOCK:0', 'the answer says how many of each line wait');
SELECT pg_temp.eq(format('%s / %s / %s', pg_temp.line(current_setting('t.a_id'), 'Q50-ORDER'), pg_temp.line(current_setting('t.a_id'), 'Q50-SOURCE'),
                         pg_temp.line(current_setting('t.a_id'), 'Q50-STOCK')),
                  'q3 r1 b2 / q1 r0 b1 / q1 r1 b0', 'order lines: what was taken from the shelf (reserved) and what waits (backorder)');
SELECT pg_temp.eq(format('%s %s', pg_temp.stock('Q50-ORDER'), pg_temp.stock('Q50-STOCK')), '0 1', 'the shelf gave what it had, never below 0');
SELECT pg_temp.eq((SELECT count(*) FROM public.stock_movements WHERE variant_id = pg_temp.v('Q50-ORDER') AND claimable), 0::bigint,
                  'the reservation leaves no movement behind (38''s ledger unchanged)');

-- ── 4. the stock arrives: the next status change moves it to the waiting order ─────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_record_stock_movement(pg_temp.v('Q50-ORDER'), 'received', 5, 'GRN-50');
SELECT pg_temp.eq(pg_temp.stock('Q50-ORDER'), 5, '5 received');
SELECT public.admin_set_order_status(current_setting('t.a_id'), 'accepted');
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.line(current_setting('t.a_id'), 'Q50-ORDER'), 'q3 r3 b0', 'accepting the order moved the 2 it waited for to it');
SELECT pg_temp.eq(pg_temp.stock('Q50-ORDER'), 3, 'the shelf keeps the other 3');
SELECT pg_temp.eq(pg_temp.line(current_setting('t.a_id'), 'Q50-SOURCE'), 'q1 r0 b1', 'an untracked line keeps waiting (nothing to take)');
SELECT pg_temp.eq(public._stock_balance(pg_temp.v('Q50-ORDER')), 6, 'ledger: on hand 6 = 3 on the shelf + 3 held for the order');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_set_order_status(current_setting('t.a_id'), 'out_for_delivery', 'TRK-50');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT sum(qty_out)::int FROM public.stock_movements WHERE source_type = 'order' AND source_id = current_setting('t.a_id')
                     AND movement_type = 'sale' AND variant_id = pg_temp.v('Q50-ORDER')), 3,
                  'the hand-over posts the sale of all 3');
SELECT pg_temp.eq(public._stock_balance(pg_temp.v('Q50-ORDER')), 3, 'ledger and shelf agree after the hand-over');

-- ── 5. cancelling puts back only what was taken ────────────────────────────────
SELECT pg_temp.login_anon();
SELECT set_config('t.b_id', pg_temp.po('[{"sku":"Q50-ORDER","qty":5}]') ->> 'order_id', false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s | %s', pg_temp.line(current_setting('t.b_id'), 'Q50-ORDER'), pg_temp.stock('Q50-ORDER')), 'q5 r3 b2 | 0',
                  'a second order takes the 3 left and waits for 2');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_set_order_status(current_setting('t.b_id'), 'cancelled');
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.stock('Q50-ORDER'), 3, 'cancelled: the 3 it took go back — not 5');
SELECT pg_temp.eq(public._stock_balance(pg_temp.v('Q50-ORDER')), 3, 'the ledger still matches the shelf');

-- an order from before the ledger started (no reliable reservation) puts back its whole quantity
SELECT pg_temp.login_anon();
SELECT set_config('t.c_id', pg_temp.po('[{"sku":"Q50-STOCK","qty":1}]') ->> 'order_id', false);
SELECT pg_temp.logout();
UPDATE public.orders SET created_at = (SELECT value::timestamptz FROM public.app_config WHERE name = 'stock_ledger_started') - interval '1 day'
 WHERE id = current_setting('t.c_id');
UPDATE public.order_items SET stock_reserved = 0 WHERE order_id = current_setting('t.c_id');
SELECT pg_temp.eq(pg_temp.stock('Q50-STOCK'), 0, 'the old-style order took the last unit');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_set_order_status(current_setting('t.c_id'), 'cancelled');
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.stock('Q50-STOCK'), 1, 'an order placed before the ledger puts back its whole quantity, as before 50');

-- ── 6. "in stock only" ──────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT string_agg(p.slug, ' ' ORDER BY p.slug) FROM public.list_in_stock_product_ids() x JOIN public.products p ON p.id = x.product_id
                    WHERE p.slug LIKE 'qa50-%'), 'qa50-order qa50-stock',
                  'in stock = on the shelf now: not the untracked "order" item, the pre-order or the unavailable one');
SELECT pg_temp.logout();

-- ── 7. Notify me ────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(public.request_stock_alert(pg_temp.v('Q50-PRE'), '  Wait.Me@Example.COM ') ->> 'ok', 'true', 'a shopper asks to be told');
SELECT pg_temp.eq(public.request_stock_alert(pg_temp.v('Q50-PRE'), 'wait.me@example.com') ->> 'ok', 'true', 'asking twice answers the same');
SELECT pg_temp.throws($$SELECT public.request_stock_alert(pg_temp.v('Q50-PRE'), 'not-an-email')$$, 'P0001', 'a bad email is refused', 'invalid_email');
SELECT pg_temp.throws($$SELECT public.request_stock_alert(999999, 'a@b.co')$$, 'P0001', 'an unknown option is refused', 'invalid_variant');
SELECT pg_temp.throws($$SELECT count(*) FROM public.stock_alerts$$, '42501', 'shoppers can''t read the requests');
SELECT pg_temp.throws($$SELECT public.admin_take_stock_alerts(1)$$, '42501', 'anon can''t take them');
SELECT pg_temp.logout();
UPDATE public.products SET is_active = FALSE WHERE slug = 'qa50-gone';
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.request_stock_alert(pg_temp.v('Q50-GONE'), 'a@b.co')$$, 'P0001', 'a hidden product takes no requests', 'invalid_variant');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(email, ',') FROM public.stock_alerts WHERE notified_at IS NULL), 'wait.me@example.com',
                  'one waiting request, stored trimmed and lower-cased');

SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.viewer', public.admin_create_staff('inv-view@shop.test', 'Counter2026', 'Viewer', '{"inventory": "view"}') ->> 'user_id', false);
SELECT set_config('t.editor', public.admin_create_staff('inv-edit@shop.test', 'Counter2026', 'Editor', '{"inventory": "edit"}') ->> 'user_id', false);
SELECT pg_temp.login(current_setting('t.viewer')::uuid);
SELECT pg_temp.req('GET', '/rest/v1/stock_alerts');
SELECT pg_temp.eq((SELECT count(*) FROM public.stock_alerts), 1::bigint, 'staff with Inventory → view see the requests');
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_take_stock_alerts');
SELECT pg_temp.throws(format('SELECT public.admin_take_stock_alerts(%s)', pg_temp.v('Q50-PRE')), '42501', 'but can''t send them', 'not_authorised:%');
SELECT pg_temp.login(current_setting('t.editor')::uuid);
SELECT set_config('t.take', public.admin_take_stock_alerts(pg_temp.v('Q50-PRE'))::text, false);
SELECT pg_temp.req('', '');
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s|%s', current_setting('t.take')::jsonb ->> 'product_name', current_setting('t.take')::jsonb -> 'emails' -> 0 ->> 'email',
                         jsonb_array_length(current_setting('t.take')::jsonb -> 'emails')),
                  'Qa50 Preorder|wait.me@example.com|1', 'staff with Inventory → edit take the waiting emails (to send them)');
SELECT pg_temp.eq((SELECT count(*) FROM public.stock_alerts WHERE notified_at IS NOT NULL AND notified_by = current_setting('t.editor')::uuid), 1::bigint,
                  'they are marked told, by whom');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(jsonb_array_length(public.admin_take_stock_alerts(pg_temp.v('Q50-PRE')) -> 'emails'), 0, 'nobody is told twice');
SELECT pg_temp.eq(public.admin_return_stock_alerts(ARRAY[(current_setting('t.take')::jsonb -> 'emails' -> 0 ->> 'id')::bigint]), 1,
                  'an email that could not be sent goes back to waiting');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.stock_alerts WHERE notified_at IS NULL), 1::bigint, 'waiting again');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(jsonb_array_length(public.admin_take_stock_alerts(pg_temp.v('Q50-PRE')) -> 'emails'), 1, 'and is taken by the next send');
SELECT pg_temp.logout();
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(public.request_stock_alert(pg_temp.v('Q50-PRE'), 'wait.me@example.com') ->> 'ok', 'true', 'once told, the same email may ask again');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.stock_alerts WHERE email = 'wait.me@example.com'), 2::bigint, 'a new waiting row beside the told one');

-- ── 8. staff map and re-run ─────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s:%s:%s', kind, name, area, view_level, edit_level), ' ' ORDER BY kind, name, area) FROM public.staff_api_map WHERE migration = '50'),
                  'rpc:admin_return_stock_alerts:inventory:view:edit rpc:admin_take_stock_alerts:inventory:view:edit table:stock_alerts:inventory:view:admin table:stock_alerts:products:view:admin',
                  'mapped to Inventory (and readable from Products)');
\ir ../migrations/50_product_availability.sql
SELECT pg_temp.eq((SELECT availability FROM public.product_variants WHERE sku = 'Q50-PRE'), 'preorder', 'a re-run keeps the modes');
SELECT pg_temp.eq((SELECT count(*) FROM public.stock_alerts), 2::bigint, 'a re-run keeps the requests');
SELECT pg_temp.eq((SELECT count(*) FROM public.staff_api_map WHERE migration = '50'), 4::bigint, 'a re-run keeps four staff map rows');
