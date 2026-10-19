-- ═════════════════════════════════════════════════════════════════════════════
-- 39_staff_accounts.sql — Dock One Solutions
--
-- PURPOSE      Staff accounts with per-section access, created by the owner in admin → Staff.
--
--   ROLES      ADMIN  customers.is_admin = TRUE — everything, as before (the owner's account).
--              STAFF  a row in staff_accounts (active) — only the admin sections the owner ticked,
--                     each "view" or "edit". On top of that, whatever is ticked:
--                       * staff NEVER delete anything (no table DELETE, no delete RPC);
--                       * staff cannot void an invoice that has a payment / receipt (the void and
--                         back-to-draft functions refuse while a receipt is linked — 40);
--                       * supplier details and cost prices stay hidden unless "Suppliers" /
--                         "Cost prices" are ticked (restrictive policies, below and in 40/41);
--                       * financial reports (dashboard, reports) only when ticked.
--
--   HOW IT IS ENFORCED (in the database, not just the screens)
--              Every admin table policy and admin RPC already asks public.is_admin(). This file
--              redefines it:  is_admin() = is_full_admin()  OR  _staff_request_allowed().
--              _staff_request_allowed() looks at the API request PostgREST is serving
--              (request.path / request.method): the table or RPC being called is looked up in
--              staff_api_map (which admin section it belongs to and the level it needs) and
--              compared with the signed-in staff member's permissions. GET = view; POST / PATCH /
--              PUT = edit; DELETE = never for staff. An RPC needs the level listed for it; RPCs
--              listed 'admin' (deletions, settings) are never open to staff. Anything not in the
--              map is closed to staff. Outside an API request (SQL editor, jobs) only full
--              admins count.
--              Sensitive tables don't depend on the request path at all (restrictive policies):
--              product_costs / product_sourcing / variant_sourcing need "Cost prices".
--
--   staff_accounts              user_id, display name, permissions {section: 'view'|'edit'}, active
--   staff_api_map               (kind, name) → (area, view level, edit level); later files add rows
--   is_full_admin()             the owner flag only
--   staff_can(area, level)      TRUE for an admin, or active staff with at least that level
--   my_admin_access()           {role, name, email, permissions} for the signed-in viewer (admin UI)
--   admin_list_staff()          ADMIN ONLY — the staff list
--   admin_create_staff(email, password, name, permissions)    creates the sign-in (email + password,
--                               confirmed, no email sent) and the staff row
--   admin_update_staff(user_id, name, permissions, active)    (deactivating also blocks sign-in)
--   admin_set_staff_password(user_id, password)
--
-- DEPENDS ON   01 (pgcrypto in schema extensions), 02 (customers, is_admin), 04/34 (cost tables).
-- ERRORS       42501 not_authorised:… ; 22023 invalid_staff / staff_exists / staff_not_found /
--              weak_password:…
-- SAFE TO RE-RUN: yes (staff_api_map rows of THIS file are replaced; staff rows are kept).
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Tables
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.staff_accounts (
  user_id      UUID PRIMARY KEY REFERENCES public.customers (id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  permissions  JSONB NOT NULL DEFAULT '{}'::jsonb,         -- {"invoices": "edit", "inventory": "view", …}
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  updated_by   UUID REFERENCES public.customers (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT staff_accounts_name_valid CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 80),
  CONSTRAINT staff_accounts_permissions_valid CHECK (
        jsonb_typeof(permissions) = 'object'
    AND NOT jsonb_path_exists(permissions, '$.* ? (@ != "view" && @ != "edit")'))
);
DROP TRIGGER IF EXISTS staff_accounts_touch ON public.staff_accounts;
CREATE TRIGGER staff_accounts_touch BEFORE UPDATE ON public.staff_accounts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- Which admin section each API table / RPC belongs to. view_level / edit_level: 'view', 'edit' or
-- 'admin' (never staff). Tables: GET needs view_level, writes need edit_level. RPCs need edit_level.
CREATE TABLE IF NOT EXISTS public.staff_api_map (
  kind       TEXT NOT NULL,                 -- 'table' (also views) | 'rpc'
  name       TEXT NOT NULL,
  area       TEXT NOT NULL,
  view_level TEXT NOT NULL DEFAULT 'view',
  edit_level TEXT NOT NULL DEFAULT 'edit',
  migration  TEXT NOT NULL,
  PRIMARY KEY (kind, name, area),
  CONSTRAINT staff_api_map_kind_valid CHECK (kind IN ('table', 'rpc')),
  CONSTRAINT staff_api_map_levels_valid CHECK (view_level IN ('view', 'edit', 'admin') AND edit_level IN ('view', 'edit', 'admin'))
);

ALTER TABLE public.staff_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_api_map  ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_accounts, public.staff_api_map FROM anon, authenticated;
GRANT SELECT ON public.staff_accounts TO authenticated;          -- own row (and admins: all)
DROP POLICY IF EXISTS staff_accounts_read ON public.staff_accounts;
CREATE POLICY staff_accounts_read ON public.staff_accounts
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR COALESCE((SELECT c.is_admin FROM public.customers c WHERE c.id = auth.uid()), FALSE));

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The checks
-- ─────────────────────────────────────────────────────────────────────────────
-- The sections a permission may name (the admin tabs, plus "costs" = see cost prices).
CREATE OR REPLACE FUNCTION public._staff_area_keys()
RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT ARRAY['dashboard', 'orders', 'invoices', 'quotations', 'receipts', 'expenses', 'discounts',
               'abandoned-carts', 'reports', 'products', 'categories', 'collections', 'inventory',
               'suppliers', 'warranty', 'reviews', 'customers', 'inquiries', 'subscribers',
               'finder-insights', 'assistant-insights', 'homepage', 'content', 'settings', 'site-lock',
               'costs']
$$;
REVOKE ALL ON FUNCTION public._staff_area_keys() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.is_full_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT c.is_admin FROM public.customers c WHERE c.id = auth.uid()), FALSE)
$$;
REVOKE ALL ON FUNCTION public.is_full_admin() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_full_admin() TO authenticated;

