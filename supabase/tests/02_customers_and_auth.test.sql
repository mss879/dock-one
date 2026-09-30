-- 02_customers_and_auth.test.sql — provisioning, admin flag, pinned columns, owner RLS,
-- email-conflict, email-change sync, confirmation-gated guest-order linking (+ its guard).
\ir _helpers.sql

-- fixtures -------------------------------------------------------------------
SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test', TRUE, '{"first_name":"Olive"}')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.gia', pg_temp.new_user('Gia@Shop.Test', FALSE,
  '{"first_name":"  Gia ","last_name":"Guest","phone":"0771234567","is_admin":true}')::text, false);
SELECT set_config('t.sam', pg_temp.new_user('sam@shop.test')::text, false);

-- ── provisioning ─────────────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT email FROM public.customers WHERE id = current_setting('t.gia')::uuid), 'gia@shop.test',
                  'signup provisions a customers row with the email lower-cased');
SELECT pg_temp.eq((SELECT first_name || '|' || last_name || '|' || phone FROM public.customers WHERE id = current_setting('t.gia')::uuid),
                  'Gia|Guest|0771234567', 'names and phone come from signup metadata (trimmed)');
SELECT pg_temp.eq((SELECT is_admin FROM public.customers WHERE id = current_setting('t.gia')::uuid), FALSE,
                  'metadata {"is_admin":true} does NOT grant admin');
SELECT pg_temp.eq((SELECT country FROM public.customers WHERE id = current_setting('t.gia')::uuid), 'Sri Lanka',
                  'country defaults to Sri Lanka');
SELECT pg_temp.eq((SELECT total_spent::text || '/' || orders_count FROM public.customers WHERE id = current_setting('t.gia')::uuid),
                  '0.00/0', 'rollups start at zero');
INSERT INTO auth.users (id, email, is_anonymous) VALUES ('00000000-0000-0000-0000-0000000000aa', NULL, TRUE);
SELECT pg_temp.eq((SELECT count(*) FROM public.customers WHERE id = '00000000-0000-0000-0000-0000000000aa'), 0::bigint,
                  'an anonymous (email-less) auth user gets no customers row');

-- ── is_admin() ───────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT public.is_admin()', '42501', 'anon cannot call is_admin() (no probing)');
SELECT pg_temp.login(current_setting('t.gia')::uuid);
SELECT pg_temp.eq(public.is_admin(), FALSE, 'is_admin() is false for a shopper');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(public.is_admin(), TRUE, 'is_admin() is true for the promoted owner');

-- ── RLS ──────────────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT * FROM public.customers', '42501', 'anon cannot read customers at all');
SELECT pg_temp.throws($$INSERT INTO public.customers (id, email) VALUES (gen_random_uuid(), 'x@y.z')$$, '42501', 'anon cannot insert customers');
SELECT pg_temp.throws($$UPDATE public.customers SET note = 'x'$$, '42501', 'anon cannot update customers');
SELECT pg_temp.throws($$DELETE FROM public.customers$$, '42501', 'anon cannot delete customers');

SELECT pg_temp.login(current_setting('t.gia')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.customers), 1::bigint, 'a shopper sees only their own row');
SELECT pg_temp.eq((SELECT id FROM public.customers), current_setting('t.gia')::uuid, '…and it is theirs');
SELECT pg_temp.throws($$INSERT INTO public.customers (id, email) VALUES (gen_random_uuid(), 'new@shop.test')$$, '42501',
                      'a shopper cannot insert customers rows');
SELECT pg_temp.eq(pg_temp.affected(format($$UPDATE public.customers SET note = 'hijack' WHERE id = %L$$, current_setting('t.sam'))), 0::bigint,
                  'a shopper cannot update someone else''s row');
SELECT pg_temp.eq(pg_temp.affected('DELETE FROM public.customers'), 0::bigint, 'a shopper cannot delete rows (no delete policy)');

-- pinned columns vs ordinary profile edits
UPDATE public.customers
   SET is_admin = TRUE, total_spent = 99999, orders_count = 50, email = 'evil@x.test', note = 'vip',
       created_at = '2001-01-01',
       first_name = 'Gianna', street = '12 Galle Road', city = 'Colombo 03', district = 'Colombo',
       postal_code = '00300', phone = '+94771234567'
 WHERE id = current_setting('t.gia')::uuid;
