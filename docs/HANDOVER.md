# Dock One Solutions — handover

What was built on top of the approved storefront design, how to set it up, and what to replace
before launch. The feature set follows the commerce blueprint (`docs/commerce-platform-blueprint.md`);
the build contract is `docs/build/BUILD_SPEC.md`.

## 1. What the site does

**Storefront**

| Area | Where |
| --- | --- |
| Homepage — hero slides, category pop-outs with real product counts, promo tiles, featured collections, flash deals (with a real end time), new arrivals, best sellers (real sales), trust row, "order your way", store status, newsletter, ticker, top bar, footer — all edited in the admin | `/` |
| Catalogue — all products, category, search (typo-tolerant), deals, new, brand/price filters, sorting, pagination | `/shop`, `/shop?category=laptops`, `/shop?q=…` |
| Product page — priced variants, live stock band, reviews + star summary, rich results (JSON-LD) | `/product/[id]` |
| Collections | `/collections`, `/collection/[id]` |
| Basket — server-priced totals, free-delivery bar, promo code, WhatsApp order link | `/cart` + the basket drawer |
| Checkout — home delivery or showroom pickup, cash on delivery or bank transfer (each only while the store offers it), order note, promo code | `/checkout` |
| Bank transfer — the store's account (Bank of Ceylon, Vishaka branch, Dock One Solutions Pvt Ltd, 79503030) shown as a card with copy buttons at checkout, and with the amount and the order number as reference on the order page, in the confirmation email, on tracking, in the customer's account and on the printed invoice — until the owner marks the order paid | `/checkout`, `/order/[id]`, `/track`, `/customer/dashboard` |
| Order confirmation (private link) and order tracking by number + email | `/order/[id]`, `/track` |
| Accounts — sign up with email confirmation, sign in, password reset, order history, saved items, tracking, profile/address | `/signin`, `/reset-password`, `/customer/dashboard` |
| Wishlist — in the browser for guests, synced to the account once signed in | `/wishlist` |
| Guided product finder — 5 questions, 3 picks with reasons, "email me my picks" | `/discover` |
| AI shopping assistant ("tech desk") — product search and advice, stock checks, finder-style picks, offers, add to basket, private order lookup, photo questions | the `>_` button on every page |
| Contact form, newsletter sign-up and unsubscribe | `/contact`, homepage, `/newsletter/unsubscribe` |
| Abandoned-checkout reminders (3 emails) with restore and stop links | `/recover`, `/recover/stop` |
| Content pages and blog | `/privacy`, `/terms`, `/returns`, `/pages/[slug]`, `/blogs`, `/blogs/[slug]` |
| Cookie consent (analytics only after "Allow"), display currencies (orders always in LKR) | banner, top bar |
| Pre-launch lock — "launching soon" page with a preview PIN | `/launching-soon` |
| SEO — sitemap, robots, manifest, metadata | `/sitemap.xml`, `/robots.txt` |

**Admin panel** (`/admin`, sign in at `/admin/signin`; only accounts with the admin flag):
Dashboard · Orders (status changes email the customer on "out for delivery" and "delivered";
payments; tracking; invoice and packing-slip printing) · Discounts · Abandoned carts · Reports (CSV
and print) · Products (variants, stock, images, specs) · Categories · Collections · Inventory ·
Reviews (moderation) · Customers · Inquiries (reply by email) · Subscribers (mailing-list export) ·
Finder insights · Assistant insights · Homepage · Pages & blog · Store settings · Site lock ·
**Invoices** (the client's invoice layout as a live A4 preview beside the editor; products added by
name or by scanning a unit's serial number; one serial box per unit; gapless numbers given on issue;
stock taken on issue; payments, overdue tracking, print / save as PDF; "Create invoice" from an order) ·
**Serial numbers** (one box per unit in stock in Products; picked per line when packing a web order;
printed on the packing slip and invoices).

## 2. Set it up (in this order)

1. **Supabase** — create the project, then apply the migrations exactly as described in
   `supabase/MIGRATION_PLAN.md` (one file per feature, with checks and go-live list).
