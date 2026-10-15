-- 38_stock_movements.test.sql — the stock movement ledger and the two inventory reports:
-- privileges, the client's acceptance checks (inventory value example; the movement example;
-- price changes; detail vs summary), web orders (reservation ≠ sale, hand-over = sale, cancel
-- before / after hand-over, pickup), invoices (issue = sale, back to draft = reversal), stock edits,
-- tracking off / on, recording movements and its refusals, and the ledger = stock invariant.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
UPDATE public.customers SET first_name = 'Anan', last_name = 'Owner' WHERE id = current_setting('t.owner')::uuid;
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);
SELECT set_config('t.today', ((now() AT TIME ZONE 'Asia/Colombo')::date)::text, false);
-- the ledger "started" a month ago, so movements can be dated inside the test periods
UPDATE public.app_config SET value = (now() - interval '30 days')::text WHERE name = 'stock_ledger_started';

INSERT INTO public.categories (id, name) VALUES ('sm-cat', 'Stock report tests');
INSERT INTO public.products (slug, brand, name, subtitle, category_id) VALUES
  ('sm-laptop', 'SmBrand', 'Laptop A', 'i5 · 16GB · 512GB', 'sm-cat'),
  ('sm-ssd',    'SmBrand', 'SSD 1TB',  NULL,                'sm-cat'),
  ('sm-mouse',  'SmBrand', 'Mouse',    NULL,                'sm-cat'),
  ('sm-free',   'SmNoPrice', 'Unpriced cable', NULL,        'sm-cat');
INSERT INTO public.product_variants (product_id, name, price, position, sku)
SELECT p.id, 'Standard', v.price, 0, v.sku FROM public.products p
  JOIN (VALUES ('sm-laptop', 200000, NULL), ('sm-ssd', 25000, 'SM-SSD1TB'), ('sm-mouse', 3000, NULL), ('sm-free', 0, NULL)) AS v(slug, price, sku)
    ON v.slug = p.slug;
SELECT set_config('t.ids', (SELECT jsonb_object_agg(p.slug, jsonb_build_object('p', p.id, 'v', v.id))
                              FROM public.products p JOIN public.product_variants v ON v.product_id = p.id
                             WHERE p.slug LIKE 'sm-%')::text, false);
CREATE FUNCTION pg_temp.vid(p_slug text) RETURNS int LANGUAGE sql AS $$ SELECT (current_setting('t.ids')::jsonb -> p_slug ->> 'v')::int $$;
CREATE FUNCTION pg_temp.pid(p_slug text) RETURNS int LANGUAGE sql AS $$ SELECT (current_setting('t.ids')::jsonb -> p_slug ->> 'p')::int $$;
CREATE FUNCTION pg_temp.stock(p_slug text) RETURNS int LANGUAGE sql AS $$ SELECT stock_level FROM public.inventory WHERE variant_id = pg_temp.vid(p_slug) $$;
CREATE FUNCTION pg_temp.moves(p_slug text) RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(format('%s:%s', movement_type, qty_in - qty_out), ' ' ORDER BY occurred_at, id), '')
    FROM public.stock_movements WHERE variant_id = pg_temp.vid(p_slug)
$$;
-- (runs as the superuser: the helpers it checks are internal)
CREATE FUNCTION pg_temp.ledger_ok() RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.inventory i
                      WHERE i.variant_id IN (SELECT (e.value ->> 'v')::int FROM jsonb_each(current_setting('t.ids')::jsonb) e)
                        AND public._stock_balance(i.variant_id) <> i.stock_level + public._stock_reserved(i.variant_id))
