-- 20_assistant_offers.test.sql — list_live_offers (public codes: code/title/minimum only; exclusive
-- codes only for an EARNED session, with per-session and store-wide throttles; never usage figures;
-- only live codes) and admin_offer_performance (admin only; by discount_id or code snapshot;
-- cancelled orders excluded from revenue; window).
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);

-- isolate from any seeded codes
UPDATE public.discounts SET is_active = FALSE;
INSERT INTO public.discounts (code, title, kind, value, min_requirement, usage_limit, usage_count, assistant_only, starts_at, ends_at, is_active) VALUES
  ('PUB10',     'Public ten',      'percentage',   10,    0,     NULL, 3, FALSE, NULL, NULL, TRUE),
  ('PUBMIN',    'Public minimum',  'fixed_amount', 2000,  20000, 100,  7, FALSE, NULL, now() + interval '5 days', TRUE),
  ('EXCL15',    'Chat fifteen',    'percentage',   15,    0,     5,    1, TRUE,  NULL, now() + interval '2 days', TRUE),
  ('EXCLUSED',  'Chat used up',    'percentage',   20,    0,     1,    1, TRUE,  NULL, NULL, TRUE),
  ('OLDCODE',   'Expired',         'percentage',   5,     0,     NULL, 0, FALSE, NULL, now() - interval '1 day', TRUE),
  ('SOONCODE',  'Not started',     'percentage',   5,     0,     NULL, 0, FALSE, now() + interval '1 day', NULL, TRUE),
  ('OFFCODE',   'Switched off',    'percentage',   5,     0,     NULL, 0, FALSE, NULL, NULL, FALSE),
  ('FULLCODE',  'Exhausted',       'percentage',   5,     0,     2,    2, FALSE, NULL, NULL, TRUE);
CREATE FUNCTION pg_temp.offers(p_session uuid) RETURNS text LANGUAGE sql AS $$
  SELECT COALESCE(string_agg(concat_ws('/', code, COALESCE(kind, '∅'), COALESCE(value::text, '∅'), min_requirement::text,
                                       CASE WHEN ends_at IS NULL THEN '∅' ELSE 'date' END, exclusive::text), ', '), '')
    FROM public.list_live_offers(p_session) $$;

SELECT pg_temp.eq((SELECT proargnames FROM pg_proc WHERE oid = 'public.list_live_offers(uuid)'::regprocedure),
                  ARRAY['p_session_id', 'code', 'title', 'kind', 'value', 'min_requirement', 'ends_at', 'exclusive'],
                  'the offer rows carry no usage figures (no usage_count / usage_limit columns)');

-- ── public codes only, for everyone ─────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT set_config('t.o_anon', pg_temp.offers(NULL), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.o_anon'), 'PUB10/∅/∅/0.00/∅/false, PUBMIN/∅/∅/20000.00/∅/false',
                  'no session: live public codes only, code/title/minimum — no amount, no end date; expired/not started/off/exhausted hidden');

