-- 18_site_lock.test.sql — the sealed singleton, get_site_lock (effective lock, fingerprint, no
-- secrets), set_site_lock (admin only, 22023 validation, PIN required to lock, a new PIN rotates the
-- token), verify_site_lock_pin (right PIN → token, strikes: 10 misses → cool-off checked BEFORE the
-- compare, reset after a right PIN), auto-unlock at launch time, admin state/token.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);
CREATE FUNCTION pg_temp.state() RETURNS public.site_lock LANGUAGE sql AS $$ SELECT * FROM public.site_lock $$;

SELECT pg_temp.eq((SELECT count(*) FROM public.site_lock), 1::bigint, 'exactly one row');
SELECT pg_temp.eq((SELECT concat_ws('|', locked::text, (pin_hash IS NULL)::text, headline) FROM public.site_lock),
                  'false|true|Launching soon', 'unlocked, no PIN, default copy');
SELECT pg_temp.throws($$INSERT INTO public.site_lock (id) VALUES (FALSE)$$, '23514', 'the singleton CHECK refuses a second row', '%site_lock_id_check%');

-- ── sealed ──────────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws('SELECT * FROM public.site_lock', '42501', 'anon cannot read the lock row');
SELECT pg_temp.throws('SELECT public.set_site_lock(TRUE, ''123456'')', '42501', 'anon cannot call set_site_lock');
SELECT pg_temp.throws('SELECT public.admin_site_lock_token()', '42501', 'anon cannot read the token');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws('SELECT pin_hash FROM public.site_lock', '42501', 'even an admin cannot read the table directly');
SELECT pg_temp.throws($$UPDATE public.site_lock SET locked = FALSE$$, '42501', 'even an admin cannot write the table directly');

-- ── set_site_lock: admin only, validated ────────────────────────────────────
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws('SELECT public.set_site_lock(TRUE, ''432109'')', '42501', 'a shopper cannot lock the site', 'not_authorised:%');
SELECT pg_temp.throws('SELECT * FROM public.admin_site_lock_state()', '42501', 'a shopper cannot read the admin state', 'not_authorised:%');
SELECT pg_temp.throws('SELECT public.admin_site_lock_token()', '42501', 'a shopper cannot read the token', 'not_authorised:%');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.throws('SELECT public.set_site_lock(TRUE)', '22023', 'locking needs a PIN', 'pin_required:%');
SELECT pg_temp.throws('SELECT public.set_site_lock(NULL, ''12a456'')', '22023', 'a PIN must be digits', 'invalid_pin:%');
SELECT pg_temp.throws('SELECT public.set_site_lock(NULL, ''12345'')', '22023', 'a PIN of 5 digits', 'invalid_pin:%');
SELECT pg_temp.throws('SELECT public.set_site_lock(NULL, ''1234567890123'')', '22023', 'a PIN of 13 digits', 'invalid_pin:%');
SELECT pg_temp.throws('SELECT public.set_site_lock(NULL, NULL, NULL, NULL, 0)', '22023', 'a zero countdown', 'invalid_launch:%');
SELECT pg_temp.throws('SELECT public.set_site_lock(NULL, NULL, NULL, NULL, 8761)', '22023', 'a countdown over a year', 'invalid_launch:%');
SELECT pg_temp.throws($$SELECT public.set_site_lock(NULL, NULL, NULL, NULL, 'NaN')$$, '22023', 'a NaN countdown', 'invalid_launch:%');
SELECT pg_temp.throws(format('SELECT public.set_site_lock(NULL, NULL, %L)', repeat('h', 121)), '22023', 'a long headline', 'invalid_headline:%');
SELECT pg_temp.throws(format('SELECT public.set_site_lock(NULL, NULL, NULL, %L)', repeat('m', 1001)), '22023', 'a long message', 'invalid_message:%');
SELECT public.set_site_lock(TRUE, ' 432109 ', ' Opening soon ', NULL, 48);
SELECT set_config('t.tok1', public.admin_site_lock_token(), false);
SELECT set_config('t.admin_state', (SELECT to_jsonb(s) FROM public.admin_site_lock_state() s)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT concat_ws('|', locked::text, headline, message, (launch_at BETWEEN now() + interval '47 hours' AND now() + interval '49 hours')::text,
                                    (pin_hash LIKE '$2%')::text, (updated_by = current_setting('t.owner')::uuid)::text)
                     FROM public.site_lock),
                  'true|Opening soon|We are putting the finishing touches to the store.|true|true|true',
                  'locked with a bcrypt PIN, trimmed headline, message kept, launch in 48 h, updated_by = the admin');
SELECT pg_temp.eq(current_setting('t.admin_state')::jsonb - 'updated_at' - 'server_now' - 'launch_at',
                  '{"locked":true,"effective_locked":true,"headline":"Opening soon","message":"We are putting the finishing touches to the store.","auto_unlock":true,"has_pin":true}'::jsonb,
                  'admin_site_lock_state shows the stored and effective lock');

-- ── get_site_lock: public, no secrets ───────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT set_config('t.pub', (SELECT to_jsonb(g) FROM public.get_site_lock() g)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(current_setting('t.pub')::jsonb) k),
                  ARRAY['auto_unlock', 'has_pin', 'headline', 'launch_at', 'locked', 'message', 'server_now', 'unlock_fingerprint'],
                  'the public state has no token, no hash, no strike counter');
SELECT pg_temp.eq(current_setting('t.pub')::jsonb ->> 'unlock_fingerprint', encode(extensions.digest(current_setting('t.tok1'), 'sha256'), 'hex'),
                  'the fingerprint is sha256(token) in hex');
