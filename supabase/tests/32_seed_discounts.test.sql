-- 32_seed_discounts.test.sql — the DEMO code OPENING10: exactly what the approved basket accepted
-- (10 % off, active, no minimum/limit/dates, public), working end to end through quote_order,
-- validate_discount and place_order, idempotent, and removable for good.
\ir _helpers.sql

-- ── 1. what the seed stored ──────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT count(*) FROM public.discounts WHERE upper(code) = 'OPENING10'), 1::bigint, 'seed 32 stores OPENING10 once');
SELECT pg_temp.ok(
  EXISTS (SELECT 1 FROM public.discounts
           WHERE code = 'OPENING10' AND kind = 'percentage' AND value = 10 AND min_requirement = 0
             AND is_active AND NOT assistant_only AND usage_limit IS NULL AND usage_count = 0
             AND starts_at IS NULL AND ends_at IS NULL),
  'OPENING10 is 10 % off, active, public, unlimited, no minimum, no dates');
SELECT pg_temp.eq((SELECT count(*) FROM public.discounts), 1::bigint, 'no other code is seeded (nothing invented)');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.app_config WHERE name = 'seed_32_discounts_demo'), 'the seed marker is recorded');

-- ── 2. idempotent: running the seed again changes nothing ────────────────────
\ir ../migrations/32_seed_discounts.sql
SELECT pg_temp.eq((SELECT count(*) FROM public.discounts WHERE upper(code) = 'OPENING10'), 1::bigint, 'a second run is a no-op');

-- ── 3. end to end with a purchasable catalogue variant (seed 30 or any active one) ──
-- A variant of a visible product that can sell 2 units (untracked, or stock ≥ 2).
SELECT set_config('t.line', (
  SELECT jsonb_build_object('product_id', v.product_id, 'variant_id', v.id, 'quantity', 2)::text
    FROM public.product_variants v
    JOIN public.products p ON p.id = v.product_id AND p.is_active AND p.variant_count > 0
    LEFT JOIN public.inventory i ON i.variant_id = v.id
   WHERE v.is_active AND v.price > 0 AND (i.variant_id IS NULL OR i.stock_level >= 2)
   ORDER BY v.price, v.id
   LIMIT 1), false);
SELECT pg_temp.ok(current_setting('t.line') <> '', 'a purchasable variant exists for the checks');
SELECT set_config('t.expected', (
  SELECT round(v.price * 2 * 10 / 100, 0)::text FROM public.product_variants v
   WHERE v.id = (current_setting('t.line')::jsonb ->> 'variant_id')::int), false);

SELECT pg_temp.login_anon();
SELECT pg_temp.eq((public.quote_order(jsonb_build_array(current_setting('t.line')::jsonb), 'opening10', 'delivery') -> 'discount' ->> 'valid')::boolean,
                  TRUE, 'quote_order accepts the code in any case');
SELECT pg_temp.eq((public.quote_order(jsonb_build_array(current_setting('t.line')::jsonb), 'OPENING10', 'delivery') ->> 'discount_amount')::numeric,
                  current_setting('t.expected')::numeric, 'quote_order takes 10 % of the subtotal (whole rupees)');
SELECT pg_temp.eq((public.validate_discount('OPENING10', 10000) ->> 'discount_amount')::numeric, 1000::numeric, 'validate_discount previews 10 %');
SELECT pg_temp.eq((public.validate_discount('OPENING10', 0) ->> 'valid')::boolean, TRUE, 'no minimum: valid on any subtotal');

-- place_order redeems it (guest, COD — the defaults of a fresh store_settings row)
SELECT set_config('t.order', (public.place_order(
  'seed32@shop.test', 'Sam', 'Silva', '077 123 4567',
  '{"street": "12 Galle Road", "city": "Colombo 03", "district": "Colombo"}'::jsonb,
  jsonb_build_array(current_setting('t.line')::jsonb),
  'opening10', NULL, 'LKR', 1, 'cod', 'delivery', NULL))::text, false);
SELECT pg_temp.logout();

SELECT pg_temp.eq(current_setting('t.order')::jsonb ->> 'discount_code', 'OPENING10', 'the order records the code upper-cased');
SELECT pg_temp.eq((current_setting('t.order')::jsonb ->> 'discount_amount')::numeric, current_setting('t.expected')::numeric, 'place_order charges the same discount the quote showed');
SELECT pg_temp.eq((SELECT usage_count FROM public.discounts WHERE code = 'OPENING10'), 1, 'placing the order counts one use');

-- ── 4. removable for good ────────────────────────────────────────────────────
DELETE FROM public.discounts WHERE upper(code) = 'OPENING10';
SELECT pg_temp.eq((SELECT discount_code FROM public.orders WHERE id = current_setting('t.order')::jsonb ->> 'order_id'), 'OPENING10',
                  'deleting the code keeps the order''s snapshot');
SELECT pg_temp.ok((SELECT discount_id IS NULL FROM public.orders WHERE id = current_setting('t.order')::jsonb ->> 'order_id'), 'and clears the link');
\ir ../migrations/32_seed_discounts.sql
SELECT pg_temp.eq((SELECT count(*) FROM public.discounts WHERE upper(code) = 'OPENING10'), 0::bigint, 're-running the migrations never brings the demo code back');
