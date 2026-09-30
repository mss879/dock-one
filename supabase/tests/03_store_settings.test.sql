-- 03_store_settings.test.sql — singleton row, defaults, public read, admin-only update, validation.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);

-- ── the store's real bank account (03 fills it; nothing invented) ───────────
SELECT pg_temp.ok((SELECT bank_account_name = 'Dock One Solutions Pvt Ltd' AND bank_name = 'Bank of Ceylon'
                          AND bank_branch = 'Vishaka' AND bank_account_number = '79503030'
                          AND bank_transfer_instructions IS NULL AND bank_transfer_enabled FROM public.store_settings),
                  'bank transfer is on with the owner''s bank account (Bank of Ceylon, Vishaka, 79503030), no extra note');
-- A re-run never overwrites an edit made in the admin (and never touches updated_at) …
UPDATE public.store_settings SET bank_branch = 'Colombo 07';
SELECT set_config('t.bank_at', (SELECT updated_at FROM public.store_settings)::text, false);
\ir ../migrations/03_store_settings.sql
SELECT pg_temp.ok((SELECT bank_branch = 'Colombo 07' AND bank_account_number = '79503030'
                          AND updated_at = current_setting('t.bank_at')::timestamptz FROM public.store_settings),
                  'a re-run keeps the admin''s bank details and leaves updated_at alone');
-- … and fills the account again only when every bank column is empty.
UPDATE public.store_settings SET bank_account_name = NULL, bank_name = NULL, bank_branch = NULL, bank_account_number = NULL;
\ir ../migrations/03_store_settings.sql
SELECT pg_temp.ok((SELECT bank_account_name = 'Dock One Solutions Pvt Ltd' AND bank_name = 'Bank of Ceylon'
                          AND bank_branch = 'Vishaka' AND bank_account_number = '79503030' FROM public.store_settings),
                  'with no bank details at all, a re-run fills the store''s account again');

-- Seed 31 (DEMO) writes contact placeholders, pickup, ticker and labels into this row. This file
-- tests 03 on its own, so every editable column goes back to its column default first (as the
-- superuser: the touch trigger stamps updated_by NULL).
UPDATE public.store_settings
   SET (store_name, delivery_fee, free_delivery_threshold, cod_enabled, cod_max_total, bank_transfer_enabled,
        bank_account_name, bank_name, bank_branch, bank_account_number,
        bank_transfer_instructions, pickup_enabled, pickup_address, pickup_note, phone, whatsapp, email, address,
        map_url, opening_hours, business_reg_no, socials, announcement, ticker_items, accepted_payment_labels,
        flash_sale_title, flash_sale_ends_at, returns_window_days, warranty_note)
     = (DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT,
        DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT,
        DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT);

-- ── the row and its defaults ────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT count(*) FROM public.store_settings), 1::bigint, 'exactly one store_settings row exists');
SELECT pg_temp.eq((SELECT delivery_fee FROM public.store_settings), 450::numeric, 'default delivery fee Rs. 450');
SELECT pg_temp.eq((SELECT free_delivery_threshold FROM public.store_settings), 15000::numeric, 'default free-delivery threshold Rs. 15,000');
SELECT pg_temp.ok((SELECT cod_enabled AND bank_transfer_enabled AND pickup_enabled FROM public.store_settings),
                  'COD, bank transfer and pickup default to on');
SELECT pg_temp.ok((SELECT cod_max_total IS NULL AND bank_transfer_instructions IS NULL AND bank_account_name IS NULL
                          AND bank_name IS NULL AND bank_branch IS NULL AND bank_account_number IS NULL AND phone IS NULL AND whatsapp IS NULL
                          AND email IS NULL AND business_reg_no IS NULL AND announcement IS NULL
                          AND flash_sale_ends_at IS NULL FROM public.store_settings),
                  'contact/legal/flash-sale fields start empty (never invented)');
SELECT pg_temp.ok((SELECT socials = '{}'::jsonb AND ticker_items = '{}' AND accepted_payment_labels = '{}'
                          AND returns_window_days = 7 AND store_name = 'Dock One Solutions' FROM public.store_settings),
                  'remaining defaults (socials, ticker, labels, returns window, store name)');