2. **Supabase Auth** — follow `docs/build/AUTH_SETUP.md` (confirm email ON, custom SMTP with Resend,
   redirect URLs, the two branded email templates), then promote the owner to admin.
3. **Environment** — copy `.env.example` into the host (Vercel: Production and Preview) and fill it:
   Supabase URL + anon key, `NEXT_PUBLIC_SITE_URL`, `RATE_LIMIT_SECRET`, `CART_RECOVERY_SECRET`,
   `MAINTENANCE_SECRET` (each the same value as in the database), Resend keys and sender,
   `ORDER_NOTIFICATION_EMAIL`, `OPENAI_API_KEY` (assistant). Models: `ASSISTANT_MODEL=gpt-5.4-mini`
   for text turns and `ASSISTANT_VISION_MODEL=gpt-5.6-terra` for photo turns — chosen on 2026-10-01
   by running every candidate through the real prompt and tools: gpt-5.4-mini answered in 8–14 s
   and gpt-5.6-terra read every test photo correctly in 5–11 s, while gpt-5.4 took 14–18 s and
   gpt-5.5 timed out on every turn (the turn budget is 24 s). Unset, both default to `gpt-5.4-mini`.
   There is no service-role key anywhere, by design.
4. **Scheduled jobs** — hourly cart recovery and daily maintenance: `docs/build/JOBS.md`. They are
   POST requests with a bearer secret, so use an external scheduler (Vercel's built-in cron sends GET).
5. **Store settings** in the admin — real phone/WhatsApp/email/address, pickup address (or switch
   pickup off), delivery fee and free-delivery threshold. The bank account for transfers is already
   filled in by migration 03 (Payments section, with a live preview) — just check it.

Owner tips: publishing a page with the address (slug) `store-locator` in Pages & blog adds a
"Store locator" link to the top bar and mobile menu; the privacy, terms and returns pages appear in
their footer columns automatically once published; a page left unpublished is hidden everywhere.

Local development: `npm install`, put the values in `.env.local`, `npm run dev`. The build refuses to
run in production mode without the Supabase URL and anon key.

## 3. Replace before launch

- **Demo catalogue** (seed 30: 16 products with one "Standard" variant each, no stock tracking) —
  replace with real products in admin → Products, or delete with the statement in the seed's header.
- **Placeholder contact details** (seed 31): phone +94 11 234 5678, WhatsApp +94 77 123 4567,
  hello@dockone.lk, "No. 42, Galle Road, Colombo 03" — admin → Store settings.
- **Domain** — `https://dockonesolutions.com` (the fallback when `NEXT_PUBLIC_SITE_URL` is unset; set it to the
  same value on the host so sitemap, canonical and share-image URLs all use it).
- **OPENING10** (seed 32) — keep only if the offer is real.
- **Privacy page** (seed 33) is a template: fill the `[BRACKETED]` placeholders, have it reviewed,
  delete the "Template" note. Write and publish the terms and returns pages (not seeded — nothing
  was invented).
- **Homepage copy** — the seeded lines are the approved design's copy. Price claims were corrected
  to match the demo catalogue ("from Rs. 329,900", "SSDs up to 21% off", "from Rs. 32,900",
  "from Rs. 9,900"); update them whenever real prices change. Review these lines too: "Limited time"
  (no end date is set), "Real tech people on call, chat and WhatsApp" (the website chat is the AI
  assistant), "Support: Online / All systems operational", and the newsletter promise of
  "price drops, new arrivals and restock alerts" (the list is exported and mailed by the owner).
- **Site lock** — optional; PINs are 6–12 digits.

## 4. Decisions and known limits

- **Honesty (blueprint P15):** claims the store can't back were removed from the seeded content
  (card payments, instalments, "10K+ orders", "99%", "up to 40% off", an invented testimonial, card
  logos, the midnight-resetting countdown). Stars and review counts come only from approved reviews.
- **Security hardening beyond the blueprint's reference:** the public database functions that the
  site's routes call are braked for direct callers (the site's own server identifies itself with a
  header derived from `RATE_LIMIT_SECRET`); guest orders are readable by email only once that email
  is confirmed; the site-lock PIN minimum is 6 digits (the reference used 4).
