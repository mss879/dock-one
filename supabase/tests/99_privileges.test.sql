-- ═════════════════════════════════════════════════════════════════════════════
-- 99_privileges.test.sql — the privilege audit (blueprint §7.1, §7.4, §15.1; BUILD_SPEC §8).
--
-- Runs against the FULL migration chain. It fails when:
--   * anon (or authenticated) can EXECUTE a public function that is not on the allowlists
--     below — remember Supabase grants EXECUTE on every new public function to anon and
--     authenticated DIRECTLY, so `REVOKE … FROM PUBLIC` alone never closes one;
--   * an allowlisted function is missing, or is not actually executable by its roles;
--   * a SECURITY DEFINER function in public has no pinned search_path;
--   * a public table has RLS disabled;
--   * any policy (public or storage schema) lets anon / PUBLIC insert, update or delete;
--   * an UPDATE or ALL policy has no explicit WITH CHECK;
--   * anon holds INSERT/UPDATE/DELETE/TRUNCATE on a public table, or authenticated holds TRUNCATE
--     (RLS does not apply to TRUNCATE);
--   * a sealed table is readable by a role it is sealed from (privileges, and live as anon and as a
--     signed-in shopper);
--   * a named internal helper (verify_job_secret, _rate_limit_hit, link_guest_orders, redact_pii,
--     the clamp helpers, …) or ANY trigger function is executable by anon or authenticated.
--
-- EXTENDING (every migration author): when your migration grants a function, add ONE row to
-- allow_anon (grant "A": anon + authenticated) or allow_authenticated (grant "U": authenticated
-- only), with the exact signature as `to_regprocedure()` accepts it and your migration number.
-- When you create a table, revoke anon writes in the migration:
--   REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.<t> FROM anon;
--   REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.<t> FROM authenticated;
-- and add it to sealed_tables if no role but the admin (or nobody) may read it.
-- ═════════════════════════════════════════════════════════════════════════════
\ir _helpers.sql

-- ── allowlists ──────────────────────────────────────────────────────────────
CREATE TEMP TABLE allow_anon (fn text PRIMARY KEY, migration text NOT NULL);          -- grant A
INSERT INTO allow_anon (fn, migration) VALUES
  ('public.check_rate_limit(text,text,integer,integer)', '01_foundation'),
  ('public.get_product_availability(integer[])',         '05_inventory'),
  ('public.list_in_stock_product_ids()',                 '05_inventory'),
  ('public.search_products(text,integer,integer)',       '06_catalogue_search'),
  ('public.catalogue_facets(text)',                      '06_catalogue_search'),
  ('public.quote_order(jsonb,text,text)',                '09_order_rpcs'),
  ('public.place_order(text,text,text,text,jsonb,jsonb,text,uuid,text,numeric,text,text,text)', '09_order_rpcs'),
  ('public.validate_discount(text,numeric)',             '09_order_rpcs'),
  ('public.track_guest_order(text,text)',                '09_order_rpcs'),
  ('public.view_order(text,uuid)',                       '09_order_rpcs'),
  ('public.get_review_summary(integer)',                 '11_reviews'),
  ('public.subscribe_newsletter(text,text)',             '12_leads'),
  ('public.unsubscribe_newsletter(uuid)',                '12_leads'),
  ('public.submit_contact_inquiry(text,text,text,text)', '12_leads'),
  ('public.capture_abandoned_cart(uuid,text,text,text,text,jsonb,jsonb,numeric,text,numeric)', '13_abandoned_carts'),
  ('public.claim_abandoned_carts_for_recovery(text,smallint,integer,integer,integer,integer)', '13_abandoned_carts (secret)'),
  ('public.release_abandoned_cart_recovery(text,uuid,smallint)', '13_abandoned_carts (secret)'),
  ('public.get_recovery_cart(uuid)',                     '13_abandoned_carts'),
  ('public.stop_cart_recovery(uuid)',                    '13_abandoned_carts'),
  ('public.record_finder_response(uuid,jsonb,text,integer[],jsonb,uuid)', '14_finder'),
  ('public.get_best_sellers(integer,integer)',           '16_storefront_content'),
  ('public.track_event(uuid,text,integer,numeric,text,jsonb)', '17_analytics'),
  ('public.get_site_lock()',                             '18_site_lock'),
  ('public.verify_site_lock_pin(text)',                  '18_site_lock'),
  ('public.log_assistant_turn(uuid,text,text,text,integer[],integer[],integer[],text,text[],text[],text,text,integer,integer,integer,boolean,text,text,integer)', '19_assistant_core'),
  ('public.list_live_offers(uuid)',                      '20_assistant_offers'),
  ('public.lookup_order_for_assistant(text,text,uuid,text)', '21_assistant_memory_lookup'),
  ('public.run_retention(text)',                         '22_retention (secret)');

