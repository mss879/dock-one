-- ═════════════════════════════════════════════════════════════════════════════
-- 14_finder.sql — Dock One Solutions
--
-- PURPOSE      Guided-finder capture (blueprint §9.14 step 8, §7.5, Appendix A 11): what shoppers
--              asked the /discover finder for, even without an email — one row per finder session.
--                finder_responses          answers, the ≤ 12 product ids shown, the axis profile,
--                                          optional email and account
--                record_finder_response()  upsert on session_id (a PARTIAL unique index: the
--                                          ON CONFLICT repeats its predicate — the 42P10 bug);
--                                          sizes clamped here, answers allowlisted in the route
--                admin_finder_insights()   the admin Finder insights tab's aggregate (blueprint §11.2
--                                          "distribution of answers: what people want that you may
--                                          not stock"; §11.1 heavy aggregates live in admin_* RPCs)
-- DEPENDS ON   01_foundation, 02_customers_and_auth (customers, is_admin()), 12_leads
--              (subscribe_newsletter: a finder email joins the list with source 'finder').
--              admin_finder_insights() also calls 17_analytics' _business_tz() /
--              _business_window_start() — resolved when it is CALLED, so apply the chain in order
--              (01 → 23) before opening the tab.
-- ENABLES      POST /api/quiz (WP-F), admin Finder insights tab (distribution of answers),
--              the assistant's returning-customer memory (21 reads the latest profile of the
--              signed-in customer), retention of anonymous responses (22).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.finder_responses (
  id                      BIGSERIAL PRIMARY KEY,
  session_id              UUID,                                          -- the browser's finder session
  customer_id             UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  email                   TEXT,                                          -- only when the shopper asked for the results by email
  answers                 JSONB NOT NULL DEFAULT '{}'::jsonb,            -- {question_id: answer | [answers]} (route-allowlisted)
  recommended_product_ids INT[] NOT NULL DEFAULT '{}',                  -- the picks shown, in order (≤ 12)
  profile                 JSONB NOT NULL DEFAULT '{}'::jsonb,            -- {axis: 0..10} (≤ 20 numeric keys)
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT finder_responses_json_objects CHECK (jsonb_typeof(answers) = 'object' AND jsonb_typeof(profile) = 'object'),
  CONSTRAINT finder_responses_email_valid  CHECK (email IS NULL OR (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 255)),
  CONSTRAINT finder_responses_ids_valid    CHECK (cardinality(recommended_product_ids) <= 12
                                                  AND array_position(recommended_product_ids, NULL) IS NULL)
);
-- PARTIAL unique index: every ON CONFLICT against it must repeat the predicate.
CREATE UNIQUE INDEX IF NOT EXISTS finder_responses_session_key
  ON public.finder_responses (session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finder_responses_customer_idx
  ON public.finder_responses (customer_id, updated_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS finder_responses_created_idx ON public.finder_responses (created_at DESC);
-- admin_finder_insights() windows on the latest submission
CREATE INDEX IF NOT EXISTS finder_responses_updated_idx ON public.finder_responses (updated_at DESC);

ALTER TABLE public.finder_responses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.finder_responses FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.finder_responses FROM authenticated;
REVOKE ALL ON SEQUENCE public.finder_responses_id_seq FROM anon;
DROP POLICY IF EXISTS finder_responses_admin_all ON public.finder_responses;
CREATE POLICY finder_responses_admin_all ON public.finder_responses
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- Capture: called when the results appear (answers only) and again if the shopper asks for them
-- by email. One row per session_id; a later call replaces answers / picks / profile and never
-- blanks an earlier email or account (COALESCE).
--   * p_answers: a JSON object, ≤ 20 keys, ≤ 8 KB (the ROUTE allowlists keys and values against
--     the question definitions — SQL only bounds the size).
--   * p_recommended: ≤ 12 ids; NULLs and non-positive ids are dropped, order kept.
--   * p_profile: kept only as ≤ 20 entries whose key is a short snake_case word and whose value is
--     a JSON number, clamped to 0..10 (2 dp); anything else is dropped; not an object → {}.
--   * p_email: lower-cased; not x@y.z (or > 255) → ignored. A valid email is subscribed to the
--     newsletter with source 'finder' (subscribe_newsletter: like any explicit signup it
--     re-activates an address that had unsubscribed — the form must say so).
--   * p_customer_id: attached ONLY when it equals auth.uid() of the caller and that account has a
--     customers row — call with the SESSION client (the route passes the signed-in user's id). An
--     id supplied any other way (anon key, someone else's id) is ignored: account ids are
--     identifiers, never credentials.
-- Errors (P0001): invalid_session (NULL session) · invalid_answers (not an object, > 20 keys,
--   > 8 KB) · invalid_recommendations (> 12 ids).
CREATE OR REPLACE FUNCTION public.record_finder_response(
  p_session_id  UUID,
  p_answers     JSONB,
  p_email       TEXT  DEFAULT NULL,
  p_recommended INT[] DEFAULT NULL,
  p_profile     JSONB DEFAULT NULL,
  p_customer_id UUID  DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email    TEXT := lower(btrim(COALESCE(p_email, '')));
  v_profile  JSONB := '{}'::jsonb;
  v_ids      INT[];
  v_customer UUID;
BEGIN
  -- Direct PostgREST callers (not /api/quiz) share a small store-wide budget (01, P3).
  IF NOT public._route_or_budget('record_finder_response', 30, 3600) THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'invalid_session'; END IF;
  IF p_answers IS NULL OR jsonb_typeof(p_answers) <> 'object' THEN RAISE EXCEPTION 'invalid_answers'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_answers)) > 20 THEN RAISE EXCEPTION 'invalid_answers'; END IF;
  IF pg_column_size(p_answers) > 8192 THEN RAISE EXCEPTION 'invalid_answers'; END IF;
  IF cardinality(COALESCE(p_recommended, '{}'::INT[])) > 12 THEN RAISE EXCEPTION 'invalid_recommendations'; END IF;

  v_ids := ARRAY(SELECT x FROM unnest(COALESCE(p_recommended, '{}'::INT[])) WITH ORDINALITY AS u(x, ord)
                  WHERE x IS NOT NULL AND x > 0 ORDER BY ord);

  IF jsonb_typeof(p_profile) = 'object' THEN
    SELECT COALESCE(jsonb_object_agg(e.key, round(LEAST(GREATEST((e.value #>> '{}')::NUMERIC, 0), 10), 2)), '{}'::jsonb)
      INTO v_profile
      FROM (SELECT key, value FROM jsonb_each(p_profile)
             WHERE key ~ '^[a-z][a-z0-9_]{0,39}$' AND jsonb_typeof(value) = 'number'
             ORDER BY key LIMIT 20) e;
  END IF;

  IF char_length(v_email) > 255 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    v_email := NULL;
  END IF;

  -- Granted to anon: only the caller's OWN account is ever attached.
  IF p_customer_id IS NOT NULL AND p_customer_id = auth.uid() THEN
    SELECT c.id INTO v_customer FROM public.customers c WHERE c.id = p_customer_id;
  END IF;

  INSERT INTO public.finder_responses AS f
    (session_id, customer_id, email, answers, recommended_product_ids, profile)
  VALUES (p_session_id, v_customer, v_email, p_answers, v_ids, v_profile)
  ON CONFLICT (session_id) WHERE session_id IS NOT NULL DO UPDATE SET
    email                   = COALESCE(EXCLUDED.email, f.email),          -- never blank an earlier value
    customer_id             = COALESCE(EXCLUDED.customer_id, f.customer_id),
    answers                 = EXCLUDED.answers,
    recommended_product_ids = EXCLUDED.recommended_product_ids,
    profile                 = EXCLUDED.profile,
    updated_at              = now();

  IF v_email IS NOT NULL THEN
    PERFORM public.subscribe_newsletter(v_email, 'finder');
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.record_finder_response(UUID, JSONB, TEXT, INT[], JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_finder_response(UUID, JSONB, TEXT, INT[], JSONB, UUID) TO anon, authenticated;

-- Finder insights (grant U; the admin is re-checked inside → 42501 not_authorised).
-- Window: responses whose LATEST submission (updated_at) falls in the last p_days business days
-- including today (Asia/Colombo, 17's _business_window_start); p_days clamped 1..365 (NULL → 30).
-- One row = one finder session (a re-run replaces its answers), so every figure counts SHOPPERS.
-- Returns jsonb:
--   { days, since, timezone,
--     responses                      finder sessions in the window
--     with_email                     … that asked for their picks by email
--     signed_in                      … from a signed-in account
--     short                          … where the finder found fewer than 3 products for the answers
--     empty                          … where it found none
--     categories: [{category, responses, short, empty}]                  (most asked first)
--     answers:    [{category, question, value, count}]                   use / budget / portability
--                                                                       (single) and avoid (each
--                                                                       token: "wired", "heavy",
--                                                                       "brand:<Brand>")
--     gaps:       [{category, use, budget, portability, avoid[], picks, count}]  ≤ 25 answer
--                                                                       combinations that got fewer
--                                                                       than 3 picks — "what people
--                                                                       want that you may not stock" }
-- Values are cut to 80 characters (answers are allowlisted by the route; this only bounds output).
CREATE OR REPLACE FUNCTION public.admin_finder_insights(p_days INT DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_days  INT := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_since TIMESTAMPTZ;
  v_out   JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read finder insights.';
  END IF;
  v_since := public._business_window_start(v_days);

  WITH r AS (
    SELECT f.email, f.customer_id,
           cardinality(f.recommended_product_ids) AS picks,
           CASE WHEN jsonb_typeof(f.answers -> 'category') = 'string' THEN left(f.answers ->> 'category', 80) END AS category,
           CASE WHEN jsonb_typeof(f.answers -> 'use') = 'string' THEN left(f.answers ->> 'use', 80) END AS use,
           CASE WHEN jsonb_typeof(f.answers -> 'budget') = 'string' THEN left(f.answers ->> 'budget', 80) END AS budget,
           CASE WHEN jsonb_typeof(f.answers -> 'portability') = 'string' THEN left(f.answers ->> 'portability', 80) END AS portability,
           ARRAY(SELECT DISTINCT left(a.value, 80)
                   FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(f.answers -> 'avoid') = 'array'
                                                       THEN f.answers -> 'avoid' ELSE '[]'::jsonb END) AS a(value)
                  ORDER BY 1) AS avoid
      FROM public.finder_responses f
     WHERE f.updated_at >= v_since
  ),
  choices AS (
    SELECT category, 'use'::TEXT AS question, use AS value FROM r WHERE use IS NOT NULL
    UNION ALL SELECT category, 'budget', budget FROM r WHERE budget IS NOT NULL
    UNION ALL SELECT category, 'portability', portability FROM r WHERE portability IS NOT NULL
    UNION ALL SELECT r.category, 'avoid', a.value FROM r CROSS JOIN LATERAL unnest(r.avoid) AS a(value)
  )
  SELECT jsonb_build_object(
           'days', v_days, 'since', v_since, 'timezone', public._business_tz(),
           'responses',  (SELECT count(*) FROM r),
           'with_email', (SELECT count(*) FROM r WHERE email IS NOT NULL),
           'signed_in',  (SELECT count(*) FROM r WHERE customer_id IS NOT NULL),
           'short',      (SELECT count(*) FROM r WHERE picks < 3),
           'empty',      (SELECT count(*) FROM r WHERE picks = 0),
           'categories', COALESCE((SELECT jsonb_agg(jsonb_build_object('category', c.category, 'responses', c.n,
                                                                       'short', c.short, 'empty', c.empty)
                                                    ORDER BY c.n DESC, c.category)
                                     FROM (SELECT category, count(*) AS n,
                                                  count(*) FILTER (WHERE picks < 3) AS short,
                                                  count(*) FILTER (WHERE picks = 0) AS empty
                                             FROM r GROUP BY category) c), '[]'::jsonb),
           'answers',    COALESCE((SELECT jsonb_agg(jsonb_build_object('category', a.category, 'question', a.question,
                                                                       'value', a.value, 'count', a.n)
                                                    ORDER BY a.category, a.question, a.n DESC, a.value)
                                     FROM (SELECT category, question, value, count(*) AS n
                                             FROM choices GROUP BY category, question, value) a), '[]'::jsonb),
           'gaps',       COALESCE((SELECT jsonb_agg(jsonb_build_object('category', g.category, 'use', g.use, 'budget', g.budget,
                                                                       'portability', g.portability, 'avoid', to_jsonb(g.avoid),
                                                                       'picks', g.picks, 'count', g.n)
                                                    ORDER BY g.n DESC, g.picks, g.category, g.use, g.budget)
                                     FROM (SELECT category, use, budget, portability, avoid, picks, count(*) AS n
                                             FROM r WHERE picks < 3
                                            GROUP BY category, use, budget, portability, avoid, picks
                                            ORDER BY count(*) DESC, picks, category, use, budget
                                            LIMIT 25) g), '[]'::jsonb))
    INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_finder_insights(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_finder_insights(INT) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 14_finder
--   No secrets. Deploy POST /api/quiz (WP-F) with this file: it allowlists the answers against the
--   question definitions, clamps the profile, calls record_finder_response with the SESSION client
--   (p_customer_id = the signed-in user's id, or NULL), and re-derives the picks server-side before
--   emailing results (never prose from the request body).
--   Verification:
--     SELECT count(*), count(email), count(customer_id) FROM public.finder_responses;
--     SELECT key, value, count(*) FROM public.finder_responses, jsonb_each_text(answers)
--      GROUP BY 1, 2 ORDER BY 1, 3 DESC;                                   -- what people ask for
--     SELECT indexdef FROM pg_indexes WHERE indexname = 'finder_responses_session_key';   -- … WHERE (session_id IS NOT NULL)
--     -- the upsert against the partial index works (a 42P10 here = the predicate is missing):
--     BEGIN;
--       SELECT public.record_finder_response('00000000-0000-4000-8000-000000000001', '{"category":"mice"}');
--       SELECT public.record_finder_response('00000000-0000-4000-8000-000000000001', '{"category":"mice"}');
--       SELECT count(*) FROM public.finder_responses WHERE session_id = '00000000-0000-4000-8000-000000000001';  -- 1
--     ROLLBACK;
--     SELECT public.admin_finder_insights(30);   -- as an admin (SQL editor: SET request.jwt.claims first)
--     -- live probe (anon key is public): a malformed call is refused with a machine code
--     curl -s "$SUPABASE_URL/rest/v1/rpc/record_finder_response" -H "apikey: $ANON" -H "Content-Type: application/json" \
--          -d '{"p_session_id":null,"p_answers":{}}'                         -- {"message":"invalid_session",…}
-- ═════════════════════════════════════════════════════════════════════════════