- **Assistant offers:** a code the assistant offers only pre-fills the promo field — the shopper
  presses Apply, and checkout still decides (blueprint §9.4, §10.7).
- **Bank transfer:** the account is stored as separate fields (account name, bank, branch, account
  number, optional extra note), so it can be laid out as a card and copied; bank transfer is offered
  only while the name, bank and number are set. As given by the owner, stored as "Bank of Ceylon"
  (official capitalisation) and branch "Vishaka" (the card labels it "Branch") — edit either in
  admin → Store settings. Shoppers pay after ordering with the order number as the reference; the
  owner marks the order paid in admin → Orders (with the bank's reference), which removes the bank
  details from the shopper's pages. The copy button copies the account number's digits only. The
  amount to transfer is always shown in LKR, whatever display currency the shopper picked. The
  assistant says where the bank details are shown but never recites the account number.
- **Finder quality** depends on product specs. The demo catalogue carries only the facts in its spec
  lines, so some answer combinations honestly return fewer than 3 picks (the page says so).
- **Order history** shows past orders converted at today's display-currency rate (orders are
  charged and stored in LKR).
- **Cart reminders:** if a shopper reloads checkout and then changes their email, earlier reminders
  stay tied to the first address.
- **Photo questions in the assistant:** the model first records what the photo shows (kind, brand and
  model if legible, generic type, store category, features); the SERVER then decides — *carried*
  (every brand + model word is in one product's name, brand word included: that product is shown),
  *similar* (the product belongs to one of our categories: the closest 3 in it are shown, and the
  reply says we don't carry that exact one) or *none* (nothing like it: the reply says so and
  shows nothing). Brand and model names are never guessed, so a real-world brand we don't stock
  can only ever land on *similar* or *none*. *None* turns appear in the insights tab as
  "Photo: no match" with the reading (what people own that we don't carry).
- **Erasing assistant conversations** on request: run the DELETE in the OPS NOTE of
  `21_assistant_memory_lookup.sql` in the SQL editor (the insights tab is read-only by design).
- **Admin image uploads need an https Supabase project** (the database accepts site paths or
  https image URLs only); a local http Supabase stack can't save uploaded images.
- **Developer note:** under `next dev` (React's development double-mount) the admin order drawer
  closes as soon as it opens; a production build (`next build && next start`) is unaffected.
- Minor admin edges not yet addressed: reordering hero slides then editing one drops the unsaved
  order; switching homepage sub-tabs discards unsaved block edits; the product picker lists nothing
  for a collection with 42+ members; signing out of the admin does not clear storefront data kept
  in that browser (assistant transcript, parked code).

## 5. How it was verified

- **Database:** `scripts/db/verify.sh` — all 33 migration files applied twice (idempotent), 34 test
  files, 1,732 checks, including privilege audits, RLS, money and stock maths, the bank account, the direct-call
  brake, serial numbers (25) and invoices (26: numbering, stock, serials, payments, rounding).
- **App:** TypeScript and ESLint clean; `next build` succeeds.
- **End to end** against a local Supabase-shaped stack (Postgres 16 + PostgREST + an auth/storage
  stand-in, mock email capture): 76 scripted API checks (pages, basket/checkout/order/tracking,
  newsletter, contact, finder, analytics, cart recovery and jobs, assistant) and a browser pass over
  sign-up → email confirmation → dashboard, basket, checkout, order page, tracking, settings,
  wishlist, reviews with moderation, contact, newsletter, finder, assistant, password reset,
  consent, currency, and the admin (orders with emails, products with stock, settings, homepage
  flash sale, blog publishing, site lock, inquiry replies, every tab).
- **Reviews:** independent read-only reviews of client forms, client↔route↔database contracts and
  security; the confirmed findings were fixed.
- **Assistant with the real OpenAI key (2026-10-01):** six models × four photo turns (a catalogue
  laptop with its name printed on it, a catalogue mouse, a mechanical keyboard we don't carry,
  headphones) plus a text turn through the real prompt and tools, then photo and text turns through
  `POST /api/assistant` on the dev server against the live project: every verdict, card and stock
  band was right.
- **Not verified here:** real Resend delivery.
