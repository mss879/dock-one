-- ═════════════════════════════════════════════════════════════════════════════
-- 21_assistant_memory_lookup.sql — Dock One Solutions
--
-- PURPOSE      The assistant's two windows onto a person (blueprint §10.8, §10.9, §12.1.4-5, §7.5,
--              Appendix A 17):
--                get_assistant_customer_context()  (signed-in only) returning-customer memory from
--                                                  auth.uid() ALONE: first name, what they own (the last 5
--                                                  NON-cancelled orders' lines, filtered BEFORE the limit),
--                                                  and their finder profile with keys allowlisted to the
--                                                  finder axes. Claims the chat session for the account only
--                                                  if it is unclaimed, recent and from the same client.
--                                                  Never address, phone, email or money.
--                forget_assistant_customer()       (admin) erase a customer's conversations
--                assistant_order_lookups           audit of private order lookups: the email's DOMAIN only,
--                                                  kept 30 days
--                lookup_order_for_assistant()      (anon) order number + email from the private FORM (never
--                                                  the model): in-DB throttle shared with track_guest_order
--                                                  (8 per 15 min per order number and per md5(email); a miss
--                                                  costs double), {throttled:true} when limited, a narrow view
--                                                  with no money, address, phone or email
-- DEPENDS ON   01_foundation (_rate_limit_hit), 02_customers_and_auth (customers, is_admin()),
--              07_orders, 09_order_rpcs (_normalize_order_ref), 14_finder (finder_responses),
--              17_analytics (_business_tz), 19_assistant_core (assistant_sessions).
-- ENABLES      lib/assistant/customer.ts (called only when an sb-*-auth-token cookie exists),
--              POST /api/assistant/order, erasure on request (forget_assistant_customer for an admin
--              session; the admin Assistant insights tab itself is read-only, blueprint §11.2), retention (22).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- Returning-customer memory (grant U). Takes NO customer id: reads auth.uid() itself.
-- ─────────────────────────────────────────────────────────────────────────────
-- → NULL when there is no signed-in user or no customers row; otherwise
--   { "firstName": text | null (trimmed, ≤ 40 — sanitise further in TS),
--     "owns": [{productId, variantId, name, brand, variant, boughtOn: "September 2026", status}],
--             ≤ 20 distinct product/variant lines from the account's last 5 non-cancelled orders
--             (by account OR by its confirmed sign-in email), newest first,
--     "profile": {performance?, portability?, battery?, value?, weight?} — the latest finder profile
--             of this account, keys allowlisted to the finder axes (BUILD_SPEC §1), numbers 0..10 }
-- Session claim: when p_session_id names an assistant session with no customer yet, seen in the last
-- 24 hours, whose client_key is NULL or equals p_client_key (hashKey output, lower-case hex), it is
-- linked to this account (so insights and forget_assistant_customer find it). Anything else is left alone.
CREATE OR REPLACE FUNCTION public.get_assistant_customer_context(p_session_id UUID DEFAULT NULL, p_client_key TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_key   TEXT := CASE WHEN lower(btrim(p_client_key)) ~ '^[0-9a-f]{16,64}$' THEN lower(btrim(p_client_key)) END;
  v_tz    TEXT := public._business_tz();
  v_first TEXT;
  v_email TEXT;
  v_owns  JSONB;
  v_prof  JSONB;
BEGIN
  IF v_uid IS NULL THEN RETURN NULL; END IF;
  SELECT NULLIF(left(btrim(c.first_name), 40), ''), lower(c.email) INTO v_first, v_email
    FROM public.customers c WHERE c.id = v_uid;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Claim this chat session for the account — only if unclaimed, recent and from the same caller.
  IF p_session_id IS NOT NULL THEN
    UPDATE public.assistant_sessions s SET customer_id = v_uid
     WHERE s.id = p_session_id
       AND s.customer_id IS NULL
       AND s.last_seen_at > now() - interval '24 hours'
       AND (s.client_key IS NULL OR s.client_key = v_key);
  END IF;

  WITH recent AS (
    SELECT o.id, o.created_at, o.status
      FROM public.orders o
     WHERE (o.customer_id = v_uid OR lower(o.email) = v_email)
       AND o.status <> 'cancelled'                             -- filter BEFORE the limit (§14 lesson 29)
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT 5
  ), lines AS (
    SELECT DISTINCT ON (i.product_id, i.variant_id, CASE WHEN i.product_id IS NULL THEN i.id END)
           i.product_id, i.variant_id, i.product_name, i.brand, i.variant_name, r.created_at, r.status
      FROM recent r
      JOIN public.order_items i ON i.order_id = r.id
     ORDER BY i.product_id, i.variant_id, CASE WHEN i.product_id IS NULL THEN i.id END, r.created_at DESC
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'productId', l.product_id, 'variantId', l.variant_id, 'name', l.product_name, 'brand', l.brand,
           'variant', l.variant_name, 'boughtOn', to_char(l.created_at AT TIME ZONE v_tz, 'FMMonth YYYY'),
           'status', l.status) ORDER BY l.created_at DESC, l.product_name), '[]'::jsonb)
    INTO v_owns
    FROM (SELECT * FROM lines ORDER BY created_at DESC, product_name LIMIT 20) l;

  SELECT COALESCE(jsonb_object_agg(e.key, round(LEAST(GREATEST((e.value #>> '{}')::NUMERIC, 0), 10), 2)), '{}'::jsonb)
    INTO v_prof
    FROM (SELECT f.profile
            FROM public.finder_responses f
           WHERE f.customer_id = v_uid AND f.profile <> '{}'::jsonb
           ORDER BY f.updated_at DESC, f.id DESC
           LIMIT 1) latest
    CROSS JOIN LATERAL jsonb_each(latest.profile) AS e(key, value)
   WHERE e.key IN ('performance', 'portability', 'battery', 'value', 'weight')   -- the finder axes (BUILD_SPEC §1)
     AND jsonb_typeof(e.value) = 'number';

  RETURN jsonb_build_object('firstName', v_first, 'owns', v_owns, 'profile', COALESCE(v_prof, '{}'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.get_assistant_customer_context(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_assistant_customer_context(UUID, TEXT) TO authenticated;

-- Right to be forgotten, for conversations: deletes the customer's assistant sessions (their messages
-- cascade). Returns the number of sessions deleted. Errors: 42501 not_authorised.
CREATE OR REPLACE FUNCTION public.forget_assistant_customer(p_customer_id UUID) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_rows INT;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can erase conversations.';
  END IF;
  DELETE FROM public.assistant_sessions WHERE customer_id = p_customer_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;
REVOKE ALL ON FUNCTION public.forget_assistant_customer(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.forget_assistant_customer(UUID) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Private order lookup
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assistant_order_lookups (
  id           BIGSERIAL PRIMARY KEY,
  session_id   UUID,                           -- the assistant session (no FK: the audit outlives it)
  client_key   TEXT,                           -- hashKey output (lower-case hex) or NULL — never a raw IP
  order_ref    TEXT,                           -- the normalised order number asked about
  email_domain TEXT,                           -- the part after "@" — NEVER the address
  found        BOOLEAN NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assistant_order_lookups_client_key_valid CHECK (client_key IS NULL OR client_key ~ '^[0-9a-f]{16,64}$'),
  CONSTRAINT assistant_order_lookups_text_lengths CHECK (
        (order_ref    IS NULL OR char_length(order_ref)    <= 64)
    AND (email_domain IS NULL OR char_length(email_domain) <= 80))
);
CREATE INDEX IF NOT EXISTS assistant_order_lookups_time_idx ON public.assistant_order_lookups (created_at DESC);

-- Admins read it (abuse investigation); nobody writes through the API.
ALTER TABLE public.assistant_order_lookups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.assistant_order_lookups FROM anon, authenticated;
GRANT SELECT ON TABLE public.assistant_order_lookups TO authenticated;
REVOKE ALL ON SEQUENCE public.assistant_order_lookups_id_seq FROM anon, authenticated;
DROP POLICY IF EXISTS assistant_order_lookups_admin_read ON public.assistant_order_lookups;
CREATE POLICY assistant_order_lookups_admin_read ON public.assistant_order_lookups
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

-- The order number and email come from the stage FORM (POST /api/assistant/order), never the model.
-- Granted to anon over SEQUENTIAL order numbers, so it throttles itself with the SAME buckets as
-- track_guest_order (09): 'track:ref:<DO-n>' and 'track:mail:<md5(email)>', 8 per 15 minutes each —
-- both charged on every lookup, both charged again on a miss (a miss costs double). Guessing through
-- the assistant and the tracking page draws on one budget.
--   * blank number or email → NULL (charges nothing); the number accepts what a shopper types
--     (DO-10001, do-10001, #10001, 10001);
--   * over the limit → {"throttled": true} (nothing about whether the pair was right; not audited);
--   * otherwise an audit row (session, hashed client key, order number, email DOMAIN, found) —
--     rows older than 30 days are pruned on the way; the audit never costs the answer;
--   * no match (wrong or missing alike) → NULL;
--   * match → {orderId, status, fulfillment, placedAt, trackingNumber, trackingUrl,
--              items: [{productId, variantId, name, variant, quantity}],        (line order)
--              events: [{status, location, description, updatedAt}]}            (oldest first)
--     — no money, no address, no phone, no email.
CREATE OR REPLACE FUNCTION public.lookup_order_for_assistant(
  p_order_id TEXT, p_email TEXT, p_session_id UUID DEFAULT NULL, p_client_key TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_ref     TEXT := public._normalize_order_ref(p_order_id);
  v_mail    TEXT := lower(btrim(COALESCE(p_email, '')));
  v_key     TEXT := CASE WHEN lower(btrim(p_client_key)) ~ '^[0-9a-f]{16,64}$' THEN lower(btrim(p_client_key)) END;
  v_ok_ref  BOOLEAN;
  v_ok_mail BOOLEAN;
  v_found   BOOLEAN;
  o         public.orders%ROWTYPE;
BEGIN
  IF v_ref IS NULL OR v_mail = '' THEN RETURN NULL; END IF;
  -- Two separate statements: both buckets are always charged (no OR short-circuit games).
  v_ok_ref  := public._rate_limit_hit('track:ref:' || v_ref, 8, 900);
  v_ok_mail := public._rate_limit_hit('track:mail:' || md5(v_mail), 8, 900);
  IF NOT v_ok_ref OR NOT v_ok_mail THEN
    RETURN jsonb_build_object('throttled', TRUE);          -- says nothing about whether the pair was right
  END IF;

  SELECT * INTO o FROM public.orders WHERE id = v_ref AND lower(email) = v_mail;
  v_found := FOUND;                                        -- capture before later statements reset FOUND
  IF NOT v_found THEN
    PERFORM public._rate_limit_hit('track:ref:' || v_ref, 8, 900);            -- a miss costs double
    PERFORM public._rate_limit_hit('track:mail:' || md5(v_mail), 8, 900);
  END IF;

  BEGIN
    DELETE FROM public.assistant_order_lookups WHERE created_at < now() - interval '30 days';
    INSERT INTO public.assistant_order_lookups (session_id, client_key, order_ref, email_domain, found)
    VALUES (p_session_id, v_key, left(v_ref, 64), NULLIF(left(split_part(v_mail, '@', 2), 80), ''), v_found);
  EXCEPTION WHEN OTHERS THEN
    NULL;                                                  -- the audit row must never cost the answer
  END;

  IF NOT v_found THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(                               -- narrow view: no money, no address, no contact
    'orderId',        o.id,
    'status',         o.status,
    'fulfillment',    o.fulfillment,                       -- delivery | pickup: "out_for_delivery" reads "ready for pickup"
    'placedAt',       o.created_at,
    'trackingNumber', o.tracking_number,
    'trackingUrl',    o.tracking_url,
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'productId', i.product_id, 'variantId', i.variant_id, 'name', i.product_name,
               'variant', i.variant_name, 'quantity', i.quantity) ORDER BY i.id)
               FROM public.order_items i WHERE i.order_id = o.id), '[]'::jsonb),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object(
               'status', t.status, 'location', t.location, 'description', t.description, 'updatedAt', t.created_at)
               ORDER BY t.created_at, t.id)
               FROM public.order_tracking t WHERE t.order_id = o.id), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.lookup_order_for_assistant(TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_order_for_assistant(TEXT, TEXT, UUID, TEXT) TO anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 21_assistant_memory_lookup
--   No secrets. Memory needs the SESSION client (auth.uid()); anonymous shoppers cost nothing (the
--   route calls it only when an auth cookie exists). Erasure on request: forget_assistant_customer(<id>)
--   from a signed-in ADMIN session (it re-checks is_admin(), so it answers 42501 in the SQL editor,
--   where auth.uid() is NULL); in the SQL editor run the same statement directly —
--     DELETE FROM public.assistant_sessions WHERE customer_id = '<customer id>';   -- messages cascade
--   The Assistant insights tab is read-only. Lookup audits expire after 30 days (here and in 22_retention).
--   Verification:
--     SELECT found, email_domain, count(*) FROM public.assistant_order_lookups
--      WHERE created_at > now() - interval '1 day' GROUP BY 1, 2;             -- never a full address
--     SELECT has_function_privilege('anon', 'public.get_assistant_customer_context(uuid,text)', 'EXECUTE');  -- false
--     -- live probe (anon key is public): a miss answers null, not an error
--     curl -s "$SUPABASE_URL/rest/v1/rpc/lookup_order_for_assistant" -H "apikey: $ANON" -H "Content-Type: application/json" \
--          -d '{"p_order_id":"DO-1","p_email":"nobody@example.com"}'          -- null
-- ═════════════════════════════════════════════════════════════════════════════