-- ── an exclusive code needs an EARNED session ───────────────────────────────
SELECT pg_temp.login_anon();
SELECT public.log_assistant_turn('11111111-aaaa-0000-0000-000000000001', 'hi', 'hello');
SELECT set_config('t.o_new', pg_temp.offers('11111111-aaaa-0000-0000-000000000001'), false);
SELECT public.log_assistant_turn('11111111-aaaa-0000-0000-000000000001', 'any deals?', 'let me look');
SELECT set_config('t.o_young', pg_temp.offers('11111111-aaaa-0000-0000-000000000001'), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.o_new'), current_setting('t.o_anon'), '2 messages: not earned');
SELECT pg_temp.eq(current_setting('t.o_young'), current_setting('t.o_anon'), '4 messages but under a minute old: not earned');
UPDATE public.assistant_sessions SET created_at = now() - interval '5 minutes' WHERE id = '11111111-aaaa-0000-0000-000000000001';
SELECT pg_temp.login_anon();
SELECT set_config('t.o_earned', pg_temp.offers('11111111-aaaa-0000-0000-000000000001'), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.o_earned'),
                  'EXCL15/percentage/15.00/0.00/date/true, PUB10/∅/∅/0.00/∅/false, PUBMIN/∅/∅/20000.00/∅/false',
                  'an earned session also gets the live exclusive code, priced (kind/value/end); the used-up one stays hidden');
UPDATE public.assistant_sessions SET last_seen_at = now() - interval '25 hours' WHERE id = '11111111-aaaa-0000-0000-000000000001';
SELECT pg_temp.login_anon();
SELECT set_config('t.o_stale', pg_temp.offers('11111111-aaaa-0000-0000-000000000001'), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.o_stale'), current_setting('t.o_anon'), 'a session not seen for 24 hours is no longer earned');
UPDATE public.assistant_sessions SET last_seen_at = now() WHERE id = '11111111-aaaa-0000-0000-000000000001';
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(pg_temp.offers(gen_random_uuid()), current_setting('t.o_anon'), 'an unknown session is not earned');
SELECT pg_temp.logout();

-- per-session throttle: 6 exclusive answers per hour (one was spent above)
SELECT pg_temp.login_anon();
SELECT pg_temp.offers('11111111-aaaa-0000-0000-000000000001');
SELECT pg_temp.offers('11111111-aaaa-0000-0000-000000000001');
SELECT pg_temp.offers('11111111-aaaa-0000-0000-000000000001');
SELECT pg_temp.offers('11111111-aaaa-0000-0000-000000000001');
SELECT set_config('t.o_6th', pg_temp.offers('11111111-aaaa-0000-0000-000000000001'), false);
SELECT set_config('t.o_7th', pg_temp.offers('11111111-aaaa-0000-0000-000000000001'), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.o_6th'), current_setting('t.o_earned'), 'the 6th call in the hour still gets the exclusive code');
SELECT pg_temp.eq(current_setting('t.o_7th'), current_setting('t.o_anon'), 'the 7th call gets public codes only');
SELECT pg_temp.eq((SELECT count(*) FROM public.rate_limit_hits WHERE bucket = 'offers:global'), 6::bigint,
                  'the store-wide bucket is charged only for calls that passed the session throttle');

-- store-wide throttle: 400 exclusive answers per hour
INSERT INTO public.rate_limit_hits (bucket) SELECT 'offers:global' FROM generate_series(1, 394);
SELECT pg_temp.login_anon();
SELECT public.log_assistant_turn('22222222-aaaa-0000-0000-000000000001', 'hi', 'hello');
SELECT public.log_assistant_turn('22222222-aaaa-0000-0000-000000000001', 'deal?', 'looking');
SELECT pg_temp.logout();
UPDATE public.assistant_sessions SET created_at = now() - interval '5 minutes' WHERE id = '22222222-aaaa-0000-0000-000000000001';
SELECT pg_temp.login_anon();
SELECT set_config('t.o_global', pg_temp.offers('22222222-aaaa-0000-0000-000000000001'), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.o_global'), current_setting('t.o_anon'), 'past 400 per hour store-wide, even an earned session gets public codes only');

-- ── admin_offer_performance ─────────────────────────────────────────────────
INSERT INTO public.orders (id, email, first_name, phone, subtotal, discount_id, discount_code, discount_amount, total_price, status, created_at)
SELECT o.id, 'p@shop.test', 'P', '+94771111111', o.sub, d.id, d.code, o.disc, o.total, o.status, now() - o.age
  FROM (VALUES ('DO-81001', 'PUB10', 10000, 1000, 9450, 'delivered', interval '1 day'),
               ('DO-81002', 'PUB10', 20000, 2000, 18000, 'cancelled', interval '2 days'),
               ('DO-81003', 'PUB10', 5000, 500, 4950, 'pending', interval '100 days')) AS o(id, code, sub, disc, total, status, age)
  JOIN public.discounts d ON d.code = o.code;
-- the code row was deleted and re-created: only the snapshot links this order to EXCL15
INSERT INTO public.orders (id, email, first_name, phone, subtotal, discount_id, discount_code, discount_amount, total_price, status)
VALUES ('DO-81004', 'q@shop.test', 'Q', '+94771111111', 8000, NULL, 'excl15', 1200, 7250, 'accepted');

SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws('SELECT * FROM public.admin_offer_performance()', '42501', 'a shopper cannot read offer performance', 'not_authorised:%');
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT * FROM public.admin_offer_performance()', '42501', 'anon has no EXECUTE on offer performance');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.perf', (SELECT string_agg(concat_ws('/', code, exclusive::text, orders_count::text, cancelled_count::text, revenue::text, discount_given::text), ', ' ORDER BY code)
                               FROM public.admin_offer_performance() WHERE code IN ('PUB10', 'EXCL15', 'PUBMIN')), false);
SELECT set_config('t.perf_long', (SELECT concat_ws('/', orders_count::text, revenue::text) FROM public.admin_offer_performance(now() - interval '200 days') WHERE code = 'PUB10'), false);
SELECT set_config('t.perf_excl', (SELECT string_agg(code, ',' ORDER BY code) FROM public.admin_offer_performance(NULL, NULL, TRUE)), false);
SELECT set_config('t.perf_swap', (SELECT concat_ws('/', orders_count::text, revenue::text) FROM public.admin_offer_performance(now(), now() - interval '10 days') WHERE code = 'PUB10'), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.perf'),
                  'EXCL15/true/1/0/7250.00/1200.00, PUB10/false/2/1/9450.00/1000.00, PUBMIN/false/0/0/0/0',
                  'per code: orders (by id or snapshot), cancellations, revenue and discount of non-cancelled orders; unused codes listed with zeros');
SELECT pg_temp.eq(current_setting('t.perf_long'), '3/14400.00', 'a wider window counts the 100-day-old order');
SELECT pg_temp.eq(current_setting('t.perf_excl'), 'EXCL15,EXCLUSED', 'p_assistant_only = TRUE lists exclusive codes only');
SELECT pg_temp.eq(current_setting('t.perf_swap'), '2/9450.00', 'reversed bounds are swapped');
