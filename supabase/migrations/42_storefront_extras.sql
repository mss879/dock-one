-- ═════════════════════════════════════════════════════════════════════════════
-- 42_storefront_extras.sql — Dock One Solutions
--
-- PURPOSE      Two storefront changes:
--   1. The HOTLINE +94 71 096 0006 becomes the store phone number shown on the website (top bar,
--      footer, contact page, checkout, order emails, the assistant). Once only — later edits in
--      admin → Store settings are kept. WhatsApp stays on its own number.
--   2. "People viewing this product": product_presence keeps an anonymous browser id per product
--      page for a few minutes; ping_product_view() records the visit and returns how many OTHER
--      browsers have the same product open right now (seen in the last 90 seconds). The product
--      page shows a note when that is 1 or more. Called through POST /api/presence (per-IP limit),
--      never storing anything about the visitor beyond a random id and a time.
-- DEPENDS ON   01 (rate limits), 03 (store_settings), 04 (products).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The hotline
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_config WHERE name = 'seed_42_hotline') THEN
    RETURN;
  END IF;
  RAISE NOTICE '42_storefront_extras: store phone % → +94 71 096 0006', (SELECT phone FROM public.store_settings WHERE id);
  UPDATE public.store_settings SET phone = '+94 71 096 0006' WHERE id;
  INSERT INTO public.app_config (name, value) VALUES ('seed_42_hotline', 'applied');
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Who else is looking
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.product_presence (
  product_id INT NOT NULL REFERENCES public.products (id) ON DELETE CASCADE,
  session_id UUID NOT NULL,
  seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, session_id)
);
CREATE INDEX IF NOT EXISTS product_presence_seen_idx ON public.product_presence (product_id, seen_at);
ALTER TABLE public.product_presence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_presence FROM anon, authenticated;     -- the function below only

-- → the number of OTHER browsers on this product page in the last 90 seconds (0 when unknown).
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
   WHERE product_id = p_product_id AND session_id <> p_session AND seen_at > now() - interval '90 seconds';
  RETURN LEAST(v_n, 99);
END $$;
REVOKE ALL ON FUNCTION public.ping_product_view(INT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ping_product_view(INT, UUID) TO anon, authenticated;

-- 22's retention sweep would also do; this keeps the table tiny without it.
CREATE OR REPLACE FUNCTION public._presence_sweep() RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM public.product_presence WHERE seen_at < now() - interval '1 hour'
$$;
REVOKE ALL ON FUNCTION public._presence_sweep() FROM PUBLIC, anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 42_storefront_extras
--   Run after 01–41. The store phone shown on the site becomes +94 71 096 0006 (change it any time
--   in admin → Store settings; a re-run won't overwrite it). Printed invoices keep the phone set in
--   admin → Invoices → Template & numbering.
--   Verification:
--     SELECT phone, whatsapp FROM public.store_settings;
--     SELECT has_function_privilege('anon', 'public.ping_product_view(integer,uuid)', 'EXECUTE');  -- true
--     SELECT has_table_privilege('anon', 'public.product_presence', 'SELECT');                       -- false
-- ═════════════════════════════════════════════════════════════════════════════