$$;
CREATE FUNCTION pg_temp.value_row(p_report jsonb, p_slug text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT r FROM jsonb_array_elements(p_report -> 'rows') r WHERE (r ->> 'variant_id')::int = pg_temp.vid(p_slug)
$$;
CREATE FUNCTION pg_temp.place(p_slug text, p_qty int, p_fulfillment text DEFAULT 'delivery') RETURNS text LANGUAGE sql AS $$
  SELECT public.place_order('buyer@shop.test', 'Kamal', 'Silva', '0771234567',
           '{"street":"1 Galle Road","city":"Colombo 03","district":"Colombo"}',
           jsonb_build_array(jsonb_build_object('product_id', pg_temp.pid(p_slug), 'variant_id', pg_temp.vid(p_slug), 'quantity', p_qty)),
           NULL, NULL, 'LKR', 1, 'cod', p_fulfillment, NULL) ->> 'order_id'
$$;
CREATE FUNCTION pg_temp.record(p_slug text, p_type text, p_qty int, p_days_ago int, p_ref text DEFAULT NULL) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.admin_record_stock_movement(pg_temp.vid(p_slug), p_type, p_qty, p_ref, NULL, now() - make_interval(days => p_days_ago))
$$;

-- tracking switched on with stock (as the SQL editor would)
INSERT INTO public.inventory (variant_id, stock_level) VALUES
  (pg_temp.vid('sm-laptop'), 3), (pg_temp.vid('sm-ssd'), 5), (pg_temp.vid('sm-mouse'), 10), (pg_temp.vid('sm-free'), 2);
SELECT pg_temp.eq(pg_temp.moves('sm-ssd'), 'adjustment_in:5', 'switching tracking on posts the stock as an addition');
SELECT pg_temp.eq((SELECT note FROM public.stock_movements WHERE variant_id = pg_temp.vid('sm-ssd')), 'Stock tracking switched on', '… with a note');
-- those were "before the period": move them back ten days
UPDATE public.stock_movements SET occurred_at = now() - interval '10 days'
 WHERE variant_id IN (pg_temp.vid('sm-laptop'), pg_temp.vid('sm-ssd'), pg_temp.vid('sm-mouse'), pg_temp.vid('sm-free'));

-- ── 1. privileges ───────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT 1 FROM public.stock_movements LIMIT 1', '42501', 'anon cannot read the ledger');
SELECT pg_temp.throws($$SELECT public.admin_inventory_value_report()$$, '42501', 'anon cannot run the value report');
SELECT pg_temp.throws($$SELECT public.admin_stock_movement_report(current_date, current_date)$$, '42501', 'anon cannot run the movement report');
SELECT pg_temp.throws($$SELECT public.admin_record_stock_movement(1, 'received', 1)$$, '42501', 'anon cannot record movements');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.stock_movements), 0::bigint, 'a shopper sees no movements (RLS)');
SELECT pg_temp.throws($$SELECT public.admin_inventory_value_report()$$, '42501', 'a shopper is refused by the in-body check', 'not_authorised:%');
SELECT pg_temp.throws($$SELECT public.admin_stock_movement_history(1, current_date, current_date)$$, '42501', 'a shopper cannot read a history', 'not_authorised:%');
SELECT pg_temp.throws($$SELECT public.admin_stock_report_options()$$, '42501', 'a shopper cannot list the options', 'not_authorised:%');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws(format($$INSERT INTO public.stock_movements (variant_id, movement_type, qty_in) VALUES (%s, 'received', 1)$$, pg_temp.vid('sm-ssd')),
                      '42501', 'even an admin cannot write the ledger directly');
SELECT pg_temp.throws('UPDATE public.stock_movements SET qty_in = 99', '42501', 'or rewrite it');
SELECT pg_temp.throws('DELETE FROM public.stock_movements', '42501', 'or delete from it');

-- ── 2. acceptance: the inventory value example (page 1) ─────────────────────
SELECT set_config('t.val', public.admin_inventory_value_report(NULL, NULL, 'smbrand')::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', t ->> 'rows', t ->> 'quantity', t ->> 'value') FROM (SELECT current_setting('t.val')::jsonb -> 'totals' AS t) x),
                  '3|18|755000.00', 'Laptop A 3 + SSD 5 + Mouse 10 = 18 units, LKR 755,000.00 (brand filter, any case)');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s:%s', r ->> 'product_name', r ->> 'quantity', r ->> 'price', r ->> 'value'), ', ' ORDER BY ord)
                     FROM jsonb_array_elements(current_setting('t.val')::jsonb -> 'rows') WITH ORDINALITY AS e(r, ord)),
                  'Laptop A:3:200000.00:600000.00, Mouse:10:3000.00:30000.00, SSD 1TB:5:25000.00:125000.00',
                  'one row per variant: quantity × current selling price');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', r ->> 'code', r ->> 'specs', r ->> 'category_name') FROM pg_temp.value_row(current_setting('t.val')::jsonb, 'sm-laptop') r),
                  format('V%s|i5 · 16GB · 512GB|Stock report tests', pg_temp.vid('sm-laptop')), 'no SKU → V + the variant number; specs and category');
