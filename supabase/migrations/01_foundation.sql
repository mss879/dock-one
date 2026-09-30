-- ═════════════════════════════════════════════════════════════════════════════
-- 01_foundation.sql — Dock One Solutions
--
-- PURPOSE      Extensions, the shared `touch_updated_at()` trigger, the sealed `app_config`
--              secrets table, `verify_job_secret()`, and database-side rate limiting
--              (`rate_limit_hits`, internal `_rate_limit_hit()`, secret-gated
--              `check_rate_limit()` for route handlers), and the direct-call brake
--              (`_trusted_route_call()`, `_route_or_budget()`: public RPCs called straight against
--              PostgREST, bypassing the routes, share a small store-wide budget — P3 hardening).
--              Blueprint §2 P3, §6.4, §7.1, §7.5, Appendix A 01.
-- DEPENDS ON   nothing (Supabase provides the `auth` schema and the `extensions` schema).
-- ENABLES      every later migration: 02+ use touch_updated_at(); job endpoints (cart recovery,
--              maintenance) compare their bearer secret with verify_job_secret(); every public
--              route throttles through check_rate_limit() (lib/rate-limit.ts), and definer RPCs
--              throttle themselves with _rate_limit_hit(); 09/12/13/14/17/19 call
--              _route_or_budget() / _trusted_route_call() first.
-- SAFE TO RE-RUN: yes (IF NOT EXISTS / CREATE OR REPLACE / guarded DO blocks).
-- ═════════════════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Pre-flight: fail at migration time, not at first use.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.proname IN ('digest', 'crypt', 'gen_salt') AND n.nspname IN ('public', 'extensions')
  ) THEN
    RAISE EXCEPTION 'pgcrypto (digest/crypt/gen_salt) is required in the public or extensions schema';
  END IF;
END $$;

-- Shared BEFORE UPDATE trigger body: keeps updated_at honest without trusting the client.
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;
-- Trigger functions are never called directly; keep them off the privilege surface.
REVOKE ALL ON FUNCTION public.touch_updated_at() FROM PUBLIC, anon, authenticated;

