-- 08_discounts.test.sql — code normalisation and shape, the assistant-only cap, the pinned usage
-- counter, admin-only RLS, and the orders.discount_id foreign key.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);

-- ── normalisation and shape ─────────────────────────────────────────────────
INSERT INTO public.discounts (code, title, kind, value) VALUES ('  welcome10 ', '  Welcome  ', 'percentage', 10);
SELECT pg_temp.eq((SELECT code || '|' || title || '|' || kind || '|' || value || '|' || min_requirement || '|' || usage_count || '|' || is_active || '|' || assistant_only
                     FROM public.discounts WHERE code = 'WELCOME10'),
                  'WELCOME10|Welcome|percentage|10.00|0.00|0|true|false', 'codes are stored trimmed and upper-case; defaults');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, value) VALUES ('Welcome10', 'Dup', 5)$$, '23505',
                      'codes are unique case-insensitively', '%discounts_code_upper_key%');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, value) VALUES ('HAS SPACE', 'x', 5)$$, '23514',
                      'no spaces in a code', '%discounts_code_format%');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, value) VALUES ('A', 'x', 5)$$, '23514',
                      'at least 2 characters', '%discounts_code_format%');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, value) VALUES ('-OFF', 'x', 5)$$, '23514',
                      'starts with a letter or digit', '%discounts_code_format%');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, value) VALUES (repeat('A', 33), 'x', 5)$$, '23514',
                      'at most 32 characters (the storefront''s own limit)', '%discounts_code_format%');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, value) VALUES ('BLANK', '   ', 5)$$, '23514',
                      'a title is required', '%discounts_title_valid%');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, kind, value) VALUES ('BOGO', 'x', 'bogo', 5)$$, '23514',
                      'percentage or fixed_amount only', '%discounts_kind_valid%');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, kind, value) VALUES ('P101', 'x', 'percentage', 101)$$, '23514',
                      'a percentage is at most 100', '%discounts_percentage_max%');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, kind, value) VALUES ('ZERO', 'x', 'fixed_amount', 0)$$, '23514',
                      'a value must be positive', '%discounts_value_valid%');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, value, min_requirement) VALUES ('NEGMIN', 'x', 5, -1)$$, '23514',
                      'a minimum cannot be negative', '%discounts_min_valid%');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, value, starts_at, ends_at) VALUES ('BACKWARDS', 'x', 5, now(), now() - interval '1 day')$$,
                      '23514', 'it must end after it starts', '%discounts_dates_valid%');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, value, usage_limit) VALUES ('NOUSE', 'x', 5, 0)$$, '23514',
                      'a usage limit is positive', '%discounts_usage_valid%');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, value, assistant_only) VALUES ('CHATFREE', 'x', 5, TRUE)$$, '23514',
                      'an assistant-only code must be capped', '%discounts_assistant_needs_cap%');
INSERT INTO public.discounts (code, title, kind, value, usage_limit, assistant_only) VALUES ('chat15', 'Chat', 'percentage', 15, 50, TRUE);
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.discounts WHERE code = 'CHAT15' AND assistant_only), 'a capped assistant-only code is fine');

-- ── RLS: admin-only table ────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT * FROM public.discounts', '42501', 'anon cannot list codes');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, value) VALUES ('ANON', 'x', 5)$$, '42501', 'anon cannot create codes');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.discounts), 0::bigint, 'a shopper sees no codes');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.discounts SET value = 100$$), 0::bigint, 'a shopper cannot edit codes');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.discounts$$), 0::bigint, 'a shopper cannot delete codes');
SELECT pg_temp.throws($$INSERT INTO public.discounts (code, title, value) VALUES ('MINE', 'x', 50)$$, '42501', 'a shopper cannot mint codes');
SELECT pg_temp.throws('TRUNCATE public.discounts CASCADE', '42501', 'a shopper cannot truncate codes');

-- ── the admin manages codes; usage_count is derived and pinned ───────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO public.discounts (code, title, kind, value, min_requirement, usage_limit, usage_count)
                                      VALUES ('fixed500', 'Five hundred off', 'fixed_amount', 500, 5000, 10, 7)$$), 1::bigint,
                  'the admin creates a code');
SELECT pg_temp.eq((SELECT usage_count FROM public.discounts WHERE code = 'FIXED500'), 0, 'a new code starts at 0 uses whatever the admin sent');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.discounts SET usage_count = 99, is_active = FALSE WHERE code = 'FIXED500'$$), 1::bigint,
                  'the admin toggles a code');
SELECT pg_temp.eq((SELECT usage_count::text || '/' || is_active FROM public.discounts WHERE code = 'FIXED500'), '0/false',
                  'the uses counter cannot be edited from the app (the toggle still applies)');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.discounts SET code = ' fixed-500 ' WHERE code = 'FIXED500'$$), 1::bigint, 'the admin renames a code');
SELECT pg_temp.eq((SELECT count(*) FROM public.discounts WHERE code = 'FIXED-500'), 1::bigint, 'a renamed code is normalised too');
SELECT pg_temp.logout();
UPDATE public.discounts SET usage_count = 3 WHERE code = 'FIXED-500';
SELECT pg_temp.eq((SELECT usage_count FROM public.discounts WHERE code = 'FIXED-500'), 3, 'the owner can repair a count from the SQL editor (no JWT)');
SELECT pg_temp.ok((SELECT updated_at >= created_at FROM public.discounts WHERE code = 'FIXED-500'), 'updated_at is maintained');

-- ── orders keep the code snapshot when a discount is deleted ─────────────────
INSERT INTO public.orders (id, email, phone, subtotal, discount_id, discount_code, discount_amount, total_price)
SELECT 'DO-30001', 'd@shop.test', '+94771234567', 10000, id, code, 500, 9950 FROM public.discounts WHERE code = 'FIXED-500';
SELECT pg_temp.throws($$UPDATE public.orders SET discount_id = 999999 WHERE id = 'DO-30001'$$, '23503',
                      'orders.discount_id must reference a real code', '%orders_discount_id_fkey%');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.discounts WHERE code = 'FIXED-500'$$), 1::bigint, 'the admin deletes a code');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT COALESCE(discount_id::text, 'null') || '|' || discount_code FROM public.orders WHERE id = 'DO-30001'), 'null|FIXED-500',
                  'deleting a code clears the link and keeps the snapshot');
