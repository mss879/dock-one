-- ═════════════════════════════════════════════════════════════════════════════
-- supabase/tests/harness.sql — a Supabase-shaped local database (blueprint Appendix B.1)
--
-- PURPOSE   Make privilege and RLS bugs reproduce on a throwaway Postgres 16 exactly as they
--           would on Supabase, so `scripts/db/verify.sh` can prove the migrations before the
--           owner pastes them into the SQL editor.
-- LOADED BY scripts/db/verify.sh into a fresh database, BEFORE any migration. Never apply
--           this file to a real Supabase project (the platform already provides all of it).
-- PROVIDES
--   * roles anon, authenticated (NOLOGIN) and service_role (NOLOGIN BYPASSRLS);
--   * schema `auth` with `auth.users` (the columns our triggers read, plus the usual extras)
--     and auth.uid() / auth.email() / auth.role() / auth.jwt(), which read the same GUCs
--     PostgREST sets: the legacy per-claim `request.jwt.claim.<name>` settings first, then the
--     JSON `request.jwt.claims` setting (current PostgREST). Tests may use either;
--   * schema `extensions` (where Supabase installs pgcrypto, pg_trgm, …) with USAGE granted;
--   * a minimal `storage` schema (buckets + objects, RLS on) so migrations that create
--     buckets and storage policies are exercised instead of skipped;
--   * SUPABASE'S DEFAULT PRIVILEGES: every table, sequence and function the postgres role
--     creates in `public` is granted to anon, authenticated and service_role DIRECTLY.
--     This is why `REVOKE … FROM PUBLIC` alone never closes a function (blueprint §7.1):
--     after it, has_function_privilege('anon', …) is still TRUE here, as on Supabase.
--
-- IMPERSONATION (how tests act as a caller)
--   SET ROLE anon;           SELECT set_config('request.jwt.claim.sub', '', false),
--                                   set_config('request.jwt.claims', '', false);
--   SET ROLE authenticated;  SELECT set_config('request.jwt.claim.sub', '<uuid>', false),
--                                   set_config('request.jwt.claim.email', '<email>', false),
--                                   set_config('request.jwt.claims',
--                                     json_build_object('sub','<uuid>','email','<email>','role','authenticated')::text, false);
--   RESET ROLE;              -- back to the superuser (auth.uid() is NULL once the GUCs are cleared)
-- ═════════════════════════════════════════════════════════════════════════════

-- Roles -----------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END $$;

-- Schemas ---------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS storage;

-- auth.users: the columns GoTrue maintains that our triggers and tests touch, plus the common
-- extras so `INSERT … (id, email, …)` fixtures look like the real thing.
CREATE TABLE IF NOT EXISTS auth.users (
  instance_id          UUID,
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aud                  VARCHAR(255) DEFAULT 'authenticated',
  role                 VARCHAR(255) DEFAULT 'authenticated',
  email                VARCHAR(255),
  encrypted_password   VARCHAR(255),
  email_confirmed_at   TIMESTAMPTZ,
  invited_at           TIMESTAMPTZ,
  confirmation_sent_at TIMESTAMPTZ,
  email_change         VARCHAR(255),
  phone                TEXT,
  phone_confirmed_at   TIMESTAMPTZ,
  last_sign_in_at      TIMESTAMPTZ,
  raw_app_meta_data    JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_user_meta_data   JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_super_admin       BOOLEAN,
  is_sso_user          BOOLEAN NOT NULL DEFAULT FALSE,
  is_anonymous         BOOLEAN NOT NULL DEFAULT FALSE,
  banned_until         TIMESTAMPTZ,
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);
-- GoTrue: one account per email (SSO users excepted).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_partial_key ON auth.users (email) WHERE (is_sso_user = FALSE);

-- auth helpers: the per-claim GUC first (legacy PostgREST), then the JSON claims GUC.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.email() RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.email', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
  )
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS JSONB
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

GRANT USAGE ON SCHEMA public, auth, extensions TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.email(), auth.role(), auth.jwt() TO anon, authenticated, service_role;

-- Minimal Supabase Storage: enough for bucket rows and storage.objects policies.
CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  owner              UUID,
  public             BOOLEAN DEFAULT FALSE,
  avif_autodetection BOOLEAN DEFAULT FALSE,
  file_size_limit    BIGINT,
  allowed_mime_types TEXT[],
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bname ON storage.buckets (name);
CREATE TABLE IF NOT EXISTS storage.objects (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id        TEXT REFERENCES storage.buckets (id),
  name             TEXT,
  owner            UUID,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now(),
  last_accessed_at TIMESTAMPTZ DEFAULT now(),
  metadata         JSONB
);
CREATE UNIQUE INDEX IF NOT EXISTS bucketid_objname ON storage.objects (bucket_id, name);
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON storage.buckets, storage.objects TO anon, authenticated, service_role;

-- What Supabase does for objects the postgres role creates in public:
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
