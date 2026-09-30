-- ═════════════════════════════════════════════════════════════════════════════
-- 12_leads.sql — Dock One Solutions
--
-- PURPOSE      Lead capture (blueprint §9.11, §9.12, Appendix A 09):
--                newsletter_subscribers   ONE list, attributed by `source`, one unsubscribe token
--                                         per subscriber (confirm-then-POST unsubscribe page)
--                contact_inquiries        the contact-form inbox (new → answered); admins hold all
--                                         four verbs (a missing UPDATE policy was a silent no-op)
--                email_suppressions       keyed on the PERSON (+ purpose), not on a record. Sealed:
--                                         only definer functions read or write it
--                subscribe_newsletter()   idempotent; TRUE for new AND existing addresses (no
--                                         enumeration); an explicit signup is fresh consent
--                unsubscribe_newsletter() token → unsubscribed + suppressed; TRUE for any token
--                admin_newsletter_mailing_list()  admin-only export of the people who may be mailed
--                                         (active AND not suppressed — the send-time check)
--                submit_contact_inquiry() bounded write: name/subject 1–255, message 15–5000,
--                                         machine codes invalid_*
-- DEPENDS ON   01_foundation, 02_customers_and_auth (is_admin()).
-- ENABLES      POST /api/newsletter, /api/newsletter/unsubscribe, /api/contact,
--              /api/admin/inquiry-reply, admin Inquiries + Subscribers tabs (WP-E);
--              13_abandoned_carts (suppression-aware capture and recovery claims);
--              14_finder (a finder email joins the list with source 'finder');
--              17_analytics (newsletter growth); 22_retention.
-- SAFE TO RE-RUN: yes (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS).
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The suppression list (sealed)
-- ─────────────────────────────────────────────────────────────────────────────
-- One row per (person, purpose). 'cart_recovery' is written by stop_cart_recovery() (13),
-- 'newsletter' by unsubscribe_newsletter(); 'all' is for the owner (SQL editor) — every marketing
-- send checks it. Keyed on the lower-cased address, so a NEW cart or a re-typed address is still
-- suppressed. Never backfill this table from a grandfathering flag (blueprint §14 lesson 28).
CREATE TABLE IF NOT EXISTS public.email_suppressions (
  email      TEXT NOT NULL,                   -- always lower-cased + trimmed (CHECK)
  reason     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (email, reason),
  CONSTRAINT email_suppressions_reason_valid CHECK (reason IN ('cart_recovery', 'newsletter', 'all')),
  CONSTRAINT email_suppressions_email_valid  CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 255)
);
-- Sealed: RLS on with NO policy (admins included) and no table privileges for the API roles.
ALTER TABLE public.email_suppressions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.email_suppressions FROM anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Newsletter
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.newsletter_subscribers (
  id                SERIAL PRIMARY KEY,
  email             TEXT NOT NULL,                              -- lower-cased + trimmed (CHECK)
  source            TEXT NOT NULL DEFAULT 'footer',             -- capture point: home, footer, finder, assistant…
  unsubscribe_token UUID NOT NULL DEFAULT gen_random_uuid(),    -- the /newsletter/unsubscribe?token= credential
  confirmed_at      TIMESTAMPTZ,                                -- set by a double opt-in flow, if one is ever run
  unsubscribed_at   TIMESTAMPTZ,                                -- NULL = subscribed
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT newsletter_subscribers_email_key             UNIQUE (email),
  CONSTRAINT newsletter_subscribers_unsubscribe_token_key UNIQUE (unsubscribe_token),
  CONSTRAINT newsletter_subscribers_email_valid  CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 255),
  CONSTRAINT newsletter_subscribers_source_valid CHECK (char_length(btrim(source)) BETWEEN 1 AND 50)
);
CREATE INDEX IF NOT EXISTS newsletter_subscribers_created_idx ON public.newsletter_subscribers (created_at DESC);
CREATE INDEX IF NOT EXISTS newsletter_subscribers_source_idx  ON public.newsletter_subscribers (source, created_at DESC);

