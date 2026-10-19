-- 43_image_housekeeping.test.sql — the owner lists the storage images in use and swaps one URL for
-- another everywhere it appears (products, categories, hero, content, past order lines); staff and
-- shoppers can do neither.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT set_config('t.staff', (public.admin_create_staff('ih-staff@shop.test', 'Counter2026', 'Ih Staff',
  '{"products": "edit", "categories": "edit", "homepage": "edit"}') ->> 'user_id'), false);
SELECT pg_temp.logout();

SELECT set_config('t.old', 'https://example.supabase.co/storage/v1/object/public/product-images/products/1/old.png', false);
SELECT set_config('t.new', 'https://example.supabase.co/storage/v1/object/public/product-images/products/1/new.webp', false);
SELECT set_config('t.other', 'https://example.supabase.co/storage/v1/object/public/product-images/products/1/other.webp', false);

INSERT INTO public.categories (id, name, stage_image_url) VALUES ('ih-cat', 'Ih Cat', current_setting('t.old'));
INSERT INTO public.products (slug, brand, name, image_urls, cutout_url, description)
VALUES ('ih-thing', 'IhBrand', 'Ih Thing', ARRAY[current_setting('t.old'), current_setting('t.other')], current_setting('t.old'),
        format('Look: ![photo](%s)', current_setting('t.old')));
INSERT INTO public.products (slug, brand, name, image_urls) VALUES ('ih-untouched', 'IhBrand', 'Ih Untouched', ARRAY[current_setting('t.other')]);
UPDATE public.hero_slides SET mobile_image_url = current_setting('t.old') WHERE id = (SELECT min(id) FROM public.hero_slides);
INSERT INTO public.orders (id, email, first_name, phone, subtotal, total_price) VALUES ('DO-29901', 'buyer@shop.test', 'Buyer', '+94771234567', 100, 100);
INSERT INTO public.order_items (order_id, quantity, unit_price, product_name, image_url)
VALUES ('DO-29901', 1, 100, 'Ih Thing', current_setting('t.old'));

-- ── who may call ────────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.throws($$SELECT * FROM public.admin_image_references()$$, '42501', 'anon cannot list images');
SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.throws($$SELECT * FROM public.admin_image_references()$$, '42501', 'a shopper cannot list images', 'not_authorised:%');
SELECT pg_temp.login(current_setting('t.staff')::uuid);
SELECT pg_temp.throws($$SELECT * FROM public.admin_image_references()$$, '42501', 'staff (even with Products: edit) cannot list images', 'not_authorised:%');
SELECT pg_temp.throws(format('SELECT public.admin_replace_image_url(%L, %L)', current_setting('t.old'), current_setting('t.new')), '42501',
                      'staff cannot swap images', 'not_authorised:%');

-- ── the owner ───────────────────────────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq((SELECT used_in FROM public.admin_image_references() WHERE url = current_setting('t.old')),
                  ARRAY['Category: Ih Cat', 'Cut-out: Ih Thing', 'Hero slide ' || (SELECT min(id) FROM public.hero_slides) || ' (phone)', 'Product: Ih Thing'],
                  'the old file is listed with every place it is used');
SELECT pg_temp.eq((SELECT used_in FROM public.admin_image_references() WHERE url = current_setting('t.other')),
                  ARRAY['Product: Ih Thing', 'Product: Ih Untouched'], 'a shared file lists both products');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.admin_image_references() WHERE url NOT LIKE '%/storage/v1/object/public/%'),
                  'site files (/images/…) are never listed');

SELECT pg_temp.throws(format('SELECT public.admin_replace_image_url(%L, %L)', current_setting('t.old'), '/images/hero/opening.webp'), '22023',
                      'only storage URLs can be swapped in', 'invalid_image_url:%');
SELECT pg_temp.throws(format('SELECT public.admin_replace_image_url(%L, %L)', current_setting('t.old'), current_setting('t.old')), '22023',
                      'the same URL is refused', 'invalid_image_url:%');

SELECT pg_temp.eq(public.admin_replace_image_url(current_setting('t.old'), current_setting('t.new')), 4,
                  'one swap updates the product, category, hero slide and order line (4 rows)');
SELECT pg_temp.eq((SELECT format('%s|%s|%s', image_url = current_setting('t.new'), image_urls = ARRAY[current_setting('t.new'), current_setting('t.other')],
                                 cutout_url = current_setting('t.new'))
                     FROM public.products WHERE slug = 'ih-thing'), 't|t|t', 'main image, gallery order and cut-out all point at the new file');
SELECT pg_temp.ok((SELECT strpos(description, current_setting('t.new')) > 0 AND strpos(description, current_setting('t.old')) = 0
                     FROM public.products WHERE slug = 'ih-thing'), 'images inside the description are swapped too');
SELECT pg_temp.eq((SELECT stage_image_url FROM public.categories WHERE id = 'ih-cat'), current_setting('t.new'), 'the category stage');
SELECT pg_temp.eq((SELECT mobile_image_url FROM public.hero_slides WHERE id = (SELECT min(id) FROM public.hero_slides)), current_setting('t.new'), 'the hero phone image');
SELECT pg_temp.eq((SELECT image_url FROM public.order_items WHERE order_id = 'DO-29901'), current_setting('t.new'), 'past order lines keep showing the picture');
SELECT pg_temp.eq((SELECT image_urls FROM public.products WHERE slug = 'ih-untouched'), ARRAY[current_setting('t.other')], 'unrelated products are untouched');
SELECT pg_temp.ok(NOT EXISTS (SELECT 1 FROM public.admin_image_references() WHERE url = current_setting('t.old')), 'nothing uses the old file any more');
SELECT pg_temp.eq(public.admin_replace_image_url(current_setting('t.old'), current_setting('t.new')), 0, 'running it again changes nothing');
SELECT pg_temp.logout();