SELECT pg_temp.eq((SELECT r ->> 'code' FROM pg_temp.value_row(current_setting('t.val')::jsonb, 'sm-ssd') r), 'SM-SSD1TB', 'the SKU when there is one');
SELECT set_config('t.val', public.admin_inventory_value_report(NULL, 'sm-cat')::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s', t ->> 'rows', t ->> 'quantity', t ->> 'value', t ->> 'missing_price_rows', t ->> 'missing_price_quantity')
                     FROM (SELECT current_setting('t.val')::jsonb -> 'totals' AS t) x),
                  '4|20|755000.00|1|2', 'a missing price is flagged and left out of the value total — never counted as 0');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', r ->> 'price_missing', r -> 'price', r -> 'value') FROM pg_temp.value_row(current_setting('t.val')::jsonb, 'sm-free') r),
                  'true|null|null', 'the unpriced row has no price and no value');
SELECT pg_temp.eq((public.admin_inventory_value_report('sm-ssd1tb') -> 'totals' ->> 'rows'), '1', 'search by SKU (any case)');
SELECT pg_temp.eq((public.admin_inventory_value_report('laptop a', 'sm-cat') -> 'totals' ->> 'rows'), '1', 'search by name within a category');
SELECT pg_temp.eq((public.admin_inventory_value_report(NULL, NULL, NULL, pg_temp.vid('sm-mouse')) -> 'totals' ->> 'quantity'), '10', 'one variant');
SELECT pg_temp.eq((SELECT count(*) FROM jsonb_array_elements(public.admin_stock_report_options() -> 'variants') v
                    WHERE (v ->> 'variant_id')::int = pg_temp.vid('sm-ssd') AND v ->> 'label' = 'SmBrand SSD 1TB'), 1::bigint, 'the options list the variant');
UPDATE public.products SET name = 'SmBrand Mouse' WHERE slug = 'sm-mouse';
SELECT pg_temp.eq((SELECT v ->> 'label' FROM jsonb_array_elements(public.admin_stock_report_options() -> 'variants') v
                    WHERE (v ->> 'variant_id')::int = pg_temp.vid('sm-mouse')), 'SmBrand Mouse', 'a name that already starts with the brand keeps it once');
UPDATE public.products SET name = 'Mouse' WHERE slug = 'sm-mouse';
SELECT pg_temp.ok(public.admin_stock_report_options() -> 'brands' ? 'SmNoPrice', 'the options list the brands');

-- ── 3. acceptance: the movement example (page 3) on the SSD ─────────────────
-- opening 5 (ten days ago); in the period: received 10, sold 4 (an invoice), customer return 1,
-- supplier return 2, adjustment +1 and −1
SELECT pg_temp.record('sm-ssd', 'received', 10, 2, 'GRN-001');
SELECT pg_temp.record('sm-ssd', 'customer_return', 1, 1);
SELECT pg_temp.record('sm-ssd', 'supplier_return', 2, 1, 'SR-9');
SELECT pg_temp.record('sm-ssd', 'adjustment_in', 1, 1);
SELECT pg_temp.record('sm-ssd', 'adjustment_out', 1, 1);
SELECT set_config('t.inv', (public.admin_save_invoice('{"bill_to_name":"Acme Holdings"}',
  jsonb_build_array(jsonb_build_object('variant_id', pg_temp.vid('sm-ssd'), 'description', 'SSD 1TB', 'quantity', 3, 'unit_price', 25000),
                    jsonb_build_object('variant_id', pg_temp.vid('sm-ssd'), 'description', 'SSD 1TB (spare)', 'quantity', 1, 'unit_price', 25000)))
  #>> '{invoice,id}'), false);
SELECT public.admin_issue_invoice(current_setting('t.inv')::int);
SELECT pg_temp.eq(pg_temp.stock('sm-ssd'), 10, 'the SSD stock is 10');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s', movement_type, qty_out, source_type), ' ' ORDER BY qty_out DESC) FROM public.stock_movements
                    WHERE variant_id = pg_temp.vid('sm-ssd') AND source_type IS NOT NULL),
                  'sale:3:invoice sale:1:invoice', 'issuing the invoice posts a sale per line (one inventory update, split by line)');
