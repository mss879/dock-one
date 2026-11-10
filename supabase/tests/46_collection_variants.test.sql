-- 46_collection_variants.test.sql — which variants of a product a collection holds: the pick and its
-- checks, admin_set_collection_members (and 23's call leaving picks alone), deleted or moved variants
-- leaving the picks, what shoppers can read, access (anon, shopper, staff), and a re-run.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);

-- an API request as seen by PostgREST (39's staff checks read it)
CREATE FUNCTION pg_temp.req(p_method text, p_path text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.method', p_method, false), set_config('request.path', p_path, false)
$$;

-- the members of cv-sale in order: "<product>=<pick>" with "all" for the whole product
CREATE FUNCTION pg_temp.members(p_collection text) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(format('%s=%s', p.slug, COALESCE((SELECT string_agg(v.name, '+' ORDER BY v.position)
                                                        FROM public.product_variants v WHERE v.id = ANY (pc.variant_ids)), 'all')),
                    ' ' ORDER BY pc.position, pc.product_id)
    FROM public.product_collections pc JOIN public.products p ON p.id = pc.product_id
   WHERE pc.collection_id = p_collection
$$;

-- fixtures (as the superuser): a mouse in three colours, a laptop in two sizes, a cable, a headset
INSERT INTO public.categories (id, name) VALUES ('cv-cat', 'Variant picks');
INSERT INTO public.products (slug, brand, name, category_id) VALUES
  ('cv-mouse', 'CvBrand', 'Cv Mouse', 'cv-cat'), ('cv-laptop', 'CvBrand', 'Cv Laptop', 'cv-cat'),
  ('cv-cable', 'CvBrand', 'Cv Cable', 'cv-cat'), ('cv-headset', 'CvBrand', 'Cv Headset', 'cv-cat');
SELECT set_config('t.' || replace(slug, 'cv-', ''), id::text, false) FROM public.products WHERE slug LIKE 'cv-%';
INSERT INTO public.product_variants (product_id, name, price, compare_at_price, position) VALUES
  (current_setting('t.mouse')::int,   'Black',    9000,   10000,  0),
  (current_setting('t.mouse')::int,   'White',    10000,  NULL,   1),
  (current_setting('t.mouse')::int,   'Grey',     9000,   10000,  2),
  (current_setting('t.laptop')::int,  '16GB',     200000, 220000, 0),
  (current_setting('t.laptop')::int,  '32GB',     250000, NULL,   1),
  (current_setting('t.cable')::int,   'Standard', 1000,   NULL,   0),
  (current_setting('t.headset')::int, 'Red',      5000,   6000,   0),
  (current_setting('t.headset')::int, 'Blue',     5000,   NULL,   1);
SELECT set_config('t.v_' || lower(v.name) || '_' || replace(p.slug, 'cv-', ''), v.id::text, false)
  FROM public.product_variants v JOIN public.products p ON p.id = v.product_id WHERE p.slug LIKE 'cv-%';
INSERT INTO public.collections (id, title) VALUES ('cv-sale', 'Cv Sale');

-- ── 1. the column ───────────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT format('%s|%s', data_type, is_nullable) FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'product_collections' AND column_name = 'variant_ids'),
                  'ARRAY|YES', 'product_collections.variant_ids exists (a list of variant ids; NULL = the whole product)');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_collections WHERE variant_ids IS NOT NULL), 0::bigint,
                  'every member the migration found still holds its whole product');

-- ── 2. admin_set_collection_members ─────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.r1', public.admin_set_collection_members('cv-sale',
  ARRAY[current_setting('t.mouse')::int, current_setting('t.laptop')::int, current_setting('t.cable')::int],
  jsonb_build_object(current_setting('t.mouse'),  jsonb_build_array(current_setting('t.v_grey_mouse')::int, current_setting('t.v_black_mouse')::int,
                                                                    current_setting('t.v_grey_mouse')::int),
                     current_setting('t.laptop'), jsonb_build_array(current_setting('t.v_16gb_laptop')::int)))::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s', r ->> 'collection_id', r ->> 'manual_count', r ->> 'member_count', r ->> 'variant_picks')
                     FROM (SELECT current_setting('t.r1')::jsonb AS r) s),
                  'cv-sale|3|3|2', 'returns 23''s counts plus how many members hold a pick');
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-mouse=Black+Grey cv-laptop=16GB cv-cable=all',
                  'members in list order: the mouse holds Black and Grey, the laptop 16GB, the cable (not named) everything');
