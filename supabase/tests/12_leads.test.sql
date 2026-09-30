-- 12_leads.test.sql — newsletter (idempotent, no enumeration, token unsubscribe → suppression,
-- re-signup = fresh consent), contact inquiries (bounds + codes, trimming, admin all four verbs),
-- the sealed suppression list, and RLS for all three tables.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);

-- ── privileges ──────────────────────────────────────────────────────────────
SELECT pg_temp.ok(has_function_privilege('anon', 'public.subscribe_newsletter(text,text)', 'EXECUTE')
              AND has_function_privilege('anon', 'public.unsubscribe_newsletter(uuid)', 'EXECUTE')
              AND has_function_privilege('anon', 'public.submit_contact_inquiry(text,text,text,text)', 'EXECUTE'),
                  'anon may call the three lead functions (grant A)');
SELECT pg_temp.ok(NOT has_table_privilege('anon', 'public.newsletter_subscribers', 'SELECT')
              AND NOT has_table_privilege('anon', 'public.contact_inquiries', 'SELECT')
              AND NOT has_table_privilege('anon', 'public.email_suppressions', 'SELECT')
              AND NOT has_table_privilege('authenticated', 'public.email_suppressions', 'SELECT')
              AND NOT has_table_privilege('authenticated', 'public.email_suppressions', 'INSERT'),
                  'anon holds no privilege on the lead tables; the suppression list is sealed from authenticated too');

-- ── subscribe_newsletter ────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(public.subscribe_newsletter('  Nimal@Example.LK ', 'home'), TRUE, 'a valid address is accepted');
SELECT pg_temp.eq(public.subscribe_newsletter('nimal@example.lk', 'footer'), TRUE, 'an existing address answers TRUE too (no enumeration)');
SELECT pg_temp.eq(public.subscribe_newsletter('NIMAL@EXAMPLE.LK'), TRUE, 'case does not create a second subscriber');
SELECT pg_temp.eq(public.subscribe_newsletter('kamal@example.lk', NULL), TRUE, 'NULL source → default');
SELECT pg_temp.eq(public.subscribe_newsletter('sunil@example.lk', '   '), TRUE, 'blank source → default');
SELECT pg_temp.eq(public.subscribe_newsletter('ravi@example.lk', repeat('s', 80)), TRUE, 'an over-long source is cut, not refused');
SELECT pg_temp.eq(public.subscribe_newsletter('', 'home'), FALSE, 'blank address → FALSE');
SELECT pg_temp.eq(public.subscribe_newsletter(NULL, 'home'), FALSE, 'NULL address → FALSE');
SELECT pg_temp.eq(public.subscribe_newsletter('no-at-sign', 'home'), FALSE, 'no @ → FALSE');
SELECT pg_temp.eq(public.subscribe_newsletter('a@b', 'home'), FALSE, 'no dot in the domain → FALSE');
SELECT pg_temp.eq(public.subscribe_newsletter('a b@c.lk', 'home'), FALSE, 'whitespace inside → FALSE');
SELECT pg_temp.eq(public.subscribe_newsletter(repeat('x', 251) || '@c.lk', 'home'), FALSE, 'over 255 characters → FALSE');
SELECT pg_temp.throws('SELECT * FROM public.newsletter_subscribers', '42501', 'anon cannot read the list');
SELECT pg_temp.throws($$INSERT INTO public.newsletter_subscribers (email) VALUES ('x@y.lk')$$, '42501', 'anon cannot insert into the list');
SELECT pg_temp.throws('SELECT * FROM public.email_suppressions', '42501', 'anon cannot read suppressions');
SELECT pg_temp.logout();

SELECT pg_temp.eq((SELECT count(*) FROM public.newsletter_subscribers), 4::bigint, 'four distinct subscribers, nothing for the invalid ones');
SELECT pg_temp.eq((SELECT source FROM public.newsletter_subscribers WHERE email = 'nimal@example.lk'), 'home',
                  'stored lower-cased and trimmed; the FIRST capture point keeps the attribution');
SELECT pg_temp.eq((SELECT string_agg(source, ',' ORDER BY email) FROM public.newsletter_subscribers WHERE email IN ('kamal@example.lk', 'sunil@example.lk')),
                  'footer,footer', 'missing or blank source → footer');
SELECT pg_temp.eq((SELECT char_length(source) FROM public.newsletter_subscribers WHERE email = 'ravi@example.lk'), 50, 'source capped at 50');
SELECT pg_temp.ok((SELECT unsubscribe_token IS NOT NULL AND unsubscribed_at IS NULL AND confirmed_at IS NULL
                     FROM public.newsletter_subscribers WHERE email = 'nimal@example.lk'),
                  'every subscriber has a token; subscribed; not confirmed (no double opt-in flow)');
