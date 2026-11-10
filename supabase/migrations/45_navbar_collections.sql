-- ═════════════════════════════════════════════════════════════════════════════
-- 45_navbar_collections.sql — Dock One Solutions
--
-- PURPOSE      The navbar sale collection: one "major" collection at a time (11.11, then Black
--              Friday, Cyber Monday…) gets its own item in the store's main menu (the desktop
--              header, the phone header and the phone menu), drawn with the electric sale effect
--              and linking to its page, /collection/<slug>. It shows ONLY there: the switch adds
--              nothing to the homepage, and the navbar collection is left off the All collections
--              page (/collections). The homepage row keeps its own "Featured" switch.
--                * collections.show_in_nav: the switch (default off). The item shows while the
--                  collection is ALSO active.
--                * ONE at a time (the header has room for one): switching a collection on takes
--                  the current one out of the navbar in the same save — that is the 11.11 →
--                  Black Friday switch. A unique index backs it up (collections_nav_one).
--                * Two sale collections, created ONCE: "11.11" (/collection/11-11, active and in the
--                  navbar) and "Black Friday" (/collection/black-friday, hidden and off, ready to
--                  switch on). Both start empty: the shop adds the products (hand-picked or by
--                  rules) in admin → Catalogue → Collections. A re-run never brings back a deleted
--                  one or undoes an edit.
-- DEPENDS ON   01_foundation (app_config), 04_catalogue (collections).
-- ENABLES      admin → Catalogue → Collections: the "Navbar" switch (list and editor);
--              Header.tsx / MobileMenu.tsx read it (lib/catalogue.ts getNavCollection). Staff with
--              Collections → edit can use it: 39 already maps the collections table, and this adds
--              no function or table to map.
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The switch
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.collections ADD COLUMN IF NOT EXISTS show_in_nav BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN public.collections.show_in_nav IS
  'The navbar sale collection: shown in the store''s main menu with the electric effect while also active. One at a time — switching one on switches the others off (collections_nav_switch).';

-- At most one row can be switched on (and it is the navbar read's index).
CREATE UNIQUE INDEX IF NOT EXISTS collections_nav_one ON public.collections (show_in_nav) WHERE show_in_nav;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. One at a time: switching one on switches the current one off
-- ─────────────────────────────────────────────────────────────────────────────
-- Runs BEFORE the row is written, so the unique index never sees two. Invoker rights: whoever may
-- update this collection (an admin, or staff with Collections → edit) may update the other one.
-- If the other one can't be switched off, the unique index refuses the save (23505) instead of
-- showing two. Switching two on in one statement leaves only the last one written on.
CREATE OR REPLACE FUNCTION public.collections_nav_switch() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_self TEXT;
BEGIN
  IF NOT NEW.show_in_nav THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.show_in_nav THEN
      RETURN NEW;                       -- already the navbar collection (an edit or a rename)
    END IF;
    v_self := OLD.id;
  ELSE
    v_self := NEW.id;
  END IF;
  UPDATE public.collections SET show_in_nav = FALSE WHERE show_in_nav AND id <> v_self;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.collections_nav_switch() FROM PUBLIC, anon, authenticated;

-- BEFORE triggers fire in name order: collections_10_validate → collections_20_nav_switch → collections_touch.
DROP TRIGGER IF EXISTS collections_20_nav_switch ON public.collections;
CREATE TRIGGER collections_20_nav_switch BEFORE INSERT OR UPDATE OF show_in_nav ON public.collections
  FOR EACH ROW EXECUTE FUNCTION public.collections_nav_switch();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The two sale collections (once)
-- ─────────────────────────────────────────────────────────────────────────────
-- Title and slug only: no products, description, images or claims. An existing collection with
-- the same slug is left exactly as it is. 11.11 goes in the navbar only when nothing else is.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_config WHERE name = 'seed_45_sale_collections') THEN
    RETURN;
  END IF;
  INSERT INTO public.collections (id, title, kind, type, is_active, show_in_nav, sort_order)
  VALUES ('11-11', '11.11', 'curated', 'manual', TRUE,
          NOT EXISTS (SELECT 1 FROM public.collections WHERE show_in_nav), 10)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.collections (id, title, kind, type, is_active, show_in_nav, sort_order)
  VALUES ('black-friday', 'Black Friday', 'curated', 'manual', FALSE, FALSE, 20)
  ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.app_config (name, value) VALUES ('seed_45_sale_collections', 'applied');
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ops notes
-- ─────────────────────────────────────────────────────────────────────────────
-- Which collection is in the navbar (the website picks up SQL-editor changes within 5 minutes;
-- changes made in the admin show at once):
--     SELECT id, title, is_active, show_in_nav FROM public.collections WHERE show_in_nav;
-- Switch the navbar from 11.11 to Black Friday by hand (the admin's Navbar switch does the same;
-- 11.11 leaves the navbar by itself):
--     UPDATE public.collections SET show_in_nav = TRUE, is_active = TRUE WHERE id = 'black-friday';
-- Take the sale out of the navbar:
--     UPDATE public.collections SET show_in_nav = FALSE WHERE show_in_nav;
-- Undo (the two collections stay; delete them in the admin if unwanted):
--     DROP TRIGGER IF EXISTS collections_20_nav_switch ON public.collections;
--     DROP FUNCTION IF EXISTS public.collections_nav_switch();
--     DROP INDEX IF EXISTS public.collections_nav_one;
--     ALTER TABLE public.collections DROP COLUMN IF EXISTS show_in_nav;
--     DELETE FROM public.app_config WHERE name = 'seed_45_sale_collections';
