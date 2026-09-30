-- 01_foundation.test.sql — secrets, sealed tables, rate limiting, touch trigger.
\ir _helpers.sql

-- fixtures (superuser)
INSERT INTO public.app_config (name, value) VALUES
  ('rate_limit', 'rl_secret_0123456789abcdefghij'),
  ('short_one',  'too-short');

-- ── privileges ──────────────────────────────────────────────────────────────
SELECT pg_temp.ok(NOT has_function_privilege('anon', 'public.verify_job_secret(text,text)', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'public.verify_job_secret(text,text)', 'EXECUTE'),
                  'verify_job_secret is internal (no anon/authenticated EXECUTE)');
SELECT pg_temp.ok(NOT has_function_privilege('anon', 'public._rate_limit_hit(text,integer,integer)', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'public._rate_limit_hit(text,integer,integer)', 'EXECUTE'),
                  '_rate_limit_hit is internal (callers cannot fill buckets directly)');
SELECT pg_temp.ok(has_function_privilege('anon', 'public.check_rate_limit(text,text,integer,integer)', 'EXECUTE'),
                  'check_rate_limit is callable by anon (secret-gated inside)');
SELECT pg_temp.ok(NOT has_function_privilege('anon', 'public.touch_updated_at()', 'EXECUTE'),
                  'touch_updated_at is off the privilege surface');

-- ── sealed tables ───────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT * FROM public.app_config', '42501', 'anon cannot read app_config');
SELECT pg_temp.throws($$INSERT INTO public.app_config VALUES ('x', 'y')$$, '42501', 'anon cannot write app_config');
SELECT pg_temp.throws('SELECT * FROM public.rate_limit_hits', '42501', 'anon cannot read rate_limit_hits');
SELECT pg_temp.throws($$INSERT INTO public.rate_limit_hits (bucket) VALUES ('checkout:ip:victim')$$, '42501',
                      'anon cannot pre-fill someone else''s bucket by table write');
SELECT pg_temp.throws($$SELECT public.verify_job_secret('rate_limit', 'rl_secret_0123456789abcdefghij')$$, '42501',
                      'anon cannot call verify_job_secret');
SELECT pg_temp.throws($$SELECT public._rate_limit_hit('checkout:ip:victim', 1, 600)$$, '42501',
                      'anon cannot call _rate_limit_hit');
SELECT pg_temp.logout();
SELECT pg_temp.login(pg_temp.new_user('someone@shop.test'));
SELECT pg_temp.throws('SELECT * FROM public.app_config', '42501', 'authenticated cannot read app_config');
SELECT pg_temp.throws('SELECT * FROM public.rate_limit_hits', '42501', 'authenticated cannot read rate_limit_hits');
SELECT pg_temp.logout();

-- ── verify_job_secret (superuser) ───────────────────────────────────────────
SELECT pg_temp.eq(public.verify_job_secret('rate_limit', 'rl_secret_0123456789abcdefghij'), TRUE, 'correct secret verifies');
SELECT pg_temp.eq(public.verify_job_secret('rate_limit', 'rl_secret_0123456789abcdefghiX'), FALSE, 'wrong secret refused');
SELECT pg_temp.eq(public.verify_job_secret('rate_limit', NULL), FALSE, 'NULL secret refused');
SELECT pg_temp.eq(public.verify_job_secret('rate_limit', 'short'), FALSE, 'short supplied secret refused');
SELECT pg_temp.eq(public.verify_job_secret('short_one', 'too-short'), FALSE, 'a stored secret under 20 chars keeps the job closed');
SELECT pg_temp.eq(public.verify_job_secret('missing', 'rl_secret_0123456789abcdefghij'), FALSE, 'unknown secret name refused');

-- ── check_rate_limit: secret gate, then the limiter bites (each call its own statement) ──
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.check_rate_limit('wrong-secret-xxxxxxxxxxxxxxxxx', 'test:b', 2, 60)$$,
                      'P0001', 'check_rate_limit refuses a wrong secret', 'unauthorized');
SELECT pg_temp.throws($$SELECT public.check_rate_limit(NULL, 'test:b', 2, 60)$$,
                      'P0001', 'check_rate_limit refuses a missing secret', 'unauthorized');
SELECT pg_temp.eq(public.check_rate_limit('rl_secret_0123456789abcdefghij', 'test:b', 2, 60), TRUE, 'limiter: 1st call allowed');
SELECT pg_temp.eq(public.check_rate_limit('rl_secret_0123456789abcdefghij', 'test:b', 2, 60), TRUE, 'limiter: 2nd call allowed');
SELECT pg_temp.eq(public.check_rate_limit('rl_secret_0123456789abcdefghij', 'test:b', 2, 60), FALSE, 'limiter: 3rd call refused');
SELECT pg_temp.eq(public.check_rate_limit('rl_secret_0123456789abcdefghij', 'test:b', 2, 60), FALSE, 'limiter: still refused (refusals are not recorded, but the window is full)');
SELECT pg_temp.eq(public.check_rate_limit('rl_secret_0123456789abcdefghij', 'test:other', 2, 60), TRUE, 'limiter: other buckets unaffected');
SELECT pg_temp.eq(public.check_rate_limit('rl_secret_0123456789abcdefghij', '', 2, 60), TRUE, 'nonsense bucket never locks the store');
SELECT pg_temp.eq(public.check_rate_limit('rl_secret_0123456789abcdefghij', 'test:zero', 0, 60), TRUE, 'max < 1 never locks the store');
SELECT pg_temp.eq(public.check_rate_limit('rl_secret_0123456789abcdefghij', 'test:zero', 5, 0), TRUE, 'window < 1 never locks the store');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.rate_limit_hits WHERE bucket = 'test:b'), 2::bigint, 'exactly the allowed hits were recorded');
SELECT pg_temp.eq((SELECT count(*) FROM public.rate_limit_hits WHERE bucket IN ('', 'test:zero')), 0::bigint, 'nonsense calls record nothing');

