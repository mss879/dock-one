-- 11_reviews.test.sql — submit_review (signed-in only, validation, verified purchase from a
-- DELIVERED order by account or confirmed email, one per product, edits return to moderation,
-- in-DB rate limit), RLS (public approved / own / admin), the rating rollup, get_review_summary.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.ana', pg_temp.new_user('ana@shop.test', TRUE, '{"first_name":"Ana","last_name":"Perera"}')::text, false);
SELECT set_config('t.ben', pg_temp.new_user('ben@shop.test', TRUE, '{"first_name":"Ben"}')::text, false);
SELECT set_config('t.cara', pg_temp.new_user('cara@shop.test', TRUE, '{"first_name":"Cara"}')::text, false);
SELECT set_config('t.dave', pg_temp.new_user('dave@shop.test', FALSE, '{"first_name":"Dave"}')::text, false);
SELECT set_config('t.eve', pg_temp.new_user('eve@shop.test', TRUE, '{"first_name":"Eve"}')::text, false);
SELECT set_config('t.nameless', pg_temp.new_user('nameless@shop.test')::text, false);

INSERT INTO public.categories (id, name) VALUES ('rv-cat', 'Reviews');
INSERT INTO public.products (slug, brand, name, category_id) VALUES
  ('rv-p', 'RvBrand', 'Rv P', 'rv-cat'), ('rv-q', 'RvBrand', 'Rv Q', 'rv-cat'), ('rv-h', 'RvBrand', 'Rv Hidden', 'rv-cat');
INSERT INTO public.product_variants (product_id, sku, name, price)
SELECT id, upper(slug), 'Standard', 1000 FROM public.products WHERE slug LIKE 'rv-%';
UPDATE public.products SET is_active = FALSE WHERE slug = 'rv-h';
SELECT set_config('t.p', (SELECT id FROM public.products WHERE slug = 'rv-p')::text, false);
SELECT set_config('t.q', (SELECT id FROM public.products WHERE slug = 'rv-q')::text, false);
SELECT set_config('t.h', (SELECT id FROM public.products WHERE slug = 'rv-h')::text, false);
SELECT set_config('t.pv', (SELECT id FROM public.product_variants WHERE sku = 'RV-P')::text, false);
CREATE FUNCTION pg_temp.p() RETURNS int LANGUAGE sql AS $$ SELECT current_setting('t.p')::int $$;
CREATE FUNCTION pg_temp.q() RETURNS int LANGUAGE sql AS $$ SELECT current_setting('t.q')::int $$;
CREATE FUNCTION pg_temp.j(p_name text) RETURNS jsonb LANGUAGE sql AS $$ SELECT current_setting('t.' || p_name)::jsonb $$;
CREATE FUNCTION pg_temp.rating(p_id int) RETURNS text LANGUAGE sql AS
  $$ SELECT rating_avg::text || '/' || rating_count FROM public.products WHERE id = p_id $$;
CREATE FUNCTION pg_temp.body() RETURNS text LANGUAGE sql AS $$ SELECT 'Solid build, fast delivery to Kandy.' $$;

-- Orders that decide "verified purchase" (written with no JWT, as a job would):
--   Ana   — her account order containing P, DELIVERED              → verified by account
--   Ben   — his account order containing P, only accepted          → not verified
--   Cara  — a GUEST order with her confirmed email, DELIVERED      → verified by confirmed email
--   Dave  — a GUEST order with his UNCONFIRMED email, DELIVERED    → not verified
INSERT INTO public.orders (id, customer_id, email, first_name, phone, subtotal, total_price, status) VALUES
  ('DO-40001', current_setting('t.ana')::uuid, 'ana@shop.test', 'Ana', '+94771111111', 1000, 1450, 'delivered'),
  ('DO-40002', current_setting('t.ben')::uuid, 'ben@shop.test', 'Ben', '+94772222222', 1000, 1450, 'accepted'),
  ('DO-40003', NULL, 'Cara@Shop.test', 'Cara', '+94773333333', 1000, 1450, 'delivered'),
  ('DO-40004', NULL, 'dave@shop.test', 'Dave', '+94774444444', 1000, 1450, 'delivered');