SELECT pg_temp.eq((SELECT count(*) FROM public.stock_movements WHERE variant_id = pg_temp.vid('sm-ssd') AND movement_type LIKE 'adjustment%'), 3::bigint,
                  'no stray adjustment is left by the invoice (only tracking-on and the two recorded ones)');

SELECT set_config('t.mr', public.admin_stock_movement_report((current_setting('t.today')::date - 3), current_setting('t.today')::date,
                                                             NULL, NULL, NULL, pg_temp.vid('sm-ssd'))::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s|%s|%s|%s', r ->> 'opening', r ->> 'received', r ->> 'sales', r ->> 'customer_returns',
                                 r ->> 'supplier_returns', r ->> 'adjustments_in', r ->> 'adjustments_out', r ->> 'closing')
                     FROM jsonb_array_elements(current_setting('t.mr')::jsonb -> 'rows') r),
                  '5|10|4|1|2|1|1|10', 'opening 5 + 10 + 1 − 4 − 2 + 1 − 1 = closing 10');
SELECT pg_temp.eq((SELECT format('%s|%s', r ->> 'price', r ->> 'closing_value') FROM jsonb_array_elements(current_setting('t.mr')::jsonb -> 'rows') r),
                  '25000.00|250000.00', 'closing 10 × LKR 25,000 = LKR 250,000.00');

-- detail vs summary
SELECT set_config('t.h', public.admin_stock_movement_history(pg_temp.vid('sm-ssd'), (current_setting('t.today')::date - 3), current_setting('t.today')::date)::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', h ->> 'opening', h ->> 'closing', jsonb_array_length(h -> 'rows')) FROM (SELECT current_setting('t.h')::jsonb AS h) x),
                  '5|10|7', 'the history opens at 5, closes at 10, seven movements');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s:%s', r ->> 'movement_type', r ->> 'qty_in', r ->> 'qty_out', r ->> 'balance'), ' ' ORDER BY ord)
                     FROM jsonb_array_elements(current_setting('t.h')::jsonb -> 'rows') WITH ORDINALITY AS e(r, ord) WHERE ord <= 5),
                  'received:10:0:15 customer_return:1:0:16 supplier_return:0:2:14 adjustment_in:1:0:15 adjustment_out:0:1:14',
                  'by date/time then id, stock in / out positive, running balance = previous + in − out');
SELECT pg_temp.ok((SELECT bool_and((r ->> 'balance')::int = 14 + (SELECT -sum((x ->> 'qty_out')::int) FROM jsonb_array_elements(current_setting('t.h')::jsonb -> 'rows') WITH ORDINALITY AS y(x, o2) WHERE o2 BETWEEN 6 AND ord))
                     FROM jsonb_array_elements(current_setting('t.h')::jsonb -> 'rows') WITH ORDINALITY AS e(r, ord) WHERE ord > 5),
                  'the two invoice sales (same instant, by id) carry the balance down to 10');
SELECT pg_temp.eq((SELECT (r ->> 'balance')::int FROM jsonb_array_elements(current_setting('t.h')::jsonb -> 'rows') WITH ORDINALITY AS e(r, ord) ORDER BY ord DESC LIMIT 1),
                  (SELECT (r ->> 'closing')::int FROM jsonb_array_elements(current_setting('t.mr')::jsonb -> 'rows') r), 'the final running balance equals the summary closing');
SELECT pg_temp.eq((SELECT string_agg(COALESCE(r ->> 'reference', '-'), ' ' ORDER BY ord) FROM jsonb_array_elements(current_setting('t.h')::jsonb -> 'rows') WITH ORDINALITY AS e(r, ord)),
                  format('GRN-001 - SR-9 - - %1$s %1$s', (SELECT number FROM public.invoices WHERE id = current_setting('t.inv')::int)),
                  'references: typed ones, and the invoice number for invoice sales');
