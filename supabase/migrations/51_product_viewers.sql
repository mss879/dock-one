-- ═════════════════════════════════════════════════════════════════════════════
-- 51_product_viewers.sql — Dock One Solutions
--
-- PURPOSE      The client asked (Website changes, November 2026 — 01 Frontend, "Product viewers")
--              for "N other people are looking at this" only when the live count is accurate.
--              42's count could run high: a shopper who left still counted for 90 seconds, and the
--              same browser in two tabs counted as two people. Now:
--                * the product page pings every 20 seconds while it is visible, and says goodbye
--                  when it is hidden or closed (leave_product_view) — the row goes at once;
--                * a page that vanished without a goodbye stops counting after 45 seconds
--                  (two missed pings), not 90;
--                * the browser keeps one random id for all its tabs (the page's job — see
--                  ProductViewers.tsx), so one person is one viewer.
--              Still nothing about the visitor is stored beyond a random id and a time.
-- REPLACES     ping_product_view (42).
-- DEPENDS ON   01 (_route_or_budget), 04 (products), 42 (product_presence).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- → the number of OTHER browsers on this product page now (seen in the last 45 seconds).
CREATE OR REPLACE FUNCTION public.ping_product_view(p_product_id INT, p_session UUID)
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_n INT;
BEGIN
  IF p_product_id IS NULL OR p_session IS NULL THEN
    RETURN 0;
  END IF;
  IF NOT public._route_or_budget('ping_product_view', 600, 600) THEN
    RETURN 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = p_product_id AND p.is_active) THEN
    RETURN 0;
  END IF;
  DELETE FROM public.product_presence WHERE product_id = p_product_id AND seen_at < now() - interval '10 minutes';
  INSERT INTO public.product_presence (product_id, session_id, seen_at) VALUES (p_product_id, p_session, now())
  ON CONFLICT (product_id, session_id) DO UPDATE SET seen_at = now();
  SELECT count(*)::INT INTO v_n FROM public.product_presence
   WHERE product_id = p_product_id AND session_id <> p_session AND seen_at > now() - interval '45 seconds';
  RETURN LEAST(v_n, 99);
END $$;
REVOKE ALL ON FUNCTION public.ping_product_view(INT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ping_product_view(INT, UUID) TO anon, authenticated;

-- The page was hidden or closed: this browser no longer counts for the product.
CREATE OR REPLACE FUNCTION public.leave_product_view(p_product_id INT, p_session UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_product_id IS NULL OR p_session IS NULL THEN
    RETURN;
  END IF;
  IF NOT public._route_or_budget('leave_product_view', 600, 600) THEN
    RETURN;
  END IF;
  DELETE FROM public.product_presence WHERE product_id = p_product_id AND session_id = p_session;
END $$;
REVOKE ALL ON FUNCTION public.leave_product_view(INT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.leave_product_view(INT, UUID) TO anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 51_product_viewers
--   Run after 42 (it replaces 42's ping_product_view; re-run 51 after any re-run of 42). The site
--   works before and after it; until it runs, a closed page keeps counting for up to 90 seconds.
--   Verification:
--     SELECT has_function_privilege('anon', 'public.leave_product_view(integer,uuid)', 'EXECUTE');  -- true
--     SELECT product_id, count(*) FROM public.product_presence WHERE seen_at > now() - interval '45 seconds' GROUP BY 1;
-- ═════════════════════════════════════════════════════════════════════════════
