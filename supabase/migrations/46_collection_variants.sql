-- ═════════════════════════════════════════════════════════════════════════════
-- 46_collection_variants.sql — Dock One Solutions
--
-- PURPOSE      Pick which variants of a product a collection holds. In a sale (11.11, Black
--              Friday…) often only some variants are on offer — one colour of a mouse, one memory
--              size of a laptop. A hand-picked member can now name the variants that are in;
--              without a pick it holds the whole product, exactly as before.
--                * product_collections.variant_ids: the picked variants (NULL = every variant).
--                  Hand-picked rows only — a member added by rules always holds the whole product.
--                  Checked on every write: each id must be a variant of that product; the list is
--                  de-duplicated and sorted; an empty pick is refused (remove the product instead).
--                * A picked variant that is DELETED drops out of the pick. When it was the only
--                  one picked, the product leaves the collection — its other variants were never
--                  in it, so it must not fall back to "the whole product" (in an automatic
--                  collection whose rules match the product, the rules take it back, as in 23).
--                  A variant that is only switched off stays picked and shows again when it is
--                  switched back on.
--                * admin_set_collection_members(collection, products, picks): 23's
--                  admin_set_collection_products (members + their order in one call) plus the
--                  picks, e.g. {"12": [31, 33]}; a product not named holds every variant.
--                  admin_set_collection_products keeps working and leaves existing picks alone.
--              The storefront shows a member with a pick as those variants only: the card's price,
--              discount and the variant it adds or opens are the picked ones, and a member none of
--              whose picked variants is on sale is left out of the list (lib/catalogue.ts).
-- DEPENDS ON   04_catalogue (product_collections, product_variants), 23_admin_catalogue
--              (admin_set_collection_products), 39_staff_accounts (staff_api_map).
-- ENABLES      admin → Catalogue → Collections → a collection → Products: "Variants" on each
--              product; the collection page and the product page read the picks. Staff with
--              Collections → edit can save picks (the map row at the end).
-- ERRORS       22023 `invalid_variants:<text for the admin>`; 42501 `not_authorised:…`; and 23's
--              codes from admin_set_collection_products (collection_not_found, invalid_products,
--              unknown_product).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The pick
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.product_collections ADD COLUMN IF NOT EXISTS variant_ids INT[];

COMMENT ON COLUMN public.product_collections.variant_ids IS
  'The variants of the product this collection holds, sorted; NULL = every variant (the whole product). Hand-picked rows only (46).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Checked on every write
-- ─────────────────────────────────────────────────────────────────────────────
-- Only ids a write ADDS are looked up: an id that leaves needs no check, and while a whole product
-- is being deleted its other variants may already be gone (section 3 runs mid-delete).
CREATE OR REPLACE FUNCTION public.product_collections_check_variants() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_ids   INT[];
  v_added INT[];
  v_bad   TEXT;
