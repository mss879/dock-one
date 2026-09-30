-- ═════════════════════════════════════════════════════════════════════════════
-- 16_storefront_content.sql — Dock One Solutions
--
-- PURPOSE      The approved homepage's banners and copy, made backend-controlled (BUILD_SPEC §2.0(b),
--              §6 — these have no blueprint table, so the columns mirror the existing components):
--                hero_slides     Hero.tsx slides: image or fallback scene, tone, background, chip,
--                                eyebrow, title (safe mini-markup {lime:…} {violet:…} and \n), body,
--                                primary + secondary link, HUD readout lines, order, schedule window
--                promo_tiles     PromoGrid.tsx bento: slots 1–4 (the geometry per slot stays in code)
--                content_blocks  keyed JSON blocks: hero_perks, trust_row, order_your_way, store_status,
--                                testimonial, new_arrivals_feature (shapes validated by lib/content.ts)
--                get_best_sellers()  product ids ranked by units sold in non-cancelled orders over a
--                                    window, topped up with is_bestseller products (BUILD_SPEC §6)
--                admin_reorder_hero_slides(), admin_set_featured_collections()  the Homepage tab's
--                                    reorders, each ONE statement (blueprint §11.2 / §11.3)
--              Public read of what is live (active, inside its schedule window); admins hold all
--              four verbs. Links are site-relative paths or https URLs only (CHECK).
-- DEPENDS ON   01_foundation (touch_updated_at), 02_customers_and_auth (customers, is_admin()),
--              04_catalogue (products, collections), 07_orders (orders, order_items for best sellers).
-- ENABLES      src/lib/content.ts + the homepage components and admin Homepage tab (WP-B), seed 31.
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Hero slides
-- ─────────────────────────────────────────────────────────────────────────────
-- Links: "/" + a path ("/shop?category=laptops", "/#flash-deals") or "https://…". Never "//host",
-- "javascript:", "http:" or a backslash (browsers read "/\host" as "//host").
CREATE TABLE IF NOT EXISTS public.hero_slides (
  id              SERIAL PRIMARY KEY,
  image_url       TEXT,                                -- /path or https://; NULL → the fallback scene
  fallback_scene  TEXT NOT NULL DEFAULT 'paper',       -- night | paper | lime | violet (ui/Scene)
  tone            TEXT NOT NULL DEFAULT 'light',       -- dark | light: the text colour scheme
  background      TEXT NOT NULL,                       -- #rrggbb: matches the image's own edge colour
  chip            TEXT,                                -- the highlighted label ("Grand opening")
  eyebrow         TEXT,                                -- the line after "/01 —"
  title           TEXT NOT NULL,                       -- mini-markup: {lime:…} {violet:…} and \n line breaks
  body            TEXT,
  cta_label       TEXT,                                -- primary button (label + href together)
  cta_href        TEXT,
  secondary_label TEXT,                                -- bracket link (label + href together)
  secondary_href  TEXT,
  readout         TEXT[] NOT NULL DEFAULT '{}',        -- HUD lines (decorative)
  position        INT NOT NULL DEFAULT 100,            -- ascending; ties by id
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at       TIMESTAMPTZ,                         -- NULL = already running
  ends_at         TIMESTAMPTZ,                         -- NULL = no end
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hero_slides_scene_valid      CHECK (fallback_scene IN ('night', 'paper', 'lime', 'violet')),
  CONSTRAINT hero_slides_tone_valid       CHECK (tone IN ('dark', 'light')),
  CONSTRAINT hero_slides_background_valid CHECK (background ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'),
  CONSTRAINT hero_slides_links_valid      CHECK (
        (cta_label IS NULL) = (cta_href IS NULL)
    AND (secondary_label IS NULL) = (secondary_href IS NULL)
    AND (cta_href       IS NULL OR (char_length(cta_href)       <= 500 AND cta_href       ~ '^(/([^/\\\s][^\\\s]*)?|https://[^\\\s]+)$'))
    AND (secondary_href IS NULL OR (char_length(secondary_href) <= 500 AND secondary_href ~ '^(/([^/\\\s][^\\\s]*)?|https://[^\\\s]+)$'))),
  CONSTRAINT hero_slides_image_valid      CHECK (image_url IS NULL
                                                 OR (char_length(image_url) <= 1000 AND image_url ~ '^(/[^/\\\s][^\\\s]*|https://[^\\\s]+)$')),
  CONSTRAINT hero_slides_schedule_valid   CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT hero_slides_readout_valid    CHECK (
        cardinality(readout) <= 6
    AND array_position(readout, NULL) IS NULL
    AND NOT jsonb_path_exists(to_jsonb(readout), '$[*] ? (@ like_regex "^.{41}" flag "s")')),
  CONSTRAINT hero_slides_text_lengths     CHECK (
        char_length(btrim(title)) BETWEEN 1 AND 200
    AND (chip            IS NULL OR char_length(chip)            <= 40)
    AND (eyebrow         IS NULL OR char_length(eyebrow)         <= 80)
    AND (body            IS NULL OR char_length(body)            <= 500)
    AND (cta_label       IS NULL OR char_length(btrim(cta_label))       BETWEEN 1 AND 40)
    AND (secondary_label IS NULL OR char_length(btrim(secondary_label)) BETWEEN 1 AND 40))
);
CREATE INDEX IF NOT EXISTS hero_slides_live_idx ON public.hero_slides (position, id) WHERE is_active;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Promo tiles (the four bento slots)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.promo_tiles (
  slot           SMALLINT PRIMARY KEY,                 -- 1..4: the bento position (geometry lives in code)
  image_url      TEXT,                                 -- /path or https://; NULL → the fallback scene
  fallback_scene TEXT NOT NULL DEFAULT 'paper',        -- night | paper | lime | violet
  tone           TEXT NOT NULL DEFAULT 'light',        -- dark | light
  background     TEXT NOT NULL,                        -- #rrggbb behind the image
  eyebrow        TEXT,                                 -- the chip ("Limited time offer")
  title_lines    TEXT[] NOT NULL,                      -- one element per display line (1–4)
  body           TEXT,                                 -- the line under the title
  cta_label      TEXT,                                 -- the pill ("Shop laptops")
  href           TEXT NOT NULL,                        -- the whole tile links here
  image_position TEXT,                                 -- CSS object-position, e.g. "85% bottom"
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT promo_tiles_slot_valid       CHECK (slot BETWEEN 1 AND 4),
  CONSTRAINT promo_tiles_scene_valid      CHECK (fallback_scene IN ('night', 'paper', 'lime', 'violet')),
  CONSTRAINT promo_tiles_tone_valid       CHECK (tone IN ('dark', 'light')),
  CONSTRAINT promo_tiles_background_valid CHECK (background ~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$'),
  CONSTRAINT promo_tiles_href_valid       CHECK (char_length(href) <= 500 AND href ~ '^(/([^/\\\s][^\\\s]*)?|https://[^\\\s]+)$'),
  CONSTRAINT promo_tiles_image_valid      CHECK (image_url IS NULL
                                                 OR (char_length(image_url) <= 1000 AND image_url ~ '^(/[^/\\\s][^\\\s]*|https://[^\\\s]+)$')),
  -- rendered into a style attribute: keywords, numbers and % only (no url(), no ";")
  CONSTRAINT promo_tiles_position_valid   CHECK (image_position IS NULL OR image_position ~ '^[a-z0-9%. -]{1,40}$'),
  CONSTRAINT promo_tiles_title_valid      CHECK (
        cardinality(title_lines) BETWEEN 1 AND 4
    AND array_position(title_lines, NULL) IS NULL
    AND NOT jsonb_path_exists(to_jsonb(title_lines), '$[*] ? (@ like_regex "^.{41}" flag "s")')
    AND NOT jsonb_path_exists(to_jsonb(title_lines), '$[*] ? (@ like_regex "^\\s*$")')),
  CONSTRAINT promo_tiles_text_lengths     CHECK (
        (eyebrow   IS NULL OR char_length(eyebrow)   <= 40)
    AND (body      IS NULL OR char_length(body)      <= 160)
    AND (cta_label IS NULL OR char_length(btrim(cta_label)) BETWEEN 1 AND 40))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Content blocks (keyed JSON; the shape of each key is validated by src/lib/content.ts)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.content_blocks (
  key        TEXT PRIMARY KEY,                         -- hero_perks | trust_row | order_your_way | store_status | testimonial | new_arrivals_feature | …
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,       -- an object or an array, ≤ 32 KB
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),       -- set by trigger
  updated_by UUID REFERENCES public.customers (id) ON DELETE SET NULL,   -- set by trigger (the admin who saved)
  CONSTRAINT content_blocks_key_format CHECK (key ~ '^[a-z0-9_]+$' AND char_length(key) <= 64),
  CONSTRAINT content_blocks_data_valid CHECK (jsonb_typeof(data) IN ('object', 'array') AND octet_length(data::TEXT) <= 32768)
);

DROP TRIGGER IF EXISTS hero_slides_touch ON public.hero_slides;
CREATE TRIGGER hero_slides_touch BEFORE UPDATE ON public.hero_slides
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS promo_tiles_touch ON public.promo_tiles;
CREATE TRIGGER promo_tiles_touch BEFORE UPDATE ON public.promo_tiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- updated_at always; updated_by = the admin who saved (NULL for SQL-editor edits and seeds).
CREATE OR REPLACE FUNCTION public.content_blocks_touch() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.content_blocks_touch() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS content_blocks_touch ON public.content_blocks;
CREATE TRIGGER content_blocks_touch BEFORE INSERT OR UPDATE ON public.content_blocks
  FOR EACH ROW EXECUTE FUNCTION public.content_blocks_touch();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. RLS: the public reads what is live; admins everything
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.hero_slides    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promo_tiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_blocks ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.hero_slides, public.promo_tiles, public.content_blocks FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER
  ON public.hero_slides, public.promo_tiles, public.content_blocks FROM authenticated;
REVOKE ALL ON SEQUENCE public.hero_slides_id_seq FROM anon;

-- A slide is live while active and inside its window (evaluated at query time — a cached page shows
-- a scheduled change only after it revalidates).
DROP POLICY IF EXISTS hero_slides_public_read ON public.hero_slides;
CREATE POLICY hero_slides_public_read ON public.hero_slides
  FOR SELECT TO anon, authenticated
  USING (is_active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now()));
DROP POLICY IF EXISTS hero_slides_admin_all ON public.hero_slides;
CREATE POLICY hero_slides_admin_all ON public.hero_slides
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS promo_tiles_public_read ON public.promo_tiles;
CREATE POLICY promo_tiles_public_read ON public.promo_tiles
  FOR SELECT TO anon, authenticated USING (is_active);
DROP POLICY IF EXISTS promo_tiles_admin_all ON public.promo_tiles;
CREATE POLICY promo_tiles_admin_all ON public.promo_tiles
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS content_blocks_public_read ON public.content_blocks;
CREATE POLICY content_blocks_public_read ON public.content_blocks
  FOR SELECT TO anon, authenticated USING (TRUE);
DROP POLICY IF EXISTS content_blocks_admin_all ON public.content_blocks;
CREATE POLICY content_blocks_admin_all ON public.content_blocks
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Best sellers (BUILD_SPEC §6: "units sold in last 90 days, topped up with is_bestseller")
-- ─────────────────────────────────────────────────────────────────────────────
-- Visible products only (active with ≥ 1 active variant). Ranked by units sold — Σ order_items
-- quantity of orders whose status is not 'cancelled', placed within the last p_days days
-- (rolling) — ties by sort_order, id; then topped up with is_bestseller products that sold
-- nothing in the window, by sort_order, id. No duplicates. Clamps: p_limit 1..24 (NULL → 5),
-- p_days 1..365 (NULL → 90). Returns ids and positions only — never sales figures (units sold
-- are the owner's business). Never raises.
CREATE OR REPLACE FUNCTION public.get_best_sellers(p_limit INT DEFAULT 5, p_days INT DEFAULT 90)
RETURNS TABLE (product_id INT, rank INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH params AS (
    SELECT LEAST(GREATEST(COALESCE(p_limit, 5), 1), 24) AS lim,
           now() - make_interval(days => LEAST(GREATEST(COALESCE(p_days, 90), 1), 365)) AS since
  ), sold AS (
    SELECT i.product_id, sum(i.quantity) AS units
      FROM public.order_items i
      JOIN public.orders o ON o.id = i.order_id
     WHERE o.status <> 'cancelled'
       AND o.created_at >= (SELECT since FROM params)
       AND i.product_id IS NOT NULL
     GROUP BY i.product_id
  ), ranked AS (
    SELECT p.id, 0 AS tier, s.units, p.sort_order
      FROM sold s
      JOIN public.products p ON p.id = s.product_id AND p.is_active AND p.variant_count > 0
    UNION ALL
    SELECT p.id, 1 AS tier, 0 AS units, p.sort_order
      FROM public.products p
     WHERE p.is_bestseller AND p.is_active AND p.variant_count > 0
       AND NOT EXISTS (SELECT 1 FROM sold s WHERE s.product_id = p.id)
  )
  SELECT r.id AS product_id,
         (row_number() OVER (ORDER BY r.tier, r.units DESC, r.sort_order, r.id))::INT AS rank
    FROM ranked r
   ORDER BY rank
   LIMIT (SELECT lim FROM params)
$$;
REVOKE ALL ON FUNCTION public.get_best_sellers(INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_best_sellers(INT, INT) TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Admin ordering (blueprint §11.2 Homepage: "reorder through one RPC or one upsert, so a
--    half-applied reorder can't leave two items in the same slot"; §11.3: no client-supplied ids)
-- ─────────────────────────────────────────────────────────────────────────────
-- The new order of the hero slides in ONE statement: positions 10, 20, 30 … in array order.
-- Only EXISTING slides: a slide deleted meanwhile (another tab) fails the whole reorder with
-- slide_not_found instead of being re-created — an upsert would re-insert it under its old id.
-- Slides not listed keep their position. Admin re-checked inside (P9.5).
CREATE OR REPLACE FUNCTION public.admin_reorder_hero_slides(p_ids INT[])
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ids INT[] := COALESCE(p_ids, '{}'::INT[]);
  v_bad TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can reorder hero slides.';
  END IF;
  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_slides:Send the slides in their new order.';
  END IF;
  IF cardinality(v_ids) > 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_slides:At most 100 slides can be reordered at once.';
  END IF;
  IF array_position(v_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_slides:The slide list has an empty entry.';
  END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(v_ids) AS x) <> cardinality(v_ids) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_slides:A slide is listed twice.';
  END IF;
  SELECT string_agg(u.x::TEXT, ', ' ORDER BY u.o) INTO v_bad
    FROM unnest(v_ids) WITH ORDINALITY AS u(x, o)
   WHERE NOT EXISTS (SELECT 1 FROM public.hero_slides s WHERE s.id = u.x);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('slide_not_found:Slide %s no longer exists (it may have been deleted). Reload the list and try again.', v_bad);
  END IF;

  UPDATE public.hero_slides s
     SET position = (u.o * 10)::INT
    FROM unnest(v_ids) WITH ORDINALITY AS u(x, o)
   WHERE s.id = u.x AND s.position IS DISTINCT FROM (u.o * 10)::INT;

  RETURN jsonb_build_object('ids', to_jsonb(v_ids));
END $$;
REVOKE ALL ON FUNCTION public.admin_reorder_hero_slides(INT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reorder_hero_slides(INT[]) TO authenticated;

-- The homepage "Featured collections" row in ONE statement (BUILD_SPEC §6: collections where
-- is_featured, by sort_order): the listed collections become featured with sort_order 10, 20, 30 …
-- in array order; every other featured collection stops being featured (its sort_order is kept).
-- '{}' / NULL = feature none. Only existing collections (collection_not_found otherwise); an
-- inactive one may be featured — the storefront shows it once it is active again.
CREATE OR REPLACE FUNCTION public.admin_set_featured_collections(p_ids TEXT[])
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ids TEXT[] := COALESCE(p_ids, '{}'::TEXT[]);
  v_bad TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can choose the homepage collections.';
  END IF;
  IF cardinality(v_ids) > 12 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_collections:The homepage can feature at most 12 collections.';
  END IF;
  IF array_position(v_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_collections:The collection list has an empty entry.';
  END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(v_ids) AS x) <> cardinality(v_ids) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_collections:A collection is listed twice.';
  END IF;
  SELECT string_agg(u.x, ', ' ORDER BY u.o) INTO v_bad
    FROM unnest(v_ids) WITH ORDINALITY AS u(x, o)
   WHERE NOT EXISTS (SELECT 1 FROM public.collections c WHERE c.id = u.x);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('collection_not_found:Collection %s no longer exists (it may have been deleted). Reload the list and try again.', v_bad);
  END IF;

  UPDATE public.collections c
     SET is_featured = (m.o IS NOT NULL),
         sort_order  = CASE WHEN m.o IS NOT NULL THEN (m.o * 10)::INT ELSE c.sort_order END
    FROM (SELECT c2.id, u.o
            FROM public.collections c2
            LEFT JOIN unnest(v_ids) WITH ORDINALITY AS u(x, o) ON u.x = c2.id
           WHERE c2.is_featured OR u.o IS NOT NULL) AS m
   WHERE c.id = m.id
     AND (c.is_featured IS DISTINCT FROM (m.o IS NOT NULL)
          OR (m.o IS NOT NULL AND c.sort_order IS DISTINCT FROM (m.o * 10)::INT));

  RETURN jsonb_build_object('featured', to_jsonb(v_ids));
END $$;
REVOKE ALL ON FUNCTION public.admin_set_featured_collections(TEXT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_featured_collections(TEXT[]) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 16_storefront_content
--   No secrets. The homepage reads these tables; seed 31 (DEMO) fills them with today's approved
--   copy. Edit them in the admin Homepage tab, which revalidates the `content` tag after a
--   confirmed save (the featured-collections order revalidates `catalogue`). A scheduled slide
--   (starts_at / ends_at) appears or disappears when the page next revalidates (≤ 2 minutes for the
--   homepage's slide read) — keep that in mind for tightly timed schedules.
--   Best sellers need real orders; until then the row shows the is_bestseller products.
--   Verification:
--     SELECT id, position, is_active, starts_at, ends_at, left(title, 40) FROM public.hero_slides ORDER BY position, id;
--     SELECT slot, is_active, href FROM public.promo_tiles ORDER BY slot;
--     SELECT key, jsonb_typeof(data), updated_at FROM public.content_blocks ORDER BY key;
--     SELECT * FROM public.get_best_sellers(5, 90);
--     -- live probes (anon key is public):
--     curl -s "$SUPABASE_URL/rest/v1/rpc/get_best_sellers" -H "apikey: $ANON" -H "Content-Type: application/json" -d '{"p_limit":5}'
--     curl -s -X PATCH "$SUPABASE_URL/rest/v1/hero_slides?id=eq.1" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
--          -H "Content-Type: application/json" -d '{"title":"x"}'                                   -- permission denied
-- ═════════════════════════════════════════════════════════════════════════════
