-- ═════════════════════════════════════════════════════════════════════════════
-- 47_seed_policy_pages.sql — Dock One Solutions
--
-- PURPOSE      The policy pages the card payment gateway (WebXPay) asked to see on the website,
--              written from what this store actually does, published and linked in the footer
--              and next to "Place order" at checkout:
--                * /terms    "Terms & conditions"  — footer: Legal
--                * /returns  "Refund policy"       — footer: Customer service
--              and 33's privacy TEMPLATE finished: its [PLACEHOLDERS] filled in and the
--              "Template — have it reviewed" note removed. Only the template's own placeholder
--              text is replaced, so anything the owner already wrote stays as it is.
--              Every store fact is a SETTINGS TOKEN — {store_name}, {address}, {email}, {phone},
--              {whatsapp}, {business_reg_no}, {opening_hours}, {payment_methods},
--              {cod_max_total}, {delivery_fee}, {free_delivery_threshold}, {pickup_address},
--              {returns_window_days}, {warranty_note} — filled in from store_settings whenever
--              the page is shown (lib/page-tokens.ts). The pages therefore can't disagree with
--              Settings (P6 — the reason 33 left them out): change the delivery fee or the returns
--              window in Settings and every page follows. A line whose setting is empty is left
--              out (the registration number and opening hours appear once they are set).
--              The pages state a few business commitments that no setting holds — read them and
--              edit them in admin → Pages & blog if they differ: approved refunds sent within 7
--              working days; card refunds usually 7–14 working days at the bank; cancellation
--              free until dispatch; change-of-mind returns unused and complete, return postage
--              and the delivery fee not refunded; bank-transfer orders sent once paid; warranty
--              excludes accidents, misuse, liquids and outside repairs.
-- ORDER        Deploy the code that fills in the tokens FIRST (the commit that adds
--              lib/page-tokens.ts), then run this file. Run before that deploy, the three pages
--              would show the {tokens} as written until it lands.
-- DEPENDS ON   01_foundation (app_config), 15_content_pages, 33_seed_content_pages (the template).
-- RULES        one atomic DO block guarded by the app_config marker 'seed_47_policy_pages';
--              ON CONFLICT (slug) DO NOTHING — a terms or returns page the owner already wrote is
--              never touched; self-verifying (RAISE ⇒ the whole seed rolls back).
-- SAFE TO RE-RUN: yes (a second run is a no-op).
-- ═════════════════════════════════════════════════════════════════════════════

