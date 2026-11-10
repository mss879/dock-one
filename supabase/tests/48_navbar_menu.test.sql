-- 48_navbar_menu.test.sql — the store's main menu: the seed (the old navbar, Deals and New off),
-- public read, the one writer (admin_save_nav_menu) and its checks, what a deleted or renamed
-- category or collection does, staff access, and a re-run.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);

CREATE FUNCTION pg_temp.req(p_method text, p_path text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.method', p_method, false), set_config('request.path', p_path, false)
$$;

-- the menu as text: "Label(kind)[child, child]" in order, "-" marking a switched-off item
CREATE FUNCTION pg_temp.menu() RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(
           format('%s%s%s', CASE WHEN t.is_visible THEN '' ELSE '-' END,
                  COALESCE(t.label, t.category_id, t.collection_id),
                  COALESCE('[' || (SELECT string_agg(CASE WHEN c.is_visible THEN '' ELSE '-' END || COALESCE(c.label, c.category_id, c.collection_id), ', ' ORDER BY c.position)
                                     FROM public.nav_menu_items c WHERE c.parent_id = t.id) || ']', '')),
           ' / ' ORDER BY t.position)
    FROM public.nav_menu_items t WHERE t.parent_id IS NULL
$$;

-- ── 1. the seed: the navbar as it was, Deals and New switched off ────────────
SELECT pg_temp.eq(pg_temp.menu(),
  (SELECT format('Computing[%s] / Accessories[%s] / Cameras[%s] / -Deals / -New',
                 (SELECT string_agg(id, ', ' ORDER BY sort_order, name) FROM public.categories WHERE id = ANY (ARRAY['laptops', 'monitors', 'storage', 'components'])),
                 (SELECT string_agg(id, ', ' ORDER BY sort_order, name) FROM public.categories WHERE id = ANY (ARRAY['keyboards', 'mice', 'audio', 'power-charging'])),
                 (SELECT string_agg(id, ', ' ORDER BY sort_order, name) FROM public.categories WHERE id = ANY (ARRAY['cameras', 'polaroid-camera'])))),
  'seeded from the old navbar: three menus with their categories in admin order, then Deals and New switched off');
SELECT pg_temp.eq((SELECT string_agg(href, ' ' ORDER BY position) FROM public.nav_menu_items WHERE kind = 'link'), '/shop?filter=deals /shop?filter=new',
                  'Deals and New keep their addresses, ready to switch back on');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.app_config WHERE name = 'seed_48_navbar_menu'), 'the seed marker is recorded');

-- ── 2. everyone reads it; nobody but the save function writes it ─────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT count(*) FROM public.nav_menu_items WHERE NOT is_visible), 2::bigint,
                  'anon reads every row, switched-off ones too (the storefront needs them to place categories)');
SELECT pg_temp.throws($$INSERT INTO public.nav_menu_items (kind, label, href) VALUES ('link', 'X', '/x')$$, '42501', 'anon cannot insert');
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('[]')$$, '42501', 'anon cannot execute admin_save_nav_menu');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws($$UPDATE public.nav_menu_items SET is_visible = TRUE$$, '42501', 'a shopper cannot update rows');
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('[]')$$, '42501', 'a shopper is refused by the in-body admin check', 'not_authorised:%');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$DELETE FROM public.nav_menu_items$$, '42501', 'even an admin writes only through the save function');
SELECT pg_temp.logout();

-- ── 3. the save: the menu becomes exactly the list ───────────────────────────
INSERT INTO public.collections (id, title) VALUES ('nav-sale', 'Nav Sale');
INSERT INTO public.categories (id, name) VALUES ('nav-cat', 'Nav Cat');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.r1', public.admin_save_nav_menu('[
  {"kind": "menu", "label": " Shop by type ", "visible": true, "children": [
     {"kind": "category", "category_id": "nav-cat"},
     {"kind": "collection", "collection_id": "nav-sale", "label": "On sale"},
     {"kind": "link", "label": "Finder", "href": "/discover", "visible": false}]},
  {"kind": "collection", "collection_id": "nav-sale"},
  {"kind": "link", "label": "Deals", "href": "/shop?filter=deals"},
  {"kind": "category", "category_id": "nav-cat", "label": "Cats", "visible": false},
  {"kind": "link", "label": "Blog", "href": "https://example.com/blog"}]')::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.r1')::jsonb ->> 'items', '8', 'returns how many items it saved');
SELECT pg_temp.eq(pg_temp.menu(), 'Shop by type[nav-cat, On sale, -Finder] / nav-sale / Deals / -Cats / Blog',
                  'order, nesting, own labels (trimmed) and switched-off items as sent; the old menu is gone');
SELECT pg_temp.eq((SELECT string_agg(position::text, ',' ORDER BY position) FROM public.nav_menu_items WHERE parent_id IS NULL), '0,1,2,3,4',
                  'positions follow the list');