BEGIN
  IF NEW.variant_ids IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.source = 'rule' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid_variants:A product added by rules always includes every variant. Hand-pick it to choose its variants.';
  END IF;
  IF array_position(NEW.variant_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_variants:The variant list has an empty entry.';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_ids FROM unnest(NEW.variant_ids) AS x;
  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid_variants:Pick at least one variant, or remove the product from the collection.';
  END IF;
  IF cardinality(v_ids) > 200 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_variants:Pick at most 200 variants of one product.';
  END IF;

  v_added := CASE WHEN TG_OP = 'UPDATE' AND OLD.product_id = NEW.product_id AND OLD.variant_ids IS NOT NULL
                  THEN ARRAY(SELECT x FROM unnest(v_ids) AS x WHERE x <> ALL (OLD.variant_ids))
                  ELSE v_ids END;
  SELECT string_agg(x::TEXT, ', ' ORDER BY x) INTO v_bad
    FROM unnest(v_added) AS x
   WHERE NOT EXISTS (SELECT 1 FROM public.product_variants v WHERE v.id = x AND v.product_id = NEW.product_id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = format('invalid_variants:Variant %s isn''t one of this product''s variants (it may have been deleted). Reload and try again.', v_bad);
  END IF;

  NEW.variant_ids := v_ids;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.product_collections_check_variants() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS product_collections_10_variants ON public.product_collections;
CREATE TRIGGER product_collections_10_variants BEFORE INSERT OR UPDATE ON public.product_collections
  FOR EACH ROW EXECUTE FUNCTION public.product_collections_check_variants();

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. A deleted (or moved) variant leaves the picks
-- ─────────────────────────────────────────────────────────────────────────────
-- Definer: whoever removes the variant (a product save, a staff member with Products → edit), the
-- picks are kept true. The only-pick rows go first, so no pick is ever left empty; an AUTOMATIC
-- collection whose rules match the product then takes it back whole, as 23 does when a hand-picked
-- member leaves one (the rules say the whole product belongs).
CREATE OR REPLACE FUNCTION public.product_variants_leave_collections() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_collection TEXT;
BEGIN
  FOR v_collection IN
    DELETE FROM public.product_collections
     WHERE product_id = OLD.product_id AND variant_ids = ARRAY[OLD.id]
    RETURNING collection_id
  LOOP
    IF EXISTS (SELECT 1 FROM public.collections c WHERE c.id = v_collection AND c.type = 'automated') THEN
      PERFORM public._refresh_collection_rule_members(v_collection);
    END IF;
  END LOOP;
  UPDATE public.product_collections
     SET variant_ids = array_remove(variant_ids, OLD.id)
   WHERE product_id = OLD.product_id AND OLD.id = ANY (variant_ids);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.product_variants_leave_collections() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS product_variants_leave_collections_del ON public.product_variants;
CREATE TRIGGER product_variants_leave_collections_del AFTER DELETE ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.product_variants_leave_collections();
DROP TRIGGER IF EXISTS product_variants_leave_collections_move ON public.product_variants;
CREATE TRIGGER product_variants_leave_collections_move AFTER UPDATE OF product_id ON public.product_variants
  FOR EACH ROW WHEN (OLD.product_id IS DISTINCT FROM NEW.product_id)
  EXECUTE FUNCTION public.product_variants_leave_collections();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. admin_set_collection_members(p_collection_id, p_product_ids, p_variant_ids) → JSONB
-- ─────────────────────────────────────────────────────────────────────────────
-- The hand-picked members become exactly p_product_ids, in that order (23 does that part, with its
-- checks and the rule refresh), then each one's pick becomes p_variant_ids ->> '<product id>':
-- {"12": [31, 33]} holds variants 31 and 33 of product 12; a product not named holds every
-- variant. One call, one transaction: a refused pick leaves the members unchanged too.
-- Returns 23's {collection_id, manual_count, member_count} plus variant_picks (members with a pick).
CREATE OR REPLACE FUNCTION public.admin_set_collection_members(p_collection_id TEXT, p_product_ids INT[],
                                                               p_variant_ids JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ids    INT[] := COALESCE(p_product_ids, '{}'::INT[]);
  v_picks  JSONB := COALESCE(p_variant_ids, '{}'::jsonb);
  v_key    TEXT;
  v_value  JSONB;
  v_result JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can change collection members.';
  END IF;
  IF jsonb_typeof(v_picks) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid_variants:The variant picks must map a product id to its variant ids.';
  END IF;
  FOR v_key, v_value IN SELECT key, value FROM jsonb_each(v_picks) LOOP
    IF v_key !~ '^[1-9][0-9]{0,8}$' OR NOT (v_key::INT = ANY (v_ids)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = 'invalid_variants:Variants were picked for a product that isn''t in the collection''s list.';
    END IF;
    IF jsonb_typeof(v_value) <> 'array' OR jsonb_array_length(v_value) = 0 THEN
      RAISE EXCEPTION USING ERRCODE = '22023',
        MESSAGE = format('invalid_variants:Pick at least one variant of product %s, or remove it from the collection.', v_key);
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_value) AS e
                WHERE jsonb_typeof(e) <> 'number' OR (e #>> '{}') !~ '^[1-9][0-9]{0,8}$') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_variants:A variant id isn''t a whole number.';
    END IF;
  END LOOP;

  v_result := public.admin_set_collection_products(p_collection_id, v_ids);

  UPDATE public.product_collections pc
     SET variant_ids = p.ids
    FROM (SELECT x AS product_id,
                 (SELECT array_agg(DISTINCT (e #>> '{}')::INT) FROM jsonb_array_elements(v_picks -> x::TEXT) AS e) AS ids
            FROM unnest(v_ids) AS x) p
   WHERE pc.collection_id = v_result ->> 'collection_id'
     AND pc.source = 'manual'
     AND pc.product_id = p.product_id
     AND pc.variant_ids IS DISTINCT FROM p.ids;

  RETURN v_result || jsonb_build_object(
    'variant_picks', (SELECT count(*) FROM public.product_collections
                       WHERE collection_id = v_result ->> 'collection_id' AND variant_ids IS NOT NULL));
END $$;
REVOKE ALL ON FUNCTION public.admin_set_collection_members(TEXT, INT[], JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_collection_members(TEXT, INT[], JSONB) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Staff: the same access as admin_set_collection_products (39)
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM public.staff_api_map WHERE migration = '46';
INSERT INTO public.staff_api_map (kind, name, area, view_level, edit_level, migration)
VALUES ('rpc', 'admin_set_collection_members', 'collections', 'view', 'edit', '46');

-- ─────────────────────────────────────────────────────────────────────────────
-- Ops notes (run by hand in the SQL editor; nothing here runs them)
-- ─────────────────────────────────────────────────────────────────────────────
-- Which members of a collection hold only some variants:
--   SELECT pc.product_id, p.name, pc.variant_ids,
--          (SELECT string_agg(v.name, ', ' ORDER BY v.position) FROM product_variants v WHERE v.id = ANY (pc.variant_ids)) AS picked
--     FROM product_collections pc JOIN products p ON p.id = pc.product_id
--    WHERE pc.collection_id = '11-11' AND pc.variant_ids IS NOT NULL;
-- Put one member back to the whole product:
--   UPDATE product_collections SET variant_ids = NULL WHERE collection_id = '11-11' AND product_id = 12;
-- Undo 46 (picks are lost; the storefront then shows whole products again):
--   DROP FUNCTION IF EXISTS public.admin_set_collection_members(TEXT, INT[], JSONB);
--   DROP TRIGGER IF EXISTS product_variants_leave_collections_del ON public.product_variants;
--   DROP TRIGGER IF EXISTS product_variants_leave_collections_move ON public.product_variants;
--   DROP FUNCTION IF EXISTS public.product_variants_leave_collections();
--   DROP TRIGGER IF EXISTS product_collections_10_variants ON public.product_collections;
--   DROP FUNCTION IF EXISTS public.product_collections_check_variants();
--   ALTER TABLE public.product_collections DROP COLUMN IF EXISTS variant_ids;
--   DELETE FROM public.staff_api_map WHERE migration = '46';