ALTER TABLE public.newsletter_subscribers ENABLE ROW LEVEL SECURITY;
-- anon never reads or writes the list (signups go through subscribe_newsletter); nobody truncates.
REVOKE ALL ON TABLE public.newsletter_subscribers FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.newsletter_subscribers FROM authenticated;
REVOKE ALL ON SEQUENCE public.newsletter_subscribers_id_seq FROM anon;
DROP POLICY IF EXISTS newsletter_admin_all ON public.newsletter_subscribers;
CREATE POLICY newsletter_admin_all ON public.newsletter_subscribers
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- TRUE for new AND existing addresses, so it cannot be used to test membership (P14).
-- FALSE only for an address that is not x@y.z shaped (or > 255 chars) — the route answers 422.
-- The first capture point keeps the attribution (`source` is not overwritten); an explicit signup
-- re-activates an unsubscribed address and lifts its 'newsletter' suppression (fresh consent).
CREATE OR REPLACE FUNCTION public.subscribe_newsletter(p_email TEXT, p_source TEXT DEFAULT 'footer')
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email TEXT := lower(btrim(COALESCE(p_email, '')));
BEGIN
  -- Direct PostgREST callers (not the routes) share a small store-wide budget (01, P3).
  IF NOT public._route_or_budget('subscribe_newsletter', 30, 3600) THEN
    RETURN FALSE;
  END IF;
  IF char_length(v_email) > 255 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RETURN FALSE;
  END IF;
  INSERT INTO public.newsletter_subscribers (email, source)
  VALUES (v_email, left(COALESCE(NULLIF(btrim(p_source), ''), 'footer'), 50))
  ON CONFLICT (email) DO UPDATE SET unsubscribed_at = NULL;   -- an explicit signup is fresh consent
  DELETE FROM public.email_suppressions WHERE email = v_email AND reason = 'newsletter';
  RETURN TRUE;
END $$;
REVOKE ALL ON FUNCTION public.subscribe_newsletter(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.subscribe_newsletter(TEXT, TEXT) TO anon, authenticated;

-- The unsubscribe page asks first, then POSTs the token here (mail scanners follow GET links).
-- Same answer (TRUE) for known, unknown and NULL tokens. The first unsubscribe time is kept.
CREATE OR REPLACE FUNCTION public.unsubscribe_newsletter(p_token UUID) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email TEXT;
BEGIN
  UPDATE public.newsletter_subscribers SET unsubscribed_at = COALESCE(unsubscribed_at, now())
   WHERE unsubscribe_token = p_token
  RETURNING email INTO v_email;
  IF v_email IS NOT NULL THEN
    INSERT INTO public.email_suppressions (email, reason) VALUES (v_email, 'newsletter')
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN TRUE;   -- same answer for unknown tokens
END $$;
REVOKE ALL ON FUNCTION public.unsubscribe_newsletter(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unsubscribe_newsletter(UUID) TO anon, authenticated;

-- The marketing list (admin Subscribers tab → "Export mailing list", CSV). Blueprint §9.11: check
-- email_suppressions before any marketing send — and the store's marketing sends start from this
-- export. The suppression list is sealed even from admins, so the check lives HERE: only active
-- subscribers (unsubscribed_at IS NULL) whose address has no 'newsletter' or 'all' suppression.
-- The unsubscribe token travels with each row so every mail sent from the list can carry that
-- subscriber's /newsletter/unsubscribe?token= link. Admin only: 42501 not_authorised otherwise.
-- → [{email, source, created_at, confirmed_at, unsubscribe_token}] oldest first ('[]' when empty)
CREATE OR REPLACE FUNCTION public.admin_newsletter_mailing_list()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can export the mailing list.';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('email', s.email, 'source', s.source, 'created_at', s.created_at,
                                        'confirmed_at', s.confirmed_at, 'unsubscribe_token', s.unsubscribe_token)
                     ORDER BY s.created_at, s.id)
      FROM public.newsletter_subscribers s
     WHERE s.unsubscribed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM public.email_suppressions x
                        WHERE x.email = s.email AND x.reason IN ('newsletter', 'all'))), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.admin_newsletter_mailing_list() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_newsletter_mailing_list() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Contact inquiries
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contact_inquiries (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,                  -- lower-cased by submit_contact_inquiry
  subject     TEXT NOT NULL,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new',
  answered_at TIMESTAMPTZ,                    -- set by the reply route together with status
  admin_reply TEXT,                           -- the text that was emailed (NULL when answered by phone)
  replied_by  TEXT,                           -- the admin who answered (their email)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contact_inquiries_status_valid CHECK (status IN ('new', 'answered')),
  CONSTRAINT contact_inquiries_text_lengths CHECK (
        char_length(name)    BETWEEN 1 AND 255
    AND char_length(email)   BETWEEN 3 AND 255
    AND char_length(subject) BETWEEN 1 AND 255
    AND char_length(message) BETWEEN 1 AND 5000
    AND (admin_reply IS NULL OR char_length(admin_reply) <= 10000)
    AND (replied_by  IS NULL OR char_length(replied_by)  <= 255))
);
CREATE INDEX IF NOT EXISTS contact_inquiries_status_idx ON public.contact_inquiries (status, created_at DESC);
CREATE INDEX IF NOT EXISTS contact_inquiries_created_idx ON public.contact_inquiries (created_at DESC);

