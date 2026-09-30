-- ═════════════════════════════════════════════════════════════════════════════
-- 23_admin_catalogue.sql — Dock One Solutions
--
-- PURPOSE      The admin catalogue's writes that must never half-apply, and its list views.
--
--   admin_save_product(p_product, p_variants)                        grant U, admin re-checked
--       ONE transaction: insert or update the product (the database assigns the id), diff its
--       variants (insert / update / delete — or DEACTIVATE a removed variant that past order
--       lines reference), upsert or clear per-variant cost prices, and apply stock ONLY for the
--       variants whose stock fields were supplied (tracking on = an inventory row, off = no
--       row). Editing a product never resets stock (blueprint §11.2 — the reference store
--       re-inserted inventory at 50 on every edit).
--   admin_set_collection_products(p_collection_id, p_product_ids)    grant U, admin re-checked
--       Replaces a collection's hand-picked members AND their order in one call (blueprint
--       §11.3.3: a reorder is one RPC, so a half-applied reorder can't leave two items in one
--       slot). Rule members are then re-derived by 04's _refresh_collection_rule_members().
--   admin_product_list, admin_inventory                               views, security_invoker
--       The Products and Inventory tabs' lists: variant counts, SKUs, total stock and the
--       admin's low-stock flag — the SAME rule as 17's admin_low_stock (dashboard): a tracked,
--       active variant of an active product with stock_level <= low_stock_threshold (sold out
--       counts, unlike the shopper-facing get_product_availability) — so the tabs filter, sort
--       ("low stock first") and paginate in the database. RLS of the underlying tables applies:
--       anon has no privilege at all, a shopper sees no stock, an admin sees everything.
--   products_forget_collection_art                                    trigger
--       A deleted product leaves collections.feature_product_ids (homepage tile art).
--
--   Blueprint §7.1 (function wrapper), §7.4, §11.2, §11.3; BUILD_SPEC §3 (23), §4.3, §9 WP-K.
-- DEPENDS ON   02 (is_admin), 04 (catalogue, _refresh_collection_rule_members), 05 (inventory),
--              07 (order_items: which variants past orders reference).
-- ENABLES      admin Products / Collections / Inventory tabs (WP-K).
-- ERRORS       42501 `not_authorised:…` (caller is not an admin). 22023 `code:human text` —
--              invalid_product, invalid_slug, invalid_variant, invalid_stock, product_not_found,
--              variants_required, duplicate_variant_name, duplicate_sku, variant_name_taken,
--              sku_taken, collection_not_found, invalid_products, unknown_product (the text after
--              the first ':' is written for the admin). CHECK / unique / FK violations of 04 and 05
--              surface unchanged (23514 / 23505 / 23503 with the constraint name) and 04's
--              triggers raise invalid_image_url / invalid_tags (22023). docs/build/SQL_NOTES.md (23).
-- LOCK ORDER   admin_save_product locks the product's inventory rows FIRST, in (product_id,
--              variant_id) order, before any product/variant row — the order place_order and the
--              cancellation in admin_set_order_status use (SQL_NOTES, 09), so they cannot deadlock.
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. JSON field readers (internal, no grant). NULL/absent → NULL; anything else of the wrong
--    type or range → 22023 `<p_code>:<p_label> …` written for the admin form.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._admin_json_text(p_code TEXT, p_value JSONB, p_label TEXT, p_max INT,
                                                   p_required BOOLEAN DEFAULT FALSE)
RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v TEXT;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    v := NULL;
  ELSIF jsonb_typeof(p_value) <> 'string' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('%s:%s must be text.', p_code, p_label);
  ELSE
    v := NULLIF(btrim(p_value #>> '{}', E' \t\r\n'), '');
  END IF;
  IF v IS NULL AND p_required THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('%s:%s is required.', p_code, p_label);
  END IF;
  IF char_length(v) > p_max THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('%s:%s can be at most %s characters.', p_code, p_label, to_char(p_max, 'FM999,999,990'));
  END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public._admin_json_text(TEXT, JSONB, TEXT, INT, BOOLEAN) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._admin_json_int(p_code TEXT, p_value JSONB, p_label TEXT, p_min INT, p_max INT)
RETURNS INT
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v NUMERIC;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_value) = 'number' THEN
    v := (p_value #>> '{}')::NUMERIC;
  END IF;
  IF v IS NULL OR v <> trunc(v) OR v < p_min OR v > p_max THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('%s:%s must be a whole number from %s to %s.', p_code, p_label,
                       to_char(p_min, 'FM999,999,999,990'), to_char(p_max, 'FM999,999,999,990'));
  END IF;
  RETURN v::INT;
END $$;
REVOKE ALL ON FUNCTION public._admin_json_int(TEXT, JSONB, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;

-- Rupees: ≥ 0, at most 2 decimals. The upper bounds stay with the table CHECKs
-- (product_variants_price_valid: ≤ 100,000,000), so their names reach the admin form.
CREATE OR REPLACE FUNCTION public._admin_json_money(p_code TEXT, p_value JSONB, p_label TEXT)
RETURNS NUMERIC
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v NUMERIC;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_value) = 'number' THEN
    v := (p_value #>> '{}')::NUMERIC;
  END IF;
  IF v IS NULL OR v < 0 OR v <> round(v, 2) OR v >= 10000000000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('%s:%s must be an amount in rupees (0 or more).', p_code, p_label);
  END IF;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public._admin_json_money(TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._admin_json_bool(p_code TEXT, p_value JSONB, p_label TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(p_value) <> 'boolean' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('%s:%s must be true or false.', p_code, p_label);
  END IF;
  RETURN (p_value #>> '{}')::BOOLEAN;
END $$;
REVOKE ALL ON FUNCTION public._admin_json_bool(TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;

-- A JSON array of strings → TEXT[] ('{}' for NULL/absent). The content rules (URL forms, tag
-- length, ≤ 12 images, ≤ 30 tags) stay in 04's products_normalize() trigger.
CREATE OR REPLACE FUNCTION public._admin_json_text_array(p_code TEXT, p_value JSONB, p_label TEXT, p_max_items INT)
RETURNS TEXT[]
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RETURN '{}'::TEXT[];
  END IF;
  IF jsonb_typeof(p_value) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('%s:%s must be a list.', p_code, p_label);
  END IF;
  IF jsonb_array_length(p_value) > p_max_items THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('%s:%s can have at most %s entries.', p_code, p_label, p_max_items);
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_value) x WHERE jsonb_typeof(x) <> 'string') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('%s:%s must be a list of text.', p_code, p_label);
  END IF;
  RETURN ARRAY(SELECT jsonb_array_elements_text(p_value));
END $$;
REVOKE ALL ON FUNCTION public._admin_json_text_array(TEXT, JSONB, TEXT, INT) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. admin_save_product(p_product JSONB, p_variants JSONB DEFAULT NULL) → JSONB
-- ─────────────────────────────────────────────────────────────────────────────
-- p_product  object. `id` absent/null = create (the database assigns the id; slug, brand and name
--            required). With an id = update: ONLY the keys present change (absent = keep).
--            Keys: id, slug, brand, name, subtitle, description, category_id, image_urls[],
--            cutout_url, tags[], attributes{}, warranty_months, is_active, is_new, is_bestseller,
--            is_featured, is_flash_deal, sort_order, seo_title, seo_description. Anything else
--            (price, image_url, variant_count … are derived) is refused. image_url follows
--            image_urls[1] (04's trigger).
-- p_variants NULL = leave the variants alone (update only). Otherwise the COMPLETE list, 1–100:
--            each object needs name + price; `id` = an existing variant OF THIS PRODUCT (update),
--            no id = new. Existing variants not listed are removed: deleted, or deactivated when
--            order lines reference them (orders keep their snapshots either way).
--            Optional per variant: sku, option_values{text: text}, compare_at_price, position
--            (default = list order for new rows), is_active, weight_g (absent on update = keep),
--              cost_price     present: a number upserts product_costs, null clears it; absent = keep
--              track_stock    false → the inventory row is removed (not tracked: always sells)
--              stock_level, low_stock_threshold, or track_stock true → the row exists (new rows
--                             start from the column defaults: 0 in stock, threshold 3) and the
--                             supplied values are written. None of the three (or all null) = the
--                             stock is NOT touched — send them only when the admin edited them.
-- Returns {product_id, created, slug, price, compare_at_price, variant_count, default_variant_id,
--          variants: [{id, name, created}] in list order ([] when p_variants is NULL),
--          deleted_variant_ids: [], deactivated_variant_ids: []}.
CREATE OR REPLACE FUNCTION public.admin_save_product(p_product JSONB, p_variants JSONB DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c_product_keys CONSTANT TEXT[] := ARRAY['id', 'slug', 'brand', 'name', 'subtitle', 'description', 'category_id',
    'image_urls', 'cutout_url', 'tags', 'attributes', 'warranty_months', 'is_active', 'is_new', 'is_bestseller',
    'is_featured', 'is_flash_deal', 'sort_order', 'seo_title', 'seo_description'];
  c_derived_keys CONSTANT TEXT[] := ARRAY['price', 'compare_at_price', 'default_variant_id', 'variant_count',
    'rating_avg', 'rating_count', 'image_url', 'search_vector', 'created_at', 'updated_at'];
  c_variant_keys CONSTANT TEXT[] := ARRAY['id', 'name', 'sku', 'option_values', 'price', 'compare_at_price',
    'position', 'is_active', 'weight_g', 'cost_price', 'track_stock', 'stock_level', 'low_stock_threshold'];
  c_p CONSTANT TEXT := 'invalid_product';
  c_v CONSTANT TEXT := 'invalid_variant';
  c_s CONSTANT TEXT := 'invalid_stock';
  v_id          INT;
  v_create      BOOLEAN;
  v_with_vars   BOOLEAN := p_variants IS NOT NULL AND jsonb_typeof(p_variants) <> 'null';
  v_key         TEXT;
  v_n           INT := 0;
  i             INT;
  e             JSONB;
  v_label       TEXT;
  v_hit         TEXT;
  -- product values
  v_slug        TEXT;
  v_brand       TEXT;
  v_name        TEXT;
  v_subtitle    TEXT;
  v_description TEXT;
  v_category    TEXT;
  v_cutout      TEXT;
  v_seo_title   TEXT;
  v_seo_desc    TEXT;
  v_images      TEXT[];
  v_tags        TEXT[];
  v_attributes  JSONB;
  v_warranty    INT;
  v_sort        INT;
  v_active      BOOLEAN;
  v_is_new      BOOLEAN;
  v_best        BOOLEAN;
  v_featured    BOOLEAN;
  v_flash       BOOLEAN;
  -- variants
  v_existing    INT[] := '{}';   -- the product's variant ids now
  v_named       INT[] := '{}';   -- existing ids listed in p_variants
  v_names       TEXT[] := '{}';  -- lower(name) of every listed variant
  v_skus        TEXT[] := '{}';  -- every listed SKU
  v_removed     INT[] := '{}';
  v_kept        INT[] := '{}';   -- removed but referenced by order lines → deactivated
  v_deleted     INT[] := '{}';
  v_vid         INT;
  v_vnew        BOOLEAN;
  v_vname       TEXT;
  v_vsku        TEXT;
  v_vopts       JSONB;
  v_vprice      NUMERIC;
  v_vcmp        NUMERIC;
  v_vpos        INT;
  v_vactive     BOOLEAN;
  v_vweight     INT;
  v_cost        NUMERIC;
  v_track       BOOLEAN;
  v_stock       INT;
  v_threshold   INT;
  v_variants    JSONB := '[]'::jsonb;
  v_out         JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can save products.';
  END IF;

  -- ── 1. The product object ─────────────────────────────────────────────────
  IF p_product IS NULL OR jsonb_typeof(p_product) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_product:The product must be a JSON object.';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p_product) LOOP
    IF NOT (v_key = ANY (c_product_keys)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('invalid_product:The field “%s” can''t be saved here%s.', left(v_key, 40),
                         CASE WHEN v_key = ANY (c_derived_keys) THEN ' (the database works it out)' ELSE '' END);
    END IF;
  END LOOP;

  v_id     := public._admin_json_int(c_p, p_product -> 'id', 'The product id', 1, 2147483647);
  v_create := v_id IS NULL;

  v_slug  := public._admin_json_text('invalid_slug', p_product -> 'slug', 'The slug', 120, v_create OR p_product ? 'slug');
  IF v_slug IS NOT NULL AND v_slug !~ '^[a-z0-9][a-z0-9-]*$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid_slug:Use lower-case letters, digits and hyphens only, starting with a letter or digit.';
  END IF;
  v_brand       := public._admin_json_text(c_p, p_product -> 'brand', 'The brand', 80, v_create OR p_product ? 'brand');
  v_name        := public._admin_json_text(c_p, p_product -> 'name', 'The name', 200, v_create OR p_product ? 'name');
  v_subtitle    := public._admin_json_text(c_p, p_product -> 'subtitle', 'The card spec line', 200);
  v_description := public._admin_json_text(c_p, p_product -> 'description', 'The description', 10000);
  v_category    := public._admin_json_text(c_p, p_product -> 'category_id', 'The category', 64);
  v_cutout      := public._admin_json_text(c_p, p_product -> 'cutout_url', 'The cut-out image', 1000);
  v_seo_title   := public._admin_json_text(c_p, p_product -> 'seo_title', 'The SEO title', 120);
  v_seo_desc    := public._admin_json_text(c_p, p_product -> 'seo_description', 'The SEO description', 320);
  v_images      := public._admin_json_text_array(c_p, p_product -> 'image_urls', 'The gallery', 12);
  v_tags        := public._admin_json_text_array(c_p, p_product -> 'tags', 'Tags', 60);
  IF p_product ? 'attributes' THEN
    v_attributes := p_product -> 'attributes';
    IF jsonb_typeof(v_attributes) = 'null' THEN
      v_attributes := '{}'::jsonb;
    ELSIF jsonb_typeof(v_attributes) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_product:Attributes must be a JSON object.';
    END IF;
  END IF;
  v_warranty := public._admin_json_int(c_p, p_product -> 'warranty_months', 'Warranty (months)', 0, 240);
  v_sort     := public._admin_json_int(c_p, p_product -> 'sort_order', 'The sort order', -1000000, 1000000);
  v_active   := public._admin_json_bool(c_p, p_product -> 'is_active', '“Active”');
  v_is_new   := public._admin_json_bool(c_p, p_product -> 'is_new', '“New”');
  v_best     := public._admin_json_bool(c_p, p_product -> 'is_bestseller', '“Best seller”');
  v_featured := public._admin_json_bool(c_p, p_product -> 'is_featured', '“Featured”');
  v_flash    := public._admin_json_bool(c_p, p_product -> 'is_flash_deal', '“Flash deal”');
  -- NOT NULL columns: an explicit null is a mistake, not "keep"
  IF (p_product ? 'sort_order' AND v_sort IS NULL)
     OR (p_product ? 'is_active' AND v_active IS NULL) OR (p_product ? 'is_new' AND v_is_new IS NULL)
     OR (p_product ? 'is_bestseller' AND v_best IS NULL) OR (p_product ? 'is_featured' AND v_featured IS NULL)
     OR (p_product ? 'is_flash_deal' AND v_flash IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_product:Flags and the sort order can''t be empty.';
  END IF;

  IF NOT v_create THEN
    PERFORM 1 FROM public.products WHERE id = v_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'product_not_found:This product no longer exists (it may have been deleted). Reload the list.';
    END IF;
    -- Lock order: this product's stock rows first, in (product_id, variant_id) order (see header).
    PERFORM 1 FROM public.inventory WHERE product_id = v_id ORDER BY product_id, variant_id FOR UPDATE;
    SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_existing
      FROM public.product_variants WHERE product_id = v_id;
  END IF;

  -- ── 2. The variant list: validate everything before writing anything ──────
  IF v_with_vars THEN
    IF jsonb_typeof(p_variants) <> 'array' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_variant:Variants must be a list.';
    END IF;
    v_n := jsonb_array_length(p_variants);
  END IF;
  IF (v_create OR v_with_vars) AND v_n = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'variants_required:A product needs at least one variant (call it “Standard” when there is only one option).';
  END IF;
  IF v_n > 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_variant:A product can have at most 100 variants.';
  END IF;

  FOR i IN 1 .. v_n LOOP
    e := p_variants -> (i - 1);
    v_label := format('Variant %s', i);
    IF jsonb_typeof(e) <> 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_variant:%s must be an object.', v_label);
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(e) LOOP
      IF NOT (v_key = ANY (c_variant_keys)) THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = format('invalid_variant:%s has a field that can''t be saved (“%s”).', v_label, left(v_key, 40));
      END IF;
    END LOOP;
    v_vid := public._admin_json_int(c_v, e -> 'id', v_label || ' id', 1, 2147483647);
    IF v_vid IS NOT NULL THEN
      IF NOT (v_vid = ANY (v_existing)) THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = format('invalid_variant:%s isn''t a variant of this product (it may have been deleted). Reload and try again.', v_label);
      END IF;
      IF v_vid = ANY (v_named) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_variant:%s repeats another row.', v_label);
      END IF;
      v_named := v_named || v_vid;
    END IF;

    v_vname := public._admin_json_text(c_v, e -> 'name', v_label || ' name', 120, TRUE);
    v_label := format('Variant “%s”', v_vname);
    IF lower(v_vname) = ANY (v_names) THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('duplicate_variant_name:Two variants are called “%s”. Each variant needs its own name.', v_vname);
    END IF;
    v_names := v_names || lower(v_vname);

    v_vsku := public._admin_json_text(c_v, e -> 'sku', v_label || ' SKU', 64);
    IF v_vsku ~ '\s' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_variant:%s SKU can''t contain spaces.', v_label);
    END IF;
    IF v_vsku IS NOT NULL THEN
      IF v_vsku = ANY (v_skus) THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = format('duplicate_sku:Two variants use the SKU “%s”. SKUs must be unique.', v_vsku);
      END IF;
      v_skus := v_skus || v_vsku;
    END IF;

    IF public._admin_json_money(c_v, e -> 'price', v_label || ' price') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_variant:%s needs a price.', v_label);
    END IF;
    PERFORM public._admin_json_money(c_v, e -> 'compare_at_price', v_label || ' compare-at price');
    PERFORM public._admin_json_money(c_v, e -> 'cost_price', v_label || ' cost price');
    IF e ? 'option_values' AND jsonb_typeof(e -> 'option_values') <> 'null' THEN
      IF jsonb_typeof(e -> 'option_values') <> 'object' THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = format('invalid_variant:%s options must be name/value pairs.', v_label);
      END IF;
      IF (SELECT count(*) FROM jsonb_object_keys(e -> 'option_values')) > 10
         OR EXISTS (SELECT 1 FROM jsonb_each(e -> 'option_values') kv
                     WHERE jsonb_typeof(kv.value) <> 'string'
                        OR char_length(btrim(kv.key)) > 40 OR char_length(btrim(kv.value #>> '{}')) > 60) THEN
        RAISE EXCEPTION USING ERRCODE = '22023',
          MESSAGE = format('invalid_variant:%s can have up to 10 options, each a name (≤ 40 characters) and a text value (≤ 60).', v_label);
      END IF;
    END IF;
    IF e ? 'position' AND public._admin_json_int(c_v, e -> 'position', v_label || ' position', 0, 100000) IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_variant:%s position can''t be empty.', v_label);
    END IF;
    IF e ? 'is_active' AND public._admin_json_bool(c_v, e -> 'is_active', v_label || ' “active”') IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_variant:%s “active” can''t be empty.', v_label);
    END IF;
    PERFORM public._admin_json_int(c_v, e -> 'weight_g', v_label || ' weight (g)', 0, 1000000);
    PERFORM public._admin_json_bool(c_s, e -> 'track_stock', v_label || ' “track stock”');
    PERFORM public._admin_json_int(c_s, e -> 'stock_level', v_label || ' stock', 0, 1000000);
    PERFORM public._admin_json_int(c_s, e -> 'low_stock_threshold', v_label || ' low-stock threshold', 0, 100000);
  END LOOP;

  -- ── 3. Variants that leave: referenced by order lines → kept (deactivated), else deleted ──
  IF v_with_vars AND NOT v_create THEN
    v_removed := ARRAY(SELECT x FROM unnest(v_existing) AS x WHERE NOT (x = ANY (v_named)) ORDER BY x);
    IF cardinality(v_removed) > 0 THEN
      -- lock first: an order being placed right now for one of them commits before we look
      PERFORM 1 FROM public.product_variants WHERE id = ANY (v_removed) ORDER BY id FOR UPDATE;
      v_kept := ARRAY(SELECT x FROM unnest(v_removed) AS x
                       WHERE EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.variant_id = x) ORDER BY x);
      v_deleted := ARRAY(SELECT x FROM unnest(v_removed) AS x WHERE NOT (x = ANY (v_kept)) ORDER BY x);
    END IF;
    SELECT format('The name “%s” still belongs to a removed variant that past orders reference (it stays, inactive). Choose another name.', v.name)
      INTO v_hit
      FROM public.product_variants v
     WHERE v.id = ANY (v_kept) AND lower(v.name) = ANY (v_names)
     LIMIT 1;
    IF v_hit IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'variant_name_taken:' || v_hit;
    END IF;
  END IF;
  IF cardinality(v_skus) > 0 THEN
    SELECT CASE WHEN v.id = ANY (v_kept)
                THEN format('The SKU “%s” still belongs to a removed variant that past orders reference. Choose another SKU.', v.sku)
                ELSE format('The SKU “%s” is already used by %s (%s).', v.sku, p.name, v.name) END
      INTO v_hit
      FROM public.product_variants v
      JOIN public.products p ON p.id = v.product_id
     WHERE v.sku = ANY (v_skus) AND (v_create OR v.product_id <> v_id OR v.id = ANY (v_kept))
     ORDER BY v.id
     LIMIT 1;
    IF v_hit IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'sku_taken:' || v_hit;
    END IF;
  END IF;

  -- ── 4. Write the product ──────────────────────────────────────────────────
  IF v_create THEN
    INSERT INTO public.products (slug, brand, name, subtitle, description, category_id, image_urls, cutout_url, tags,
                                 attributes, warranty_months, is_active, is_new, is_bestseller, is_featured,
                                 is_flash_deal, sort_order, seo_title, seo_description)
    VALUES (v_slug, v_brand, v_name, v_subtitle, v_description, v_category, v_images, v_cutout, v_tags,
            COALESCE(v_attributes, '{}'::jsonb), v_warranty, COALESCE(v_active, TRUE), COALESCE(v_is_new, FALSE),
            COALESCE(v_best, FALSE), COALESCE(v_featured, FALSE), COALESCE(v_flash, FALSE), COALESCE(v_sort, 100),
            v_seo_title, v_seo_desc)
    RETURNING id INTO v_id;
  ELSIF EXISTS (SELECT 1 FROM jsonb_object_keys(p_product) k WHERE k <> 'id') THEN
    UPDATE public.products p
       SET slug            = CASE WHEN p_product ? 'slug'            THEN v_slug        ELSE p.slug END,
           brand           = CASE WHEN p_product ? 'brand'           THEN v_brand       ELSE p.brand END,
           name            = CASE WHEN p_product ? 'name'            THEN v_name        ELSE p.name END,
           subtitle        = CASE WHEN p_product ? 'subtitle'        THEN v_subtitle    ELSE p.subtitle END,
           description     = CASE WHEN p_product ? 'description'     THEN v_description ELSE p.description END,
           category_id     = CASE WHEN p_product ? 'category_id'     THEN v_category    ELSE p.category_id END,
           image_urls      = CASE WHEN p_product ? 'image_urls'      THEN v_images      ELSE p.image_urls END,
           cutout_url      = CASE WHEN p_product ? 'cutout_url'      THEN v_cutout      ELSE p.cutout_url END,
           tags            = CASE WHEN p_product ? 'tags'            THEN v_tags        ELSE p.tags END,
           attributes      = CASE WHEN p_product ? 'attributes'      THEN v_attributes  ELSE p.attributes END,
           warranty_months = CASE WHEN p_product ? 'warranty_months' THEN v_warranty    ELSE p.warranty_months END,
           is_active       = COALESCE(v_active, p.is_active),
           is_new          = COALESCE(v_is_new, p.is_new),
           is_bestseller   = COALESCE(v_best, p.is_bestseller),
           is_featured     = COALESCE(v_featured, p.is_featured),
           is_flash_deal   = COALESCE(v_flash, p.is_flash_deal),
           sort_order      = COALESCE(v_sort, p.sort_order),
           seo_title       = CASE WHEN p_product ? 'seo_title'       THEN v_seo_title   ELSE p.seo_title END,
           seo_description = CASE WHEN p_product ? 'seo_description' THEN v_seo_desc    ELSE p.seo_description END
     WHERE p.id = v_id;
  END IF;

  -- ── 5. Write the variants ─────────────────────────────────────────────────
  IF cardinality(v_kept) > 0 THEN
    UPDATE public.product_variants SET is_active = FALSE WHERE id = ANY (v_kept) AND is_active;
  END IF;
  IF cardinality(v_deleted) > 0 THEN
    DELETE FROM public.product_variants WHERE id = ANY (v_deleted);
  END IF;

  -- Park changed names/SKUs of listed variants first, so swapping two names (or SKUs) in one
  -- save can't trip the unique indexes half-way (they are checked row by row).
  FOR i IN 1 .. v_n LOOP
    e := p_variants -> (i - 1);
    v_vid := public._admin_json_int(c_v, e -> 'id', '', 1, 2147483647);
    CONTINUE WHEN v_vid IS NULL;
    v_vname := public._admin_json_text(c_v, e -> 'name', '', 120, TRUE);
    v_vsku  := public._admin_json_text(c_v, e -> 'sku', '', 64);
    UPDATE public.product_variants v
       SET name = CASE WHEN lower(v.name) <> lower(v_vname) THEN format('__admin_save_%s__', v.id) ELSE v.name END,
           sku  = CASE WHEN e ? 'sku' AND v.sku IS DISTINCT FROM v_vsku THEN NULL ELSE v.sku END
     WHERE v.id = v_vid
       AND (lower(v.name) <> lower(v_vname) OR (e ? 'sku' AND v.sku IS DISTINCT FROM v_vsku));
  END LOOP;

  FOR i IN 1 .. v_n LOOP
    e := p_variants -> (i - 1);
    v_vid     := public._admin_json_int(c_v, e -> 'id', '', 1, 2147483647);
    v_vnew    := v_vid IS NULL;
    v_vname   := public._admin_json_text(c_v, e -> 'name', '', 120, TRUE);
    v_vsku    := public._admin_json_text(c_v, e -> 'sku', '', 64);
    v_vprice  := public._admin_json_money(c_v, e -> 'price', '');
    v_vcmp    := public._admin_json_money(c_v, e -> 'compare_at_price', '');
    v_vpos    := public._admin_json_int(c_v, e -> 'position', '', 0, 100000);
    v_vactive := public._admin_json_bool(c_v, e -> 'is_active', '');
    v_vweight := public._admin_json_int(c_v, e -> 'weight_g', '', 0, 1000000);
    -- options: trimmed; blank names/values dropped
    v_vopts := CASE WHEN jsonb_typeof(e -> 'option_values') = 'object' THEN
                 COALESCE((SELECT jsonb_object_agg(btrim(kv.key), btrim(kv.value #>> '{}'))
                             FROM jsonb_each(e -> 'option_values') kv
                            WHERE btrim(kv.key) <> '' AND btrim(kv.value #>> '{}') <> ''), '{}'::jsonb)
               ELSE '{}'::jsonb END;

    IF v_vnew THEN
      INSERT INTO public.product_variants (product_id, sku, name, option_values, price, compare_at_price,
                                           position, is_active, weight_g)
      VALUES (v_id, v_vsku, v_vname, v_vopts, v_vprice, v_vcmp, COALESCE(v_vpos, i - 1), COALESCE(v_vactive, TRUE), v_vweight)
      RETURNING id INTO v_vid;
    ELSE
      UPDATE public.product_variants v
         SET name             = v_vname,
             sku              = CASE WHEN e ? 'sku'              THEN v_vsku    ELSE v.sku END,
             option_values    = CASE WHEN e ? 'option_values'    THEN v_vopts   ELSE v.option_values END,
             price            = v_vprice,
             compare_at_price = CASE WHEN e ? 'compare_at_price' THEN v_vcmp    ELSE v.compare_at_price END,
             position         = COALESCE(v_vpos, v.position),
             is_active        = COALESCE(v_vactive, v.is_active),
             weight_g         = CASE WHEN e ? 'weight_g'         THEN v_vweight ELSE v.weight_g END
       WHERE v.id = v_vid;
    END IF;

    -- cost price: present → write (null clears); absent → untouched
    IF e ? 'cost_price' THEN
      v_cost := public._admin_json_money(c_v, e -> 'cost_price', '');
      IF v_cost IS NULL THEN
        DELETE FROM public.product_costs WHERE variant_id = v_vid;
      ELSE
        INSERT INTO public.product_costs (variant_id, cost_price) VALUES (v_vid, v_cost)
        ON CONFLICT (variant_id) DO UPDATE SET cost_price = EXCLUDED.cost_price;
      END IF;
    END IF;

    -- stock: ONLY when supplied (this row's inventory lock is already held, see step 1)
    v_track     := public._admin_json_bool(c_s, e -> 'track_stock', '');
    v_stock     := public._admin_json_int(c_s, e -> 'stock_level', '', 0, 1000000);
    v_threshold := public._admin_json_int(c_s, e -> 'low_stock_threshold', '', 0, 100000);
    IF v_track IS FALSE THEN
      DELETE FROM public.inventory WHERE variant_id = v_vid;
    ELSIF v_track IS TRUE OR v_stock IS NOT NULL OR v_threshold IS NOT NULL THEN
      INSERT INTO public.inventory (variant_id, product_id) VALUES (v_vid, v_id)
      ON CONFLICT (variant_id) DO NOTHING;                -- new rows: the column defaults (0 in stock, threshold 3)
      IF v_stock IS NOT NULL OR v_threshold IS NOT NULL THEN
        UPDATE public.inventory
           SET stock_level         = COALESCE(v_stock, stock_level),
               low_stock_threshold = COALESCE(v_threshold, low_stock_threshold)
         WHERE variant_id = v_vid;
      END IF;
    END IF;

    v_variants := v_variants || jsonb_build_array(jsonb_build_object('id', v_vid, 'name', v_vname, 'created', v_vnew));
  END LOOP;

  SELECT jsonb_build_object(
           'product_id', p.id, 'created', v_create, 'slug', p.slug,
           'price', p.price, 'compare_at_price', p.compare_at_price,
           'variant_count', p.variant_count, 'default_variant_id', p.default_variant_id,
           'variants', v_variants,
           'deleted_variant_ids', to_jsonb(v_deleted), 'deactivated_variant_ids', to_jsonb(v_kept))
    INTO v_out
    FROM public.products p WHERE p.id = v_id;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_save_product(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_product(JSONB, JSONB) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. admin_set_collection_products(p_collection_id TEXT, p_product_ids INT[]) → JSONB
-- ─────────────────────────────────────────────────────────────────────────────
-- The hand-picked (source = 'manual') members become exactly p_product_ids, positions 0, 1, 2 …
-- in that order ('{}' or NULL = none). A rule row for a listed product becomes manual; a manual
-- row that leaves an AUTOMATED collection falls back to its rule row when the rules match.
-- Returns {collection_id, manual_count, member_count}.
CREATE OR REPLACE FUNCTION public.admin_set_collection_products(p_collection_id TEXT, p_product_ids INT[])
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c     public.collections%ROWTYPE;
  v_ids INT[] := COALESCE(p_product_ids, '{}'::INT[]);
  v_bad TEXT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can change collection members.';
  END IF;
  -- NO KEY UPDATE: serialises two edits of one collection without blocking membership FK checks
  SELECT * INTO c FROM public.collections WHERE id = btrim(COALESCE(p_collection_id, '')) FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'collection_not_found:This collection no longer exists (it may have been deleted). Reload the list.';
  END IF;
  IF cardinality(v_ids) > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_products:A collection can have at most 500 hand-picked products.';
  END IF;
  IF array_position(v_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_products:The product list has an empty entry.';
  END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(v_ids) AS x) <> cardinality(v_ids) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_products:A product is listed twice.';
  END IF;
  SELECT string_agg(x::TEXT, ', ' ORDER BY x) INTO v_bad
    FROM unnest(v_ids) AS x
   WHERE NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = x);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('unknown_product:Product %s no longer exists (it may have been deleted). Reload and try again.', v_bad);
  END IF;

  DELETE FROM public.product_collections pc
   WHERE pc.collection_id = c.id AND pc.source = 'manual' AND NOT (pc.product_id = ANY (v_ids));
  INSERT INTO public.product_collections (product_id, collection_id, position, source)
  SELECT u.x, c.id, (u.o - 1)::INT, 'manual'
    FROM unnest(v_ids) WITH ORDINALITY AS u(x, o)
  ON CONFLICT (product_id, collection_id) DO UPDATE SET position = EXCLUDED.position, source = 'manual';
  IF c.type = 'automated' THEN
    PERFORM public._refresh_collection_rule_members(c.id);
  END IF;

  RETURN jsonb_build_object(
    'collection_id', c.id,
    'manual_count',  cardinality(v_ids),
    'member_count',  (SELECT count(*) FROM public.product_collections WHERE collection_id = c.id));
END $$;
REVOKE ALL ON FUNCTION public.admin_set_collection_products(TEXT, INT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_collection_products(TEXT, INT[]) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. List views for the admin tabs (security_invoker: the caller's RLS applies)
-- ─────────────────────────────────────────────────────────────────────────────

-- One row per product. stock_total = units on hand over TRACKED variants (inventory rows; NULL
-- when none is tracked); low_stock_variants / has_low_stock use the admin low-stock rule (header).
-- `skus` (space-separated) is for search only.
CREATE OR REPLACE VIEW public.admin_product_list WITH (security_invoker = true) AS
SELECT p.id, p.slug, p.brand, p.name, p.subtitle, p.category_id, c.name AS category_name,
       p.price, p.compare_at_price, p.default_variant_id, p.variant_count,
       p.image_url, p.cutout_url,
       p.is_active, p.is_new, p.is_bestseller, p.is_featured, p.is_flash_deal,
       p.sort_order, p.rating_avg, p.rating_count, p.created_at, p.updated_at,
       COALESCE(vs.variants_total, 0)     AS variants_total,
       vs.skus,
       COALESCE(st.tracked_variants, 0)   AS tracked_variants,
       st.stock_total,
       COALESCE(st.low_stock_variants, 0) AS low_stock_variants,
       COALESCE(st.low_stock_variants, 0) > 0 AS has_low_stock
  FROM public.products p
  LEFT JOIN public.categories c ON c.id = p.category_id
  LEFT JOIN LATERAL (
         SELECT count(*)::INT AS variants_total,
                string_agg(v.sku, ' ' ORDER BY v.position, v.id) AS skus
           FROM public.product_variants v
          WHERE v.product_id = p.id) vs ON TRUE
  LEFT JOIN LATERAL (
         SELECT count(*)::INT AS tracked_variants,
                sum(i.stock_level)::INT AS stock_total,
                (count(*) FILTER (WHERE p.is_active AND v.is_active AND i.stock_level <= i.low_stock_threshold))::INT AS low_stock_variants
           FROM public.inventory i
           JOIN public.product_variants v ON v.id = i.variant_id
          WHERE i.product_id = p.id) st ON TRUE;

-- One row per variant (tracked or not). is_low = the admin low-stock rule (header).
CREATE OR REPLACE VIEW public.admin_inventory WITH (security_invoker = true) AS
SELECT v.id AS variant_id, v.product_id, v.name AS variant_name, v.sku, v.position,
       v.is_active AS variant_is_active, v.price,
       p.name AS product_name, p.brand, p.slug AS product_slug, p.category_id, c.name AS category_name,
       p.image_url, p.is_active AS product_is_active,
       (i.variant_id IS NOT NULL) AS tracked,
       i.stock_level, i.low_stock_threshold,
       COALESCE(p.is_active AND v.is_active AND i.stock_level <= i.low_stock_threshold, FALSE) AS is_low,
       i.updated_at AS stock_updated_at
  FROM public.product_variants v
  JOIN public.products p ON p.id = v.product_id
  LEFT JOIN public.categories c ON c.id = p.category_id
  LEFT JOIN public.inventory i ON i.variant_id = v.id;

-- Read-only for the admin (Supabase's default privileges would grant ALL to anon too).
REVOKE ALL ON public.admin_product_list, public.admin_inventory FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.admin_product_list, public.admin_inventory TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. A deleted product leaves the collections' tile art
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.products_forget_collection_art() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE public.collections
     SET feature_product_ids = array_remove(feature_product_ids, OLD.id)
   WHERE OLD.id = ANY (feature_product_ids);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.products_forget_collection_art() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS products_forget_collection_art ON public.products;
CREATE TRIGGER products_forget_collection_art AFTER DELETE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.products_forget_collection_art();

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 23_admin_catalogue
--   Nothing to configure: the admin Products / Collections / Inventory tabs call these as the
--   signed-in admin (grant U + the in-body is_admin() check; anon and shoppers get 42501).
--   Do this or the tabs show "apply 23_admin_catalogue.sql": apply it after 01–11 (it reads 07's
--   order_items). Verification:
--     SELECT p.oid::regprocedure, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can
--       FROM pg_proc p WHERE p.proname IN ('admin_save_product', 'admin_set_collection_products');  -- both false
--     SELECT has_table_privilege('anon', 'public.admin_inventory', 'SELECT');                      -- false
--     SELECT product_name, variant_name, stock_level, low_stock_threshold
--       FROM public.admin_inventory WHERE is_low ORDER BY stock_level;                             -- low stock
--     -- live probe (anon key is public): refused
--     curl -s "$SUPABASE_URL/rest/v1/rpc/admin_save_product" -H "apikey: $ANON" \
--          -H "Content-Type: application/json" -d '{"p_product":{}}'                               -- 42501
--     curl -s "$SUPABASE_URL/rest/v1/admin_inventory?select=*" -H "apikey: $ANON"                   -- permission denied
-- ═════════════════════════════════════════════════════════════════════════════
