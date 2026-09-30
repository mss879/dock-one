-- ═════════════════════════════════════════════════════════════════════════════
-- 08_discounts.sql — Dock One Solutions
--
-- PURPOSE      Discount codes: percentage or fixed LKR amount, minimum subtotal, start/end
--              dates, usage limit + count, active flag, and `assistant_only` (codes only the AI
--              assistant may offer — a DB CHECK forces every such code to carry a usage cap).
--              Codes are stored upper-case and compared upper-case (unique on upper(code)).
--              `usage_count` is a derived counter: only place_order() adds a use and only a
--              cancellation gives one back (09); other writes to it are silently restored.
--              Blueprint §7.3 (discounts), §9.6, §10.7, §11.2 (Discounts tab), Appendix A 06.
-- DEPENDS ON   01_foundation (touch_updated_at), 02_customers_and_auth (is_admin()),
--              07_orders (adds the orders.discount_id → discounts foreign key).
-- ENABLES      09_order_rpcs (quote_order / validate_discount preview a code, place_order redeems
--              it, admin_set_order_status returns the use on cancel), admin Discounts tab (WP-C),
--              assistant offers (20_assistant_offers), seed 32 (OPENING10).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.discounts (
  id              SERIAL PRIMARY KEY,
  code            TEXT NOT NULL,                             -- upper-cased by trigger; shoppers type any case
  title           TEXT NOT NULL,                             -- admin-facing name ("Opening offer")
  kind            TEXT NOT NULL DEFAULT 'percentage',        -- percentage | fixed_amount (LKR)
  value           NUMERIC(12,2) NOT NULL,                    -- 10 = 10 % or Rs. 10
  min_requirement NUMERIC(12,2) NOT NULL DEFAULT 0,          -- LKR pre-discount subtotal needed
  starts_at       TIMESTAMPTZ,                               -- NULL = already running
  ends_at         TIMESTAMPTZ,                               -- NULL = never ends
  usage_limit     INT,                                       -- NULL = unlimited
  usage_count     INT NOT NULL DEFAULT 0,                    -- derived (09); never edited by hand
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  assistant_only  BOOLEAN NOT NULL DEFAULT FALSE,            -- only the assistant may OFFER it (anyone who has it may use it)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The same shape the storefront accepts (src/lib/offer-code.ts normalizeOfferCode).
  CONSTRAINT discounts_code_format       CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  CONSTRAINT discounts_title_valid       CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  CONSTRAINT discounts_kind_valid        CHECK (kind IN ('percentage', 'fixed_amount')),
  CONSTRAINT discounts_value_valid       CHECK (value > 0 AND value <= 100000000),
  CONSTRAINT discounts_percentage_max    CHECK (kind <> 'percentage' OR value <= 100),
  CONSTRAINT discounts_min_valid         CHECK (min_requirement >= 0 AND min_requirement <= 100000000),
  CONSTRAINT discounts_dates_valid       CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT discounts_usage_valid       CHECK ((usage_limit IS NULL OR usage_limit > 0) AND usage_count >= 0),
  -- Any code an AI can hand out must be capped (blueprint §7.3).
  CONSTRAINT discounts_assistant_needs_cap CHECK (NOT assistant_only OR usage_limit IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS discounts_code_upper_key ON public.discounts (upper(code));
CREATE INDEX IF NOT EXISTS discounts_live_idx ON public.discounts (is_active, assistant_only);

-- The foreign key 07 could not declare (discounts did not exist yet). Deleting a code keeps the
-- orders' discount_code snapshot and clears the link.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_discount_id_fkey') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_discount_id_fkey
      FOREIGN KEY (discount_id) REFERENCES public.discounts (id) ON DELETE SET NULL;
  END IF;
END $$;

-- Normalise the code (trim + upper-case) and pin the derived usage counter: a new code starts
-- at 0 and later writes keep the stored count, unless the writer is a definer function that set
-- app.trusted_write for its transaction (place_order / admin_set_order_status) or has no JWT
-- (SQL editor: auth.uid() IS NULL — the owner can still repair a count by hand).
CREATE OR REPLACE FUNCTION public.discounts_normalize() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.code  := upper(btrim(NEW.code));
  NEW.title := btrim(NEW.title);
  IF auth.uid() IS NOT NULL AND current_setting('app.trusted_write', true) IS DISTINCT FROM 'on' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.usage_count := 0;
    ELSE
      NEW.usage_count := OLD.usage_count;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.discounts_normalize() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS discounts_10_normalize ON public.discounts;
CREATE TRIGGER discounts_10_normalize BEFORE INSERT OR UPDATE ON public.discounts
  FOR EACH ROW EXECUTE FUNCTION public.discounts_normalize();
DROP TRIGGER IF EXISTS discounts_touch ON public.discounts;
CREATE TRIGGER discounts_touch BEFORE UPDATE ON public.discounts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Admin-only table. Shoppers learn about a code only through quote_order / validate_discount
-- (09) and the assistant's offers — never by listing the table.
ALTER TABLE public.discounts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discounts FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.discounts FROM authenticated;
REVOKE ALL ON SEQUENCE public.discounts_id_seq FROM anon;

DROP POLICY IF EXISTS discounts_admin_all ON public.discounts;
CREATE POLICY discounts_admin_all ON public.discounts
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 08_discounts
--   No secrets. Create codes in the admin Discounts tab (or seed 32 for the demo OPENING10).
--   An assistant_only code needs a usage limit (the CHECK refuses it otherwise). usage_count is
--   maintained by place_order (+1) and order cancellation (−1); edits to it from the app are
--   ignored. To repair a count by hand, run the UPDATE in the SQL editor.
--   Verification:
--     SELECT code, kind, value, min_requirement, usage_limit, usage_count, is_active, assistant_only
--       FROM public.discounts ORDER BY code;
--     SELECT conname FROM pg_constraint WHERE conname = 'orders_discount_id_fkey';   -- 1 row
--     -- live probe: codes are not listable with the anon key
--     curl -s "$SUPABASE_URL/rest/v1/discounts?select=code" -H "apikey: $ANON"      -- permission denied
-- ═════════════════════════════════════════════════════════════════════════════
