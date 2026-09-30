-- ═════════════════════════════════════════════════════════════════════════════
-- supabase/tests/_helpers.sql — shared helpers for every *.test.sql (blueprint Appendix B.2 style)
--
-- Include it on the first line of a test file:   \ir _helpers.sql
-- (verify.sh runs only *.test.sql, so this file is never run on its own.)
--
-- Conventions
--   * Every check prints `NOTICE:  PASS: <label>`; a failure RAISEs `FAIL: <label> …`, which
--     stops the file (ON_ERROR_STOP) and verify.sh reports that message.
--   * Checks whose outcome depends on earlier writes (rate limits!) must be separate
--     statements: calls inside ONE statement share a snapshot.
--   * Impersonation sets the same GUCs PostgREST sets (see harness.sql):
--       SELECT pg_temp.login_anon();        -- role anon, no claims
--       SELECT pg_temp.login(<uuid>);       -- role authenticated, sub + email claims of that auth user
--       SELECT pg_temp.logout();            -- back to the superuser, claims cleared (auth.uid() IS NULL)
--     Blueprint B.2 style also works: SET ROLE anon; SELECT pg_temp.as_anon();  /
--       SET ROLE authenticated; SELECT pg_temp.as_user('<uuid>', '<email>');  / RESET ROLE;
--   * Query results are sent to /dev/null (\o); NOTICEs and ERRORs still reach stderr.
--   * psql :'vars' do not expand inside DO $$ … $$; stash values with set_config('t.x', …, false).
--
-- Helpers
--   pg_temp.ok(bool, label)                         assert TRUE
--   pg_temp.eq(actual, expected, label)             assert IS NOT DISTINCT FROM (any compatible types)
--   pg_temp.throws(sql, sqlstate, label [, like])   run dynamic SQL as the CURRENT role; assert it
--                                                    fails with that SQLSTATE (and message LIKE)
--   pg_temp.affected(sql) → bigint                   run dynamic SQL, return its row count
--   pg_temp.new_user(email [, confirmed [, meta]]) → uuid   create an auth.users row (as superuser)
--   pg_temp.make_admin(uuid)                         customers.is_admin = TRUE (as superuser)
-- ═════════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
\set QUIET 1
\pset pager off
\o /dev/null
SET client_min_messages = notice;

CREATE OR REPLACE FUNCTION pg_temp.logout() RETURNS void LANGUAGE sql AS $$
  SELECT set_config('role', 'none', false),
         set_config('request.jwt.claim.sub', '', false),
         set_config('request.jwt.claim.email', '', false),
         set_config('request.jwt.claim.role', '', false),
         set_config('request.jwt.claims', '', false)
$$;

CREATE OR REPLACE FUNCTION pg_temp.login_anon() RETURNS void LANGUAGE sql AS $$
  SELECT set_config('role', 'none', false),
         set_config('request.jwt.claim.sub', '', false),
         set_config('request.jwt.claim.email', '', false),
         set_config('request.jwt.claim.role', 'anon', false),
         set_config('request.jwt.claims', '{"role":"anon"}', false),
         set_config('role', 'anon', false)
$$;

CREATE OR REPLACE FUNCTION pg_temp.login(p_uid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_email text;
BEGIN
  PERFORM set_config('role', 'none', false);           -- superuser, to read auth.users
  SELECT email INTO v_email FROM auth.users WHERE id = p_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'login(): no auth.users row %', p_uid; END IF;
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, false);
  PERFORM set_config('request.jwt.claim.email', COALESCE(v_email, ''), false);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', false);
  PERFORM set_config('request.jwt.claims',
            json_build_object('sub', p_uid, 'email', v_email, 'role', 'authenticated')::text, false);
  PERFORM set_config('role', 'authenticated', false);
END $$;

-- Blueprint Appendix B.2 compatibility: claims only — pair with an explicit SET ROLE / RESET ROLE.
CREATE OR REPLACE FUNCTION pg_temp.as_anon() RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', '', false),
         set_config('request.jwt.claim.email', '', false),
         set_config('request.jwt.claims', '', false)
$$;
CREATE OR REPLACE FUNCTION pg_temp.as_user(uid uuid, mail text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claim.sub', uid::text, false),
         set_config('request.jwt.claim.email', mail, false),
         set_config('request.jwt.claims', json_build_object('sub', uid, 'email', mail, 'role', 'authenticated')::text, false)
$$;

CREATE OR REPLACE FUNCTION pg_temp.ok(p_ok boolean, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'FAIL: % (condition was %)', p_label, COALESCE(p_ok::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS: %', p_label;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.eq(p_actual anycompatible, p_expected anycompatible, p_label text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'FAIL: % — expected %, got %', p_label,
      COALESCE(p_expected::text, 'NULL'), COALESCE(p_actual::text, 'NULL');
  END IF;
  RAISE NOTICE 'PASS: %', p_label;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.throws(p_sql text, p_sqlstate text, p_label text, p_message_like text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
  END;
  IF v_state IS NULL THEN
    RAISE EXCEPTION 'FAIL: % — statement succeeded but should have failed with %: %', p_label, p_sqlstate, p_sql;
  END IF;
  IF v_state <> p_sqlstate THEN
    RAISE EXCEPTION 'FAIL: % — expected SQLSTATE %, got % (%)', p_label, p_sqlstate, v_state, v_msg;
  END IF;
  IF p_message_like IS NOT NULL AND v_msg NOT LIKE p_message_like THEN
    RAISE EXCEPTION 'FAIL: % — message "%" does not match "%"', p_label, v_msg, p_message_like;
  END IF;
  RAISE NOTICE 'PASS: %', p_label;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.affected(p_sql text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  EXECUTE p_sql;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.new_user(p_email text, p_confirmed boolean DEFAULT TRUE, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid := gen_random_uuid();
BEGIN
  PERFORM pg_temp.logout();                            -- NOTE: leaves you logged out (superuser)
  INSERT INTO auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  VALUES (v_id, p_email, CASE WHEN p_confirmed THEN now() END, COALESCE(p_meta, '{}'::jsonb));
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.make_admin(p_uid uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_temp.logout();
  UPDATE public.customers SET is_admin = TRUE WHERE id = p_uid;
  IF NOT FOUND THEN RAISE EXCEPTION 'make_admin(): no customers row for %', p_uid; END IF;
END $$;

SELECT pg_temp.logout();
