-- 22_retention.test.sql — run_retention: refuses without the secret (and without an app_config row),
-- deletes exactly what is past each retention period, keeps everything newer, reports per table,
-- never touches orders.
\ir _helpers.sql

INSERT INTO public.app_config (name, value) VALUES ('maintenance', 'mt_secret_0123456789abcdefghij')
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value;
CREATE FUNCTION pg_temp.j(p_name text) RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('t.' || p_name)::jsonb $$;

-- ── fixtures: one row just past and one well inside every period ────────────
INSERT INTO public.rate_limit_hits (bucket, hit_at) VALUES ('x', now() - interval '25 hours'), ('x', now() - interval '1 hour');
INSERT INTO public.assistant_order_lookups (order_ref, email_domain, found, created_at) VALUES
  ('DO-1', 'a.test', FALSE, now() - interval '31 days'), ('DO-2', 'b.test', TRUE, now() - interval '29 days');
INSERT INTO public.analytics_events (event_type, session_id, created_at) VALUES
  ('page_view', gen_random_uuid(), now() - interval '13 months 1 day'), ('page_view', gen_random_uuid(), now() - interval '12 months');
INSERT INTO public.assistant_sessions (id, message_count, created_at, last_seen_at) VALUES
  ('a1000000-0000-0000-0000-000000000001', 2, now() - interval '14 months', now() - interval '12 months 1 day'),
  ('a2000000-0000-0000-0000-000000000001', 3, now() - interval '14 months', now() - interval '1 day');
INSERT INTO public.assistant_messages (session_id, role, content, created_at) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'user', 'old session', now() - interval '12 months 2 days'),
  ('a1000000-0000-0000-0000-000000000001', 'assistant', 'old session reply', now() - interval '12 months 2 days'),
  ('a2000000-0000-0000-0000-000000000001', 'user', 'old message in a live session', now() - interval '13 months'),
  ('a2000000-0000-0000-0000-000000000001', 'user', 'recent', now() - interval '1 day'),
  ('a2000000-0000-0000-0000-000000000001', 'assistant', 'recent reply', now() - interval '1 day');
INSERT INTO public.abandoned_carts (id, email, updated_at, last_recovery_at, converted) VALUES
  ('c1000000-0000-0000-0000-000000000001', 'old@shop.test', now() - interval '91 days', NULL, FALSE),          -- gone
  ('c2000000-0000-0000-0000-000000000001', 'reminded@shop.test', now() - interval '100 days', now() - interval '80 days', FALSE),  -- kept: last reminder 80 d ago
  ('c3000000-0000-0000-0000-000000000001', 'reminded2@shop.test', now() - interval '110 days', now() - interval '95 days', FALSE), -- gone
  ('c4000000-0000-0000-0000-000000000001', 'converted@shop.test', now() - interval '10 days', NULL, TRUE),      -- kept
  ('c5000000-0000-0000-0000-000000000001', 'fresh@shop.test', now(), NULL, FALSE);                             -- kept
SELECT set_config('t.cust', pg_temp.new_user('finder@shop.test')::text, false);
INSERT INTO public.finder_responses (session_id, customer_id, email, answers, updated_at) VALUES
  (gen_random_uuid(), NULL, NULL, '{}', now() - interval '12 months 1 day'),                           -- anonymous + old: gone
  (gen_random_uuid(), NULL, 'kept@shop.test', '{}', now() - interval '2 years'),                       -- has an email: kept
  (gen_random_uuid(), current_setting('t.cust')::uuid, NULL, '{}', now() - interval '2 years'),        -- has an account: kept
  (gen_random_uuid(), NULL, NULL, '{}', now() - interval '11 months');                                 -- anonymous, recent: kept
INSERT INTO public.orders (id, email, first_name, phone, subtotal, total_price, status, created_at) VALUES
  ('DO-90001', 'ancient@shop.test', 'A', '+94771111111', 100, 100, 'delivered', now() - interval '8 years');

-- ── the secret ──────────────────────────────────────────────────────────────
SELECT pg_temp.ok(has_function_privilege('anon', 'public.run_retention(text)', 'EXECUTE'), 'the job function is callable with the anon key (secret-gated)');
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.run_retention('nope')$$, 'P0001', 'a short secret is refused', 'unauthorized');
SELECT pg_temp.throws($$SELECT public.run_retention('wrong_secret_0123456789abcdefghij')$$, 'P0001', 'a wrong secret is refused', 'unauthorized');
SELECT pg_temp.throws($$SELECT public.run_retention(NULL)$$, 'P0001', 'no secret is refused', 'unauthorized');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.analytics_events), 2::bigint, 'a refused run deleted nothing');
DELETE FROM public.app_config WHERE name = 'maintenance';
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.run_retention('mt_secret_0123456789abcdefghij')$$, 'P0001',
                      'without the app_config row even the right value is refused', 'unauthorized');
SELECT pg_temp.logout();
INSERT INTO public.app_config (name, value) VALUES ('maintenance', 'mt_secret_0123456789abcdefghij');

-- ── the run ─────────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT set_config('t.r1', public.run_retention('mt_secret_0123456789abcdefghij')::text, false);
SELECT set_config('t.r2', public.run_retention('mt_secret_0123456789abcdefghij')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.j('r1'),
                  '{"rate_limit_hits":1,"assistant_order_lookups":1,"analytics_events":1,"assistant_sessions":1,
                    "assistant_messages":1,"abandoned_carts":2,"finder_responses":1}'::jsonb,
                  'the report: rows deleted per table');
SELECT pg_temp.eq(pg_temp.j('r2'),
                  '{"rate_limit_hits":0,"assistant_order_lookups":0,"analytics_events":0,"assistant_sessions":0,
                    "assistant_messages":0,"abandoned_carts":0,"finder_responses":0}'::jsonb,
                  'an immediate second run deletes nothing');
SELECT pg_temp.eq((SELECT count(*) FROM public.rate_limit_hits), 1::bigint, 'rate-limit hits: the last day stays');
SELECT pg_temp.eq((SELECT string_agg(order_ref, ',') FROM public.assistant_order_lookups), 'DO-2', 'lookups: 30 days stay');
SELECT pg_temp.eq((SELECT count(*) FROM public.analytics_events), 1::bigint, 'events: 13 months stay');
SELECT pg_temp.eq((SELECT string_agg(left(id::text, 2), ',') FROM public.assistant_sessions), 'a2', 'sessions: seen within 12 months stay');
SELECT pg_temp.eq((SELECT string_agg(content, ',' ORDER BY id) FROM public.assistant_messages), 'recent,recent reply',
                  'messages: the old session''s cascaded and the old message of a live session went');
SELECT pg_temp.eq((SELECT string_agg(left(id::text, 2), ',' ORDER BY id) FROM public.abandoned_carts), 'c2,c4,c5',
                  'carts: 90 days after the later of the last autosave/conversion and the last reminder');
SELECT pg_temp.eq((SELECT count(*) FROM public.finder_responses), 3::bigint, 'finder: only anonymous rows older than 12 months go');
SELECT pg_temp.eq((SELECT count(*) FROM public.orders WHERE id = 'DO-90001'), 1::bigint, 'orders are never touched');
