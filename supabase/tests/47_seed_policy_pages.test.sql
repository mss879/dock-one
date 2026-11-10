-- 47_seed_policy_pages.test.sql — the policy pages for the card gateway: Terms & conditions (/terms)
-- and the Refund policy (/returns), published in their footer columns, every store fact a settings
-- token (never a copied value); 33's privacy template filled in without touching the rest of it;
-- readable by anon; idempotent; never overwrites the owner's own pages.
\ir _helpers.sql

-- ── 1. what the seed stored ──────────────────────────────────────────────────
SELECT pg_temp.eq((SELECT string_agg(format('%s|%s|%s|%s|%s', slug, title, is_published, footer_group, sort_order), ' ' ORDER BY slug)
                     FROM public.cms_pages WHERE slug IN ('terms', 'returns')),
                  'returns|Refund policy|t|customer_service|10 terms|Terms & conditions|t|legal|5',
                  'terms (Legal) and the refund policy (Customer service) are published, once each');
SELECT pg_temp.ok((SELECT bool_and(summary IS NOT NULL AND show_in_footer AND cover_image IS NULL AND seo_title IS NULL AND seo_description IS NULL)
                     FROM public.cms_pages WHERE slug IN ('terms', 'returns')),
                  'each has a summary and no invented SEO copy or image');
SELECT pg_temp.ok(EXISTS (SELECT 1 FROM public.app_config WHERE name = 'seed_47_policy_pages'), 'the seed marker is recorded');

-- ── 2. store facts are settings tokens, never copied values (P6) ─────────────
SELECT pg_temp.eq(
  (SELECT coalesce(array_agg(needle), '{}')
     FROM unnest(ARRAY['{store_name}', '{address}', '{email}', '{phone}', '{whatsapp}', '{business_reg_no}', '{opening_hours}',
                       '{payment_methods}', '{cod_max_total}', '{delivery_fee}', '{free_delivery_threshold}', '{pickup_address}',
                       '{returns_window_days}', '{warranty_note}']) AS needle
    WHERE position(needle IN (SELECT content FROM public.cms_pages WHERE slug = 'terms')) = 0),
  '{}'::text[], 'the terms quote every store fact through a token');
SELECT pg_temp.eq(
  (SELECT coalesce(array_agg(needle), '{}')
     FROM unnest(ARRAY['{store_name}', '{returns_window_days}', '{phone}', '{whatsapp}', '{email}', '{address}']) AS needle
    WHERE position(needle IN (SELECT content FROM public.cms_pages WHERE slug = 'returns')) = 0),
  '{}'::text[], 'the refund policy quotes the returns window and the contact details through tokens');
SELECT pg_temp.ok(
  NOT EXISTS (SELECT 1 FROM public.cms_pages
               WHERE slug IN ('terms', 'returns') AND content ~ '(Rs\.|\+94|Colombo|dockonesolutions|Unity Plaza|\m[0-9]{3,}\M)'),
  'no fee, phone, address, email or amount is written into the two new pages (they come from Settings)');
SELECT pg_temp.ok((SELECT content FROM public.cms_pages WHERE slug = 'privacy') !~ '(\+94|Colombo|dockonesolutions\.com|Unity Plaza)',
                  'nor into the privacy page: its filled-in facts are tokens too');
SELECT pg_temp.ok(
  (SELECT bool_and(position(needle IN (SELECT content FROM public.cms_pages WHERE slug = 'returns')) > 0)
     FROM unnest(ARRAY['**Card:**', '**Bank transfer:**', '**Cash on delivery:**', 'within 7 working days', '7–14 working days',
                       '## Cancelled orders', '## Faulty, damaged or wrong items', '[Terms & conditions](/terms)']) AS needle),
  'the refund policy covers card, bank-transfer and cash-on-delivery refunds, timings, cancellations and faulty items');