SELECT pg_temp.eq((SELECT count(DISTINCT unsubscribe_token) FROM public.newsletter_subscribers), 4::bigint, 'tokens are unique');

-- ── unsubscribe_newsletter ──────────────────────────────────────────────────
SELECT set_config('t.tok', (SELECT unsubscribe_token FROM public.newsletter_subscribers WHERE email = 'nimal@example.lk')::text, false);
INSERT INTO public.email_suppressions (email, reason) VALUES ('nimal@example.lk', 'cart_recovery');
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(public.unsubscribe_newsletter(gen_random_uuid()), TRUE, 'unknown token → TRUE (same answer)');
SELECT pg_temp.eq(public.unsubscribe_newsletter(NULL), TRUE, 'NULL token → TRUE (same answer)');
SELECT pg_temp.eq(public.unsubscribe_newsletter(current_setting('t.tok')::uuid), TRUE, 'the real token → TRUE');
SELECT pg_temp.logout();
SELECT pg_temp.ok((SELECT unsubscribed_at IS NOT NULL FROM public.newsletter_subscribers WHERE email = 'nimal@example.lk'),
                  'the token unsubscribed its owner');
SELECT pg_temp.eq((SELECT count(*) FROM public.newsletter_subscribers WHERE unsubscribed_at IS NOT NULL), 1::bigint,
                  'unknown and NULL tokens changed nothing');
SELECT pg_temp.eq((SELECT string_agg(reason, ',' ORDER BY reason) FROM public.email_suppressions WHERE email = 'nimal@example.lk'),
                  'cart_recovery,newsletter', 'unsubscribing adds a newsletter suppression for the person');
UPDATE public.newsletter_subscribers SET unsubscribed_at = now() - interval '3 days' WHERE email = 'nimal@example.lk';
SELECT pg_temp.login_anon();
SELECT public.unsubscribe_newsletter(current_setting('t.tok')::uuid);
SELECT pg_temp.logout();
SELECT pg_temp.ok((SELECT unsubscribed_at < now() - interval '2 days' FROM public.newsletter_subscribers WHERE email = 'nimal@example.lk'),
                  'a second unsubscribe keeps the original time');

-- re-signup = fresh consent: re-activated, newsletter suppression lifted, other purposes untouched
SELECT pg_temp.login_anon();
SELECT pg_temp.eq(public.subscribe_newsletter('Nimal@example.lk', 'finder'), TRUE, 're-signup answers TRUE');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s', unsubscribed_at IS NULL, source) FROM public.newsletter_subscribers WHERE email = 'nimal@example.lk'),
                  't|home', 'an explicit signup re-activates the address (attribution unchanged)');
SELECT pg_temp.eq((SELECT string_agg(reason, ',') FROM public.email_suppressions WHERE email = 'nimal@example.lk'),
                  'cart_recovery', 'the newsletter suppression is lifted; the cart-recovery one stays');

-- ── submit_contact_inquiry ──────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT public.submit_contact_inquiry('', 'a@b.lk', 'Hello', 'I would like to ask about warranty.')$$,
                      'P0001', 'blank name', 'invalid_name');
SELECT pg_temp.throws($$SELECT public.submit_contact_inquiry('   ', 'a@b.lk', 'Hello', 'I would like to ask about warranty.')$$,
                      'P0001', 'whitespace-only name', 'invalid_name');
SELECT pg_temp.throws($$SELECT public.submit_contact_inquiry(NULL, 'a@b.lk', 'Hello', 'I would like to ask about warranty.')$$,
                      'P0001', 'NULL name', 'invalid_name');
SELECT pg_temp.throws(format('SELECT public.submit_contact_inquiry(%L, %L, %L, %L)', repeat('n', 256), 'a@b.lk', 'Hello',
                             'I would like to ask about warranty.'), 'P0001', 'name over 255', 'invalid_name');
SELECT pg_temp.throws($$SELECT public.submit_contact_inquiry('Ann', 'not-an-email', 'Hello', 'I would like to ask about warranty.')$$,
                      'P0001', 'bad email', 'invalid_email');
SELECT pg_temp.throws($$SELECT public.submit_contact_inquiry('Ann', NULL, 'Hello', 'I would like to ask about warranty.')$$,
                      'P0001', 'NULL email', 'invalid_email');
