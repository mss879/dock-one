-- ═════════════════════════════════════════════════════════════════════════════
-- 05_inventory.sql — Dock One Solutions
--
-- PURPOSE      Stock per VARIANT (variant model B). A variant with NO inventory row is not
--              stock-tracked and always sells; a row makes it tracked (stock_level ≥ 0).
--              `get_product_availability()` is the narrow public window into this admin-only
--              table (≤ 24 products per call, a computed low-stock flag, never the threshold);
--              `list_in_stock_product_ids()` powers "in stock only" filters.
--              Blueprint §7.3 (inventory), §7.5, Appendix A 04; BUILD_SPEC §4.3.
-- DEPENDS ON   01_foundation, 02_customers_and_auth (is_admin()), 04_catalogue (products,
--              product_variants).
-- ENABLES      live availability bands on the product page / cart (WP-A, WP-C), place_order
--              stock checks and decrements in 09 (SELECT … FOR UPDATE on inventory by
--              variant_id), cancellation restock, admin Inventory tab (WP-K), low-stock
--              dashboard (WP-H), seed 30.
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.inventory (
  variant_id          INT PRIMARY KEY,
  product_id          INT NOT NULL,                     -- always the variant's product (set by trigger)
  stock_level         INT NOT NULL DEFAULT 0,
  low_stock_threshold INT NOT NULL DEFAULT 3,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_variant_product_fkey FOREIGN KEY (variant_id, product_id)
    REFERENCES public.product_variants (id, product_id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT inventory_product_id_fkey FOREIGN KEY (product_id)
    REFERENCES public.products (id) ON DELETE CASCADE,
  CONSTRAINT inventory_levels_valid CHECK (stock_level >= 0 AND stock_level <= 1000000
                                           AND low_stock_threshold >= 0 AND low_stock_threshold <= 100000)
);
CREATE INDEX IF NOT EXISTS inventory_product_idx ON public.inventory (product_id);
CREATE INDEX IF NOT EXISTS inventory_low_stock_idx ON public.inventory (stock_level) WHERE stock_level <= low_stock_threshold;

-- product_id is derived from the variant, never trusted from the writer (the admin UI may
-- send only variant_id + stock_level). An unknown variant fails the FK as usual.
CREATE OR REPLACE FUNCTION public.inventory_set_product() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_pid INT;
BEGIN
  SELECT v.product_id INTO v_pid FROM public.product_variants v WHERE v.id = NEW.variant_id;
  IF v_pid IS NOT NULL THEN
    NEW.product_id := v_pid;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.inventory_set_product() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS inventory_10_set_product ON public.inventory;
CREATE TRIGGER inventory_10_set_product BEFORE INSERT OR UPDATE ON public.inventory
  FOR EACH ROW EXECUTE FUNCTION public.inventory_set_product();

-- Admin-only (sealed from anon). Shoppers see stock only through the functions below.
ALTER TABLE public.inventory ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.inventory FROM authenticated;
DROP POLICY IF EXISTS inventory_admin_all ON public.inventory;
CREATE POLICY inventory_admin_all ON public.inventory
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- Narrow public window: tracked, ACTIVE variants of VISIBLE products only; the first 24
-- distinct product ids (ascending) of the request; a computed low flag, never the threshold.
-- Variants with no row are untracked (always available) and are simply absent here.
CREATE OR REPLACE FUNCTION public.get_product_availability(p_product_ids INT[])
RETURNS TABLE (product_id INT, variant_id INT, stock_level INT, low_stock BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.product_id, i.variant_id, i.stock_level,
         (i.stock_level > 0 AND i.stock_level <= i.low_stock_threshold) AS low_stock
    FROM public.inventory i
    JOIN (SELECT DISTINCT x AS pid
            FROM unnest(COALESCE(p_product_ids, '{}'::INT[])) AS x
           WHERE x IS NOT NULL
           ORDER BY 1
           LIMIT 24) ids ON ids.pid = i.product_id
    JOIN public.product_variants v ON v.id = i.variant_id AND v.is_active
    JOIN public.products p ON p.id = i.product_id AND p.is_active AND p.variant_count > 0
   ORDER BY i.product_id, v.position, i.variant_id
$$;
REVOKE ALL ON FUNCTION public.get_product_availability(INT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_product_availability(INT[]) TO anon, authenticated;

-- Visible products that can be bought right now: at least one active variant that is
-- untracked (no inventory row) or has stock_level > 0. For "in stock only" filters and the
-- finder; exposes nothing a product page does not already show.
CREATE OR REPLACE FUNCTION public.list_in_stock_product_ids()
RETURNS TABLE (product_id INT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id
    FROM public.products p
   WHERE p.is_active AND p.variant_count > 0
     AND EXISTS (SELECT 1
                   FROM public.product_variants v
                   LEFT JOIN public.inventory i ON i.variant_id = v.id
                  WHERE v.product_id = p.id AND v.is_active
                    AND (i.variant_id IS NULL OR i.stock_level > 0))
   ORDER BY p.id
$$;
REVOKE ALL ON FUNCTION public.list_in_stock_product_ids() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_in_stock_product_ids() TO anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 05_inventory
--   Do this or everything sells without limit: every variant you want stock-limited needs an
--   inventory row (seed 30 creates none (demo variants are untracked); the admin Products/Inventory
--   tabs create one when stock tracking is switched on). Editing a product never resets stock.
--   Verification (run in the SQL editor — an anonymous count of inventory is 0 by design):
--     SELECT count(*) FROM public.product_variants v
--       LEFT JOIN public.inventory i ON i.variant_id = v.id WHERE i.variant_id IS NULL;  -- untracked variants
--     SELECT * FROM public.get_product_availability(ARRAY(SELECT id FROM public.products LIMIT 5));
--     -- live probe: availability answers, the table stays sealed
--     curl -s "$SUPABASE_URL/rest/v1/rpc/get_product_availability" -H "apikey: $ANON" \
--          -H "Content-Type: application/json" -d '{"p_product_ids":[1,2,3]}'
--     curl -s "$SUPABASE_URL/rest/v1/inventory?select=*" -H "apikey: $ANON"      -- permission denied
-- ═════════════════════════════════════════════════════════════════════════════