INSERT INTO public.order_items (order_id, product_id, variant_id, quantity, unit_price, product_name)
SELECT o, pg_temp.p(), current_setting('t.pv')::int, 1, 1000, 'Rv P' FROM unnest(ARRAY['DO-40001', 'DO-40002', 'DO-40003', 'DO-40004']) o;

-- ── who may submit ──────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws(format('SELECT public.submit_review(%s, 5, NULL, %L, NULL)', pg_temp.p(), pg_temp.body()), '42501',
                      'anon cannot submit reviews');
SELECT pg_temp.logout();
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000b1', NULL);
SELECT pg_temp.login('00000000-0000-0000-0000-0000000000b1');
SELECT pg_temp.throws(format('SELECT public.submit_review(%s, 5, NULL, %L, NULL)', pg_temp.p(), pg_temp.body()), 'P0001',
                      'an account without a customers row cannot review', 'not_signed_in');

-- ── validation ──────────────────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.ana')::uuid);
SELECT pg_temp.throws(format('SELECT public.submit_review(%s, 0, NULL, %L, NULL)', pg_temp.p(), pg_temp.body()), 'P0001', 'rating 0', 'invalid_rating');
SELECT pg_temp.throws(format('SELECT public.submit_review(%s, 6, NULL, %L, NULL)', pg_temp.p(), pg_temp.body()), 'P0001', 'rating 6', 'invalid_rating');
SELECT pg_temp.throws(format('SELECT public.submit_review(%s, NULL, NULL, %L, NULL)', pg_temp.p(), pg_temp.body()), 'P0001', 'no rating', 'invalid_rating');
SELECT pg_temp.throws(format('SELECT public.submit_review(%s, 5, NULL, %L, NULL)', pg_temp.p(), '  too short '), 'P0001',
                      'a body under 10 characters (after trimming)', 'invalid_body');
SELECT pg_temp.throws(format('SELECT public.submit_review(%s, 5, NULL, repeat(%L, 4001), NULL)', pg_temp.p(), 'x'), 'P0001',
                      'a body over 4000 characters', 'invalid_body');
SELECT pg_temp.throws(format('SELECT public.submit_review(%s, 5, repeat(%L, 121), %L, NULL)', pg_temp.p(), 't', pg_temp.body()), 'P0001',
                      'a title over 120 characters', 'invalid_title');
SELECT pg_temp.throws(format('SELECT public.submit_review(%s, 5, NULL, %L, repeat(%L, 61))', pg_temp.p(), pg_temp.body(), 'n'), 'P0001',
                      'a public name over 60 characters', 'invalid_author_name');
SELECT pg_temp.throws(format('SELECT public.submit_review(%s, 5, NULL, %L, NULL)', current_setting('t.h'), pg_temp.body()), 'P0001',
                      'a hidden product cannot be reviewed', 'unknown_product');
SELECT pg_temp.throws(format('SELECT public.submit_review(%s, 5, NULL, %L, NULL)', 999999, pg_temp.body()), 'P0001',
                      'an unknown product', 'unknown_product');
SELECT pg_temp.login(current_setting('t.nameless')::uuid);
SELECT pg_temp.throws(format('SELECT public.submit_review(%s, 5, NULL, %L, %L)', pg_temp.p(), pg_temp.body(), '  '), 'P0001',
                      'no public name and no profile name', 'invalid_author_name');

-- ── verified purchase, default public name, one per product ──────────────────
SELECT pg_temp.login(current_setting('t.ana')::uuid);
SELECT set_config('t.a1', public.submit_review(pg_temp.p(), 5, '  Great laptop  ', '  ' || pg_temp.body() || '  ', NULL)::text, false);
SELECT pg_temp.login(current_setting('t.ben')::uuid);
SELECT set_config('t.b1', public.submit_review(pg_temp.p(), 3, NULL, pg_temp.body(), 'Ben S.')::text, false);
SELECT pg_temp.login(current_setting('t.cara')::uuid);
SELECT set_config('t.c1', public.submit_review(pg_temp.p(), 4, NULL, pg_temp.body(), NULL)::text, false);
SELECT pg_temp.login(current_setting('t.dave')::uuid);
SELECT set_config('t.d1', public.submit_review(pg_temp.p(), 2, NULL, pg_temp.body(), NULL)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('a1') ->> 'status', pg_temp.j('a1') ->> 'is_verified_purchase'), 'pending|true',
                  'Ana: held for moderation, verified by her delivered account order');