SELECT pg_temp.eq(current_setting('t.pub')::jsonb ->> 'locked', 'true', 'the site reads as locked');

-- ── verify_site_lock_pin: token on the right PIN; strikes and cool-off ──────
SELECT pg_temp.login_anon();
SELECT set_config('t.good', COALESCE(public.verify_site_lock_pin('432109'), ''), false);
SELECT set_config('t.good_spaces', COALESCE(public.verify_site_lock_pin(' 432109 '), ''), false);
SELECT set_config('t.blank', COALESCE(public.verify_site_lock_pin('  '), ''), false);
SELECT set_config('t.null', COALESCE(public.verify_site_lock_pin(NULL), ''), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.good'), current_setting('t.tok1'), 'the right PIN returns the bypass token');
SELECT pg_temp.eq(current_setting('t.good_spaces'), current_setting('t.tok1'), 'surrounding spaces are ignored');
SELECT pg_temp.eq(current_setting('t.blank') || current_setting('t.null'), '', 'blank and NULL PINs answer NULL');
SELECT pg_temp.eq((pg_temp.state()).failed_attempts, 0, 'blank and NULL PINs cost no strike');

-- nine misses, then the right PIN still works and resets the counter
SELECT pg_temp.login_anon();
SELECT public.verify_site_lock_pin('000000') FROM generate_series(1, 9);
SELECT pg_temp.logout();
SELECT pg_temp.eq((pg_temp.state()).failed_attempts, 9, 'nine misses are counted');
SELECT pg_temp.login_anon();
SELECT set_config('t.after9', COALESCE(public.verify_site_lock_pin('432109'), ''), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.after9'), current_setting('t.tok1'), 'the right PIN on the 10th try works');
SELECT pg_temp.eq((pg_temp.state()).failed_attempts, 0, '…and resets the strike counter');

-- ten misses → a 15-minute cool-off in which even the right PIN answers NULL
SELECT pg_temp.login_anon();
SELECT public.verify_site_lock_pin('999999') FROM generate_series(1, 10);
SELECT set_config('t.during', COALESCE(public.verify_site_lock_pin('432109'), ''), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.during'), '', 'during the cool-off the right PIN answers NULL (checked before comparing)');
SELECT pg_temp.ok((SELECT locked_out_until BETWEEN now() + interval '14 minutes' AND now() + interval '16 minutes' AND failed_attempts = 0
                     FROM public.site_lock), 'the 10th miss starts a 15-minute cool-off and resets the counter');
UPDATE public.site_lock SET locked_out_until = now() - interval '1 second';
SELECT pg_temp.login_anon();
SELECT set_config('t.after', COALESCE(public.verify_site_lock_pin('432109'), ''), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.after'), current_setting('t.tok1'), 'after the cool-off the right PIN works again');

-- ── a new PIN rotates the token; saves clear strikes; re-lock clears a stale launch ──
UPDATE public.site_lock SET failed_attempts = 4;
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.set_site_lock(NULL, '987654');
SELECT set_config('t.tok2', public.admin_site_lock_token(), false);
SELECT pg_temp.login_anon();
SELECT set_config('t.old_pin', COALESCE(public.verify_site_lock_pin('432109'), ''), false);
SELECT set_config('t.new_pin', COALESCE(public.verify_site_lock_pin('987654'), ''), false);
SELECT pg_temp.logout();
SELECT pg_temp.ok(current_setting('t.tok2') <> current_setting('t.tok1'), 'a new PIN rotates the bypass token (old cookies stop working)');
SELECT pg_temp.eq(current_setting('t.old_pin'), '', 'the old PIN no longer unlocks');
SELECT pg_temp.eq(current_setting('t.new_pin'), current_setting('t.tok2'), 'the new PIN returns the new token');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.set_site_lock(NULL, NULL, '   ', '  ');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT concat_ws('|', headline, failed_attempts::text, (unlock_token::text = current_setting('t.tok2'))::text)
                     FROM public.site_lock), 'Opening soon|0|true', 'blank fields leave the copy unchanged; a save without a PIN keeps the token');

-- auto-unlock at launch time (DB clock)
UPDATE public.site_lock SET launch_at = now() - interval '1 minute', auto_unlock = TRUE;
SELECT pg_temp.login_anon();
SELECT set_config('t.auto', (SELECT locked::text FROM public.get_site_lock()), false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.auto'), 'false', 'with auto_unlock the lock ends at launch_at');
UPDATE public.site_lock SET auto_unlock = FALSE;
SELECT pg_temp.eq((SELECT locked FROM public.get_site_lock()), TRUE, 'without auto_unlock a passed launch time does not unlock');
UPDATE public.site_lock SET auto_unlock = TRUE;
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.set_site_lock(TRUE);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT concat_ws('|', locked::text, COALESCE(launch_at::text, '∅')) FROM public.site_lock), 'true|∅',
                  're-locking after the launch time passed clears the stale launch time');
SELECT pg_temp.eq((SELECT locked FROM public.get_site_lock()), TRUE, '…so the site really is locked again');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT public.set_site_lock(NULL, NULL, NULL, NULL, 2);
SELECT public.set_site_lock(NULL, NULL, NULL, NULL, NULL, TRUE);
SELECT public.set_site_lock(FALSE);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT concat_ws('|', locked::text, COALESCE(launch_at::text, '∅'), (pin_hash IS NOT NULL)::text) FROM public.site_lock),
                  'false|∅|true', 'p_clear_launch removes the launch time; unlocking keeps the PIN');
SELECT pg_temp.eq((SELECT locked FROM public.get_site_lock()), FALSE, 'unlocked');