-- ── anon: read yes, write never ─────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT delivery_fee FROM public.store_settings), 450::numeric, 'anon can read the settings row');
SELECT pg_temp.throws('UPDATE public.store_settings SET delivery_fee = 0', '42501', 'anon cannot update settings');
SELECT pg_temp.throws('INSERT INTO public.store_settings (id) VALUES (TRUE)', '42501', 'anon cannot insert settings');
SELECT pg_temp.throws('DELETE FROM public.store_settings', '42501', 'anon cannot delete settings');
SELECT pg_temp.throws('TRUNCATE public.store_settings', '42501', 'anon cannot truncate settings');

-- ── signed-in shopper: read yes, write no ───────────────────────────────────
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.store_settings), 1::bigint, 'a shopper can read the settings row');
SELECT pg_temp.eq(pg_temp.affected('UPDATE public.store_settings SET delivery_fee = 0'), 0::bigint,
                  'a non-admin update touches 0 rows (RLS)');
SELECT pg_temp.throws('DELETE FROM public.store_settings', '42501', 'a shopper cannot delete settings');
SELECT pg_temp.throws('INSERT INTO public.store_settings (id) VALUES (TRUE)', '42501', 'a shopper cannot insert settings');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT delivery_fee FROM public.store_settings), 450::numeric, 'fee unchanged after refused writes');

-- ── admin: update with WITH CHECK, stamped ──────────────────────────────────
SELECT set_config('t.before', (SELECT updated_at FROM public.store_settings)::text, false);
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.store_settings
                                        SET delivery_fee = 500, free_delivery_threshold = 20000,
                                            bank_transfer_instructions = 'Bank: Example Bank, Colombo',
                                            socials = '{"instagram":"https://instagram.com/dockone"}',
                                            ticker_items = ARRAY['Island-wide delivery'],
                                            flash_sale_ends_at = now() + interval '2 days'$$), 1::bigint,
                  'the admin updates the settings row');
SELECT pg_temp.throws('DELETE FROM public.store_settings', '42501', 'even the admin cannot delete the singleton');
SELECT pg_temp.throws('INSERT INTO public.store_settings (id) VALUES (TRUE)', '42501', 'even the admin cannot insert a second row');
SELECT pg_temp.logout();
SELECT pg_temp.ok((SELECT delivery_fee = 500 AND free_delivery_threshold = 20000 AND updated_by = current_setting('t.owner')::uuid
                          AND updated_at > current_setting('t.before')::timestamptz FROM public.store_settings),
                  'admin write stored, stamped with updated_by and a fresh updated_at');

-- ── singleton + validation (as superuser: constraints bind everyone) ────────
SELECT pg_temp.throws('INSERT INTO public.store_settings (id) VALUES (FALSE)', '23514', 'id must be TRUE (singleton CHECK)');
SELECT pg_temp.throws('INSERT INTO public.store_settings (id) VALUES (TRUE)', '23505', 'a second TRUE row violates the primary key');
SELECT pg_temp.throws($$UPDATE public.store_settings SET socials = '{"myspace":"https://myspace.com/x"}'$$, '23514', 'unknown social network refused');
SELECT pg_temp.throws($$UPDATE public.store_settings SET socials = '{"facebook":"javascript:alert(1)"}'$$, '23514', 'non-https social URL refused');
SELECT pg_temp.throws($$UPDATE public.store_settings SET socials = '{"facebook":5}'$$, '23514', 'non-string social URL refused');
SELECT pg_temp.throws($$UPDATE public.store_settings SET socials = '["https://x.test"]'$$, '23514', 'socials must be an object');
SELECT pg_temp.throws($$UPDATE public.store_settings SET map_url = 'http://maps.example/x'$$, '23514', 'map_url must be https');
SELECT pg_temp.throws($$UPDATE public.store_settings SET map_url = 'https://maps.example\@evil.example'$$, '23514', 'map_url cannot contain backslashes');
SELECT pg_temp.throws($$UPDATE public.store_settings SET socials = '{"facebook":"https://facebook.com\\@evil.example"}'$$, '23514', 'social URLs cannot contain backslashes');
SELECT pg_temp.throws($$UPDATE public.store_settings SET email = 'not-an-email'$$, '23514', 'contact email must look like an email');
SELECT pg_temp.throws('UPDATE public.store_settings SET delivery_fee = -1', '23514', 'negative delivery fee refused');
SELECT pg_temp.throws('UPDATE public.store_settings SET cod_max_total = 0', '23514', 'COD cap must be positive when set');
SELECT pg_temp.throws('UPDATE public.store_settings SET returns_window_days = 400', '23514', 'returns window capped at 365 days');
SELECT pg_temp.throws($$UPDATE public.store_settings SET announcement = repeat('x', 201)$$, '23514', 'announcement capped at 200 chars (the top-bar display cap)');
SELECT pg_temp.throws($$UPDATE public.store_settings SET ticker_items = ARRAY['ok', repeat('y', 201)]$$, '23514', 'each ticker item capped at 200 chars');
SELECT pg_temp.throws($$UPDATE public.store_settings SET accepted_payment_labels = ARRAY['Cash on delivery', repeat('z', 61)]$$, '23514', 'each payment label capped at 60 chars');
SELECT pg_temp.throws($$UPDATE public.store_settings SET ticker_items = ARRAY['a', NULL]$$, '23514', 'no NULL ticker items');
UPDATE public.store_settings SET ticker_items = ARRAY[repeat('y', 200), E'two\nlines'], accepted_payment_labels = ARRAY[repeat('z', 60)],
       announcement = repeat('x', 200), whatsapp = '+94 77 123 4567';