SELECT pg_temp.ok(
  (SELECT bool_and(position(needle IN (SELECT content FROM public.cms_pages WHERE slug = 'terms')) > 0)
     FROM unnest(ARRAY['## Who we are', '## Payment', '## Delivery and collection', '## Warranty', '[Refund policy](/returns)',
                       '[Privacy policy](/privacy)', 'always charged in LKR', 'laws of Sri Lanka']) AS needle),
  'the terms cover who we are, payment, delivery, warranty and the law, and link the other two policies');

-- ── 3. the privacy template, filled in ───────────────────────────────────────
SELECT pg_temp.eq(
  (SELECT coalesce(array_agg(needle), '{}')
     FROM unnest(ARRAY['Template — have it reviewed', '[BUSINESS NAME]', '[POSTAL ADDRESS]', '[CONTACT EMAIL]', '[HOSTING PROVIDER]',
                       '[HOW LONG YOU KEEP ORDER RECORDS', '[ANY OTHER SERVICE YOU USE', '[square brackets]']) AS needle
    WHERE position(needle IN (SELECT content FROM public.cms_pages WHERE slug = 'privacy')) > 0),
  '{}'::text[], 'no placeholder and no "Template" note is left on the privacy page');
SELECT pg_temp.ok((SELECT content FROM public.cms_pages WHERE slug = 'privacy') LIKE '## Who we are%', 'it now opens with "Who we are"');
SELECT pg_temp.ok(
  (SELECT bool_and(position(needle IN (SELECT content FROM public.cms_pages WHERE slug = 'privacy')) > 0)
     FROM unnest(ARRAY['This website is run by {store_name}, {address}.', 'email {email} or write to us', '- **Netlify** — runs this website',
                       '| Orders | As long as we need them for our accounts, tax records and warranty claims; they are not deleted automatically |']) AS needle),
  'the business name, address and email are tokens, the host is Netlify, and order records have a stated period');
SELECT pg_temp.ok(
  (SELECT bool_and(position(needle IN (SELECT content FROM public.cms_pages WHERE slug = 'privacy')) > 0)
     FROM unnest(ARRAY['### Orders', '**Supabase**', '**Resend**', '**OpenAI**', '| 90 days', '`dockone.cart.v2`', 'corrected or deleted']) AS needle),
  'the rest of the template is untouched');

-- ── 4. the storefront reads them as anon ─────────────────────────────────────
SELECT pg_temp.login_anon();
SELECT pg_temp.eq((SELECT count(*) FROM public.cms_pages WHERE slug IN ('terms', 'returns', 'privacy') AND is_published), 3::bigint,
                  'anon reads all three policy pages (RLS: published)');
SELECT pg_temp.logout();

-- ── 5. idempotent, and the owner's own pages win ─────────────────────────────
\ir ../migrations/47_seed_policy_pages.sql
SELECT pg_temp.eq((SELECT count(*) FROM public.cms_pages WHERE slug IN ('terms', 'returns')), 2::bigint, 'a re-run adds nothing');

UPDATE public.cms_pages SET content = 'Our own terms.' WHERE slug = 'terms';
UPDATE public.cms_pages SET content = 'Who we are: Example Ltd, example@shop.test.' WHERE slug = 'privacy';
DELETE FROM public.cms_pages WHERE slug = 'returns';
DELETE FROM public.app_config WHERE name = 'seed_47_policy_pages';
\ir ../migrations/47_seed_policy_pages.sql
SELECT pg_temp.eq((SELECT content FROM public.cms_pages WHERE slug = 'terms'), 'Our own terms.', 'an owner''s terms page is never overwritten');
SELECT pg_temp.eq((SELECT content FROM public.cms_pages WHERE slug = 'privacy'), 'Who we are: Example Ltd, example@shop.test.',
                  'a privacy page with no placeholders left is never touched');
SELECT pg_temp.eq((SELECT title FROM public.cms_pages WHERE slug = 'returns'), 'Refund policy', 'with the marker gone, a deleted refund policy comes back');

DELETE FROM public.cms_pages WHERE slug = 'returns';
\ir ../migrations/47_seed_policy_pages.sql
SELECT pg_temp.eq((SELECT count(*) FROM public.cms_pages WHERE slug = 'returns'), 0::bigint, 'while the marker stays, a deleted page stays deleted');
