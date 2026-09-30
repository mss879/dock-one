-- 14_finder.test.sql — record_finder_response: upsert against the PARTIAL unique index (one row
-- per session, the 42P10 bug), earlier email/account never blanked, size clamps and codes, the
-- profile sanitiser, the account attached only for the caller's own session, the newsletter join
-- (source 'finder'), RLS.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.ann', pg_temp.new_user('ann@shop.test', TRUE, '{"first_name":"Ann"}')::text, false);
SELECT set_config('t.bob', pg_temp.new_user('bob@shop.test', TRUE, '{"first_name":"Bob"}')::text, false);
CREATE FUNCTION pg_temp.row(p_session uuid) RETURNS public.finder_responses LANGUAGE sql AS
  $$ SELECT * FROM public.finder_responses WHERE session_id = p_session $$;

SELECT pg_temp.ok(has_function_privilege('anon', 'public.record_finder_response(uuid,jsonb,text,integer[],jsonb,uuid)', 'EXECUTE'),
                  'anon may record finder responses (grant A)');
SELECT pg_temp.ok((SELECT indexdef LIKE '%WHERE (session_id IS NOT NULL)%' FROM pg_indexes WHERE indexname = 'finder_responses_session_key'),
                  'the session key is a PARTIAL unique index');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'finder_responses_updated_idx'),
                  'the insights window (updated_at) is indexed');

-- ── the upsert: one row per session ─────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT public.record_finder_response('33333333-3333-3333-3333-333333333333', '{"category":"laptops","use":"gaming"}', NULL,
                                     ARRAY[3, 1], '{"performance":8,"portability":2.5}');
SELECT public.record_finder_response('33333333-3333-3333-3333-333333333333', '{"category":"laptops","use":"creative"}', ' Fan@Shop.TEST ',
                                     ARRAY[1, NULL, -4, 7], '{"performance":9}', '00000000-0000-0000-0000-0000000000ff');
SELECT public.record_finder_response('33333333-3333-3333-3333-333333333333', '{"category":"mice"}', NULL, NULL, NULL);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.finder_responses), 1::bigint, 'three calls for one session → one row (partial-index ON CONFLICT works)');
SELECT pg_temp.eq((pg_temp.row('33333333-3333-3333-3333-333333333333')).email, 'fan@shop.test',
                  'the email is lower-cased, trimmed and never blanked by a later call without one');
SELECT pg_temp.eq((pg_temp.row('33333333-3333-3333-3333-333333333333')).answers, '{"category":"mice"}'::jsonb, 'the latest answers win');
SELECT pg_temp.eq((pg_temp.row('33333333-3333-3333-3333-333333333333')).recommended_product_ids, '{}'::int[], 'NULL picks → empty');
SELECT pg_temp.eq((pg_temp.row('33333333-3333-3333-3333-333333333333')).customer_id, NULL::uuid,
                  'a forged / non-existent customer id from the anon key is never attached');
SELECT pg_temp.ok((SELECT updated_at >= created_at FROM pg_temp.row('33333333-3333-3333-3333-333333333333')), 'updated_at moves on update');
SELECT pg_temp.eq((SELECT source FROM public.newsletter_subscribers WHERE email = 'fan@shop.test'), 'finder',
                  'a finder email joins the newsletter with source finder');

-- picks and profile are cleaned
SELECT pg_temp.login_anon();
SELECT public.record_finder_response('44444444-4444-4444-4444-444444444444', '{"category":"storage"}', 'not-an-email',
                                     ARRAY[5, NULL, 0, -1, 6], '{"performance":14,"battery":-3,"value":"9","Weight":4,"portability":7.456,"bad key":2,"nested":{"x":1}}');
SELECT pg_temp.logout();
SELECT pg_temp.eq((pg_temp.row('44444444-4444-4444-4444-444444444444')).recommended_product_ids, ARRAY[5, 6],
                  'NULL and non-positive ids are dropped, order kept');
SELECT pg_temp.eq((pg_temp.row('44444444-4444-4444-4444-444444444444')).profile, '{"battery":0,"performance":10,"portability":7.46}'::jsonb,
                  'profile: numbers only, clamped 0..10 (2 dp); strings, bad keys and nested values dropped');
