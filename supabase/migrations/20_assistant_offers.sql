-- ═════════════════════════════════════════════════════════════════════════════
-- 20_assistant_offers.sql — Dock One Solutions
--
-- PURPOSE      What the assistant may say about discount codes (blueprint §10.6 list_offers /
--              check_offer, §10.7, §7.5, Appendix A 16):
--                list_live_offers()         live codes for the assistant's list_offers tool. PUBLIC codes
--                                           come back with their code, title and minimum only (no amount,
--                                           so the model cannot volunteer maths it was never given);
--                                           EXCLUSIVE (assistant_only) codes come back — with kind, value and
--                                           end date so the app can price them against the bag — only for a
--                                           session that has EARNED them, behind per-session and store-wide
--                                           throttles. Usage figures never leave the database.
--                admin_offer_performance()  orders, cancellations, revenue and discount given per code
--                                           (admin re-checked: 42501)
--              Pricing a code against the bag stays with validate_discount (09) — the same verdict
--              place_order applies; delivery is always decided on the PRE-discount subtotal.
-- DEPENDS ON   01_foundation (_rate_limit_hit), 02_customers_and_auth (is_admin()), 07_orders,
--              08_discounts (assistant_only needs a usage limit — CHECK), 19_assistant_core
--              (assistant_sessions: message_count, created_at, last_seen_at).
-- ENABLES      lib/assistant/offers.ts + the list_offers / check_offer tools (WP-I), the admin
--              Discounts tab's performance columns (WP-C).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- A code is LIVE when: is_active, started (starts_at NULL or ≤ now), not ended (ends_at NULL or
-- ≥ now) and under its usage limit (the same verdict as 09's _discount_check, minus the minimum,
-- which is returned for the model to state).
-- A session has EARNED the exclusive codes when it has ≥ 4 logged messages (two full exchanges),
-- was created more than 60 seconds ago and was seen in the last 24 hours; then each call costs one
-- of 6 per hour for that session and one of 400 per hour store-wide (no exclusive codes once either
-- is spent — the public list still answers). p_session_id NULL → public codes only.
-- Rows (≤ 8), exclusive first, then by minimum, code:
--   (code, title, kind, value, min_requirement, ends_at, exclusive)
--   public rows:    kind, value and ends_at are NULL
--   exclusive rows: kind ('percentage' | 'fixed_amount'), value, ends_at set
CREATE OR REPLACE FUNCTION public.list_live_offers(p_session_id UUID DEFAULT NULL)
RETURNS TABLE (code TEXT, title TEXT, kind TEXT, value NUMERIC, min_requirement NUMERIC,
               ends_at TIMESTAMPTZ, exclusive BOOLEAN)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_exclusive BOOLEAN := FALSE;
BEGIN
  IF p_session_id IS NOT NULL THEN
    SELECT TRUE INTO v_exclusive
      FROM public.assistant_sessions s
     WHERE s.id = p_session_id
       AND s.message_count >= 4                             -- two full exchanges
       AND s.created_at < now() - interval '60 seconds'
       AND s.last_seen_at > now() - interval '24 hours';
    v_exclusive := COALESCE(v_exclusive, FALSE);
    IF v_exclusive THEN                                     -- nested: the global bucket is charged only
      IF NOT public._rate_limit_hit('offers:sess:' || p_session_id::TEXT, 6, 3600) THEN   -- after the session one passed
        v_exclusive := FALSE;
      ELSIF NOT public._rate_limit_hit('offers:global', 400, 3600) THEN
        v_exclusive := FALSE;
      END IF;
    END IF;
  END IF;
  RETURN QUERY
    SELECT d.code, d.title,
           CASE WHEN d.assistant_only THEN d.kind END,
           CASE WHEN d.assistant_only THEN d.value END,
           d.min_requirement,
           CASE WHEN d.assistant_only THEN d.ends_at END,
           d.assistant_only
      FROM public.discounts d
     WHERE d.is_active
       AND (d.starts_at IS NULL OR d.starts_at <= now())
       AND (d.ends_at IS NULL OR d.ends_at >= now())
       AND (d.usage_limit IS NULL OR d.usage_count < d.usage_limit)
       AND (NOT d.assistant_only OR v_exclusive)
     ORDER BY d.assistant_only DESC, d.min_requirement, d.code
     LIMIT 8;