-- The signed-in staff member's permissions (NULL: not staff, or switched off).
CREATE OR REPLACE FUNCTION public._staff_permissions() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.permissions FROM public.staff_accounts s WHERE s.user_id = auth.uid() AND s.is_active
$$;
REVOKE ALL ON FUNCTION public._staff_permissions() FROM PUBLIC, anon, authenticated;

-- 'edit' ≥ 'view'; 'admin' is never met by staff.
CREATE OR REPLACE FUNCTION public._staff_level_ok(p_have TEXT, p_need TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE p_need WHEN 'view' THEN p_have IN ('view', 'edit')
                     WHEN 'edit' THEN p_have = 'edit'
                     ELSE FALSE END
$$;
REVOKE ALL ON FUNCTION public._staff_level_ok(TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- An admin, or active staff with at least p_level on p_area.
CREATE OR REPLACE FUNCTION public.staff_can(p_area TEXT, p_level TEXT DEFAULT 'view') RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.is_full_admin()
      OR COALESCE(public._staff_level_ok(public._staff_permissions() ->> p_area, p_level), FALSE)
$$;
REVOKE ALL ON FUNCTION public.staff_can(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.staff_can(TEXT, TEXT) TO authenticated;

-- May the signed-in staff member make THIS API request? (see the header)
CREATE OR REPLACE FUNCTION public._staff_request_allowed() RETURNS BOOLEAN
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_perms  JSONB;
  v_path   TEXT := COALESCE(current_setting('request.path', true), '');
  v_method TEXT := upper(COALESCE(current_setting('request.method', true), ''));
  v_kind   TEXT;
  v_name   TEXT;
  r        RECORD;
BEGIN
  IF v_path = '' OR auth.uid() IS NULL THEN
    RETURN FALSE;
  END IF;
  v_perms := public._staff_permissions();
  IF v_perms IS NULL THEN
    RETURN FALSE;
  END IF;
  IF v_path ~ '/rpc/[A-Za-z0-9_]+/?$' THEN
    v_kind := 'rpc';
    v_name := substring(v_path FROM '/rpc/([A-Za-z0-9_]+)/?$');
  ELSE
    IF v_method = 'DELETE' THEN
      RETURN FALSE;                                          -- staff never delete
    END IF;
    v_kind := 'table';
    v_name := substring(regexp_replace(v_path, '^/rest/v1', '') FROM '^/([A-Za-z0-9_]+)');
  END IF;
  IF v_name IS NULL THEN
    RETURN FALSE;
  END IF;
  FOR r IN SELECT m.area, m.view_level, m.edit_level FROM public.staff_api_map m WHERE m.kind = v_kind AND m.name = v_name LOOP
    IF public._staff_level_ok(v_perms ->> r.area,
                              CASE WHEN v_kind = 'table' AND v_method IN ('GET', 'HEAD') THEN r.view_level ELSE r.edit_level END) THEN
      RETURN TRUE;
    END IF;
  END LOOP;
  RETURN FALSE;
END $$;
REVOKE ALL ON FUNCTION public._staff_request_allowed() FROM PUBLIC, anon, authenticated;

-- The gate every admin policy and RPC already uses — now staff-aware (see the header).
CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT public.is_full_admin() OR public._staff_request_allowed()
$$;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;

-- Only an admin changes who is an admin (staff with Customers → edit must not promote anyone).
CREATE OR REPLACE FUNCTION public._customers_admin_flag_guard() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.is_admin IS DISTINCT FROM OLD.is_admin AND auth.uid() IS NOT NULL
     AND current_setting('app.trusted_write', true) IS DISTINCT FROM 'on'
     AND public._staff_request_allowed() AND NOT public.is_full_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can change who is an admin.';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._customers_admin_flag_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS customers_05_admin_flag_guard ON public.customers;
CREATE TRIGGER customers_05_admin_flag_guard BEFORE UPDATE OF is_admin ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public._customers_admin_flag_guard();

-- Cost prices: an admin, or staff with "Cost prices", whatever the request (embeds included).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_costs', 'product_sourcing', 'variant_sourcing'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_costs_only', t);
      EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated
                        USING (public.staff_can(''costs'', ''view'')) WITH CHECK (public.staff_can(''costs'', ''edit''))',
                     t || '_costs_only', t);
    END IF;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The section map (this file's rows; later files add theirs)
-- ─────────────────────────────────────────────────────────────────────────────
DELETE FROM public.staff_api_map WHERE migration = '39';
INSERT INTO public.staff_api_map (kind, name, area, view_level, edit_level, migration)
SELECT k, n, a, v, e, '39'
  FROM (VALUES
    -- tables / views (GET = view level; POST/PATCH = edit level; DELETE never)
    ('table', 'orders',                 'orders',            'view', 'edit'),
    ('table', 'orders',                 'customers',         'view', 'admin'),
    ('table', 'orders',                 'reports',           'view', 'admin'),
    ('table', 'orders',                 'invoices',          'view', 'admin'),
    ('table', 'order_items',            'orders',            'view', 'edit'),
    ('table', 'order_items',            'customers',         'view', 'admin'),
    ('table', 'order_items',            'reports',           'view', 'admin'),
    ('table', 'order_items',            'invoices',          'view', 'admin'),
    ('table', 'order_tracking',         'orders',            'view', 'edit'),
    ('table', 'customers',              'customers',         'view', 'edit'),
    ('table', 'wishlists',              'customers',         'view', 'admin'),
    ('table', 'store_settings',         'settings',          'view', 'edit'),
    ('table', 'store_settings',         'orders',            'view', 'admin'),
    ('table', 'store_settings',         'invoices',          'view', 'admin'),
    ('table', 'products',               'products',          'view', 'edit'),
    ('table', 'products',               'reviews',           'view', 'admin'),
    ('table', 'products',               'inventory',         'view', 'admin'),
    ('table', 'product_variants',       'products',          'view', 'edit'),
    ('table', 'product_variants',       'inventory',         'view', 'admin'),
    ('table', 'product_costs',          'products',          'view', 'edit'),
    ('table', 'product_units',          'products',          'view', 'admin'),
    ('table', 'product_units',          'inventory',         'view', 'admin'),
    ('table', 'product_units',          'invoices',          'view', 'admin'),
    ('table', 'product_units',          'orders',            'view', 'admin'),
    ('table', 'admin_product_list',     'products',          'view', 'admin'),
    ('table', 'admin_product_list',     'collections',       'view', 'admin'),
    ('table', 'admin_product_list',     'homepage',          'view', 'admin'),
    ('table', 'admin_product_list',     'categories',        'view', 'admin'),
    ('table', 'admin_inventory',        'inventory',         'view', 'admin'),
    ('table', 'admin_inventory',        'products',          'view', 'admin'),
    ('table', 'inventory',              'inventory',         'view', 'edit'),
    ('table', 'inventory',              'products',          'view', 'edit'),
    ('table', 'categories',             'categories',        'view', 'edit'),
    ('table', 'collections',            'collections',       'view', 'edit'),
    ('table', 'product_collections',    'collections',       'view', 'edit'),
    ('table', 'product_reviews',        'reviews',           'view', 'edit'),
    ('table', 'discounts',              'discounts',         'view', 'edit'),
    ('table', 'abandoned_carts',        'abandoned-carts',   'view', 'edit'),
    ('table', 'contact_inquiries',      'inquiries',         'view', 'edit'),
    ('table', 'newsletter_subscribers', 'subscribers',       'view', 'edit'),
    ('table', 'hero_slides',            'homepage',          'view', 'edit'),
    ('table', 'promo_tiles',            'homepage',          'view', 'edit'),
    ('table', 'content_blocks',         'homepage',          'view', 'edit'),
    ('table', 'cms_pages',              'content',           'view', 'edit'),
    ('table', 'blog_posts',             'content',           'view', 'edit'),
    ('table', 'expenses',               'expenses',          'view', 'edit'),
    ('table', 'expense_categories',     'expenses',          'view', 'edit'),
    ('table', 'invoices',               'invoices',          'view', 'admin'),
    ('table', 'invoice_items',          'invoices',          'view', 'admin'),
    ('table', 'invoice_payments',       'invoices',          'view', 'admin'),
    ('table', 'invoice_settings',       'invoices',          'view', 'admin'),
    ('table', 'stock_movements',        'inventory',         'view', 'admin'),
    ('table', 'stock_movements',        'reports',           'view', 'admin'),
    -- RPCs (need edit_level)
    ('rpc', 'admin_sales_overview',          'dashboard',          'view', 'view'),
    ('rpc', 'admin_sales_overview',          'reports',            'view', 'view'),
    ('rpc', 'admin_funnel',                  'dashboard',          'view', 'view'),
    ('rpc', 'admin_top_products',            'dashboard',          'view', 'view'),
    ('rpc', 'admin_search_terms',            'dashboard',          'view', 'view'),
    ('rpc', 'admin_low_stock',               'dashboard',          'view', 'view'),
    ('rpc', 'admin_low_stock',               'inventory',          'view', 'view'),
    ('rpc', 'admin_recovery_stats',          'dashboard',          'view', 'view'),
    ('rpc', 'admin_recovery_stats',          'abandoned-carts',    'view', 'view'),
    ('rpc', 'admin_newsletter_growth',       'dashboard',          'view', 'view'),
    ('rpc', 'admin_newsletter_growth',       'subscribers',        'view', 'view'),
    ('rpc', 'admin_order_status_counts',     'dashboard',          'view', 'view'),
    ('rpc', 'admin_order_status_counts',     'orders',             'view', 'view'),
    ('rpc', 'admin_assistant_overview',      'dashboard',          'view', 'view'),
    ('rpc', 'admin_assistant_overview',      'assistant-insights', 'view', 'view'),
    ('rpc', 'admin_assistant_sessions',      'assistant-insights', 'view', 'view'),
    ('rpc', 'admin_assistant_transcript',    'assistant-insights', 'view', 'view'),
    ('rpc', 'admin_finder_insights',         'finder-insights',    'view', 'view'),
    ('rpc', 'admin_offer_performance',       'discounts',          'view', 'view'),
    ('rpc', 'admin_newsletter_mailing_list', 'subscribers',        'view', 'view'),
    ('rpc', 'admin_set_order_status',        'orders',             'view', 'edit'),
    ('rpc', 'admin_set_payment_status',      'orders',             'view', 'edit'),
    ('rpc', 'admin_assign_order_serials',    'orders',             'view', 'edit'),
    ('rpc', 'admin_reorder_hero_slides',     'homepage',           'view', 'edit'),
    ('rpc', 'admin_set_featured_collections','homepage',           'view', 'edit'),
    ('rpc', 'admin_save_product',            'products',           'view', 'edit'),
    ('rpc', 'admin_set_product_serials',     'products',           'view', 'edit'),
    ('rpc', 'admin_set_collection_products', 'collections',        'view', 'edit'),
    ('rpc', 'admin_save_invoice',            'invoices',           'view', 'edit'),
    ('rpc', 'admin_save_invoice_sale',       'invoices',           'view', 'edit'),
    ('rpc', 'admin_issue_invoice',           'invoices',           'view', 'edit'),
    ('rpc', 'admin_revert_invoice',          'invoices',           'view', 'edit'),
    ('rpc', 'admin_void_invoice',            'invoices',           'view', 'edit'),
    ('rpc', 'admin_record_invoice_payment',  'invoices',           'view', 'edit'),
    ('rpc', 'admin_delete_invoice',          'invoices',           'view', 'admin'),
    ('rpc', 'admin_delete_invoice_payment',  'invoices',           'view', 'admin'),
    ('rpc', 'admin_invoice_product_search',  'invoices',           'view', 'view'),
    ('rpc', 'admin_invoice_client_search',   'invoices',           'view', 'view'),
    ('rpc', 'admin_invoice_summary',         'invoices',           'view', 'view'),
    ('rpc', 'admin_invoice_due_alerts',      'invoices',           'view', 'view'),
    ('rpc', 'admin_expense_summary',         'expenses',           'view', 'view'),
    ('rpc', 'admin_inventory_value_report',  'reports',            'view', 'view'),
    ('rpc', 'admin_stock_movement_report',   'reports',            'view', 'view'),
    ('rpc', 'admin_stock_movement_history',  'reports',            'view', 'view'),
    ('rpc', 'admin_stock_report_options',    'reports',            'view', 'view'),
    ('rpc', 'admin_stock_report_options',    'inventory',          'view', 'edit'),
    ('rpc', 'admin_record_stock_movement',   'inventory',          'view', 'edit'),
    ('rpc', 'admin_site_lock_state',         'site-lock',          'view', 'view'),
    ('rpc', 'admin_site_lock_token',         'site-lock',          'view', 'edit'),
    ('rpc', 'set_site_lock',                 'site-lock',          'view', 'edit')
  ) AS m(k, n, a, v, e);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Who am I (the admin screens)
-- ─────────────────────────────────────────────────────────────────────────────
-- {role: 'admin' | 'staff' | null, user_id, email, name, permissions}
CREATE OR REPLACE FUNCTION public.my_admin_access()
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
           'role', CASE WHEN c.is_admin THEN 'admin' WHEN s.is_active THEN 'staff' END,
           'user_id', c.id,
           'email', c.email,
           'name', COALESCE(s.display_name, NULLIF(btrim(concat_ws(' ', c.first_name, c.last_name)), ''), c.email),
           'permissions', CASE WHEN c.is_admin THEN '{}'::jsonb WHEN s.is_active THEN s.permissions ELSE '{}'::jsonb END)
    FROM public.customers c
    LEFT JOIN public.staff_accounts s ON s.user_id = c.id
   WHERE c.id = auth.uid()
$$;
REVOKE ALL ON FUNCTION public.my_admin_access() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.my_admin_access() TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Managing staff (admins only)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._staff_require_admin() RETURNS VOID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT public.is_full_admin() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'not_authorised:Only an admin can manage staff accounts.';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._staff_require_admin() FROM PUBLIC, anon, authenticated;

-- A permissions object: only known sections, only 'view' / 'edit' ('none' and null drop the key).
CREATE OR REPLACE FUNCTION public._staff_clean_permissions(p_value JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  v_out JSONB := '{}'::jsonb;
  r     RECORD;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
    RETURN v_out;
  END IF;
  IF jsonb_typeof(p_value) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_staff:Permissions must be an object of section → view / edit.';
  END IF;
  FOR r IN SELECT key, value FROM jsonb_each(p_value) LOOP
    IF NOT (r.key = ANY (public._staff_area_keys())) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_staff:Unknown section “%s”.', left(r.key, 40));
    END IF;
    IF jsonb_typeof(r.value) = 'string' AND r.value #>> '{}' IN ('view', 'edit') THEN
      v_out := v_out || jsonb_build_object(r.key, r.value #>> '{}');
    ELSIF jsonb_typeof(r.value) = 'null' OR r.value #>> '{}' IN ('none', '') THEN
      CONTINUE;
    ELSE
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = format('invalid_staff:“%s” must be view, edit or none.', left(r.key, 40));
    END IF;
  END LOOP;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public._staff_clean_permissions(JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._staff_check_password(p_password TEXT) RETURNS VOID
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF p_password IS NULL OR char_length(p_password) < 8 OR char_length(p_password) > 72 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'weak_password:The password must be 8 to 72 characters.';
  END IF;
  IF p_password !~ '[A-Za-z]' OR p_password !~ '[0-9]' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'weak_password:Use at least one letter and one number in the password.';
  END IF;
END $$;
REVOKE ALL ON FUNCTION public._staff_check_password(TEXT) FROM PUBLIC, anon, authenticated;

-- Creates a confirmed email + password sign-in (Supabase Auth tables). Works with the columns the
-- project's auth schema has (GoTrue needs its token columns to be '' rather than NULL).
CREATE OR REPLACE FUNCTION public._auth_create_user(p_email TEXT, p_password TEXT, p_meta JSONB)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
DECLARE
  v_id    UUID := gen_random_uuid();
  v_hash  TEXT := extensions.crypt(p_password, extensions.gen_salt('bf', 10));
  v_col   TEXT;
  v_has_provider_id BOOLEAN;
  v_id_type TEXT;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  VALUES (v_id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', p_email, v_hash, now(),
          '{"provider": "email", "providers": ["email"]}'::jsonb, COALESCE(p_meta, '{}'::jsonb), now(), now());
  FOREACH v_col IN ARRAY ARRAY['confirmation_token', 'recovery_token', 'email_change_token_new', 'email_change',
                               'email_change_token_current', 'phone_change', 'phone_change_token', 'reauthentication_token'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = v_col
                  AND is_generated = 'NEVER') THEN
      EXECUTE format('UPDATE auth.users SET %I = COALESCE(%I, '''') WHERE id = $1', v_col, v_col) USING v_id;
    END IF;
  END LOOP;
  IF to_regclass('auth.identities') IS NOT NULL THEN
    v_has_provider_id := EXISTS (SELECT 1 FROM information_schema.columns
                                  WHERE table_schema = 'auth' AND table_name = 'identities' AND column_name = 'provider_id');
    SELECT data_type INTO v_id_type FROM information_schema.columns
     WHERE table_schema = 'auth' AND table_name = 'identities' AND column_name = 'id';
    IF v_has_provider_id THEN
      EXECUTE format('INSERT INTO auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
                      VALUES (%s, $1::text, $1, $2, ''email'', now(), now(), now())',
                     CASE WHEN v_id_type = 'uuid' THEN 'gen_random_uuid()' ELSE '$1::text' END)
        USING v_id, jsonb_build_object('sub', v_id::text, 'email', p_email, 'email_verified', TRUE);
    ELSE
      EXECUTE 'INSERT INTO auth.identities (id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
               VALUES ($1::text, $1, $2, ''email'', now(), now(), now())'
        USING v_id, jsonb_build_object('sub', v_id::text, 'email', p_email);
    END IF;
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public._auth_create_user(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

-- [{user_id, email, name, permissions, is_active, last_sign_in_at, created_at}] (newest first)
CREATE OR REPLACE FUNCTION public.admin_list_staff()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_out JSONB;
BEGIN
  PERFORM public._staff_require_admin();
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'user_id', s.user_id, 'email', c.email, 'name', s.display_name, 'permissions', s.permissions,
           'is_active', s.is_active, 'last_sign_in_at', u.last_sign_in_at, 'created_at', s.created_at)
         ORDER BY s.is_active DESC, s.created_at DESC), '[]'::jsonb)
    INTO v_out
    FROM public.staff_accounts s
    JOIN public.customers c ON c.id = s.user_id
    LEFT JOIN auth.users u ON u.id = s.user_id;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.admin_list_staff() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_staff() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_create_staff(p_email TEXT, p_password TEXT, p_name TEXT, p_permissions JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_email TEXT := lower(btrim(COALESCE(p_email, '')));
  v_name  TEXT := btrim(COALESCE(p_name, ''));
  v_perms JSONB;
  v_id    UUID;
BEGIN
  PERFORM public._staff_require_admin();
  IF char_length(v_email) > 254 OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_staff:Enter a valid email address.';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_staff:Enter the staff member''s name (up to 80 characters).';
  END IF;
  PERFORM public._staff_check_password(p_password);
  v_perms := public._staff_clean_permissions(p_permissions);
  IF EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = v_email)
     OR EXISTS (SELECT 1 FROM public.customers c WHERE lower(c.email) = v_email) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'staff_exists:An account with that email already exists. Use a different email for the staff login.';
  END IF;
  v_id := public._auth_create_user(v_email, p_password, jsonb_build_object('first_name', v_name));
  IF NOT EXISTS (SELECT 1 FROM public.customers c WHERE c.id = v_id) THEN   -- the signup trigger normally adds it
    INSERT INTO public.customers (id, email, first_name) VALUES (v_id, v_email, v_name);
  END IF;
  INSERT INTO public.staff_accounts (user_id, display_name, permissions, created_by, updated_by)
  VALUES (v_id, v_name, v_perms, auth.uid(), auth.uid());
  RETURN jsonb_build_object('user_id', v_id, 'email', v_email, 'name', v_name, 'permissions', v_perms, 'is_active', TRUE);
END $$;
REVOKE ALL ON FUNCTION public.admin_create_staff(TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_staff(TEXT, TEXT, TEXT, JSONB) TO authenticated;

-- NULL arguments keep the current value. Switching a staff member off also blocks their sign-in.
CREATE OR REPLACE FUNCTION public.admin_update_staff(p_user_id UUID, p_name TEXT DEFAULT NULL, p_permissions JSONB DEFAULT NULL, p_active BOOLEAN DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s      public.staff_accounts;
  v_name TEXT := NULLIF(btrim(COALESCE(p_name, '')), '');
BEGIN
  PERFORM public._staff_require_admin();
  SELECT * INTO s FROM public.staff_accounts WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'staff_not_found:That staff account no longer exists.';
  END IF;
  IF v_name IS NOT NULL AND char_length(v_name) > 80 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid_staff:The name can be at most 80 characters.';
  END IF;
  UPDATE public.staff_accounts
     SET display_name = COALESCE(v_name, display_name),
         permissions  = CASE WHEN p_permissions IS NULL THEN permissions ELSE public._staff_clean_permissions(p_permissions) END,
         is_active    = COALESCE(p_active, is_active),
         updated_by   = auth.uid()
   WHERE user_id = p_user_id
  RETURNING * INTO s;
  IF p_active IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns
                                       WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'banned_until') THEN
    EXECUTE 'UPDATE auth.users SET banned_until = $2 WHERE id = $1'
      USING p_user_id, CASE WHEN p_active THEN NULL ELSE 'infinity'::timestamptz END;
  END IF;
  RETURN jsonb_build_object('user_id', s.user_id, 'name', s.display_name, 'permissions', s.permissions, 'is_active', s.is_active);
END $$;
REVOKE ALL ON FUNCTION public.admin_update_staff(UUID, TEXT, JSONB, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_staff(UUID, TEXT, JSONB, BOOLEAN) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_staff_password(p_user_id UUID, p_password TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp AS $$
BEGIN
  PERFORM public._staff_require_admin();
  IF NOT EXISTS (SELECT 1 FROM public.staff_accounts s WHERE s.user_id = p_user_id) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'staff_not_found:That staff account no longer exists.';
  END IF;
  PERFORM public._staff_check_password(p_password);
  UPDATE auth.users SET encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), updated_at = now()
   WHERE id = p_user_id;
  RETURN jsonb_build_object('user_id', p_user_id, 'password_changed', TRUE);
END $$;
REVOKE ALL ON FUNCTION public.admin_set_staff_password(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_staff_password(UUID, TEXT) TO authenticated;

-- 38's "recorded by" names staff as well as admins.
CREATE OR REPLACE FUNCTION public._stock_actor()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id FROM public.customers c
   WHERE c.id = auth.uid()
     AND (c.is_admin OR EXISTS (SELECT 1 FROM public.staff_accounts s WHERE s.user_id = c.id AND s.is_active))
$$;
REVOKE ALL ON FUNCTION public._stock_actor() FROM PUBLIC, anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 39_staff_accounts
--   Run after 01–38. Nothing changes for the owner's account (customers.is_admin = TRUE).
--   Add staff in admin → Staff: name, email, password and the sections they may view or edit.
--   Staff sign in at /admin/signin like the owner. Deactivating an account blocks sign-in.
--   If you re-run 02_customers_and_auth.sql, run 39 again afterwards (02 redefines is_admin()).
--   Verification:
--     SELECT count(*) FROM public.staff_api_map;                                  -- > 100
--     SELECT has_function_privilege('anon', 'public.admin_create_staff(text,text,text,jsonb)', 'EXECUTE');  -- false
--     SELECT u.email, s.display_name, s.permissions, s.is_active
--       FROM public.staff_accounts s JOIN auth.users u ON u.id = s.user_id;
-- ═════════════════════════════════════════════════════════════════════════════