SELECT pg_temp.eq((pg_temp.row('44444444-4444-4444-4444-444444444444')).email, NULL::text, 'an invalid email is ignored, not stored');
SELECT pg_temp.eq((SELECT count(*) FROM public.newsletter_subscribers), 1::bigint, '…and not subscribed');

SELECT pg_temp.login_anon();
SELECT public.record_finder_response('45454545-4545-4545-4545-454545454545', '{"category":"mice"}', NULL, NULL,
  (SELECT jsonb_object_agg('axis_' || i, i % 10) FROM generate_series(1, 25) i));
SELECT public.record_finder_response('46464646-4646-4646-4646-464646464646', '{"category":"mice"}', NULL, NULL, '[1,2]');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM jsonb_object_keys((pg_temp.row('45454545-4545-4545-4545-454545454545')).profile)), 20::bigint,
                  'at most 20 profile keys are kept');
SELECT pg_temp.eq((pg_temp.row('46464646-4646-4646-4646-464646464646')).profile, '{}'::jsonb, 'a non-object profile → {}');

-- ── codes ───────────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.record_finder_response(NULL, '{"a":1}')$$, 'P0001', 'no session', 'invalid_session');
SELECT pg_temp.throws($$SELECT public.record_finder_response(gen_random_uuid(), NULL)$$, 'P0001', 'NULL answers', 'invalid_answers');
SELECT pg_temp.throws($$SELECT public.record_finder_response(gen_random_uuid(), '["a"]')$$, 'P0001', 'answers not an object', 'invalid_answers');
SELECT pg_temp.throws(format('SELECT public.record_finder_response(gen_random_uuid(), %L)',
                             (SELECT jsonb_object_agg('q' || i, 'a') FROM generate_series(1, 21) i)), 'P0001', 'more than 20 answer keys', 'invalid_answers');
SELECT pg_temp.throws(format('SELECT public.record_finder_response(gen_random_uuid(), %L)',
                             jsonb_build_object('avoid', repeat('x', 9000))), 'P0001', 'answers over 8 KB', 'invalid_answers');
SELECT pg_temp.throws($$SELECT public.record_finder_response(gen_random_uuid(), '{"a":1}', NULL, ARRAY[1,2,3,4,5,6,7,8,9,10,11,12,13])$$,
                      'P0001', 'more than 12 picks', 'invalid_recommendations');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.finder_responses), 4::bigint, 'refused calls wrote nothing');

-- ── the account: only the caller's own ──────────────────────────────────────
SELECT pg_temp.login(current_setting('t.ann')::uuid);
SELECT public.record_finder_response('55555555-5555-5555-5555-555555555555', '{"category":"keyboards"}', NULL, ARRAY[2],
                                     '{"portability":6}', current_setting('t.ann')::uuid);
SELECT public.record_finder_response('56565656-5656-5656-5656-565656565656', '{"category":"keyboards"}', NULL, NULL,
                                     '{"portability":6}', current_setting('t.bob')::uuid);
SELECT pg_temp.login_anon();
SELECT public.record_finder_response('57575757-5757-5757-5757-575757575757', '{"category":"keyboards"}', NULL, NULL,
                                     NULL, current_setting('t.ann')::uuid);
-- a later anonymous call for Ann's session never detaches her account
SELECT public.record_finder_response('55555555-5555-5555-5555-555555555555', '{"category":"mice"}', NULL, NULL, NULL, NULL);
SELECT pg_temp.logout();
SELECT pg_temp.eq((pg_temp.row('55555555-5555-5555-5555-555555555555')).customer_id, current_setting('t.ann')::uuid,
                  'a signed-in shopper''s own id (= auth.uid()) is attached, and kept by later calls');
SELECT pg_temp.eq((pg_temp.row('56565656-5656-5656-5656-565656565656')).customer_id, NULL::uuid,
                  'a signed-in shopper cannot attach SOMEONE ELSE''s account');
SELECT pg_temp.eq((pg_temp.row('57575757-5757-5757-5757-575757575757')).customer_id, NULL::uuid,
                  'a real account id sent with the anon key is ignored');

