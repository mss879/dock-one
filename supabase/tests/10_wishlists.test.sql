-- 10_wishlists.test.sql — owner RLS (select / insert / delete own), no updates, admin read-only,
-- and merge_wishlist() (sign-in merge of the guest's local list).
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.ana', pg_temp.new_user('ana@shop.test')::text, false);
SELECT set_config('t.ben', pg_temp.new_user('ben@shop.test')::text, false);
-- an auth account with no email (anonymous sign-in) has no customers row
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000a1', NULL);

INSERT INTO public.categories (id, name) VALUES ('wl-cat', 'Wishlist');
INSERT INTO public.products (slug, brand, name, category_id)
SELECT 'wl-' || lpad(g::text, 3, '0'), 'WlBrand', 'Wl ' || g, 'wl-cat' FROM generate_series(1, 130) g;
INSERT INTO public.products (slug, brand, name, category_id) VALUES ('wl-hidden', 'WlBrand', 'Wl Hidden', 'wl-cat'),
                                                                   ('wl-novariant', 'WlBrand', 'Wl No Variant', 'wl-cat');
INSERT INTO public.product_variants (product_id, name, price)
SELECT id, 'Standard', 100 FROM public.products WHERE slug LIKE 'wl-%' AND slug <> 'wl-novariant';
UPDATE public.products SET is_active = FALSE WHERE slug = 'wl-hidden';
CREATE FUNCTION pg_temp.p(p_n int) RETURNS int LANGUAGE sql AS
  $$ SELECT (current_setting('t.wl')::jsonb ->> p_n::text)::int $$;
SELECT set_config('t.wl', (SELECT jsonb_object_agg(ltrim(substr(slug, 4), '0'), id) FROM public.products
                            WHERE slug ~ '^wl-[0-9]{3}$')::text, false);
SELECT set_config('t.hidden', (SELECT id FROM public.products WHERE slug = 'wl-hidden')::text, false);
SELECT set_config('t.novar', (SELECT id FROM public.products WHERE slug = 'wl-novariant')::text, false);

-- ── shape ───────────────────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey::int2[], a.attnum))
                     FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
                    WHERE i.indrelid = 'public.wishlists'::regclass AND i.indisprimary),
                  'customer_id,product_id,list_type', 'primary key on (customer_id, product_id, list_type)');

-- ── anon ────────────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT * FROM public.wishlists', '42501', 'anon cannot read wishlists');
SELECT pg_temp.throws(format('INSERT INTO public.wishlists (customer_id, product_id) VALUES (%L, %s)', current_setting('t.ana'), pg_temp.p(1)),
                      '42501', 'anon cannot write wishlists');
SELECT pg_temp.throws('SELECT public.merge_wishlist(ARRAY[1])', '42501', 'anon cannot merge');
SELECT pg_temp.logout();

-- ── owner verbs ─────────────────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.ana')::uuid);
SELECT pg_temp.eq(pg_temp.affected(format('INSERT INTO public.wishlists (customer_id, product_id) VALUES (%L, %s)',
                                          current_setting('t.ana'), pg_temp.p(3))), 1::bigint, 'Ana saves a favourite');
SELECT pg_temp.eq(pg_temp.affected(format('INSERT INTO public.wishlists (customer_id, product_id, list_type) VALUES (%L, %s, %L)',
                                          current_setting('t.ana'), pg_temp.p(4), 'buy_later')), 1::bigint, 'Ana saves for later');
SELECT pg_temp.eq((SELECT list_type FROM public.wishlists WHERE product_id = pg_temp.p(3)), 'favorite', 'list_type defaults to favorite');
SELECT pg_temp.throws(format('INSERT INTO public.wishlists (customer_id, product_id) VALUES (%L, %s)', current_setting('t.ana'), pg_temp.p(3)),
                      '23505', 'the same product twice on one list is refused');
SELECT pg_temp.throws(format('INSERT INTO public.wishlists (customer_id, product_id, list_type) VALUES (%L, %s, %L)',
                             current_setting('t.ana'), pg_temp.p(5), 'cart'), '23514', 'list_type is favorite | buy_later', '%wishlists_list_type_valid%');
SELECT pg_temp.throws(format('INSERT INTO public.wishlists (customer_id, product_id) VALUES (%L, %s)', current_setting('t.ben'), pg_temp.p(5)),
                      '42501', 'Ana cannot write into Ben''s wishlist');
SELECT pg_temp.throws(format('UPDATE public.wishlists SET list_type = %L', 'buy_later'), '42501',
                      'no updates: moving between lists is delete + insert');
SELECT pg_temp.login(current_setting('t.ben')::uuid);
SELECT pg_temp.eq(pg_temp.affected(format('INSERT INTO public.wishlists (customer_id, product_id) VALUES (%L, %s)',
                                          current_setting('t.ben'), pg_temp.p(6))), 1::bigint, 'Ben saves a favourite');
SELECT pg_temp.eq((SELECT count(*) FROM public.wishlists), 1::bigint, 'Ben sees only his own rows');
SELECT pg_temp.eq(pg_temp.affected(format('DELETE FROM public.wishlists WHERE customer_id = %L', current_setting('t.ana'))), 0::bigint,
                  'Ben cannot delete Ana''s rows');