CREATE TEMP TABLE allow_authenticated (fn text PRIMARY KEY, migration text NOT NULL); -- grant U (NOT anon)
INSERT INTO allow_authenticated (fn, migration) VALUES
  ('public.is_admin()', '02_customers_and_auth'),
  ('public._viewer_verified_email()',                                  '07_orders (owner-read policies)'),
  ('public.admin_set_order_status(text,text,text,text,numeric,text)', '09_order_rpcs'),
  ('public.admin_set_payment_status(text,text,text)',                  '09_order_rpcs'),
  ('public.merge_wishlist(integer[])',                                 '10_wishlists'),
  ('public.submit_review(integer,integer,text,text,text)',             '11_reviews'),
  ('public.admin_newsletter_mailing_list()',                           '12_leads'),
  ('public.admin_finder_insights(integer)',                            '14_finder'),
  ('public.admin_reorder_hero_slides(integer[])',                      '16_storefront_content'),
  ('public.admin_set_featured_collections(text[])',                    '16_storefront_content'),
  ('public.admin_sales_overview(date,date)',                          '17_analytics'),
  ('public.admin_funnel(integer)',                                     '17_analytics'),
  ('public.admin_top_products(integer,integer)',                       '17_analytics'),
  ('public.admin_search_terms(integer,integer)',                       '17_analytics'),
  ('public.admin_low_stock(integer)',                                  '17_analytics'),
  ('public.admin_recovery_stats(integer)',                             '17_analytics'),
  ('public.admin_newsletter_growth(integer)',                          '17_analytics'),
  ('public.admin_order_status_counts()',                               '17_analytics'),
  ('public.admin_site_lock_state()',                                   '18_site_lock'),
  ('public.admin_site_lock_token()',                                   '18_site_lock'),
  ('public.set_site_lock(boolean,text,text,text,numeric,boolean,boolean)', '18_site_lock'),
  ('public.admin_assistant_overview(integer)',                         '19_assistant_core'),
  ('public.admin_assistant_sessions(integer,boolean,integer,integer)', '19_assistant_core'),
  ('public.admin_assistant_transcript(uuid)',                          '19_assistant_core'),
  ('public.admin_offer_performance(timestamptz,timestamptz,boolean)',  '20_assistant_offers'),
  ('public.get_assistant_customer_context(uuid,text)',                 '21_assistant_memory_lookup'),
  ('public.forget_assistant_customer(uuid)',                           '21_assistant_memory_lookup'),
  ('public.admin_save_product(jsonb,jsonb)',                           '23_admin_catalogue'),
  ('public.admin_set_collection_products(text,integer[])',             '23_admin_catalogue');