SELECT pg_temp.eq(pg_temp.j('b1') ->> 'is_verified_purchase', 'false', 'Ben: an order that is not delivered does not verify');
SELECT pg_temp.eq(pg_temp.j('c1') ->> 'is_verified_purchase', 'true', 'Cara: a delivered guest order with her CONFIRMED email verifies');
SELECT pg_temp.eq(pg_temp.j('d1') ->> 'is_verified_purchase', 'false', 'Dave: an unconfirmed email never verifies');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', author_name, title, body) FROM public.product_reviews WHERE id = (pg_temp.j('a1') ->> 'review_id')::bigint),
                  'Ana P.|Great laptop|' || pg_temp.body(), 'default public name "First L."; title and body trimmed');
SELECT pg_temp.eq((SELECT author_name FROM public.product_reviews WHERE id = (pg_temp.j('c1') ->> 'review_id')::bigint), 'Cara',
                  'first name only when there is no last name');

-- ── RLS: public sees approved, owners see their own, admins moderate ─────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT count(*) FROM public.product_reviews WHERE product_id = pg_temp.p()), 0::bigint, 'pending reviews are not public');
SELECT pg_temp.throws('SELECT customer_id FROM public.product_reviews', '42501', 'anon can never read review account ids');
SELECT pg_temp.throws('SELECT * FROM public.product_reviews', '42501', 'anon must name its columns (select * includes customer_id)');
SELECT pg_temp.throws(format('INSERT INTO public.product_reviews (product_id, author_name, rating, body) VALUES (%s, %L, 5, %L)',
                             pg_temp.p(), 'Fake', pg_temp.body()), '42501', 'anon cannot insert reviews directly');
SELECT pg_temp.login(current_setting('t.ana')::uuid);
SELECT pg_temp.eq((SELECT string_agg(author_name, ',') FROM public.product_reviews), 'Ana P.', 'Ana sees her own pending review only');
SELECT pg_temp.throws(format('INSERT INTO public.product_reviews (product_id, customer_id, author_name, rating, body, status) VALUES (%s, %L, %L, 5, %L, %L)',
                             pg_temp.q(), current_setting('t.ana'), 'Ana', pg_temp.body(), 'approved'), '42501',
                      'a shopper cannot insert (or self-approve) directly');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.product_reviews SET status = 'approved'$$), 0::bigint, 'a shopper cannot approve their own review');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.product_reviews$$), 0::bigint, 'a shopper cannot delete reviews');

SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.product_reviews), 4::bigint, 'the admin sees the moderation queue');
SELECT pg_temp.eq(pg_temp.affected(format($$UPDATE public.product_reviews SET status = 'approved', is_featured = TRUE,
                                                admin_reply = 'Thank you, Ana!' WHERE id = %s$$, pg_temp.j('a1') ->> 'review_id')), 1::bigint,
                  'the admin approves, features and replies');
SELECT pg_temp.eq(pg_temp.affected(format($$UPDATE public.product_reviews SET status = 'approved' WHERE id IN (%s, %s)$$,
                                          pg_temp.j('b1') ->> 'review_id', pg_temp.j('c1') ->> 'review_id')), 2::bigint, 'the admin approves two more');
-- moderation is honest: status / is_featured / admin_reply only; no invented reviews
SELECT pg_temp.throws(format('INSERT INTO public.product_reviews (product_id, author_name, rating, body, status) VALUES (%s, %L, 5, %L, %L)',
                             pg_temp.q(), 'Happy Customer', pg_temp.body(), 'approved'), '42501',
                      'even an admin cannot create a review (only customers, through submit_review)', 'review_insert_managed%');
SELECT pg_temp.throws(format('UPDATE public.product_reviews SET rating = 5 WHERE id = %s', pg_temp.j('b1') ->> 'review_id'), '22023',
                      'the admin cannot change a customer''s rating', 'review_field_managed:rating%');
SELECT pg_temp.throws(format('UPDATE public.product_reviews SET body = %L WHERE id = %s', 'Best purchase ever, highly recommended!', pg_temp.j('b1') ->> 'review_id'),
                      '22023', 'the admin cannot rewrite a customer''s words', 'review_field_managed:body%');