SELECT pg_temp.throws('TRUNCATE public.wishlists', '42501', 'a shopper cannot truncate wishlists');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.wishlists), 3::bigint, 'the admin reads every wishlist');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.wishlists$$), 0::bigint, 'the admin read is read-only');
SELECT pg_temp.login(current_setting('t.ana')::uuid);
SELECT pg_temp.eq(pg_temp.affected(format('DELETE FROM public.wishlists WHERE product_id = %s', pg_temp.p(4))), 1::bigint, 'Ana removes her own row');
SELECT pg_temp.logout();

-- ── merge_wishlist ──────────────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.ana')::uuid);
SELECT set_config('t.m1', public.merge_wishlist(ARRAY[pg_temp.p(1), pg_temp.p(1), current_setting('t.hidden')::int,
                                                       current_setting('t.novar')::int, 999999, NULL, pg_temp.p(2)])::text, false);
SELECT set_config('t.m2', public.merge_wishlist(ARRAY[pg_temp.p(2), pg_temp.p(1)])::text, false);
SELECT set_config('t.m3', public.merge_wishlist(NULL)::text, false);
SELECT set_config('t.m_rows', (SELECT count(*) FROM public.wishlists)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.m1'),
                  format('{%s,%s,%s}', GREATEST(pg_temp.p(1), pg_temp.p(2)), LEAST(pg_temp.p(1), pg_temp.p(2)), pg_temp.p(3)),
                  'merge adds visible products only (no duplicates, hidden, variant-less, unknown or NULL ids) and returns the favourites newest first');
SELECT pg_temp.eq(current_setting('t.m2'), current_setting('t.m1'), 'merging again changes nothing (idempotent)');
SELECT pg_temp.eq(current_setting('t.m3'), current_setting('t.m1'), 'a NULL list just returns the account''s favourites');
SELECT pg_temp.eq(current_setting('t.m_rows'), '3', 'Ana holds exactly three rows after the merges');

-- at most 100 distinct ids are taken, in the order given
SELECT pg_temp.login(current_setting('t.ben')::uuid);
SELECT set_config('t.m4', cardinality(public.merge_wishlist(ARRAY(SELECT pg_temp.p(g) FROM generate_series(130, 1, -1) g)))::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.m4'), '101', 'merge takes the first 100 distinct ids (Ben already had one saved)');
SELECT pg_temp.eq((SELECT count(*) FROM public.wishlists WHERE customer_id = current_setting('t.ben')::uuid
                                                         AND product_id IN (pg_temp.p(130), pg_temp.p(31))), 2::bigint,
                  'the first 100 of the list are the ones kept');
SELECT pg_temp.eq((SELECT count(*) FROM public.wishlists WHERE customer_id = current_setting('t.ben')::uuid
                                                         AND product_id = pg_temp.p(30)), 0::bigint,
                  'the 101st id is ignored');

-- a saved product that is later hidden stays saved but is not returned
UPDATE public.products SET is_active = FALSE WHERE id = pg_temp.p(3);
SELECT pg_temp.login(current_setting('t.ana')::uuid);
SELECT set_config('t.m5', public.merge_wishlist('{}')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.m5'), format('{%s,%s}', GREATEST(pg_temp.p(1), pg_temp.p(2)), LEAST(pg_temp.p(1), pg_temp.p(2))),
                  'hidden products drop out of the returned list');
SELECT pg_temp.eq((SELECT count(*) FROM public.wishlists WHERE customer_id = current_setting('t.ana')::uuid), 3::bigint,
                  '…but their rows are kept (they come back if the product returns)');

-- an account without a customers row cannot merge
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000a1');
SELECT pg_temp.throws('SELECT public.merge_wishlist(ARRAY[1])', 'P0001', 'no customers row → not_signed_in', 'not_signed_in');
SELECT pg_temp.logout();

-- ── the exact PostgREST shapes lib/wishlist.ts uses (WP-D) ──────────────────
-- save = insert(...).select('product_id'); remove = delete()...select('product_id'): RETURNING
-- must pass the owner's SELECT policy.
SELECT pg_temp.login(current_setting('t.ana')::uuid);
SELECT pg_temp.eq(pg_temp.affected(format('INSERT INTO public.wishlists (customer_id, product_id, list_type) VALUES (%L, %s, %L) RETURNING product_id',
                                          current_setting('t.ana'), pg_temp.p(7), 'favorite')), 1::bigint,
                  'save: INSERT … RETURNING gives the owner their row back');
SELECT pg_temp.eq(pg_temp.affected(format('DELETE FROM public.wishlists WHERE customer_id = %L AND product_id = %s AND list_type = %L RETURNING product_id',
                                          current_setting('t.ana'), pg_temp.p(7), 'favorite')), 1::bigint,
                  'remove: DELETE … RETURNING reports the removed row');
SELECT pg_temp.eq(pg_temp.affected(format('DELETE FROM public.wishlists WHERE customer_id = %L AND product_id = %s AND list_type = %L RETURNING product_id',
                                          current_setting('t.ana'), pg_temp.p(7), 'favorite')), 0::bigint,
                  'removing it again is a harmless no-op (0 rows, no error)');
SELECT pg_temp.logout();

-- an admin's merge is scoped to the admin's own account (RLS would let an admin READ everyone's rows)
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.m_owner', public.merge_wishlist(ARRAY[pg_temp.p(9)])::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.m_owner'), format('{%s}', pg_temp.p(9)), 'an admin''s merge returns only the admin''s own favourites');
