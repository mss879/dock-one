-- ═════════════════════════════════════════════════════════════════════════════
-- 48_navbar_menu.sql — Dock One Solutions
--
-- PURPOSE      The store's main menu — the desktop navbar and the phone menu — edited in admin →
--              Homepage & navbar → Navbar instead of in code: what it shows, in what order, and
--              what each dropdown holds.
--                * nav_menu_items: one row per item. At the top level, in order: a MENU (a
--                  dropdown with its own name, e.g. "Computing") or a single CATEGORY, COLLECTION
--                  or LINK. Inside a menu: categories, collections and links, in order. Any item can
--                  be switched off without deleting it. A category or collection shows its CURRENT
--                  name unless the item gives its own label, and drops out while it is hidden.
--                * admin_save_nav_menu(items): the whole menu in ONE call, so an order or a nesting
--                  is never half-saved. It is the only writer: the table has no write policy.
--                * Seeded ONCE from what the navbar showed until now — Computing, Accessories and
--                  Cameras with their categories — plus Deals and New, kept but switched OFF while
--                  the 11.11 sale is the headline (the shop's request). Switch them back on in the
--                  editor.
--              Unchanged: the electric sale item (45, admin → Collections → Navbar) always ends the
--              navbar; an active category that is in no menu at all still shows under "More", so a
--              new category is never left out (to keep one out, add it to a menu switched off).
-- DEPENDS ON   01_foundation (app_config), 02_customers_and_auth (is_admin), 04_catalogue
--              (categories, collections), 39_staff_accounts (staff_api_map).
-- ENABLES      Header.tsx / MobileMenu.tsx (lib/navigation.ts getNavMenu) and the admin Navbar
--              editor (components/admin/homepage/NavbarPanel.tsx). Staff with Homepage → edit can
--              change it (map rows at the end).
-- ERRORS       22023 `invalid_nav:<text for the admin>`; 42501 `not_authorised:…`.
-- SAFE TO RE-RUN: yes (the seed runs once — app_config 'seed_48_navbar_menu').
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The menu
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.nav_menu_items (
  id            SERIAL PRIMARY KEY,
  parent_id     INT REFERENCES public.nav_menu_items (id) ON DELETE CASCADE,   -- the menu it sits in
  kind          TEXT NOT NULL,                                                 -- menu | category | collection | link
  label         TEXT,                     -- menu, link: required · category, collection: optional own label
  category_id   TEXT REFERENCES public.categories (id) ON DELETE CASCADE ON UPDATE CASCADE,
  collection_id TEXT REFERENCES public.collections (id) ON DELETE CASCADE ON UPDATE CASCADE,
  href          TEXT,                     -- link only: /path on this site or https://…
  position      INT NOT NULL DEFAULT 0,
  is_visible    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT nav_menu_items_kind_valid CHECK (kind IN ('menu', 'category', 'collection', 'link')),
  CONSTRAINT nav_menu_items_target_valid CHECK (
       (kind = 'menu'       AND parent_id IS NULL AND label IS NOT NULL AND category_id IS NULL AND collection_id IS NULL AND href IS NULL)
    OR (kind = 'category'   AND category_id IS NOT NULL AND collection_id IS NULL AND href IS NULL)
    OR (kind = 'collection' AND collection_id IS NOT NULL AND category_id IS NULL AND href IS NULL)
    OR (kind = 'link'       AND href IS NOT NULL AND label IS NOT NULL AND category_id IS NULL AND collection_id IS NULL)),
  CONSTRAINT nav_menu_items_label_valid CHECK (label IS NULL OR char_length(btrim(label)) BETWEEN 1 AND 40),
  CONSTRAINT nav_menu_items_href_valid  CHECK (href IS NULL OR (char_length(href) <= 500
                                                AND href ~ '^(/([^/\\\s][^\\\s]*)?|https://[^\\\s]+)$'))
);
CREATE INDEX IF NOT EXISTS nav_menu_items_order_idx ON public.nav_menu_items (parent_id, position, id);

COMMENT ON TABLE public.nav_menu_items IS
  'The store''s main menu (navbar + phone menu), in order; written only by admin_save_nav_menu (48).';

-- Only a top-level MENU holds items (one level deep). The save function never breaks this; the
-- trigger keeps a hand edit in the SQL editor from doing it.
CREATE OR REPLACE FUNCTION public.nav_menu_items_check_parent() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.nav_menu_items p WHERE p.id = NEW.parent_id AND p.kind = 'menu' AND p.parent_id IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_nav:Only a menu can hold other items.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.nav_menu_items_check_parent() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS nav_menu_items_10_parent ON public.nav_menu_items;
CREATE TRIGGER nav_menu_items_10_parent BEFORE INSERT OR UPDATE ON public.nav_menu_items
  FOR EACH ROW EXECUTE FUNCTION public.nav_menu_items_check_parent();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Access: everyone reads it (the header is public; switched-off rows too, so the storefront
--    knows which categories are placed); nobody writes it except the save function.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.nav_menu_items ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.nav_menu_items FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.nav_menu_items_id_seq FROM anon, authenticated;
GRANT SELECT ON public.nav_menu_items TO anon, authenticated;

DROP POLICY IF EXISTS nav_menu_items_public_read ON public.nav_menu_items;
CREATE POLICY nav_menu_items_public_read ON public.nav_menu_items
  FOR SELECT TO anon, authenticated USING (TRUE);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. admin_save_nav_menu(p_items JSONB) → {items}
-- ─────────────────────────────────────────────────────────────────────────────
-- p_items: the top-level items in order, each
--   {"kind": "menu", "label": "Computing", "visible": true, "children": [ …items… ]}
--   {"kind": "category", "category_id": "laptops", "label": null, "visible": true}
--   {"kind": "collection", "collection_id": "gaming-zone", "label": "Gaming", "visible": true}
--   {"kind": "link", "label": "Deals", "href": "/shop?filter=deals", "visible": false}
-- Children are categories, collections or links (no menu inside a menu). The menu becomes exactly
-- this list; positions follow the order given.

-- One item, checked (22023 invalid_nav, written for the admin) and inserted; returns its id.
CREATE OR REPLACE FUNCTION public._nav_insert_item(p_item JSONB, p_parent INT, p_position INT) RETURNS INT
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_kind       TEXT;
  v_label      TEXT;
  v_category   TEXT;
  v_collection TEXT;
  v_href       TEXT;
  v_visible    BOOLEAN;
  v_id         INT;
BEGIN
  IF p_item IS NULL OR jsonb_typeof(p_item) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_nav:An item of the menu is empty.';
  END IF;
  v_kind := p_item ->> 'kind';
  IF v_kind IS NULL OR v_kind NOT IN ('menu', 'category', 'collection', 'link') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_nav:"%s" is not a kind of menu item.', COALESCE(v_kind, ''));
  END IF;
  IF v_kind = 'menu' AND p_parent IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_nav:A menu can''t sit inside another menu.';
  END IF;
  v_label := NULLIF(btrim(COALESCE(p_item ->> 'label', '')), '');
  IF v_label IS NULL AND v_kind IN ('menu', 'link') THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = CASE v_kind WHEN 'menu' THEN 'invalid_nav:Give every menu a name.' ELSE 'invalid_nav:Give every link a name.' END;
  END IF;
  IF char_length(v_label) > 40 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_nav:"%s…" is too long for the navbar (up to 40 characters).', left(v_label, 30));
  END IF;
  v_visible := COALESCE((p_item ->> 'visible')::BOOLEAN, TRUE);

  IF v_kind = 'category' THEN
    v_category := NULLIF(btrim(COALESCE(p_item ->> 'category_id', '')), '');
    IF v_category IS NULL OR NOT EXISTS (SELECT 1 FROM public.categories WHERE id = v_category) THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('invalid_nav:The category "%s" no longer exists. Pick another or remove the item.', COALESCE(v_category, ''));
    END IF;
  ELSIF v_kind = 'collection' THEN
    v_collection := NULLIF(btrim(COALESCE(p_item ->> 'collection_id', '')), '');
    IF v_collection IS NULL OR NOT EXISTS (SELECT 1 FROM public.collections WHERE id = v_collection) THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('invalid_nav:The collection "%s" no longer exists. Pick another or remove the item.', COALESCE(v_collection, ''));
    END IF;
  ELSIF v_kind = 'link' THEN
    v_href := NULLIF(btrim(COALESCE(p_item ->> 'href', '')), '');
    IF v_href IS NULL OR char_length(v_href) > 500 OR v_href !~ '^(/([^/\\\s][^\\\s]*)?|https://[^\\\s]+)$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('invalid_nav:The link "%s" needs an address on this site (starting with /) or a full https:// address.', v_label);
    END IF;
  END IF;

  INSERT INTO public.nav_menu_items (parent_id, kind, label, category_id, collection_id, href, position, is_visible)
  VALUES (p_parent, v_kind, v_label, v_category, v_collection, v_href, p_position, v_visible)
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN invalid_text_representation THEN
  RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_nav:"visible" must be true or false.';
END $$;
REVOKE ALL ON FUNCTION public._nav_insert_item(JSONB, INT, INT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_save_nav_menu(p_items JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_items    JSONB := COALESCE(p_items, '[]'::jsonb);
  v_top      JSONB;
  v_children JSONB;
  v_child    JSONB;
  v_menu     INT;
  v_pos      INT := 0;
  v_cpos     INT;
  v_count    INT := 0;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can change the navbar.';
  END IF;
  IF jsonb_typeof(v_items) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_nav:The menu must be a list of items.';
  END IF;
  IF jsonb_array_length(v_items) > 20 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_nav:The navbar can hold at most 20 items. Group some into a menu.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('public.admin_save_nav_menu'));   -- one save at a time
  DELETE FROM public.nav_menu_items;

  FOR v_top IN SELECT value FROM jsonb_array_elements(v_items) LOOP
    v_menu := public._nav_insert_item(v_top, NULL, v_pos);
    v_count := v_count + 1;
    v_children := COALESCE(v_top -> 'children', '[]'::jsonb);
    IF jsonb_typeof(v_children) <> 'array' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_nav:A menu''s items must be a list.';
    END IF;
    IF jsonb_array_length(v_children) > 0 AND v_top ->> 'kind' <> 'menu' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_nav:Only a menu can hold other items.';
    END IF;
    IF jsonb_array_length(v_children) > 40 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_nav:A menu can hold at most 40 items.';
    END IF;
    v_cpos := 0;
    FOR v_child IN SELECT value FROM jsonb_array_elements(v_children) LOOP
      PERFORM public._nav_insert_item(v_child, v_menu, v_cpos);
      v_cpos := v_cpos + 1;
      v_count := v_count + 1;
    END LOOP;
    v_pos := v_pos + 1;
  END LOOP;

  RETURN jsonb_build_object('items', v_count);
END $$;
REVOKE ALL ON FUNCTION public.admin_save_nav_menu(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_nav_menu(JSONB) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Staff: Homepage → view reads it, Homepage → edit saves it
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM public.staff_api_map WHERE migration = '48';
INSERT INTO public.staff_api_map (kind, name, area, view_level, edit_level, migration)
VALUES ('table', 'nav_menu_items', 'homepage', 'view', 'admin', '48'),
       ('rpc', 'admin_save_nav_menu', 'homepage', 'view', 'edit', '48');

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Seed, once: the navbar as it was, with Deals and New switched off
-- ─────────────────────────────────────────────────────────────────────────────
DO $seed$
DECLARE
  c_marker CONSTANT TEXT := 'seed_48_navbar_menu';
  g        RECORD;
  v_menu   INT;
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_config WHERE name = c_marker) THEN
    RAISE NOTICE '48_navbar_menu: already seeded (app_config %) — skipped', c_marker;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.nav_menu_items) THEN
    -- the menus and category ids the header used (components/layout/nav.ts before 48); categories in
    -- their admin order, as the dropdowns listed them
    FOR g IN SELECT * FROM (VALUES
                (0, 'Computing',   ARRAY['laptops', 'monitors', 'storage', 'components']),
                (1, 'Accessories', ARRAY['keyboards', 'mice', 'audio', 'power-charging']),
                (2, 'Cameras',     ARRAY['cameras', 'polaroid-camera'])) AS t (pos, label, ids)
    LOOP
      INSERT INTO public.nav_menu_items (kind, label, position) VALUES ('menu', g.label, g.pos) RETURNING id INTO v_menu;
      INSERT INTO public.nav_menu_items (parent_id, kind, category_id, position)
      SELECT v_menu, 'category', c.id, (row_number() OVER (ORDER BY c.sort_order, c.name))::INT - 1
        FROM public.categories c
       WHERE c.id = ANY (g.ids);
    END LOOP;
    INSERT INTO public.nav_menu_items (kind, label, href, position, is_visible)
    VALUES ('link', 'Deals', '/shop?filter=deals', 3, FALSE),
           ('link', 'New',   '/shop?filter=new',   4, FALSE);
    RAISE NOTICE '48_navbar_menu: seeded Computing, Accessories, Cameras; Deals and New switched off';
  ELSE
    RAISE NOTICE '48_navbar_menu: a menu already exists — left unchanged';
  END IF;
  INSERT INTO public.app_config (name, value) VALUES (c_marker, to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))
  ON CONFLICT (name) DO NOTHING;