-- sliding window: hits older than the window are garbage-collected and stop counting
INSERT INTO public.rate_limit_hits (bucket, hit_at) VALUES
  ('test:gc', now() - interval '2 hours'), ('test:gc', now() - interval '3 hours');
SELECT pg_temp.eq(public._rate_limit_hit('test:gc', 2, 60), TRUE, 'expired hits do not count against the window');
SELECT pg_temp.eq((SELECT count(*) FROM public.rate_limit_hits WHERE bucket = 'test:gc'), 1::bigint, 'expired hits were garbage-collected for that bucket');
SELECT pg_temp.eq((SELECT max(char_length(bucket)) FROM public.rate_limit_hits), 10, 'bucket names stored as given (≤ 200 chars)');
SELECT pg_temp.eq(public._rate_limit_hit(repeat('x', 500), 5, 60), TRUE, 'over-long bucket accepted');
SELECT pg_temp.eq((SELECT max(char_length(bucket)) FROM public.rate_limit_hits), 200, 'over-long bucket truncated to 200 chars');

-- ── touch_updated_at ────────────────────────────────────────────────────────
CREATE TEMP TABLE touch_probe (id int PRIMARY KEY, v text, updated_at timestamptz);
CREATE TRIGGER touch_probe_touch BEFORE UPDATE ON touch_probe FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
INSERT INTO touch_probe VALUES (1, 'a', '2000-01-01');
UPDATE touch_probe SET v = 'b', updated_at = '1999-01-01';
SELECT pg_temp.ok((SELECT updated_at > '2020-01-01' FROM touch_probe), 'touch_updated_at overrides a client-supplied updated_at');

-- ── extensions ──────────────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT extnamespace::regnamespace::text FROM pg_extension WHERE extname = 'pgcrypto'), 'extensions',
                  'pgcrypto lives in the extensions schema');

-- ── direct-call brake: _trusted_route_call / _route_or_budget (P3 hardening) ──
SELECT pg_temp.ok(NOT has_function_privilege('anon', 'public._trusted_route_call()', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'public._trusted_route_call()', 'EXECUTE')
              AND NOT has_function_privilege('anon', 'public._route_or_budget(text,integer,integer)', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'public._route_or_budget(text,integer,integer)', 'EXECUTE'),
                  'the brake helpers are internal (no anon/authenticated EXECUTE)');
-- the 'rate_limit' secret is configured (fixture above)
SELECT set_config('request.headers', '', false);
SELECT pg_temp.eq(public._trusted_route_call(), FALSE, 'no x-dockone-route header = a direct PostgREST call');
SELECT set_config('request.headers', json_build_object('x-dockone-route', repeat('0', 64))::text, false);
SELECT pg_temp.eq(public._trusted_route_call(), FALSE, 'a wrong route token is not trusted');
SELECT set_config('request.headers', '{not json', false);
SELECT pg_temp.eq(public._trusted_route_call(), FALSE, 'malformed request.headers never throws, and is not trusted');
SELECT set_config('request.headers',
                  json_build_object('x-dockone-route',
                                    encode(extensions.hmac('dockone-route-v1', 'rl_secret_0123456789abcdefghij', 'sha256'), 'hex'))::text,
                  false);
SELECT pg_temp.eq(public._trusted_route_call(), TRUE, 'the HMAC route token the server clients send is trusted');
SELECT pg_temp.eq(public._route_or_budget('probe', 1, 60), TRUE, 'route call: allowed (1)');
SELECT pg_temp.eq(public._route_or_budget('probe', 1, 60), TRUE, 'route call: allowed (2) — no budget spent');
SELECT pg_temp.eq((SELECT count(*) FROM public.rate_limit_hits WHERE bucket = 'direct:probe'), 0::bigint,
                  'route calls record nothing');
SELECT set_config('request.headers', '', false);
SELECT pg_temp.eq(public._route_or_budget('probe', 2, 60), TRUE, 'direct call 1: within the store-wide budget');
SELECT pg_temp.eq(public._route_or_budget('probe', 2, 60), TRUE, 'direct call 2: within the store-wide budget');
SELECT pg_temp.eq(public._route_or_budget('probe', 2, 60), FALSE, 'direct call 3: over the store-wide budget');
-- no secret configured: every call is trusted, so the store stays open (like check_rate_limit)
DELETE FROM public.app_config WHERE name = 'rate_limit';
SELECT pg_temp.eq(public._trusted_route_call(), TRUE, 'no rate_limit secret configured = calls are trusted (fail open)');
SELECT pg_temp.eq(public._route_or_budget('probe', 2, 60), TRUE, 'no rate_limit secret configured = no budget applies');