-- Secrets and one-time markers. Sealed: RLS on with NO policy (admins included) and no grants.
CREATE TABLE IF NOT EXISTS public.app_config (
  name       TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_config FROM anon, authenticated;

-- Internal. Never granted. An unset or short secret keeps every job closed.
CREATE OR REPLACE FUNCTION public.verify_job_secret(p_name TEXT, p_secret TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_expected TEXT;
BEGIN
  IF p_secret IS NULL OR length(p_secret) < 20 THEN RETURN FALSE; END IF;
  SELECT value INTO v_expected FROM public.app_config WHERE name = p_name;
  IF v_expected IS NULL OR length(v_expected) < 20 THEN RETURN FALSE; END IF;
  -- Compare digests, not the strings: equal-length hashes leak nothing useful by timing.
  RETURN digest(p_secret, 'sha256') = digest(v_expected, 'sha256');
END $$;
-- On Supabase, default privileges grant EXECUTE on new functions to anon and
-- authenticated DIRECTLY — revoking from PUBLIC alone does not close a function.
REVOKE ALL ON FUNCTION public.verify_job_secret(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- Sliding-window hit log. Sealed.
CREATE TABLE IF NOT EXISTS public.rate_limit_hits (
  id     BIGSERIAL PRIMARY KEY,
  bucket TEXT NOT NULL,
  hit_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rate_limit_hits_bucket_time_idx ON public.rate_limit_hits (bucket, hit_at DESC);
ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rate_limit_hits FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.rate_limit_hits_id_seq FROM anon, authenticated;

-- Internal limiter, called by other definer functions. Never granted.
-- TRUE = allowed (and the hit is recorded); FALSE = over the limit (nothing recorded).
CREATE OR REPLACE FUNCTION public._rate_limit_hit(p_bucket TEXT, p_max INT, p_window_seconds INT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_bucket TEXT;
  v_hits   INT;
BEGIN
  -- Nonsense arguments never lock the store.
  IF p_bucket IS NULL OR btrim(p_bucket) = '' OR p_max IS NULL OR p_max < 1
     OR p_window_seconds IS NULL OR p_window_seconds < 1 THEN
    RETURN TRUE;
  END IF;
  v_bucket := left(btrim(p_bucket), 200);
  -- Serialise callers of the same bucket so concurrent requests cannot overshoot.
  PERFORM pg_advisory_xact_lock(hashtext(v_bucket));
  -- Lazy garbage collection, per bucket: no cron job needed.
  DELETE FROM public.rate_limit_hits
   WHERE bucket = v_bucket AND hit_at < now() - make_interval(secs => p_window_seconds);
  SELECT count(*) INTO v_hits FROM public.rate_limit_hits WHERE bucket = v_bucket;
  IF v_hits >= p_max THEN RETURN FALSE; END IF;
  INSERT INTO public.rate_limit_hits (bucket) VALUES (v_bucket);
  RETURN TRUE;
END $$;
REVOKE ALL ON FUNCTION public._rate_limit_hit(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;

-- Public wrapper for route handlers. The secret stops anyone pre-filling another caller's bucket.
CREATE OR REPLACE FUNCTION public.check_rate_limit(p_secret TEXT, p_bucket TEXT, p_max INT, p_window_seconds INT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.verify_job_secret('rate_limit', p_secret) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  RETURN public._rate_limit_hit(p_bucket, p_max, p_window_seconds);
END $$;
REVOKE ALL ON FUNCTION public.check_rate_limit(TEXT, TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(TEXT, TEXT, INT, INT) TO anon, authenticated;

-- Direct-call brake (blueprint P3, hardening beyond the reference store). Route handlers are the
-- only intended callers of the public write/advisory RPCs (place_order, quote_order,
-- validate_discount, capture_abandoned_cart, subscribe_newsletter, submit_contact_inquiry,
-- record_finder_response, track_event, log_assistant_turn), and their per-IP limits live in the
-- routes. Someone holding only the public anon key can call those RPCs straight against PostgREST
-- and skip the routes. The app's server-side Supabase clients (src/lib/supabase/route-token.ts)
-- therefore send
--     x-dockone-route: hex(HMAC-SHA256(key = the 'rate_limit' secret, 'dockone-route-v1'))
-- which PostgREST exposes in request.headers. _trusted_route_call() is TRUE for such calls, and
-- also when no 'rate_limit' secret is configured (the store stays open, like check_rate_limit).
CREATE OR REPLACE FUNCTION public._trusted_route_call() RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_secret TEXT;
  v_given  TEXT;
BEGIN
  SELECT value INTO v_secret FROM public.app_config WHERE name = 'rate_limit';
  IF v_secret IS NULL OR length(v_secret) < 20 THEN RETURN TRUE; END IF;
  BEGIN
    v_given := NULLIF(current_setting('request.headers', true), '')::jsonb ->> 'x-dockone-route';
  EXCEPTION WHEN OTHERS THEN
    v_given := NULL;
  END;
  IF v_given IS NULL OR length(v_given) <> 64 THEN RETURN FALSE; END IF;
  RETURN digest(v_given, 'sha256') = digest(encode(hmac('dockone-route-v1', v_secret, 'sha256'), 'hex'), 'sha256');
END $$;
REVOKE ALL ON FUNCTION public._trusted_route_call() FROM PUBLIC, anon, authenticated;

-- TRUE when the call came through a route, or when the store-wide budget for DIRECT calls of this
-- kind (p_max per p_window_seconds) still has room. Only direct callers ever spend that budget.
CREATE OR REPLACE FUNCTION public._route_or_budget(p_kind TEXT, p_max INT, p_window_seconds INT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF public._trusted_route_call() THEN RETURN TRUE; END IF;
  RETURN public._rate_limit_hit('direct:' || COALESCE(p_kind, '?'), p_max, p_window_seconds);
END $$;
REVOKE ALL ON FUNCTION public._route_or_budget(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 01_foundation
--   Secrets (do this or EVERY rate limit fails open — treat an unset RATE_LIMIT_SECRET in
--   production as a deploy error):
--     INSERT INTO public.app_config (name, value)
--     VALUES ('rate_limit', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
--     ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
--     SELECT value FROM public.app_config WHERE name = 'rate_limit';   -- copy into RATE_LIMIT_SECRET
--   Later features add their own rows the same way ('cart_recovery' → CART_RECOVERY_SECRET,
--   'maintenance' → MAINTENANCE_SECRET). Values must be ≥ 20 characters.
--   Verification:
--     SELECT has_function_privilege('anon', 'public.verify_job_secret(text,text)', 'EXECUTE');  -- false
--     SELECT has_function_privilege('anon', 'public._rate_limit_hit(text,integer,integer)', 'EXECUTE'); -- false
--     SELECT has_function_privilege('anon', 'public.check_rate_limit(text,text,integer,integer)', 'EXECUTE'); -- true
--     -- live probe (anon key is public): must answer an error "unauthorized", not true/false
--     curl -s "$SUPABASE_URL/rest/v1/rpc/check_rate_limit" -H "apikey: $ANON" -H "Authorization: Bearer $ANON" \
--          -H "Content-Type: application/json" -d '{"p_secret":"x","p_bucket":"probe","p_max":1,"p_window_seconds":60}'
-- ═════════════════════════════════════════════════════════════════════════════
