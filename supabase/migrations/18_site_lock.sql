-- ═════════════════════════════════════════════════════════════════════════════
-- 18_site_lock.sql — Dock One Solutions
--
-- PURPOSE      The pre-launch holding page with a PIN (blueprint §9.15, §7.5, Appendix A 14):
--                site_lock               a sealed singleton: locked, bcrypt pin_hash, the bypass
--                                        token, holding-page copy, launch time, strike counter
--                get_site_lock()         (anon) the EFFECTIVE lock state for the proxy, with only a
--                                        sha256 fingerprint of the bypass token — never the token
--                verify_site_lock_pin()  (anon) PIN → token; bcrypt in the DB; the cool-off is checked
--                                        BEFORE comparing; 10 misses → 15-minute cool-off; every
--                                        failure answers NULL
--                admin_site_lock_state() / admin_site_lock_token() / set_site_lock()
--                                        admin only (re-checked inside: 42501); a new PIN ROTATES the
--                                        token, revoking every bypass cookie
-- DEPENDS ON   01_foundation (pgcrypto in `extensions`: crypt, gen_salt, digest),
--              02_customers_and_auth (is_admin(), customers for updated_by).
-- ENABLES      src/proxy.ts site-lock gate + src/lib/site-lock.ts (15 s cache, fingerprint check,
--              fail to last known good), /launching-soon, POST /api/site-lock/unlock,
--              GET/POST /api/admin/site-lock and the admin Site lock tab (WP-H).
-- SAFE TO RE-RUN: yes (the singleton row is inserted once; its values are never reset).
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.site_lock (
  id               BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),   -- exactly one row
  locked           BOOLEAN NOT NULL DEFAULT FALSE,
  pin_hash         TEXT,                                          -- bcrypt; NULL = no PIN set
  unlock_token     UUID NOT NULL DEFAULT gen_random_uuid(),       -- the bypass cookie value; rotated with the PIN
  headline         TEXT NOT NULL DEFAULT 'Launching soon',
  message          TEXT NOT NULL DEFAULT 'We are putting the finishing touches to the store.',
  launch_at        TIMESTAMPTZ,
  auto_unlock      BOOLEAN NOT NULL DEFAULT TRUE,                 -- the lock ends by itself at launch_at
  failed_attempts  INT NOT NULL DEFAULT 0,
  locked_out_until TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by       UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  CONSTRAINT site_lock_text_lengths CHECK (char_length(btrim(headline)) BETWEEN 1 AND 120
                                           AND char_length(btrim(message)) BETWEEN 1 AND 1000),
  CONSTRAINT site_lock_attempts_valid CHECK (failed_attempts BETWEEN 0 AND 10)
);
INSERT INTO public.site_lock (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

-- Sealed: no policy for anyone (admins included), no table privileges for the API roles. Only
-- the definer functions below read or write it.
ALTER TABLE public.site_lock ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.site_lock FROM anon, authenticated;

-- Read on every public request (cached ~15 s per instance by the proxy). The effective state:
-- locked AND NOT (auto_unlock AND launch_at has passed, by the DB clock). No secrets — only
-- unlock_fingerprint = hex sha256 of the token's text, so a bypass cookie verifies locally.
-- One row: (locked, headline, message, launch_at, auto_unlock, has_pin, unlock_fingerprint, server_now).
CREATE OR REPLACE FUNCTION public.get_site_lock()
RETURNS TABLE (locked BOOLEAN, headline TEXT, message TEXT, launch_at TIMESTAMPTZ,
               auto_unlock BOOLEAN, has_pin BOOLEAN, unlock_fingerprint TEXT, server_now TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
  SELECT s.locked AND NOT (s.auto_unlock AND s.launch_at IS NOT NULL AND now() >= s.launch_at),
         s.headline, s.message, s.launch_at, s.auto_unlock, s.pin_hash IS NOT NULL,
         encode(digest(s.unlock_token::TEXT, 'sha256'), 'hex'), now()
    FROM public.site_lock s
$$;
REVOKE ALL ON FUNCTION public.get_site_lock() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_site_lock() TO anon, authenticated;

-- PIN → bypass token (text) or NULL. The cool-off is checked BEFORE comparing; every failure —
-- no PIN set, cooling off, blank, wrong — answers the same NULL. The 10th miss in a row starts a
-- 15-minute cool-off (and resets the counter); a right PIN resets both.
CREATE OR REPLACE FUNCTION public.verify_site_lock_pin(p_pin TEXT) RETURNS TEXT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  s     public.site_lock%ROWTYPE;
  v_pin TEXT := NULLIF(btrim(COALESCE(p_pin, '')), '');
BEGIN
  SELECT * INTO s FROM public.site_lock WHERE id FOR UPDATE;
  IF NOT FOUND OR s.pin_hash IS NULL THEN RETURN NULL; END IF;
  IF s.locked_out_until IS NOT NULL AND now() < s.locked_out_until THEN RETURN NULL; END IF;
  IF v_pin IS NULL OR char_length(v_pin) > 64 THEN RETURN NULL; END IF;
  IF crypt(v_pin, s.pin_hash) = s.pin_hash THEN
    UPDATE public.site_lock SET failed_attempts = 0, locked_out_until = NULL WHERE id;
    RETURN s.unlock_token::TEXT;
  END IF;
  UPDATE public.site_lock
     SET failed_attempts  = CASE WHEN failed_attempts + 1 >= 10 THEN 0 ELSE failed_attempts + 1 END,
         locked_out_until = CASE WHEN failed_attempts + 1 >= 10 THEN now() + interval '15 minutes'
                                 ELSE locked_out_until END
   WHERE id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.verify_site_lock_pin(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_site_lock_pin(TEXT) TO anon, authenticated;

-- The admin panel's view. One row: (locked, effective_locked, headline, message, launch_at,
-- auto_unlock, has_pin, updated_at, server_now). Errors: 42501 not_authorised.
CREATE OR REPLACE FUNCTION public.admin_site_lock_state()
RETURNS TABLE (locked BOOLEAN, effective_locked BOOLEAN, headline TEXT, message TEXT, launch_at TIMESTAMPTZ,
               auto_unlock BOOLEAN, has_pin BOOLEAN, updated_at TIMESTAMPTZ, server_now TIMESTAMPTZ)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read the site lock.';
  END IF;
  RETURN QUERY
    SELECT s.locked,
           s.locked AND NOT (s.auto_unlock AND s.launch_at IS NOT NULL AND now() >= s.launch_at),
           s.headline, s.message, s.launch_at, s.auto_unlock, s.pin_hash IS NOT NULL, s.updated_at, now()
      FROM public.site_lock s;
END $$;
REVOKE ALL ON FUNCTION public.admin_site_lock_state() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_site_lock_state() TO authenticated;

-- Lets the admin route hand the operator their own bypass cookie: locking never locks out the
-- locker. Returns the token as text. Errors: 42501 not_authorised.
CREATE OR REPLACE FUNCTION public.admin_site_lock_token() RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can read the bypass token.';
  END IF;
  RETURN (SELECT s.unlock_token::TEXT FROM public.site_lock s);
END $$;
REVOKE ALL ON FUNCTION public.admin_site_lock_token() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_site_lock_token() TO authenticated;

-- Save the lock. NULL (or blank) = leave unchanged. A new PIN is bcrypt-hashed and ROTATES the
-- token (every bypass cookie stops working — the route then re-issues the operator's own). Any
-- save clears the strike counter and cool-off. p_launch_in_hours sets launch_at = now() + hours;
-- p_clear_launch removes it; re-locking after a launch time already passed clears that stale
-- launch_at (otherwise the lock would end at once).
-- Errors: 42501 not_authorised · 22023 invalid_pin (not 6–12 digits) · 22023 invalid_launch
--   (hours not in (0, 8760]) · 22023 invalid_headline (> 120) · 22023 invalid_message (> 1000) ·
--   22023 pin_required (locking with no PIN set and none given). Messages are 'code:human text'.
CREATE OR REPLACE FUNCTION public.set_site_lock(
  p_locked          BOOLEAN DEFAULT NULL,
  p_pin             TEXT    DEFAULT NULL,
  p_headline        TEXT    DEFAULT NULL,
  p_message         TEXT    DEFAULT NULL,
  p_launch_in_hours NUMERIC DEFAULT NULL,
  p_clear_launch    BOOLEAN DEFAULT FALSE,
  p_auto_unlock     BOOLEAN DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  s          public.site_lock%ROWTYPE;
  v_pin      TEXT := NULLIF(btrim(COALESCE(p_pin, '')), '');
  v_headline TEXT := NULLIF(btrim(COALESCE(p_headline, '')), '');
  v_message  TEXT := NULLIF(btrim(COALESCE(p_message, '')), '');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can change the site lock.';
  END IF;
  IF v_pin IS NOT NULL AND v_pin !~ '^[0-9]{6,12}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_pin:The PIN must be 6 to 12 digits.';
  END IF;
  IF p_launch_in_hours IS NOT NULL AND NOT (p_launch_in_hours > 0 AND p_launch_in_hours <= 8760) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_launch:The countdown must be more than 0 and at most 8760 hours.';
  END IF;
  IF char_length(COALESCE(v_headline, '')) > 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_headline:The headline can be at most 120 characters.';
  END IF;
  IF char_length(COALESCE(v_message, '')) > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_message:The message can be at most 1000 characters.';
  END IF;
  SELECT * INTO s FROM public.site_lock WHERE id FOR UPDATE;
  IF COALESCE(p_locked, s.locked) AND s.pin_hash IS NULL AND v_pin IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'pin_required:Set a PIN before locking the website.';
  END IF;
  UPDATE public.site_lock SET
    locked           = COALESCE(p_locked, locked),
    auto_unlock      = COALESCE(p_auto_unlock, auto_unlock),
    headline         = COALESCE(v_headline, headline),
    message          = COALESCE(v_message, message),
    launch_at        = CASE
                         WHEN p_clear_launch THEN NULL
                         WHEN p_launch_in_hours IS NOT NULL
                           THEN now() + make_interval(secs => (p_launch_in_hours * 3600)::DOUBLE PRECISION)
                         -- re-locking after a countdown already passed would unlock at once
                         WHEN p_locked AND launch_at IS NOT NULL AND launch_at <= now() THEN NULL
                         ELSE launch_at
                       END,
    pin_hash         = CASE WHEN v_pin IS NOT NULL THEN crypt(v_pin, gen_salt('bf', 10)) ELSE pin_hash END,
    unlock_token     = CASE WHEN v_pin IS NOT NULL THEN gen_random_uuid() ELSE unlock_token END,
    failed_attempts  = 0,
    locked_out_until = NULL,
    updated_at       = now(),
    updated_by       = (SELECT c.id FROM public.customers c WHERE c.id = auth.uid())
  WHERE id;
END $$;
REVOKE ALL ON FUNCTION public.set_site_lock(BOOLEAN, TEXT, TEXT, TEXT, NUMERIC, BOOLEAN, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_site_lock(BOOLEAN, TEXT, TEXT, TEXT, NUMERIC, BOOLEAN, BOOLEAN) TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 18_site_lock
--   Nothing is locked by default. To lock before launch: admin panel → Site lock → set a PIN (6–12
--   digits) and lock; the operator's own bypass cookie is refreshed on save, so you stay in.
--   Everyone else sees /launching-soon (noindex); API callers get a JSON 503; job endpoints and
--   /admin stay open. auto_unlock + a launch time ends the lock by itself (DB clock).
--   Lost the PIN? Set a new one in the panel (it also rotates the token, revoking every bypass
--   cookie). Emergency unlock from the SQL editor:
--     UPDATE public.site_lock SET locked = FALSE WHERE id;
--   Verification:
--     SELECT locked, has_pin, launch_at FROM public.get_site_lock();
--     SELECT has_table_privilege('authenticated', 'public.site_lock', 'SELECT');     -- false (sealed)
--     -- live probes (anon key is public): the state answers without secrets, the table is sealed
--     curl -s "$SUPABASE_URL/rest/v1/rpc/get_site_lock" -H "apikey: $ANON" -H "Content-Type: application/json" -d '{}'
--     curl -s "$SUPABASE_URL/rest/v1/site_lock?select=pin_hash" -H "apikey: $ANON"          -- permission denied
-- ═════════════════════════════════════════════════════════════════════════════
