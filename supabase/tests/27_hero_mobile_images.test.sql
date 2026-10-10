-- 27_hero_mobile_images.test.sql — the optional phone image on hero slides: same link rule as
-- image_url, admin-writable, publicly readable with the slide, NULL by default.
\ir _helpers.sql

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
DELETE FROM public.hero_slides;

SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO public.hero_slides (image_url, mobile_image_url, background, title)
    VALUES ('/images/hero/opening.webp', '/images/hero/opening-mobile.webp', '#07070b', 'With phone image'),
           ('/images/hero/laptops.webp', NULL, '#f6f7f9', 'Without phone image')$$),
  2::bigint, 'the admin saves slides with and without a mobile image');
SELECT pg_temp.eq((SELECT mobile_image_url FROM public.hero_slides WHERE title = 'Without phone image'), NULL::text,
                  'mobile_image_url defaults to NULL');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.hero_slides
    SET mobile_image_url = 'https://abc.supabase.co/storage/v1/object/public/content-images/homepage/hero/m.webp'
    WHERE title = 'Without phone image'$$), 1::bigint, 'an uploaded (https) mobile image is accepted');

SELECT pg_temp.throws($$UPDATE public.hero_slides SET mobile_image_url = 'http://example.com/a.webp'$$,
                      '23514', 'a plain-http mobile image', '%hero_slides_mobile_image_valid%');
SELECT pg_temp.throws($$UPDATE public.hero_slides SET mobile_image_url = '//evil.example/a.webp'$$,
                      '23514', 'a protocol-relative mobile image', '%hero_slides_mobile_image_valid%');
SELECT pg_temp.throws($$UPDATE public.hero_slides SET mobile_image_url = 'javascript:alert(1)'$$,
                      '23514', 'a javascript: mobile image', '%hero_slides_mobile_image_valid%');
SELECT pg_temp.throws($$UPDATE public.hero_slides SET mobile_image_url = '/images/a b.webp'$$,
                      '23514', 'a mobile image path with a space', '%hero_slides_mobile_image_valid%');

SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT mobile_image_url FROM public.hero_slides WHERE title = 'With phone image'),
                  '/images/hero/opening-mobile.webp', 'anon reads the mobile image of a live slide');
SELECT pg_temp.throws($$UPDATE public.hero_slides SET mobile_image_url = NULL$$, '42501', 'anon cannot change it');