END $seed$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ops notes (run by hand in the SQL editor; nothing here runs them)
-- ─────────────────────────────────────────────────────────────────────────────
-- The menu as stored:
--   SELECT i.id, i.parent_id, i.position, i.kind, COALESCE(i.label, c.name, k.title) AS shows, i.href, i.is_visible
--     FROM nav_menu_items i LEFT JOIN categories c ON c.id = i.category_id LEFT JOIN collections k ON k.id = i.collection_id
--    ORDER BY COALESCE(i.parent_id, i.id), i.parent_id NULLS FIRST, i.position;
-- Bring Deals and New back:   UPDATE nav_menu_items SET is_visible = TRUE WHERE kind = 'link' AND href IN ('/shop?filter=deals', '/shop?filter=new');
-- Undo 48 (the header goes back to its built-in menu: Computing, Accessories, Cameras):
--   DROP FUNCTION IF EXISTS public.admin_save_nav_menu(JSONB);
--   DROP FUNCTION IF EXISTS public._nav_insert_item(JSONB, INT, INT);
--   DROP TABLE IF EXISTS public.nav_menu_items;
--   DROP FUNCTION IF EXISTS public.nav_menu_items_check_parent();
--   DELETE FROM public.staff_api_map WHERE migration = '48';
--   DELETE FROM public.app_config WHERE name = 'seed_48_navbar_menu';
