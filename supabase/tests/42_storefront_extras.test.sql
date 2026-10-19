-- 42_storefront_extras.test.sql — the hotline is the store phone; "people viewing" counts other
-- browsers on the same product in the last 90 seconds, never the visitor themself.
\ir _helpers.sql

SELECT pg_temp.eq((SELECT phone FROM public.store_settings), '+94 71 096 0006', 'the hotline is the store phone');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.app_config WHERE name = 'seed_42_hotline'), 'set once (marker)');

INSERT INTO public.products (slug, brand, name) VALUES ('pv-thing', 'PvBrand', 'Pv Thing'), ('pv-hidden', 'PvBrand', 'Pv Hidden');
UPDATE public.products SET is_active = FALSE WHERE slug = 'pv-hidden';
SELECT set_config('t.p', (SELECT id::text FROM public.products WHERE slug = 'pv-thing'), false);
SELECT set_config('t.h', (SELECT id::text FROM public.products WHERE slug = 'pv-hidden'), false);
SELECT set_config('t.a', gen_random_uuid()::text, false);
SELECT set_config('t.b', gen_random_uuid()::text, false);
SELECT set_config('t.c', gen_random_uuid()::text, false);

SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT 1 FROM public.product_presence LIMIT 1', '42501', 'anon cannot read who is viewing');
SELECT pg_temp.eq(public.ping_product_view(current_setting('t.p')::int, current_setting('t.a')::uuid), 0, 'alone on the page: 0 others');
SELECT pg_temp.eq(public.ping_product_view(current_setting('t.p')::int, current_setting('t.b')::uuid), 1, 'a second browser sees 1 other');
SELECT pg_temp.eq(public.ping_product_view(current_setting('t.p')::int, current_setting('t.a')::uuid), 1, 'the first sees the second (not itself)');
SELECT pg_temp.eq(public.ping_product_view(current_setting('t.p')::int, current_setting('t.c')::uuid), 2, 'a third sees 2');
SELECT pg_temp.eq(public.ping_product_view(current_setting('t.h')::int, current_setting('t.a')::uuid), 0, 'a hidden product counts nobody');
SELECT pg_temp.eq(public.ping_product_view(NULL, current_setting('t.a')::uuid), 0, 'nonsense counts nobody');
SELECT pg_temp.logout();
UPDATE public.product_presence SET seen_at = now() - interval '5 minutes' WHERE session_id = current_setting('t.b')::uuid;
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(public.ping_product_view(current_setting('t.p')::int, current_setting('t.a')::uuid), 1, 'a browser gone quiet for 90 seconds no longer counts');
SELECT pg_temp.logout();