SELECT pg_temp.eq((SELECT variant_ids FROM public.product_collections WHERE collection_id = 'cv-sale' AND product_id = current_setting('t.mouse')::int),
                  ARRAY[current_setting('t.v_black_mouse')::int, current_setting('t.v_grey_mouse')::int],
                  'a pick is stored sorted and without the repeated id');

-- ── 3. refused picks (one transaction: the members stay as they were) ────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws(format($$SELECT public.admin_set_collection_members('cv-sale', ARRAY[%s], '{"%s": []}')$$,
                             current_setting('t.mouse'), current_setting('t.mouse')),
                      '22023', 'an empty pick is refused', 'invalid_variants:Pick at least one variant of product%');
SELECT pg_temp.throws(format($$SELECT public.admin_set_collection_members('cv-sale', ARRAY[%s], '{"%s": [%s]}')$$,
                             current_setting('t.mouse'), current_setting('t.mouse'), current_setting('t.v_16gb_laptop')),
                      '22023', 'another product''s variant is refused', 'invalid_variants:Variant % isn''t one of this product''s variants%');
SELECT pg_temp.throws(format($$SELECT public.admin_set_collection_members('cv-sale', ARRAY[%s], '{"%s": [%s]}')$$,
                             current_setting('t.mouse'), current_setting('t.laptop'), current_setting('t.v_16gb_laptop')),
                      '22023', 'a pick for a product that isn''t in the list is refused', 'invalid_variants:Variants were picked for a product%');
SELECT pg_temp.throws($$SELECT public.admin_set_collection_members('cv-sale', '{}', '[1, 2]')$$,
                      '22023', 'picks that aren''t an object are refused', 'invalid_variants:The variant picks must map%');
SELECT pg_temp.throws(format($$SELECT public.admin_set_collection_members('cv-sale', ARRAY[%s], '{"%s": ["%s"]}')$$,
                             current_setting('t.mouse'), current_setting('t.mouse'), current_setting('t.v_black_mouse')),
                      '22023', 'a variant id written as text is refused', 'invalid_variants:A variant id isn''t a whole number%');
SELECT pg_temp.throws(format($$SELECT public.admin_set_collection_members('cv-sale', ARRAY[%s], '{"%s": [1.5]}')$$,
                             current_setting('t.mouse'), current_setting('t.mouse')),
                      '22023', 'a fractional variant id is refused', 'invalid_variants:A variant id isn''t a whole number%');
SELECT pg_temp.throws(format($$SELECT public.admin_set_collection_members('no-such-sale', ARRAY[%s], '{}')$$, current_setting('t.mouse')),
                      '22023', '23''s own checks still apply (an unknown collection)', 'collection_not_found:%');
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-mouse=Black+Grey cv-laptop=16GB cv-cable=all', 'the refused calls changed nothing');

-- the same checks guard a direct table write (an admin through the API)
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws(format($$UPDATE public.product_collections SET variant_ids = '{}' WHERE collection_id = 'cv-sale' AND product_id = %s$$,
                             current_setting('t.mouse')),
                      '22023', 'a direct write of an empty pick is refused', 'invalid_variants:Pick at least one variant, or remove%');
SELECT pg_temp.throws(format($$UPDATE public.product_collections SET variant_ids = ARRAY[%s, NULL] WHERE collection_id = 'cv-sale' AND product_id = %s$$,
                             current_setting('t.v_black_mouse'), current_setting('t.mouse')),
                      '22023', 'a pick with an empty entry is refused', 'invalid_variants:The variant list has an empty entry%');
SELECT pg_temp.throws(format($$UPDATE public.product_collections SET variant_ids = ARRAY[%s, %s] WHERE collection_id = 'cv-sale' AND product_id = %s$$,
                             current_setting('t.v_black_mouse'), current_setting('t.v_standard_cable'), current_setting('t.mouse')),
                      '22023', 'adding another product''s variant directly is refused', 'invalid_variants:Variant % isn''t one%');
SELECT pg_temp.eq(pg_temp.affected(format($$UPDATE public.product_collections SET variant_ids = ARRAY[%s, %s, %s] WHERE collection_id = 'cv-sale' AND product_id = %s$$,
                                          current_setting('t.v_white_mouse'), current_setting('t.v_black_mouse'), current_setting('t.v_white_mouse'), current_setting('t.mouse'))),
                  1::bigint, 'an admin may write a valid pick directly');
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-mouse=Black+White cv-laptop=16GB cv-cable=all', '…and it is normalised the same way');
SELECT pg_temp.logout();