DO $seed$
DECLARE
  c_marker   CONSTANT TEXT := 'seed_47_policy_pages';
  c_note     CONSTANT TEXT := '> **Template — have it reviewed.** This page was written from what this website actually collects and does. Before launch, replace everything in [square brackets] with your own details, have the page reviewed by someone who knows Sri Lanka''s data-protection law, and then delete this note.';
  v_terms    INT;
  v_returns  INT;
  v_privacy  INT;
  v_missing  TEXT[];
  v_left     TEXT[];
  p          public.cms_pages%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_config WHERE name = c_marker) THEN
    RAISE NOTICE '47_seed_policy_pages: already applied (app_config %) — skipped', c_marker;
    RETURN;
  END IF;

  -- ── Terms & conditions ─────────────────────────────────────────────────────
  INSERT INTO public.cms_pages (slug, title, summary, content, is_published, show_in_footer, footer_group, sort_order)
  VALUES (
    'terms',
    'Terms & conditions',
    'The terms for shopping with {store_name}: orders, prices, payment, delivery, warranty and returns.',
    $terms$These terms apply when you shop with {store_name} on this website. Please read them before you place an order: by placing one, you agree to them. If anything is unclear, get in touch before you buy.

## Who we are

This website is run by {store_name}.

- Address: {address}
- Business registration number: {business_reg_no}
- Phone: {phone}
- WhatsApp: {whatsapp}
- Email: {email}
- Opening hours: {opening_hours}

You can also write to us through our [contact page](/contact).

## Products and prices

- We describe and photograph every product as accurately as we can. Colours can look slightly different on your screen, and a photo can show something that isn't included: the product's description says what you get.
- All prices are in Sri Lankan rupees (LKR). If you pick another currency at the top of the page, prices are converted only as a guide; you are always charged in LKR.
- Prices and stock can change. You pay the price shown at checkout when you place your order.
- If a price was shown wrongly by mistake, we contact you before we go ahead: you can buy at the correct price or cancel, free of charge.

## Orders

- When you place an order, you get an order number and we email you a confirmation. Use the number to follow your order on our [track order](/track) page.
- An order is accepted once we confirm or dispatch it. We may decline or cancel an order, for example if an item is out of stock, a price was wrong, or we can't confirm the order with you. If you have already paid, we refund you in full.
- To change or cancel an order, contact us as soon as you can. You can cancel free of charge until the order is dispatched (or, for showroom pickup, collected). After that, our [Refund policy](/returns) applies.

## Payment

We accept {payment_methods}.

- **Cash on delivery:** pay in cash when you receive your order.
- Cash on delivery is available for orders up to {cod_max_total}.
- **Bank transfer:** after you place your order, your order page shows our bank details, the amount and the reference to use. We send your order once the payment has reached our account.
- **Card:** when card payment is offered at checkout, you're charged in LKR and the payment is handled securely by our payment provider. We never see or store your full card number.

## Delivery and collection

- We deliver island-wide. Delivery costs {delivery_fee} per order.
- Delivery is free when your order's value before discounts is {free_delivery_threshold} or more.
- You can collect your order from our showroom instead, free of charge: {pickup_address}.
- Delivery times depend on where you are; follow your order on the [track order](/track) page.
- Please check your order when it arrives, and tell us within {returns_window_days} days if anything is damaged, faulty or missing.

## Warranty

- The warranty period of each product is shown on its page and on your invoice.
- {warranty_note}
- Warranty covers faults in materials and workmanship under normal use. It doesn't cover damage from accidents, misuse or liquids, or repairs by anyone other than us or the manufacturer's service centre.
- To make a claim, contact us with your order number or invoice. We record the serial number of serial-numbered items when we sell them, which helps us check a claim quickly.

## Returns and refunds

When and how you can return an item and get your money back is explained in our [Refund policy](/returns).

## Your account and reviews

- If you open an account, keep your password to yourself: you're responsible for what is done with it.
- Reviews you post must describe your own experience. We read reviews before they appear and may decline ones that are offensive, misleading or not about the product.

## Our responsibility

- If we break these terms, we're responsible for loss or damage you suffer that was a foreseeable result. We aren't responsible for loss we couldn't have foreseen, for business losses, or for delays caused by events beyond our control, such as severe weather, strikes or courier disruption.
- Nothing in these terms takes away your rights under Sri Lankan consumer law.

## Your privacy

How we use your personal details is explained in our [Privacy policy](/privacy).

## Changes to these terms

We may update these terms from time to time. The version on this page when you place an order applies to that order.

## The law

These terms are governed by the laws of Sri Lanka.$terms$,
    TRUE, TRUE, 'legal', 5)
  ON CONFLICT (slug) DO NOTHING;
  GET DIAGNOSTICS v_terms = ROW_COUNT;

  -- ── Refund policy (/returns) ───────────────────────────────────────────────
  INSERT INTO public.cms_pages (slug, title, summary, content, is_published, show_in_footer, footer_group, sort_order)
  VALUES (
    'returns',
    'Refund policy',
    'How to return an item and get your money back, whether you paid by card, bank transfer or cash on delivery.',
    $returns$We want you to be happy with everything you buy from {store_name}. This page explains when you can return an item, how to do it, and how you get your money back.

## Returns

- You can return an item within {returns_window_days} days of receiving it.
- It must be unused and complete: in its original packaging, with all accessories, manuals and any free gifts that came with it.
- Please include your invoice or order number. For an item with a serial number, the serial number must match the one we recorded when we sold it.

## Faulty, damaged or wrong items

- If an item arrives damaged or faulty, or isn't what you ordered, tell us within {returns_window_days} days of receiving it. We'll repair or replace it, or refund you in full, including the delivery fee.
- After that, a fault is covered by the product's warranty: see our [Terms & conditions](/terms).

## How to return an item

1. Contact us first, with your order number:
   - Phone: {phone}
   - WhatsApp: {whatsapp}
   - Email: {email}
   - or through our [contact page](/contact)
2. We'll confirm the return and tell you how to send or bring the item to us.
   - Our address: {address}
3. When the item reaches us, we check it and tell you whether the refund is approved.

## How you get your money back

We refund the way you paid:

- **Card:** back to the same card. After we send the refund, banks usually take 7–14 working days to show it on your statement.
- **Bank transfer:** to your bank account by transfer; we'll ask you for the account details.
- **Cash on delivery:** to your bank account by transfer; we'll ask you for the account details.

We send approved refunds within 7 working days.

## Delivery charges

- The delivery fee is refunded in full when the item was faulty, damaged or wrong.
- If you return an item because you changed your mind, the delivery fee isn't refunded, and sending the item back to us is at your cost.

## Cancelled orders

If you cancel an order before it's dispatched, or we cancel it, you get back everything you paid, the same way you paid.

## Questions

Ask us anything about a return or a refund:

- Phone: {phone}
- Email: {email}$returns$,
    TRUE, TRUE, 'customer_service', 10)
  ON CONFLICT (slug) DO NOTHING;
  GET DIAGNOSTICS v_returns = ROW_COUNT;

  -- ── 33's privacy template: fill in its placeholders (only the template's own text) ──
  UPDATE public.cms_pages
     SET content = replace(replace(replace(replace(replace(replace(replace(
                     content,
                     c_note || E'\n\n', ''),
                     '[BUSINESS NAME]', '{store_name}'),
                     '[POSTAL ADDRESS]', '{address}'),
                     '[CONTACT EMAIL]', '{email}'),
                     '[HOW LONG YOU KEEP ORDER RECORDS — for example, as long as tax law requires]',
                     'As long as we need them for our accounts, tax records and warranty claims'),
                     '**[HOSTING PROVIDER]**', '**Netlify**'),
                     E'\n- [ANY OTHER SERVICE YOU USE WITH THIS DATA — for example the tool you send newsletters with.]', '')
   WHERE slug = 'privacy'
     AND (position(c_note IN content) > 0 OR position('[BUSINESS NAME]' IN content) > 0 OR position('[CONTACT EMAIL]' IN content) > 0
          OR position('[POSTAL ADDRESS]' IN content) > 0 OR position('[HOSTING PROVIDER]' IN content) > 0
          OR position('[HOW LONG YOU KEEP ORDER RECORDS' IN content) > 0 OR position('[ANY OTHER SERVICE YOU USE' IN content) > 0);
  GET DIAGNOSTICS v_privacy = ROW_COUNT;

  INSERT INTO public.app_config (name, value) VALUES (c_marker, to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))
  ON CONFLICT (name) DO NOTHING;

  -- ── Self-verification ──────────────────────────────────────────────────────
  IF v_terms = 1 THEN
    SELECT * INTO p FROM public.cms_pages WHERE slug = 'terms';
    IF NOT p.is_published OR p.footer_group IS DISTINCT FROM 'legal' THEN
      RAISE EXCEPTION '47_seed_policy_pages: the terms page was not stored published, in the Legal column';
    END IF;
    SELECT array_agg(needle) INTO v_missing
      FROM unnest(ARRAY['## Who we are', '{store_name}', '{address}', '{email}', '{phone}', '{business_reg_no}',
                        '## Payment', '{payment_methods}', '## Delivery and collection', '{delivery_fee}',
                        '{free_delivery_threshold}', '{pickup_address}', '## Warranty', '[Refund policy](/returns)',
                        '[Privacy policy](/privacy)', 'laws of Sri Lanka']) AS needle
     WHERE position(needle IN p.content) = 0;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION '47_seed_policy_pages: the terms page does not mention: %', array_to_string(v_missing, ' · ');
    END IF;
  END IF;
  IF v_returns = 1 THEN
    SELECT * INTO p FROM public.cms_pages WHERE slug = 'returns';
    IF NOT p.is_published OR p.footer_group IS DISTINCT FROM 'customer_service' OR p.title <> 'Refund policy' THEN
      RAISE EXCEPTION '47_seed_policy_pages: the refund policy was not stored published, in the Customer service column';
    END IF;
    SELECT array_agg(needle) INTO v_missing
      FROM unnest(ARRAY['{returns_window_days}', '## Faulty, damaged or wrong items', '## How to return an item',
                        '## How you get your money back', '**Card:**', '**Bank transfer:**', '**Cash on delivery:**',
                        'within 7 working days', '## Cancelled orders', '[Terms & conditions](/terms)', '{phone}', '{email}']) AS needle
     WHERE position(needle IN p.content) = 0;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION '47_seed_policy_pages: the refund policy does not mention: %', array_to_string(v_missing, ' · ');
    END IF;
  END IF;
  SELECT array_agg(left_over) INTO v_left
    FROM unnest(ARRAY['Template — have it reviewed', '[BUSINESS NAME]', '[POSTAL ADDRESS]', '[CONTACT EMAIL]',
                      '[HOSTING PROVIDER]', '[HOW LONG YOU KEEP ORDER RECORDS', '[ANY OTHER SERVICE YOU USE']) AS left_over
   WHERE v_privacy = 1
     AND position(left_over IN (SELECT content FROM public.cms_pages WHERE slug = 'privacy')) > 0;
  IF v_left IS NOT NULL THEN
    -- An owner-edited variant of a placeholder: worth finishing by hand, not worth failing the seed.
    RAISE WARNING '47_seed_policy_pages: the privacy page still has: % — finish it in admin → Pages & blog', array_to_string(v_left, ' · ');
  END IF;

  RAISE NOTICE '47_seed_policy_pages: terms %, refund policy %, privacy template %',
    CASE v_terms WHEN 1 THEN 'published' ELSE 'already existed — left unchanged' END,
    CASE v_returns WHEN 1 THEN 'published' ELSE 'already existed — left unchanged' END,
    CASE v_privacy WHEN 1 THEN 'filled in' ELSE 'had no placeholders left — unchanged' END;
END $seed$;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 47_seed_policy_pages
--   Check:   SELECT slug, title, is_published, footer_group, length(content) FROM public.cms_pages
--              WHERE slug IN ('terms', 'returns', 'privacy') ORDER BY slug;
--   Edit:    admin → Pages & blog → "Terms & conditions" / "Refund policy" / "Privacy policy". The
--            {tokens} show today's Settings in the preview; "Formatting help" lists them all.
--   Undo (the two new pages; the privacy fill-in stays — edit it in the admin instead):
--            DELETE FROM public.cms_pages WHERE slug IN ('terms', 'returns');
--            The marker stays, so a re-run never brings them back (delete it only to re-seed):
--            DELETE FROM public.app_config WHERE name = 'seed_47_policy_pages';
-- ═════════════════════════════════════════════════════════════════════════════
