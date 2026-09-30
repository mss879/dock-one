-- 15_content_pages.test.sql — CMS publish gating (anon and shoppers see published rows only),
-- admin all four verbs, slug/footer/url/tag constraints, the blog published_at default.
\ir _helpers.sql

-- Seed 33 publishes the privacy page template (tested in 33_seed_content_pages.test.sql); this file
-- tests the tables themselves, so it starts from empty ones.
DELETE FROM public.cms_pages;
DELETE FROM public.blog_posts;

SELECT set_config('t.owner', pg_temp.new_user('owner@shop.test')::text, false);
SELECT pg_temp.make_admin(current_setting('t.owner')::uuid);
SELECT set_config('t.shopper', pg_temp.new_user('shopper@shop.test')::text, false);

-- ── the admin writes pages and posts ────────────────────────────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO public.cms_pages (slug, title, content, is_published, show_in_footer, footer_group, sort_order)
                                     VALUES ('privacy', 'Privacy policy', 'We collect…', TRUE, TRUE, 'legal', 10),
                                            ('terms', 'Terms', 'Draft terms', FALSE, TRUE, 'legal', 20),
                                            ('delivery', 'Delivery', 'Island-wide…', TRUE, FALSE, NULL, 100)$$),
                  3::bigint, 'the admin inserts pages');
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO public.blog_posts (slug, title, content, author, tags, is_published, cover_image)
                                     VALUES ('ssd-guide', 'Choosing an SSD', 'NVMe vs SATA…', 'Dock One', ARRAY['storage','guides'], TRUE, '/images/blog/ssd.webp'),
                                            ('draft-post', 'Draft', 'Not yet', NULL, '{}', FALSE, NULL),
                                            ('dated-post', 'Dated', 'Old news', NULL, '{}', TRUE, 'https://cdn.example.com/a.webp')$$),
                  3::bigint, 'the admin inserts posts');
UPDATE public.blog_posts SET published_at = '2025-01-15 10:00+05:30' WHERE slug = 'dated-post';
SELECT pg_temp.logout();

SELECT pg_temp.ok((SELECT published_at > now() - interval '1 minute' FROM public.blog_posts WHERE slug = 'ssd-guide'),
                  'a post published without a date gets now()');
SELECT pg_temp.eq((SELECT published_at FROM public.blog_posts WHERE slug = 'draft-post'), NULL::timestamptz, 'a draft has no publish date');
SELECT pg_temp.eq((SELECT published_at FROM public.blog_posts WHERE slug = 'dated-post'), '2025-01-15 10:00+05:30'::timestamptz,
                  'an explicit publish date is kept');
UPDATE public.blog_posts SET is_published = FALSE WHERE slug = 'dated-post';
UPDATE public.blog_posts SET is_published = TRUE WHERE slug = 'dated-post';
SELECT pg_temp.eq((SELECT published_at FROM public.blog_posts WHERE slug = 'dated-post'), '2025-01-15 10:00+05:30'::timestamptz,
                  'unpublish + republish keeps the original date');

-- ── publish gating ──────────────────────────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT string_agg(slug, ',' ORDER BY slug) FROM public.cms_pages), 'delivery,privacy', 'anon sees published pages only');
SELECT pg_temp.eq((SELECT string_agg(slug, ',' ORDER BY slug) FROM public.blog_posts), 'dated-post,ssd-guide', 'anon sees published posts only');
SELECT pg_temp.eq((SELECT count(*) FROM public.cms_pages WHERE slug = 'terms'), 0::bigint, 'an unpublished page is invisible (a real 404)');
SELECT pg_temp.eq((SELECT string_agg(slug, ',') FROM public.cms_pages WHERE show_in_footer), 'privacy',
                  'footer links come only from published pages');
SELECT pg_temp.throws($$INSERT INTO public.cms_pages (slug, title, content) VALUES ('x', 'x', 'x')$$, '42501', 'anon cannot insert pages');
SELECT pg_temp.throws($$UPDATE public.blog_posts SET title = 'hacked'$$, '42501', 'anon cannot update posts');
SELECT pg_temp.throws($$DELETE FROM public.cms_pages$$, '42501', 'anon cannot delete pages');

SELECT pg_temp.login(current_setting('t.shopper')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.cms_pages), 2::bigint, 'a shopper sees published pages only');
SELECT pg_temp.eq((SELECT count(*) FROM public.blog_posts), 2::bigint, 'a shopper sees published posts only');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.cms_pages SET title = 'hacked'$$), 0::bigint, 'a shopper updates nothing');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.blog_posts$$), 0::bigint, 'a shopper deletes nothing');
SELECT pg_temp.throws($$INSERT INTO public.blog_posts (slug, title, content) VALUES ('x', 'x', 'x')$$, '42501', 'a shopper cannot insert posts');

SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq((SELECT count(*) FROM public.cms_pages), 3::bigint, 'the admin sees drafts too');
SELECT pg_temp.eq((SELECT count(*) FROM public.blog_posts), 3::bigint, 'the admin sees draft posts too');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.cms_pages SET is_published = TRUE WHERE slug = 'terms'$$), 1::bigint, 'the admin publishes');
SELECT pg_temp.eq(pg_temp.affected($$DELETE FROM public.blog_posts WHERE slug = 'draft-post'$$), 1::bigint, 'the admin deletes');

