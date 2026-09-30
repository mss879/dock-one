-- ═════════════════════════════════════════════════════════════════════════════
-- 33_seed_content_pages.sql — Dock One Solutions
--
--   ██ TEMPLATE — have it reviewed before launch ██
--   ONE page: the privacy policy (/privacy), published and listed in the footer's Legal column,
--   because blueprint §12.1.6 requires a privacy page that "lists everything collected". Every
--   sentence describes what THIS build actually collects and does (blueprint §12.2 + §12.5 as
--   implemented in migrations 02–22 and the app): orders (+ the copy emailed to the owner); checkout details captured before
--   submit + recovery emails; newsletter; contact inquiries; finder answers; assistant
--   conversations (redacted) and the order-lookup audit (email domain only); consent-gated
--   analytics; saved items; profile/address; reviews; hashed rate-limit identifiers — with the
--   retention periods of 22_retention.sql, the processors actually used (Supabase, Resend,
--   OpenAI for the assistant, an exchange-rate service with no personal data) and the browser
--   storage keys in use. The business name, contact email, postal address, hosting provider,
--   order-record retention period and any other services are [BRACKETED PLACEHOLDERS] the owner
--   fills in; the page opens with a visible "Template — have it reviewed" note to delete then.
--
--   NOT seeded (owner's rule: nothing invented — BUILD_SPEC §2.0, §3): terms, refund, cookie,
--   about, delivery, warranty, showroom, careers and corporate pages, and blog posts. The
--   returns page is NOT seeded either: the only returns fact in the system is the
--   `store_settings.returns_window_days` number, which can't state a complete, true policy
--   (when the window starts, condition, costs, refunds), and copying it into page text would
--   drift from Settings (two sources of truth, P6). /returns and /terms answer 404 and the footer
--   leaves them out until the owner writes and publishes them (admin → Pages & blog).
--
--   To remove the template (run in the SQL editor — but the blueprint requires a privacy page, so
--   write your own first):
--     DELETE FROM public.cms_pages WHERE slug = 'privacy';
--   The app_config marker 'seed_33_content_pages' stays, so re-running the migrations never
--   brings the template back or overwrites your edited page (delete the marker only to re-seed).
--
-- PURPOSE      Seed the privacy page template (blueprint §12.1.6).
-- DEPENDS ON   01_foundation (app_config), 15_content_pages.
-- ENABLES      /privacy (src/app/(store)/privacy), its footer link (WP-B getFooterLinks).
-- RULES        references the row by slug (never a SERIAL id), ON CONFLICT DO NOTHING (an owner's
--              own privacy page is never touched), one atomic DO block guarded by an app_config
--              marker, self-verifying (RAISE ⇒ the whole seed rolls back).
-- SAFE TO RE-RUN: yes (a second run is a no-op).
-- ═════════════════════════════════════════════════════════════════════════════

DO $seed$
DECLARE
  c_marker CONSTANT TEXT := 'seed_33_content_pages';
  v_inserted INT;
  v_missing TEXT[];
  p public.cms_pages%ROWTYPE;
BEGIN
  IF EXISTS (SELECT 1 FROM public.app_config WHERE name = c_marker) THEN
    RAISE NOTICE '33_seed_content_pages: already applied (app_config %) — skipped', c_marker;
    RETURN;
  END IF;

  INSERT INTO public.cms_pages (slug, title, summary, content, is_published, show_in_footer, footer_group, sort_order)
  VALUES (
    'privacy',
    'Privacy policy',
    'What this shop collects, why, where it is kept, for how long and who processes it — and how to ask for your data to be deleted.',
    $privacy$> **Template — have it reviewed.** This page was written from what this website actually collects and does. Before launch, replace everything in [square brackets] with your own details, have the page reviewed by someone who knows Sri Lanka's data-protection law, and then delete this note.

## Who we are

This website is run by [BUSINESS NAME], [POSTAL ADDRESS]. For anything to do with your personal data — a question, a copy of what we hold, a correction or deletion — email [CONTACT EMAIL] or write to us through our [contact page](/contact).

## What we collect and why

### Orders

When you place an order we store your email address, first and last name and phone number; for delivery, your street address, city, district, postal code and country (not needed for showroom pickup); any delivery note you add; the products, quantities and prices; any discount code; how you chose to pay (cash on delivery or bank transfer); and the currency you were viewing prices in, with its exchange rate, for our records — you are always charged in Sri Lankan rupees. If you pay by bank transfer, we may note your transfer reference on the order.

We use this to prepare, deliver or hand over your order, to contact you about it, and to email you the order confirmation and delivery updates. A copy of each new order, with your contact and delivery details, is also emailed to our own inbox. We never ask for card details on this site.

If you are signed in, the order is linked to your account. If you order as a guest and later create an account and confirm the same email address, those orders are linked to the account.

### Checkout details saved before you order

Once you have typed your email address and first name at checkout, what you have entered so far — email, name, phone number, address and basket — is saved automatically as you type, before you place the order. If you don't complete the order, we may email you up to three reminders about that basket in the hours and days that follow. Every reminder has a link to restore the basket (the products only, never your address) and a link to stop the reminders. Stopping them puts your email address on our do-not-remind list, which we keep so that we don't remind you again. When you place the order, the saved checkout is marked as completed.

### Newsletter

If you sign up — with the form on our home page, or by asking the product finder to email you your results — we store your email address, where you signed up and when. We use it to send you our newsletter. You can unsubscribe at any time with the link in our newsletter emails or by contacting us; we record when you unsubscribed and keep your address on a do-not-email list so that we don't email you again, unless you sign up again yourself.

### Messages you send us

The contact form stores your name, email address, subject and message and, when we answer by email, our reply and who sent it. Each message is also emailed to our own inbox, so that we see it straight away. We use it to answer you.

### The product finder

When the [product finder](/discover) shows you results, we store your answers (what you are shopping for, what you will use it for, your budget, how portable it needs to be and anything to avoid), the products it showed you (up to three), a summary of the preferences your answers imply (scores out of 10 for performance, portability, battery life, value and weight), a random identifier for your visit (kept in your browser tab) and, if you are signed in, your account. If you ask us to email you the results, we also store your email address, email you the results and add you to our newsletter (you can unsubscribe at any time). We use the answers to show you results and to understand what shoppers are looking for; if you are signed in, the shopping assistant can use your preferences to tailor its suggestions.

### The shopping assistant

When you chat with the shopping assistant, we store your messages and its replies with email addresses, phone numbers, order numbers and other long numbers replaced by placeholders before they are saved. With them we store which products were shown to you or added to your basket, the search terms it used, the page you were on, timings and usage figures, whether you attached a photo and a short description of what the photo showed, and a one-way code derived from your network (IP) address — not the address itself. If you are signed in, the chat is linked to your account. The photo itself is not stored.

To answer you, the recent conversation and any photo you attach are sent to our AI provider, OpenAI, together with the page you are on, the products you have viewed in this browser tab and your basket total. If you are signed in, your first name, the products from your recent orders and your product-finder preferences are sent too, so the assistant can tailor its answers. We never add your email address, phone number, delivery address or order numbers — but anything you type into the chat is sent as written, so please don't type personal details there. To check an order, use the order look-up form in the assistant: the order number and email address you type into it are never sent to the AI. If the order is found, the list of products in it is added to the conversation, so the assistant can help with them.

### Order look-ups in the assistant

When you look up an order in the assistant, we log the order number, the part of your email address after the @ (for example gmail.com — never the full address), whether it matched, the chat session and the one-way network code, so that we can spot abuse.

### Browsing statistics — only if you allow them

If you allow analytics in the cookie banner, we record the pages you view (the address without anything after a "?"), the products, categories and collections you look at, what you search for and how many results it found, adding and removing basket items, starting checkout (with the basket value), saving items, finishing the product finder, opening the shopping assistant and signing up to the newsletter. Each record carries a random identifier that changes after 30 minutes of inactivity and, if you are signed in, your account. If you don't allow analytics, none of this is recorded. You can change your choice at any time with the cookie settings link at the bottom of every page.

### Your account

If you create an account we store your email address, first and last name and, if you add them, your phone number and default delivery address. Your password is handled by Supabase, our sign-in provider, and is never stored in readable form. We keep a running total of your orders and what you have spent, and our staff can add a note to your customer record. You can update your details in your account settings.

### Saved items

If you are signed in, the products you save are stored with your account. If you are not, they are kept only in your browser; when you sign in, they are added to your account.

### Reviews

If you review a product we store your rating, title, review and the display name you choose, linked to your account, and whether you bought the product (from your delivered orders). Reviews are published after we check them; we may reply publicly and show a review on our home page. If your account is deleted, your published reviews stay under your display name unless you ask us to remove them.

### Protection against abuse

To stop automated abuse of our forms, we keep short-lived records of one-way codes derived from your network (IP) address and, for some forms, your email address — not the addresses themselves. They are deleted after a day.

## How long we keep it

| What | How long |
| --- | --- |
| Orders | [HOW LONG YOU KEEP ORDER RECORDS — for example, as long as tax law requires]; they are not deleted automatically |
| Checkout details saved before an order | 90 days after they were last saved, reminded about or completed |
| Shopping assistant conversations | 12 months |
| Assistant order look-up log | 30 days |
| Browsing statistics | 13 months |
| Product-finder answers without an email address or account | 12 months |
| Abuse-protection records | 1 day |
| Your account, saved items, reviews, newsletter sign-up, messages to us, and product-finder answers with an email address or account | Until you ask us to delete them |
| Do-not-remind and do-not-email lists | Kept, so that we keep honouring your choice |

## Who processes your data for us

- **Supabase** — hosts our database, sign-in and uploaded images, and sends account emails (confirmation and password reset). The information described above is stored in its database.
- **Resend** — sends our emails: order confirmations and updates, basket reminders, replies to your messages and product-finder results, and the copies of new orders and messages sent to our own inbox.
- **OpenAI** — writes the shopping assistant's replies from what is sent to it, as described above.
- **A currency exchange-rate service** — our server fetches exchange rates for the currency switcher; no personal data is sent.
- **[HOSTING PROVIDER]** — runs this website, so it handles your requests, including your network (IP) address, when you visit.
- [ANY OTHER SERVICE YOU USE WITH THIS DATA — for example the tool you send newsletters with.]

This site runs no third-party advertising or tracking scripts.

## Cookies and browser storage

Some storage is essential for the shop to work and is always on; analytics storage is used only if you allow it. Session storage is cleared when you close the tab; local storage stays until you clear it or it expires.

**Essential — always on**

- `dockone.cart.v2` (local storage) — your basket.
- `dockone.wishlist.v2` (local storage) — items you saved while signed out.
- `dockone.currency.v1` (local storage) — the currency you chose to view prices in.
- `dockone.offer.v1` (local storage) — the discount code you applied, or one the shopping assistant offered you, kept for checkout for up to 24 hours.
- `dockone.consent.v1` (local storage) — your cookie choice.
- `dockone.assistant.v1` (local storage) — your conversation with the shopping assistant, for 24 hours; cleared when you sign out.
- `dockone.assistant.nudge-off.v1` (local storage) — assistant tips you dismissed, for 24 hours.
- `dockone.rates.v1` (session storage) — exchange rates for the currency switcher.
- `dockone.checkout.id` (session storage) — a random identifier that ties your checkout's automatic saves together.
- `dockone.order.v1` (session storage) — your last order's confirmation, without your address or phone number.
- `dockone.viewed.v1` (session storage) — the last products you viewed in this tab, shared with the shopping assistant.
- `dockone.finder.v1` (session storage) — a random identifier for your product-finder answers.
- `dockone.assistant.nudges.v1` (session storage) — which assistant tips were shown during this visit.
- Sign-in cookies (`sb-…-auth-token`) — set when you sign in, create an account or reset your password, to keep you signed in.
- `dockone_site_access` (cookie) — only before the shop opens, for people given a preview PIN; 30 days.

**Analytics — only if you allow them**

- `dockone.analytics.v1` (local storage) — a random identifier for your browsing session, replaced after 30 minutes of inactivity and deleted if you withdraw your consent.

## Your choices

- Update your name, phone number and address in your account settings.
- Remove saved items at any time.
- Stop basket reminders with the link in any reminder email.
- Unsubscribe from the newsletter with the link in our newsletter emails.
- Change your analytics choice with the cookie settings link at the bottom of every page.
- To ask for a copy of your personal data, or for it to be corrected or deleted, email [CONTACT EMAIL]. Some records, such as orders, may have to be kept for legal reasons.$privacy$,
    TRUE, TRUE, 'legal', 10)
  ON CONFLICT (slug) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  INSERT INTO public.app_config (name, value) VALUES (c_marker, to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF'))
  ON CONFLICT (name) DO NOTHING;

  -- Self-verification.
  SELECT * INTO p FROM public.cms_pages WHERE slug = 'privacy';
  IF NOT FOUND THEN
    RAISE EXCEPTION '33_seed_content_pages: the privacy page is missing after the insert';
  END IF;
  IF v_inserted = 1 THEN
    IF NOT p.is_published OR NOT p.show_in_footer OR p.footer_group IS DISTINCT FROM 'legal' OR p.title <> 'Privacy policy' THEN
      RAISE EXCEPTION '33_seed_content_pages: privacy was not stored published, in the Legal footer column';
    END IF;
    -- Blueprint §12.1.6 / §12.2 / §12.5: every collection point, retention period, processor and
    -- the erasure route must be on the page.
    SELECT array_agg(needle) INTO v_missing
      FROM unnest(ARRAY[
        'Template — have it reviewed',
        '### Orders', '### Checkout details saved before you order', 'up to three reminders', 'stop the reminders',
        '### Newsletter', 'form on our home page', '### Messages you send us', 'emailed to our own inbox', '### The product finder', '(up to three)', 'add you to our newsletter', '### The shopping assistant',
        'replaced by placeholders', '### Order look-ups in the assistant', 'after the @',
        '### Browsing statistics — only if you allow them', '### Your account', '### Saved items', '### Reviews',
        '### Protection against abuse', 'one-way codes',
        '| 90 days', '| 12 months |', '| 30 days |', '| 13 months |', '| 1 day |',
        '**Supabase**', '**Resend**', '**OpenAI**', 'exchange-rate service', 'no personal data is sent',
        '`dockone.cart.v2`', '`dockone.consent.v1`', '`dockone.analytics.v1`', '`dockone_site_access`',
        '[BUSINESS NAME]', '[CONTACT EMAIL]', '[HOSTING PROVIDER]', 'corrected or deleted'
      ]) AS needle
     WHERE position(needle IN p.content) = 0;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION '33_seed_content_pages: the privacy page does not mention: %', array_to_string(v_missing, ' · ');
    END IF;
    RAISE NOTICE '33_seed_content_pages: seeded the privacy page TEMPLATE (published, footer: Legal) — fill in the [placeholders] and have it reviewed';
  ELSE
    RAISE NOTICE '33_seed_content_pages: a privacy page already existed — left unchanged';
  END IF;
END $seed$;

-- ═════════════════════════════════════════════════════════════════════════════
-- OPS NOTE — 33_seed_content_pages (TEMPLATE)
--   Before launch: admin → Pages & blog → "Privacy policy": replace every [BRACKETED PLACEHOLDER],
--   delete the "Template — have it reviewed" note, have the page reviewed, save. The retention
--   periods it states are carried out by the daily maintenance job — schedule POST
--   /api/maintenance (22_retention.sql OPS NOTE, docs/build/JOBS.md) or they are not true. When
--   the site starts collecting something new (a new form, a new service, a new storage key),
--   update this page in the same change (blueprint §12.1.6).
--   Write /terms and /returns yourself in the same tab; they stay 404 (and out of the footer)
--   until published.
--   Verification:
--     SELECT slug, title, is_published, show_in_footer, footer_group, sort_order, length(content)
--       FROM public.cms_pages WHERE slug = 'privacy';
--     SELECT value FROM public.app_config WHERE name = 'seed_33_content_pages';   -- when it ran
--     -- live probe (anon key is public): the published page is readable
--     curl -s "$SUPABASE_URL/rest/v1/cms_pages?select=slug,title&slug=eq.privacy" -H "apikey: $ANON"
-- ═════════════════════════════════════════════════════════════════════════════