SELECT pg_temp.eq((SELECT DISTINCT r ->> 'recorded_by' FROM jsonb_array_elements(current_setting('t.h')::jsonb -> 'rows') r), 'Anan Owner', 'recorded by the admin');
-- the opening balance is the whole history before the start
SELECT pg_temp.eq((public.admin_stock_movement_history(pg_temp.vid('sm-ssd'), current_setting('t.today')::date, current_setting('t.today')::date) ->> 'opening'),
                  '14', 'a later start date opens at the balance before it');
SELECT pg_temp.eq((public.admin_stock_movement_report((current_setting('t.today')::date - 20), (current_setting('t.today')::date - 15),
                                                      NULL, NULL, NULL, pg_temp.vid('sm-ssd')) #>> '{rows,0,closing}'),
                  '0', 'a period before the stock arrived closes at 0');

-- price change: valuation moves, quantities and invoice prices don't
UPDATE public.product_variants SET price = 30000 WHERE id = pg_temp.vid('sm-ssd');
SELECT pg_temp.eq((SELECT format('%s|%s', r ->> 'closing', r ->> 'closing_value')
                     FROM jsonb_array_elements(public.admin_stock_movement_report((current_setting('t.today')::date - 3), current_setting('t.today')::date,
                                                                                   NULL, NULL, NULL, pg_temp.vid('sm-ssd')) -> 'rows') r),
                  '10|300000.00', 'a new selling price changes the valuation, not the quantity');
SELECT pg_temp.eq((SELECT r ->> 'value' FROM pg_temp.value_row(public.admin_inventory_value_report(NULL, 'sm-cat'), 'sm-ssd') r), '300000.00',
                  'the value report uses the current price');
SELECT pg_temp.eq((SELECT string_agg(unit_price::text, ',') FROM public.invoice_items WHERE invoice_id = current_setting('t.inv')::int),
                  '25000.00,25000.00', 'historical invoice prices are untouched');

-- ── 4. web orders: reservation is not a sale; the hand-over is ──────────────
SELECT pg_temp.login_anon();
SELECT set_config('t.o1', pg_temp.place('sm-mouse', 2), false);
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.stock('sm-mouse'), 8, 'placing the order takes 2 off the sellable stock');
SELECT pg_temp.eq(pg_temp.moves('sm-mouse'), 'adjustment_in:10', 'but posts nothing to the ledger');
SELECT pg_temp.eq((SELECT stock_reserved FROM public.order_items WHERE order_id = current_setting('t.o1')), 2, 'the line remembers it reserved 2');
SELECT pg_temp.eq((SELECT format('%s|%s', r ->> 'quantity', r ->> 'reserved') FROM pg_temp.value_row(public.admin_inventory_value_report(NULL, 'sm-cat'), 'sm-mouse') r),
                  '10|2', 'reserved units are still on hand (not deducted twice)');
SELECT public.admin_set_order_status(current_setting('t.o1'), 'accepted');
SELECT pg_temp.eq(pg_temp.moves('sm-mouse'), 'adjustment_in:10', 'accepting it moves nothing');
SELECT public.admin_set_order_status(current_setting('t.o1'), 'out_for_delivery', 'TRK-1');
SELECT pg_temp.eq(pg_temp.moves('sm-mouse'), 'adjustment_in:10 sale:-2', 'handing it to the courier is the sale');
SELECT pg_temp.eq((SELECT format('%s|%s', r ->> 'quantity', r ->> 'reserved') FROM pg_temp.value_row(public.admin_inventory_value_report(NULL, 'sm-cat'), 'sm-mouse') r),
                  '8|0', 'now it has left the shelf');
SELECT public.admin_set_order_status(current_setting('t.o1'), 'delivered');
SELECT pg_temp.eq(pg_temp.moves('sm-mouse'), 'adjustment_in:10 sale:-2', 'delivered: still one sale');
SELECT pg_temp.ok(pg_temp.ledger_ok(), 'ledger = sellable + reserved');
SELECT public.admin_set_order_status(current_setting('t.o1'), 'cancelled');
SELECT pg_temp.eq(pg_temp.stock('sm-mouse'), 10, 'cancelling restocks the 2');
SELECT pg_temp.eq(pg_temp.moves('sm-mouse'), 'adjustment_in:10 sale:-2 sale_reversal:2', 'as an explicit reversal of the sale');
SELECT pg_temp.eq((SELECT source_id FROM public.stock_movements WHERE variant_id = pg_temp.vid('sm-mouse') AND movement_type = 'sale_reversal'),
                  current_setting('t.o1'), 'referencing the order');