-- tables no API role may touch at all (nobody), or only admins through RLS (anon never)
CREATE TEMP TABLE sealed_tables (tbl text PRIMARY KEY, sealed_from text[] NOT NULL, migration text NOT NULL);
INSERT INTO sealed_tables (tbl, sealed_from, migration) VALUES
  ('public.app_config',      ARRAY['anon', 'authenticated'], '01_foundation'),
  ('public.rate_limit_hits', ARRAY['anon', 'authenticated'], '01_foundation'),
  ('public.customers',       ARRAY['anon'],                  '02_customers_and_auth'),
  ('public.product_costs',   ARRAY['anon'],                  '04_catalogue'),
  ('public.inventory',       ARRAY['anon'],                  '05_inventory'),
  ('public.orders',          ARRAY['anon'],                  '07_orders'),
  ('public.order_items',     ARRAY['anon'],                  '07_orders'),
  ('public.order_tracking',  ARRAY['anon'],                  '07_orders'),
  ('public.discounts',       ARRAY['anon'],                  '08_discounts'),
  ('public.wishlists',       ARRAY['anon'],                  '10_wishlists'),
  ('public.email_suppressions',     ARRAY['anon', 'authenticated'], '12_leads'),
  ('public.newsletter_subscribers', ARRAY['anon'],                  '12_leads'),
  ('public.contact_inquiries',      ARRAY['anon'],                  '12_leads'),
  ('public.abandoned_carts',        ARRAY['anon'],                  '13_abandoned_carts'),
  ('public.finder_responses',       ARRAY['anon'],                  '14_finder'),
  ('public.analytics_events',       ARRAY['anon'],                  '17_analytics'),
  ('public.site_lock',              ARRAY['anon', 'authenticated'], '18_site_lock'),
  ('public.assistant_sessions',      ARRAY['anon'],                  '19_assistant_core'),
  ('public.assistant_messages',      ARRAY['anon'],                  '19_assistant_core'),
  ('public.assistant_order_lookups', ARRAY['anon'],                  '21_assistant_memory_lookup');

-- ── the lists themselves are valid ──────────────────────────────────────────
SELECT pg_temp.eq((SELECT string_agg(fn || ' (' || migration || ')', ', ' ORDER BY fn)
                     FROM (SELECT fn, migration FROM allow_anon UNION ALL SELECT fn, migration FROM allow_authenticated) a
                    WHERE to_regprocedure(fn) IS NULL), NULL::text,
                  'every allowlisted function exists with that exact signature');
SELECT pg_temp.eq((SELECT string_agg(tbl, ', ') FROM sealed_tables WHERE to_regclass(tbl) IS NULL), NULL::text,
                  'every sealed table exists');

-- functions we own (extension members such as pg_trgm's are not ours to audit)
CREATE TEMP VIEW our_functions AS
  SELECT p.oid, n.nspname || '.' || p.oid::regprocedure::text AS label, p.prosecdef, p.proconfig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e');

-- ── EXECUTE surface ─────────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT string_agg(f.label, ', ' ORDER BY f.label) FROM our_functions f
                    WHERE has_function_privilege('anon', f.oid, 'EXECUTE')
                      AND f.oid NOT IN (SELECT to_regprocedure(fn) FROM allow_anon WHERE to_regprocedure(fn) IS NOT NULL)),
                  NULL::text,
                  'anon can execute ONLY allowlisted functions (fix: REVOKE ALL ON FUNCTION … FROM PUBLIC, anon, authenticated; or add a row to allow_anon)');
SELECT pg_temp.eq((SELECT string_agg(f.label, ', ' ORDER BY f.label) FROM our_functions f
                    WHERE has_function_privilege('authenticated', f.oid, 'EXECUTE')
                      AND f.oid NOT IN (SELECT to_regprocedure(fn) FROM allow_anon WHERE to_regprocedure(fn) IS NOT NULL
                                        UNION ALL
                                        SELECT to_regprocedure(fn) FROM allow_authenticated WHERE to_regprocedure(fn) IS NOT NULL)),
                  NULL::text,
                  'authenticated can execute ONLY allowlisted functions (fix: revoke, or add a row to allow_authenticated)');
SELECT pg_temp.eq((SELECT string_agg(fn, ', ' ORDER BY fn) FROM allow_anon
                    WHERE to_regprocedure(fn) IS NOT NULL
                      AND NOT (has_function_privilege('anon', to_regprocedure(fn), 'EXECUTE')
                               AND has_function_privilege('authenticated', to_regprocedure(fn), 'EXECUTE'))),
                  NULL::text, 'every allow_anon function really is executable by anon and authenticated (grant A)');
SELECT pg_temp.eq((SELECT string_agg(fn, ', ' ORDER BY fn) FROM allow_authenticated
                    WHERE to_regprocedure(fn) IS NOT NULL
                      AND (NOT has_function_privilege('authenticated', to_regprocedure(fn), 'EXECUTE')
                           OR has_function_privilege('anon', to_regprocedure(fn), 'EXECUTE'))),
                  NULL::text, 'every allow_authenticated function is executable by authenticated and NOT by anon (grant U)');
