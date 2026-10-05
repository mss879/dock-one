# Dock One Solutions — Supabase migration plan (one migration per feature)

Every feature of the store has its own SQL file in `supabase/migrations/`. You add the features
yourself by running those files, in number order, in the Supabase **SQL editor**. This document
is the plan for each one: what it adds, what it needs first, what it switches on in the site,
what to do right after, and how to check it worked.

- The files are the source of truth; this plan summarises them. The full contract (every table,
  function, argument and error code) is in `docs/build/SQL_NOTES.md`, and each file ends with an
  **OPS NOTE** holding extra verification queries and live probes.
- Every file is **safe to run twice** (it only creates what is missing and replaces functions).
  If a paste fails half-way, fix the cause and run the whole file again.
- Every file was proven on a Supabase-shaped Postgres 16 before hand-over: all migrations applied
  twice, then the test suite in `supabase/tests/` (`scripts/db/verify.sh`).

> **Changed 2026-09-28 — bank transfer details.** `03` now stores the bank account as separate
> fields (account name, bank, branch, account number — plus an optional extra note) and fills in
> the store's real account: **Dock One Solutions Pvt Ltd · Bank of Ceylon · Vishaka branch ·
> 79503030**. `09` offers bank transfer only while the account name, bank and number are set, and
> the order page receives the account while a transfer is awaited. **If you already ran 03 and 09
> before this date, run both again** (in that order — both are safe to re-run); nothing else changes.

---

## 0. Before the first migration

1. Create the Supabase project. From **Project Settings → API** copy the **Project URL** and the
   **anon public key** into the host's environment as `NEXT_PUBLIC_SUPABASE_URL` and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` (see `.env.example` for every variable). The app never uses
   the service-role key — do not add it anywhere.
2. Open **SQL editor → New query**. For each migration: open the file, copy **all** of it, paste,
   press **Run**. "Success. No rows returned" is the normal result (a few files print a NOTICE).
3. Prefer one paste per file. To paste a range at once, run `scripts/db/bundle.sh FROM TO`
   locally (e.g. `scripts/db/bundle.sh 1 11`) and paste `supabase/bundles/FROM-TO.sql`.
4. If a file fails with `relation … does not exist` or `function … does not exist`, an earlier
   file in the order below was skipped — run that one first, then re-run.

The app can be deployed before or after any migration: a form or API whose migration is not
applied yet answers "This feature is not available yet" (HTTP 503) and the server log names the
file to apply (e.g. `apply migration 12_leads.sql`); a page section whose data is missing is
simply hidden. Nothing crashes.

---

## 1. Apply order at a glance

