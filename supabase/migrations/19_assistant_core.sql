-- ═════════════════════════════════════════════════════════════════════════════
-- 19_assistant_core.sql — Dock One Solutions
--
-- PURPOSE      The AI assistant's conversation log and insights (blueprint §10.13, §11.4, §12.2,
--              Appendix A 15). This migration OWNS the shape of assistant_messages and the
--              signature of log_assistant_turn(): later migrations add NEW functions, never change
--              these (add every column up front, freeze the writer's signature).
--                assistant_sessions         one row per browser chat session (client_key = HMAC of
--                                           the caller's IP, never the raw IP)
--                assistant_messages         user + assistant rows; content PII-REDACTED on the way in;
--                                           outcome, tools, search terms, products shown/added/tapped,
--                                           model, latency, token counts, photo flag + reading
--                redact_pii()               emails → [email], DO- order numbers → [order], phone shapes
--                                           and runs of 7+ digits → [number]; prices/specs survive
--                clamp_ints(), clamp_labels() order-preserving array clamps
--                log_assistant_turn()       ONE write per turn (user + reply), ≤ 400 messages per
--                                           session, swallows its own errors
--                admin_assistant_overview() / admin_assistant_sessions() / admin_assistant_transcript()
--                                           the Assistant insights tab (admin re-checked: 42501)
-- DEPENDS ON   01_foundation, 02_customers_and_auth (customers, is_admin()), 04_catalogue
--              (products for the demand list), 17_analytics (_business_tz, _business_window_start).
-- ENABLES      POST /api/assistant logging (lib/assistant/insights.ts), the admin Assistant insights
--              tab (WP-I), 20_assistant_offers (earned sessions), 21_assistant_memory_lookup
--              (session claims, forget), 22_retention.
-- OUTCOMES     truncated | bad_ids | no_image_match | no_match | no_tools | dead_end | answered | failed
--              — the same list lives in THREE places: the TS type (lib/assistant/types.ts), the CHECK
--              below and the coercion inside log_assistant_turn. Change all three together.
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.assistant_sessions (
  id            UUID PRIMARY KEY,                               -- minted by the browser
  client_key    TEXT,                                           -- hashKey(clientKey(req)): lower-case hex, never the raw IP
  customer_id   UUID REFERENCES public.customers (id) ON DELETE SET NULL,   -- set by 21's claim
  message_count INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assistant_sessions_client_key_valid CHECK (client_key IS NULL OR client_key ~ '^[0-9a-f]{16,64}$'),
  CONSTRAINT assistant_sessions_count_valid      CHECK (message_count >= 0)
);
CREATE INDEX IF NOT EXISTS assistant_sessions_customer_idx
  ON public.assistant_sessions (customer_id, last_seen_at DESC) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS assistant_sessions_seen_idx ON public.assistant_sessions (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.assistant_messages (
  id                 BIGSERIAL PRIMARY KEY,
  session_id         UUID NOT NULL REFERENCES public.assistant_sessions (id) ON DELETE CASCADE,
  role               TEXT NOT NULL,                    -- user | assistant
  content            TEXT NOT NULL,                    -- PII-redacted on the way in (redact_pii)
  product_ids        INT[],                            -- shown on the stage (assistant rows)
  added_product_ids  INT[],                            -- added to the bag by the agent (assistant rows)
  tapped_product_ids INT[],                            -- tapped ADD on staged cards by the shopper (user rows)
  outcome            TEXT,                             -- assistant rows; NULL = unclassified
  question_id        TEXT,                             -- the present_question id (assistant rows)
  tools_used         TEXT[],
  search_terms       TEXT[],                           -- redacted
  page               TEXT,                             -- the path the shopper was on
  model              TEXT,
  latency_ms         INT,
  input_tokens       INT,
  output_tokens      INT,
  cache_read_tokens  INT,
  has_image          BOOLEAN NOT NULL DEFAULT FALSE,   -- user rows: a photo rode on this turn (never stored)
  photo_reading      TEXT,                             -- assistant rows: what the photo was read as (≤ 200, redacted)
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assistant_messages_role_valid    CHECK (role IN ('user', 'assistant')),
  CONSTRAINT assistant_messages_outcome_valid CHECK (outcome IS NULL OR outcome IN
    ('truncated', 'bad_ids', 'no_image_match', 'no_match', 'no_tools', 'dead_end', 'answered', 'failed'))
);
CREATE INDEX IF NOT EXISTS assistant_messages_session_idx   ON public.assistant_messages (session_id, created_at, id);
CREATE INDEX IF NOT EXISTS assistant_messages_time_idx      ON public.assistant_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS assistant_messages_struggles_idx ON public.assistant_messages (created_at DESC)
  WHERE outcome IS NOT NULL AND outcome <> 'answered';

-- Written only by log_assistant_turn (and 21's claim). Admins read; nobody else sees a thing.
ALTER TABLE public.assistant_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assistant_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.assistant_sessions, public.assistant_messages FROM anon, authenticated;
GRANT SELECT ON TABLE public.assistant_sessions, public.assistant_messages TO authenticated;
REVOKE ALL ON SEQUENCE public.assistant_messages_id_seq FROM anon, authenticated;
DROP POLICY IF EXISTS assistant_sessions_admin_read ON public.assistant_sessions;
CREATE POLICY assistant_sessions_admin_read ON public.assistant_sessions
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));
DROP POLICY IF EXISTS assistant_messages_admin_read ON public.assistant_messages;
CREATE POLICY assistant_messages_admin_read ON public.assistant_messages
  FOR SELECT TO authenticated USING ((SELECT public.is_admin()));

-- ─────────────────────────────────────────────────────────────────────────────
-- Helpers (internal: no grants)
-- ─────────────────────────────────────────────────────────────────────────────
-- Order-preserving clamps: the first p_limit non-NULL values.
CREATE OR REPLACE FUNCTION public.clamp_ints(p_values INT[], p_limit INT DEFAULT 12) RETURNS INT[]
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_values IS NULL THEN NULL ELSE
    (SELECT array_agg(v ORDER BY ord)
       FROM (SELECT v, ord FROM unnest(p_values) WITH ORDINALITY AS t(v, ord)
              WHERE v IS NOT NULL ORDER BY ord LIMIT p_limit) x) END
$$;
REVOKE ALL ON FUNCTION public.clamp_ints(INT[], INT) FROM PUBLIC, anon, authenticated;

-- The first p_limit non-blank values, each trimmed and cut to p_len characters.
CREATE OR REPLACE FUNCTION public.clamp_labels(p_values TEXT[], p_limit INT DEFAULT 8, p_len INT DEFAULT 40) RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN p_values IS NULL THEN NULL ELSE
    (SELECT array_agg(left(btrim(v), p_len) ORDER BY ord)
       FROM (SELECT v, ord FROM unnest(p_values) WITH ORDINALITY AS t(v, ord)
              WHERE v IS NOT NULL AND btrim(v) <> '' ORDER BY ord LIMIT p_limit) x) END
$$;
REVOKE ALL ON FUNCTION public.clamp_labels(TEXT[], INT, INT) FROM PUBLIC, anon, authenticated;

-- Redaction happens on the way IN, so it can never be recovered later (P10). In order:
--   emails → [email]; order numbers "DO-10001" / "do 10001" / "DO10001" → [order];
--   phone shapes ("077 123 4567", "+94 77 123 4567", "0771234567", "(011) 234-5678") → [number];
--   any remaining run of 7+ digits → [number].
-- Prices ("Rs. 489,900", "300000"), specs ("RTX 4060", "16GB") and model numbers survive.
CREATE OR REPLACE FUNCTION public.redact_pii(p_text TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  t TEXT := p_text;
BEGIN
  IF t IS NULL THEN RETURN NULL; END IF;
  t := regexp_replace(t, '[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}', '[email]', 'g');
  t := regexp_replace(t, '\mDO[- ]?[0-9]{5,12}\M', '[order]', 'gi');
  t := regexp_replace(t, '(\+?[0-9]{1,4}[ .-]?)?\(?[0-9]{2,4}\)?[ .-]?[0-9]{3}[ .-]?[0-9]{4}', '[number]', 'g');
  t := regexp_replace(t, '[0-9]{7,}', '[number]', 'g');
  RETURN t;
END $$;
REVOKE ALL ON FUNCTION public.redact_pii(TEXT) FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- The logger: ONE write per turn (two racing inserts contended on the session row and could not
-- be ordered). Granted to anon (the route calls it with the stateless client). Swallows every
-- error: a clean return does NOT prove a row was written — verify with the OPS NOTE query.
--   * nothing is written when p_session_id is NULL or both texts are blank;
--   * the session row is created or touched (last_seen_at, message_count += rows written this
--     turn); client_key must be lower-case hex 16–64 chars (hashKey output) — anything else
--     (e.g. a raw IP) is stored as NULL; the first key a session got is kept;
--   * past 400 messages in a session nothing more is stored (the counter still moves);
--   * user row: redacted text (≤ 8000), tapped_product_ids (≤ 12), page, has_image;
--   * assistant row: redacted text (≤ 8000), product_ids / added_product_ids (≤ 12 each), outcome
--     (unknown → NULL, never a CHECK failure that loses the turn), question_id (≤ 32),
--     tools_used (≤ 12 × 40), search_terms (≤ 8 × 80, redacted), page, model (≤ 60),
--     latency_ms 0..600000, input/output/cache_read tokens 0..10 000 000 (NULL stays NULL),
--     photo_reading (newlines/brackets → spaces, ≤ 200, redacted);
--   * page: the path only (query string and fragment removed), ≤ 120.
CREATE OR REPLACE FUNCTION public.log_assistant_turn(
  p_session_id         UUID,
  p_user_content       TEXT,
  p_assistant_content  TEXT    DEFAULT '',
  p_outcome            TEXT    DEFAULT NULL,
  p_shown_product_ids  INT[]   DEFAULT NULL,
  p_added_product_ids  INT[]   DEFAULT NULL,
  p_tapped_product_ids INT[]   DEFAULT NULL,
  p_question_id        TEXT    DEFAULT NULL,
  p_tools_used         TEXT[]  DEFAULT NULL,
  p_search_terms       TEXT[]  DEFAULT NULL,
  p_page               TEXT    DEFAULT NULL,
  p_model              TEXT    DEFAULT NULL,
  p_latency_ms         INT     DEFAULT NULL,
  p_input_tokens       INT     DEFAULT NULL,
  p_output_tokens      INT     DEFAULT NULL,
  p_has_image          BOOLEAN DEFAULT FALSE,
  p_photo_reading      TEXT    DEFAULT NULL,
  p_client_key         TEXT    DEFAULT NULL,
  p_cache_read_tokens  INT     DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_user    TEXT := left(btrim(COALESCE(p_user_content, '')), 8000);
  v_reply   TEXT := left(btrim(COALESCE(p_assistant_content, '')), 8000);
  v_outcome TEXT := CASE WHEN p_outcome IN ('truncated', 'bad_ids', 'no_image_match', 'no_match', 'no_tools',
                                            'dead_end', 'answered', 'failed')
                         THEN p_outcome END;   -- unknown → NULL, never a CHECK failure that loses the turn
  v_page    TEXT := NULLIF(left(btrim(split_part(split_part(COALESCE(p_page, ''), '?', 1), '#', 1)), 120), '');
  v_reading TEXT := NULLIF(left(btrim(regexp_replace(COALESCE(p_photo_reading, ''), '[\n\r\[\]]', ' ', 'g')), 200), '');
  v_key     TEXT := CASE WHEN lower(btrim(p_client_key)) ~ '^[0-9a-f]{16,64}$' THEN lower(btrim(p_client_key)) END;
  v_rows    INT;
  v_count   INT;
BEGIN
  -- Only /api/assistant logs turns: a direct PostgREST call is dropped, so sessions can't be
  -- forged to "earn" exclusive offers or to fill the transcript tables (01, P3).
  IF NOT public._trusted_route_call() THEN RETURN; END IF;
  IF p_session_id IS NULL OR (v_user = '' AND v_reply = '') THEN RETURN; END IF;
  v_rows := (CASE WHEN v_user <> '' THEN 1 ELSE 0 END) + (CASE WHEN v_reply <> '' THEN 1 ELSE 0 END);

  INSERT INTO public.assistant_sessions AS s (id, client_key, message_count)
  VALUES (p_session_id, v_key, v_rows)
  ON CONFLICT (id) DO UPDATE SET
    last_seen_at  = now(),
    message_count = s.message_count + v_rows
  RETURNING message_count INTO v_count;
  IF v_count > 400 THEN RETURN; END IF;              -- one session cannot grow without bound

  IF v_user <> '' THEN
    INSERT INTO public.assistant_messages (session_id, role, content, tapped_product_ids, page, has_image)
    VALUES (p_session_id, 'user', public.redact_pii(v_user),
            public.clamp_ints(p_tapped_product_ids, 12), v_page, COALESCE(p_has_image, FALSE));
  END IF;
  IF v_reply <> '' THEN
    INSERT INTO public.assistant_messages (
      session_id, role, content, product_ids, added_product_ids, outcome, question_id,
      tools_used, search_terms, page, model, latency_ms, input_tokens, output_tokens,
      cache_read_tokens, photo_reading)
    VALUES (
      p_session_id, 'assistant', public.redact_pii(v_reply),
      public.clamp_ints(p_shown_product_ids, 12), public.clamp_ints(p_added_product_ids, 12),
      v_outcome, NULLIF(left(btrim(p_question_id), 32), ''),
      public.clamp_labels(p_tools_used, 12, 40),
      (SELECT array_agg(public.redact_pii(t) ORDER BY o)
         FROM unnest(public.clamp_labels(p_search_terms, 8, 80)) WITH ORDINALITY AS x(t, o)),
      v_page, NULLIF(left(btrim(p_model), 60), ''),
      CASE WHEN p_latency_ms        IS NULL THEN NULL ELSE LEAST(GREATEST(p_latency_ms, 0), 600000) END,
      CASE WHEN p_input_tokens      IS NULL THEN NULL ELSE LEAST(GREATEST(p_input_tokens, 0), 10000000) END,
      CASE WHEN p_output_tokens     IS NULL THEN NULL ELSE LEAST(GREATEST(p_output_tokens, 0), 10000000) END,
      CASE WHEN p_cache_read_tokens IS NULL THEN NULL ELSE LEAST(GREATEST(p_cache_read_tokens, 0), 10000000) END,
      public.redact_pii(v_reading));
  END IF;
EXCEPTION WHEN OTHERS THEN
  RETURN;   -- logging must never cost the shopper an answer
END $$;
REVOKE ALL ON FUNCTION public.log_assistant_turn(UUID, TEXT, TEXT, TEXT, INT[], INT[], INT[], TEXT, TEXT[], TEXT[], TEXT, TEXT, INT, INT, INT, BOOLEAN, TEXT, TEXT, INT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_assistant_turn(UUID, TEXT, TEXT, TEXT, INT[], INT[], INT[], TEXT, TEXT[], TEXT[], TEXT, TEXT, INT, INT, INT, BOOLEAN, TEXT, TEXT, INT)
  TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Admin insights (grant U; admin re-checked inside: 42501 not_authorised)
-- Window = the last p_days business days (Asia/Colombo) including today; p_days 1..365 (NULL → 30).
-- ─────────────────────────────────────────────────────────────────────────────

-- What happened, what people searched for, what they took, what they photographed.
-- → { days, since, timezone,
--     totals: {sessions, turns, adds, photos, struggles, median_latency_ms, input_tokens, output_tokens, cache_read_tokens},
--     outcomes: {truncated, bad_ids, no_image_match, no_match, no_tools, dead_end, answered, failed},  (unclassified → answered)
--     hours: {"0": n … "23": n},                                   user messages per local hour
--     terms: [{term, turns}],                  top assistant search terms (≤ 25)
--     zero_result_terms: [{term, turns}],      terms on no_match / no_image_match turns (≤ 25) — "stock this"
--     demand: [{product_id, brand, name, shown, taken}],  (≤ 30; taken = added by the agent + tapped by the shopper)
--     photo_demand: [{reading, turns}],        photo readings on no_image_match turns, "unclear" excluded (≤ 25)
--     tools: [{tool, calls}] }
CREATE OR REPLACE FUNCTION public.admin_assistant_overview(p_days INT DEFAULT 30)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_days  INT := LEAST(GREATEST(COALESCE(p_days, 30), 1), 365);
  v_since TIMESTAMPTZ := public._business_window_start(p_days);
  v_tz    TEXT := public._business_tz();
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read assistant insights.';
  END IF;
  RETURN jsonb_build_object(
    'days', v_days, 'since', v_since, 'timezone', v_tz,
    'totals', (SELECT jsonb_build_object(
        'sessions',          count(DISTINCT m.session_id),
        'turns',             count(*) FILTER (WHERE m.role = 'assistant'),
        'adds',              COALESCE(sum(cardinality(m.added_product_ids)) FILTER (WHERE m.role = 'assistant'), 0)
                           + COALESCE(sum(cardinality(m.tapped_product_ids)) FILTER (WHERE m.role = 'user'), 0),
        'photos',            count(*) FILTER (WHERE m.role = 'user' AND m.has_image),
        'struggles',         count(*) FILTER (WHERE m.role = 'assistant' AND m.outcome IS NOT NULL AND m.outcome <> 'answered'),
        'median_latency_ms', percentile_cont(0.5) WITHIN GROUP (ORDER BY m.latency_ms)
                               FILTER (WHERE m.role = 'assistant' AND m.latency_ms IS NOT NULL),
        'input_tokens',      COALESCE(sum(m.input_tokens), 0),
        'output_tokens',     COALESCE(sum(m.output_tokens), 0),
        'cache_read_tokens', COALESCE(sum(m.cache_read_tokens), 0))
      FROM public.assistant_messages m WHERE m.created_at >= v_since),
    'outcomes', (SELECT jsonb_object_agg(k.o, COALESCE(c.n, 0))
                   FROM unnest(ARRAY['truncated', 'bad_ids', 'no_image_match', 'no_match', 'no_tools',
                                     'dead_end', 'answered', 'failed']) AS k(o)
                   LEFT JOIN (SELECT COALESCE(outcome, 'answered') AS o, count(*) AS n
                                FROM public.assistant_messages
                               WHERE role = 'assistant' AND created_at >= v_since GROUP BY 1) c ON c.o = k.o),
    'hours', (SELECT jsonb_object_agg(h.h, COALESCE(c.n, 0))
                FROM generate_series(0, 23) AS h(h)
                LEFT JOIN (SELECT extract(hour FROM created_at AT TIME ZONE v_tz)::INT AS h, count(*) AS n
                             FROM public.assistant_messages
                            WHERE role = 'user' AND created_at >= v_since GROUP BY 1) c ON c.h = h.h),
    'terms', COALESCE((SELECT jsonb_agg(jsonb_build_object('term', x.term, 'turns', x.n) ORDER BY x.n DESC, x.term)
                         FROM (SELECT lower(btrim(t)) AS term, count(*) AS n
                                 FROM public.assistant_messages m, unnest(m.search_terms) AS t
                                WHERE m.role = 'assistant' AND m.created_at >= v_since AND btrim(t) <> ''
                                GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 25) x), '[]'::jsonb),
    'zero_result_terms', COALESCE((SELECT jsonb_agg(jsonb_build_object('term', x.term, 'turns', x.n) ORDER BY x.n DESC, x.term)
                         FROM (SELECT lower(btrim(t)) AS term, count(*) AS n
                                 FROM public.assistant_messages m, unnest(m.search_terms) AS t
                                WHERE m.role = 'assistant' AND m.created_at >= v_since AND btrim(t) <> ''
                                  AND m.outcome IN ('no_match', 'no_image_match')
                                GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 25) x), '[]'::jsonb),
    'demand', COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', x.product_id, 'brand', x.brand, 'name', x.name,
                                                            'shown', x.shown, 'taken', x.taken) ORDER BY x.shown + x.taken DESC, x.product_id)
                          FROM (SELECT p.id AS product_id, p.brand, p.name,
                                       count(*) FILTER (WHERE d.kind = 'shown') AS shown,
                                       count(*) FILTER (WHERE d.kind = 'taken') AS taken
                                  FROM (SELECT unnest(m.product_ids) AS pid, 'shown' AS kind
                                          FROM public.assistant_messages m
                                         WHERE m.role = 'assistant' AND m.created_at >= v_since
                                        UNION ALL
                                        SELECT unnest(m.added_product_ids), 'taken'
                                          FROM public.assistant_messages m
                                         WHERE m.role = 'assistant' AND m.created_at >= v_since
                                        UNION ALL
                                        SELECT unnest(m.tapped_product_ids), 'taken'
                                          FROM public.assistant_messages m
                                         WHERE m.role = 'user' AND m.created_at >= v_since) d
                                  JOIN public.products p ON p.id = d.pid
                                 GROUP BY p.id, p.brand, p.name
                                 ORDER BY count(*) DESC, p.id LIMIT 30) x), '[]'::jsonb),
    'photo_demand', COALESCE((SELECT jsonb_agg(jsonb_build_object('reading', x.reading, 'turns', x.n) ORDER BY x.n DESC, x.reading)
                                FROM (SELECT lower(btrim(m.photo_reading)) AS reading, count(*) AS n
                                        FROM public.assistant_messages m
                                       WHERE m.role = 'assistant' AND m.created_at >= v_since
                                         AND m.outcome = 'no_image_match' AND m.photo_reading IS NOT NULL
                                         AND lower(btrim(m.photo_reading)) <> 'unclear'
                                       GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 25) x), '[]'::jsonb),
    'tools', COALESCE((SELECT jsonb_agg(jsonb_build_object('tool', x.tool, 'calls', x.n) ORDER BY x.n DESC, x.tool)
                         FROM (SELECT t AS tool, count(*) AS n
                                 FROM public.assistant_messages m, unnest(m.tools_used) AS t
                                WHERE m.role = 'assistant' AND m.created_at >= v_since
                                GROUP BY 1) x), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION public.admin_assistant_overview(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assistant_overview(INT) TO authenticated;

-- Sessions seen in the window, newest first. p_struggles_only: only sessions with at least one
-- struggle (an assistant row whose outcome is set and not 'answered') in the window.
-- p_limit 1..200 (NULL → 50), p_offset 0..100000.
-- → {total, items: [{session_id, customer_id, message_count, turns, struggles, photos, adds,
--                    first_message, last_outcome, created_at, last_seen_at}]}
--   first_message = the first user message (redacted, ≤ 160 chars); last_outcome = the latest
--   assistant row's outcome.
CREATE OR REPLACE FUNCTION public.admin_assistant_sessions(
  p_days INT DEFAULT 30, p_struggles_only BOOLEAN DEFAULT FALSE, p_limit INT DEFAULT 50, p_offset INT DEFAULT 0)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_since  TIMESTAMPTZ := public._business_window_start(p_days);
  v_limit  INT := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_offset INT := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 100000);
  v_out    JSONB;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read assistant sessions.';
  END IF;
  WITH stats AS (
    SELECT s.id, s.customer_id, s.message_count, s.created_at, s.last_seen_at,
           count(m.id) FILTER (WHERE m.role = 'assistant') AS turns,
           count(m.id) FILTER (WHERE m.role = 'assistant' AND m.outcome IS NOT NULL AND m.outcome <> 'answered') AS struggles,
           count(m.id) FILTER (WHERE m.role = 'user' AND m.has_image) AS photos,
           COALESCE(sum(cardinality(m.added_product_ids)) FILTER (WHERE m.role = 'assistant'), 0)
             + COALESCE(sum(cardinality(m.tapped_product_ids)) FILTER (WHERE m.role = 'user'), 0) AS adds
      FROM public.assistant_sessions s
      LEFT JOIN public.assistant_messages m ON m.session_id = s.id AND m.created_at >= v_since
     WHERE s.last_seen_at >= v_since
     GROUP BY s.id
  ), filtered AS (
    SELECT * FROM stats WHERE NOT COALESCE(p_struggles_only, FALSE) OR struggles > 0
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM filtered),
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                         'session_id', f.id, 'customer_id', f.customer_id, 'message_count', f.message_count,
                         'turns', f.turns, 'struggles', f.struggles, 'photos', f.photos, 'adds', f.adds,
                         'first_message', (SELECT left(m.content, 160) FROM public.assistant_messages m
                                            WHERE m.session_id = f.id AND m.role = 'user' ORDER BY m.id LIMIT 1),
                         'last_outcome', (SELECT m.outcome FROM public.assistant_messages m
                                           WHERE m.session_id = f.id AND m.role = 'assistant' ORDER BY m.id DESC LIMIT 1),
                         'created_at', f.created_at, 'last_seen_at', f.last_seen_at) ORDER BY f.last_seen_at DESC, f.id)
                         FROM (SELECT * FROM filtered ORDER BY last_seen_at DESC, id LIMIT v_limit OFFSET v_offset) f), '[]'::jsonb))
    INTO v_out;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_assistant_sessions(INT, BOOLEAN, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assistant_sessions(INT, BOOLEAN, INT, INT) TO authenticated;

-- A session's messages in order (≤ 400) for the transcript drawer: rows of assistant_messages.
CREATE OR REPLACE FUNCTION public.admin_assistant_transcript(p_session_id UUID)
RETURNS SETOF public.assistant_messages
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read transcripts.';
  END IF;
  RETURN QUERY SELECT * FROM public.assistant_messages WHERE session_id = p_session_id ORDER BY id LIMIT 400;
END $$;
REVOKE ALL ON FUNCTION public.admin_assistant_transcript(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assistant_transcript(UUID) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 19_assistant_core
--   No secrets here (OPENAI_API_KEY lives in the app). Do this — the logger swallows errors, so a
--   deploy proves nothing: send one real message through the assistant, then
--     SELECT role, outcome, left(content, 60), created_at FROM public.assistant_messages ORDER BY id DESC LIMIT 4;
--   and check the redaction:
--     SELECT public.redact_pii('mail me at a.b@c.com or +94 77 123 4567 about DO-10023, budget 300000');
--     → 'mail me at [email] or [number] about [order], budget 300000'
--   Transcripts are kept 12 months (22_retention); erase a customer's conversations with
--   forget_assistant_customer (21).
--   Verification:
--     SELECT has_function_privilege('anon', 'public.redact_pii(text)', 'EXECUTE');            -- false
--     SELECT has_table_privilege('anon', 'public.assistant_messages', 'SELECT');               -- false
--     -- live probe (anon key is public): transcripts are closed
--     curl -s "$SUPABASE_URL/rest/v1/assistant_messages?select=content" -H "apikey: $ANON"     -- permission denied
-- ═════════════════════════════════════════════════════════════════════════════
