-- 29_expenses.test.sql — starter categories, admin-only access (RLS + no anon privilege), the
-- constraints, created_by, deleting a used category is refused, and admin_expense_summary.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('nimal@shop.test')::text, false);
SELECT set_config('t.today', ((now() AT TIME ZONE 'Asia/Colombo')::date)::text, false);

-- ── starter categories ──────────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT count(*) FROM public.expense_categories), 12::bigint, 'twelve starter categories');
SELECT pg_temp.eq((SELECT string_agg(name, ' | ' ORDER BY sort_order) FROM (SELECT * FROM public.expense_categories ORDER BY sort_order LIMIT 3) c),
                  'Rent | Salaries & wages | Stock purchases', 'in their starting order');

-- ── privileges ──────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT 1 FROM public.expenses LIMIT 1', '42501', 'anon cannot read expenses');
SELECT pg_temp.throws('SELECT 1 FROM public.expense_categories LIMIT 1', '42501', 'anon cannot read expense categories');
SELECT pg_temp.throws($$SELECT public.admin_expense_summary(current_date, current_date)$$, '42501', 'anon cannot run the summary');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.expense_categories), 0::bigint, 'a shopper sees no categories (RLS)');
SELECT pg_temp.throws($$INSERT INTO public.expenses (category_id, description, amount) VALUES (1, 'x', 1)$$, '42501',
                      'a shopper cannot add an expense (RLS)');
SELECT pg_temp.throws($$SELECT public.admin_expense_summary(current_date, current_date)$$, '42501', 'a shopper cannot run the summary', 'not_authorised:%');

-- ── the admin adds expenses ─────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.rent', (SELECT id::text FROM public.expense_categories WHERE name = 'Rent'), false);
SELECT set_config('t.courier', (SELECT id::text FROM public.expense_categories WHERE name = 'Delivery & courier'), false);
SELECT pg_temp.eq(pg_temp.affected(format($$INSERT INTO public.expenses (spent_on, category_id, description, amount, payment_method, paid_to, reference)
  VALUES (%L, %s, 'October rent — Unity Plaza', 150000, 'bank_transfer', 'Unity Plaza Management', 'RENT-10'),
         (%L, %s, 'Courier — 12 parcels', 4800, 'cash', 'Pronto', NULL),
         (%L, %s, 'Courier — returns', 1200.50, 'cash', NULL, NULL),
         (%L, %s, 'Last year''s rent', 140000, 'bank_transfer', NULL, NULL)$$,
  current_setting('t.today'), current_setting('t.rent'),
  current_setting('t.today'), current_setting('t.courier'),
  current_setting('t.today'), current_setting('t.courier'),
  (current_setting('t.today')::date - 400)::text, current_setting('t.rent'))), 4::bigint, 'the admin adds four expenses');
SELECT pg_temp.eq((SELECT count(*) FROM public.expenses WHERE created_by = current_setting('t.owner')::uuid), 4::bigint,
                  'created_by is the admin who added them');
SELECT pg_temp.eq((SELECT spent_on::text FROM public.expenses WHERE description = 'Courier — returns'), current_setting('t.today'),
                  'dated as entered');

-- constraints
SELECT pg_temp.throws(format($$INSERT INTO public.expenses (category_id, description, amount) VALUES (%s, 'x', 0)$$, current_setting('t.rent')),
                      '23514', 'a zero amount', '%expenses_amount_valid%');
SELECT pg_temp.throws(format($$INSERT INTO public.expenses (category_id, description, amount, payment_method) VALUES (%s, 'x', 5, 'barter')$$, current_setting('t.rent')),
                      '23514', 'an unknown payment method', '%expenses_method_valid%');
SELECT pg_temp.throws(format($$INSERT INTO public.expenses (category_id, description, amount) VALUES (%s, '   ', 5)$$, current_setting('t.rent')),
                      '23514', 'a blank description', '%expenses_text_lengths%');
SELECT pg_temp.throws($$INSERT INTO public.expenses (category_id, description, amount) VALUES (999999, 'x', 5)$$,
                      '23503', 'an unknown category', '%expenses_category_id_fkey%');
SELECT pg_temp.throws($$INSERT INTO public.expense_categories (name) VALUES ('rent')$$, '23505', 'a duplicate category name (any case)');
SELECT pg_temp.throws($$INSERT INTO public.expense_categories (name) VALUES (' Padded ')$$, '23514', 'an untrimmed category name',
                      '%expense_categories_name_valid%');

-- categories: a used one can't be deleted (switch it off); an unused one can
SELECT pg_temp.throws(format('DELETE FROM public.expense_categories WHERE id = %s', current_setting('t.rent')), '23503',
                      'a category with expenses cannot be deleted', '%expenses_category_id_fkey%');
SELECT pg_temp.eq(pg_temp.affected(format('UPDATE public.expense_categories SET is_active = FALSE WHERE id = %s', current_setting('t.rent'))), 1::bigint,
                  'it can be switched off');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.expense_categories WHERE name = 'Other'$$), 1::bigint, 'an unused category is deleted');

-- ── summary ─────────────────────────────────────────────────────────────────
SELECT set_config('t.sum', public.admin_expense_summary(current_setting('t.today')::date - 30, current_setting('t.today')::date)::text, false);
SELECT pg_temp.eq((SELECT format('%s|%s', s ->> 'total', s ->> 'count') FROM (SELECT current_setting('t.sum')::jsonb AS s) x),
                  '156000.50|3', 'the range total and count (last year''s rent is outside it)');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s:%s', e ->> 'name', e ->> 'total', e ->> 'count'), ', ' ORDER BY ord)
                     FROM jsonb_array_elements(current_setting('t.sum')::jsonb -> 'by_category') WITH ORDINALITY AS t(e, ord)),
                  'Rent:150000.00:1, Delivery & courier:6000.50:2', 'per category, largest first');
SELECT pg_temp.eq((SELECT string_agg(format('%s:%s', e ->> 'method', e ->> 'total'), ', ' ORDER BY ord)
                     FROM jsonb_array_elements(current_setting('t.sum')::jsonb -> 'by_method') WITH ORDINALITY AS t(e, ord)),
                  'bank_transfer:150000.00, cash:6000.50', 'per payment method');
SELECT pg_temp.eq((SELECT public.admin_expense_summary(current_setting('t.today')::date + 1, current_setting('t.today')::date + 2) ->> 'total'),
                  '0', 'an empty range totals 0');
SELECT pg_temp.throws($$SELECT public.admin_expense_summary(current_date, current_date - 1)$$, '22023', 'an inverted range', 'invalid_range:%');
