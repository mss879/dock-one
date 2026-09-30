-- ═════════════════════════════════════════════════════════════════════════════
-- 06_catalogue_search.sql — Dock One Solutions
--
-- PURPOSE      Site search and catalogue facets.
--              * products.search_vector: a trigger-maintained, weighted tsvector
--                  A = name, brand · B = subtitle (the card spec line) · C = category id + name,
--                  tags, active variant names / SKUs / option values · D = description,
--                  attributes.specs string values, highlights, use_cases, in_the_box
--                ('simple' config: product names and model numbers must not be stemmed away),
--                with a GIN index.
--              * search_products(p_query, p_limit, p_offset) → ranked (product_id, rank,
--                total_count) for VISIBLE products (active, ≥ 1 active variant). Every word is
--                prefix-matched ("ssd", "keyb" work), simple plurals fold ("keyboards"),
--                filler words are ignored ("laptop for gaming"). If nothing matches and pg_trgm
--                is installed, a fuzzy fallback catches typos ("keybord", "portble ssd").
--              * catalogue_facets(p_category) → brands, price range and REAL category counts.
--              BUILD_SPEC §3 (06), §6 (CategoryPopouts real counts), §9 WP-A.
-- DEPENDS ON   04_catalogue (products, product_variants, categories). Optional: pg_trgm
--              (installed into the `extensions` schema when possible, skipped otherwise).
-- ENABLES      /shop?q= search (the header SearchBar), /shop brand + price filters and category
--              counts (WP-A, WP-B), the assistant's catalogue search (WP-I).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- Pre-flight: fuzzy matching is optional. Install pg_trgm into `extensions` when the
-- platform allows it; otherwise search still works (exact/prefix only) and we say so.
DO $$
DECLARE
  v_schema TEXT;
BEGIN
  SELECT n.nspname INTO v_schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'pg_trgm';
  IF v_schema IS NOT NULL THEN
    RAISE NOTICE '06_catalogue_search: pg_trgm present in schema % — fuzzy fallback on', v_schema;
  ELSIF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
    BEGIN
      CREATE SCHEMA IF NOT EXISTS extensions;
      CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
      RAISE NOTICE '06_catalogue_search: installed pg_trgm in schema extensions — fuzzy fallback on';
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '06_catalogue_search: could not install pg_trgm (%) — fuzzy fallback off', SQLERRM;
    END;
  ELSE
    RAISE WARNING '06_catalogue_search: pg_trgm is not available — fuzzy fallback off';
  END IF;
END $$;

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS search_vector tsvector;
CREATE INDEX IF NOT EXISTS products_search_vector_gin ON public.products USING GIN (search_vector);