SELECT pg_temp.logout();
SELECT pg_temp.ok((SELECT NOT is_admin AND total_spent = 0 AND orders_count = 0 AND email = 'gia@shop.test'
                          AND note IS NULL AND created_at > '2020-01-01'
                     FROM public.customers WHERE id = current_setting('t.gia')::uuid),
                  'protected columns (is_admin, rollups, email, note, created_at) are restored for a shopper');
SELECT pg_temp.eq((SELECT first_name || '|' || street || '|' || city || '|' || district || '|' || postal_code || '|' || phone
                     FROM public.customers WHERE id = current_setting('t.gia')::uuid),
                  'Gianna|12 Galle Road|Colombo 03|Colombo|00300|+94771234567', 'ordinary profile/address edits go through');

SELECT pg_temp.login(current_setting('t.gia')::uuid);
SELECT pg_temp.throws($$UPDATE public.customers SET district = 'Atlantis'$$, '23514', 'district must be one of the 25 districts');
SELECT pg_temp.throws($$UPDATE public.customers SET first_name = repeat('x', 300)$$, '23514', 'over-long names are refused');

-- admins see and edit everyone (including the admin-only note)
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.ok((SELECT count(*) >= 3 FROM public.customers), 'the admin sees every customer');
SELECT pg_temp.eq(pg_temp.affected(format($$UPDATE public.customers SET note = 'Prefers pickup' WHERE id = %L$$, current_setting('t.gia'))), 1::bigint,
                  'the admin can write the note on another customer');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT note FROM public.customers WHERE id = current_setting('t.gia')::uuid), 'Prefers pickup', 'admin note stored');
-- RLS is row-level: the shopper can READ the note on their own row (never write it). The storefront
-- never selects it and the admin UI says so — this pins the fact so nobody assumes otherwise.
SELECT pg_temp.login(current_setting('t.gia')::uuid);
SELECT pg_temp.eq((SELECT note FROM public.customers), 'Prefers pickup', 'the admin note is readable (not writable) by the customer on their own row');

-- the dashboard's Settings save (WP-D): UPDATE … RETURNING the profile columns, exactly one row
SELECT pg_temp.login(current_setting('t.sam')::uuid);
SELECT pg_temp.eq(pg_temp.affected(format(
  $$UPDATE public.customers SET first_name = 'Samuel', last_name = NULL, phone = '+94771234567', street = '1 Temple Road',
           city = 'Kandy', district = 'Kandy', postal_code = NULL
     WHERE id = %L RETURNING email, first_name, last_name, phone, street, city, district, postal_code, country$$,
  current_setting('t.sam'))), 1::bigint, 'a shopper''s profile save returns exactly their own row (RETURNING under RLS)');
-- an admin saving their OWN profile goes through the admin policy (the shopper policy checks is_admin = FALSE)
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected(format($$UPDATE public.customers SET first_name = 'Olivia' WHERE id = %L RETURNING first_name$$,
                                          current_setting('t.owner'))), 1::bigint, 'an admin can save their own profile from the dashboard');
SELECT pg_temp.logout();
SELECT pg_temp.ok((SELECT is_admin AND first_name = 'Olivia' FROM public.customers WHERE id = current_setting('t.owner')::uuid),
                  'the admin keeps is_admin after editing their own profile');
SELECT pg_temp.eq((SELECT first_name || '|' || COALESCE(last_name, '-') || '|' || district FROM public.customers WHERE id = current_setting('t.sam')::uuid),
                  'Samuel|-|Kandy', 'the saved profile is stored as sent');

-- ── email conflict + email change sync ──────────────────────────────────────
-- simulate a drifted row (a customers email no auth account owns), then sign up with it
UPDATE public.customers SET email = 'drift@shop.test' WHERE id = current_setting('t.sam')::uuid;
SELECT pg_temp.throws($$INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), 'drift@shop.test')$$,
                      'P0001', 'signup refuses to share an email with another customers row', 'customer_email_conflict:%');
UPDATE public.customers SET email = 'sam@shop.test' WHERE id = current_setting('t.sam')::uuid;

UPDATE auth.users SET email = 'Gia.New@Shop.Test' WHERE id = current_setting('t.gia')::uuid;
SELECT pg_temp.eq((SELECT email FROM public.customers WHERE id = current_setting('t.gia')::uuid), 'gia.new@shop.test',
                  'a confirmed auth email change is followed by customers.email (lower-cased)');
SELECT pg_temp.throws(format($$UPDATE auth.users SET email = 'sam@shop.test' WHERE id = %L$$, current_setting('t.gia')),
                      '23505', 'auth refuses a duplicate email itself');