SELECT pg_temp.eq((SELECT string_agg(f.label, ', ' ORDER BY f.label) FROM our_functions f
                    WHERE f.prosecdef
                      AND NOT EXISTS (SELECT 1 FROM unnest(COALESCE(f.proconfig, '{}')) c WHERE c LIKE 'search_path=%')),
                  NULL::text, 'every SECURITY DEFINER function pins its search_path');

-- ── tables ──────────────────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT string_agg(c.oid::regclass::text, ', ' ORDER BY 1)
                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity),
                  NULL::text, 'RLS is enabled on every public table');
SELECT pg_temp.eq((SELECT string_agg(format('%s.%s/%s (%s)', schemaname, tablename, policyname, cmd), ', ' ORDER BY 1)
                     FROM pg_policies
                    WHERE schemaname IN ('public', 'storage')
                      AND roles && ARRAY['anon', 'public']::name[]
                      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')),
                  NULL::text, 'no policy anywhere lets anon/PUBLIC insert, update or delete (every public write is an RPC)');
SELECT pg_temp.eq((SELECT string_agg(format('%s.%s/%s', schemaname, tablename, policyname), ', ' ORDER BY 1)
                     FROM pg_policies
                    WHERE schemaname IN ('public', 'storage') AND cmd IN ('UPDATE', 'ALL') AND with_check IS NULL),
                  NULL::text, 'every UPDATE/ALL policy has an explicit WITH CHECK');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s', c.oid::regclass, pr.p), ', ' ORDER BY 1)
                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     CROSS JOIN unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS pr(p)
                    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
                      AND has_table_privilege('anon', c.oid, pr.p)),
                  NULL::text,
                  'anon holds no INSERT/UPDATE/DELETE/TRUNCATE on any public table (fix: REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.<t> FROM anon)');
SELECT pg_temp.eq((SELECT string_agg(c.oid::regclass::text, ', ' ORDER BY 1)
                     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
                      AND has_table_privilege('authenticated', c.oid, 'TRUNCATE')),
                  NULL::text,
                  'authenticated holds no TRUNCATE on any public table (fix: REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.<t> FROM authenticated)');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s', s.tbl, r.role, pr.p), ', ' ORDER BY 1)
                     FROM sealed_tables s
                     CROSS JOIN LATERAL unnest(s.sealed_from) AS r(role)
                     CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']) AS pr(p)
                    WHERE to_regclass(s.tbl) IS NOT NULL AND has_table_privilege(r.role, to_regclass(s.tbl), pr.p)),
                  NULL::text, 'sealed tables grant nothing to the roles they are sealed from');

-- ── behavioural spot checks as the real roles ───────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT public.verify_job_secret(''rate_limit'', ''x'')', '42501', 'live: anon cannot call an internal helper');
SELECT pg_temp.throws('SELECT * FROM public.app_config', '42501', 'live: anon cannot read app_config');
SELECT pg_temp.logout();

-- ── internal helpers and trigger functions are never callable (SQL-REST, migrations 01–22) ──
CREATE TEMP TABLE internal_helpers (fn text PRIMARY KEY, migration text NOT NULL);
INSERT INTO internal_helpers (fn, migration) VALUES
  ('public.verify_job_secret(text,text)',                  '01_foundation'),
  ('public._rate_limit_hit(text,integer,integer)',         '01_foundation'),
  ('public.link_guest_orders(uuid,text)',                  '02_customers_and_auth'),
  ('public.refresh_product_from_price(integer)',           '04_catalogue'),
  ('public._apply_product_rating(integer,numeric,integer)', '04_catalogue'),
  ('public._normalize_order_ref(text)',                    '09_order_rpcs'),
  ('public._parse_order_items(jsonb)',                     '09_order_rpcs'),
  ('public._discount_check(text,numeric)',                 '09_order_rpcs'),
  ('public._order_view(text)',                             '09_order_rpcs'),
  ('public.refresh_product_rating(integer)',               '11_reviews'),
  ('public._business_tz()',                                '17_analytics'),
  ('public._business_window_start(integer)',               '17_analytics'),
  ('public.redact_pii(text)',                              '19_assistant_core'),
  ('public.clamp_ints(integer[],integer)',                 '19_assistant_core'),
  ('public.clamp_labels(text[],integer,integer)',          '19_assistant_core');
