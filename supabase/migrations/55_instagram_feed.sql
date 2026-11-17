-- ═════════════════════════════════════════════════════════════════════════════
-- 55_instagram_feed.sql — Dock One Solutions
--
-- PURPOSE      The client asked (Website changes, November 2026 — 01 Frontend, "Instagram") for the
--              store's recent Instagram posts on the website, like laptop.lk's "Follow us on
--              Instagram" strip. Set up from the admin (no server settings to edit):
--                * the owner pastes an Instagram access token (Instagram API with Instagram Login,
--                  read-only permission) in admin → Homepage & navbar → Instagram and switches it on;
--                * the admin fetches the latest posts from Instagram (on "Refresh now", and by itself
--                  about twice a day while someone with Homepage access has the admin open) and
--                  keeps them here, renewing the token as it goes (Instagram tokens last 60 days);
--                * the homepage shows the kept posts — public pictures and links from the store's own
--                  account — and never sees the token.
--
--   instagram_settings   ONE row, sealed (no API role reads it). access_token is write-only.
--   get_instagram_feed() PUBLIC: {username, posts: [{id, permalink, media_type, image, caption,
--                        timestamp}]} while switched on and there are posts; NULL otherwise.
--
-- STAFF        Homepage → view: see the status; Homepage → edit: refresh the posts (the token goes
--              only to the site's own server for that). The token itself is the owner's alone.
-- DEPENDS ON   01 (_trusted_route_call), 02, 39 (staff).
-- SAFE TO RE-RUN: yes (the row is created once; a re-run never touches the token or the posts).
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.instagram_settings (
  id                 BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),   -- singleton
  enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  access_token       TEXT,                     -- write-only
  token_refreshed_at TIMESTAMPTZ,              -- when it was saved or last renewed
  username           TEXT,                     -- the account's handle, read from Instagram
  posts              JSONB NOT NULL DEFAULT '[]'::jsonb,
  fetched_at         TIMESTAMPTZ,
  last_error         TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by         UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  CONSTRAINT instagram_settings_valid CHECK (
        (access_token IS NULL OR char_length(access_token) BETWEEN 20 AND 2000)
    AND (username IS NULL OR username ~ '^[A-Za-z0-9._]{1,30}$')
    AND jsonb_typeof(posts) = 'array' AND jsonb_array_length(posts) <= 24 AND octet_length(posts::text) <= 65536
    AND (last_error IS NULL OR char_length(last_error) <= 500))
);
INSERT INTO public.instagram_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.instagram_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.instagram_settings FROM anon, authenticated;

-- The homepage's read: the kept posts (public data from the store's own account), never the token.
CREATE OR REPLACE FUNCTION public.get_instagram_feed()
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN s.enabled AND jsonb_array_length(s.posts) > 0
              THEN jsonb_build_object('username', s.username, 'posts', s.posts, 'fetched_at', s.fetched_at) END
    FROM public.instagram_settings s WHERE s.id
$$;
REVOKE ALL ON FUNCTION public.get_instagram_feed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_instagram_feed() TO anon, authenticated;

-- What the admin shows (Homepage → view): everything but the token.
CREATE OR REPLACE FUNCTION public.admin_instagram_status()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.instagram_settings;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t see the Instagram settings.';
  END IF;
  SELECT * INTO s FROM public.instagram_settings WHERE id;
  RETURN jsonb_build_object('enabled', s.enabled, 'token_set', s.access_token IS NOT NULL, 'token_refreshed_at', s.token_refreshed_at,
                            'username', s.username, 'posts', s.posts, 'fetched_at', s.fetched_at, 'last_error', s.last_error,
                            'is_owner', public.is_full_admin());
END $$;
REVOKE ALL ON FUNCTION public.admin_instagram_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_instagram_status() TO authenticated;

