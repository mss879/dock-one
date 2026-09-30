-- 33_seed_content_pages.test.sql — the privacy page TEMPLATE (blueprint §12.1.6): exactly one
-- published page in the Legal footer column that names every collection point, retention period,
-- processor and storage key of this build; nothing else seeded (no terms/returns/posts —
-- nothing invented); readable by anon; idempotent; never overwrites the owner's page; removable
-- for good.
\ir _helpers.sql

-- ── 1. what the seed stored ──────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT count(*) FROM public.cms_pages WHERE slug = 'privacy'), 1::bigint, 'seed 33 stores the privacy page once');
SELECT pg_temp.ok(
  EXISTS (SELECT 1 FROM public.cms_pages
           WHERE slug = 'privacy' AND title = 'Privacy policy' AND is_published AND show_in_footer
             AND footer_group = 'legal' AND sort_order = 10 AND cover_image IS NULL
             AND seo_title IS NULL AND seo_description IS NULL AND summary IS NOT NULL),
  'privacy is published, in the Legal footer column, with a summary and no invented SEO copy or image');
SELECT pg_temp.eq((SELECT count(*) FROM public.cms_pages), 1::bigint, 'no other page is seeded (terms, returns, about … are the owner''s)');
SELECT pg_temp.eq((SELECT count(*) FROM public.cms_pages WHERE slug IN ('terms', 'returns', 'refund', 'cookies', 'about', 'delivery', 'warranty')), 0::bigint,
                  'terms and returns are not seeded (their routes stay 404 until the owner publishes them)');
SELECT pg_temp.eq((SELECT count(*) FROM public.blog_posts), 0::bigint, 'no blog post is seeded');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.app_config WHERE name = 'seed_33_content_pages'), 'the seed marker is recorded');

-- ── 2. it is marked as a template and leaves the business facts as placeholders ──
SELECT pg_temp.ok((SELECT content FROM public.cms_pages WHERE slug = 'privacy') LIKE '> **Template — have it reviewed.**%',
                  'the page opens with the "Template — have it reviewed" note');
SELECT pg_temp.eq(
  (SELECT array_agg(p ORDER BY p) FROM unnest(ARRAY['[BUSINESS NAME]', '[POSTAL ADDRESS]', '[CONTACT EMAIL]', '[HOSTING PROVIDER]']) AS p
    WHERE position(p IN (SELECT content FROM public.cms_pages WHERE slug = 'privacy')) > 0),
  ARRAY['[BUSINESS NAME]', '[CONTACT EMAIL]', '[HOSTING PROVIDER]', '[POSTAL ADDRESS]'],
  'the business name, address, contact email and host are placeholders (never invented)');
SELECT pg_temp.ok(
  (SELECT content FROM public.cms_pages WHERE slug = 'privacy') !~ '(dockone\.lk|hello@|\+94|Galle Road|Colombo 0)',
  'no placeholder contact detail from the old site copy is presented as real');