UPDATE public.customers SET email = 'taken@shop.test' WHERE id = current_setting('t.sam')::uuid;
SELECT pg_temp.throws(format($$UPDATE auth.users SET email = 'taken@shop.test' WHERE id = %L$$, current_setting('t.gia')),
                      'P0001', 'an email change onto another customer''s address is refused', 'customer_email_conflict:%');
UPDATE public.customers SET email = 'sam@shop.test' WHERE id = current_setting('t.sam')::uuid;
UPDATE auth.users SET email = 'upgraded@shop.test' WHERE id = '00000000-0000-0000-0000-0000000000aa';
SELECT pg_temp.eq((SELECT email FROM public.customers WHERE id = '00000000-0000-0000-0000-0000000000aa'), 'upgraded@shop.test',
                  'an anonymous account that gains an email is provisioned');

-- ── guest-order linking guard: signups never fail before 07_orders exists ────
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.orders') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.orders RENAME TO orders_hidden_by_test';
  END IF;
END $$;
UPDATE auth.users SET email_confirmed_at = now() WHERE id = current_setting('t.gia')::uuid;
INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ('00000000-0000-0000-0000-0000000000bb', 'auto@shop.test', now());
SELECT pg_temp.eq((SELECT count(*) FROM public.customers WHERE id = '00000000-0000-0000-0000-0000000000bb'), 1::bigint,
                  'with no orders table, confirmation and auto-confirmed signup still succeed (to_regclass guard)');
ROLLBACK;

-- ── confirmation-gated linking, against a stand-in orders table ─────────────
-- The real orders table (07) is hidden for this transaction; link_guest_orders() only needs
-- orders(customer_id, email, total_price, status).
BEGIN;
DO $$ BEGIN
  IF to_regclass('public.orders') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.orders RENAME TO orders_hidden_by_test';
  END IF;
END $$;
CREATE TABLE public.orders (id text PRIMARY KEY, customer_id uuid, email text NOT NULL,
                            total_price numeric(12,2) NOT NULL, status text NOT NULL);
INSERT INTO public.orders VALUES
  ('DO-T1', NULL, 'Linky@Shop.test', 1000, 'pending'),
  ('DO-T2', NULL, 'linky@shop.test', 500, 'delivered'),
  ('DO-T3', NULL, 'linky@shop.test', 700, 'cancelled'),
  ('DO-T4', NULL, 'other@shop.test', 900, 'pending'),
  ('DO-T5', current_setting('t.sam')::uuid, 'linky@shop.test', 300, 'pending');
SELECT set_config('t.linky', pg_temp.new_user('linky@shop.test', FALSE)::text, false);
SELECT pg_temp.eq((SELECT count(*) FROM public.orders WHERE customer_id = current_setting('t.linky')::uuid), 0::bigint,
                  'guest orders are NOT linked to an unconfirmed signup');
UPDATE auth.users SET email_confirmed_at = now() WHERE id = current_setting('t.linky')::uuid;
SELECT pg_temp.eq((SELECT string_agg(id, ',' ORDER BY id) FROM public.orders WHERE customer_id = current_setting('t.linky')::uuid),
                  'DO-T1,DO-T2,DO-T3', 'on confirmation, that email''s guest orders are linked (case-insensitive)');
SELECT pg_temp.eq((SELECT customer_id FROM public.orders WHERE id = 'DO-T5'), current_setting('t.sam')::uuid,
                  'an order already owned by another account is never re-linked');
SELECT pg_temp.eq((SELECT customer_id FROM public.orders WHERE id = 'DO-T4'), NULL::uuid, 'other emails untouched');
SELECT pg_temp.eq((SELECT total_spent::text || '/' || orders_count FROM public.customers WHERE id = current_setting('t.linky')::uuid),
                  '1500.00/2', 'lifetime value adopts linked history, cancelled orders excluded');
INSERT INTO public.orders VALUES ('DO-T6', NULL, 'instant@shop.test', 250, 'pending');
SELECT set_config('t.instant', pg_temp.new_user('instant@shop.test', TRUE)::text, false);
SELECT pg_temp.eq((SELECT customer_id FROM public.orders WHERE id = 'DO-T6'), current_setting('t.instant')::uuid,
                  'auto-confirmed signups link immediately');
ROLLBACK;

SELECT pg_temp.ok(NOT has_function_privilege('anon', 'public.link_guest_orders(uuid,text)', 'EXECUTE')
              AND NOT has_function_privilege('authenticated', 'public.link_guest_orders(uuid,text)', 'EXECUTE'),
                  'link_guest_orders is internal');