SELECT pg_temp.throws(format('UPDATE public.product_reviews SET is_verified_purchase = TRUE WHERE id = %s', pg_temp.j('b1') ->> 'review_id'),
                      '22023', 'the admin cannot award the verified-purchase badge', 'review_field_managed:is_verified_purchase%');
SELECT pg_temp.throws(format('UPDATE public.product_reviews SET customer_id = %L WHERE id = %s', current_setting('t.owner'), pg_temp.j('b1') ->> 'review_id'),
                      '22023', 'the admin cannot re-attribute a review', 'review_field_managed:customer_id%');
SELECT pg_temp.eq(pg_temp.affected(format($$UPDATE public.product_reviews SET is_featured = TRUE WHERE id = %s$$, pg_temp.j('d1') ->> 'review_id')),
                  1::bigint, 'featuring a pending review is accepted…');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT is_featured FROM public.product_reviews WHERE id = (pg_temp.j('d1') ->> 'review_id')::bigint), FALSE,
                  '…but only an approved review can be featured');
SELECT pg_temp.eq(pg_temp.rating(pg_temp.p()), '4.00/3', 'rating rollup: approved reviews only (5, 3, 4 → 4.00 over 3)');

SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT string_agg(author_name || ':' || rating || ':' || is_verified_purchase, ',' ORDER BY rating DESC)
                     FROM public.product_reviews WHERE product_id = pg_temp.p()),
                  'Ana P.:5:true,Cara:4:true,Ben S.:3:false', 'the public sees approved reviews with the verified flag');
SELECT set_config('t.sum', public.get_review_summary(pg_temp.p())::text, false);
SELECT set_config('t.sum_none', public.get_review_summary(999999)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.j('sum'),
                  jsonb_build_object('product_id', pg_temp.p(), 'total', 3, 'average', 4.00,
                                     'counts', '{"1":0,"2":0,"3":1,"4":1,"5":1}'::jsonb),
                  'get_review_summary: total, average and the star distribution (approved only)');
SELECT pg_temp.eq(pg_temp.j('sum_none'), '{"product_id":999999,"total":0,"average":0,"counts":{"1":0,"2":0,"3":0,"4":0,"5":0}}'::jsonb,
                  'get_review_summary never raises: zeros for an unknown product');

-- ── edits: one review per customer per product; a changed review is re-moderated ─
SELECT pg_temp.login(current_setting('t.ana')::uuid);
SELECT set_config('t.a2', public.submit_review(pg_temp.p(), 5, 'Great laptop', pg_temp.body(), 'Ana P.')::text, false);
SELECT set_config('t.a3', public.submit_review(pg_temp.p(), 1, 'Died after a week', 'The screen failed after seven days of use.', NULL)::text, false);
SELECT pg_temp.logout();
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('a2') ->> 'review_id' = pg_temp.j('a1') ->> 'review_id', pg_temp.j('a2') ->> 'status'), 't|approved',
                  'an identical resubmission keeps the same review and its approval');
SELECT pg_temp.eq(format('%s|%s', pg_temp.j('a3') ->> 'review_id' = pg_temp.j('a1') ->> 'review_id', pg_temp.j('a3') ->> 'status'), 't|pending',
                  'an edit updates the SAME review and sends it back to moderation');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_reviews WHERE customer_id = current_setting('t.ana')::uuid AND product_id = pg_temp.p()),
                  1::bigint, 'one review per customer per product');
SELECT pg_temp.eq(pg_temp.rating(pg_temp.p()), '3.50/2', 'the edited (now pending) review leaves the average until re-approved');
SELECT pg_temp.eq((SELECT is_featured FROM public.product_reviews WHERE id = (pg_temp.j('a1') ->> 'review_id')::bigint), FALSE,
                  'an edited review is no longer featured (the new text must be approved and featured again)');