-- ── 4. refused saves (and the menu stays as it was) ──────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('{"kind": "menu"}')$$, '22023', 'not a list', 'invalid_nav:The menu must be a list%');
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('[{"kind": "menu", "label": "A", "children": [{"kind": "menu", "label": "B"}]}]')$$,
                      '22023', 'a menu inside a menu', 'invalid_nav:A menu can''t sit inside another menu%');
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('[{"kind": "link", "label": "A", "href": "/a", "children": [{"kind": "link", "label": "B", "href": "/b"}]}]')$$,
                      '22023', 'items under something that isn''t a menu', 'invalid_nav:Only a menu can hold other items%');
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('[{"kind": "menu", "label": "  "}]')$$, '22023', 'a menu without a name', 'invalid_nav:Give every menu a name%');
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('[{"kind": "link", "href": "/x"}]')$$, '22023', 'a link without a name', 'invalid_nav:Give every link a name%');
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('[{"kind": "link", "label": "X"}]')$$, '22023', 'a link without an address', 'invalid_nav:The link "X" needs an address%');
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('[{"kind": "link", "label": "X", "href": "//evil.example"}]')$$, '22023', 'a protocol-relative address', 'invalid_nav:The link "X" needs%');
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('[{"kind": "link", "label": "X", "href": "javascript:alert(1)"}]')$$, '22023', 'a script address', 'invalid_nav:The link "X" needs%');
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('[{"kind": "category", "category_id": "no-such-cat"}]')$$, '22023', 'an unknown category', 'invalid_nav:The category "no-such-cat" no longer exists%');
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('[{"kind": "collection", "collection_id": "no-such-sale"}]')$$, '22023', 'an unknown collection', 'invalid_nav:The collection "no-such-sale" no longer exists%');
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('[{"kind": "button", "label": "X"}]')$$, '22023', 'an unknown kind', 'invalid_nav:"button" is not a kind%');
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu(('[{"kind": "menu", "label": "' || repeat('x', 41) || '"}]')::jsonb)$$, '22023', 'a name over 40 characters', 'invalid_nav:%too long%');
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('[{"kind": "link", "label": "X", "href": "/x", "visible": "maybe"}]')$$, '22023', 'visible that isn''t true or false', 'invalid_nav:"visible" must be%');
SELECT pg_temp.throws(format($$SELECT public.admin_save_nav_menu('%s')$$, (SELECT jsonb_agg(jsonb_build_object('kind', 'link', 'label', 'L' || n, 'href', '/l' || n)) FROM generate_series(1, 21) n)),
                      '22023', 'more than 20 top-level items', 'invalid_nav:The navbar can hold at most 20 items%');
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.menu(), 'Shop by type[nav-cat, On sale, -Finder] / nav-sale / Deals / -Cats / Blog', 'every refused save left the menu as it was');

-- the table's own checks back the function up (a hand edit in the SQL editor)
SELECT pg_temp.throws($$INSERT INTO public.nav_menu_items (parent_id, kind, label, href)
                         SELECT id, 'link', 'Inner', '/inner' FROM public.nav_menu_items WHERE kind = 'link' AND label = 'Deals'$$,
                      '22023', 'by hand: an item under a link', 'invalid_nav:Only a menu can hold other items%');
SELECT pg_temp.throws($$INSERT INTO public.nav_menu_items (kind, href) VALUES ('link', '/no-name')$$, '23514', 'by hand: a link without a name (CHECK)');

-- ── 5. categories and collections it points at ───────────────────────────────
UPDATE public.collections SET id = 'nav-sale-2' WHERE id = 'nav-sale';
SELECT pg_temp.eq(pg_temp.menu(), 'Shop by type[nav-cat, On sale, -Finder] / nav-sale-2 / Deals / -Cats / Blog',
                  'a collection whose address changes is followed');
DELETE FROM public.categories WHERE id = 'nav-cat';
SELECT pg_temp.eq(pg_temp.menu(), 'Shop by type[On sale, -Finder] / nav-sale-2 / Deals / Blog', 'a deleted category leaves the menu');

-- ── 6. staff: Homepage → edit saves it, Homepage → view does not ─────────────
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s:%s:%s', kind, name, area, view_level, edit_level), ' ' ORDER BY kind) FROM public.staff_api_map WHERE migration = '48'),
                  'rpc:admin_save_nav_menu:homepage:view:edit table:nav_menu_items:homepage:view:admin', 'mapped to the Homepage section');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.editor', public.admin_create_staff('editor@shop.test', 'Counter2026', 'Editor', '{"homepage": "edit"}') ->> 'user_id', false);
SELECT set_config('t.viewer', public.admin_create_staff('viewer@shop.test', 'Counter2026', 'Viewer', '{"homepage": "view"}') ->> 'user_id', false);
SELECT pg_temp.login(current_setting('t.editor')::uuid);
SELECT pg_temp.req('POST', '/rest/v1/rpc/admin_save_nav_menu');
SELECT pg_temp.eq(public.admin_save_nav_menu('[{"kind": "link", "label": "Deals", "href": "/shop?filter=deals"}]') ->> 'items', '1',
                  'staff with Homepage → edit can save the navbar');
SELECT pg_temp.login(current_setting('t.viewer')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_save_nav_menu('[]')$$, '42501', 'staff with Homepage → view cannot', 'not_authorised:%');
SELECT pg_temp.req('', '');
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.menu(), 'Deals', 'only the editor''s save landed');

-- ── 7. re-run: the seed never comes back over the shop's menu ────────────────
\ir ../migrations/48_navbar_menu.sql
SELECT pg_temp.eq(pg_temp.menu(), 'Deals', 'a re-run keeps the saved menu');
DELETE FROM public.app_config WHERE name = 'seed_48_navbar_menu';
\ir ../migrations/48_navbar_menu.sql
SELECT pg_temp.eq(pg_temp.menu(), 'Deals', 'even without the marker, a menu that exists is never replaced by the seed');
SELECT pg_temp.eq((SELECT count(*) FROM public.staff_api_map WHERE migration = '48'), 2::bigint, 'a re-run keeps two staff map rows');