-- ── constraints (named, for the admin form) ─────────────────────────────────
SELECT pg_temp.throws($$INSERT INTO public.cms_pages (slug, title, content) VALUES ('Bad Slug', 'x', 'x')$$, '23514', 'slug format', '%cms_pages_slug_format%');
SELECT pg_temp.throws($$INSERT INTO public.cms_pages (slug, title, content) VALUES ('privacy', 'x', 'x')$$, '23505', 'slug unique', '%cms_pages_slug_key%');
SELECT pg_temp.throws($$INSERT INTO public.cms_pages (slug, title, content, footer_group) VALUES ('x1', 'x', 'x', 'shop')$$, '23514',
                      'footer group vocabulary', '%cms_pages_footer_group_valid%');
SELECT pg_temp.throws($$INSERT INTO public.cms_pages (slug, title, content, show_in_footer) VALUES ('x2', 'x', 'x', TRUE)$$, '23514',
                      'a footer page needs a group', '%cms_pages_footer_needs_group%');
SELECT pg_temp.throws($$INSERT INTO public.cms_pages (slug, title, content) VALUES ('x3', '  ', 'x')$$, '23514', 'a blank title', '%cms_pages_text_lengths%');
SELECT pg_temp.throws($$INSERT INTO public.cms_pages (slug, title, content, cover_image) VALUES ('x4', 'x', 'x', 'javascript:alert(1)')$$, '23514',
                      'a javascript: cover image', '%cms_pages_text_lengths%');
SELECT pg_temp.throws($$INSERT INTO public.cms_pages (slug, title, content, cover_image) VALUES ('x5', 'x', 'x', '//evil.example/a.png')$$, '23514',
                      'a protocol-relative cover image', '%cms_pages_text_lengths%');
SELECT pg_temp.throws($$INSERT INTO public.blog_posts (slug, title, content, cover_image) VALUES ('x6', 'x', 'x', 'http://plain.example/a.png')$$, '23514',
                      'a plain-http cover image', '%blog_posts_text_lengths%');
SELECT pg_temp.throws($$INSERT INTO public.blog_posts (slug, title, content, tags) VALUES ('x7', 'x', 'x', ARRAY['ok', ''])$$, '23514',
                      'an empty tag', '%blog_posts_tags_valid%');
SELECT pg_temp.throws(format('INSERT INTO public.blog_posts (slug, title, content, tags) VALUES (%L, %L, %L, %L)', 'x8', 'x', 'x',
                             ARRAY[repeat('t', 41)]), '23514', 'a tag over 40 characters', '%blog_posts_tags_valid%');
SELECT pg_temp.throws($$INSERT INTO public.blog_posts (slug, title, content) VALUES ('x9', 'x', NULL)$$, '23502', 'content is required');
SELECT pg_temp.logout();

-- ── as lib/cms.ts and the admin Content tab use the tables ───────────────────
SELECT pg_temp.login(current_setting('t.owner')::uuid);
SELECT pg_temp.eq(pg_temp.affected($$INSERT INTO public.blog_posts (slug, title, content) VALUES ('later', 'Later', 'Draft first')$$), 1::bigint,
                  'the admin saves a draft post');
SELECT pg_temp.eq((SELECT published_at FROM public.blog_posts WHERE slug = 'later'), NULL::timestamptz, 'the draft has no publish date');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.blog_posts SET is_published = TRUE WHERE slug = 'later'$$), 1::bigint, 'the admin publishes it later');
SELECT pg_temp.ok((SELECT published_at > now() - interval '1 minute' FROM public.blog_posts WHERE slug = 'later'), 'publishing a draft dates it then');
SELECT pg_temp.eq(pg_temp.affected($$UPDATE public.cms_pages SET is_published = FALSE WHERE id = (SELECT id FROM public.cms_pages WHERE slug = 'privacy')$$), 1::bigint,
                  'the tab''s quick "Unpublish" (one guarded row) works');
SELECT pg_temp.eq((SELECT count(*) FROM public.cms_pages WHERE slug = 'privacy' AND id <> (SELECT id FROM public.cms_pages WHERE slug = 'delivery')), 1::bigint,
                  'the slug-taken hint (slug = x, id <> own id) finds another page''s slug');
SELECT pg_temp.logout();

SELECT pg_temp.login_anon();
-- lib/cms.ts listPosts: published only, published_at DESC then id DESC; getPage/getPost: slug + is_published
SELECT pg_temp.eq((SELECT string_agg(slug, ',' ORDER BY published_at DESC, id DESC) FROM public.blog_posts WHERE is_published), 'later,ssd-guide,dated-post',
                  'the blog list reads newest publish date first');
SELECT pg_temp.eq((SELECT count(*) FROM public.cms_pages WHERE slug = 'privacy' AND is_published), 0::bigint, 'an unpublished page is gone from the storefront at once');
SELECT pg_temp.eq((SELECT string_agg(slug, ',') FROM public.cms_pages WHERE show_in_footer), 'terms', 'and from the footer (only the published terms page is listed now)');
SELECT pg_temp.logout();