SELECT pg_temp.eq((SELECT cardinality(ticker_items) FROM public.store_settings), 2, 'values exactly at the caps are accepted');
SELECT pg_temp.throws($$UPDATE public.store_settings SET ticker_items = array_fill('x'::text, ARRAY[21])$$, '23514', 'at most 20 ticker items');
UPDATE public.store_settings SET free_delivery_threshold = NULL,
       socials = '{"facebook":"https://facebook.com/dockone","instagram":"https://instagram.com/dockone","tiktok":"https://tiktok.com/@dockone","youtube":"https://youtube.com/@dockone"}';
SELECT pg_temp.ok((SELECT free_delivery_threshold IS NULL AND socials ? 'youtube' FROM public.store_settings),
                  'NULL threshold (never free) and all four networks are accepted');

-- ── the bank account (store_settings_bank_account_valid) ────────────────────
SELECT pg_temp.throws($$UPDATE public.store_settings SET bank_account_number = 'ABC12345'$$, '23514', 'account number: digits only', '%store_settings_bank_account_valid%');
SELECT pg_temp.throws($$UPDATE public.store_settings SET bank_account_number = '123'$$, '23514', 'account number: at least 4 characters');
SELECT pg_temp.throws($$UPDATE public.store_settings SET bank_account_number = repeat('1', 41)$$, '23514', 'account number: at most 40 characters');
SELECT pg_temp.throws($$UPDATE public.store_settings SET bank_account_number = '7950  3030'$$, '23514', 'account number: no double spaces');
SELECT pg_temp.throws($$UPDATE public.store_settings SET bank_account_number = ' 79503030'$$, '23514', 'account number: no leading space');
SELECT pg_temp.throws($$UPDATE public.store_settings SET bank_account_number = '7950-'$$, '23514', 'account number: cannot end with a separator');
SELECT pg_temp.throws($$UPDATE public.store_settings SET bank_name = ''$$, '23514', 'bank name: not empty');
SELECT pg_temp.throws($$UPDATE public.store_settings SET bank_account_name = '   '$$, '23514', 'account name: not blank');
SELECT pg_temp.throws($$UPDATE public.store_settings SET bank_branch = repeat('b', 121)$$, '23514', 'branch: at most 120 characters');
SELECT pg_temp.throws($$UPDATE public.store_settings SET bank_name = E'Bank of\nCeylon'$$, '23514', 'bank name: one line (no control characters)');
UPDATE public.store_settings SET bank_account_name = repeat('n', 120), bank_name = 'Bank of Ceylon', bank_branch = 'Vishaka',
       bank_account_number = '0079-5030 30';
SELECT pg_temp.ok((SELECT bank_account_number = '0079-5030 30' AND char_length(bank_account_name) = 120 FROM public.store_settings),
                  'grouped account numbers and a 120-character name are accepted');
UPDATE public.store_settings SET bank_account_number = repeat('1', 40);
SELECT pg_temp.eq((SELECT char_length(bank_account_number) FROM public.store_settings), 40, 'a 40-digit account number is accepted');