-- ── rollup follows every moderation move ────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.affected(format($$UPDATE public.product_reviews SET status = 'rejected' WHERE id = %s$$, pg_temp.j('b1') ->> 'review_id'));
SELECT set_config('t.r1', pg_temp.rating(pg_temp.p()), false);
SELECT pg_temp.throws(format($$UPDATE public.product_reviews SET product_id = %s WHERE id = %s$$, pg_temp.q(), pg_temp.j('c1') ->> 'review_id'),
                      '22023', 'the admin cannot move a review to another product', 'review_field_managed:product_id%');
SELECT pg_temp.logout();
-- a repair from the SQL editor (no JWT) still re-computes both products
SELECT pg_temp.affected(format($$UPDATE public.product_reviews SET product_id = %s WHERE id = %s$$, pg_temp.q(), pg_temp.j('c1') ->> 'review_id'));
SELECT set_config('t.r2', pg_temp.rating(pg_temp.p()) || ' ' || pg_temp.rating(pg_temp.q()), false);
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.affected(format($$DELETE FROM public.product_reviews WHERE id = %s$$, pg_temp.j('c1') ->> 'review_id'));
SELECT set_config('t.r3', pg_temp.rating(pg_temp.q()), false);
SELECT pg_temp.eq(pg_temp.affected(format('UPDATE public.products SET rating_avg = 5, rating_count = 999 WHERE id = %s', pg_temp.p())), 1::bigint,
                  'an admin product save runs…');
SELECT pg_temp.logout();
SELECT pg_temp.eq(current_setting('t.r1'), '4.00/1', 'rejecting removes a review from the average');
SELECT pg_temp.eq(current_setting('t.r2'), '0.00/0 4.00/1', 'moving a review re-computes both products');
SELECT pg_temp.eq(current_setting('t.r3'), '0.00/0', 'deleting a review re-computes the product');
SELECT pg_temp.eq(pg_temp.rating(pg_temp.p()), '0.00/0', '…but ratings can only come from reviews (derived columns are pinned)');

-- ── in-DB rate limit: 5 successful submissions per hour per account ──────────
SELECT pg_temp.login(current_setting('t.eve')::uuid);
SELECT pg_temp.throws(format('SELECT public.submit_review(%s, 9, NULL, %L, NULL)', pg_temp.p(), pg_temp.body()), 'P0001',
                      'a refused submission…', 'invalid_rating');
SELECT public.submit_review(pg_temp.p(), 4, NULL, pg_temp.body(), NULL);
SELECT public.submit_review(pg_temp.p(), 5, NULL, pg_temp.body(), NULL);
SELECT public.submit_review(pg_temp.q(), 4, NULL, pg_temp.body(), NULL);
SELECT public.submit_review(pg_temp.q(), 3, NULL, pg_temp.body(), NULL);
SELECT set_config('t.e5', public.submit_review(pg_temp.p(), 4, NULL, pg_temp.body(), NULL)::text, false);
SELECT pg_temp.throws(format('SELECT public.submit_review(%s, 5, NULL, %L, NULL)', pg_temp.q(), pg_temp.body()), 'P0001',
                      '…costs nothing, but the 6th successful submission within the hour is throttled', 'rate_limited');
SELECT pg_temp.logout();
SELECT pg_temp.eq(pg_temp.j('e5') ->> 'status', 'pending', 'the 5th submission went through');
SELECT pg_temp.eq((SELECT count(*) FROM public.product_reviews WHERE customer_id = current_setting('t.eve')::uuid), 2::bigint,
                  'Eve holds one review per product whatever she resubmits');

-- ── a deleted account's reviews stay (anonymised link) ───────────────────────
DELETE FROM auth.users WHERE id = current_setting('t.ben')::uuid;
SELECT pg_temp.eq((SELECT COALESCE(customer_id::text, 'null') || '|' || author_name FROM public.product_reviews
                    WHERE id = (pg_temp.j('b1') ->> 'review_id')::bigint), 'null|Ben S.',
                  'deleting the account keeps the review under its public name');
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected(format('DELETE FROM public.customers WHERE id = %L', current_setting('t.eve'))), 1::bigint,
                  'an admin deletes a customer who has reviews (the foreign key''s SET NULL passes the guard)');
SELECT pg_temp.logout();
SELECT pg_temp.eq((SELECT count(*) FROM public.product_reviews WHERE customer_id IS NULL AND author_name = 'Eve'), 2::bigint,
                  'her reviews stay, detached from the deleted account');
