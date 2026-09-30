-- ═════════════════════════════════════════════════════════════════════════════
-- 24_admin_account.sql — Dock One Solutions
--
-- PURPOSE      Make the account admin@dockone.lk an admin: sets customers.is_admin = TRUE on its
--              row (the ONLY thing that grants admin — 02_customers_and_auth). This is the
--              promotion step of 02's OPS NOTE, as a file.
--              The account must already exist AND have a confirmed email; this file never
--              creates a login and never stores a password. If the account is missing or
--              unconfirmed, nothing changes and the result row says what to do — then run the
--              file again. No standing rule is left behind: an account created later with this
--              address is NOT promoted until the file is run again.
-- DEPENDS ON   02_customers_and_auth (customers, the signup trigger that provisions the row).
-- ENABLES      /admin for admin@dockone.lk (lib/auth.ts reads customers.is_admin).
-- SAFE TO RE-RUN: yes (a second run is a no-op).
-- ═════════════════════════════════════════════════════════════════════════════

DO $admin$
DECLARE
  c_email CONSTANT TEXT := 'admin@dockone.lk';
  v_uid       UUID;
  v_confirmed BOOLEAN;
  v_is_admin  BOOLEAN;
BEGIN
  SELECT c.id, u.email_confirmed_at IS NOT NULL, c.is_admin
    INTO v_uid, v_confirmed, v_is_admin
    FROM public.customers c
    JOIN auth.users u ON u.id = c.id
   WHERE lower(c.email) = c_email;

  IF v_uid IS NULL THEN
    RAISE NOTICE '24_admin_account: no account % yet — nothing changed (create it, confirm the email, run this file again)', c_email;
    RETURN;
  END IF;
  IF NOT v_confirmed THEN                             -- an unproven address never gets admin
    RAISE NOTICE '24_admin_account: % has not confirmed its email — nothing changed (confirm it, run this file again)', c_email;
    RETURN;
  END IF;
  IF v_is_admin THEN
    RAISE NOTICE '24_admin_account: % is already an admin — left unchanged', c_email;
    RETURN;
  END IF;

  UPDATE public.customers SET is_admin = TRUE WHERE id = v_uid;
  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = v_uid AND is_admin) THEN
    RAISE EXCEPTION '24_admin_account: % was not promoted (customers.is_admin is still FALSE)', c_email;
  END IF;
  RAISE NOTICE '24_admin_account: % is now an admin', c_email;
END $admin$;

-- The result the SQL editor shows: one row saying where the account stands.
SELECT 'admin@dockone.lk' AS email,
       CASE WHEN c.id IS NULL                  THEN 'NOT AN ADMIN — no account yet: create it, confirm the email, run this file again'
            WHEN u.email_confirmed_at IS NULL  THEN 'NOT AN ADMIN — email not confirmed: confirm it, run this file again'
            WHEN c.is_admin                    THEN 'admin'
            ELSE                                    'NOT AN ADMIN'
       END AS status
  FROM (SELECT 1) one
  LEFT JOIN public.customers c ON lower(c.email) = 'admin@dockone.lk'
  LEFT JOIN auth.users u ON u.id = c.id;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 24_admin_account
--   Before running: the account must exist with a confirmed email — sign up at /signin and
--   click the confirmation link, or Supabase → Authentication → Users → Add user with
--   "Auto Confirm User" ticked (use that when the mailbox cannot receive mail yet).
--   To take admin away again:
--     UPDATE public.customers SET is_admin = FALSE WHERE lower(email) = 'admin@dockone.lk';
--   Verification:
--     SELECT email, is_admin FROM public.customers WHERE is_admin;   -- every admin, and nobody else
-- ═════════════════════════════════════════════════════════════════════════════
