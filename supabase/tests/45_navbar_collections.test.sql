-- 45_navbar_collections.test.sql — the navbar sale collection: the switch, one at a time (switching
-- one on takes the other out), the 11.11 / Black Friday collections created once, and who may
-- change it.
\ir _helpers.sql

-- ── 1. the seed ─────────────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT title FROM public.collections WHERE id = '11-11'), '11.11', 'the 11.11 collection exists (/collection/11-11)');
SELECT pg_temp.ok((SELECT is_active AND show_in_nav FROM public.collections WHERE id = '11-11'), '11.11 is active and in the navbar');
SELECT pg_temp.eq((SELECT title FROM public.collections WHERE id = 'black-friday'), 'Black Friday', 'the Black Friday collection exists');
SELECT pg_temp.ok((SELECT NOT is_active AND NOT show_in_nav FROM public.collections WHERE id = 'black-friday'),
                  'Black Friday waits hidden and out of the navbar');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_collections WHERE collection_id IN ('11-11', 'black-friday')), 0::bigint,
                  'both start with no products (the shop adds them)');
SELECT pg_temp.ok((SELECT bool_and(type = 'manual' AND description IS NULL AND subtitle IS NULL AND cover_image IS NULL AND NOT is_featured)
                     FROM public.collections WHERE id IN ('11-11', 'black-friday')),
                  'title and slug only: no invented copy or images, not on the homepage');
SELECT pg_temp.eq((SELECT count(*) FROM public.collections WHERE show_in_nav), 1::bigint, 'exactly one collection is in the navbar');

-- ── 2. the admin switches 11.11 for Black Friday ────────────────────────────
SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);

SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.collections SET show_in_nav = TRUE, is_active = TRUE WHERE id = 'black-friday'$$), 1::bigint,
                  'the admin puts Black Friday in the navbar (switched on and made active)');
SELECT pg_temp.eq((SELECT string_agg(id, ',') FROM public.collections WHERE show_in_nav), 'black-friday',
                  'which takes 11.11 out in the same save');
SELECT pg_temp.ok((SELECT is_active FROM public.collections WHERE id = '11-11'), '11.11 itself stays active (its page still works)');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.collections SET title = 'Black Friday Week' WHERE id = 'black-friday'$$), 1::bigint,
                  'the navbar collection can be edited');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.collections SET id = 'black-friday-2026', show_in_nav = TRUE WHERE id = 'black-friday'$$), 1::bigint,
                  'and renamed while it stays switched on');
SELECT pg_temp.eq((SELECT string_agg(id, ',') FROM public.collections WHERE show_in_nav), 'black-friday-2026', 'still the only one in the navbar');
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO public.collections (id, title, show_in_nav) VALUES ('cyber-monday', 'Cyber Monday', TRUE)$$),
                  1::bigint, 'a new collection can be created straight into the navbar');
SELECT pg_temp.eq((SELECT string_agg(id, ',') FROM public.collections WHERE show_in_nav), 'cyber-monday', 'replacing the previous one');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.collections SET is_active = FALSE WHERE id = 'cyber-monday'$$), 1::bigint,
                  'hiding the navbar collection is allowed (nothing shows then)');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.collections SET show_in_nav = FALSE WHERE show_in_nav$$), 1::bigint,
                  'and so is switching it off');
SELECT pg_temp.eq((SELECT count(*) FROM public.collections WHERE show_in_nav), 0::bigint, 'the navbar can have no sale at all');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.collections SET show_in_nav = TRUE WHERE id IN ('11-11', 'cyber-monday')$$), 2::bigint,
                  'switching two on in one statement runs');
SELECT pg_temp.eq((SELECT count(*) FROM public.collections WHERE show_in_nav), 1::bigint, 'but leaves only one of them on');

-- the unique index is the backstop when a switch-off can't happen
SELECT pg_temp.affected($$UPDATE public.collections SET show_in_nav = FALSE WHERE show_in_nav$$);
SELECT pg_temp.logout();
ALTER TABLE public.collections DISABLE TRIGGER collections_20_nav_switch;
UPDATE public.collections SET show_in_nav = TRUE WHERE id = '11-11';
SELECT pg_temp.throws($$UPDATE public.collections SET show_in_nav = TRUE WHERE id = 'cyber-monday'$$,
                      '23505', 'two switched-on collections can never be stored', '%collections_nav_one%');
ALTER TABLE public.collections ENABLE TRIGGER collections_20_nav_switch;

-- ── 3. shoppers read it, only admins change it ──────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.ok((SELECT show_in_nav FROM public.collections WHERE id = '11-11'), 'anon reads the switch of an active collection');
SELECT pg_temp.eq((SELECT count(*) FROM public.collections WHERE id = 'cyber-monday'), 0::bigint, 'and never sees a hidden one');
SELECT pg_temp.throws($$UPDATE public.collections SET show_in_nav = FALSE WHERE id = '11-11'$$, '42501', 'anon cannot change it');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.collections SET show_in_nav = FALSE WHERE id = '11-11'$$), 0::bigint,
                  'a signed-in shopper changes nothing (admin RLS)');
SELECT pg_temp.logout();
SELECT pg_temp.ok((SELECT show_in_nav FROM public.collections WHERE id = '11-11'), '11.11 is still in the navbar');
SELECT pg_temp.ok(NOT has_function_privilege('anon', 'public.collections_nav_switch()', 'EXECUTE')
                  AND NOT has_function_privilege('authenticated', 'public.collections_nav_switch()', 'EXECUTE'),
                  'the switch trigger function is not callable through the API');

-- ── 4. created once: a re-run keeps the shop's edits and deletes ────────────
UPDATE public.collections SET title = '11.11 Mega Sale' WHERE id = '11-11';
DELETE FROM public.collections WHERE id = 'black-friday-2026';
\ir ../migrations/45_navbar_collections.sql
SELECT pg_temp.eq((SELECT title FROM public.collections WHERE id = '11-11'), '11.11 Mega Sale', 'a re-run keeps the edited title');
SELECT pg_temp.eq((SELECT count(*) FROM public.collections WHERE id IN ('black-friday', 'black-friday-2026')), 0::bigint,
                  'and never brings back a deleted collection');

-- With the marker gone (a deliberate re-seed), existing slugs are left alone and the navbar is kept.
DELETE FROM public.app_config WHERE name = 'seed_45_sale_collections';
UPDATE public.collections SET show_in_nav = TRUE, is_active = TRUE WHERE id = 'cyber-monday';
DELETE FROM public.collections WHERE id = '11-11';
\ir ../migrations/45_navbar_collections.sql
SELECT pg_temp.ok((SELECT NOT show_in_nav AND is_active FROM public.collections WHERE id = '11-11'),
                  're-seeding recreates a missing 11.11 without taking over the navbar');
SELECT pg_temp.eq((SELECT string_agg(id, ',') FROM public.collections WHERE show_in_nav), 'cyber-monday', 'the shop''s navbar choice stays');
SELECT pg_temp.ok((SELECT NOT is_active AND NOT show_in_nav FROM public.collections WHERE id = 'black-friday'),
                  'and recreates Black Friday hidden');
