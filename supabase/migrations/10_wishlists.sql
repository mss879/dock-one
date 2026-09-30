-- ═════════════════════════════════════════════════════════════════════════════
-- 10_wishlists.sql — Dock One Solutions
--
-- PURPOSE      Saved items for signed-in shoppers: wishlists(customer_id, product_id, list_type)
--              with the primary key on all three (list_type favorite | buy_later), owner
--              SELECT / INSERT / DELETE, admin read. "Move between lists" = delete + insert
--              (there is deliberately no UPDATE). merge_wishlist() folds the guest's local
--              wishlist (dockone.wishlist.v2) into the account on sign-in in one call.
--              Blueprint §7.3 (wishlists), §7.4, §9.13, Appendix A 08; BUILD_SPEC §5
--              (lib/wishlist.ts hybrid: guests local, signed-in DB, merge on sign-in).
-- DEPENDS ON   02_customers_and_auth (customers, is_admin()), 04_catalogue (products).
-- ENABLES      /wishlist and the dashboard "Saved items" tab, WishlistButton sync,
--              AuthListener merge on sign-in (WP-D), admin customer dossier (read).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.wishlists (
  customer_id UUID NOT NULL REFERENCES public.customers (id) ON DELETE CASCADE,
  product_id  INT  NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  list_type   TEXT NOT NULL DEFAULT 'favorite',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, product_id, list_type),
  CONSTRAINT wishlists_list_type_valid CHECK (list_type IN ('favorite', 'buy_later'))
);
CREATE INDEX IF NOT EXISTS wishlists_customer_recent_idx ON public.wishlists (customer_id, list_type, created_at DESC);
CREATE INDEX IF NOT EXISTS wishlists_product_idx ON public.wishlists (product_id);

-- Owner rows only. anon has no privilege at all (a guest's wishlist lives in the browser);
-- no UPDATE for anyone (move = delete + insert); no TRUNCATE through the API.
ALTER TABLE public.wishlists ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.wishlists FROM anon;
REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.wishlists FROM authenticated;

DROP POLICY IF EXISTS wishlists_owner_read ON public.wishlists;
CREATE POLICY wishlists_owner_read ON public.wishlists
  FOR SELECT TO authenticated USING (customer_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS wishlists_owner_insert ON public.wishlists;
CREATE POLICY wishlists_owner_insert ON public.wishlists
  FOR INSERT TO authenticated WITH CHECK (customer_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS wishlists_owner_delete ON public.wishlists;
CREATE POLICY wishlists_owner_delete ON public.wishlists
  FOR DELETE TO authenticated USING (customer_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS wishlists_admin_read ON public.wishlists;
CREATE POLICY wishlists_admin_read ON public.wishlists
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

-- Sign-in merge: the guest's local favourites → the account, in one idempotent call.
-- Takes the first 100 distinct ids (of at most the first 1000 elements), keeps only products a
-- shopper can see (active with an active variant), inserts them as 'favorite' (existing rows
-- untouched), and returns the account's visible favourites, newest first — the list the
-- browser should now hold (wishlist.replace(ids)).
-- Errors: not_signed_in (no JWT, or an account without a customers row).
CREATE OR REPLACE FUNCTION public.merge_wishlist(p_product_ids INT[])
RETURNS INT[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid UUID := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.customers WHERE id = v_uid) THEN
    RAISE EXCEPTION 'not_signed_in';
  END IF;

  INSERT INTO public.wishlists (customer_id, product_id, list_type)
  SELECT v_uid, x.id, 'favorite'
    FROM (SELECT u.id, min(u.ord) AS first_seen
            FROM unnest((COALESCE(p_product_ids, '{}'::INT[]))[1:1000]) WITH ORDINALITY AS u(id, ord)
           WHERE u.id IS NOT NULL
           GROUP BY u.id
           ORDER BY min(u.ord)
           LIMIT 100) x
    JOIN public.products p ON p.id = x.id AND p.is_active AND p.variant_count > 0
  ON CONFLICT (customer_id, product_id, list_type) DO NOTHING;

  RETURN ARRAY(
    SELECT w.product_id
      FROM public.wishlists w
      JOIN public.products p ON p.id = w.product_id AND p.is_active AND p.variant_count > 0
     WHERE w.customer_id = v_uid AND w.list_type = 'favorite'
     ORDER BY w.created_at DESC, w.product_id DESC);
END $$;
REVOKE ALL ON FUNCTION public.merge_wishlist(INT[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_wishlist(INT[]) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 10_wishlists
--   Nothing to configure. Guests keep their wishlist in the browser; on sign-in AuthListener
--   calls merge_wishlist(<local ids>) and then mirrors the returned list locally.
--   Verification:
--     SELECT has_table_privilege('anon', 'public.wishlists', 'SELECT');                 -- false
--     SELECT has_function_privilege('anon', 'public.merge_wishlist(integer[])', 'EXECUTE');  -- false
--     SELECT list_type, count(*) FROM public.wishlists GROUP BY 1;
--     -- live probe: anon cannot read or write wishlists
--     curl -s "$SUPABASE_URL/rest/v1/wishlists?select=*" -H "apikey: $ANON"            -- permission denied
-- ═════════════════════════════════════════════════════════════════════════════
