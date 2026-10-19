-- 39_staff_accounts.test.sql — staff accounts: creation (sign-in rows, hashed password), who may
-- manage them, my_admin_access, and the request-path enforcement of section permissions (view vs
-- edit, no DELETE, admin-only RPCs, nothing outside an API request), the admin-flag guard, cost
-- prices, deactivation and password changes.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);

-- an API request as seen by PostgREST
CREATE FUNCTION pg_temp.req(p_method text, p_path text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.method', p_method, false), set_config('request.path', p_path, false)
$$;
CREATE FUNCTION pg_temp.noreq() RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.method', '', false), set_config('request.path', '', false)
$$;

-- ── 1. creating staff ───────────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_create_staff('x@shop.test', 'abcdefg1', 'X')$$, '42501', 'a shopper cannot create staff', 'not_authorised:%');
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.admin_create_staff('x@shop.test', 'abcdefg1', 'X')$$, '42501', 'anon cannot even call it');

SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws($$SELECT public.admin_create_staff('nimal@shop.test', 'short1', 'Nimal')$$, '22023', 'a short password', 'weak_password:%');
SELECT pg_temp.throws($$SELECT public.admin_create_staff('nimal@shop.test', 'onlyletters', 'Nimal')$$, '22023', 'a password without a number', 'weak_password:%');
SELECT pg_temp.throws($$SELECT public.admin_create_staff('not-an-email', 'abcdefg1', 'Nimal')$$, '22023', 'a bad email', 'invalid_staff:%');
SELECT pg_temp.throws($$SELECT public.admin_create_staff('nimal@shop.test', 'abcdefg1', 'Nimal', '{"payroll": "edit"}')$$, '22023', 'an unknown section', 'invalid_staff:Unknown section%');
SELECT pg_temp.throws($$SELECT public.admin_create_staff('shopper@shop.test', 'abcdefg1', 'Dup')$$, '22023', 'an email that already has an account', 'staff_exists:%');
SELECT set_config('t.r', public.admin_create_staff('  Nimal@Shop.test ', 'Counter2026', 'Nimal Perera',
  '{"invoices": "edit", "inventory": "view", "customers": "edit", "orders": "none", "products": "view"}')::text, false);
SELECT set_config('t.staff', current_setting('t.r')::jsonb ->> 'user_id', false);
SELECT pg_temp.eq(current_setting('t.r')::jsonb -> 'permissions', '{"invoices": "edit", "inventory": "view", "customers": "edit", "products": "view"}'::jsonb,
                  '"none" drops a section; the rest are kept');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT email FROM auth.users WHERE id = current_setting('t.staff')::uuid), 'nimal@shop.test', 'the sign-in uses the trimmed, lower-case email');
SELECT pg_temp.ok((SELECT encrypted_password = extensions.crypt('Counter2026', encrypted_password) AND email_confirmed_at IS NOT NULL
                     FROM auth.users WHERE id = current_setting('t.staff')::uuid), 'the password is stored hashed (bcrypt) and the email confirmed');
SELECT pg_temp.eq((SELECT format('%s|%s', is_admin, email) FROM public.customers WHERE id = current_setting('t.staff')::uuid), 'f|nimal@shop.test',
                  'a customers row exists and is NOT an admin');

-- ── 2. who am I ─────────────────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.staff')::uuid);
SELECT pg_temp.eq((SELECT format('%s|%s', a ->> 'role', a ->> 'name') FROM (SELECT public.my_admin_access() AS a) x), 'staff|Nimal Perera', 'staff see their role and name');
SELECT pg_temp.eq(public.my_admin_access() -> 'permissions' ->> 'invoices', 'edit', 'and their permissions');
SELECT pg_temp.eq((SELECT count(*) FROM public.staff_accounts), 1::bigint, 'staff read only their own staff row');
SELECT pg_temp.throws($$SELECT public.admin_list_staff()$$, '42501', 'staff cannot list staff', 'not_authorised:%');
SELECT pg_temp.throws(format($$SELECT public.admin_update_staff(%L, NULL, '{"reports": "edit"}')$$, current_setting('t.staff')), '42501',
                      'staff cannot raise their own permissions', 'not_authorised:%');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(public.my_admin_access() ->> 'role', 'admin', 'the owner is the admin');
SELECT pg_temp.eq(jsonb_array_length(public.admin_list_staff()), 1, 'the admin lists the staff');