-- ── 3. §12.1.6: it lists everything collected (§12.2), how long it is kept (§12.5) and who processes it ──
SELECT pg_temp.eq(
  (SELECT coalesce(array_agg(needle), '{}')
     FROM unnest(ARRAY[
       -- §12.2 collection points, in the order the blueprint lists them
       '### Orders', 'phone number', 'delivery note', 'discount code', 'cash on delivery or bank transfer', 'exchange rate',
       'A copy of each new order, with your contact and delivery details, is also emailed to our own inbox',
       '### Checkout details saved before you order', 'saved automatically as you type', 'up to three reminders',
       'restore the basket', 'stop the reminders', 'do-not-remind list',
       '### Newsletter', 'with the form on our home page', 'where you signed up', 'unsubscribe',
       '### Messages you send us', 'name, email address, subject and message', 'Each message is also emailed to our own inbox',
       '### The product finder', 'what you are shopping for', 'the products it showed you (up to three)',
       'scores out of 10 for performance, portability, battery life, value and weight', 'if you are signed in, your account',
       'add you to our newsletter',
       '### The shopping assistant', 'replaced by placeholders', 'If you are signed in, the chat is linked to your account',
       'The photo itself is not stored', 'OpenAI',
       'the order number and email address you type into it are never sent to the AI', 'the list of products in it is added to the conversation',
       '### Order look-ups in the assistant', 'after the @', 'never the full address',
       '### Browsing statistics — only if you allow them', 'none of this is recorded',
       '### Saved items', '### Your account', 'default delivery address', '### Reviews', 'display name',
       '### Protection against abuse', 'one-way codes', 'deleted after a day',
       -- §12.5 retention, as 22_retention.sql implements it
       '| 90 days', '| 12 months |', '| 30 days |', '| 13 months |', '| 1 day |', 'not deleted automatically',
       -- processors actually used
       '**Supabase**', '**Resend**', '**OpenAI**', 'exchange-rate service', 'no personal data is sent',
       'no third-party advertising or tracking scripts',
       -- browser storage keys in use (lib/*.ts, components/**)
       '`dockone.cart.v2`', '`dockone.wishlist.v2`', '`dockone.currency.v1`', '`dockone.offer.v1`', '`dockone.consent.v1`',
       '`dockone.assistant.v1`', '`dockone.assistant.nudge-off.v1`', '`dockone.rates.v1`', '`dockone.checkout.id`',
       '`dockone.order.v1`', '`dockone.viewed.v1`', '`dockone.finder.v1`', '`dockone.assistant.nudges.v1`',
       '`dockone.analytics.v1`', '`sb-…-auth-token`', '`dockone_site_access`',
       -- how to ask for erasure
       'corrected or deleted'
     ]) AS needle
    WHERE position(needle IN (SELECT content FROM public.cms_pages WHERE slug = 'privacy')) = 0),
  '{}'::text[],
  'the page names every collection point, retention period, processor, storage key and the erasure route');
SELECT pg_temp.ok(
  (SELECT content FROM public.cms_pages WHERE slug = 'privacy') !~* '(card number|cvv|encrypted payment|we never share|we do not sell|gdpr)',
  'no claim the system cannot back (card data, "encrypted", "never share/sell", other jurisdictions'' laws)');
SELECT pg_temp.ok(
  (SELECT content FROM public.cms_pages WHERE slug = 'privacy') !~* '(in the footer, or|footer newsletter|sign up .{0,40}footer)',
  'the newsletter section names only the signup points that exist (the home page form and the finder email) — the footer has no signup form');
SELECT pg_temp.ok(
  (SELECT content FROM public.cms_pages WHERE slug = 'privacy') !~* 'until you ask us to delete them \(or unsubscribe\)',
  'unsubscribing is not presented as deletion (the row stays, marked unsubscribed, on the do-not-email list)');

-- ── 4. the storefront reads it as anon (RLS: published rows only) ────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT title FROM public.cms_pages WHERE slug = 'privacy'), 'Privacy policy', 'anon reads the published privacy page');
SELECT pg_temp.eq((SELECT string_agg(slug, ',') FROM public.cms_pages WHERE show_in_footer AND footer_group = 'legal'), 'privacy',
                  'the footer''s Legal column lists privacy');
SELECT pg_temp.logout();

-- ── 5. idempotent, and never overwrites the owner's page ─────────────────────
UPDATE public.cms_pages SET title = 'Privacy', content = 'The owner''s own words.' WHERE slug = 'privacy';
\ir ../migrations/33_seed_content_pages.sql
SELECT pg_temp.eq((SELECT count(*) FROM public.cms_pages WHERE slug = 'privacy'), 1::bigint, 'a second run is a no-op');
SELECT pg_temp.eq((SELECT content FROM public.cms_pages WHERE slug = 'privacy'), 'The owner''s own words.', 're-running never overwrites the owner''s edits');

-- without the marker (a fresh database where the owner already wrote a privacy page) ON CONFLICT keeps theirs
DELETE FROM public.app_config WHERE name = 'seed_33_content_pages';
\ir ../migrations/33_seed_content_pages.sql
SELECT pg_temp.eq((SELECT title FROM public.cms_pages WHERE slug = 'privacy'), 'Privacy', 'an existing privacy page is left unchanged (ON CONFLICT DO NOTHING)');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.app_config WHERE name = 'seed_33_content_pages'), 'and the marker is recorded again');

-- ── 6. removable for good ────────────────────────────────────────────────────
DELETE FROM public.cms_pages WHERE slug = 'privacy';
\ir ../migrations/33_seed_content_pages.sql
SELECT pg_temp.eq((SELECT count(*) FROM public.cms_pages WHERE slug = 'privacy'), 0::bigint, 're-running the migrations never brings the template back');