ALTER TABLE public.contact_inquiries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.contact_inquiries FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.contact_inquiries FROM authenticated;
-- All four verbs for admins — a missing UPDATE policy is a silent no-op (blueprint §9.12).
DROP POLICY IF EXISTS contact_inquiries_admin_all ON public.contact_inquiries;
CREATE POLICY contact_inquiries_admin_all ON public.contact_inquiries
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- The contact form's only write path. Values are trimmed; the email is lower-cased.
-- Errors (P0001, checked in this order): invalid_name · invalid_email · invalid_subject · invalid_message
CREATE OR REPLACE FUNCTION public.submit_contact_inquiry(p_name TEXT, p_email TEXT, p_subject TEXT, p_message TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_name    TEXT := btrim(COALESCE(p_name, ''));
  v_email   TEXT := lower(btrim(COALESCE(p_email, '')));
  v_subject TEXT := btrim(COALESCE(p_subject, ''));
  v_message TEXT := btrim(COALESCE(p_message, ''));
BEGIN
  -- Direct PostgREST callers (not /api/contact) share a small store-wide budget (01, P3).
  IF NOT public._route_or_budget('submit_contact_inquiry', 10, 3600) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'invalid_name'; END IF;
  IF char_length(v_email) > 255 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'invalid_email'; END IF;
  IF char_length(v_subject) NOT BETWEEN 1 AND 255 THEN RAISE EXCEPTION 'invalid_subject'; END IF;
  IF char_length(v_message) NOT BETWEEN 15 AND 5000 THEN RAISE EXCEPTION 'invalid_message'; END IF;
  INSERT INTO public.contact_inquiries (name, email, subject, message)
  VALUES (v_name, v_email, v_subject, v_message);
END $$;
REVOKE ALL ON FUNCTION public.submit_contact_inquiry(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_contact_inquiry(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 12_leads
--   No secrets. Deploy the routes (WP-E) together with this file: POST /api/newsletter →
--   subscribe_newsletter, POST /api/newsletter/unsubscribe → unsubscribe_newsletter (the page asks,
--   then POSTs), POST /api/contact → submit_contact_inquiry (+ owner alert email, fail-soft).
--   Marketing sends start from admin_newsletter_mailing_list() (Subscribers tab → "Export mailing
--   list"): it leaves out unsubscribed AND suppressed addresses. The suppression list is sealed on
--   purpose (only 13's recovery claim and these functions read it). To suppress an address from
--   EVERY marketing send (a legal request), run in the SQL editor:
--     INSERT INTO public.email_suppressions (email, reason) VALUES (lower('<address>'), 'all')
--     ON CONFLICT DO NOTHING;
--   Verification:
--     SELECT source, count(*) FILTER (WHERE unsubscribed_at IS NULL) AS active, count(*) AS total
--       FROM public.newsletter_subscribers GROUP BY 1 ORDER BY 3 DESC;
--     SELECT status, count(*) FROM public.contact_inquiries GROUP BY 1;
--     SELECT has_table_privilege('authenticated', 'public.email_suppressions', 'SELECT');   -- false
--     -- live probes (anon key is public): the functions answer, the tables stay closed
--     curl -s "$SUPABASE_URL/rest/v1/rpc/subscribe_newsletter" -H "apikey: $ANON" -H "Content-Type: application/json" \
--          -d '{"p_email":"not-an-email","p_source":"probe"}'                          -- false
--     curl -s "$SUPABASE_URL/rest/v1/newsletter_subscribers?select=email" -H "apikey: $ANON"   -- permission denied
--     curl -s "$SUPABASE_URL/rest/v1/contact_inquiries?select=email" -H "apikey: $ANON"        -- permission denied
-- ═════════════════════════════════════════════════════════════════════════════