-- ── RLS ─────────────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT * FROM public.finder_responses', '42501', 'anon cannot read finder responses');
SELECT pg_temp.login(current_setting('t.ann')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.finder_responses), 0::bigint, 'a shopper reads none (not even their own)');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.finder_responses$$), 0::bigint, 'a shopper deletes none');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.finder_responses), 7::bigint, 'the admin reads every response');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.finder_responses WHERE session_id = '46464646-4646-4646-4646-464646464646'$$),
                  1::bigint, 'the admin can delete a response');
SELECT pg_temp.logout();

-- ── admin_finder_insights: the Finder insights tab's aggregate ─────────────
SELECT pg_temp.ok(NOT has_function_privilege('anon', 'public.admin_finder_insights(integer)', 'EXECUTE'),
                  'anon cannot execute admin_finder_insights (grant U)');
SELECT pg_temp.ok(has_function_privilege('authenticated', 'public.admin_finder_insights(integer)', 'EXECUTE'),
                  'authenticated may execute admin_finder_insights (the admin is re-checked inside)');
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT public.admin_finder_insights(30)', '42501', 'anon: admin_finder_insights refused');
SELECT pg_temp.login(current_setting('t.ann')::uuid);
SELECT pg_temp.throws('SELECT public.admin_finder_insights(30)', '42501', 'a shopper: admin_finder_insights refused', 'not_authorised:%');

-- four full answer sets from the finder (anon), one of them with an email
SELECT pg_temp.login_anon();
SELECT public.record_finder_response('a1a1a1a1-0000-4000-8000-000000000001',
  '{"category":"laptops","use":"gaming","budget":"mid","portability":"any","avoid":["brand:Vanta"]}', NULL, ARRAY[1, 2, 3], '{"performance":8.8}');
SELECT public.record_finder_response('a1a1a1a1-0000-4000-8000-000000000002',
  '{"category":"laptops","use":"gaming","budget":"entry","portability":"light","avoid":["heavy"]}', 'gap@shop.test', ARRAY[2], '{"portability":8.8}');
SELECT public.record_finder_response('a1a1a1a1-0000-4000-8000-000000000003',
  '{"category":"laptops","use":"gaming","budget":"entry","portability":"light","avoid":["heavy"]}', NULL, ARRAY[2], NULL);
SELECT public.record_finder_response('a1a1a1a1-0000-4000-8000-000000000004',
  '{"category":"laptops","use":"creative","budget":"premium","avoid":[]}', NULL, ARRAY[3, 1, 2], NULL);
-- one response last touched 40 days ago: outside a 30-day window, inside a 90-day one
SELECT public.record_finder_response('a1a1a1a1-0000-4000-8000-000000000005',
  '{"category":"storage","use":"backup","budget":"any","avoid":["heavy","brand:Atlas"]}', NULL, ARRAY[8], NULL);
SELECT pg_temp.logout();
UPDATE public.finder_responses SET updated_at = now() - interval '40 days', created_at = now() - interval '40 days'
 WHERE session_id = 'a1a1a1a1-0000-4000-8000-000000000005';

SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.fi', public.admin_finder_insights(30)::text, false);
SELECT set_config('t.fi90', public.admin_finder_insights(90)::text, false);
SELECT set_config('t.fi0', public.admin_finder_insights(0)::text, false);
SELECT set_config('t.fibig', public.admin_finder_insights(100000)::text, false);
SELECT pg_temp.logout();