| # | Feature | File | Needs first | What starts working |
| --- | --- | --- | --- | --- |
| 01 | Foundation: secrets + rate limiting | `01_foundation.sql` | — | Rate limits on every public form/API; secret checks for scheduled jobs |
| 02 | Customer accounts + admin flag | `02_customers_and_auth.sql` | 01 | Sign up / sign in / reset, account page, the admin gate |
| 03 | Store settings | `03_store_settings.sql` | 01, 02 | Delivery fee + free-delivery rule, payment methods, pickup, contact details, top bar, ticker, footer labels |
| 04 | Catalogue | `04_catalogue.sql` | 01, 02 | Categories, products, priced variants, collections, image buckets |
| 05 | Inventory | `05_inventory.sql` | 04 | Stock per variant, "in stock / low / sold out", stock checks at checkout |
| 06 | Search + filters | `06_catalogue_search.sql` | 04 | Header search, brand/price filters, real category counts |
| 07 | Orders ledger | `07_orders.sql` | 02, 04 | The order tables (orders appear once 09 is applied) |
| 08 | Discount codes | `08_discounts.sql` | 07 | Promo codes (admin → Discounts) |
| 09 | Checkout + order processing | `09_order_rpcs.sql` | 03, 05, 07, 08 | Basket totals, checkout, confirmation page, order tracking, admin order status |
| 10 | Wishlists | `10_wishlists.sql` | 02, 04 | Saved items synced to the account |
| 11 | Reviews + ratings | `11_reviews.sql` | 04, 07 | Product reviews, star ratings, moderation |
| 12 | Newsletter + contact | `12_leads.sql` | 01, 02 | Newsletter sign-up/unsubscribe, contact form inbox |
| 13 | Abandoned-cart recovery | `13_abandoned_carts.sql` | 09, 12 | Checkout autosave, reminder emails, restore links |
| 14 | Guided finder | `14_finder.sql` | 12 | `/discover` answers saved, finder insights |
| 15 | Content pages + blog | `15_content_pages.sql` | 01, 02 | Privacy / terms / returns / other pages, blog, footer links |
| 16 | Homepage content | `16_storefront_content.sql` | 04, 07 | Hero slides, promo tiles, homepage copy blocks, best sellers |
| 17 | Analytics + dashboard | `17_analytics.sql` | 12, 13 | Consent-based event tracking, admin dashboard and reports |
| 18 | Site lock | `18_site_lock.sql` | 01, 02 | Pre-launch "launching soon" page with a PIN |
| 19 | AI assistant — core | `19_assistant_core.sql` | 17 | Assistant conversation log, assistant insights |
| 20 | AI assistant — offers | `20_assistant_offers.sql` | 08, 19 | What the assistant may say about discount codes |
| 21 | AI assistant — memory + order lookup | `21_assistant_memory_lookup.sql` | 09, 14, 17, 19 | Returning-customer memory, private order lookup in chat |
| 22 | Data retention | `22_retention.sql` | 13, 14, 17, 19, 21 | Daily clean-up of old logs (privacy promises) |
| 23 | Admin catalogue tools | `23_admin_catalogue.sql` | 04, 05, 07 | Admin product editor save, collection ordering, stock lists |
| 24 | Admin account | `24_admin_account.sql` | 02 | `/admin` for `admin@dockone.lk` (run once that account exists and is confirmed) |
| 25 | Serial numbers | `25_serial_numbers.sql` | 02, 04, 07, 23 | One serial per unit: entered with the stock in Products, picked when packing a web order |
| 26 | Invoices | `26_invoices.sql` | 05, 07, 23, 25 | Admin → Invoices: the invoice builder with live preview, numbering, stock, serials, payments |
| 30–33 | **Demo content** (seeds) | `30_…`–`33_…` | the feature they fill | The approved design's content, moved into the database |
| 34 | **Real inventory** | `34_seed_inventory.sql` | 04, 05, 30 | The client's 86 stock rows as 59 live products, prices and stock; demo catalogue hidden |
| 35 | Inventory costs (**not in git**) | `35_seed_inventory_costs.sql` | 34 | Cost and dealer prices for those variants — admin-only |
| 36 | Inventory update | `36_seed_inventory_update.sql` | 34 | The second stock list: 2 new items (awaiting prices), 3 stock corrections, details |

The simplest safe route is: **01 → 23 in order, then the seeds you want**, and `24` once the admin
account exists. Then **34, 35, 36** for the real catalogue, and **25, then 26** for serial numbers and
invoices (on a project that already has 01–24 and 34–36, just run 25 then 26).

---

## 2. Feature plans