-- cancelled before hand-over: nothing ever moved
SELECT pg_temp.login_anon();
SELECT set_config('t.o2', pg_temp.place('sm-mouse', 1), false);
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.stock('sm-mouse'), 9, 'a second order reserves 1');
SELECT public.admin_set_order_status(current_setting('t.o2'), 'cancelled');
SELECT pg_temp.eq(pg_temp.stock('sm-mouse'), 10, 'cancelled before hand-over: back to 10');
SELECT pg_temp.eq(pg_temp.moves('sm-mouse'), 'adjustment_in:10 sale:-2 sale_reversal:2', 'and the ledger never saw it');
SELECT pg_temp.ok(pg_temp.ledger_ok(), 'ledger = sellable + reserved after the cancellations');

-- pickup: "Ready for pickup" is still on the shelf; collected is the sale
SELECT pg_temp.login_anon();
SELECT set_config('t.o3', pg_temp.place('sm-mouse', 3, 'pickup'), false);
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_set_order_status(current_setting('t.o3'), 'out_for_delivery');
SELECT pg_temp.eq((SELECT count(*) FROM public.stock_movements WHERE source_id = current_setting('t.o3')), 0::bigint, 'ready for pickup is not a sale');
SELECT public.admin_set_order_status(current_setting('t.o3'), 'delivered');
SELECT pg_temp.eq((SELECT format('%s:%s', movement_type, qty_out) FROM public.stock_movements WHERE source_id = current_setting('t.o3')), 'sale:3', 'collected is');
SELECT pg_temp.ok(pg_temp.ledger_ok(), 'ledger = sellable + reserved after the pickup');