-- a member added by rules always holds the whole product
INSERT INTO public.collections (id, title, type, rules) VALUES ('cv-auto', 'Cv Auto', 'automated', '[{"field": "brand", "relation": "equals", "value": "CvBrand"}]');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_collections WHERE collection_id = 'cv-auto' AND source = 'rule'), 4::bigint,
                  'the rule collection picked up the four products (whole products)');
SELECT pg_temp.throws(format($$UPDATE public.product_collections SET variant_ids = ARRAY[%s] WHERE collection_id = 'cv-auto' AND product_id = %s$$,
                             current_setting('t.v_black_mouse'), current_setting('t.mouse')),
                      '22023', 'a pick on a rule member is refused', 'invalid_variants:A product added by rules always includes every variant%');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_set_collection_members('cv-auto', ARRAY[current_setting('t.mouse')::int],
                                           jsonb_build_object(current_setting('t.mouse'), jsonb_build_array(current_setting('t.v_grey_mouse')::int)));
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s', source, array_to_string(variant_ids, ',')) FROM public.product_collections
                    WHERE collection_id = 'cv-auto' AND product_id = current_setting('t.mouse')::int),
                  format('manual|%s', current_setting('t.v_grey_mouse')), 'hand-picking a rule member makes it manual, and then it can hold a pick');

-- ── 4. 23's admin_set_collection_products leaves picks alone ─────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_set_collection_products('cv-sale', ARRAY[current_setting('t.laptop')::int, current_setting('t.mouse')::int]);
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-laptop=16GB cv-mouse=Black+White',
                  'the older call (an admin page from before 46) reorders and removes without touching the picks');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_set_collection_members('cv-sale', ARRAY[current_setting('t.laptop')::int, current_setting('t.mouse')::int]);
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-laptop=all cv-mouse=all', 'with no picks named, every member holds its whole product again');

-- ── 5. deleted, moved and switched-off variants ─────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_set_collection_members('cv-sale',
  ARRAY[current_setting('t.mouse')::int, current_setting('t.laptop')::int, current_setting('t.headset')::int],
  jsonb_build_object(current_setting('t.mouse'),   jsonb_build_array(current_setting('t.v_black_mouse')::int, current_setting('t.v_grey_mouse')::int),
                     current_setting('t.laptop'),  jsonb_build_array(current_setting('t.v_16gb_laptop')::int, current_setting('t.v_32gb_laptop')::int),
                     current_setting('t.headset'), jsonb_build_array(current_setting('t.v_red_headset')::int, current_setting('t.v_blue_headset')::int)));
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-mouse=Black+Grey cv-laptop=16GB+32GB cv-headset=Red+Blue', 'picks set for the variant checks');

DELETE FROM public.product_variants WHERE id = current_setting('t.v_white_mouse')::int;
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-mouse=Black+Grey cv-laptop=16GB+32GB cv-headset=Red+Blue', 'deleting a variant nobody picked changes nothing');
DELETE FROM public.product_variants WHERE id = current_setting('t.v_grey_mouse')::int;
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-mouse=Black cv-laptop=16GB+32GB cv-headset=Red+Blue', 'a deleted picked variant drops out of the pick');
SELECT pg_temp.eq((SELECT format('%s|%s', source, COALESCE(array_to_string(variant_ids, ','), 'all')) FROM public.product_collections
                    WHERE collection_id = 'cv-auto' AND product_id = current_setting('t.mouse')::int),
                  'rule|all', 'in an automatic collection whose rules match, losing its only pick (Grey) hands the product back to the rules, whole');
DELETE FROM public.product_variants WHERE id = current_setting('t.v_black_mouse')::int;
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-laptop=16GB+32GB cv-headset=Red+Blue',
                  'deleting the last picked variant takes the product out, never back to "every variant"');

UPDATE public.product_variants SET product_id = current_setting('t.cable')::int WHERE id = current_setting('t.v_32gb_laptop')::int;
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-laptop=16GB cv-headset=Red+Blue', 'a variant moved to another product leaves the old product''s pick');

UPDATE public.product_variants SET is_active = FALSE WHERE id = current_setting('t.v_16gb_laptop')::int;
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-laptop=16GB cv-headset=Red+Blue', 'a switched-off variant stays picked (the storefront hides it)');
UPDATE public.product_variants SET is_active = TRUE WHERE id = current_setting('t.v_16gb_laptop')::int;

SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_save_product(jsonb_build_object('id', current_setting('t.headset')::int, 'slug', 'cv-headset', 'brand', 'CvBrand',
                                                    'name', 'Cv Headset', 'category_id', 'cv-cat'),
                                 jsonb_build_array(jsonb_build_object('id', current_setting('t.v_red_headset')::int, 'name', 'Red', 'price', 5000)));
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-laptop=16GB cv-headset=Red', 'a product save that drops a picked variant updates the pick too');

SELECT pg_temp.eq(pg_temp.affected(format('DELETE FROM public.products WHERE id = %s', current_setting('t.headset'))), 1::bigint,
                  'a product whose variants are picked can still be deleted');
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-laptop=16GB', '…and it leaves the collection with them');

-- ── 6. what shoppers can read, and who can write ────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT array_to_string(variant_ids, ',') FROM public.product_collections
                    WHERE collection_id = 'cv-sale' AND product_id = current_setting('t.laptop')::int),
                  current_setting('t.v_16gb_laptop'), 'a shopper (anon) reads the pick with the membership (the storefront needs it)');
SELECT pg_temp.throws($$SELECT public.admin_set_collection_members('cv-sale', '{}', '{}')$$, '42501', 'anon cannot execute admin_set_collection_members');
SELECT pg_temp.throws($$UPDATE public.product_collections SET variant_ids = NULL WHERE collection_id = 'cv-sale'$$, '42501', 'anon cannot write picks');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_set_collection_members('cv-sale', '{}', '{}')$$, '42501',
                      'a signed-in shopper is refused by the in-body admin check', 'not_authorised:%');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.product_collections SET variant_ids = NULL WHERE collection_id = 'cv-sale'$$), 0::bigint,
                  'a shopper''s direct write touches nothing (RLS)');
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-laptop=16GB', 'still the admin''s pick');

-- staff: Collections → edit may save picks, Collections → view may not
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.editor', public.admin_create_staff('editor@shop.test', 'Counter2026', 'Editor', '{"collections": "edit"}') ->> 'user_id', false);
SELECT set_config('t.viewer', public.admin_create_staff('viewer@shop.test', 'Counter2026', 'Viewer', '{"collections": "view"}') ->> 'user_id', false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(format('%s|%s|%s|%s', kind, area, view_level, edit_level), ' ') FROM public.staff_api_map
                    WHERE name = 'admin_set_collection_members'),
                  'rpc|collections|view|edit', 'mapped like admin_set_collection_products: Collections → edit');
SELECT pg_temp.login(current_setting('t.editor')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_set_collection_members');
SELECT pg_temp.eq(public.admin_set_collection_members('cv-sale', ARRAY[current_setting('t.laptop')::int, current_setting('t.cable')::int],
                    jsonb_build_object(current_setting('t.laptop'), jsonb_build_array(current_setting('t.v_16gb_laptop')::int))) ->> 'variant_picks',
                  '1', 'staff with Collections → edit can save members and picks');
SELECT pg_temp.login(current_setting('t.viewer')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_set_collection_members('cv-sale', '{}', '{}')$$, '42501',
                      'staff with Collections → view cannot', 'not_authorised:%');
SELECT pg_temp.req('', '');
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-laptop=16GB cv-cable=all', 'only the editor''s save landed');

SELECT pg_temp.eq((SELECT string_agg(p.proname, ', ' ORDER BY p.proname) FROM pg_proc p
                    WHERE p.pronamespace = 'public'::regnamespace
                      AND p.proname IN ('product_collections_check_variants', 'product_variants_leave_collections')
                      AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
                  NULL::text, 'the trigger functions can''t be called through the API');

-- ── 7. re-run ───────────────────────────────────────────────────────────────
\ir ../migrations/46_collection_variants.sql
SELECT pg_temp.eq(pg_temp.members('cv-sale'), 'cv-laptop=16GB cv-cable=all', 'a re-run keeps every pick');
SELECT pg_temp.eq((SELECT count(*) FROM public.staff_api_map WHERE migration = '46'), 1::bigint, 'a re-run keeps one staff map row');
SELECT pg_temp.eq((SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('public.product_collections'::regclass, 'public.product_variants'::regclass)
                     AND tgname IN ('product_collections_10_variants', 'product_variants_leave_collections_del', 'product_variants_leave_collections_move')),
                  3::bigint, 'a re-run leaves exactly the three triggers');