END $$;
REVOKE ALL ON FUNCTION public.list_live_offers(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_live_offers(UUID) TO anon, authenticated;

-- Per code, for orders placed in [p_since, p_until] (defaults: the last 90 days until now; reversed
-- bounds are swapped; at most 366 days, keeping the latest). An order counts for a code by its
-- discount_id, or — when that link was cleared because the code row was deleted and re-created — by
-- its discount_code snapshot. p_assistant_only: NULL = all codes, TRUE = exclusive only, FALSE =
-- public only.
-- Rows (every code, most used first): (code, title, exclusive, orders_count, cancelled_count,
--   revenue, discount_given) — revenue = Σ total_price and discount_given = Σ discount_amount of the
--   NON-cancelled orders (the dashboard's revenue definition, 17).
-- Errors: 42501 not_authorised.
CREATE OR REPLACE FUNCTION public.admin_offer_performance(
  p_since TIMESTAMPTZ DEFAULT NULL, p_until TIMESTAMPTZ DEFAULT NULL, p_assistant_only BOOLEAN DEFAULT NULL)
RETURNS TABLE (code TEXT, title TEXT, exclusive BOOLEAN, orders_count BIGINT, cancelled_count BIGINT,
               revenue NUMERIC, discount_given NUMERIC)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  v_until TIMESTAMPTZ := COALESCE(p_until, now());
  v_since TIMESTAMPTZ := COALESCE(p_since, COALESCE(p_until, now()) - interval '90 days');
  v_swap  TIMESTAMPTZ;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read offer performance.';
  END IF;
  IF v_since > v_until THEN
    v_swap := v_since; v_since := v_until; v_until := v_swap;
  END IF;
  IF v_until - v_since > interval '366 days' THEN
    v_since := v_until - interval '366 days';
  END IF;
  RETURN QUERY
    SELECT d.code, d.title, d.assistant_only,
           count(o.id),
           count(o.id) FILTER (WHERE o.status = 'cancelled'),
           COALESCE(sum(o.total_price) FILTER (WHERE o.status <> 'cancelled'), 0),
           COALESCE(sum(o.discount_amount) FILTER (WHERE o.status <> 'cancelled'), 0)
      FROM public.discounts d
      LEFT JOIN public.orders o
        ON (o.discount_id = d.id
            OR (o.discount_id IS NULL AND o.discount_code IS NOT NULL AND upper(o.discount_code) = upper(d.code)))
       AND o.created_at >= v_since
       AND o.created_at <= v_until
     WHERE p_assistant_only IS NULL OR d.assistant_only = p_assistant_only
     GROUP BY d.id, d.code, d.title, d.assistant_only
     ORDER BY count(o.id) DESC, d.code;
END $$;
REVOKE ALL ON FUNCTION public.admin_offer_performance(TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_offer_performance(TIMESTAMPTZ, TIMESTAMPTZ, BOOLEAN) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 20_assistant_offers
--   No secrets. Exclusive (assistant_only) codes are created in the admin Discounts tab and MUST
--   carry a usage limit (the CHECK refuses them otherwise). The assistant sees them only after a real
--   conversation; the shopper still applies the code at checkout, and place_order still decides.
--   Verification:
--     SELECT * FROM public.list_live_offers(NULL);        -- public codes only: kind/value/ends_at NULL
--     SELECT has_function_privilege('anon', 'public.admin_offer_performance(timestamptz,timestamptz,boolean)', 'EXECUTE');  -- false
--     -- live probe (anon key is public): never usage figures, never an exclusive code without a session
--     curl -s "$SUPABASE_URL/rest/v1/rpc/list_live_offers" -H "apikey: $ANON" -H "Content-Type: application/json" -d '{}'
-- ═════════════════════════════════════════════════════════════════════════════