SELECT pg_temp.throws($$SELECT public.submit_contact_inquiry('Ann', 'a@b.lk', '  ', 'I would like to ask about warranty.')$$,
                      'P0001', 'blank subject', 'invalid_subject');
SELECT pg_temp.throws(format('SELECT public.submit_contact_inquiry(%L, %L, %L, %L)', 'Ann', 'a@b.lk', repeat('s', 256),
                             'I would like to ask about warranty.'), 'P0001', 'subject over 255', 'invalid_subject');
SELECT pg_temp.throws($$SELECT public.submit_contact_inquiry('Ann', 'a@b.lk', 'Hello', '  fourteen chr  ')$$,
                      'P0001', 'a message under 15 characters after trimming', 'invalid_message');
SELECT pg_temp.throws(format('SELECT public.submit_contact_inquiry(%L, %L, %L, %L)', 'Ann', 'a@b.lk', 'Hello', repeat('m', 5001)),
                      'P0001', 'a message over 5000 characters', 'invalid_message');
SELECT pg_temp.throws($$SELECT public.submit_contact_inquiry('Ann', 'a@b.lk', 'Hello', NULL)$$,
                      'P0001', 'NULL message', 'invalid_message');
-- the order of checks: name first, then email, subject, message
SELECT pg_temp.throws($$SELECT public.submit_contact_inquiry('', 'bad', '', '')$$, 'P0001', 'name is checked first', 'invalid_name');
SELECT pg_temp.throws($$SELECT public.submit_contact_inquiry('Ann', 'bad', '', '')$$, 'P0001', 'then the email', 'invalid_email');
SELECT pg_temp.throws($$SELECT public.submit_contact_inquiry('Ann', 'a@b.lk', '', '')$$, 'P0001', 'then the subject', 'invalid_subject');
-- boundaries that pass
SELECT public.submit_contact_inquiry('  Ann Perera ', ' Ann@Example.LK ', '  Warranty  ', '  fifteen chars!!  ');
SELECT public.submit_contact_inquiry(repeat('n', 255), 'b@example.lk', repeat('s', 255), repeat('m', 5000));
SELECT pg_temp.throws('SELECT * FROM public.contact_inquiries', '42501', 'anon cannot read inquiries');
SELECT pg_temp.throws($$INSERT INTO public.contact_inquiries (name, email, subject, message) VALUES ('x', 'x@y.lk', 's', 'a message long enough')$$,
                      '42501', 'anon cannot insert inquiries directly');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s|%s|%s|%s', name, email, subject, message, status) FROM public.contact_inquiries WHERE email = 'ann@example.lk'),
                  'Ann Perera|ann@example.lk|Warranty|fifteen chars!!|new', 'values trimmed, email lower-cased, status new');
SELECT pg_temp.eq((SELECT count(*) FROM public.contact_inquiries), 2::bigint, 'exactly the two valid inquiries were stored');
SELECT pg_temp.ok((SELECT answered_at IS NULL AND admin_reply IS NULL AND replied_by IS NULL FROM public.contact_inquiries WHERE email = 'ann@example.lk'),
                  'a new inquiry has no answer fields');

-- ── RLS: shoppers see nothing, admins hold all four verbs ────────────────────
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.contact_inquiries), 0::bigint, 'a shopper reads no inquiries');
SELECT pg_temp.eq((SELECT count(*) FROM public.newsletter_subscribers), 0::bigint, 'a shopper reads no subscribers');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.contact_inquiries SET status = 'answered'$$), 0::bigint, 'a shopper cannot update inquiries');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.newsletter_subscribers$$), 0::bigint, 'a shopper cannot delete subscribers');
SELECT pg_temp.throws($$INSERT INTO public.contact_inquiries (name, email, subject, message) VALUES ('x', 'x@y.lk', 's', 'a message long enough')$$,
                      '42501', 'a shopper cannot insert inquiries directly');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.contact_inquiries$$), 0::bigint, 'a shopper cannot delete inquiries');
SELECT pg_temp.throws('SELECT * FROM public.email_suppressions', '42501', 'a shopper cannot read suppressions');
-- all four verbs for anon on the inbox: no privilege at all (SELECT/INSERT are checked above)
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$UPDATE public.contact_inquiries SET status = 'answered'$$, '42501', 'anon cannot update inquiries');
SELECT pg_temp.throws($$DELETE FROM public.contact_inquiries$$, '42501', 'anon cannot delete inquiries');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);

SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.contact_inquiries), 2::bigint, 'the admin reads every inquiry');
SELECT pg_temp.eq((SELECT count(*) FROM public.newsletter_subscribers), 4::bigint, 'the admin reads every subscriber');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.contact_inquiries SET status = 'answered', answered_at = now(),
                                        admin_reply = 'Thanks — the warranty is 12 months.', replied_by = 'owner@shop.test'
                                     WHERE email = 'ann@example.lk'$$), 1::bigint, 'admin UPDATE (mark answered) works');
SELECT pg_temp.throws($$UPDATE public.contact_inquiries SET status = 'closed' WHERE email = 'ann@example.lk'$$, '23514',
                      'the status vocabulary is enforced', '%contact_inquiries_status_valid%');
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO public.contact_inquiries (name, email, subject, message)
                                     VALUES ('Phone call', 'caller@example.lk', 'Logged by phone', 'Customer called about delivery.')$$),
                  1::bigint, 'admin INSERT works');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.contact_inquiries WHERE email = 'b@example.lk'$$), 1::bigint, 'admin DELETE works');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.newsletter_subscribers SET confirmed_at = now() WHERE email = 'kamal@example.lk'$$),
                  1::bigint, 'admin can update a subscriber');
SELECT pg_temp.throws($$INSERT INTO public.newsletter_subscribers (email, source) VALUES ('Mixed@Case.lk', 'admin')$$, '23514',
                      'a mixed-case address cannot sneak in beside the lower-cased one', '%newsletter_subscribers_email_valid%');
SELECT pg_temp.throws('SELECT * FROM public.email_suppressions', '42501', 'even an admin cannot read the sealed suppression list');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT format('%s|%s', status, answered_at IS NOT NULL) FROM public.contact_inquiries WHERE email = 'ann@example.lk'),
                  'answered|t', 'the reply was recorded');

-- ── admin_newsletter_mailing_list: the export honours unsubscribes AND suppressions ──
SELECT pg_temp.ok(NOT has_function_privilege('anon', 'public.admin_newsletter_mailing_list()', 'EXECUTE')
              AND has_function_privilege('authenticated', 'public.admin_newsletter_mailing_list()', 'EXECUTE'),
                  'the mailing-list export is grant U (anon has no EXECUTE)');
SELECT set_config('t.sunil_tok', (SELECT unsubscribe_token FROM public.newsletter_subscribers WHERE email = 'sunil@example.lk')::text, false);
SELECT pg_temp.login_anon();
SELECT public.unsubscribe_newsletter(current_setting('t.sunil_tok')::uuid);   -- sunil unsubscribes himself
SELECT pg_temp.throws('SELECT public.admin_newsletter_mailing_list()', '42501', 'anon cannot export the list');
SELECT pg_temp.logout();
INSERT INTO public.email_suppressions (email, reason) VALUES ('ravi@example.lk', 'all');   -- a legal "never email me"
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws('SELECT public.admin_newsletter_mailing_list()', '42501', 'a shopper cannot export the list', 'not_authorised:%');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.list', public.admin_newsletter_mailing_list()::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT string_agg(e ->> 'email', ',' ORDER BY ord) FROM jsonb_array_elements(current_setting('t.list')::jsonb) WITH ORDINALITY AS x(e, ord)),
                  'nimal@example.lk,kamal@example.lk',
                  'only active, unsuppressed subscribers, oldest first (unsubscribed sunil and all-suppressed ravi are left out; a cart_recovery suppression does not matter)');
SELECT pg_temp.eq((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(current_setting('t.list')::jsonb -> 0) k),
                  ARRAY['confirmed_at', 'created_at', 'email', 'source', 'unsubscribe_token'],
                  'each row carries the unsubscribe token for the mail footer, nothing else');
SELECT pg_temp.eq((SELECT e ->> 'unsubscribe_token' FROM jsonb_array_elements(current_setting('t.list')::jsonb) e WHERE e ->> 'email' = 'kamal@example.lk'),
                  (SELECT unsubscribe_token::text FROM public.newsletter_subscribers WHERE email = 'kamal@example.lk'),
                  'the token is the subscriber''s own');
SELECT pg_temp.eq((SELECT (e ->> 'confirmed_at') IS NOT NULL FROM jsonb_array_elements(current_setting('t.list')::jsonb) e WHERE e ->> 'email' = 'kamal@example.lk'),
                  TRUE, 'confirmed_at is exported when set');
DELETE FROM public.newsletter_subscribers;
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(public.admin_newsletter_mailing_list(), '[]'::jsonb, 'an empty list exports as []');
SELECT pg_temp.logout();