-- earlier rows still in the table: 3333 (mice, email fan@, no picks), 4444 (storage, 2 picks),
-- 4545 (mice), 5555 (Ann's, signed in), 5656, 5757 (keyboards) — all without picks except 4444
SELECT pg_temp.eq((current_setting('t.fi')::jsonb ->> 'responses')::int, 10, 'responses in the window: 6 earlier + 4 new');
SELECT pg_temp.eq((current_setting('t.fi90')::jsonb ->> 'responses')::int, 11, 'a 90-day window also counts the 40-day-old response');
SELECT pg_temp.eq((current_setting('t.fi')::jsonb ->> 'with_email')::int, 2, 'responses with an email (fan@, gap@)');
SELECT pg_temp.eq((current_setting('t.fi')::jsonb ->> 'signed_in')::int, 1, 'responses from a signed-in account (Ann)');
SELECT pg_temp.eq((current_setting('t.fi')::jsonb ->> 'short')::int, 8, 'responses where fewer than 3 products matched');
SELECT pg_temp.eq((current_setting('t.fi')::jsonb ->> 'empty')::int, 5, 'responses where nothing matched');
SELECT pg_temp.eq((current_setting('t.fi0')::jsonb ->> 'days')::int, 1, 'p_days is clamped up to 1');
SELECT pg_temp.eq((current_setting('t.fibig')::jsonb ->> 'days')::int, 365, 'p_days is clamped down to 365');
SELECT pg_temp.eq(current_setting('t.fi')::jsonb ->> 'timezone', 'Asia/Colombo', 'the window is in business days (Asia/Colombo)');
SELECT pg_temp.eq((SELECT (c ->> 'responses')::int FROM jsonb_array_elements(current_setting('t.fi')::jsonb -> 'categories') c
                    WHERE c ->> 'category' = 'laptops'), 4, 'per category: 4 laptop responses');
SELECT pg_temp.eq((SELECT (c ->> 'short')::int FROM jsonb_array_elements(current_setting('t.fi')::jsonb -> 'categories') c
                    WHERE c ->> 'category' = 'laptops'), 2, 'per category: 2 laptop responses came up short');
SELECT pg_temp.eq((SELECT (a ->> 'count')::int FROM jsonb_array_elements(current_setting('t.fi')::jsonb -> 'answers') a
                    WHERE a ->> 'category' = 'laptops' AND a ->> 'question' = 'use' AND a ->> 'value' = 'gaming'), 3,
                  'answer distribution: 3 × laptops / use = gaming');
SELECT pg_temp.eq((SELECT (a ->> 'count')::int FROM jsonb_array_elements(current_setting('t.fi')::jsonb -> 'answers') a
                    WHERE a ->> 'category' = 'laptops' AND a ->> 'question' = 'budget' AND a ->> 'value' = 'entry'), 2,
                  'answer distribution: 2 × laptops / budget = entry');
SELECT pg_temp.eq((SELECT (a ->> 'count')::int FROM jsonb_array_elements(current_setting('t.fi')::jsonb -> 'answers') a
                    WHERE a ->> 'category' = 'laptops' AND a ->> 'question' = 'avoid' AND a ->> 'value' = 'brand:Vanta'), 1,
                  'avoid tokens are counted one by one (brand:Vanta)');
SELECT pg_temp.eq((SELECT count(*) FROM jsonb_array_elements(current_setting('t.fi')::jsonb -> 'answers') a
                    WHERE a ->> 'category' = 'storage' AND a ->> 'value' = 'brand:Atlas'), 0::bigint,
                  'answers outside the window are not counted');
SELECT pg_temp.eq((SELECT count(*) FROM jsonb_array_elements(current_setting('t.fi')::jsonb -> 'answers') a
                    WHERE a ->> 'question' NOT IN ('use', 'budget', 'portability', 'avoid')), 0::bigint,
                  'the distribution lists only the four answer questions');
SELECT pg_temp.eq((SELECT g FROM jsonb_array_elements(current_setting('t.fi')::jsonb -> 'gaps') g WHERE g ->> 'category' = 'laptops'),
                  '{"category":"laptops","use":"gaming","budget":"entry","portability":"light","avoid":["heavy"],"picks":1,"count":2}'::jsonb,
                  'a gap: laptops / gaming / budget-friendly / light / avoid heavy → 1 pick, asked twice');
SELECT pg_temp.eq(current_setting('t.fi')::jsonb -> 'gaps' -> 0,
                  '{"category":"mice","use":null,"budget":null,"portability":null,"avoid":[],"picks":0,"count":3}'::jsonb,
                  'gaps are ordered by how often they were asked (3 mice sessions found nothing)');
SELECT pg_temp.eq((SELECT count(*) FROM jsonb_array_elements(current_setting('t.fi')::jsonb -> 'gaps') g WHERE (g ->> 'picks')::int >= 3),
                  0::bigint, 'gaps list only answer sets that got fewer than 3 picks');