-- OWNER ONLY. {access_token?: a token replaces · null clears · absent/"" keeps, enabled?}
CREATE OR REPLACE FUNCTION public.admin_save_instagram(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_key   TEXT;
  v_token TEXT;
BEGIN
  IF NOT public.is_full_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only the owner can change the Instagram connection.';
  END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_instagram:The settings must be a JSON object.';
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(p) LOOP
    IF NOT (v_key = ANY (ARRAY['access_token', 'enabled'])) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_instagram:The field “%s” can''t be saved here.', left(v_key, 40));
    END IF;
  END LOOP;
  IF p ? 'access_token' THEN
    IF jsonb_typeof(p -> 'access_token') = 'null' THEN
      UPDATE public.instagram_settings SET access_token = NULL, token_refreshed_at = NULL, enabled = FALSE, posts = '[]', fetched_at = NULL, username = NULL WHERE id;
    ELSE
      v_token := btrim(COALESCE(p ->> 'access_token', ''));
      IF v_token <> '' THEN
        IF char_length(v_token) NOT BETWEEN 20 AND 2000 OR v_token ~ '\s' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_instagram:That doesn''t look like an Instagram access token — copy the whole token (no spaces).';
        END IF;
        UPDATE public.instagram_settings SET access_token = v_token, token_refreshed_at = now(), last_error = NULL WHERE id;
      END IF;
    END IF;
  END IF;
  IF p ? 'enabled' THEN
    UPDATE public.instagram_settings
       SET enabled = COALESCE(public._admin_json_bool('invalid_instagram', p -> 'enabled', 'Show on the homepage'), FALSE)
     WHERE id;
  END IF;
  UPDATE public.instagram_settings SET updated_at = now(), updated_by = auth.uid() WHERE id;
  RETURN public.admin_instagram_status();
END $$;
REVOKE ALL ON FUNCTION public.admin_save_instagram(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_instagram(JSONB) TO authenticated;

-- The token, for the site's server to fetch the posts: the owner, or staff with Homepage → edit
-- through the site's own server.
CREATE OR REPLACE FUNCTION public.admin_instagram_token()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s public.instagram_settings;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_full_admin() OR (public.staff_can('homepage', 'edit') AND public._trusted_route_call())) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t refresh the Instagram posts.';
  END IF;
  SELECT * INTO s FROM public.instagram_settings WHERE id;
  IF s.access_token IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'not_configured:Instagram isn''t connected yet — the owner adds the token in admin → Homepage & navbar → Instagram.';
  END IF;
  RETURN jsonb_build_object('access_token', s.access_token, 'token_refreshed_at', s.token_refreshed_at);
END $$;
REVOKE ALL ON FUNCTION public.admin_instagram_token() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_instagram_token() TO authenticated;

-- What a refresh learned: {posts?: [...], username?, access_token? (renewed), error?}. Posts are
-- kept as given (≤ 24, each {id, permalink, media_type, image, caption, timestamp}).
CREATE OR REPLACE FUNCTION public.admin_instagram_store(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_posts JSONB;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_full_admin() OR (public.staff_can('homepage', 'edit') AND public._trusted_route_call())) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Your account can''t refresh the Instagram posts.';
  END IF;
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_instagram:The refresh must be a JSON object.';
  END IF;
  IF NULLIF(btrim(COALESCE(p ->> 'error', '')), '') IS NOT NULL THEN
    UPDATE public.instagram_settings SET last_error = left(btrim(p ->> 'error'), 500) WHERE id;
    RETURN public.admin_instagram_status();
  END IF;
  IF jsonb_typeof(p -> 'posts') = 'array' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'id', left(x ->> 'id', 40), 'permalink', x ->> 'permalink', 'media_type', left(x ->> 'media_type', 20),
             'image', x ->> 'image', 'caption', left(COALESCE(x ->> 'caption', ''), 300), 'timestamp', left(x ->> 'timestamp', 40))
             ORDER BY ord), '[]'::jsonb)
      INTO v_posts
      FROM jsonb_array_elements(p -> 'posts') WITH ORDINALITY AS t(x, ord)
     WHERE ord <= 24 AND x ->> 'permalink' ~ '^https://(www\.)?instagram\.com/' AND x ->> 'image' ~ '^https://';
    UPDATE public.instagram_settings
       SET posts = v_posts, fetched_at = now(), last_error = NULL,
           username = CASE WHEN COALESCE(p ->> 'username', '') ~ '^[A-Za-z0-9._]{1,30}$' THEN p ->> 'username' ELSE username END
     WHERE id;
  END IF;
  IF NULLIF(btrim(COALESCE(p ->> 'access_token', '')), '') IS NOT NULL THEN
    IF char_length(btrim(p ->> 'access_token')) NOT BETWEEN 20 AND 2000 THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_instagram:The renewed token looks wrong.';
    END IF;
    UPDATE public.instagram_settings SET access_token = btrim(p ->> 'access_token'), token_refreshed_at = now() WHERE id;
  END IF;
  RETURN public.admin_instagram_status();
END $$;
REVOKE ALL ON FUNCTION public.admin_instagram_store(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_instagram_store(JSONB) TO authenticated;

DELETE FROM public.staff_api_map WHERE migration = '55';
INSERT INTO public.staff_api_map (kind, name, area, view_level, edit_level, migration) VALUES
  ('rpc', 'admin_instagram_status', 'homepage', 'view', 'view', '55'),
  ('rpc', 'admin_instagram_token',  'homepage', 'view', 'edit', '55'),
  ('rpc', 'admin_instagram_store',  'homepage', 'view', 'edit', '55');

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 55_instagram_feed
--   Run after 01–54. Nothing shows until the owner adds the token and switches it on
--   (admin → Homepage & navbar → Instagram). docs/INSTAGRAM_SETUP.md says how to get the token.
--   Verification:
--     SELECT enabled, access_token IS NOT NULL AS token_set, username, jsonb_array_length(posts), fetched_at, last_error
--       FROM public.instagram_settings;
--     SELECT has_table_privilege('anon', 'public.instagram_settings', 'SELECT');   -- false
-- ═════════════════════════════════════════════════════════════════════════════
