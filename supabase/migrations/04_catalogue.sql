-- ═════════════════════════════════════════════════════════════════════════════
-- 04_catalogue.sql — Dock One Solutions
--
-- PURPOSE      The catalogue: categories, products, product_variants (VARIANT MODEL B —
--              every purchasable configuration is a priced row), product_costs (margins,
--              admin-only), collections + product_collections (manual AND rule-driven
--              membership), storage buckets for admin uploads, and RLS for all of it.
--              Blueprint §7.3, §7.4, §9.1, Appendix A 03; BUILD_SPEC §2.8, §4.3, §4.4;
--              docs/domain-model.md explains the model.
-- DEPENDS ON   01_foundation (touch_updated_at), 02_customers_and_auth (is_admin()).
-- ENABLES      05_inventory (stock per variant), 06_catalogue_search, 07+ (order_items
--              reference product_variants; place_order prices from product_variants),
--              10 wishlists / 11 reviews (reference products; 11 writes ratings through
--              _apply_product_rating()), the storefront catalogue (lib/catalogue.ts),
--              admin Products / Categories / Collections tabs (WP-K), seed 30.
--
-- DERIVED COLUMNS ON products (maintained by triggers — never write them from the app):
--   price, compare_at_price  the "from" price = the cheapest ACTIVE variant's price, and that
--                            variant's compare_at_price only when it is > its price
--   default_variant_id       that cheapest active variant (what "Add to basket" on a card adds)
--   variant_count            number of ACTIVE variants (0 ⇒ the product is hidden from shoppers)
--   rating_avg, rating_count maintained by 11_reviews through _apply_product_rating()
--   image_url                always image_urls[1] (and vice-versa, see products_normalize())
-- Writes to these columns from the API are silently restored (like the customers pin).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.categories (
  id               TEXT PRIMARY KEY,                    -- the slug: /shop?category=<id>
  name             TEXT NOT NULL,
  tagline          TEXT,                                -- one line on the pop-out card
  description      TEXT,
  stage_image_url  TEXT,                                -- photographic stage behind the cut-out
  hero_product_id  INT,                                 -- FK added below (products must exist first)
  scene            TEXT NOT NULL DEFAULT 'paper',       -- CSS fallback when the stage image is missing
  sort_order       INT NOT NULL DEFAULT 100,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  seo_title        TEXT,
  seo_description  TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT categories_id_format   CHECK (id ~ '^[a-z0-9][a-z0-9-]*$' AND char_length(id) <= 64),
  CONSTRAINT categories_scene_valid CHECK (scene IN ('night', 'paper', 'lime', 'violet')),
  CONSTRAINT categories_text_lengths CHECK (
        char_length(btrim(name)) BETWEEN 1 AND 80
    AND (tagline         IS NULL OR char_length(tagline)         <= 160)
    AND (description     IS NULL OR char_length(description)     <= 4000)
    AND (stage_image_url IS NULL OR stage_image_url ~ '^(/[^/\\\s][^\\\s]*|https://[^\\\s]+)$')
    AND (seo_title       IS NULL OR char_length(seo_title)       <= 120)
    AND (seo_description IS NULL OR char_length(seo_description) <= 320))
);

