-- ═════════════════════════════════════════════════════════════════════════════
-- 02_customers_and_auth.sql — Dock One Solutions
--
-- PURPOSE      The `customers` profile row for every Supabase Auth account (id = auth.users.id),
--              `is_admin()` (the ONLY thing that grants admin), provisioning on signup,
--              guest-order linking once the email is CONFIRMED, an email-change sync, and the
--              column pin that stops a shopper editing their own email / admin flag / lifetime
--              value through the "update own row" policy. Blueprint §6.2, §7.4, §9.13,
--              Appendix A 02; BUILD_SPEC §4.1 (Sri Lankan address keys).
-- DEPENDS ON   01_foundation (touch_updated_at). Supabase `auth.users`.
--              link_guest_orders() reads public.orders (created by 07_orders) only if that
--              table exists, so this file applies before 07 and signups keep working.
-- ENABLES      accounts (WP-D), admin gate (lib/auth.ts reads customers.is_admin), owner RLS on
--              orders/wishlists/reviews (07+), checkout prefill (address keys = checkout
--              `shipping` JSON keys: street, city, district, postal_code, country).
-- SAFE TO RE-RUN: yes.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.customers (
  id           UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  first_name   TEXT,
  last_name    TEXT,
  phone        TEXT,
  street       TEXT,            -- address keys match the checkout `shipping` JSON keys
  city         TEXT,
  district     TEXT,            -- one of the 25 districts (CHECK below), NULL until chosen
  postal_code  TEXT,
  country      TEXT NOT NULL DEFAULT 'Sri Lanka',
  note         TEXT,            -- admin-only; pinned for customers
  total_spent  NUMERIC(12,2) NOT NULL DEFAULT 0,
  orders_count INT NOT NULL DEFAULT 0,
  is_admin     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS customers_email_lower_key ON public.customers (lower(email));

-- Shape constraints (named, so the app can map a violation to a field).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_district_valid') THEN
    ALTER TABLE public.customers ADD CONSTRAINT customers_district_valid CHECK (
      district IS NULL OR district IN (
        'Ampara', 'Anuradhapura', 'Badulla', 'Batticaloa', 'Colombo', 'Galle', 'Gampaha',
        'Hambantota', 'Jaffna', 'Kalutara', 'Kandy', 'Kegalle', 'Kilinochchi', 'Kurunegala',
        'Mannar', 'Matale', 'Matara', 'Monaragala', 'Mullaitivu', 'Nuwara Eliya',
        'Polonnaruwa', 'Puttalam', 'Ratnapura', 'Trincomalee', 'Vavuniya'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_field_lengths') THEN
    ALTER TABLE public.customers ADD CONSTRAINT customers_field_lengths CHECK (
          char_length(email) <= 255
      AND (first_name  IS NULL OR char_length(first_name)  <= 255)
      AND (last_name   IS NULL OR char_length(last_name)   <= 255)
      AND (phone       IS NULL OR char_length(phone)       <= 50)
      AND (street      IS NULL OR char_length(street)      <= 500)
      AND (city        IS NULL OR char_length(city)        <= 120)
      AND (postal_code IS NULL OR char_length(postal_code) <= 20)
      AND char_length(country) BETWEEN 1 AND 80
      AND (note        IS NULL OR char_length(note)        <= 5000));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_rollups_non_negative') THEN
    ALTER TABLE public.customers ADD CONSTRAINT customers_rollups_non_negative
      CHECK (total_spent >= 0 AND orders_count >= 0);
  END IF;
END $$;

DROP TRIGGER IF EXISTS customers_touch ON public.customers;
CREATE TRIGGER customers_touch BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- No argument: it cannot be used to probe whether some other id is an admin.
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT c.is_admin FROM public.customers c WHERE c.id = auth.uid()), FALSE)
$$;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- Links earlier guest orders to a VERIFIED address and adopts their history.
-- Guarded: before 07_orders exists there is nothing to link, and a signup must never fail
-- because of it. (plpgsql plans the statements lazily, so the body compiles without orders.)
-- Contract with 07: orders(customer_id UUID, email TEXT, total_price NUMERIC, status TEXT
-- with 'cancelled' in its vocabulary).
CREATE OR REPLACE FUNCTION public.link_guest_orders(p_uid UUID, p_email TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_uid IS NULL OR p_email IS NULL OR btrim(p_email) = '' THEN RETURN; END IF;
  IF to_regclass('public.orders') IS NULL THEN RETURN; END IF;
  PERFORM set_config('app.trusted_write', 'on', true);
  UPDATE public.orders SET customer_id = p_uid
   WHERE customer_id IS NULL AND lower(email) = lower(btrim(p_email));
  UPDATE public.customers c
     SET total_spent  = s.total,
         orders_count = s.n
    FROM (SELECT COALESCE(sum(o.total_price), 0) AS total, count(*)::INT AS n
            FROM public.orders o
           WHERE o.customer_id = p_uid AND o.status <> 'cancelled') s
   WHERE c.id = p_uid;
END $$;
REVOKE ALL ON FUNCTION public.link_guest_orders(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- Provisioning. Idempotent on id; never reads privileges from metadata; refuses to share an
-- email with another account (unreachable while auth enforces unique emails and the email
-- sync below keeps customers.email in step with auth.users.email).
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email TEXT := lower(btrim(NEW.email));
BEGIN
  IF v_email IS NULL OR v_email = '' THEN RETURN NEW; END IF;        -- anonymous / phone-only users
  IF EXISTS (SELECT 1 FROM public.customers WHERE id = NEW.id) THEN RETURN NEW; END IF;  -- re-fired trigger
  IF EXISTS (SELECT 1 FROM public.customers WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION 'customer_email_conflict:%', v_email;
  END IF;
  INSERT INTO public.customers (id, email, first_name, last_name, phone, is_admin)
  VALUES (NEW.id, v_email,
          NULLIF(left(btrim(NEW.raw_user_meta_data ->> 'first_name'), 255), ''),
          NULLIF(left(btrim(NEW.raw_user_meta_data ->> 'last_name'), 255), ''),
          NULLIF(left(btrim(NEW.raw_user_meta_data ->> 'phone'), 50), ''),
          FALSE)                                    -- NEVER read privileges from metadata
  ON CONFLICT (id) DO NOTHING;
  IF NEW.email_confirmed_at IS NOT NULL THEN       -- projects with auto-confirm
    PERFORM public.link_guest_orders(NEW.id, v_email);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- Guest orders are linked when the address is PROVEN, not when it is typed.
CREATE OR REPLACE FUNCTION public.handle_user_confirmed() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL THEN
    PERFORM public.link_guest_orders(NEW.id, NEW.email);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.handle_user_confirmed() FROM PUBLIC, anon, authenticated;

-- Supabase changes auth.users.email only after the new address is confirmed ("secure email
-- change"). Follow it, so customers.email (pinned against the shopper) never drifts from the
-- login address and a later signup with the old address cannot hit customer_email_conflict.
-- An account that had no email before (anonymous sign-in upgraded to email) is provisioned here.
CREATE OR REPLACE FUNCTION public.handle_user_email_changed() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email TEXT := lower(btrim(NEW.email));
BEGIN
  IF v_email IS NULL OR v_email = '' OR v_email = lower(btrim(COALESCE(OLD.email, ''))) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers WHERE lower(email) = v_email AND id <> NEW.id) THEN
    RAISE EXCEPTION 'customer_email_conflict:%', v_email;
  END IF;
  PERFORM set_config('app.trusted_write', 'on', true);
  IF EXISTS (SELECT 1 FROM public.customers WHERE id = NEW.id) THEN
    UPDATE public.customers SET email = v_email WHERE id = NEW.id;
  ELSE
    INSERT INTO public.customers (id, email, first_name, last_name, phone, is_admin)
    VALUES (NEW.id, v_email,
            NULLIF(left(btrim(NEW.raw_user_meta_data ->> 'first_name'), 255), ''),
            NULLIF(left(btrim(NEW.raw_user_meta_data ->> 'last_name'), 255), ''),
            NULLIF(left(btrim(NEW.raw_user_meta_data ->> 'phone'), 50), ''),
            FALSE)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  IF NEW.email_confirmed_at IS NOT NULL THEN
    PERFORM public.link_guest_orders(NEW.id, v_email);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.handle_user_email_changed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
DROP TRIGGER IF EXISTS on_auth_user_confirmed ON auth.users;
CREATE TRIGGER on_auth_user_confirmed AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_user_confirmed();
DROP TRIGGER IF EXISTS on_auth_user_email_changed ON auth.users;
CREATE TRIGGER on_auth_user_email_changed AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_user_email_changed();

-- RLS is ROW-level. This pins the columns a customer must never edit on their own row.
-- Definer functions that legitimately change them set app.trusted_write for their transaction
-- (set_config(…, true)); a PostgREST client cannot set that GUC.
CREATE OR REPLACE FUNCTION public.pin_customer_identity_columns() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL
     OR current_setting('app.trusted_write', true) = 'on'
     OR public.is_admin() THEN
    RETURN NEW;
  END IF;
  NEW.id           := OLD.id;
  NEW.email        := OLD.email;
  NEW.is_admin     := OLD.is_admin;
  NEW.total_spent  := OLD.total_spent;
  NEW.orders_count := OLD.orders_count;
  NEW.note         := OLD.note;
  NEW.created_at   := OLD.created_at;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.pin_customer_identity_columns() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS pin_customer_identity ON public.customers;
CREATE TRIGGER pin_customer_identity BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.pin_customer_identity_columns();

-- RLS: a shopper reads/updates only their own row; admins everything. Nobody inserts or
-- deletes through the API (the signup trigger provisions; deleting the auth user cascades).
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customers FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.customers FROM authenticated;

DROP POLICY IF EXISTS customers_select_own ON public.customers;
CREATE POLICY customers_select_own ON public.customers
  FOR SELECT TO authenticated USING (id = auth.uid());
DROP POLICY IF EXISTS customers_update_own ON public.customers;
CREATE POLICY customers_update_own ON public.customers
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid() AND is_admin = FALSE);
DROP POLICY IF EXISTS customers_admin_all ON public.customers;
CREATE POLICY customers_admin_all ON public.customers
  FOR ALL TO authenticated USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()));

-- Backfill: accounts created before this migration (e.g. the owner signed up first).
INSERT INTO public.customers (id, email, is_admin)
SELECT u.id, lower(btrim(u.email)), FALSE
  FROM auth.users u
 WHERE u.email IS NOT NULL AND btrim(u.email) <> ''
   AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = u.id)
   AND NOT EXISTS (SELECT 1 FROM public.customers c WHERE lower(c.email) = lower(btrim(u.email)))
ON CONFLICT DO NOTHING;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 02_customers_and_auth
--   Do this or there is no admin: after the owner signs up through the storefront AND confirms
--   the email, promote them once in the SQL editor:
--     UPDATE public.customers SET is_admin = TRUE WHERE lower(email) = lower('<owner-email>');
--   Supabase Auth settings: enable "Confirm email" (guest orders link only to CONFIRMED
--   addresses) and configure custom SMTP before launch (built-in SMTP ≈ 2 emails/hour).
--   Verification:
--     SELECT tgname FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal;
--       -- on_auth_user_created, on_auth_user_confirmed, on_auth_user_email_changed
--     SELECT count(*) FROM auth.users u LEFT JOIN public.customers c ON c.id = u.id
--      WHERE u.email IS NOT NULL AND c.id IS NULL;                     -- 0
--     SELECT has_function_privilege('anon', 'public.is_admin()', 'EXECUTE');   -- false
--     SELECT has_function_privilege('anon', 'public.link_guest_orders(uuid,text)', 'EXECUTE'); -- false
-- ═════════════════════════════════════════════════════════════════════════════