-- The search document for one product row. Internal (no grant).
CREATE OR REPLACE FUNCTION public.product_search_document(p public.products) RETURNS tsvector
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT
      setweight(to_tsvector('simple', regexp_replace(
        COALESCE(p.name, '') || ' ' || COALESCE(p.brand, ''), '[·•|]', ' ', 'g')), 'A')
   || setweight(to_tsvector('simple', regexp_replace(COALESCE(p.subtitle, ''), '[·•|]', ' ', 'g')), 'B')
   || setweight(to_tsvector('simple', regexp_replace(
        COALESCE(p.category_id, '') || ' '
        || COALESCE((SELECT c.name FROM public.categories c WHERE c.id = p.category_id), '') || ' '
        || array_to_string(COALESCE(p.tags, '{}'::TEXT[]), ' ') || ' '
        || COALESCE((SELECT string_agg(v.name || ' ' || COALESCE(v.sku, '') || ' '
                                       || COALESCE((SELECT string_agg(o.value, ' ') FROM jsonb_each_text(v.option_values) o), ''),
                                       ' ')
                       FROM public.product_variants v
                      WHERE v.product_id = p.id AND v.is_active), ''),
        '[·•|]', ' ', 'g')), 'C')
   || setweight(to_tsvector('simple', regexp_replace(
        COALESCE(p.description, '') || ' '
        || COALESCE((SELECT string_agg(x #>> '{}', ' ')
                       FROM jsonb_path_query(p.attributes, 'lax $.specs.*[*]') AS x
                      WHERE jsonb_typeof(x) = 'string'), '') || ' '
        || COALESCE((SELECT string_agg(x #>> '{}', ' ')
                       FROM jsonb_path_query(p.attributes, 'lax $.highlights[*]') AS x
                      WHERE jsonb_typeof(x) = 'string'), '') || ' '
        || COALESCE((SELECT string_agg(x #>> '{}', ' ')
                       FROM jsonb_path_query(p.attributes, 'lax $.use_cases[*]') AS x
                      WHERE jsonb_typeof(x) = 'string'), '') || ' '
        || COALESCE((SELECT string_agg(x #>> '{}', ' ')
                       FROM jsonb_path_query(p.attributes, 'lax $.in_the_box[*]') AS x
                      WHERE jsonb_typeof(x) = 'string'), ''),
        '[·•|]', ' ', 'g')), 'D')
$$;
REVOKE ALL ON FUNCTION public.product_search_document(public.products) FROM PUBLIC, anon, authenticated;

-- Keep the vector current on every product write (definer: the document reads variants and
-- categories whatever the writer's RLS view is).
CREATE OR REPLACE FUNCTION public.products_search_vector_refresh() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.search_vector := public.product_search_document(NEW);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.products_search_vector_refresh() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS products_30_search ON public.products;
CREATE TRIGGER products_30_search BEFORE INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.products_search_vector_refresh();

-- Variant names/SKUs/options and category names are part of the document: re-index the
-- affected products when they change (the UPDATE fires products_30_search).
CREATE OR REPLACE FUNCTION public.product_variants_search_touch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE public.products SET search_vector = NULL WHERE id = OLD.product_id;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.product_id IS DISTINCT FROM OLD.product_id) THEN
    UPDATE public.products SET search_vector = NULL WHERE id = NEW.product_id;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.product_variants_search_touch() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS product_variants_search_ins_del ON public.product_variants;
CREATE TRIGGER product_variants_search_ins_del AFTER INSERT OR DELETE ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.product_variants_search_touch();
DROP TRIGGER IF EXISTS product_variants_search_upd ON public.product_variants;
CREATE TRIGGER product_variants_search_upd
  AFTER UPDATE OF name, sku, option_values, is_active, product_id ON public.product_variants
  FOR EACH ROW
  WHEN (OLD.name IS DISTINCT FROM NEW.name OR OLD.sku IS DISTINCT FROM NEW.sku
        OR OLD.option_values IS DISTINCT FROM NEW.option_values
        OR OLD.is_active IS DISTINCT FROM NEW.is_active OR OLD.product_id IS DISTINCT FROM NEW.product_id)
  EXECUTE FUNCTION public.product_variants_search_touch();

CREATE OR REPLACE FUNCTION public.categories_search_touch() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.products SET search_vector = NULL WHERE category_id = NEW.id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.categories_search_touch() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS categories_search_touch ON public.categories;
CREATE TRIGGER categories_search_touch AFTER UPDATE OF name ON public.categories
  FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION public.categories_search_touch();

-- Backfill rows that existed before this migration (the trigger computes the value).
UPDATE public.products SET search_vector = NULL WHERE search_vector IS NULL;

-- Quote one lexeme for tsquery input: it's → 'it''s', a\b → 'a\\b'. Internal (no grant).
CREATE OR REPLACE FUNCTION public._quote_tsquery_lexeme(p_lexeme TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT '''' || replace(replace(p_lexeme, '\', '\\'), '''', '''''') || ''''
$$;
REVOKE ALL ON FUNCTION public._quote_tsquery_lexeme(TEXT) FROM PUBLIC, anon, authenticated;

-- Shopper text → tsquery. Internal (no grant). NULL when nothing searchable remains.
--   * tokens come from the same 'simple' parser as the documents; ≤ 8 of them, ≤ 40 chars each;
--   * filler words are dropped (unless nothing else is left); 1-character tokens are dropped
--     when longer ones exist ("keyb's" → keyb); tokens with no letter or digit are dropped;
--   * every token of ≥ 2 characters is a PREFIX match; a trailing plural "s" also matches
--     the singular ("keyboards" → keyboards:* | keyboard:*);
--   * all tokens must match (AND).
-- The tsquery is built by casting quoted lexemes, never by concatenating shopper text into
-- tsquery syntax, so operators such as & | ! : * ( ) < > in the input are inert.
CREATE OR REPLACE FUNCTION public._search_tsquery(p_query TEXT) RETURNS tsquery
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  c_filler CONSTANT TEXT[] := ARRAY['a', 'an', 'and', 'the', 'for', 'with', 'of', 'in', 'on', 'to', 'my',
                                    'me', 'i', 'is', 'it', 'at', 'by', 'or', 'from', 'need', 'want',
                                    'looking', 'some', 'any', 'please'];
  v_all   TEXT[];
  v_terms TEXT[];
  v_t     TEXT;
  v_part  tsquery;
  v_q     tsquery;
BEGIN
  SELECT COALESCE(array_agg(t), '{}') INTO v_all
    FROM unnest(tsvector_to_array(to_tsvector('simple',
           regexp_replace(left(COALESCE(p_query, ''), 200), '[·•|]', ' ', 'g')))) AS t
   WHERE char_length(t) <= 40 AND t ~ '[[:alnum:]]';

  SELECT COALESCE(array_agg(t), '{}') INTO v_terms FROM unnest(v_all) t WHERE NOT (t = ANY (c_filler));
  IF cardinality(v_terms) = 0 THEN v_terms := v_all; END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_terms) t WHERE char_length(t) > 1) THEN
    SELECT array_agg(t) INTO v_terms FROM unnest(v_terms) t WHERE char_length(t) > 1;
  END IF;
  IF cardinality(v_terms) = 0 THEN RETURN NULL; END IF;
  v_terms := v_terms[1:8];

  FOREACH v_t IN ARRAY v_terms LOOP
    IF char_length(v_t) >= 2 THEN
      v_part := (public._quote_tsquery_lexeme(v_t) || ':*')::tsquery;
      IF char_length(v_t) >= 4 AND v_t ~ '[^s]s$' THEN
        v_part := v_part || (public._quote_tsquery_lexeme(left(v_t, -1)) || ':*')::tsquery;
      END IF;
    ELSE
      v_part := public._quote_tsquery_lexeme(v_t)::tsquery;
    END IF;
    v_q := CASE WHEN v_q IS NULL THEN v_part ELSE v_q && v_part END;
  END LOOP;
  RETURN v_q;
END $$;
REVOKE ALL ON FUNCTION public._search_tsquery(TEXT) FROM PUBLIC, anon, authenticated;

-- Public search. Returns one page of ranked product ids; the caller fetches the cards by id
-- (keeping this order). total_count = matches across all pages (repeated on every row; an
-- empty page carries no count). Inputs are clamped: query ≤ 100 chars, limit 1..48 (default
-- 24), offset 0..10000.
-- Rank = ts_rank_cd over the weighted vector + 0.5 when the name or brand starts with the
-- query; ties → sort_order, id. Fuzzy fallback (pg_trgm) only when nothing matched:
-- word_similarity(query, brand + name + subtitle) ≥ 0.5, ranked by similarity.
CREATE OR REPLACE FUNCTION public.search_products(p_query TEXT, p_limit INT DEFAULT 24, p_offset INT DEFAULT 0)
RETURNS TABLE (product_id INT, rank REAL, total_count INT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  -- truncate BEFORE any regex work: the anon key can send arbitrarily long strings
  v_q      TEXT := left(btrim(regexp_replace(left(COALESCE(p_query, ''), 400), '\s+', ' ', 'g')), 100);
  v_lq     TEXT;
  v_limit  INT  := LEAST(GREATEST(COALESCE(p_limit, 24), 1), 48);
  v_offset INT  := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 10000);
  v_tsq    tsquery;
  v_total  INT  := 0;
BEGIN
  IF v_q = '' THEN RETURN; END IF;
  v_lq  := lower(v_q);
  v_tsq := public._search_tsquery(v_q);

  IF v_tsq IS NOT NULL THEN
    SELECT count(*)::INT INTO v_total
      FROM public.products p
     WHERE p.is_active AND p.variant_count > 0 AND p.search_vector @@ v_tsq;
  END IF;

  IF v_total > 0 THEN
    RETURN QUERY
      SELECT p.id,
             (ts_rank_cd(p.search_vector, v_tsq)
              + CASE WHEN starts_with(lower(p.name), v_lq) OR starts_with(lower(p.brand), v_lq)
                     THEN 0.5 ELSE 0 END)::REAL,
             v_total
        FROM public.products p
       WHERE p.is_active AND p.variant_count > 0 AND p.search_vector @@ v_tsq
       ORDER BY 2 DESC, p.sort_order, p.id
       LIMIT v_limit OFFSET v_offset;
    RETURN;
  END IF;

  -- Fuzzy fallback: typos. Only when pg_trgm is installed (checked at call time).
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AND char_length(v_lq) >= 3 THEN
    RETURN QUERY
      WITH f AS (
        SELECT p.id, p.sort_order,
               word_similarity(v_lq, lower(p.brand || ' ' || p.name || ' ' || COALESCE(p.subtitle, ''))) AS sim
          FROM public.products p
         WHERE p.is_active AND p.variant_count > 0)
      SELECT f.id, f.sim::REAL, (count(*) OVER ())::INT
        FROM f
       WHERE f.sim >= 0.5
       ORDER BY f.sim DESC, f.sort_order, f.id
       LIMIT v_limit OFFSET v_offset;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.search_products(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_products(TEXT, INT, INT) TO anon, authenticated;

-- Facets for /shop and the homepage: counts are of VISIBLE products (active, ≥ 1 active
-- variant). `categories` lists every active category with its real count (global, ignoring
-- p_category); `brands`, `price` and `total` are scoped to p_category when given.
CREATE OR REPLACE FUNCTION public.catalogue_facets(p_category TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH arg AS (
    SELECT NULLIF(lower(btrim(left(COALESCE(p_category, ''), 200))), '') AS category   -- truncate first
  ), visible AS (
    SELECT p.id, p.brand, p.category_id, p.price
      FROM public.products p
     WHERE p.is_active AND p.variant_count > 0
  ), scoped AS (
    SELECT v.* FROM visible v, arg
     WHERE arg.category IS NULL OR v.category_id = arg.category
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM scoped),
    'price', jsonb_build_object('min', (SELECT min(price) FROM scoped),
                                'max', (SELECT max(price) FROM scoped)),
    'brands', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('brand', b.brand, 'count', b.n) ORDER BY lower(b.brand))
          FROM (SELECT min(btrim(brand)) AS brand, count(*) AS n
                  FROM scoped GROUP BY lower(btrim(brand))) b), '[]'::jsonb),
    'categories', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'count', COALESCE(n.n, 0))
                         ORDER BY c.sort_order, c.id)
          FROM public.categories c
          LEFT JOIN (SELECT category_id, count(*) AS n FROM visible GROUP BY category_id) n
            ON n.category_id = c.id
         WHERE c.is_active), '[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION public.catalogue_facets(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.catalogue_facets(TEXT) TO anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 06_catalogue_search
--   Nothing to configure. If the migration printed "fuzzy fallback off", enable pg_trgm in
--   Supabase (Database → Extensions → pg_trgm, schema `extensions`) and typo-tolerance switches
--   on by itself — no re-run needed.
--   Do NOT `select('*')` products in storefront code: search_vector is large and useless to
--   the browser. Name columns (PRODUCT_CARD_FIELDS).
--   Verification:
--     SELECT count(*) FROM public.products WHERE search_vector IS NULL;          -- 0
--     SELECT * FROM public.search_products('ssd', 5, 0);                         -- ranked ids + total
--     SELECT public.catalogue_facets(NULL) -> 'categories';                      -- real counts
--     -- live probe (anon key is public):
--     curl -s "$SUPABASE_URL/rest/v1/rpc/search_products" -H "apikey: $ANON" \
--          -H "Content-Type: application/json" -d '{"p_query":"keyb","p_limit":5,"p_offset":0}'
-- ═════════════════════════════════════════════════════════════════════════════