CREATE TABLE IF NOT EXISTS public.products (
  id                 SERIAL PRIMARY KEY,
  slug               TEXT NOT NULL,                     -- unique; product pages are keyed by id (/product/<id>)
  brand              TEXT NOT NULL,
  name               TEXT NOT NULL,
  subtitle           TEXT,                              -- the one-line spec shown on cards
  description        TEXT,
  category_id        TEXT,                              -- FK below (ON UPDATE CASCADE, delete RESTRICTED)
  -- derived (see header) ------------------------------------------------------
  price              NUMERIC(12,2) NOT NULL DEFAULT 0,
  compare_at_price   NUMERIC(12,2),
  default_variant_id INT,
  variant_count      INT NOT NULL DEFAULT 0,
  -- media ---------------------------------------------------------------------
  image_url          TEXT,                              -- = image_urls[1]; NULL when there is no image
  image_urls         TEXT[] NOT NULL DEFAULT '{}',
  cutout_url         TEXT,                              -- transparent cut-out (pop-outs, banners)
  -- facts ---------------------------------------------------------------------
  tags               TEXT[] NOT NULL DEFAULT '{}',      -- lower-case facet words (normalised by trigger)
  attributes         JSONB NOT NULL DEFAULT '{}'::jsonb,-- {specs, highlights, use_cases, in_the_box} — domain-model.md
  warranty_months    INT,
  -- merchandising -------------------------------------------------------------
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  is_new             BOOLEAN NOT NULL DEFAULT FALSE,
  is_bestseller      BOOLEAN NOT NULL DEFAULT FALSE,
  is_featured        BOOLEAN NOT NULL DEFAULT FALSE,
  is_flash_deal      BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order         INT NOT NULL DEFAULT 100,
  rating_avg         NUMERIC(3,2) NOT NULL DEFAULT 0,   -- derived (11_reviews)
  rating_count       INT NOT NULL DEFAULT 0,            -- derived (11_reviews)
  seo_title          TEXT,
  seo_description    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT products_slug_key        UNIQUE (slug),
  CONSTRAINT products_slug_format     CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$' AND char_length(slug) <= 120),
  CONSTRAINT products_price_valid     CHECK (price >= 0 AND (compare_at_price IS NULL OR compare_at_price >= 0)),
  CONSTRAINT products_counts_valid    CHECK (variant_count >= 0 AND rating_count >= 0 AND rating_avg BETWEEN 0 AND 5),
  CONSTRAINT products_warranty_valid  CHECK (warranty_months IS NULL OR warranty_months BETWEEN 0 AND 240),
  CONSTRAINT products_attributes_object CHECK (jsonb_typeof(attributes) = 'object'),
  CONSTRAINT products_text_lengths    CHECK (
        char_length(btrim(brand)) BETWEEN 1 AND 80
    AND char_length(btrim(name))  BETWEEN 1 AND 200
    AND (subtitle        IS NULL OR char_length(subtitle)        <= 200)
    AND (description     IS NULL OR char_length(description)     <= 10000)
    AND (seo_title       IS NULL OR char_length(seo_title)       <= 120)
    AND (seo_description IS NULL OR char_length(seo_description) <= 320))
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_category_id_fkey') THEN
    ALTER TABLE public.products ADD CONSTRAINT products_category_id_fkey
      FOREIGN KEY (category_id) REFERENCES public.categories (id) ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
  -- Added only now that products exists. NOTE for PostgREST: categories <-> products are now
  -- related TWO ways, so embeds must name the FK: products!products_category_id_fkey(…) /
  -- categories!products_category_id_fkey(…) / hero:products!categories_hero_product_id_fkey(…).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'categories_hero_product_id_fkey') THEN
    ALTER TABLE public.categories ADD CONSTRAINT categories_hero_product_id_fkey
      FOREIGN KEY (hero_product_id) REFERENCES public.products (id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.product_variants (
  id               SERIAL PRIMARY KEY,
  product_id       INT NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  sku              TEXT,
  name             TEXT NOT NULL,                       -- 'Standard' for single-variant products
  option_values    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- {"Memory":"16GB","Storage":"512GB"}
  price            NUMERIC(12,2) NOT NULL,
  compare_at_price NUMERIC(12,2),                       -- shown struck through only when > price
  position         INT NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  weight_g         INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_variants_sku_key        UNIQUE (sku),
  CONSTRAINT product_variants_id_product_key UNIQUE (id, product_id),   -- target of inventory's composite FK
  CONSTRAINT product_variants_price_valid    CHECK (price >= 0 AND price <= 100000000
                                                    AND (compare_at_price IS NULL OR compare_at_price >= 0)),
  CONSTRAINT product_variants_sku_format     CHECK (sku IS NULL OR (char_length(sku) BETWEEN 1 AND 64 AND sku !~ '\s')),
  CONSTRAINT product_variants_name_valid     CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT product_variants_options_valid  CHECK (jsonb_typeof(option_values) = 'object'
                                                    AND NOT jsonb_path_exists(option_values, '$.* ? (@.type() != "string")')),
  CONSTRAINT product_variants_weight_valid   CHECK (weight_g IS NULL OR weight_g BETWEEN 0 AND 1000000)
);
CREATE UNIQUE INDEX IF NOT EXISTS product_variants_product_name_key ON public.product_variants (product_id, lower(name));
CREATE INDEX IF NOT EXISTS product_variants_product_idx ON public.product_variants (product_id, position, id);

-- Margins are the owner's business: kept off the publicly readable rows, per variant.
CREATE TABLE IF NOT EXISTS public.product_costs (
  variant_id INT PRIMARY KEY REFERENCES public.product_variants (id) ON DELETE CASCADE,
  cost_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_costs_cost_valid CHECK (cost_price >= 0)
);

CREATE TABLE IF NOT EXISTS public.collections (
  id                  TEXT PRIMARY KEY,                 -- the slug: /collection/<id>
  title               TEXT NOT NULL,
  subtitle            TEXT,                             -- short line on the homepage tile
  description         TEXT,
  cover_image         TEXT,
  type                TEXT NOT NULL DEFAULT 'manual',   -- HOW membership is kept
  rules               JSONB NOT NULL DEFAULT '[]'::jsonb, -- [{field, relation, value}] (automated only)
  match               TEXT NOT NULL DEFAULT 'any',
  kind                TEXT NOT NULL DEFAULT 'curated',  -- WHAT it means
  parent_id           TEXT REFERENCES public.collections (id) ON DELETE SET NULL,
  brand               TEXT,
  theme               JSONB NOT NULL DEFAULT '{}'::jsonb,
  page_content        JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active           BOOLEAN NOT NULL DEFAULT TRUE,
  is_featured         BOOLEAN NOT NULL DEFAULT FALSE,   -- homepage "Featured collections" row
  feature_product_ids INT[] NOT NULL DEFAULT '{}',      -- ≤ 2: tile art, [back, front] cut-outs
  sort_order          INT NOT NULL DEFAULT 100,
  seo_title           TEXT,
  seo_description     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT collections_id_format      CHECK (id ~ '^[a-z0-9][a-z0-9-]*$' AND char_length(id) <= 80),
  CONSTRAINT collections_type_valid     CHECK (type IN ('manual', 'automated')),
  CONSTRAINT collections_match_valid    CHECK (match IN ('any', 'all')),
  CONSTRAINT collections_kind_valid     CHECK (kind IN ('brand', 'line', 'curated')),
  CONSTRAINT collections_rules_array    CHECK (jsonb_typeof(rules) = 'array'),
  CONSTRAINT collections_json_objects   CHECK (jsonb_typeof(theme) = 'object' AND jsonb_typeof(page_content) = 'object'),
  CONSTRAINT collections_feature_valid  CHECK (cardinality(feature_product_ids) <= 2
                                               AND array_position(feature_product_ids, NULL) IS NULL),
  CONSTRAINT collections_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT collections_text_lengths   CHECK (
        char_length(btrim(title)) BETWEEN 1 AND 120
    AND (subtitle        IS NULL OR char_length(subtitle)        <= 200)
    AND (description     IS NULL OR char_length(description)     <= 4000)
    AND (cover_image     IS NULL OR cover_image ~ '^(/[^/\\\s][^\\\s]*|https://[^\\\s]+)$')
    AND (seo_title       IS NULL OR char_length(seo_title)       <= 120)
    AND (seo_description IS NULL OR char_length(seo_description) <= 320))
);

CREATE TABLE IF NOT EXISTS public.product_collections (
  product_id    INT  NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL REFERENCES public.collections (id) ON DELETE CASCADE ON UPDATE CASCADE,
  position      INT  NOT NULL DEFAULT 0,
  source        TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (product_id, collection_id),
  CONSTRAINT product_collections_source_valid CHECK (source IN ('manual', 'rule'))
);

-- Indexes the storefront queries lean on.
CREATE INDEX IF NOT EXISTS categories_sort_idx           ON public.categories (sort_order, id);
CREATE INDEX IF NOT EXISTS products_category_sort_idx    ON public.products (category_id, sort_order, id);
CREATE INDEX IF NOT EXISTS products_brand_lower_idx      ON public.products (lower(brand));
CREATE INDEX IF NOT EXISTS products_tags_gin             ON public.products USING GIN (tags);
CREATE INDEX IF NOT EXISTS products_price_idx            ON public.products (price);
CREATE INDEX IF NOT EXISTS products_created_idx          ON public.products (created_at DESC);
CREATE INDEX IF NOT EXISTS products_sort_idx             ON public.products (sort_order, id);
CREATE INDEX IF NOT EXISTS products_flash_deal_idx       ON public.products (sort_order, id) WHERE is_flash_deal;
CREATE INDEX IF NOT EXISTS products_new_idx              ON public.products (created_at DESC) WHERE is_new;
CREATE INDEX IF NOT EXISTS products_bestseller_idx       ON public.products (sort_order, id) WHERE is_bestseller;
CREATE INDEX IF NOT EXISTS products_featured_idx         ON public.products (sort_order, id) WHERE is_featured;
CREATE INDEX IF NOT EXISTS collections_featured_idx      ON public.collections (sort_order, id) WHERE is_featured;
CREATE INDEX IF NOT EXISTS collections_kind_idx          ON public.collections (kind, sort_order);
CREATE INDEX IF NOT EXISTS product_collections_collection_idx ON public.product_collections (collection_id, position);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Triggers: products
-- ─────────────────────────────────────────────────────────────────────────────
-- BEFORE triggers fire in name order: products_10_normalize → products_20_derived →
-- (06: products_30_search) → products_touch.

-- Tags: lower-case, trimmed, de-duplicated (first occurrence keeps its place), no empties.
-- Images: image_url = image_urls[1] and vice-versa; no placeholder; only site-relative
-- paths ("/images/…") or https URLs (never "//host", never javascript:, and no backslashes
-- anywhere: browsers read "/\host" as "//host").
CREATE OR REPLACE FUNCTION public.products_normalize() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  c_url_re CONSTANT TEXT := '^(/[^/\\\s][^\\\s]*|https://[^\\\s]+)$';
  v_urls   TEXT[];
  v_url    TEXT;
BEGIN
  SELECT COALESCE(array_agg(t ORDER BY ord), '{}') INTO NEW.tags
    FROM (SELECT DISTINCT ON (lower(btrim(x))) lower(btrim(x)) AS t, ord
            FROM unnest(COALESCE(NEW.tags, '{}'::TEXT[])) WITH ORDINALITY AS u(x, ord)
           WHERE x IS NOT NULL AND btrim(x) <> ''
           ORDER BY lower(btrim(x)), ord) s;
  IF cardinality(NEW.tags) > 30 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_tags:at most 30 tags';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(NEW.tags) t WHERE char_length(t) > 40) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_tags:a tag is longer than 40 characters';
  END IF;

  SELECT COALESCE(array_agg(u ORDER BY ord), '{}') INTO v_urls
    FROM (SELECT DISTINCT ON (btrim(x)) btrim(x) AS u, ord
            FROM unnest(COALESCE(NEW.image_urls, '{}'::TEXT[])) WITH ORDINALITY AS a(x, ord)
           WHERE x IS NOT NULL AND btrim(x) <> ''
           ORDER BY btrim(x), ord) s;
  NEW.image_url  := NULLIF(btrim(NEW.image_url), '');
  NEW.cutout_url := NULLIF(btrim(NEW.cutout_url), '');

  IF TG_OP = 'INSERT' THEN
    IF cardinality(v_urls) = 0 AND NEW.image_url IS NOT NULL THEN
      v_urls := ARRAY[NEW.image_url];                  -- only the primary was given
    END IF;                                            -- otherwise the gallery wins
  ELSIF NEW.image_urls IS DISTINCT FROM OLD.image_urls THEN
    NULL;                                              -- gallery edited: it wins
  ELSIF NEW.image_url IS DISTINCT FROM OLD.image_url THEN
    IF NEW.image_url IS NULL THEN
      v_urls := v_urls[2:];                            -- primary removed: next image moves up
    ELSE
      v_urls := ARRAY[NEW.image_url] || array_remove(v_urls, NEW.image_url);  -- primary set/moved to front
    END IF;
  END IF;

  IF cardinality(v_urls) > 12 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_image_url:at most 12 images';
  END IF;
  FOREACH v_url IN ARRAY v_urls LOOP
    IF v_url !~ c_url_re OR char_length(v_url) > 1000 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_image_url:' || left(v_url, 120);
    END IF;
  END LOOP;
  IF NEW.cutout_url IS NOT NULL AND (NEW.cutout_url !~ c_url_re OR char_length(NEW.cutout_url) > 1000) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_image_url:' || left(NEW.cutout_url, 120);
  END IF;

  NEW.image_urls := v_urls;
  NEW.image_url  := v_urls[1];                         -- NULL when the gallery is empty
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.products_normalize() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS products_10_normalize ON public.products;
CREATE TRIGGER products_10_normalize BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.products_normalize();

-- Derived columns are written only by the rollups below (which set app.catalogue_rollup for
-- the duration of their own UPDATE). Everyone else's value is restored — admins included —
-- so the from-price can never disagree with the variants, and ratings come only from reviews.
CREATE OR REPLACE FUNCTION public.products_pin_derived() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF current_setting('app.catalogue_rollup', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.price              := 0;       -- a new product has no variants yet: hidden until it does
    NEW.compare_at_price   := NULL;
    NEW.default_variant_id := NULL;
    NEW.variant_count      := 0;
    NEW.rating_avg         := 0;
    NEW.rating_count       := 0;
  ELSE
    NEW.price              := OLD.price;
    NEW.compare_at_price   := OLD.compare_at_price;
    NEW.default_variant_id := OLD.default_variant_id;
    NEW.variant_count      := OLD.variant_count;
    NEW.rating_avg         := OLD.rating_avg;
    NEW.rating_count       := OLD.rating_count;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.products_pin_derived() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS products_20_derived ON public.products;
CREATE TRIGGER products_20_derived BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.products_pin_derived();

DROP TRIGGER IF EXISTS products_touch ON public.products;
CREATE TRIGGER products_touch BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. From-price rollup (variants → products) and the ratings writer
-- ─────────────────────────────────────────────────────────────────────────────

-- Recompute one product's derived pricing from its ACTIVE variants.
-- Cheapest active variant (ties: lowest position, then lowest id) gives price, its
-- compare_at_price when > price, and default_variant_id. With no active variant the last
-- price is kept (nothing is shown anyway: variant_count = 0 hides the product).
CREATE OR REPLACE FUNCTION public.refresh_product_from_price(p_product_id INT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_prev  TEXT := current_setting('app.catalogue_rollup', true);
  v_id    INT;
  v_price NUMERIC(12,2);
  v_cmp   NUMERIC(12,2);
  v_n     INT;
BEGIN
  IF p_product_id IS NULL THEN RETURN; END IF;
  SELECT count(*)::INT INTO v_n
    FROM public.product_variants WHERE product_id = p_product_id AND is_active;
  SELECT v.id, v.price, v.compare_at_price INTO v_id, v_price, v_cmp
    FROM public.product_variants v
   WHERE v.product_id = p_product_id AND v.is_active
   ORDER BY v.price, v.position, v.id
   LIMIT 1;

  PERFORM set_config('app.catalogue_rollup', 'on', true);
  UPDATE public.products p
     SET price              = CASE WHEN v_id IS NULL THEN p.price ELSE v_price END,
         compare_at_price   = CASE WHEN v_id IS NULL THEN p.compare_at_price
                                   WHEN v_cmp > v_price THEN v_cmp ELSE NULL END,
         default_variant_id = v_id,
         variant_count      = v_n
   WHERE p.id = p_product_id
     AND (p.price, p.compare_at_price, p.default_variant_id, p.variant_count)
         IS DISTINCT FROM
         (CASE WHEN v_id IS NULL THEN p.price ELSE v_price END,
          CASE WHEN v_id IS NULL THEN p.compare_at_price WHEN v_cmp > v_price THEN v_cmp ELSE NULL END,
          v_id, v_n);
  PERFORM set_config('app.catalogue_rollup', COALESCE(v_prev, ''), true);
END $$;
REVOKE ALL ON FUNCTION public.refresh_product_from_price(INT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.product_variants_rollup() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.refresh_product_from_price(OLD.product_id);
    RETURN NULL;
  END IF;
  PERFORM public.refresh_product_from_price(NEW.product_id);
  IF TG_OP = 'UPDATE' AND OLD.product_id IS DISTINCT FROM NEW.product_id THEN
    PERFORM public.refresh_product_from_price(OLD.product_id);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.product_variants_rollup() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS product_variants_rollup_ins_del ON public.product_variants;
CREATE TRIGGER product_variants_rollup_ins_del AFTER INSERT OR DELETE ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.product_variants_rollup();
DROP TRIGGER IF EXISTS product_variants_rollup_upd ON public.product_variants;
CREATE TRIGGER product_variants_rollup_upd
  AFTER UPDATE OF price, compare_at_price, is_active, position, product_id ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.product_variants_rollup();

DROP TRIGGER IF EXISTS product_variants_touch ON public.product_variants;
CREATE TRIGGER product_variants_touch BEFORE UPDATE ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS product_costs_touch ON public.product_costs;
CREATE TRIGGER product_costs_touch BEFORE UPDATE ON public.product_costs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS categories_touch ON public.categories;
CREATE TRIGGER categories_touch BEFORE UPDATE ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
DROP TRIGGER IF EXISTS collections_touch ON public.collections;
CREATE TRIGGER collections_touch BEFORE UPDATE ON public.collections
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- The ONLY writer of products.rating_avg / rating_count. Internal (no grant): 11_reviews
-- calls it from its own definer rollup after a review is approved, rejected or deleted.
CREATE OR REPLACE FUNCTION public._apply_product_rating(p_product_id INT, p_rating_avg NUMERIC, p_rating_count INT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_prev  TEXT := current_setting('app.catalogue_rollup', true);
  v_count INT := GREATEST(COALESCE(p_rating_count, 0), 0);
BEGIN
  IF p_product_id IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.catalogue_rollup', 'on', true);
  UPDATE public.products
     SET rating_count = v_count,
         rating_avg   = CASE WHEN v_count = 0 THEN 0
                             ELSE round(LEAST(GREATEST(COALESCE(p_rating_avg, 0), 0), 5), 2) END
   WHERE id = p_product_id;
  PERFORM set_config('app.catalogue_rollup', COALESCE(v_prev, ''), true);
END $$;
REVOKE ALL ON FUNCTION public._apply_product_rating(INT, NUMERIC, INT) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Collections: rule engine + two-way re-evaluation
-- ─────────────────────────────────────────────────────────────────────────────
-- rules = [{"field": F, "relation": R, "value": V}, …], match = 'any' | 'all'
--   F = tag | brand | category        R = equals | not_equals      (case-insensitive)
--   F = price                          R = lt | lte | gt | gte      (V a number; compares the from-price)
--   F = is_new | is_flash_deal         R = equals                   (V true | false)
-- An automated collection with no rules has no members.

CREATE OR REPLACE FUNCTION public.product_matches_rules(p public.products, p_rules JSONB, p_match TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  r     JSONB;
  ok    BOOLEAN;
  v_rel TEXT;
  v_val TEXT;
  hits  INT := 0;
  total INT := 0;
BEGIN
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'array' THEN RETURN FALSE; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rules) LOOP
    total := total + 1;
    ok := FALSE;
    IF jsonb_typeof(r) = 'object' THEN
      v_rel := r ->> 'relation';
      v_val := lower(btrim(r ->> 'value'));
      ok := CASE r ->> 'field'
        WHEN 'tag' THEN CASE v_rel
            WHEN 'equals'     THEN v_val = ANY (p.tags)
            WHEN 'not_equals' THEN NOT (v_val = ANY (p.tags))
            ELSE FALSE END
        WHEN 'brand' THEN CASE v_rel
            WHEN 'equals'     THEN lower(btrim(p.brand)) = v_val
            WHEN 'not_equals' THEN lower(btrim(p.brand)) <> v_val
            ELSE FALSE END
        WHEN 'category' THEN CASE v_rel
            WHEN 'equals'     THEN p.category_id = v_val
            WHEN 'not_equals' THEN p.category_id IS DISTINCT FROM v_val
            ELSE FALSE END
        WHEN 'price' THEN CASE
            WHEN v_val IS NULL OR v_val !~ '^\d{1,10}(\.\d{1,2})?$' THEN FALSE
            ELSE CASE v_rel
              WHEN 'lt'  THEN p.price <  v_val::NUMERIC
              WHEN 'lte' THEN p.price <= v_val::NUMERIC
              WHEN 'gt'  THEN p.price >  v_val::NUMERIC
              WHEN 'gte' THEN p.price >= v_val::NUMERIC
              ELSE FALSE END
            END
        WHEN 'is_new' THEN v_rel = 'equals' AND v_val IN ('true', 'false') AND p.is_new = (v_val = 'true')
        WHEN 'is_flash_deal' THEN v_rel = 'equals' AND v_val IN ('true', 'false') AND p.is_flash_deal = (v_val = 'true')
        ELSE FALSE
      END;
    END IF;
    IF COALESCE(ok, FALSE) THEN hits := hits + 1; END IF;
  END LOOP;
  IF total = 0 THEN RETURN FALSE; END IF;
  RETURN CASE WHEN p_match = 'all' THEN hits = total ELSE hits > 0 END;
END $$;
REVOKE ALL ON FUNCTION public.product_matches_rules(public.products, JSONB, TEXT) FROM PUBLIC, anon, authenticated;

-- Reject malformed rules at write time (22023 + a message the admin form can show).
CREATE OR REPLACE FUNCTION public.collections_validate() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  r     JSONB;
  i     INT := 0;
  v_f   TEXT;
  v_rel TEXT;
  v_val TEXT;
BEGIN
  NEW.rules := COALESCE(NEW.rules, '[]'::jsonb);
  IF jsonb_typeof(NEW.rules) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_collection_rules:rules must be a JSON array';
  END IF;
  IF jsonb_array_length(NEW.rules) > 20 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_collection_rules:at most 20 rules';
  END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(NEW.rules) LOOP
    i := i + 1;
    IF jsonb_typeof(r) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_collection_rules:rule %s is not an object', i);
    END IF;
    v_f   := r ->> 'field';
    v_rel := r ->> 'relation';
    v_val := btrim(r ->> 'value');
    IF NOT COALESCE((v_f, v_rel) IN (
         ('tag', 'equals'), ('tag', 'not_equals'), ('brand', 'equals'), ('brand', 'not_equals'),
         ('category', 'equals'), ('category', 'not_equals'),
         ('price', 'lt'), ('price', 'lte'), ('price', 'gt'), ('price', 'gte'),
         ('is_new', 'equals'), ('is_flash_deal', 'equals')), FALSE) THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('invalid_collection_rules:rule %s has an unsupported field/relation (%s/%s)', i,
                         COALESCE(v_f, 'null'), COALESCE(v_rel, 'null'));
    END IF;
    IF v_val IS NULL OR v_val = '' OR char_length(v_val) > 120 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_collection_rules:rule %s needs a value', i);
    END IF;
    IF v_f = 'price' AND v_val !~ '^\d{1,10}(\.\d{1,2})?$' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_collection_rules:rule %s price must be a number', i);
    END IF;
    IF v_f IN ('is_new', 'is_flash_deal') AND lower(v_val) NOT IN ('true', 'false') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_collection_rules:rule %s value must be true or false', i);
    END IF;
  END LOOP;
  -- tile art: de-duplicate, keep order
  SELECT COALESCE(array_agg(x ORDER BY ord), '{}') INTO NEW.feature_product_ids
    FROM (SELECT DISTINCT ON (x) x, ord
            FROM unnest(COALESCE(NEW.feature_product_ids, '{}'::INT[])) WITH ORDINALITY AS u(x, ord)
           WHERE x IS NOT NULL ORDER BY x, ord) s;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.collections_validate() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS collections_10_validate ON public.collections;
CREATE TRIGGER collections_10_validate BEFORE INSERT OR UPDATE ON public.collections
  FOR EACH ROW EXECUTE FUNCTION public.collections_validate();

-- Rule rows sort AFTER hand-picked ones: the storefront orders members by (position, product_id)
-- and hand-picked positions are 0, 1, 2 … (23_admin_catalogue's admin_set_collection_products).
-- A product changed: re-evaluate its rule memberships (manual memberships untouched).
CREATE OR REPLACE FUNCTION public.sync_product_rule_collections() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM public.product_collections WHERE product_id = NEW.id AND source = 'rule';
  INSERT INTO public.product_collections (product_id, collection_id, position, source)
  SELECT NEW.id, c.id, 100000, 'rule'
    FROM public.collections c
   WHERE c.type = 'automated' AND public.product_matches_rules(NEW, c.rules, c.match)
  ON CONFLICT (product_id, collection_id) DO NOTHING;   -- a manual row for the pair wins
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.sync_product_rule_collections() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS products_rule_collections ON public.products;
DROP TRIGGER IF EXISTS products_rule_collections_ins ON public.products;
CREATE TRIGGER products_rule_collections_ins AFTER INSERT ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.sync_product_rule_collections();
DROP TRIGGER IF EXISTS products_rule_collections_upd ON public.products;
CREATE TRIGGER products_rule_collections_upd
  AFTER UPDATE OF tags, brand, category_id, price, is_new, is_flash_deal ON public.products
  FOR EACH ROW
  WHEN (OLD.tags IS DISTINCT FROM NEW.tags OR OLD.brand IS DISTINCT FROM NEW.brand
        OR OLD.category_id IS DISTINCT FROM NEW.category_id OR OLD.price IS DISTINCT FROM NEW.price
        OR OLD.is_new IS DISTINCT FROM NEW.is_new OR OLD.is_flash_deal IS DISTINCT FROM NEW.is_flash_deal)
  EXECUTE FUNCTION public.sync_product_rule_collections();

-- Rewrite ONE collection's rule rows from its current type/rules/match (none when 'manual').
-- The single implementation (P6): the collection trigger below and 23_admin_catalogue's
-- admin_set_collection_products (after hand-picked rows change) both call it. Internal: no grant.
CREATE OR REPLACE FUNCTION public._refresh_collection_rule_members(p_collection_id TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM public.product_collections WHERE collection_id = p_collection_id AND source = 'rule';
  INSERT INTO public.product_collections (product_id, collection_id, position, source)
  SELECT p.id, c.id, 100000, 'rule'
    FROM public.collections c
    JOIN public.products p ON public.product_matches_rules(p, c.rules, c.match)
   WHERE c.id = p_collection_id AND c.type = 'automated'
  ON CONFLICT (product_id, collection_id) DO NOTHING;   -- a manual row for the pair wins
END $$;
REVOKE ALL ON FUNCTION public._refresh_collection_rule_members(TEXT) FROM PUBLIC, anon, authenticated;

-- A collection's rules changed: re-evaluate every product (the reference store forgot this half).
-- Switching a collection to 'manual' drops its rule rows and keeps its manual rows.
CREATE OR REPLACE FUNCTION public.sync_collection_rule_members() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM public._refresh_collection_rule_members(NEW.id);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.sync_collection_rule_members() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS collections_rule_members ON public.collections;
DROP TRIGGER IF EXISTS collections_rule_members_ins ON public.collections;
CREATE TRIGGER collections_rule_members_ins AFTER INSERT ON public.collections
  FOR EACH ROW EXECUTE FUNCTION public.sync_collection_rule_members();
DROP TRIGGER IF EXISTS collections_rule_members_upd ON public.collections;
CREATE TRIGGER collections_rule_members_upd AFTER UPDATE OF type, rules, match ON public.collections
  FOR EACH ROW
  WHEN (OLD.type IS DISTINCT FROM NEW.type OR OLD.rules IS DISTINCT FROM NEW.rules OR OLD.match IS DISTINCT FROM NEW.match)
  EXECUTE FUNCTION public.sync_collection_rule_members();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Row-level security (default deny; public reads only what a shopper may see)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.categories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_costs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collections         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_collections ENABLE ROW LEVEL SECURITY;

-- Table privileges: anon may only ever SELECT (no anonymous writes anywhere, P2); nobody
-- TRUNCATEs through the API (RLS does not apply to TRUNCATE). product_costs is sealed from anon.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.categories, public.products, public.product_variants, public.collections, public.product_collections
  FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER
  ON public.categories, public.products, public.product_variants, public.collections,
     public.product_collections, public.product_costs
  FROM authenticated;
REVOKE ALL ON public.product_costs FROM anon;
REVOKE ALL ON SEQUENCE public.products_id_seq, public.product_variants_id_seq FROM anon;

DROP POLICY IF EXISTS categories_public_read ON public.categories;
CREATE POLICY categories_public_read ON public.categories
  FOR SELECT TO anon, authenticated USING (is_active);
DROP POLICY IF EXISTS categories_admin_all ON public.categories;
CREATE POLICY categories_admin_all ON public.categories
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- A product is shown only while active AND purchasable (≥ 1 active variant).
DROP POLICY IF EXISTS products_public_read ON public.products;
CREATE POLICY products_public_read ON public.products
  FOR SELECT TO anon, authenticated USING (is_active AND variant_count > 0);
DROP POLICY IF EXISTS products_admin_all ON public.products;
CREATE POLICY products_admin_all ON public.products
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS product_variants_public_read ON public.product_variants;
CREATE POLICY product_variants_public_read ON public.product_variants
  FOR SELECT TO anon, authenticated
  USING (is_active AND EXISTS (SELECT 1 FROM public.products p
                                WHERE p.id = product_variants.product_id AND p.is_active));
DROP POLICY IF EXISTS product_variants_admin_all ON public.product_variants;
CREATE POLICY product_variants_admin_all ON public.product_variants
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS product_costs_admin_all ON public.product_costs;
CREATE POLICY product_costs_admin_all ON public.product_costs
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS collections_public_read ON public.collections;
CREATE POLICY collections_public_read ON public.collections
  FOR SELECT TO anon, authenticated USING (is_active);
DROP POLICY IF EXISTS collections_admin_all ON public.collections;
CREATE POLICY collections_admin_all ON public.collections
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

DROP POLICY IF EXISTS product_collections_public_read ON public.product_collections;
CREATE POLICY product_collections_public_read ON public.product_collections
  FOR SELECT TO anon, authenticated
  USING (EXISTS (SELECT 1 FROM public.collections c
                  WHERE c.id = product_collections.collection_id AND c.is_active)
         AND EXISTS (SELECT 1 FROM public.products p
                      WHERE p.id = product_collections.product_id AND p.is_active AND p.variant_count > 0));
DROP POLICY IF EXISTS product_collections_admin_all ON public.product_collections;
CREATE POLICY product_collections_admin_all ON public.product_collections
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Storage (Supabase only; skipped where the storage schema does not exist)
-- ─────────────────────────────────────────────────────────────────────────────
-- Public buckets serve files by URL without a SELECT policy, so none is created for anon —
-- that also stops anonymous listing. Admins get every verb on these two buckets only.
-- Raster images only (SVG can carry script), 5 MB cap (admin uploads are converted to WebP).
DO $$
DECLARE
  v_has_limits BOOLEAN;
BEGIN
  IF to_regclass('storage.buckets') IS NULL OR to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE '04_catalogue: storage schema not found — buckets skipped (Supabase provides it)';
    RETURN;
  END IF;
  SELECT count(*) = 2 INTO v_has_limits
    FROM information_schema.columns
   WHERE table_schema = 'storage' AND table_name = 'buckets'
     AND column_name IN ('file_size_limit', 'allowed_mime_types');
  IF v_has_limits THEN
    EXECUTE $q$
      INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      VALUES ('product-images', 'product-images', TRUE, 5242880,
              ARRAY['image/webp', 'image/jpeg', 'image/png', 'image/avif']),
             ('content-images', 'content-images', TRUE, 5242880,
              ARRAY['image/webp', 'image/jpeg', 'image/png', 'image/avif'])
      ON CONFLICT (id) DO UPDATE SET public = TRUE$q$;
  ELSE
    EXECUTE $q$
      INSERT INTO storage.buckets (id, name, public)
      VALUES ('product-images', 'product-images', TRUE), ('content-images', 'content-images', TRUE)
      ON CONFLICT (id) DO UPDATE SET public = TRUE$q$;
  END IF;
  EXECUTE 'DROP POLICY IF EXISTS "dockone admin write catalogue images" ON storage.objects';
  EXECUTE $p$
    CREATE POLICY "dockone admin write catalogue images" ON storage.objects
      FOR ALL TO authenticated
      USING (bucket_id IN ('product-images', 'content-images') AND (SELECT public.is_admin()))
      WITH CHECK (bucket_id IN ('product-images', 'content-images') AND (SELECT public.is_admin()))$p$;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 04_catalogue
--   Nothing to configure. Load products with 30_seed_catalogue.sql (DEMO) or the admin panel.
--   Pricing lives on product_variants: products.price is the trigger-maintained "from" price.
--   A product with no active variant is invisible to shoppers (variant_count = 0) — add a
--   variant, or it will never appear. Admin uploads go to the product-images / content-images
--   buckets; pin next.config images.remotePatterns + CSP img-src to <project>.supabase.co.
--   Verification:
--     SELECT slug FROM public.products WHERE is_active AND variant_count = 0;    -- hidden, needs a variant
--     SELECT p.slug, p.price, min(v.price) FROM public.products p
--       JOIN public.product_variants v ON v.product_id = p.id AND v.is_active
--      GROUP BY p.id HAVING p.price <> min(v.price);                           -- 0 rows
--     SELECT id, public FROM storage.buckets WHERE id IN ('product-images','content-images');  -- both public
--     -- live probes (anon key is public): cost prices sealed, writes refused
--     curl -s "$SUPABASE_URL/rest/v1/product_costs?select=*" -H "apikey: $ANON"   -- permission denied
--     curl -s -X POST "$SUPABASE_URL/rest/v1/products" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
--          -H "Content-Type: application/json" -d '{"slug":"x","brand":"x","name":"x"}'   -- permission denied
-- ═════════════════════════════════════════════════════════════════════════════
