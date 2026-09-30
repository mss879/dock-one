-- 24_admin_account.test.sql — admin@dockone.lk is promoted only when the account exists with a
-- confirmed email; nobody else is touched; no standing rule; idempotent.
\ir _helpers.sql

-- ── 1. no account yet: the migration chain ran on an empty auth.users and promoted nobody ──
SELECT pg_temp.eq((SELECT count(*) FROM public.customers WHERE is_admin), 0::bigint, 'no account → no admin');

-- ── 2. an unconfirmed account is never promoted ──────────────────────────────
SELECT set_config('t.other', pg_temp.new_user('shopper@shop.test')::text, false);
SELECT set_config('t.admin', pg_temp.new_user('Admin@DockOne.lk', FALSE)::text, false);
\ir ../migrations/24_admin_account.sql
SELECT pg_temp.eq((SELECT is_admin FROM public.customers WHERE id = current_setting('t.admin')::uuid), FALSE,
  'an unconfirmed admin@dockone.lk is left alone');

-- ── 3. confirmed: promoted, and only that account ────────────────────────────
UPDATE auth.users SET email_confirmed_at = now() WHERE id = current_setting('t.admin')::uuid;
SELECT pg_temp.eq((SELECT is_admin FROM public.customers WHERE id = current_setting('t.admin')::uuid), FALSE,
  'confirming alone does not promote (no standing rule)');
\ir ../migrations/24_admin_account.sql
SELECT pg_temp.eq((SELECT is_admin FROM public.customers WHERE id = current_setting('t.admin')::uuid), TRUE,
  'a confirmed admin@dockone.lk is promoted (email matched case-insensitively)');
SELECT pg_temp.eq((SELECT count(*) FROM public.customers WHERE is_admin), 1::bigint, 'nobody else is promoted');
SELECT pg_temp.login(current_setting('t.admin')::uuid);
SELECT pg_temp.eq(public.is_admin(), TRUE, 'is_admin() is true for the promoted account');
SELECT pg_temp.login(current_setting('t.other')::uuid);
SELECT pg_temp.eq(public.is_admin(), FALSE, 'is_admin() stays false for another shopper');
SELECT pg_temp.logout();

-- ── 4. idempotent ────────────────────────────────────────────────────────────
\ir ../migrations/24_admin_account.sql
SELECT pg_temp.eq((SELECT count(*) FROM public.customers WHERE is_admin), 1::bigint, 'a second run is a no-op');
