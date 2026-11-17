-- 51_product_viewers.test.sql — the live viewer count: other browsers only, one row per browser,
-- a goodbye removes the viewer at once, a vanished page stops counting after 45 seconds, hidden
-- products count nobody, the table stays sealed.
\ir _helpers.sql

INSERT INTO public.categories (id, name) VALUES ('qa51-cat', 'QA 51');
INSERT INTO public.products (slug, brand, name, category_id) VALUES ('qa51-a', 'QaBrand', 'Qa51 A', 'qa51-cat');
INSERT INTO public.product_variants (product_id, sku, name, price, position, is_active)
SELECT p.id, 'Q51-A', 'Standard', 1000, 0, TRUE FROM public.products p WHERE p.slug = 'qa51-a';
SELECT set_config('t.p', (SELECT id FROM public.products WHERE slug = 'qa51-a')::text, false);
SELECT set_config('t.s1', gen_random_uuid()::text, false);
SELECT set_config('t.s2', gen_random_uuid()::text, false);
SELECT set_config('t.s3', gen_random_uuid()::text, false);
CREATE FUNCTION pg_temp.ping(p_s text) RETURNS int LANGUAGE sql AS $$
  SELECT public.ping_product_view(current_setting('t.p')::int, current_setting('t.' || p_s)::uuid) $$;
CREATE FUNCTION pg_temp.leave(p_s text) RETURNS void LANGUAGE sql AS $$
  SELECT public.leave_product_view(current_setting('t.p')::int, current_setting('t.' || p_s)::uuid) $$;

SELECT pg_temp.login_anon();
SELECT pg_temp.eq(pg_temp.ping('s1'), 0, 'alone on the page: nobody else');
SELECT pg_temp.eq(pg_temp.ping('s2'), 1, 'a second browser sees one other');
SELECT pg_temp.eq(pg_temp.ping('s1'), 1, 'and the first sees one other — never itself');
SELECT pg_temp.eq(pg_temp.ping('s1'), 1, 'pinging again (another tab of the same browser) still counts it once');
SELECT pg_temp.leave('s2');
SELECT pg_temp.eq(pg_temp.ping('s1'), 0, 'the second said goodbye: gone at once');
SELECT pg_temp.eq(pg_temp.ping('s3'), 1, 'a third browser arrives');
SELECT pg_temp.logout();
UPDATE public.product_presence SET seen_at = now() - interval '50 seconds' WHERE session_id = current_setting('t.s3')::uuid;
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(pg_temp.ping('s1'), 0, 'a page that vanished without a goodbye stops counting after 45 seconds');
SELECT pg_temp.throws($$SELECT count(*) FROM public.product_presence$$, '42501', 'shoppers can''t read the presence table');
SELECT pg_temp.leave('s1');
SELECT pg_temp.leave('s1');
SELECT pg_temp.ok(TRUE, 'a goodbye for a browser that is not there is harmless');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.product_presence WHERE product_id = current_setting('t.p')::int AND session_id = current_setting('t.s1')::uuid), 0::bigint,
                  'the goodbye deleted the row');
UPDATE public.products SET is_active = FALSE WHERE slug = 'qa51-a';
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(pg_temp.ping('s2'), 0, 'a hidden product counts nobody');
SELECT pg_temp.logout();
\ir ../migrations/51_product_viewers.sql
SELECT pg_temp.ok(has_function_privilege('anon', 'public.leave_product_view(integer,uuid)', 'EXECUTE'), 'a re-run keeps the goodbye callable by the site');