SELECT pg_temp.eq((SELECT string_agg(fn, ', ' ORDER BY fn) FROM internal_helpers WHERE to_regprocedure(fn) IS NULL), NULL::text,
                  'every named internal helper exists');
SELECT pg_temp.eq((SELECT string_agg(fn, ', ' ORDER BY fn) FROM internal_helpers
                    WHERE to_regprocedure(fn) IS NOT NULL
                      AND (has_function_privilege('anon', to_regprocedure(fn), 'EXECUTE')
                           OR has_function_privilege('authenticated', to_regprocedure(fn), 'EXECUTE'))),
                  NULL::text, 'internal helpers are executable by neither anon nor authenticated');
SELECT pg_temp.eq((SELECT string_agg(f.label, ', ' ORDER BY f.label) FROM our_functions f JOIN pg_proc p ON p.oid = f.oid
                    WHERE p.prorettype = 'trigger'::regtype
                      AND (has_function_privilege('anon', f.oid, 'EXECUTE') OR has_function_privilege('authenticated', f.oid, 'EXECUTE'))),
                  NULL::text, 'no trigger function is executable by anon or authenticated');
SELECT pg_temp.eq((SELECT string_agg(fn, ', ' ORDER BY fn)
                     FROM (SELECT fn FROM allow_anon INTERSECT SELECT fn FROM allow_authenticated) x), NULL::text,
                  'no function is listed as both grant A and grant U');

-- ── sealed tables, live: anon and a signed-in shopper get 42501 ─────────────
SELECT set_config('t.shopper99', pg_temp.new_user('audit-shopper@shop.test')::text, false);
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT 1 FROM public.rate_limit_hits LIMIT 1',    '42501', 'live: anon cannot read rate_limit_hits');
SELECT pg_temp.throws('SELECT 1 FROM public.email_suppressions LIMIT 1', '42501', 'live: anon cannot read email_suppressions');
SELECT pg_temp.throws('SELECT 1 FROM public.site_lock LIMIT 1',          '42501', 'live: anon cannot read site_lock');
SELECT pg_temp.throws('SELECT 1 FROM public.product_costs LIMIT 1',      '42501', 'live: anon cannot read product_costs');
SELECT pg_temp.throws('SELECT 1 FROM public.abandoned_carts LIMIT 1',    '42501', 'live: anon cannot read abandoned_carts');
SELECT pg_temp.throws('SELECT 1 FROM public.assistant_messages LIMIT 1', '42501', 'live: anon cannot read assistant_messages');
SELECT pg_temp.throws('SELECT public._rate_limit_hit(''x'', 1, 60)',     '42501', 'live: anon cannot hit the limiter directly');
SELECT pg_temp.throws('SELECT public.redact_pii(''x'')',                 '42501', 'live: anon cannot call redact_pii');
SELECT pg_temp.login(current_setting('t.shopper99')::uuid);
SELECT pg_temp.throws('SELECT 1 FROM public.app_config LIMIT 1',         '42501', 'live: a shopper cannot read app_config');
SELECT pg_temp.throws('SELECT 1 FROM public.rate_limit_hits LIMIT 1',    '42501', 'live: a shopper cannot read rate_limit_hits');
SELECT pg_temp.throws('SELECT 1 FROM public.email_suppressions LIMIT 1', '42501', 'live: a shopper cannot read email_suppressions');
SELECT pg_temp.throws('SELECT 1 FROM public.site_lock LIMIT 1',          '42501', 'live: a shopper cannot read site_lock');
SELECT pg_temp.throws('SELECT public.verify_job_secret(''rate_limit'', ''x'')', '42501', 'live: a shopper cannot call verify_job_secret');
SELECT pg_temp.throws('SELECT public.link_guest_orders(gen_random_uuid(), ''x@y.lk'')', '42501', 'live: a shopper cannot call link_guest_orders');
SELECT pg_temp.logout();