### 01 — Foundation: secrets and rate limiting · `01_foundation.sql`
- **Adds:** the shared `updated_at` trigger; the sealed `app_config` table that holds the job
  secrets; database-side rate limiting (`rate_limit_hits`, `check_rate_limit`); and a
  "direct-call brake" — the store's own server identifies itself with a header derived from the
  rate-limit secret, so anyone calling the public database functions directly (skipping the
  site's per-visitor limits) shares a small store-wide budget instead. Installs `pgcrypto` in the
  `extensions` schema.
- **Needs:** nothing.
- **Switches on:** throttling for every public route (checkout, contact, newsletter, reviews,
  tracking, assistant…); secret checks for the two scheduled jobs.
- **Right after:** create the rate-limit secret and copy it into the host as `RATE_LIMIT_SECRET`
  (without it every route limit fails open and the server logs "RATE LIMITING IS OFF"; a value
  that differs from the database makes the store run on the small direct-call budgets — keep the
  two identical):
  ```sql
  INSERT INTO public.app_config (name, value)
  VALUES ('rate_limit', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  SELECT value FROM public.app_config WHERE name = 'rate_limit';
  ```
- **Check:** `SELECT has_function_privilege('anon', 'public.check_rate_limit(text,text,integer,integer)', 'EXECUTE');` → `true`, and the same for `public.verify_job_secret(text,text)` → `false`.

### 02 — Customer accounts and the admin flag · `02_customers_and_auth.sql`
- **Adds:** `customers` (one profile row per Supabase Auth account, Sri Lankan address fields),
  `is_admin()` (the only thing that grants admin), automatic profile creation on sign-up,
  guest-order linking once an email is confirmed, and a guard so shoppers cannot edit their own
  email, admin flag or lifetime value.
- **Needs:** 01.
- **Switches on:** `/signin` (sign in, create account, forgot password), `/reset-password`,
  `/auth/callback`, `/customer/dashboard`, the account menu, the admin gate (`/admin`).
- **Right after:** configure Supabase Auth exactly as in `docs/build/AUTH_SETUP.md` ("Confirm
  email" ON, custom SMTP, Site URL + redirect URLs, the two branded templates). Then, once the
  owner has signed up **and confirmed** their email, promote them:
  ```sql
  UPDATE public.customers SET is_admin = TRUE WHERE lower(email) = lower('<owner-email>');
  SELECT email, is_admin FROM public.customers WHERE is_admin;   -- the owner, and nobody else
  ```
- **Check:** `SELECT tgname FROM pg_trigger WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal;`
  → `on_auth_user_created`, `on_auth_user_confirmed`, `on_auth_user_email_changed`.

### 03 — Store settings · `03_store_settings.sql`
- **Adds:** the single `store_settings` row: delivery fee and free-delivery threshold, cash on
  delivery (+ optional maximum), bank transfer with the account to pay into (account name, bank,
  branch, account number, optional extra note — filled with the store's real account: Dock One
  Solutions Pvt Ltd, Bank of Ceylon, Vishaka branch, 79503030), showroom pickup (+ address),
  contact details, socials, business registration no., top-bar announcement, ticker, "We accept"
  labels, flash-sale title/end time, returns window and warranty note.
- **Needs:** 01, 02.
- **Switches on:** the top bar, footer, contact links, the free-delivery bar in the basket, the
  delivery line at checkout, admin → **Store settings**. Checkout reads this same row, so a change in
  the admin applies at checkout immediately.
- **Right after:** in admin → Store settings: enter the real contact details; check the bank
  account under **Payments** (the preview shows exactly what shoppers see); either enter the pickup
  address **or** switch pickup off (checkout refuses a method that cannot be completed). Anything
  left empty is simply not shown.
- **Check:** `SELECT count(*) FROM public.store_settings;` → `1`;
  `SELECT bank_account_name, bank_name, bank_branch, bank_account_number FROM public.store_settings;`
  → `Dock One Solutions Pvt Ltd | Bank of Ceylon | Vishaka | 79503030`.

### 04 — Catalogue · `04_catalogue.sql`
- **Adds:** `categories`, `products`, `product_variants` (every purchasable configuration is a
  priced variant; the product's "from" price is kept by the database), `product_costs` (admin
  only), `collections` + `product_collections` (hand-picked and rule-based), the public
  `product-images` and `content-images` storage buckets with admin-only upload policies.
- **Needs:** 01, 02.
- **Switches on:** `/shop`, `/shop?category=…`, `/product/[id]`, `/collections`,
  `/collection/[id]`, the homepage product rows and category cards, admin → **Products**,
  **Categories**, **Collections** (the editor's save also needs 23).
- **Right after:** nothing to configure. A product needs at least one active variant to be
  visible. Load the demo catalogue with seed 30 or add real products in the admin.
- **Check:** `SELECT id, public FROM storage.buckets WHERE id IN ('product-images','content-images');` → two rows, both `true`.

### 05 — Inventory · `05_inventory.sql`
- **Adds:** `inventory` (stock per variant; admin only), `get_product_availability` (the narrow
  public view: in stock / low / sold out), `list_in_stock_product_ids` (the "in stock" filter).
- **Needs:** 04.
- **Switches on:** availability on product pages and in the basket, stock checks and stock
  decrements when an order is placed (and restock on cancellation), admin → **Inventory**,
  low-stock alerts on the dashboard.
- **Right after:** a variant with **no** inventory row is not stock-tracked and always sells.
  Switch tracking on per variant in admin → Products / Inventory and enter real stock.
- **Check:** `SELECT * FROM public.get_product_availability(ARRAY(SELECT id FROM public.products LIMIT 5));`

### 06 — Search and filters · `06_catalogue_search.sql`
- **Adds:** a weighted search index on products, `search_products` (prefix matching, plurals,
  typo-tolerant fallback when `pg_trgm` is on) and `catalogue_facets` (brands, price range, real
  category counts).
- **Needs:** 04.
- **Switches on:** the header search (`/shop?q=…`), brand and price filters, product counts on the
  category cards, the assistant's catalogue search.
- **Right after:** if the file printed "fuzzy fallback off", enable **Database → Extensions →
  pg_trgm** (schema `extensions`); typo tolerance switches on by itself.
- **Check:** `SELECT * FROM public.search_products('ssd', 5, 0);` → ranked rows.

### 07 — Orders ledger · `07_orders.sql`
- **Adds:** `orders` (numbered DO-10001, DO-10002 …, charged in LKR), `order_items` (snapshots
  of name, variant, price and image so history survives catalogue edits), `order_tracking`
  (the shopper-visible timeline), owner access by account or by a **confirmed** sign-in email,
  and guards that keep money/status changes inside the order functions.
- **Needs:** 02, 04.
- **Switches on:** nothing visible yet — orders are created by 09. Apply **07 → 08 → 09 together**.
- **Right after:** never delete orders to undo them — cancel in admin → Orders (restocks and
  returns the discount use).
- **Check:** `SELECT last_value, is_called FROM public.order_number_seq;` → `10001`, `f` on a fresh project.

### 08 — Discount codes · `08_discounts.sql`
- **Adds:** `discounts` (percentage or fixed LKR, minimum subtotal, start/end dates, usage limit
  and count, active flag, "assistant only" codes that must carry a usage cap).
- **Needs:** 07.
- **Switches on:** admin → **Discounts**; the promo field in the basket and checkout works once 09
  is applied.
- **Right after:** create real codes in admin → Discounts (seed 32 adds the demo OPENING10).
- **Check:** `SELECT conname FROM pg_constraint WHERE conname = 'orders_discount_id_fkey';` → 1 row.

### 09 — Checkout and order processing · `09_order_rpcs.sql`
- **Adds:** every money step computed inside the database: `quote_order` (basket/checkout
  totals), `place_order` (the only way an order is created: prices, delivery fee, discount,
  stock, payment status and order number are all decided here), `validate_discount`,
  `track_guest_order`, `view_order`, `admin_set_order_status` (cancel reverses stock, spend and
  the discount use), `admin_set_payment_status`.
- **Needs:** 03, 05, 07, 08 (and 01, 02, 04).
- **Switches on:** `/cart` totals, `/checkout` (cash on delivery, bank transfer, showroom pickup
  when enabled), `/order/[id]` confirmation, `/track`, the dashboard's order history and tracking,
  admin → **Orders** status and payment changes, order emails (when Resend is configured).
- **Right after:** complete step 03's settings (pickup address or pickup off; the bank account is
  already filled). Place one test order, then cancel it in admin → Orders.
- **Check:** `SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('quote_order','place_order','validate_discount','track_guest_order','view_order','admin_set_order_status','admin_set_payment_status') ORDER BY 1;`
  → `true` for the first five, `false` for the two admin functions.

### 10 — Wishlists · `10_wishlists.sql`
- **Adds:** `wishlists` (per signed-in customer; owner read/write, admin read) and
  `merge_wishlist` (folds a guest's browser wishlist into the account at sign-in).
- **Needs:** 02, 04.
- **Switches on:** `/wishlist` and the dashboard's **Saved items** synced across devices (guests
  keep theirs in the browser until they sign in); the admin customer dossier shows saved items.
- **Check:** `SELECT has_table_privilege('anon', 'public.wishlists', 'SELECT');` → `false`.

### 11 — Reviews and ratings · `11_reviews.sql`
- **Adds:** `product_reviews` (one per signed-in customer per product, submitted through
  `submit_review`, held as *pending* until approved, "verified purchase" only from a delivered
  order), `get_review_summary` (star distribution), and a trigger that keeps each product's star
  rating equal to its **approved** reviews.
- **Needs:** 04, 07.
- **Switches on:** the reviews section and review form on `/product/[id]`, star ratings on
  cards, admin → **Reviews** (approve / reject / feature / reply), the homepage testimonial from a
  featured review, product rich results (aggregate rating) once real reviews exist.
- **Right after:** nothing; no reviews are seeded — stars appear only when real approved reviews exist.
- **Check:** `SELECT status, count(*) FROM public.product_reviews GROUP BY 1;`

### 12 — Newsletter and contact · `12_leads.sql`
- **Adds:** `newsletter_subscribers` (one list, with the source of each sign-up and an
  unsubscribe token), `contact_inquiries` (the contact-form inbox), the sealed
  `email_suppressions` list, and `subscribe_newsletter`, `unsubscribe_newsletter`,
  `submit_contact_inquiry`.
- **Needs:** 01, 02.
- **Switches on:** the newsletter form, `/newsletter/unsubscribe`, `/contact`, admin →
  **Inquiries** (reply by email) and **Subscribers**.
- **Right after:** nothing. Owner alerts for new inquiries need Resend (`RESEND_*`,
  `ORDER_NOTIFICATION_EMAIL`).
- **Check:** `SELECT status, count(*) FROM public.contact_inquiries GROUP BY 1;`

### 13 — Abandoned-cart recovery · `13_abandoned_carts.sql`
- **Adds:** `abandoned_carts` (checkout autosave once an email is typed), the secret-gated
  reminder queue (three stages), `get_recovery_cart` (the restore link shows items only, never
  the address) and `stop_cart_recovery` ("stop these reminders"). Carts that already exist when
  the file is first applied are opted out.
- **Needs:** 09, 12 (and 01, 02, 04, 07).
- **Switches on:** checkout autosave, reminder emails, `/recover` and `/recover/stop`, admin →
  **Abandoned carts**; `place_order` starts marking carts as converted.
- **Right after:** create the job secret, set it as `CART_RECOVERY_SECRET`, and schedule the
  hourly job (without it carts are captured but no reminder is ever sent):
  ```sql
  INSERT INTO public.app_config (name, value)
  VALUES ('cart_recovery', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  SELECT value FROM public.app_config WHERE name = 'cart_recovery';
  ```
  Hourly: `curl -X POST https://<domain>/api/cart-recovery -H "Authorization: Bearer <CART_RECOVERY_SECRET>"`
  (details in `docs/build/JOBS.md`).
- **Check:** `SELECT recovery_stage, count(*) FROM public.abandoned_carts WHERE NOT converted AND NOT recovery_opted_out GROUP BY 1;`

### 14 — Guided finder · `14_finder.sql`
- **Adds:** `finder_responses` (what shoppers asked the finder for, with or without an email) and
  `record_finder_response`; a finder email joins the newsletter with source `finder`.
- **Needs:** 12 (and 01, 02).
- **Switches on:** saving `/discover` sessions and optional "email me my results", admin →
  **Finder insights**, the assistant's memory of a signed-in shopper's finder profile (21).
- **Check:** `SELECT count(*), count(email), count(customer_id) FROM public.finder_responses;`

### 15 — Content pages and blog · `15_content_pages.sql`
- **Adds:** `cms_pages` (privacy, terms, returns and any page the owner publishes, with footer
  placement) and `blog_posts`. Only published rows are public; content is sanitised on display.
- **Needs:** 01, 02.
- **Switches on:** `/blogs`, `/blogs/[slug]`, admin → **Pages & blog**, and — for each page once
  it is published — `/privacy`, `/terms`, `/returns`, `/pages/[slug]`, its footer link and its
  sitemap entry. An unpublished page is a real 404 and is left out of the footer.
- **Right after:** write the store's own terms and returns pages in admin → Pages & blog and
  publish them (seed 33 adds only the privacy page template, to be reviewed before launch).
- **Check:** `SELECT slug, is_published, show_in_footer, footer_group FROM public.cms_pages ORDER BY footer_group, sort_order;`

### 16 — Homepage content · `16_storefront_content.sql`
- **Adds:** `hero_slides` (image, copy, links, schedule window), `promo_tiles` (the four bento
  tiles), `content_blocks` (hero perks, trust row, "order your way", store status, testimonial,
  new-arrivals feature) and `get_best_sellers` (ranked by real units sold, topped up with products
  marked best seller).
- **Needs:** 04, 07 (and 01, 02).
- **Switches on:** the backend-controlled homepage (hero, promo grid, trust row, "order your way",
  testimonial, best sellers) and admin → **Homepage**.
- **Right after:** load today's approved copy with seed 31, then edit it in admin → Homepage.
- **Check:** `SELECT id, position, is_active, left(title, 40) FROM public.hero_slides ORDER BY position;`

### 17 — Analytics and the admin dashboard · `17_analytics.sql`
- **Adds:** `analytics_events` (written only by `track_event`, only after a shopper accepts
  analytics cookies) and the dashboard figures: sales overview, funnel, top products, search
  terms (including searches with no results), low stock, cart-recovery stats, newsletter growth,
  order status counts — all in the Asia/Colombo business day.
- **Needs:** 12, 13 (and 01, 02, 04, 05, 07).
- **Switches on:** the cookie-consent banner's analytics, admin → **Dashboard** and **Reports**.
- **Check (after browsing the site with analytics accepted):**
  `SELECT event_type, count(*) FROM public.analytics_events WHERE created_at > now() - interval '1 day' GROUP BY 1;`

### 18 — Site lock · `18_site_lock.sql`
- **Adds:** a sealed `site_lock` singleton (locked flag, bcrypt PIN, bypass token, holding-page
  copy, launch time, strike counter) and its functions; 10 wrong PINs → 15-minute cool-off.
- **Needs:** 01, 02.
- **Switches on:** `/launching-soon` and the PIN form, admin → **Site lock**. Nothing is locked
  by default.
- **Right after:** optional — to hide the store before launch, set a PIN (6–12 digits) and lock
  it in the admin. Emergency unlock: `UPDATE public.site_lock SET locked = FALSE WHERE id;`
- **Check:** `SELECT locked, has_pin, launch_at FROM public.get_site_lock();`

### 19 — AI assistant: core · `19_assistant_core.sql`
- **Adds:** `assistant_sessions` and `assistant_messages` (every message PII-redacted on the way
  in: emails, phone numbers and order numbers are masked), `log_assistant_turn`, and the insight
  functions for the admin.
- **Needs:** 17 (and 01, 02, 04).
- **Switches on:** conversation logging for the shopping assistant, admin → **Assistant insights**.
- **Right after:** set `OPENAI_API_KEY` in the host (without it the widget says the desk is away
  and nothing is sent). Send one real message, then check:
  `SELECT role, outcome, left(content, 60) FROM public.assistant_messages ORDER BY id DESC LIMIT 4;`
- **Check:** `SELECT public.redact_pii('mail me at a.b@c.com or +94 77 123 4567 about DO-10023');`
  → `mail me at [email] or [number] about [order]`.

### 20 — AI assistant: offers · `20_assistant_offers.sql`
- **Adds:** `list_live_offers` (public codes with title and minimum only; assistant-only codes
  only for a conversation that has earned them) and `admin_offer_performance`.
- **Needs:** 08, 19.
- **Switches on:** the assistant's "any offers?" answers; performance columns in admin →
  Discounts. The shopper still applies the code at checkout, and checkout still decides.
- **Check:** `SELECT * FROM public.list_live_offers(NULL);` → public codes only.

### 21 — AI assistant: memory and private order lookup · `21_assistant_memory_lookup.sql`
- **Adds:** `get_assistant_customer_context` (for a signed-in shopper only: first name, what they
  bought, their finder profile — never address, phone, email or money),
  `lookup_order_for_assistant` (order number + email from a private form, throttled, audited by
  email *domain* only), `forget_assistant_customer` (admin erase).
- **Needs:** 09, 14, 17, 19.
- **Switches on:** "welcome back" context in the assistant, the private order-status form inside
  the chat, the "forget this customer" action in admin → Assistant insights.
- **Check:** `SELECT has_function_privilege('anon', 'public.get_assistant_customer_context(uuid,text)', 'EXECUTE');` → `false`.

### 22 — Data retention · `22_retention.sql`
- **Adds:** `run_retention` — the daily housekeeping that deletes what the privacy page promises
  not to keep (rate-limit hits 1 day, order-lookup audits 30 days, analytics 13 months, assistant
  conversations 12 months, abandoned carts 90 days after last activity, anonymous finder answers
  12 months). Orders, customers, reviews and subscribers are never touched.
- **Needs:** 13, 14, 17, 19, 21.
- **Right after:** create the job secret, set it as `MAINTENANCE_SECRET`, schedule daily
  `curl -X POST https://<domain>/api/maintenance -H "Authorization: Bearer <MAINTENANCE_SECRET>"`:
  ```sql
  INSERT INTO public.app_config (name, value)
  VALUES ('maintenance', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  SELECT value FROM public.app_config WHERE name = 'maintenance';
  ```
- **Check:** the job's response lists a count per table.

### 23 — Admin catalogue tools · `23_admin_catalogue.sql`
- **Adds:** `admin_save_product` (product + variants + cost prices + stock saved in ONE
  transaction; editing never resets stock), `admin_set_collection_products` (members and their
  order in one call), the `admin_product_list` and `admin_inventory` views, and a trigger that
  removes a deleted product from homepage collection art.
- **Needs:** 04, 05, 07 (and 02).
- **Switches on:** saving in admin → **Products**, ordering in **Collections**, the **Inventory**
  list with low-stock filter.
- **Check:** `SELECT has_table_privilege('anon', 'public.admin_inventory', 'SELECT');` → `false`.

### 24 — Admin account · `24_admin_account.sql`
- **Adds:** nothing new — it sets `is_admin = TRUE` on the account `admin@dockone.lk` (the
  promotion step of 02, as a file). It never creates a login or stores a password.
- **Needs:** 02, and the account itself: sign up at `/signin` and confirm the email, or Supabase →
  Authentication → Users → **Add user** with "Auto Confirm User" ticked.
- **Switches on:** `/admin` for that account.
- **Right after:** read the result row. `admin` means done. `NOT AN ADMIN — …` means the account
  is missing or unconfirmed and nothing changed: fix that and run the file again.
- **Check:** `SELECT email, is_admin FROM public.customers WHERE is_admin;` → the admins, and nobody else.

### 25 — Serial numbers · `25_serial_numbers.sql`
- **Adds:** `product_units` — one row per physical unit: its variant, its **serial number**, and
  whether it is in stock or sold (and to which web-order line / invoice line). Stock *counts* stay
  in `inventory` (what shoppers can buy); the units are the physical register on top.
  `admin_set_product_serials` (the product editor's stock intake), `admin_assign_order_serials`
  (fulfilment: which serials leave with a web-order line), and a trigger that puts a cancelled
  order's serials back in stock.
- **Needs:** 02, 04, 07, 23.
- **Switches on:** admin → Products: with stock tracked, each variant shows **one serial-number box
  per unit in stock** (set the stock to 3 → three boxes; scan or type, Enter moves to the next).
  Admin → Orders → an order: **Serial numbers** on each line — pick the units in stock (or type a
  serial that was never recorded) when packing; they print on the packing slip and the invoice.
- **Right after:** existing stock has no serials yet — enter them per product when convenient
  (nothing breaks without them).
- **Check:** `SELECT has_table_privilege('anon', 'public.product_units', 'SELECT');` → `false`.

### 26 — Invoices · `26_invoices.sql`
- **Adds:** `invoice_settings` (one row: numbering, the header text, the ten notes, defaults —
  filled from the client's invoice workbook), `invoices`, `invoice_items` (with one serial per
  unit), `invoice_payments`, and the admin RPCs to save, issue, move back to draft, void, delete
  drafts, record/delete payments, search the catalogue (by name or a scanned serial) and clients,
  and the list's figures. Numbers are given on **issue** and never skip (INV-0001, INV-0002 …);
  issuing can take the items out of stock (on by default; off for an invoice made from a web
  order) and sells the listed serials; back to draft / void put both back.
- **Needs:** 05, 07, 23, 25.
- **Switches on:** admin → Commerce → **Invoices** (list, figures, builder with live A4 preview,
  print / save as PDF), **Create invoice** in the order drawer, invoice search by serial number.
- **Right after:** admin → Invoices → **Template & numbering**: set the **next number** to carry
  on from the last paper invoice, check the address, contacts and notes.
- **Check:** `SELECT number_prefix, next_number, cardinality(default_notes) FROM public.invoice_settings;`
  → `INV-`, `1`, `10`.

---

## 3. Demo content (seeds 30–33) — optional, replace before launch

The seeds move the **approved design's existing content** into the database — nothing more. No
reviews, stock levels, cost prices, descriptions or company facts are invented; unknowns are left
empty for the owner. Each seed runs once (an `app_config` marker stops a re-run from bringing
deleted demo rows back) and each header contains the exact statement that removes it.

| Seed | Fills | Needs | Before launch |
| --- | --- | --- | --- |
| `30_seed_catalogue.sql` | the 4 categories (the store's real departments — keep), 16 demo products with one "Standard" variant each at the design's prices, the 4 homepage collections | 04, 05, 06 | Replace the demo products with real ones (admin → Products) or run the DELETE in the header |
| `31_seed_storefront.sql` | store settings from the current site copy (phone, WhatsApp, email and address are the design's **placeholders**), 3 hero slides, 4 promo tiles, the homepage copy blocks, ticker, "We accept" labels. Claims checkout can't back (card payments, instalments, "10K+ orders", "99%", "up to 40% off", the sample testimonial) were removed, not rewritten | 01, 03, 16 (artwork uses seed 30's products) | Enter real contact details (the bank account comes from 03 and is real — this seed does not touch it); set a real flash-sale end time if you run one (the section stays hidden until then); review the homepage copy |
| `32_seed_discounts.sql` | the one code the design already accepted: `OPENING10` (10 % off) | 08, 09 | Keep only if the offer is real; otherwise pause or delete it |
| `33_seed_content_pages.sql` | the privacy page, published, as a **template**: it lists what this build really collects, the retention periods of 22 and the processors used; business name, address, contact email and hosting provider are `[BRACKETED]` placeholders | 01, 15 | Fill the placeholders, have it reviewed, delete the "Template" note; the retention periods hold only once the daily maintenance job (22) runs |

### Real inventory (34–35)

Generated from the client's handoff workbook by `scripts/db/inventory/build_seed.py` (re-run it if
the workbook changes; never hand-edit the SQL). Every price, cost and quantity is read from the
workbook cell.

| File | Fills | Needs | After running |
| --- | --- | --- | --- |
| `34_seed_inventory.sql` | 5 new departments (Monitors, Audio, Power & Charging, Cameras & Instax, Networking & Components; "Mice" → "Mice & Mousepads"); 59 products / 86 variants — colour, size, capacity, switch and GPU rows grouped as variants of one product; price = "Final Selling" (a range uses the **lower** figure, the range is kept); stock = "Quantity"; brand excerpts as highlights. Adds two **admin-only** tables, `product_sourcing` (brand title, brand page, review notes incl. HOLD items) and `variant_sourcing` (workbook row, original text, colour, dealer price, price note). Switches the 16 demo products and 4 demo collections **off** (not deleted) | 04, 05, 30 | Add photos and descriptions (admin → Products); review the HOLD notes (query in the file's ops note); set new / best-seller / flash-deal flags and featured collections so the homepage sections fill again |
| `36_seed_inventory_update.sql` | From the second stock list (`scripts/db/inventory/build_update.py`): new product ASUS VivoBook E1504FA-BQ2909 and new variant JBL Tune 730BT White — both in stock but **unpriced, so switched off**; stock A1504VA 1→2, MK270 2→3, Cruzer Blade 16GB 0→1 (only where stock still holds 34's figure); Blackshadow colour Black; One Touch "2TB Black" → "2TB"; "gaming laptop" tag | 34 | Price the two new items and switch their variants on |
| `35_seed_inventory_costs.sql` | "Cost per unit" → `product_costs`, "Dealer Selling" → `variant_sourcing.dealer_price` | 34 | — . **Git-ignored**: the repo is public and these are the client's margins. Keep the file safe outside the repo |

---

## 4. Go-live checklist

1. Migrations `01`–`23` applied in order; seeds only if wanted; `24` run after the admin account
   is created and confirmed.
2. Secrets created in the database **and** set in the host with the same values:
   `RATE_LIMIT_SECRET` (01), `CART_RECOVERY_SECRET` (13), `MAINTENANCE_SECRET` (22).
3. Jobs scheduled: `/api/cart-recovery` hourly, `/api/maintenance` daily (`docs/build/JOBS.md`).
4. Supabase Auth configured per `docs/build/AUTH_SETUP.md`; the owner promoted to admin (02).
5. Admin → Settings: real contact details; bank account checked (Payments — filled by 03);
   pickup address or pickup off; delivery fee and free-delivery threshold confirmed.
6. Email: `RESEND_API_KEY`, `RESEND_FROM_EMAIL` (verified domain), `ORDER_NOTIFICATION_EMAIL`.
7. Assistant: `OPENAI_API_KEY` (optional `ASSISTANT_MODEL`, default `gpt-5.4-mini`).
8. `NEXT_PUBLIC_SITE_URL` set to the real domain; demo products, demo code and placeholder
   contacts replaced.
9. Privilege audit on the live database — every `true` must be intended (compare with the
   allow-lists in `supabase/tests/99_privileges.test.sql`):
   ```sql
   SELECT p.oid::regprocedure AS fn,
          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' ORDER BY 2 DESC, 3 DESC, 1;
   ```