-- ── 5. invoices back to draft, stock edits, tracking off / on ───────────────
SELECT set_config('t.inv2', (public.admin_save_invoice('{"bill_to_name":"Walk-in"}',
  jsonb_build_array(jsonb_build_object('variant_id', pg_temp.vid('sm-laptop'), 'description', 'Laptop A', 'quantity', 1, 'unit_price', 200000)))
  #>> '{invoice,id}'), false);
SELECT public.admin_issue_invoice(current_setting('t.inv2')::int);
SELECT public.admin_revert_invoice(current_setting('t.inv2')::int);
SELECT pg_temp.eq(pg_temp.moves('sm-laptop'), 'adjustment_in:3 sale:-1 sale_reversal:1', 'issue = sale, back to draft = reversal');
SELECT pg_temp.eq(pg_temp.stock('sm-laptop'), 3, 'stock back to 3');

SELECT pg_temp.eq(pg_temp.affected(format('UPDATE public.inventory SET stock_level = 12 WHERE variant_id = %s', pg_temp.vid('sm-laptop'))), 1::bigint,
                  'an admin edits the stock number in the Inventory tab');
SELECT pg_temp.eq((SELECT format('%s:%s:%s', movement_type, qty_in, recorded_by = current_setting('t.owner')::uuid) FROM public.stock_movements
                    WHERE variant_id = pg_temp.vid('sm-laptop') ORDER BY id DESC LIMIT 1),
                  'adjustment_in:9:t', 'logged as a positive adjustment by that admin');
SELECT pg_temp.eq(pg_temp.affected(format('UPDATE public.inventory SET low_stock_threshold = 1 WHERE variant_id = %s', pg_temp.vid('sm-laptop'))), 1::bigint,
                  'changing only the alert level…');
SELECT pg_temp.eq((SELECT count(*) FROM public.stock_movements WHERE variant_id = pg_temp.vid('sm-laptop')), 4::bigint, '…moves nothing');
SELECT pg_temp.eq(pg_temp.affected(format('DELETE FROM public.inventory WHERE variant_id = %s', pg_temp.vid('sm-laptop'))), 1::bigint, 'tracking switched off');
SELECT pg_temp.eq((SELECT sum(qty_in - qty_out)::int FROM public.stock_movements WHERE variant_id = pg_temp.vid('sm-laptop')), 0, 'takes the ledger balance to 0');
SELECT pg_temp.eq((public.admin_inventory_value_report(NULL, NULL, NULL, pg_temp.vid('sm-laptop')) -> 'totals' ->> 'rows'), '0',
                  'an untracked variant is not in the value report');
SELECT pg_temp.eq((public.admin_stock_movement_report((current_setting('t.today')::date - 3), current_setting('t.today')::date,
                                                      NULL, NULL, NULL, pg_temp.vid('sm-laptop')) -> 'rows' -> 0 ->> 'closing'), '0',
                  'but its movements are still reported (closing 0)');
SELECT pg_temp.eq(pg_temp.affected(format('INSERT INTO public.inventory (variant_id, stock_level) VALUES (%s, 4)', pg_temp.vid('sm-laptop'))), 1::bigint, 'tracked again with 4');
SELECT pg_temp.eq((SELECT sum(qty_in - qty_out)::int FROM public.stock_movements WHERE variant_id = pg_temp.vid('sm-laptop')), 4, 'the ledger follows');

-- ── 6. recording: refusals ──────────────────────────────────────────────────
SELECT pg_temp.throws(format($$SELECT public.admin_record_stock_movement(%s, 'stolen', 1)$$, pg_temp.vid('sm-ssd')), '22023', 'an unknown type', 'invalid_movement:%');
SELECT pg_temp.throws(format($$SELECT public.admin_record_stock_movement(%s, 'sale', 1)$$, pg_temp.vid('sm-ssd')), '22023', 'sales come from orders and invoices only', 'invalid_movement:%');
SELECT pg_temp.throws(format($$SELECT public.admin_record_stock_movement(%s, 'received', 0)$$, pg_temp.vid('sm-ssd')), '22023', 'a zero quantity', 'invalid_quantity:%');
SELECT pg_temp.throws(format($$SELECT public.admin_record_stock_movement(%s, 'supplier_return', 11)$$, pg_temp.vid('sm-ssd')), '22023',
                      'more than the sellable stock', 'insufficient_stock:Only 10 of %');
SELECT pg_temp.throws(format($$SELECT public.admin_record_stock_movement(%s, 'received', 1, NULL, NULL, now() + interval '1 day')$$, pg_temp.vid('sm-ssd')), '22023',
                      'a future date', 'invalid_date:%');
SELECT pg_temp.throws(format($$SELECT public.admin_record_stock_movement(%s, 'received', 1, NULL, NULL, now() - interval '60 days')$$, pg_temp.vid('sm-ssd')), '22023',
                      'a date before the ledger started', 'invalid_date:%');
INSERT INTO public.product_variants (product_id, name, price, position) VALUES (pg_temp.pid('sm-ssd'), '2TB', 40000, 1);
SELECT pg_temp.throws(format($$SELECT public.admin_record_stock_movement(%s, 'received', 1)$$,
                             (SELECT id FROM public.product_variants WHERE product_id = pg_temp.pid('sm-ssd') AND name = '2TB')), '22023',
                      'an untracked variant', 'not_tracked:%');
SELECT pg_temp.throws($$SELECT public.admin_record_stock_movement(-1, 'received', 1)$$, '22023', 'an unknown variant', 'variant_not_found:%');
SELECT pg_temp.throws($$SELECT public.admin_stock_movement_report(current_date, current_date - 1)$$, '22023', 'an inverted range', 'invalid_range:%');
SELECT set_config('t.rec', public.admin_record_stock_movement(pg_temp.vid('sm-ssd'), 'received', 5, '  GRN-002 ', '  boxed ')::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s|%s', r ->> 'stock_level', r ->> 'on_hand', r ->> 'type') FROM (SELECT current_setting('t.rec')::jsonb AS r) x),
                  '15|15|received', 'recording returns the new stock');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', reference, note, claimable) FROM public.stock_movements WHERE id = (current_setting('t.rec')::jsonb ->> 'movement_id')::bigint),
                  'GRN-002|boxed|f', 'reference and note are trimmed; a recorded movement is final');
SELECT pg_temp.ok(pg_temp.ledger_ok(), 'ledger = sellable + reserved at the end');
SELECT pg_temp.logout();