-- ── 3. section permissions are enforced per request ─────────────────────────
SELECT pg_temp.logout();
INSERT INTO public.expense_categories (name) VALUES ('Staff test category') ON CONFLICT DO NOTHING;
INSERT INTO public.discounts (code, title, kind, value) VALUES ('STAFFTEST', 'Staff test', 'percentage', 5);
SELECT pg_temp.login(current_setting('t.staff')::uuid);
SELECT pg_temp.noreq();
SELECT pg_temp.ok(NOT public.is_admin(), 'outside an API request staff are never admins');
SELECT pg_temp.req('GET', '/expense_categories');
SELECT pg_temp.eq((SELECT count(*) FROM public.expense_categories), 0::bigint, 'a section that is not granted shows nothing (expenses)');
SELECT pg_temp.req('GET', '/customers');
SELECT pg_temp.ok((SELECT count(*) FROM public.customers) >= 3, 'a granted section is readable (customers)');
SELECT pg_temp.req('GET', '/inventory');
SELECT pg_temp.ok(public.is_admin(), 'inventory: view granted');
SELECT pg_temp.req('PATCH', '/inventory');
SELECT pg_temp.ok(NOT public.is_admin(), 'inventory: view only, so no writes');
SELECT pg_temp.req('PATCH', '/customers');
SELECT pg_temp.ok(public.is_admin(), 'customers: edit granted');
SELECT pg_temp.throws(format($$UPDATE public.customers SET is_admin = TRUE WHERE id = %L$$, current_setting('t.staff')), '42501',
                      'but staff can never make anyone an admin', 'not_authorised:Only an admin can change who is an admin.');
SELECT pg_temp.req('DELETE', '/customers');
SELECT pg_temp.ok(NOT public.is_admin(), 'staff never DELETE, whatever they may edit');
SELECT pg_temp.req('POST', '/rpc/admin_save_invoice');
SELECT pg_temp.ok(public.is_admin(), 'an RPC of a granted section (invoices: edit)');
SELECT pg_temp.req('POST', '/rpc/admin_delete_invoice');
SELECT pg_temp.ok(NOT public.is_admin(), 'deleting an invoice is admin-only');
SELECT pg_temp.req('POST', '/rpc/admin_sales_overview');
SELECT pg_temp.throws($$SELECT public.admin_sales_overview(current_date - 7, current_date)$$, '42501', 'financial figures need Dashboard / Reports');
SELECT pg_temp.req('POST', '/rpc/unknown_function');
SELECT pg_temp.ok(NOT public.is_admin(), 'anything not in the map is closed to staff');
SELECT pg_temp.req('GET', '/rest/v1/customers');
SELECT pg_temp.ok(public.is_admin(), 'a gateway prefix on the path is understood');

-- cost prices: never through another section's request
SELECT pg_temp.logout();
INSERT INTO public.categories (id, name) VALUES ('st-cat', 'Staff tests');
INSERT INTO public.products (slug, brand, name, category_id) VALUES ('st-thing', 'StBrand', 'Thing', 'st-cat');
INSERT INTO public.product_variants (product_id, name, price) SELECT id, 'Standard', 1000 FROM public.products WHERE slug = 'st-thing';
INSERT INTO public.product_costs (variant_id, cost_price) SELECT v.id, 600 FROM public.product_variants v JOIN public.products p ON p.id = v.product_id WHERE p.slug = 'st-thing';
SELECT pg_temp.login(current_setting('t.staff')::uuid);
SELECT pg_temp.req('GET', '/product_costs');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_costs), 0::bigint, 'products: view, but no "Cost prices" → no costs');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_update_staff(current_setting('t.staff')::uuid, NULL,
  '{"invoices": "edit", "inventory": "view", "customers": "edit", "products": "view", "costs": "view"}');
SELECT pg_temp.login(current_setting('t.staff')::uuid);
SELECT pg_temp.req('GET', '/product_costs');
SELECT pg_temp.ok((SELECT count(*) FROM public.product_costs) >= 1, 'with "Cost prices" they are visible');
SELECT pg_temp.req('PATCH', '/product_costs');
SELECT pg_temp.eq(pg_temp.affected('UPDATE public.product_costs SET cost_price = 1'), 0::bigint, 'but view is not edit');

-- ── 4. switching staff off, passwords ───────────────────────────────────────
SELECT pg_temp.noreq();
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws(format($$SELECT public.admin_set_staff_password(%L, 'abc')$$, current_setting('t.staff')), '22023', 'a weak new password', 'weak_password:%');
SELECT public.admin_set_staff_password(current_setting('t.staff')::uuid, 'NewPass2026');
SELECT public.admin_update_staff(current_setting('t.staff')::uuid, 'Nimal P.', NULL, FALSE);
SELECT pg_temp.logout();
SELECT pg_temp.ok((SELECT encrypted_password = extensions.crypt('NewPass2026', encrypted_password) AND banned_until = 'infinity'
                     FROM auth.users WHERE id = current_setting('t.staff')::uuid), 'new password set; switched off = sign-in blocked');
SELECT pg_temp.login(current_setting('t.staff')::uuid);
SELECT pg_temp.req('GET', '/customers');
SELECT pg_temp.ok(NOT public.is_admin() AND public.my_admin_access() ->> 'role' IS NULL, 'a switched-off account has no access at all');
SELECT pg_temp.noreq();
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.admin_update_staff(current_setting('t.staff')::uuid, NULL, NULL, TRUE);
SELECT pg_temp.logout();
SELECT pg_temp.ok((SELECT banned_until IS NULL FROM auth.users WHERE id = current_setting('t.staff')::uuid), 'switched on again');
SELECT pg_temp.eq((SELECT display_name FROM public.staff_accounts WHERE user_id = current_setting('t.staff')::uuid), 'Nimal P.', 'renamed');
