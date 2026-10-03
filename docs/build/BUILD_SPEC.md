# Dock One Solutions — Commerce Build Spec

This is the contract every build agent follows. It maps `docs/commerce-platform-blueprint.md`
(the **blueprint**) onto this storefront. Where this spec and the blueprint disagree, **this spec wins**;
where this spec is silent, **the blueprint wins**. The blueprint's §2 principles (P1–P15) are laws.

Read before writing code: `AGENTS.md` (Next.js 16 — read `node_modules/next/dist/docs/` for any API you use),
`DESIGN.md` (the visual contract — the client approved the design; keep it), blueprint §2–§9 and the section
for your feature.

---

## 1. Business profile (blueprint §1, filled in)

| Key | Value |
| --- | --- |
| `BRAND` | Dock One Solutions (`src/data/site.ts` keeps name + wordmark only) |
| `SITE_URL` | `NEXT_PUBLIC_SITE_URL` (fallback `https://dockonesolutions.com` — the live domain) |
| `BASE_CURRENCY` | **LKR**. Prices are whole rupees; display `Rs. 489,900` (existing `formatLKR`). Stored `NUMERIC(12,2)` |
| `DISPLAY_CURRENCIES` | LKR (base), USD, GBP, EUR, AUD, INR, AED — presentation only (§9.3) |
| `COUNTRY` / `MARKET` | Sri Lanka, island-wide delivery (25 districts) + optional showroom pickup |
| `PRODUCT_NOUN` | product |
| `VARIANT_AXIS` | configuration — e.g. `16GB / 512GB`, `1TB`, `Red switches`, `Black` → **variant model B** (priced variants) |
| `DOMAIN_ATTRIBUTES` | `products.attributes.specs` per category (§4.4) |
| `GROUPING` | category (laptops / storage / keyboards / mice, more later) → brand; curated collections |
| `PAYMENT_METHODS` | `cod` (status `pending_collection`) and `bank_transfer` (status `awaiting_transfer`), each toggleable in store settings. **No card fields** anywhere |
| `SHIPPING_RULE` | **stored in the database** (`store_settings.delivery_fee = 450`, `free_delivery_threshold = 15000`). `place_order` reads it; the storefront reads the same row. Pickup orders pay no delivery |
| `MAX_QTY_PER_LINE` | 10 (the existing `MAX_QTY`) — mirrored in SQL `place_order` |
| `ORDER_PREFIX` | `DO-` + sequence starting 10001 → `DO-10001` |
| `EMAIL_FROM` / `OWNER_ALERT_EMAIL` | `RESEND_FROM_EMAIL` / `ORDER_NOTIFICATION_EMAIL` |
| `HOST` | Vercel by default: client IP header `x-real-ip`, overridable with `CLIENT_IP_HEADER` |
| `TIMEZONE` | `Asia/Colombo` |
| `LLM_PROVIDER` / `LLM_MODEL` | **Exactly the blueprint stack (§3.1, §10.4):** Vercel AI SDK `ai` 7.0.x + `@ai-sdk/openai` 4.0.x, `OPENAI_API_KEY`, model `ASSISTANT_MODEL` default `gpt-5.4-mini`, `providerOptions.openai.reasoningEffort = "low"`, no `temperature`. The model is named in ONE file (`lib/assistant/model.ts`) so swapping provider is a two-line change |
| `ASSISTANT_PERSONA` | "the Dock One tech desk": a straight-talking, knowledgeable tech advisor. Plain English; mirrors Sinhala/Tamil if the shopper writes in it. Never pushy |
| `KNOWLEDGE_DOMAIN` | spec literacy (CPU/GPU tiers, RAM, SSD vs HDD, NVMe, USB/Thunderbolt standards), keyboards (switches, layouts, connectivity), mice (sensors, DPI, weight, grip), compatibility, Sri Lankan market specifics (230 V Type D/G plugs, power surges → UPS/surge protector, humidity and dust care, local official warranty) |
| `RECOMMENDER_AXES` | blueprint §17.1 consumer-electronics row: performance, portability, battery, price-value (`value`) — `ecosystem` is dropped because the catalogue has no OS/ecosystem data (§9.14: remove what the stock can't honour); physical property `weight` |
| `FINDER_QUESTIONS` | §4.5 |
| `LEGAL_IDS` | `store_settings.business_reg_no` — rendered only when set |
| `SOCIAL` / contact | `store_settings` (phone, whatsapp, email, address, socials) — rendered only when set |

---

## 2. Global decisions

0. **Blueprint fidelity (owner's instruction): follow the blueprint; do not make things up.** Use the blueprint's file names, route names, table names, function names, flows, limits and copy rules wherever it gives them (§5 layout, §7 schema/RPCs, §8 routes, §9–§12). Do not add features, data, claims or UI the blueprint or the existing approved design does not call for. The ONLY extensions are the ones listed here, each because the existing approved design needs it to be backend-controlled or honest:
   (a) `store_settings` (shipping rule, payments, contact, ticker) — the owner asked for backend control; `place_order` reads it (P1, P6);
   (b) `hero_slides`, `promo_tiles`, `content_blocks`, `categories` — the existing homepage banners/cards have no blueprint table;
   (c) product reviews — the approved cards show star ratings, which must come from real rows (P15);
   (d) bank transfer + showroom pickup — both are in the approved design copy; added through the blueprint's payment seam (§9.4);
   (e) `quote_order` — read-only twin of `place_order` so every total the shopper sees is server-resolved (P1/P4).
   Anything else that looks like an addition: don't build it — note it in your report instead.

1. **Supabase is the backend.** Three clients per blueprint §4 (stateless anon, cookie session, browser singleton). **No service-role key in the app.**
2. **No static product data at runtime.** `src/data/products.ts` and `src/data/image-manifest.json` are replaced by the database + seed migrations. Existing images in `public/images/**` stay and are referenced by path from seed rows (e.g. `/images/products/lap-01.webp`). Admin uploads go to Supabase Storage (`product-images`, `content-images` buckets).
3. **Everything the homepage shows is backend-controlled** (§6): hero slides, promo tiles, category cards, featured collections, flash deals (+ a real end time), new arrivals, best sellers, trust row, "order your way", store status, testimonial, ticker, top bar message, footer contact/socials/payment labels, delivery rule.
4. **Honesty (P15) fixes to the approved copy.** No card/instalment/"encrypted payment" claims (checkout is COD + bank transfer); the flash-deal countdown counts to a real `flash_sale_ends_at` and the section hides when there is none; ratings and review counts come from real review rows; category counts are real; "store status" figures are owner-edited content (seeded honestly). The look stays identical — only the claims change.
5. **Caching:** do **not** enable `cacheComponents`. Storefront reads go through `src/lib/cache.ts` (non–Cache-Components model, see `node_modules/next/dist/docs/01-app/02-guides/caching-without-cache-components.md`), tagged `catalogue`, `content`, `settings`, `reviews`. Admin writes call `POST /api/admin/revalidate { tags }` after a confirmed write. Storefront pages are static/ISR-friendly: **auth state on storefront pages is read client-side** (`useViewer()`), never via cookies in a shared layout. Account, checkout, order and admin pages are dynamic.
6. **Route groups:** `src/app/layout.tsx` = html/body/fonts only. `src/app/(store)/layout.tsx` = storefront chrome (TopBar, Header, Footer, CartDrawer, Toaster, widgets, providers). `src/app/admin/**` has its own chrome. `src/app/launching-soon` has none.
7. **Money:** every price the shopper sees renders through `<Price amount={n} />` (client, display-currency aware). Server-side emails/admin use `formatLKR`. Checkout sends `currency` + `exchangeRate`; SQL records them and charges LKR.
8. **Variants (model B):** every product has ≥ 1 variant; a single-variant product hides the selector. Cart lines are keyed by `variantId`. `place_order` prices from `product_variants`. `products.price` / `compare_at_price` are the **"from" price** (cheapest active variant) maintained by trigger — display and sorting only.
9. **Errors are a contract** (blueprint P13, §7.6). Missing RPC → 503 naming the migration file.
10. **Every public write** = route handler in blueprint §6.7 order → one RPC. No anonymous table writes.
11. **Accessibility and design:** follow `DESIGN.md` §6 primitives and states, focus rings, ≥ 40 px targets, `aria-*` as the existing components do. New storefront pages reuse the existing visual language (mono labels, `/NN` indices, hairlines, chamfers, violet/lime). Admin has its own calmer token set (still brand-consistent).

---

## 3. Migrations — one file per feature (the owner applies them in order)

Location `supabase/migrations/NN_name.sql`. Nothing has been applied to a live database yet, so **before hand-off** an
owning agent may edit its own files; after hand-off they become append-only (P11). Every file: idempotent, header block
(purpose, depends on, what it enables), `OPS NOTE` footer (secrets, verification SQL, "do this or the feature stays off").
Tests: `supabase/tests/NN_name.test.sql` (blueprint Appendix B.2 style), harness `supabase/tests/harness.sql` (Appendix B.1).
Verify with `scripts/db/verify.sh` (§8).

| # | File | Feature | Author (phase 1) | Owner (phase 2) |
| --- | --- | --- | --- | --- |
| 01 | `01_foundation.sql` | pgcrypto, `touch_updated_at`, `app_config`, `verify_job_secret`, rate limiting | SQL-1 | F |
| 02 | `02_customers_and_auth.sql` | customers, `is_admin()`, signup/confirm triggers, guest-order linking, pinned columns | SQL-1 | WP-D |
| 03 | `03_store_settings.sql` | singleton `store_settings` (§4.2) — shipping rule, payments, contact, socials, ticker, flash sale | SQL-1 | WP-B |
| 04 | `04_catalogue.sql` | categories, products, product_variants, product_costs, collections, product_collections, rule sync, from-price rollup, storage buckets, RLS | SQL-1 | WP-K |
| 05 | `05_inventory.sql` | inventory per variant, `get_product_availability()` | SQL-1 | WP-K |
| 06 | `06_catalogue_search.sql` | search vector + `search_products()` RPC, facets helper | SQL-1 | WP-A |
| 07 | `07_orders.sql` | order seq, orders, order_items (snapshots), order_tracking, owner RLS | SQL-2 | WP-C |
| 08 | `08_discounts.sql` | discounts (+ `assistant_only` cap CHECK) | SQL-2 | WP-C |
| 09 | `09_order_rpcs.sql` | `quote_order`, `place_order`, `validate_discount`, `track_guest_order`, `view_order`, `admin_set_order_status`, `admin_set_payment_status` | SQL-2 | WP-C |
| 10 | `10_wishlists.sql` | wishlists + owner RLS, `merge_wishlist()` | SQL-2 | WP-D |
| 11 | `11_reviews.sql` | product_reviews, `submit_review()`, rating rollup, moderation | SQL-2 | WP-J |
| 12 | `12_leads.sql` | newsletter_subscribers, contact_inquiries, email_suppressions + RPCs | SQL-3 | WP-E |
| 13 | `13_abandoned_carts.sql` | capture + 3-stage recovery functions, grandfather backfill | SQL-3 | WP-E |
| 14 | `14_finder.sql` | finder_responses, `record_finder_response()` | SQL-3 | WP-F |
| 15 | `15_content_pages.sql` | cms_pages, blog_posts (public read only when published) | SQL-3 | WP-G |
| 16 | `16_storefront_content.sql` | hero_slides, promo_tiles, content_blocks, `get_best_sellers()` | SQL-3 | WP-B |
| 17 | `17_analytics.sql` | analytics_events, `track_event()`, admin aggregate RPCs | SQL-3 | WP-H |
| 18 | `18_site_lock.sql` | site lock singleton + 5 functions | SQL-3 | WP-H |
| 19 | `19_assistant_core.sql` | assistant_sessions/messages, `redact_pii`, `log_assistant_turn`, insight RPCs | SQL-4 | WP-I |
| 20 | `20_assistant_offers.sql` | `list_live_offers`, `admin_offer_performance` | SQL-4 | WP-I |
| 21 | `21_assistant_memory_lookup.sql` | customer context, forget, order lookups | SQL-4 | WP-I |
| 22 | `22_retention.sql` | `run_retention(secret)` | SQL-4 | WP-H |
| 23 | `23_admin_catalogue.sql` | admin-only atomic product save (product + variants + costs + inventory), duplicate, reorder | phase 2 | WP-K |
| 30 | `30_seed_catalogue.sql` | **DEMO** the existing 4 categories, 16 products (one Standard variant each), parsed specs, existing collections | SQL-1 | WP-A |
| 31 | `31_seed_storefront.sql` | **DEMO** store settings values, hero slides, promo tiles, content blocks | phase 2 | WP-B |
| 32 | `32_seed_discounts.sql` | **DEMO** `OPENING10` (the code the current basket already accepts) | phase 2 | WP-C |
| 33 | `33_seed_content_pages.sql` | privacy (lists everything collected, §12.1.6) + pages the system can state truthfully; other pages left to the owner | phase 2 | WP-G |

Seeds: separate from schema, `ON CONFLICT DO NOTHING`, never explicit SERIAL ids (reference rows by slug),
self-verifying `DO` block at the end, header says **DEMO — replace or delete before launch** and includes the one
statement that removes the demo rows.

**Seeds carry only what already exists in the approved site — nothing invented** (owner's instruction; blueprint §7.3
"guessing is worse than omitting", P15): products, prices, compare-at prices, specs lines, flags, category taglines,
collection tiles, hero/promo/trust/ticker copy, the `OPENING10` code and contact placeholders all come from the current
`src/` files. Therefore: one `Standard` variant per product at today's price (no invented configurations); `attributes.specs`
only holds facts parsed from the existing spec line (e.g. "Ryzen 7 · RTX 4060 · 16GB · 1TB SSD"); no invented
descriptions, brands beyond the product line name, stock numbers (no inventory rows = untracked, the blueprint's
documented behaviour), cost prices, reviews, extra discount codes, or company/about/careers copy. Copy that the
checkout cannot honour (cards, instalments, "encrypted payment") or that a new store cannot truthfully claim
("10K+ orders", "99% satisfaction") is left out of the seed rather than rewritten into new claims. Seed 34 (reviews) is
dropped. CMS pages the system can describe truthfully (privacy — required by blueprint §12.1.6 — cookie use, returns
window / delivery rule read from settings) are seeded; everything else is left for the owner to write.

---

## 4. Schema contract (shared tables)

Blueprint §7.3 + Appendix A are the baseline. Changes and additions:

### 4.1 customers (02)
Blueprint columns, address keys = checkout `shipping` JSON keys: `street`, `city`, `district` (one of the 25 Sri Lankan
districts), `postal_code`, `country` (default `'Sri Lanka'`), plus `phone`. Guest orders are linked on **confirmed** email.

### 4.2 store_settings (03) — singleton `id BOOLEAN PK DEFAULT TRUE CHECK (id)`
`store_name`, `delivery_fee NUMERIC(10,2) DEFAULT 450`, `free_delivery_threshold NUMERIC(12,2) DEFAULT 15000` (NULL = never
free), `cod_enabled BOOL DEFAULT TRUE`, `cod_max_total NUMERIC NULL`, `bank_transfer_enabled BOOL DEFAULT TRUE`,
`bank_transfer_instructions TEXT` (bank, branch, account name/number — shown on confirmation + email; **2026-09-28:** the
account is now the structured `bank_account_name`, `bank_name`, `bank_branch`, `bank_account_number` and this column is an optional extra note — SQL_NOTES §03),
`pickup_enabled BOOL DEFAULT TRUE`, `pickup_address TEXT`, `pickup_note TEXT`, `phone`, `whatsapp`, `email`, `address`,
`map_url`, `opening_hours`, `business_reg_no` (all nullable, rendered only when set), `socials JSONB DEFAULT '{}'`
(`facebook|instagram|tiktok|youtube` → URL), `announcement TEXT` (top-bar override), `ticker_items TEXT[]`,
`accepted_payment_labels TEXT[]` (footer "We accept"), `flash_sale_title TEXT`, `flash_sale_ends_at TIMESTAMPTZ`,
`returns_window_days INT DEFAULT 7`, `warranty_note TEXT`, `updated_at`, `updated_by UUID`.
RLS: public `SELECT`; admin `UPDATE` (WITH CHECK); no INSERT/DELETE policy. The row is created by the migration with
defaults only (the values the client sees come from seed 31).

### 4.3 Catalogue (04, 05)
- `categories`: `id TEXT PK` (slug `^[a-z0-9][a-z0-9-]*$`), `name`, `tagline`, `description`, `stage_image_url`,
  `hero_product_id INT → products ON DELETE SET NULL` (FK added after `products` exists), `scene TEXT CHECK IN
  ('night','paper','lime','violet')`, `sort_order`, `is_active`, `seo_title`, `seo_description`, timestamps.
- `products`: `id SERIAL`, `slug TEXT UNIQUE` (same pattern), `brand`, `name`, `subtitle` (the one-line spec shown on
  cards), `description`, `category_id TEXT → categories`, `price`, `compare_at_price` (**from-price, trigger-maintained**),
  `image_url` (= `image_urls[1]`), `image_urls TEXT[]`, `cutout_url` (transparent cut-out for pop-outs/banners),
  `tags TEXT[]`, `attributes JSONB` (§4.4), `warranty_months INT`, `is_active`, `is_new`, `is_bestseller`, `is_featured`,
  `is_flash_deal`, `sort_order INT DEFAULT 100`, `rating_avg NUMERIC(3,2) DEFAULT 0`, `rating_count INT DEFAULT 0`
  (maintained by 11), `seo_title`, `seo_description`, timestamps.
- `product_variants`: `id SERIAL`, `product_id → products CASCADE`, `sku TEXT UNIQUE NULL`, `name TEXT NOT NULL`
  (`Standard` for single-variant products), `option_values JSONB DEFAULT '{}'` (e.g. `{"Memory":"16GB","Storage":"512GB"}`),
  `price NUMERIC(12,2) NOT NULL CHECK ≥ 0`, `compare_at_price NULL` (must be > price to display), `position`,
  `is_active`, `weight_g`, timestamps. Trigger recomputes the parent's from-price on insert/update/delete.
  Public read: active variants of active products.
- `product_costs` (admin-only, sealed from anon) keyed by `variant_id`.
- `collections` / `product_collections`: blueprint shape (+ `is_active`, `is_featured` for the homepage row,
  `feature_product_ids INT[]` (≤ 2, the tile art: back/front cut-outs), `sort_order`). Rule fields: `category`, `brand`,
  `tag`, `price lt/gt`, `is_new`, `is_flash_deal`. Automated membership re-evaluates both ways (product change and
  collection change).
- `inventory` (05): `variant_id INT PK → product_variants CASCADE`, `product_id INT → products CASCADE`,
  `stock_level INT CHECK ≥ 0`, `low_stock_threshold INT DEFAULT 3`, `updated_at`. **No row = not tracked = always sells.**
  Admin-only. `get_product_availability(p_product_ids INT[])` → `(product_id, variant_id, stock_level, low_stock)` for
  ≤ 24 products, never the threshold.
- Storage buckets (public, admin-only writes): `product-images`, `content-images`.

### 4.4 `products.attributes` shape (documented in `docs/domain-model.md` by SQL-1)
```jsonc
{
  "specs": { /* per category, snake_case keys, numbers as numbers */ },
  "highlights": ["short selling points, ≤ 5"],
  "use_cases": ["everyday" | "gaming" | "creative" | "mobile" | "backup"],
  "in_the_box": ["..."]
}
```
- laptops: `cpu, gpu, ram_gb, storage_gb, storage_type, display, refresh_hz, weight_kg, battery_wh, battery_h, os, ports[]`
- storage: `capacity_gb, type ("Portable SSD"|"External HDD"|"Flash drive"|"Desktop drive"), interface, read_mbps, write_mbps, rugged ("IP65"|null), weight_g`
- keyboards: `layout ("60%"|"75%"|"TKL"|"Full-size"), switch, hot_swap, connectivity[], backlight, keycaps, battery_h, weight_g, os_compat[]`
- mice: `sensor, dpi_max, weight_g, connectivity[], buttons, grip ("palm"|"claw"|"fingertip"|"vertical"), battery_h, silent`
A product with no `specs` is excluded from the finder.

### 4.5 Guided finder questions (blueprint §9.14 + §17.1 electronics row)
Blueprint §17.1 electronics questions are: use case, budget, ecosystem, portability, **avoid** (brands/sizes). Because the store
sells four unrelated device types, a first "what are you shopping for" question selects the category (the analogue of the
reference store's "recipient" question). Ecosystem is dropped (no data to honour it). Defined in `src/lib/quiz.ts`:
| id | kind | options |
| --- | --- | --- |
| `category` | single | laptops · storage · keyboards · mice (only categories with finder-eligible products) |
| `use` | single | the use cases present in the catalogue's `attributes.use_cases` / specs for that category (e.g. everyday, gaming, creative, portable) |
| `budget` | single | budget-friendly · balanced · best available · no limit (price tertiles within the category) |
| `portability` | single | must be light/compact · doesn't matter |
| `avoid` | multi | brands present in the category · wired (when wireless exists) · heavy · nothing |
Any option the stock can't honour for the chosen category is hidden.

### 4.6 Orders (07–09)
Blueprint shape plus: `id` = `'DO-' || nextval`, `currency DEFAULT 'LKR'`, `payment_method CHECK IN ('cod','bank_transfer')`,
`payment_status CHECK IN ('pending_collection','awaiting_transfer','paid','refunded','void')`,
`fulfillment CHECK IN ('delivery','pickup') DEFAULT 'delivery'`, `customer_note TEXT`, `phone NOT NULL`.
`order_items`: `variant_id → product_variants SET NULL`, snapshots `product_name, brand, variant_name, sku, image_url`.
`place_order` reads the shipping rule and enabled payment methods from `store_settings`; pickup ⇒ fee 0 and address optional.
`quote_order(p_items, p_discount_code, p_fulfillment)` is the read-only twin (authoritative prices, availability, fee,
discount) used by cart + checkout summaries. `view_order(p_order_id, p_token)` unlocks the confirmation page.

---

## 5. Cross-feature contracts (Foundation creates these with final signatures; owners fill them in)

| Module | Signature (keep it) | Implemented by |
| --- | --- | --- |
| `src/lib/cart.ts` | `CartLine = { productId, variantId, qty, slug, name, brand, variantName, price, compareAtPrice, imageUrl, categoryId }`; `cart.add(line: Omit<CartLine,"qty">, qty?)`, `cart.setQty(variantId, qty)`, `cart.remove(variantId)`, `cart.clear()`, `cart.reprice(updates)`, `cart.open()`, `cart.close()`, `useCart()` → `{ lines, count, subtotal, savings, delivery, toFreeDelivery }`, `useCartDrawer()`, `MAX_QTY = 10` | F |
| `src/lib/settings.ts` (server) + `useStoreSettings()` (client, via provider in `(store)/layout.tsx`) | `getStoreSettings(): Promise<StoreSettings>`; `PublicStoreSettings`; shipping maths in `src/lib/delivery.ts` (the blueprint's `lib/shipping.ts`; see FOUNDATION_NOTES for exact names) — **mirror of `place_order`**, which reads the same `store_settings` row | F |
| `src/lib/catalogue.ts` (server) + `src/lib/catalogue-shared.ts` (client-safe) | types `ProductCardData`, `ProductDetail`, `ProductVariant`, `Category`, `Collection`; `PRODUCT_CARD_FIELDS`; `getCategories`, `getCategory`, `listProducts(filters)`, `getProductBySlug`, `getProductsByIds`, `getCollections`, `getCollection`, `getBrands`; `productHref(slug)`, `categoryHref(id)`, `collectionHref(id)`, `discountPercent` | F (WP-A may extend) |
| `src/components/product/{ProductCard,ProductImage,AddToCartButton,WishlistButton,Rating}.tsx` | take `ProductCardData`; `AddToCartButton` adds the default variant, or links to the product page when `variantCount > 1` | F |
| `src/components/ui/Price.tsx`, `src/lib/currency*.ts`, `GET /api/rates` | `<Price amount={lkr} className? />`, `useCurrency()` | F |
| `src/lib/viewer.ts` (client) | `useViewer()` → `{ status: "loading"|"guest"|"signed_in", user: { id, email, firstName } | null, isAdmin }` | F (WP-D may extend) |
| `src/lib/wishlist.ts` | `wishlist.toggle(productId: number, meta?)`, `useWishlist(): number[]` | F (local) → WP-D (hybrid local + DB sync) |
| `src/lib/analytics.ts` (client) | `track(type: EventType, props?)`; `EventType` = `page_view`, `product_view`, `category_view`, `collection_view`, `search`, `add_to_cart`, `remove_from_cart`, `begin_checkout`, `wishlist_add`, `finder_complete`, `assistant_open`, `newsletter_signup` (must equal the SQL CHECK in 17) | stub F → WP-H |
| `src/lib/checkout-autosave.ts` (client) | `useCheckoutAutosave(draft: CheckoutDraft | null): { cartId: string }` — stable per-session UUID | stub F → WP-E |
| `src/lib/offer-code.ts` (client) | `stashOfferCode(code)`, `takeOfferCode()`, `OFFER_CODE_EVENT` (24 h TTL, read-and-clear) | F |
| `src/lib/quiz.ts` (client-safe) + `src/lib/quiz-catalogue.ts` (server) | blueprint §9.14: `QUESTIONS`, `recommend(answers, catalogue, opts?) → { productId, match, style, reason }[]` (runs in the browser on /discover and on the server for the assistant's `recommend_for_profile`); `fetchCatalogueForFinder()` | WP-F (foundation stub `src/lib/finder/engine.ts` is folded in) |
| `src/lib/site-lock-gate.ts` | `siteLockGate(request: NextRequest): Promise<NextResponse | null>` (null = pass) | stub F → WP-H |
| `src/lib/email/send.ts`, `src/lib/email/layout.ts` | `sendEmail({to,subject,html,text})`, `getOwnerNotificationAddress()`, `emailShell({preheader,eyebrow,heading,intro,bodyHtml})`, `esc()` | F. Templates: `src/lib/email/templates/<feature>.ts` by each owner |
| `src/components/reviews/ProductReviews.tsx` | `({ productId, productName, ratingAvg, ratingCount })` server component | stub F → WP-J |
| `src/components/analytics/{ConsentBanner,PageViewTracker}.tsx` | no props | stub F → WP-H |
| `src/components/assistant/AssistantWidget.tsx` | no props | stub F → WP-I |
| `src/components/account/AuthListener.tsx` | no props (sign-out clears per-person state, wishlist merge on sign-in) | stub F → WP-D |
| `src/components/seo/SiteJsonLd.tsx` | Organization JSON-LD | stub F → WP-A |
| Admin shell + kit | `src/components/admin/registry.ts` lists every tab; `src/components/admin/tabs/<Key>Tab.tsx` stubs; kit in `src/components/admin/ui/*` and `src/lib/admin/*` (`adminWrite` checks `{error}` + row count, `useAdminQuery` with cancellation, CSV, print-to-PDF, image upload → WebP → Storage, confirm dialog, toasts queue) | F; each tab by its owner |
| `POST /api/admin/revalidate` + `revalidateStorefront(tags)` | admin-gated tag revalidation | F |
| `src/lib/sri-lanka.ts` | `DISTRICTS` (25), `normalizeLkPhone()`, `isLkPhone()` | F |
| `src/lib/viewed.ts` (client) | `recordProductView(id: number)`, `getViewedProductIds(): number[]` (sessionStorage, ≤ 12) — the assistant sends it as context | WP-A |
| window event `dockone:signed-out` | dispatched by AuthListener on sign-out; the assistant widget clears its transcript (`dockone.assistant.v1`) and rotates its session id | WP-D dispatches, WP-I listens |
| Checkout prefill | `/checkout` reads the signed-in viewer's own `customers` row itself (session client) | WP-C |
| Form primitives `src/components/ui/form.tsx`, `Breadcrumbs`, `PageHeader`, `Notice`, `Pagination`, `EmptyState` | storefront-styled | F |

Owners must keep these signatures. If a signature truly must change, change it and **every caller** in one step, and
say so in your report.

---

## 6. Homepage and chrome → data source (WP-B)

| Element (existing component) | Source |
| --- | --- |
| TopBar message | `store_settings.announcement` ?? delivery rule sentence; `Cur:` becomes the display-currency switcher |
| Header nav / MobileMenu | active `categories` → `/shop?category=…` (+ Deals `/shop?filter=deals`, New `/shop?filter=new` — the existing nav items) |
| Hero slides (`Hero`) | `hero_slides` (image_url, fallback scene, tone, background, chip, eyebrow, `title` with safe mini-markup `{lime:…}` `{violet:…}` and `\n`, body, cta/secondary label+href, readout[], position, is_active, starts_at/ends_at) |
| Hero perks | `content_blocks['hero_perks']` |
| CategoryPopouts | `categories` (stage image, hero product cut-out, scene, **real** active product count) |
| PromoGrid | `promo_tiles` (slot 1–4 keeps the bento geometry, image, fallback scene, tone, eyebrow, title lines, text, cta, href, background, object-position) |
| Collections | `collections where is_featured` (tile art from `feature_product_ids` cut-outs) |
| FlashDeals + Countdown | products `is_flash_deal`; countdown to `store_settings.flash_sale_ends_at`; section hidden when unset/past |
| NewArrivals | products `is_new` (newest first) + `content_blocks['new_arrivals_feature']` (product slug, title, kicker) |
| BestSellers | `get_best_sellers(limit)`: units sold in last 90 days, topped up with `is_bestseller` products |
| TrustRow / OrderYourWay / store status / testimonial | `content_blocks` (`trust_row`, `order_your_way`, `store_status`, `testimonial` — or the newest featured approved review) |
| Newsletter form | `POST /api/newsletter` (source `home`/`footer`) — WP-E owns `NewsletterForm.tsx` |
| Footer | contact + socials + payment labels from `store_settings`; link columns from categories + CMS pages |

Every section degrades gracefully: no rows → the section is hidden (never a broken grid, never invented content).

---

## 7. Routes and file ownership

**Routes follow blueprint §5 / §8.** Storefront pages (all under `app/(store)/`): `/` · `/shop` (all products; `?category=laptops`, `?q=` search, `?filter=deals|new`, brand/price/sort params) · `/collections` · `/collection/[id]` (id = collection slug) · `/product/[id]` (numeric id, blueprint §9.1) · `/cart` (existing) · `/checkout` · `/order/[id]` (view token) · `/track` · `/signin` (sign in + create account + forgot password on one page) · `/reset-password` · `/auth/callback` (route handler, outside the group) · `/customer/dashboard` (tabs: order history, saved items, tracking, settings — blueprint §9.13) · `/wishlist` · `/discover` · `/recover` · `/recover/stop` · `/newsletter/unsubscribe` · `/contact` · `/blogs` · `/blogs/[slug]` · `/privacy` · `/terms` · `/returns` · `/pages/[slug]` (other published `cms_pages`, e.g. delivery, warranty — only pages the owner publishes) · `/launching-soon` (no chrome). Link helpers in `lib/catalogue-shared.ts`: `productHref(p)` → `/product/<id>`, `collectionHref(id)` → `/collection/<id>`, `categoryHref(id)` → `/shop?category=<id>`.

**Module names:** blueprint §0.2 lets implementation files be renamed freely, so the foundation's names stand (`lib/supabase/{server,session,browser,proxy}.ts`, `lib/delivery.ts` = the blueprint's `lib/shipping.ts` mirror, `lib/settings(-shared).ts`, `lib/cache(-tags).ts`, `lib/env(.server).ts` — see FOUNDATION_NOTES.md). New feature modules use the blueprint's names: finder `lib/quiz.ts` (+ `lib/quiz-catalogue.ts`, `lib/attribute-lexicon.ts`, `lib/attribute-axes.ts`), assistant `lib/assistant/{types,model,prompt,knowledge,catalogue,tools,offers,customer,insights}.ts` and `components/assistant/{AssistantWidget,AssistantPanel,AssistantStage,StageProductExhibit,StageQuestion,StageOrderLookup,SuggestionChips,AssistantNudge,useAssistantChat,useAssistantNudges,prepareImage}`, `lib/orders.ts`, `lib/discount-copy.ts`, `lib/payments/*`, `lib/cart-recovery.ts`, `lib/site-lock.ts`.

| Area | Files (all under `src/`) | Owner |
| --- | --- | --- |
| Foundation | `app/layout.tsx`, `app/(store)/layout.tsx`, `proxy.ts`, `next.config.ts`, `lib/{env,env.server,cache,cache-tags,http,html,request-guard,rate-limit,rpc-errors,auth,settings,settings-shared,delivery,catalogue,catalogue-shared,cart,currency-shared,currency,viewer,offer-code,sri-lanka,format,store,toast}.ts`, `lib/supabase/*`, `lib/email/{send,layout}.ts`, `lib/admin/*`, `components/ui/*`, `components/product/*`, `components/providers/*`, admin shell (`app/admin/signin`, `app/admin/(protected)/{layout,page}.tsx`, `components/admin/{AdminApp,registry,ui/*}`), `app/api/admin/revalidate`, `app/api/rates`, `.env.example`, `package.json` | F |
| Catalogue + SEO | `app/(store)/{shop,collections,collection/[id],product/[id]}/**`, `app/{sitemap,robots,manifest}.ts`, `app/{not-found,error,global-error}.tsx`, `app/api/{availability,search}/**`, `components/catalogue/**`, `components/layout/SearchBar.tsx`, `components/seo/**`, `lib/{specs,catalogue-queries,viewed}.ts` | WP-A |
| Homepage + chrome + settings | `app/(store)/page.tsx`, `components/home/**` (except `NewsletterForm.tsx`), `components/layout/**` (except `SearchBar`, `ProfileMenu`, `HeaderCounters`), `data/site.ts`, `lib/content.ts`, admin tabs `homepage`, `settings` | WP-B |
| Commerce | `app/(store)/{cart,checkout,order/[id],track}/**`, `app/api/{checkout,discount,quote,track}/**`, `app/api/admin/order-status/**`, `components/cart/**`, `components/checkout/**`, `components/order/**`, `lib/{orders,discount-copy,checkout}.ts`, `lib/payments/{types,cod,bank-transfer,index}.ts`, `lib/email/templates/orders.ts`, admin tabs `orders`, `discounts` | WP-C |
| Accounts | `app/(store)/{signin,reset-password,customer/**,wishlist}/**`, `app/auth/**`, `app/api/wishlist/**`, `components/account/**`, `components/layout/{ProfileMenu,HeaderCounters}.tsx`, `lib/wishlist.ts` (phase 2), `supabase/email-templates/*`, admin tab `customers` | WP-D |
| Growth | `app/(store)/{contact,newsletter/unsubscribe,recover,recover/stop}/**`, `app/api/{newsletter,newsletter/unsubscribe,contact,abandoned-cart,cart-recovery,cart-recovery/unsubscribe}/**`, `app/api/admin/inquiry-reply/**`, `components/home/NewsletterForm.tsx`, `components/growth/**`, `lib/{cart-recovery,checkout-autosave}.ts`, `lib/email/templates/{recovery,inquiries,newsletter}.ts`, admin tabs `abandoned-carts`, `inquiries`, `subscribers` | WP-E |
| Finder | `app/(store)/discover/**`, `app/api/quiz/**`, `components/finder/**`, `lib/{quiz,quiz-catalogue,attribute-lexicon,attribute-axes}.ts`, `lib/finder/**` (foundation stubs — fold into the blueprint modules), `lib/email/templates/finder.ts`, admin tab `finder-insights` | WP-F |
| Content | `app/(store)/{blogs,blogs/[slug],privacy,terms,returns,pages/[slug]}/**`, `components/content/**`, `lib/{cms,sanitize,markdown}.ts`, admin tab `content` | WP-G |
| Analytics / ops | `app/launching-soon/**`, `app/api/{events,site-lock/unlock,admin/site-lock,maintenance}/**`, `components/analytics/**`, `lib/{analytics,site-lock,site-lock-gate}.ts`, admin tabs `dashboard`, `reports`, `site-lock` | WP-H |
| Assistant | `app/api/assistant/**`, `components/assistant/**`, `lib/assistant/**`, admin tab `assistant-insights` | WP-I |
| Reviews | `app/api/reviews/**`, `components/reviews/**`, `lib/reviews.ts`, admin tab `reviews` | WP-J |
| Admin catalogue | admin tabs `products`, `categories`, `collections`, `inventory`, `components/admin/catalogue/**`, `lib/admin/catalogue.ts`, migration `23_admin_catalogue.sql` | WP-K |

Admin tabs (sidebar groups): **Overview** dashboard · **Commerce** orders, discounts, abandoned-carts, reports ·
**Catalogue** products, categories, collections, inventory, reviews · **Customers** customers, inquiries, subscribers ·
**Growth** finder-insights, assistant-insights · **Content** homepage, content · **Settings** settings, site-lock.

**Only the owner edits a file.** You may *read* anything. Need a change in someone else's file? Don't make it — put it in
your report under "Requests for other owners" with the exact change. Do not edit `package.json`, `globals.css`,
`next.config.ts` or `proxy.ts` unless you are F. Do not run `npm install`, `next build` or `next dev` in phase 2.

---

## 8. Verification (every agent)

- TypeScript: `npx tsc --noEmit -p .` — fix every error in **your** files; ignore errors in files another agent owns
  (they are mid-edit).
- Lint: `npx eslint <your files>`.
- SQL: `PG_PORT=<your port> PG_WORK_DIR=<your scratch dir> scripts/db/verify.sh` — creates a throwaway Postgres 16 cluster
  over TCP 127.0.0.1 (no unix sockets), loads `supabase/tests/harness.sql`, applies every migration in order **twice**
  (idempotency), runs every `supabase/tests/*.test.sql`, prints a pass/fail summary, and stops the cluster. Ports:
  SQL chain 55431 · WP-A 55441 · WP-B 55442 · WP-C 55443 · WP-D 55444 · WP-E 55445 · WP-F 55446 · WP-G 55447 ·
  WP-H 55448 · WP-I 55449 · WP-J 55450 · WP-K 55451 · integration 55460.
- Privilege audit (in the tests): every function `anon` can execute is intended (blueprint §7.1 query).
- Report honestly: what passed, what failed, what was skipped (blueprint §0.3).

---

## 9. Work packages (phase 2)

Each WP builds its feature **end to end**: SQL (already drafted — review, fix, keep verified), route handlers, pages,
client islands, emails, admin tab, and the wiring into existing UI elements. Blueprint sections in brackets.

- **WP-A Catalogue & SEO** [§9.1]: `/shop` (filters: category, brand, price range, in-stock, sort; pagination),
  `/shop?category=…`, `/product/[id]` (gallery, variant selector with option values, live availability bands,
  add to basket, wishlist, specs table from `lib/specs.ts`, highlights, warranty, delivery note from settings,
  `<ProductReviews>`, related products, Product JSON-LD, `product_view` event), `/collections`, `/collection/[id]`,
  `/shop?filter=deals|new`, search as `/shop?q=` (+ `search` event with result count; zero results → link to /discover),
  SearchBar wired (`/shop?q=`), sitemap/robots/manifest, not-found/error/global-error in the brand style,
  Organization JSON-LD. Review seed 30.
- **WP-B Homepage CMS & chrome** [§6 of this spec]: convert every homepage/chrome component to DB data (same markup and
  look), admin **Homepage** tab (hero slides CRUD + reorder, promo tiles, featured collections order, flash sale title
  and end time, content blocks editors with image upload) and **Settings** tab (delivery rule, payments, pickup, bank
  instructions, contact, socials, ticker, payment labels, legal id). Seed 31 reproduces today's homepage exactly (with
  the §2.4 honesty fixes).
- **WP-C Commerce** [§9.2–9.8, §9.9 order emails, §11 orders/discounts]: cart page + drawer on the new cart store
  (repricing via `/api/quote`, availability notices, WhatsApp-order link from settings), real promo-code apply via
  `/api/discount`, `/checkout` (contact, delivery vs pickup, district select, payment choice from settings, bank
  instructions, honeypot, autosave via `useCheckoutAutosave`, parked offer code, `begin_checkout` event), `/api/checkout`
  → `place_order` with the full error map, `/order/[id]?t=` confirmation (sessionStorage copy), `/track` + `/api/track`,
  order emails (confirmation, owner alert, out for delivery with COD amount due, delivered), admin **Orders** (list with
  filters/pagination, detail drawer, status modals, payment status, tracking, timeline, invoice print) and **Discounts**
  tabs. Seed 32.
- **WP-D Accounts** [§9.13]: `/signin` (sign in, create account with confirm-email state + resend, forgot password) / `/reset-password` / `auth/callback`,
  ProfileMenu signed-in state (name, account links, admin link when `isAdmin`, sign out), `/customer/dashboard` with the
  blueprint's four tabs (order history with charged prices + "still sold", saved items, tracking with stepper + timeline,
  settings: profile, default address, password change), wishlist hybrid (guests local; signed-in DB; merge on sign-in), `/wishlist`, AuthListener
  (dispatches `dockone:signed-out`), branded Supabase auth email templates, admin **Customers**
  tab (dossier: orders by id OR email, lifetime value, address, admin note).
- **WP-E Growth** [§9.10–9.12]: newsletter (+ unsubscribe page), contact page + inquiry desk + reply route + owner alert,
  abandoned-cart autosave + hourly recovery job + `/recover` restore + `/recover/stop`, emails, admin **Abandoned carts**,
  **Inquiries**, **Subscribers** (CSV, counts by source).
- **WP-F Finder** [§9.14]: `/discover` with the §4.5 questions, electronics lexicon over `attributes.specs`, diversity
  rules, explanations, match %, `/api/quiz` capture + results email, the same `recommend()` for the assistant, admin
  **Finder insights**, `finder_complete` event.
- **WP-G Content** [§9.1 content, §6.6 sanitiser]: `/privacy`, `/terms`, `/returns`, `/pages/[slug]`, `/blogs`, `/blogs/[slug]` (Article JSON-LD),
  allowlist sanitiser, admin **Content** tab (pages + posts CRUD with a simple rich-text/markdown editor and image
  upload), seed 33 (privacy page lists everything collected per blueprint §12.2; only truthful system-derived pages are published; the footer shows only published pages).
- **WP-H Analytics & ops** [§12, §9.15, §12.5]: consent banner (essential vs analytics), tracker + `/api/events`,
  page-view tracker, admin **Dashboard** (revenue/orders/AOV/trend, funnel, top viewed vs sold, zero-result searches,
  low stock, recovery stats, newsletter growth — all real data), **Reports** (CSV + print-PDF), site lock (proxy gate,
  `/launching-soon`, unlock route, admin tab + route), `/api/maintenance` + retention.
- **WP-I Assistant** [§10, §11.4]: exactly the blueprint's implementation — Vercel AI SDK 7 (`generateText`, `tool({ inputSchema })`,
  `stopWhen: stepCountIs(n)`, image `FilePart`) with `@ai-sdk/openai`, model named once in `lib/assistant/model.ts`
  (`ASSISTANT_MODEL` default `gpt-5.4-mini`, `reasoningEffort: "low"`, no temperature), collector, step budget, JSON
  envelope, photo input, private order lookup, offers, returning-customer memory, nudges, insights tab.
  `OPENAI_API_KEY` unset → friendly "away" reply.
- **WP-J Reviews** (extension (c)): `submit_review` via `/api/reviews` (signed-in, one per product, verified-purchase flag
  from delivered orders, rate-limited), product-page reviews section (summary, distribution, list, form), admin
  **Reviews** moderation (approve/reject/feature). No seeded reviews — ratings appear only when real reviews exist.
- **WP-K Admin catalogue**: **Products** (list/search/filter, create/edit: details, category, brand, flags, SEO,
  attributes/specs editor by category, variants editor with prices/SKUs/option values, per-variant cost and stock,
  gallery upload with WebP conversion + reorder + cut-out upload, delete with confirmation — editing never resets
  stock), **Categories**, **Collections** (manual membership + rules), **Inventory** (low-stock first, inline edits).
