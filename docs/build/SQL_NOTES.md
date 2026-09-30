# SQL notes — the database contract for TypeScript

This file is what route handlers, server components, client islands and the admin panel code
against. It is kept **exact**: names, signatures, grants, return shapes and error codes are copied
from the migrations and checked by `scripts/db/verify.sh`. Each SQL author appends a section for
their migrations and keeps the earlier ones. If code and this file disagree, the migration wins —
fix this file in the same change.

## How to read this

- **Grant column**: **A** = anon + authenticated may EXECUTE (callable with the anon key from
  anywhere — design for hostile callers) · **U** = authenticated only · **—** = no grant (internal
  helper or trigger; PostgREST answers `42501 permission denied` / `PGRST202`) · **secret** = also
  requires a matching `app_config` secret passed as an argument.
- **RLS per verb**: what each role can do to a table through PostgREST. "admin" means
  `public.is_admin()` is true for the signed-in user (a `customers.is_admin` flag, nothing else).
  anon has **no** INSERT/UPDATE/DELETE on any table (every public write is an RPC).
- **Errors** — how a failure reaches supabase-js (`error.code` = SQLSTATE, `error.message`):
  | Kind | `error.code` | `error.message` | Route action |
  | --- | --- | --- | --- |
  | machine code from an RPC (`RAISE EXCEPTION 'snake_code:%'`) | `P0001` | `snake_code` or `snake_code:detail` | split on the first `:`; map in `lib/rpc-errors.ts` |
  | not authorised (admin RPCs, sealed objects, missing grant) | `42501` | human text | 403 (never show the text to shoppers) |
  | invalid parameter from a trigger/admin RPC | `22023` | `snake_code:human detail` | 422 in admin, show the detail |
  | CHECK violation | `23514` | contains the **constraint name** | map name → field (names listed below) |
  | unique violation | `23505` | contains the index/constraint name | "already exists" |
  | foreign-key violation | `23503` | contains the constraint name | "still in use" |
  | missing function (migration not applied) | `PGRST202` | "Could not find the function…" | 503 + log "apply migration NN" |
- **PostgREST reminders** (blueprint §3.2): `RETURNS TABLE` functions come back as an **array**;
  `numeric` arrives as a JSON number but wrap it in `Number()` anyway; selecting a column that does
  not exist fails the whole query; an UPDATE blocked by RLS is **0 rows, not an error** — admin
  writes must `.select()` and check the row count.
- **Session settings** used by definer functions (a PostgREST client cannot set them):
  `app.trusted_write = 'on'` lets a definer function change pinned `customers` columns
  (`email`, `is_admin`, `total_spent`, `orders_count`, `note`); `app.catalogue_rollup = 'on'` lets
  the catalogue rollups write derived `products` columns. Both are transaction-local.
- **Business time zone** for any aggregate: `Asia/Colombo`. **Currency**: LKR, `numeric(12,2)`,
  whole rupees in practice.

### Conventions for SQL authors (07+)

- Wrapper: `LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp` (add
  `extensions` when you call pgcrypto/pg_trgm), then `REVOKE ALL ON FUNCTION … FROM PUBLIC, anon,
  authenticated;` then the explicit `GRANT`.
- Every new table: `ENABLE ROW LEVEL SECURITY`, then
  `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.<t> FROM anon;` and
  `REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.<t> FROM authenticated;` (the audit enforces both;
  Supabase's default privileges grant ALL to both roles). Sealed tables: `REVOKE ALL … FROM anon`
  (and `authenticated` if even admins go through functions).
- Every UPDATE/ALL policy needs an explicit `WITH CHECK`; write admin policies as
  `USING ((SELECT public.is_admin())) WITH CHECK ((SELECT public.is_admin()))`.
- **Extend `supabase/tests/99_privileges.test.sql`**: one row in `allow_anon` (grant A) or
  `allow_authenticated` (grant U) per granted function, and sealed tables in `sealed_tables`.
- Tests: `supabase/tests/NN_name.test.sql`, first line `\ir _helpers.sql`; helpers
  `pg_temp.ok/eq/throws/affected/new_user/make_admin/login/login_anon/logout` (plus the blueprint
  B.2 aliases `as_anon()` / `as_user(uid, mail)` for use with `SET ROLE`) are documented at the
  top of `_helpers.sql`. Each test file runs in its **own copy** of the fully migrated database
  (seed 30 included), so tests never see each other's fixtures but must tolerate seed rows.
- Harness (`supabase/tests/harness.sql`) additionally provides `auth.role()`, `auth.jwt()`
  (reading `request.jwt.claim.*` then `request.jwt.claims`), and a minimal `storage` schema
  (`buckets`, `objects`, RLS on) so bucket/policy code runs instead of being skipped.
- Verify: `PG_PORT=<port> PG_WORK_DIR=<scratch> scripts/db/verify.sh [--keep]`.
  Bundle for the SQL editor: `scripts/db/bundle.sh 1 6` → `supabase/bundles/01-06.sql`.

---

## 01_foundation.sql — secrets, rate limiting

### Tables (both sealed: RLS on, no policy, no grants to anon/authenticated)

#### `app_config`

| column | type | null | default |
| --- | --- | --- | --- |
| `name` | text | NOT NULL (PK) |  |
| `value` | text | NOT NULL |  |
| `updated_at` | timestamptz | NOT NULL | `now()` |

Rows: `rate_limit` (= `RATE_LIMIT_SECRET`), later `cart_recovery`, `maintenance`, and one-time
markers such as `seed_30_catalogue_demo`.

#### `rate_limit_hits`

| column | type | null | default |
| --- | --- | --- | --- |
| `id` | bigint | NOT NULL (PK) | `nextval('rate_limit_hits_id_seq')` |
| `bucket` | text | NOT NULL |  |
| `hit_at` | timestamptz | NOT NULL | `now()` |

### Functions

| Signature | Grant | Returns | Contract |
| --- | --- | --- | --- |
| `touch_updated_at()` | — | trigger | `NEW.updated_at := now()` |
| `verify_job_secret(p_name text, p_secret text)` | — | boolean | FALSE if either value is NULL or < 20 chars; compares sha256 digests; never returns the stored value |
| `_rate_limit_hit(p_bucket text, p_max int, p_window_seconds int)` | — | boolean | sliding window per bucket (advisory lock, lazy GC); TRUE = allowed and recorded, FALSE = over the limit (not recorded); nonsense args (blank bucket, max < 1, window < 1) → TRUE; bucket truncated to 200 chars. For definer RPCs that throttle themselves |
| `check_rate_limit(p_secret text, p_bucket text, p_max int, p_window_seconds int)` | **A** + secret | boolean | route wrapper; raises `unauthorized` (P0001) when `p_secret` ≠ `app_config.rate_limit`; otherwise as `_rate_limit_hit` |

Route handler: `lib/rate-limit.ts` calls
`rpc('check_rate_limit', { p_secret: RATE_LIMIT_SECRET, p_bucket, p_max, p_window_seconds })`;
`data === false` → 429; **any error → fail open** (log once). Buckets `feature:dimension:value`
with the value HMAC'd (`hashKey`). Each call is one statement, so consecutive calls see each
other's hits.

### Direct-call brake (P3 hardening beyond the reference store)

The route limits only bind callers who come through the routes; the public write/advisory RPCs
are granted to anon, so anyone with the anon key could call them straight against PostgREST.
The app's **server-side** clients (`src/lib/supabase/route-token.ts`, used by
`lib/supabase/server.ts` and `lib/supabase/session.ts`) therefore send the header
`x-dockone-route: hex(HMAC-SHA256(key = RATE_LIMIT_SECRET, 'dockone-route-v1'))`, which PostgREST
exposes in `request.headers`.

| Signature | Grant | Returns | Contract |
| --- | --- | --- | --- |
| `_trusted_route_call()` | — | boolean | TRUE when `x-dockone-route` equals the HMAC of `app_config.rate_limit`, **or when no `rate_limit` secret is configured** (fail open, like `check_rate_limit`); malformed `request.headers` → FALSE, never an error |
| `_route_or_budget(p_kind text, p_max int, p_window_seconds int)` | — | boolean | `_trusted_route_call()` OR `_rate_limit_hit('direct:' ‖ p_kind, …)`: route calls never spend anything; direct calls share one store-wide budget per kind |

Callers (first statement of each function): `place_order` 20/h, `quote_order` 600/h,
`validate_discount` 120/h, `capture_abandoned_cart` 30/h, `record_finder_response` 30/h,
`submit_contact_inquiry` 10/h → over budget they raise `rate_limited` (P0001);
`subscribe_newsletter` 30/h → returns FALSE; `track_event` and `log_assistant_turn` accept
**route calls only** (a direct call returns without writing, so assistant sessions can't be forged
to "earn" exclusive offers). A deploy whose `RATE_LIMIT_SECRET` doesn't match the database still
works, but every call then counts against these small budgets — the startup log already flags an
unset secret; keep the two values equal.

---

## 02_customers_and_auth.sql — customers, admin flag, signup provisioning

#### `customers`

| column | type | null | default |
| --- | --- | --- | --- |
| `id` | uuid | NOT NULL (PK → `auth.users.id` ON DELETE CASCADE) |  |
| `email` | text | NOT NULL (unique on `lower(email)`: `customers_email_lower_key`) |  |
| `first_name` | text | yes |  |
| `last_name` | text | yes |  |
| `phone` | text | yes |  |
| `street` | text | yes |  |
| `city` | text | yes |  |
| `district` | text | yes (CHECK `customers_district_valid`) |  |
| `postal_code` | text | yes |  |
| `country` | text | NOT NULL | `'Sri Lanka'` |
| `note` | text | yes (admin-written; pinned against the shopper — but RLS is row-level, so the shopper can READ it on their own row: never show it on the storefront, write it factually) |  |
| `total_spent` | numeric(12,2) | NOT NULL | `0` |
| `orders_count` | integer | NOT NULL | `0` |
| `is_admin` | boolean | NOT NULL | `false` |
| `created_at` | timestamptz | NOT NULL | `now()` |
| `updated_at` | timestamptz | NOT NULL | `now()` (touch trigger) |

Address keys equal the checkout `shipping` JSON keys: `street, city, district, postal_code, country`.

**`district` must be exactly one of** (CHECK, case-sensitive — `src/lib/sri-lanka.ts` `DISTRICTS`
must use the same 25 strings): `Ampara, Anuradhapura, Badulla, Batticaloa, Colombo, Galle, Gampaha,
Hambantota, Jaffna, Kalutara, Kandy, Kegalle, Kilinochchi, Kurunegala, Mannar, Matale, Matara,
Monaragala, Mullaitivu, Nuwara Eliya, Polonnaruwa, Puttalam, Ratnapura, Trincomalee, Vavuniya`.

Other constraints: `customers_field_lengths` (email ≤ 255, first/last name ≤ 255, phone ≤ 50,
street ≤ 500, city ≤ 120, postal_code ≤ 20, country 1–80, note ≤ 5000),
`customers_rollups_non_negative`.

**RLS per verb**

| verb | anon | authenticated (shopper) | admin |
| --- | --- | --- | --- |
| SELECT | ✗ no privilege (42501) | own row only (`id = auth.uid()`) | all rows |
| INSERT | ✗ | ✗ (RLS 42501) — rows are created by the signup trigger | allowed by policy, but `id` must be an existing auth user |
| UPDATE | ✗ | own row; **pinned columns are silently restored**: `id, email, is_admin, total_spent, orders_count, note, created_at` | all rows, all columns |
| DELETE | ✗ | 0 rows | all rows (prefer deleting the auth user: it cascades) |

**Functions / triggers**

| Signature | Grant | Contract |
| --- | --- | --- |
| `is_admin()` → boolean | **U** | `COALESCE((SELECT is_admin FROM customers WHERE id = auth.uid()), false)`. No argument (cannot probe other ids). anon gets 42501 |
| `link_guest_orders(p_uid uuid, p_email text)` → void | — | if `public.orders` exists: sets `customer_id = p_uid` on orders with `customer_id IS NULL AND lower(email) = lower(p_email)`, then recomputes `customers.total_spent / orders_count` from that customer's non-`cancelled` orders. No-op before 07 exists (`to_regclass` guard) |
| `handle_new_user()` | trigger on `auth.users` AFTER INSERT (`on_auth_user_created`) | skips email-less (anonymous) users; idempotent on id; lower-cases + trims the email; `first_name/last_name/phone` from `raw_user_meta_data` (trimmed, ≤ 255/255/50); `is_admin` always FALSE (metadata is never trusted); raises **`customer_email_conflict:<email>`** if another customers row owns the email; links guest orders only if the user is already confirmed (auto-confirm projects) |
| `handle_user_confirmed()` | trigger AFTER UPDATE OF `email_confirmed_at` (`on_auth_user_confirmed`) | on NULL → NOT NULL: `link_guest_orders(id, email)` — guest orders link to **proven** addresses only |
| `handle_user_email_changed()` | trigger AFTER UPDATE OF `email` (`on_auth_user_email_changed`) | follows a (confirmed) auth email change into `customers.email` (lower-cased); provisions the row for an anonymous account that gains an email; raises `customer_email_conflict:<email>` if another customer owns it; links guest orders of the new address when confirmed |
| `pin_customer_identity_columns()` | trigger BEFORE UPDATE on customers | restores pinned columns unless `auth.uid()` is NULL (SQL editor/jobs), `app.trusted_write = 'on'`, or the caller is admin |

Route/page notes (WP-D, F):
- Admin gate: `customers.select('is_admin').eq('id', user.id).maybeSingle()` with the **session**
  client (blueprint §6.2), or `rpc('is_admin')`.
- Profile save (browser client): `from('customers').update({ first_name, last_name, phone, street,
  city, district, postal_code }).eq('id', user.id).select()` → check 1 row. A bad district is
  `23514 customers_district_valid`; an over-long field is `23514 customers_field_lengths`.
  **As built (WP-D, `components/account/dashboard/AccountSettings.tsx`):** reads and returns
  `email, first_name, last_name, phone, street, city, district, postal_code, country` (never `note`,
  rollups or `is_admin`), filters `.eq('id', user.id)` (an admin's RLS would otherwise match every
  row), stores the phone normalised by the `place_order` phone rule (`normalizeOrderPhone`,
  `src/lib/checkout.ts`) and requires street + city +
  district once any address field is filled (the checkout rule). An admin saving their own profile
  passes through `customers_admin_all` (tested).
- Checkout prefill reads the same columns (own row).
- Sign-up (WP-D, `/signin`): `auth.signUp({ email, password, options: { data: { first_name,
  last_name? }, emailRedirectTo: SITE_URL/auth/callback?next=… } })` → `handle_new_user()` copies the
  names. Phone is not collected at sign-up.
- `customer_email_conflict` surfaces from GoTrue as a generic "Database error saving new user" —
  show "We couldn't create your account. Please contact us." (should be unreachable).
- Admin Customers tab (WP-D): list = `select('*', { count: 'exact' })` + `.or(ilike on email,
  first_name, last_name, phone, city)` + `.range()`; dossier orders = `orders.or('customer_id.eq.<id>,
  email.eq."<lower email>"')` (the same filter the dashboard uses); note =
  `.update({ note }).eq('id', id).select()` → exactly 1 row. `is_admin` is shown read-only.
- The owner is promoted once in the SQL editor (see the migration's OPS NOTE).

**Contract with 07_orders (SQL-2):** `link_guest_orders` needs `orders(customer_id uuid, email
text, total_price numeric, status text)` with `'cancelled'` in the status vocabulary; `place_order`
must `set_config('app.trusted_write', 'on', true)` before updating `customers` rollups.

---

## 03_store_settings.sql — the singleton settings row

#### `store_settings` (exactly one row, `id = true`)

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | boolean | NOT NULL (PK, CHECK `id`) | `true` | singleton |
| `store_name` | text | NOT NULL | `'Dock One Solutions'` | 1–120 chars |
| `delivery_fee` | numeric(10,2) | NOT NULL | `450` | 0–100000 |
| `free_delivery_threshold` | numeric(12,2) | yes | `15000` | **NULL = delivery is never free** |
| `cod_enabled` | boolean | NOT NULL | `true` | |
| `cod_max_total` | numeric(12,2) | yes | | NULL = no cap; > 0 when set |
| `bank_transfer_enabled` | boolean | NOT NULL | `true` | |
| `bank_account_name` | text | yes | 03 fills `'Dock One Solutions Pvt Ltd'` | one line, 1–120 (`store_settings_bank_account_valid`) |
| `bank_name` | text | yes | 03 fills `'Bank of Ceylon'` | one line, 1–120 |
| `bank_branch` | text | yes | 03 fills `'Vishaka'` | optional; one line, 1–120 |
| `bank_account_number` | text | yes | 03 fills `'79503030'` | 4–40 chars: digits, single spaces/hyphens between groups |
| `bank_transfer_instructions` | text | yes | | ≤ 2000; optional extra note shown under the account |
| `pickup_enabled` | boolean | NOT NULL | `true` | |
| `pickup_address` | text | yes | | ≤ 500 |
| `pickup_note` | text | yes | | ≤ 500 |
| `phone` | text | yes | | ≤ 40 |
| `whatsapp` | text | yes | | ≤ 40 |
| `email` | text | yes | | ≤ 254, must look like an email |
| `address` | text | yes | | ≤ 500 |
| `map_url` | text | yes | | ≤ 500, `https://…` only, no spaces/backslashes |
| `opening_hours` | text | yes | | ≤ 500 |
| `business_reg_no` | text | yes | | ≤ 80; render only when set |
| `socials` | jsonb | NOT NULL | `'{}'` | object; keys ⊆ `facebook, instagram, tiktok, youtube`; values `https://…` strings without spaces/backslashes |
| `announcement` | text | yes | | ≤ 200; top-bar override |
| `ticker_items` | text[] | NOT NULL | `'{}'` | ≤ 20 items × ≤ 200 chars, no NULLs |
| `accepted_payment_labels` | text[] | NOT NULL | `'{}'` | ≤ 12 items × ≤ 60 chars, no NULLs; footer "We accept" |
| `flash_sale_title` | text | yes | | ≤ 120 |
| `flash_sale_ends_at` | timestamptz | yes | | hide the section when NULL or past |
| `returns_window_days` | integer | NOT NULL | `7` | 0–365 |
| `warranty_note` | text | yes | | ≤ 1000 |
| `updated_at` | timestamptz | NOT NULL | `now()` | set by trigger on every update |
| `updated_by` | uuid | yes (FK → customers ON DELETE SET NULL) | | set by trigger to `auth.uid()` |

Text limits equal the display caps in `src/lib/settings-shared.ts` (`normalizeStoreSettings`), so
nothing an admin saves is ever cut on screen — keep them equal if either side changes.
Named CHECKs (for admin form mapping): `store_settings_money_valid` (fee/threshold/cod cap),
`store_settings_returns_window_valid`, `store_settings_socials_valid`, `store_settings_urls_valid`
(map_url), `store_settings_email_valid`, `store_settings_lists_valid` (ticker/labels),
`store_settings_text_lengths`, `store_settings_id_check` (singleton).

**RLS / privileges**

| verb | anon | authenticated (shopper) | admin |
| --- | --- | --- | --- |
| SELECT | ✓ the row | ✓ the row | ✓ |
| UPDATE | ✗ no privilege (42501) | 0 rows (RLS) | ✓ (`USING`/`WITH CHECK is_admin()`) |
| INSERT / DELETE / TRUNCATE | ✗ no privilege | ✗ no privilege | ✗ no privilege (the row is permanent) |

Trigger `store_settings_touch` (BEFORE UPDATE): `updated_at = now()`, `updated_by = auth.uid()`.

Reading (F: `lib/settings.ts`): `from('store_settings').select('<columns>').eq('id', true).single()`
with the stateless anon client, cached under tag `settings`. Admin save (WP-B):
`.update({...}).eq('id', true).select()` → check exactly 1 row, then revalidate `settings`.
**As built (WP-B):** the Store settings tab (`src/components/admin/tabs/SettingsTab.tsx`,
`src/components/admin/settings/settings-form.ts`) sends ONE `updateRows('store_settings', patch,
{ id: true, updated_at: <the loaded row's updated_at> }, { expect: 1, revalidate: ['settings'] })` with only
the columns it owns (never `flash_sale_*`, `id`, `updated_*`); a newer save made elsewhere makes the
match miss → 0 rows → "changed elsewhere — reload" instead of a silent overwrite. The flash-sale pair is
saved from Homepage → Flash sale (`updateRows('store_settings', { flash_sale_title, flash_sale_ends_at },
{ id: true })`). The storefront reads the row through `getStoreSettings()` only.

**Delivery rule** (09's `place_order`/`quote_order` are the authority; `deliveryFeeFor()` mirrors
them): fee = `0` for pickup; otherwise `0` when `free_delivery_threshold IS NOT NULL AND
subtotal >= free_delivery_threshold` (subtotal **before** discount), else `delivery_fee`. SQL-2
owns the final wording of that rule in 09 — keep this line in sync with it.

Honesty notes: defaults are "on" for bank transfer and pickup, but `pickup_address` starts NULL
and bank transfer needs its account — the storefront should only offer bank transfer while the
account name, bank and number are set, and pickup when an address is set (or 09 should refuse;
SQL-2 decides and documents it). **Resolved:** 09 refuses both and `quote_order` reports
`*_available`; the homepage hides every content item that `requires` an unavailable method
(SQL_NOTES §16), and the Settings tab warns while a switched-on method can't be offered.

**Bank account (2026-09-28):** 03 fills the store's REAL account (given by the owner) — only while
all four bank columns are NULL, so a re-run never overwrites an admin edit or touches `updated_at`.
The bank columns are also added with `ADD COLUMN IF NOT EXISTS`, so re-running 03 upgrades a
database created by an earlier 03. Mirror of the offer rule: `bankTransferReady()` in
`src/lib/settings-shared.ts`.

---

## 04_catalogue.sql — categories, products, variants, costs, collections

Model and rules in prose: `docs/domain-model.md`. Exact contract below.

#### `categories`

| column | type | null | default |
| --- | --- | --- | --- |
| `id` | text | NOT NULL (PK, slug `^[a-z0-9][a-z0-9-]*$`, ≤ 64) |  |
| `name` | text | NOT NULL (1–80) |  |
| `tagline` | text | yes (≤ 160) |  |
| `description` | text | yes (≤ 4000) |  |
| `stage_image_url` | text | yes (`/path` or `https://`) |  |
| `hero_product_id` | integer | yes (FK `categories_hero_product_id_fkey` → products ON DELETE SET NULL) |  |
| `scene` | text | NOT NULL (`night\|paper\|lime\|violet`) | `'paper'` |
| `sort_order` | integer | NOT NULL | `100` |
| `is_active` | boolean | NOT NULL | `true` |
| `seo_title` | text | yes (≤ 120) |  |
| `seo_description` | text | yes (≤ 320) |  |
| `created_at` / `updated_at` | timestamptz | NOT NULL | `now()` |

#### `products`

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | integer | NOT NULL (PK) | serial | never supply it |
| `slug` | text | NOT NULL, unique `products_slug_key` | | `^[a-z0-9][a-z0-9-]*$`, ≤ 120 (product pages are keyed by id: `/product/<id>`) |
| `brand` | text | NOT NULL | | 1–80 non-blank |
| `name` | text | NOT NULL | | 1–200 non-blank |
| `subtitle` | text | yes | | ≤ 200; the card spec line |
| `description` | text | yes | | ≤ 10000 |
| `category_id` | text | yes (FK `products_category_id_fkey` ON UPDATE CASCADE, delete RESTRICT) | | |
| `price` | numeric(12,2) | NOT NULL | `0` | **derived** from-price |
| `compare_at_price` | numeric(12,2) | yes | | **derived**; only set when > price |
| `default_variant_id` | integer | yes | | **derived**; cheapest active variant (no FK — see embedding note) |
| `variant_count` | integer | NOT NULL | `0` | **derived**; active variants |
| `image_url` | text | yes | | = `image_urls[1]` (trigger), NULL when no image |
| `image_urls` | text[] | NOT NULL | `'{}'` | ≤ 12; `/path` or `https://` |
| `cutout_url` | text | yes | | transparent cut-out |
| `tags` | text[] | NOT NULL | `'{}'` | normalised lower-case, ≤ 30 × 40 chars |
| `attributes` | jsonb | NOT NULL (object) | `'{}'` | `{specs, highlights, use_cases, in_the_box}` |
| `warranty_months` | integer | yes | | 0–240 |
| `is_active` | boolean | NOT NULL | `true` | |
| `is_new` / `is_bestseller` / `is_featured` / `is_flash_deal` | boolean | NOT NULL | `false` | |
| `sort_order` | integer | NOT NULL | `100` | ascending everywhere |
| `rating_avg` | numeric(3,2) | NOT NULL | `0` | **derived** (11_reviews), 0–5 |
| `rating_count` | integer | NOT NULL | `0` | **derived** (11_reviews) |
| `seo_title` / `seo_description` | text | yes | | ≤ 120 / ≤ 320 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | `now()` | `updated_at` also bumps when variants change |
| `search_vector` | tsvector | yes | | added by 06 — **never select it** (no `select('*')`) |

Derived columns: writes from anywhere except the rollup functions are silently restored; a new
product always starts at `price 0, compare_at NULL, default_variant_id NULL, variant_count 0,
rating 0/0`.

#### `product_variants`

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | integer | NOT NULL (PK) | serial | the **cart line key** (`variantId`) |
| `product_id` | integer | NOT NULL (FK → products ON DELETE CASCADE) | | |
| `sku` | text | yes, unique `product_variants_sku_key` | | 1–64, no whitespace |
| `name` | text | NOT NULL | | 1–120; unique per product case-insensitively (`product_variants_product_name_key`); `Standard` for single-variant products |
| `option_values` | jsonb | NOT NULL | `'{}'` | object of **string** values, e.g. `{"Memory":"16GB","Storage":"1TB"}` |
| `price` | numeric(12,2) | NOT NULL | | 0–100,000,000 |
| `compare_at_price` | numeric(12,2) | yes | | shown only when > price |
| `position` | integer | NOT NULL | `0` | selector order; tie-break for the default |
| `is_active` | boolean | NOT NULL | `true` | |
| `weight_g` | integer | yes | | 0–1,000,000 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | `now()` | |

Also `UNIQUE (id, product_id)` (`product_variants_id_product_key`, target of inventory's FK).

#### `product_costs` (admin only; sealed from anon)

| column | type | null | default |
| --- | --- | --- | --- |
| `variant_id` | integer | NOT NULL (PK, FK → product_variants ON DELETE CASCADE) |  |
| `cost_price` | numeric(12,2) | NOT NULL (≥ 0) | `0` |
| `updated_at` | timestamptz | NOT NULL | `now()` |

#### `collections`

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | text | NOT NULL (PK) | | slug ≤ 80 → `/collection/<id>` |
| `title` | text | NOT NULL | | 1–120 |
| `subtitle` | text | yes | | ≤ 200; homepage tile line |
| `description` | text | yes | | ≤ 4000 |
| `cover_image` | text | yes | | `/path` or `https://` |
| `type` | text | NOT NULL | `'manual'` | `manual` \| `automated` |
| `rules` | jsonb | NOT NULL (array) | `'[]'` | see rule table |
| `match` | text | NOT NULL | `'any'` | `any` \| `all` |
| `kind` | text | NOT NULL | `'curated'` | `brand` \| `line` \| `curated` |
| `parent_id` | text | yes (FK → collections ON DELETE SET NULL) | | ≠ id |
| `brand` | text | yes | | |
| `theme` / `page_content` | jsonb | NOT NULL (objects) | `'{}'` | free-form presentation data |
| `is_active` | boolean | NOT NULL | `true` | |
| `is_featured` | boolean | NOT NULL | `false` | homepage row |
| `feature_product_ids` | integer[] | NOT NULL | `'{}'` | ≤ 2, no NULLs, de-duplicated: `[back, front]` cut-outs |
| `sort_order` | integer | NOT NULL | `100` | |
| `seo_title` / `seo_description` | text | yes | | ≤ 120 / ≤ 320 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | `now()` | |

Rules: `[{ "field", "relation", "value" }]`, ≤ 20. Allowed pairs: `tag|brand|category` ×
`equals|not_equals` (case-insensitive), `price` × `lt|lte|gt|gte` (value a number or numeric
string; compares the from-price), `is_new|is_flash_deal` × `equals` (value `true|false`, JSON
boolean or string). Anything else → `22023 invalid_collection_rules:<why>`.

#### `product_collections`

| column | type | null | default |
| --- | --- | --- | --- |
| `product_id` | integer | NOT NULL (FK → products ON DELETE CASCADE) |  |
| `collection_id` | text | NOT NULL (FK → collections ON DELETE/UPDATE CASCADE) |  |
| `position` | integer | NOT NULL | `0` |
| `source` | text | NOT NULL (`manual` \| `rule`) | `'manual'` |

PK `(product_id, collection_id)`. Rule rows (`source = 'rule'`) are rewritten by triggers — the
admin UI writes only `manual` rows (through 23's `admin_set_collection_products`) and never
deletes `rule` rows (they come back). Rule rows are written with `position = 100000`, so in the
storefront's `(position, product_id)` order hand-picked members (positions 0, 1, 2 …) come first,
then rule members by product id.

**RLS per verb (all six tables)**

| table | anon / shopper SELECT | anon writes | shopper writes | admin |
| --- | --- | --- | --- | --- |
| `categories` | `is_active` | ✗ no privilege | ✗ RLS (insert 42501, update/delete 0 rows) | ALL |
| `products` | `is_active AND variant_count > 0` | ✗ | ✗ | ALL (sees inactive) |
| `product_variants` | `is_active` AND parent product `is_active` | ✗ | ✗ | ALL |
| `product_costs` | anon: ✗ no privilege (42501); shopper: 0 rows | ✗ | ✗ | ALL |
| `collections` | `is_active` | ✗ | ✗ | ALL |
| `product_collections` | collection `is_active` AND product visible | ✗ | ✗ | ALL |

TRUNCATE is revoked from anon and authenticated everywhere.

**Functions / triggers**

| Signature | Grant | Contract |
| --- | --- | --- |
| `products_normalize()` | trigger `products_10_normalize` BEFORE INSERT/UPDATE | tags normalised; gallery trimmed/de-duplicated; `image_url ↔ image_urls[1]` sync (on UPDATE: a changed gallery wins; a changed `image_url` alone moves to the front, NULL drops the first image); raises `22023 invalid_image_url:<url>` (bad scheme, `//host`, > 12 images, > 1000 chars) and `22023 invalid_tags:<why>` (> 30, > 40 chars) |
| `products_pin_derived()` | trigger `products_20_derived` BEFORE INSERT/UPDATE | derived columns reset (INSERT) / restored (UPDATE) unless `app.catalogue_rollup = 'on'` |
| `refresh_product_from_price(p_product_id int)` → void | — | recomputes `price, compare_at_price, default_variant_id, variant_count` from active variants (cheapest; ties by `position`, `id`); keeps the last price when none is active; writes only when something changed |
| `product_variants_rollup()` | triggers `product_variants_rollup_ins_del` (AFTER INSERT/DELETE), `product_variants_rollup_upd` (AFTER UPDATE OF price, compare_at_price, is_active, position, product_id) | calls `refresh_product_from_price` for the new and (when moved) old product |
| `_apply_product_rating(p_product_id int, p_rating_avg numeric, p_rating_count int)` → void | — | **the only writer of ratings** (for 11_reviews): count clamped ≥ 0, avg clamped 0–5 and rounded to 2 dp, avg 0 when count 0 |
| `product_matches_rules(p products, p_rules jsonb, p_match text)` → boolean | — | rule evaluation (defensive: malformed rules never match) |
| `collections_validate()` | trigger `collections_10_validate` BEFORE INSERT/UPDATE | validates rules (`22023 invalid_collection_rules:<why>`), de-duplicates `feature_product_ids` |
| `sync_product_rule_collections()` | triggers `products_rule_collections_ins` (AFTER INSERT), `products_rule_collections_upd` (AFTER UPDATE OF tags, brand, category_id, price, is_new, is_flash_deal — when changed) | rewrites that product's `rule` rows |
| `_refresh_collection_rule_members(p_collection_id text)` → void | — | THE rule-row writer for one collection (P6): deletes its `rule` rows and re-inserts every product matching its current type/rules/match (none when `manual`), `position 100000`, a manual row for the pair wins. Called by the trigger below and by 23's `admin_set_collection_products` |
| `sync_collection_rule_members()` | triggers `collections_rule_members_ins` (AFTER INSERT), `collections_rule_members_upd` (AFTER UPDATE OF type, rules, match — when changed) | `_refresh_collection_rule_members(NEW.id)` |

Constraint names (for admin error mapping): `categories_id_format`, `categories_scene_valid`,
`categories_text_lengths`, `products_slug_key` (23505), `products_slug_format`,
`products_price_valid`, `products_counts_valid`, `products_warranty_valid`,
`products_attributes_object`, `products_text_lengths`, `products_category_id_fkey` (23503 when
deleting a category that still has products), `product_variants_sku_key` (23505),
`product_variants_product_name_key` (23505, duplicate variant name), `product_variants_price_valid`,
`product_variants_sku_format`, `product_variants_name_valid`, `product_variants_options_valid`,
`product_variants_weight_valid`, `product_costs_cost_valid`, `collections_pkey` (23505),
`collections_id_format`, `collections_type_valid`, `collections_match_valid`,
`collections_kind_valid`, `collections_rules_array`, `collections_json_objects`,
`collections_feature_valid`, `collections_not_own_parent`, `collections_text_lengths`,
`product_collections_source_valid`.

**PostgREST embedding — read this before writing a select string:**
- `categories` ↔ `products` are related **two ways** (`products.category_id` and
  `categories.hero_product_id`), so an un-hinted embed fails with `PGRST201`. Always hint:
  `products.select('…, category:categories!products_category_id_fkey(id,name)')`,
  `categories.select('…, products!products_category_id_fkey(count)')` (counts: prefer
  `catalogue_facets()`), `categories.select('…, hero:products!categories_hero_product_id_fkey(id,slug,name,cutout_url)')`.
- `products.select('…, product_variants(id,name,sku,option_values,price,compare_at_price,position)')`
  is unambiguous (anon gets active variants only). `default_variant_id` has no FK on purpose; pick
  the variant from the embed.
- `product_collections` is a junction: `collections.select('…, products(…)')` works (many-to-many);
  order members by `product_collections.position` via
  `product_collections.select('position, product:products(…)').eq('collection_id', id).order('position')`.

**Admin write paths (WP-K)**: a product save — product, variants, costs and stock — is ONE call to
23's `admin_save_product` (never separate inserts that could half-apply); the admin then re-reads
the product (price/variant_count are derived). Activate/deactivate and delete are direct admin-RLS
writes on `products`. Deleting a product cascades variants, stock, costs, memberships, reviews and
wishlist rows (and 23's trigger drops it from `collections.feature_product_ids`); order lines keep
their snapshots. Image uploads: bucket `product-images`, prefix `products/<id>/` (the kit names each
file uniquely — ADMIN_KIT §5 storage), then the public URLs go into `image_urls`.

**Storage** (skipped where the `storage` schema is absent): buckets `product-images` and
`content-images` — public, `file_size_limit = 5242880`, `allowed_mime_types =
{image/webp,image/jpeg,image/png,image/avif}` (set on first creation; `public` is forced true on
re-run). Policy `"dockone admin write catalogue images"` on `storage.objects`: FOR ALL TO
authenticated, `bucket_id IN (those two) AND is_admin()`. No anon policy (public files are served
by URL; listing is closed).

---

## 05_inventory.sql — stock per variant

#### `inventory` (admin only; sealed from anon)

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `variant_id` | integer | NOT NULL (PK) | | FK `(variant_id, product_id)` → product_variants ON DELETE/UPDATE CASCADE |
| `product_id` | integer | NOT NULL | | **set by trigger** from the variant (writers may omit or send anything); FK → products ON DELETE CASCADE |
| `stock_level` | integer | NOT NULL | `0` | 0–1,000,000 (`inventory_levels_valid`) |
| `low_stock_threshold` | integer | NOT NULL | `3` | 0–100,000 |
| `updated_at` | timestamptz | NOT NULL | `now()` | set by trigger on every write |

**No row = the variant is not tracked = it always sells.** RLS: anon no privilege (42501);
shopper 0 rows / RLS errors; admin ALL. TRUNCATE revoked.

| Signature | Grant | Returns | Contract |
| --- | --- | --- | --- |
| `inventory_set_product()` | trigger `inventory_10_set_product` BEFORE INSERT/UPDATE | — | `product_id := variant's product_id`, `updated_at := now()` |
| `get_product_availability(p_product_ids int[])` | **A** | TABLE `(product_id int, variant_id int, stock_level int, low_stock boolean)` | rows only for **tracked, active** variants of **visible** products (`is_active AND variant_count > 0`), for the **24 smallest distinct** non-NULL ids requested (extra ids are ignored silently), ordered by product id, variant position. `low_stock = stock_level > 0 AND stock_level <= threshold`. The threshold is never returned. NULL/empty input → no rows |
| `list_in_stock_product_ids()` | **A** | TABLE `(product_id int)` | visible products having ≥ 1 active variant that is untracked or has `stock_level > 0`, ordered by id |

Neither function raises for any input (unknown/NULL ids simply return fewer rows); the only
errors a caller can see are transport errors and `PGRST202` (migration 05 not applied).

Storefront interpretation (WP-A/WP-C): a variant missing from `get_product_availability` is
available (untracked); `stock_level = 0` → sold out; `low_stock` → "Only N left"; otherwise in
stock. Chunk requests to ≤ 24 product ids. On error show "availability confirmed at checkout"
(never block).

**Contract with 09 (SQL-2):** lock stock with `SELECT stock_level FROM inventory WHERE variant_id
= $1 FOR UPDATE` for each line **sorted by variant id**; no row → untracked; decrement with
`UPDATE inventory SET stock_level = stock_level - qty WHERE variant_id = $1` (the CHECK refuses
negatives; raise `out_of_stock:<name>` first). Only sell variants with `product_variants.is_active`
whose product `is_active` (the from-price columns are display-only; price from
`product_variants.price`). Cancellation restocks the same rows.

---

## 06_catalogue_search.sql — search and facets

Adds `products.search_vector tsvector` + GIN index `products_search_vector_gin`, maintained by
triggers (weights A name+brand · B subtitle · C category id+name, tags, active variant
names/SKUs/option values · D description, attributes strings). `pg_trgm` is installed into
`extensions` when possible (fuzzy fallback); without it search still works.

| Signature | Grant | Returns | Contract |
| --- | --- | --- | --- |
| `search_products(p_query text, p_limit int DEFAULT 24, p_offset int DEFAULT 0)` | **A** | TABLE `(product_id int, rank real, total_count int)` | see below |
| `catalogue_facets(p_category text DEFAULT NULL)` | **A** | jsonb | see below |
| `product_search_document(p products)` → tsvector | — | | the weighted document |
| `products_search_vector_refresh()` | trigger `products_30_search` BEFORE INSERT/UPDATE on products | | recomputes the vector |
| `product_variants_search_touch()` | triggers `product_variants_search_ins_del`, `product_variants_search_upd` (name, sku, option_values, is_active, product_id — when changed) | | re-indexes the affected products |
| `categories_search_touch()` | trigger `categories_search_touch` AFTER UPDATE OF name | | re-indexes the category's products |
| `_search_tsquery(p_query text)` → tsquery | — | | shopper text → prefix tsquery (NULL when nothing searchable) |
| `_quote_tsquery_lexeme(p_lexeme text)` → text | — | | quotes one lexeme for tsquery input |

**`search_products`**
- Input clamps: query whitespace-collapsed, trimmed, ≤ 100 chars (NULL/blank → no rows);
  `p_limit` 1..48 (NULL → 24); `p_offset` 0..10000 (NULL → 0).
- Matching: tokens from the `simple` parser (≤ 8, ≤ 40 chars); filler words (`a an and the for
  with of in on to my me i is it at by or from need want looking some any please`) dropped unless
  nothing else remains; 1-character tokens dropped when longer ones exist; every token ≥ 2 chars is
  a **prefix** match; a trailing plural `s` also matches the singular; **all** tokens must match.
  Shopper text never becomes tsquery syntax (operators/quotes are inert).
- Only **visible** products (`is_active AND variant_count > 0`).
- Rank: `ts_rank_cd(vector, query)` + 0.5 when name or brand starts with the query; order rank
  DESC, `sort_order`, `id`.
- Fuzzy fallback (only when there are **zero** full-text matches, the query is ≥ 3 chars and
  `pg_trgm` is installed): `word_similarity(query, lower(brand || ' ' || name || ' ' || subtitle))
  >= 0.5`, rank = similarity.
- `total_count` = matches across all pages, repeated on each row; **an empty page carries no
  count** (treat as "no results on this page"; for page 1 that means zero results).
- Route/page (WP-A — `searchProductIds` / `searchRankedProductIds` in `src/lib/catalogue.ts`,
  used by `src/app/(store)/shop/shop-results.ts`): a plain search pages with
  `rpc('search_products', { p_query: q, p_limit: 24, p_offset })` → cards by id
  (`getProductsByIds`, rank order kept); `total = data[0]?.total_count` (an empty page past the end
  asks page 1 for the total). A search combined with refinements or another sort ranks up to 96 ids
  (two calls of 48) and filters/sorts them with `listProducts({ ids, … })`. Search is NOT cached
  (shopper text never becomes a cache key). An RPC failure shows "search unavailable" — never
  "no results" — and records nothing; a page-1 search records
  `track("search", { value: total, metadata: { query, results: total } })` with the query's own
  total (0 included: the admin "stock this" list). Zero results → link to /discover.

Neither `search_products` nor `catalogue_facets` raises for any input — hostile, empty, NULL or
megabyte-sized strings are truncated/normalised first (tested). Only `PGRST202` (migration 06 not
applied) or transport errors can surface.

**`catalogue_facets(p_category)`** → 
```json
{
  "total": 16,
  "price": { "min": 4450.00, "max": 724900.00 },
  "brands": [ { "brand": "Aero Lite", "count": 1 }, … ],
  "categories": [ { "id": "laptops", "name": "Laptops", "count": 4 }, … ]
}
```
Counts are of visible products. `categories` = every **active** category with its real count
(global, ordered by `sort_order`, id; includes zero counts). `total`, `price` (from-prices; `null`
min/max when empty) and `brands` (grouped case-insensitively, alphabetical) are scoped to
`p_category` when given (trimmed, lower-cased; unknown → `total 0`). Use it for the /shop brand +
price filters and for the homepage CategoryPopouts counts (WP-A reads it through
`getCatalogueFacets({ categoryId })` — cached, tag `catalogue`, fails soft to empty facets).

---

## 07_orders.sql — the order ledger (SQL-2)

Order numbers: sequence `order_number_seq` (START 10001). Only `place_order` takes numbers; no
API role may use or reset the sequence. Ids are `'DO-' || nextval` → `DO-10001`, `DO-10002`, …
(CHECK `orders_id_format`: `^DO-[0-9]{1,12}$`).

#### `orders`

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | text | NOT NULL (PK) | | `DO-10001`; written by `place_order` only |
| `customer_id` | uuid | yes (FK `orders_customer_id_fkey` → customers ON DELETE SET NULL) | | the signed-in buyer (when they have a `customers` row), or linked later when a guest's email is **confirmed** (02) |
| `email` | text | NOT NULL | | lower-cased + trimmed by `place_order`; 3–255 |
| `first_name` | text | yes | | ≤ 255 (`place_order` requires it) |
| `last_name` | text | yes | | ≤ 255 |
| `phone` | text | NOT NULL | | E.164 from `place_order` (`+94771234567`, or `+<country><number>` for abroad); 1–50 |
| `status` | text | NOT NULL | `'pending'` | `pending\|processing\|accepted\|fulfilled\|shipped\|out_for_delivery\|delivered\|cancelled` (`processing`/`shipped` exist for the blueprint vocabulary but are never assigned) |
| `fulfillment` | text | NOT NULL | `'delivery'` | `delivery\|pickup` (showroom) |
| `shipping_address` | jsonb | NOT NULL (object) | `'{}'` | delivery: `{"street","city","district","postal_code","country":"Sri Lanka"}` (`postal_code` may be `null`); pickup: `{}` |
| `customer_note` | text | yes | | ≤ 1000; delivery instructions from checkout |
| `subtotal` | numeric(12,2) | NOT NULL | `0` | LKR, Σ `unit_price × quantity` |
| `shipping_fee` | numeric(10,2) | NOT NULL | `0` | LKR (delivery rule below) |
| `discount_id` | integer | yes (FK `orders_discount_id_fkey` → discounts ON DELETE SET NULL, added by 08) | | the redeemed code |
| `discount_code` | text | yes | | snapshot, upper-case, ≤ 64 |
| `discount_amount` | numeric(12,2) | NOT NULL | `0` | LKR, whole rupees |
| `total_price` | numeric(12,2) | NOT NULL | `0` | LKR charged = `max(subtotal − discount_amount, 0) + shipping_fee` |
| `packing_charges` | numeric(10,2) | NOT NULL | `0` | the store's own packing cost (admin), 0–100000, **not charged**; never show to shoppers |
| `currency` | text | NOT NULL | `'LKR'` | display currency the shopper saw — record only (`^[A-Z]{3}$`) |
| `exchange_rate` | numeric(14,6) | NOT NULL | `1` | units of `currency` per 1 LKR at checkout — record only, (0, 1000] |
| `payment_method` | text | NOT NULL | `'cod'` | `cod\|bank_transfer` |
| `payment_status` | text | NOT NULL | `'pending_collection'` | `pending_collection\|awaiting_transfer\|paid\|refunded\|void`; `orders_payment_pair_valid`: a COD order is never `awaiting_transfer`, a bank transfer never `pending_collection` |
| `payment_ref` | text | yes | | ≤ 120 (admin: transfer reference) — never show to shoppers |
| `tracking_number` | text | yes | | ≤ 100 |
| `tracking_url` | text | yes | | ≤ 500, `https://` only, no whitespace/backslash |
| `view_token` | uuid | NOT NULL | `gen_random_uuid()` | the `/order/[id]?t=` credential (returned by `place_order`) |
| `created_at` / `updated_at` | timestamptz | NOT NULL | `now()` | `updated_at` set by trigger `orders_touch` |

#### `order_items` (one row per variant; `place_order` merges duplicate cart lines)

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | NOT NULL (PK) | bigserial | lines are inserted in (product_id, variant_id) order — order by `id` |
| `order_id` | text | NOT NULL (FK → orders ON DELETE CASCADE) | | |
| `product_id` | integer | yes (FK → products ON DELETE SET NULL) | | NULL once the product is deleted |
| `variant_id` | integer | yes (FK → product_variants ON DELETE SET NULL) | | NULL once the variant is deleted |
| `quantity` | integer | NOT NULL | | 1–1000 by CHECK; `place_order` allows 1–10 per variant |
| `unit_price` | numeric(12,2) | NOT NULL (≥ 0) | | LKR **charged** per unit (the variant price at checkout) |
| `product_name` | text | NOT NULL (1–200) | | snapshot |
| `brand` | text | yes (≤ 80) | | snapshot |
| `variant_name` | text | yes (≤ 120) | | snapshot (`Standard` for single-variant products) |
| `sku` | text | yes (≤ 64) | | snapshot |
| `image_url` | text | yes (≤ 1000) | | snapshot of the product's `image_url` |
| `created_at` | timestamptz | NOT NULL | `now()` | |

#### `order_tracking` (the shopper's append-only timeline)

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | NOT NULL (PK) | bigserial | |
| `order_id` | text | NOT NULL (FK → orders ON DELETE CASCADE) | | |
| `status` | text | NOT NULL | | a **human label** ("Out for delivery"), 1–80 chars after trim — not `orders.status` |
| `location` | text | yes (≤ 120) | | |
| `description` | text | yes (≤ 1000) | | |
| `created_at` | timestamptz | NOT NULL | `now()` | order a timeline by `created_at, id` |

Labels written by the RPCs (`lib/orders.ts` must use the same words): `Order placed`, `Processing`,
`Accepted`, `Packed` (fulfilled), `Shipped`, `Out for delivery` / **`Ready for pickup`** (pickup),
`Delivered` / **`Collected`** (pickup), `Cancelled`, `Update` (note or tracking on the same status),
`Payment received`, `Payment refunded`, `No payment due`.

Constraint names: `orders_id_format`, `orders_status_valid`, `orders_fulfillment_valid`,
`orders_payment_method_valid`, `orders_payment_status_valid`, `orders_payment_pair_valid`,
`orders_money_valid`, `orders_currency_valid`, `orders_shipping_object`, `orders_text_lengths`,
`order_items_quantity_valid`, `order_items_price_valid`, `order_items_text_lengths`,
`order_tracking_text_lengths`. Indexes: `orders (customer_id, created_at DESC)`, `lower(email)`,
`created_at DESC`, `(status, created_at DESC)`, `upper(discount_code)`, `discount_id`;
`order_items (order_id, id)`, `product_id`, `variant_id`; `order_tracking (order_id, created_at, id)`.

**RLS per verb** (anon has **no privilege** on any of the three tables → 42501; TRUNCATE revoked)

| table | verb | shopper (authenticated) | admin |
| --- | --- | --- | --- |
| `orders` | SELECT | own: `customer_id = auth.uid() OR lower(email) = _viewer_verified_email()` (the viewer's email only once Supabase Auth has **confirmed** it — definer helper, grant U; order_items / order_tracking use the same test) | all |
| `orders` | INSERT | ✗ RLS 42501 | ✗ **42501 `order_insert_managed:…`** (orders come from `place_order`) |
| `orders` | UPDATE | 0 rows (no policy) | **contact columns only**: `first_name, last_name, phone, shipping_address, customer_note`. Changing any other column → **22023 `order_field_managed:<column> changes only through admin_set_order_status / admin_set_payment_status`**. A full-row save that leaves managed columns unchanged passes |
| `orders` | DELETE | 0 rows | ✗ **42501 `order_delete_managed:…`** (cancel instead: restock + reversals) |
| `order_items` | SELECT | lines of own orders | all |
| `order_items` | INSERT/UPDATE/DELETE | ✗ / 0 rows | ✗ **42501 `order_items_managed:…`** (a no-op save passes) |
| `order_tracking` | SELECT | rows of own orders | all |
| `order_tracking` | INSERT/UPDATE/DELETE | ✗ / 0 rows | ✓ (manual timeline rows / corrections) |

| Signature | Grant | Contract |
| --- | --- | --- |
| `orders_guard()` | — | trigger `orders_10_guard` BEFORE INSERT/UPDATE/DELETE on orders; enforces the column rules above. **Passes**: callers with no JWT (`auth.uid()` NULL: SQL editor, jobs, GoTrue triggers), definer functions that set `app.trusted_write = 'on'` (`place_order`, `admin_set_order_status`, `admin_set_payment_status`, 02's `link_guest_orders`), and the FKs' ON DELETE SET NULL (`customer_id`/`discount_id` → NULL once the referenced row is gone). Setting `customer_id`/`discount_id` by hand → 22023 `order_field_managed:customer_id` / `…:discount_id` |
| `order_items_guard()` | — | trigger `order_items_10_guard`; same passes (plus the product/variant SET NULL) |

Route/page notes:
- **Dashboard / tracking tab (WP-D, session client)** — RLS scopes the rows; the embeds are
  unambiguous:
  `from('orders').select('id, status, fulfillment, created_at, subtotal, shipping_fee, discount_code, discount_amount, total_price, currency, payment_method, payment_status, tracking_number, tracking_url, order_items(id, product_id, variant_id, product_name, brand, variant_name, sku, image_url, quantity, unit_price), order_tracking(id, status, location, description, created_at)').order('created_at', { ascending: false })`
  with `.order('id', { referencedTable: 'order_items' })` and
  `.order('created_at', { referencedTable: 'order_tracking' })`. Select **named columns** — the
  owner can technically read `packing_charges`, `payment_ref`, `discount_id` and `view_token` of
  their own orders, but they are internal (the token only matters as `/order/<id>?t=<token>`).
  Show the **charged** `unit_price`. "Still sold" = the `product_id` is returned by
  `products.select('id').in('id', ids)` (shoppers only see visible products).
- **Admin Orders (WP-C)**: list with `select('…', { count: 'exact' })`, filters on `status`,
  `payment_status`, `fulfillment`, `created_at`; emails are stored lower-case (search with
  `.eq('email', q.toLowerCase())` or `ilike`). Customer dossier: `.or('customer_id.eq.<uuid>,email.eq.<lower email>')`.
  Contact correction: `.update({ first_name, last_name, phone, shipping_address, customer_note }).eq('id', id).select()` → check 1 row
  (the DB does not re-validate phone/district on admin edits — normalise in the form).
  Manual timeline row: `from('order_tracking').insert({ order_id, status, location?, description? }).select()`.
  **Status, tracking, packing charges and payment only through the RPCs in 09.**
- Guest linking (02) is live now: confirming an email links that address's guest orders
  (`customer_id IS NULL`) and recomputes the account's `total_spent`/`orders_count` from its
  non-cancelled orders.

---

## 08_discounts.sql — discount codes (SQL-2)

#### `discounts` (admin only; anon no privilege)

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | integer | NOT NULL (PK) | serial | |
| `code` | text | NOT NULL, unique on `upper(code)` (`discounts_code_upper_key`) | | trimmed + upper-cased by trigger; `^[A-Z0-9][A-Z0-9_-]{1,31}$` (= `normalizeOfferCode` in `src/lib/offer-code.ts`) |
| `title` | text | NOT NULL | | admin-facing name, 1–120 after trim |
| `kind` | text | NOT NULL | `'percentage'` | `percentage\|fixed_amount` (LKR) |
| `value` | numeric(12,2) | NOT NULL | | > 0, ≤ 100,000,000; percentage ≤ 100 |
| `min_requirement` | numeric(12,2) | NOT NULL | `0` | LKR pre-discount subtotal needed |
| `starts_at` / `ends_at` | timestamptz | yes | | NULL = open-ended; `ends_at > starts_at` |
| `usage_limit` | integer | yes | | NULL = unlimited; > 0 |
| `usage_count` | integer | NOT NULL | `0` | **derived**: +1 in `place_order`, −1 on cancellation; app writes to it are silently restored (INSERT always starts at 0) |
| `is_active` | boolean | NOT NULL | `true` | |
| `assistant_only` | boolean | NOT NULL | `false` | only the assistant may **offer** it (anyone holding it may use it); CHECK: must have a `usage_limit` |
| `created_at` / `updated_at` | timestamptz | NOT NULL | `now()` | `updated_at` by trigger |

Constraint names: `discounts_code_format`, `discounts_title_valid`, `discounts_kind_valid`,
`discounts_value_valid`, `discounts_percentage_max`, `discounts_min_valid`,
`discounts_dates_valid`, `discounts_usage_valid`, `discounts_assistant_needs_cap`,
`discounts_code_upper_key` (23505 "code already exists").

**RLS per verb**: anon ✗ no privilege (42501) on everything; shopper SELECT 0 rows, INSERT 42501,
UPDATE/DELETE 0 rows; admin ALL (`discounts_admin_all`, WITH CHECK). Shoppers learn about codes only
through `quote_order` / `validate_discount` (09) and the assistant's offers.

| Signature | Grant | Contract |
| --- | --- | --- |
| `discounts_normalize()` | — | trigger `discounts_10_normalize` BEFORE INSERT/UPDATE: `code = upper(btrim(code))`, `title = btrim(title)`; pins `usage_count` (0 on insert, the old value on update) unless `app.trusted_write = 'on'` or no JWT (SQL editor — the owner can repair a count there) |

Admin tab (WP-C): `insert({ code, title, kind, value, min_requirement, starts_at, ends_at, usage_limit, is_active, assistant_only }).select()`,
`update({...}).eq('id', id).select()` → check 1 row. Prefer **deactivating** to deleting: deleting
clears `orders.discount_id` (the `discount_code` snapshot stays) and the cancellation then
returns the use by code match. Show `usage_count / usage_limit` read-only.

---

## 09_order_rpcs.sql — quote, place, track, view, admin status (SQL-2)

**The rules** (SQL is the authority; TypeScript mirrors — change both together, P7):

- **Delivery**: pickup → `0`; otherwise `0` when `free_delivery_threshold IS NOT NULL AND subtotal >= free_delivery_threshold`,
  else `store_settings.delivery_fee`. The subtotal is **before** the discount (a code never costs
  free delivery); a subtotal exactly at the threshold delivers free (`<` semantics). Mirror:
  `src/lib/delivery.ts deliveryFeeFor()` (already identical).
- **Lines**: 1–50 lines; quantity integer 1–**10** per **variant** (lines naming the same variant
  are merged and their total must be ≤ 10). Mirror: `MAX_QTY` in `src/lib/cart.ts`.
- **Discount maths**: percentage → `round(subtotal × min(value,100) / 100, 0)`, fixed →
  `round(value, 0)`, both capped at the subtotal — **whole rupees**. Total =
  `max(subtotal − discount, 0) + delivery`.
- **Payment**: the client sends a **method**, never a status. `cod` → `pending_collection`,
  `bank_transfer` → `awaiting_transfer`. A method is refused unless `store_settings` enables it;
  bank transfer additionally needs the account (`bank_account_name`, `bank_name`,
  `bank_account_number` — the branch and note are optional), pickup needs a
  non-blank `pickup_address` (P15 — decision for SQL-1's 03 honesty note: **09 refuses**, and
  `quote_order` reports `*_available` flags so the checkout hides the options). `cod_max_total`
  (when set) caps COD on the order **total**.
- **Phone**: step 1 = exactly `normalizeLkPhone()`; step 2 (only when step 1 fails) = an
  international number written with `+` or `00` and a country code other than 94 →
  `+<8–15 digits>`. `normalizeLkPhone()` rejects step-2 numbers, so the checkout form must not
  block them client-side — it validates with `normalizeOrderPhone()` in `src/lib/checkout.ts`
  (step 1 = `normalizeLkPhone()`, step 2 = this international rule), the mirror of `_normalize_phone`.
- **Currency**: `p_currency ∈ {LKR, USD, GBP, EUR, AUD, INR, AED}` (= `CURRENCIES` in
  `src/lib/currency-shared.ts`), case-insensitive; `p_exchange_rate` in (0, 1000], rounded to 6 dp,
  and exactly `1` for LKR. Recorded only — the charge is always LKR.
- **Lock order** (deadlock-free): inventory rows by `(product_id, variant_id)` → discount row →
  customer row. Anything else that locks several inventory rows must use the same order.

| Signature | Grant | Volatility | Returns |
| --- | --- | --- | --- |
| `quote_order(p_items jsonb, p_discount_code text DEFAULT NULL, p_fulfillment text DEFAULT 'delivery')` | **A** | STABLE (read-only) | jsonb (below) |
| `place_order(p_email text, p_first_name text, p_last_name text, p_phone text, p_shipping jsonb, p_items jsonb, p_discount_code text DEFAULT NULL, p_abandoned_cart_id uuid DEFAULT NULL, p_currency text DEFAULT 'LKR', p_exchange_rate numeric DEFAULT 1, p_payment_method text DEFAULT 'cod', p_fulfillment text DEFAULT 'delivery', p_customer_note text DEFAULT NULL)` | **A** | VOLATILE | jsonb (below) |
| `validate_discount(p_code text, p_subtotal numeric)` | **A** | STABLE | `{valid, discount_amount, reason, minimum}` |
| `track_guest_order(p_order_id text, p_email text)` | **A** | VOLATILE (throttle writes) | `null` \| `{"throttled": true}` \| order view |
| `view_order(p_order_id text, p_token uuid)` | **A** | VOLATILE (throttle writes) | `null` \| `{"throttled": true}` \| confirmation view |
| `admin_set_order_status(p_order_id text, p_status text, p_tracking_number text DEFAULT NULL, p_tracking_url text DEFAULT NULL, p_packing_charges numeric DEFAULT NULL, p_note text DEFAULT NULL)` | **U** (admin re-checked) | VOLATILE | jsonb summary |
| `admin_set_payment_status(p_order_id text, p_status text, p_payment_ref text DEFAULT NULL)` | **U** (admin re-checked) | VOLATILE | jsonb summary |

There is **no `p_payment_status` parameter** (a forged status gets `PGRST202`). Exactly one
overload of each function exists. Every order number argument accepts what a shopper types:
`DO-10001`, `do-10001`, `#10001`, `10001`, `DO 10001`.

### `quote_order` — every total the shopper sees (cart drawer, /cart, checkout summary)

Never raises for bad input (only `store_unavailable` when the settings row is missing, and
`PGRST202` before the migration). Never writes (tested: stock, discount uses, orders untouched).

```jsonc
{
  "lines": [{
    "line": 1,                    // 1-based position in p_items (only the first 50 are quoted)
    "product_id": 7, "variant_id": 11,   // the ids as sent (null when malformed)
    "quantity": 2,                // clamped 1..10 (missing/0/over 10 → clamped)
    "quantity_adjusted": false,   // true when the clamp changed it → cart.setQty(variantId, quantity)
    "available": true,            // reason === null
    "reason": null,               // null | unknown_product | inactive | invalid_variant | out_of_stock | insufficient_stock
    "product_name": "DuoLink Flash Drive 128GB", "brand": "DuoLink", "slug": "duolink-flash-drive-128gb",
    "image_url": "/images/products/sto-03.webp",
    "variant_name": "Standard", "sku": "DUOLINK-128GB",
    "unit_price": 4450.00,        // LKR from product_variants (null for hidden products / invalid variants)
    "compare_at_price": 5900.00,  // only when > unit_price, else null
    "line_total": 8900.00,        // only when available, else null
    "stock": "ok",                // null (unknown/hidden/invalid) | "ok" (untracked or above threshold) | "low" | "out"
    "stock_level": null           // exact level ONLY when stock = "low" or reason = "insufficient_stock"
  }],
  "orderable": true,              // place_order would accept these lines: 1..50 lines, all available, no quantity adjusted, no variant over 10 in total
  "subtotal": 14350.00,           // available lines only
  "shipping_fee": 450.00,         // 0 when no line is available
  "discount": { "code": "OPENING10", "valid": true, "amount": 1435.00, "reason": null, "minimum": null },  // null when no code sent
  "discount_amount": 1435.00,
  "total": 13365.00,
  "currency": "LKR",
  "fulfillment": "delivery",      // EFFECTIVE: "pickup" only when asked for AND pickup_available
  "delivery_fee": 450.00, "free_delivery_threshold": 15000.00,   // from store_settings (threshold null = never free)
  "amount_to_free_delivery": 650.00,                              // null when never free
  "pickup_available": true, "cod_available": true, "bank_transfer_available": true
}
```
- Reasons: `unknown_product` = no such product or a malformed line; `inactive` = product hidden
  (inactive or no active variant) — its name/price are **not** revealed; `invalid_variant` =
  variant missing, inactive or of another product; `out_of_stock` = tracked and level ≤ 0;
  `insufficient_stock` = tracked and level < this variant's total quantity across lines.
- `discount.reason`: `invalid` (unknown, malformed, inactive or not started) · `expired` ·
  `exhausted` · `minimum_not_met` (then `minimum` = the LKR minimum). `discount.code` is the
  upper-cased code (null when malformed).
- `cod_available` = COD enabled and (no cap or `total ≤ cod_max_total`); `bank_transfer_available`
  = enabled **and** account name, bank and number set; `pickup_available` = enabled **and** address set.
- Route (`/api/quote`, WP-C — built): body `{ items: [{productId, variantId, qty}], discountCode?, fulfillment? }`
  (60 / min per IP) → `rpc('quote_order', { p_items: items.map(i => ({ product_id: i.productId, variant_id: i.variantId, quantity: i.qty })), p_discount_code, p_fulfillment })`;
  answers the camelCase `Quote` of `src/lib/checkout.ts` (`quoteFromSql`) with the `discount`
  block collapsed to the `/api/discount` verdict shape (one refusal message, P14).
  Use the lines to `cart.reprice()`; copy suggestions: `unknown_product`/`inactive` "No longer
  available", `invalid_variant` "This option is no longer available", `out_of_stock` "Sold out",
  `insufficient_stock` "Only {stock_level} left", `stock = "low"` "Only {stock_level} left".
  On error show the local mirror and "prices are confirmed at checkout" (never block the basket).

### `place_order` — the only way an order is created

Checks run **in this order**; the first failure raises (P0001, `error.message` = code or
`code:detail`) and rolls back everything (stock, discount use):

| # | code | when |
| --- | --- | --- |
| 0 | `store_unavailable` | no `store_settings` row (fail closed) |
| 1 | `unsupported_payment_method` | method not `cod`/`bank_transfer` (trimmed, case-insensitive; NULL too), COD switched off, bank transfer switched off **or** without its account name, bank or number |
| 2 | `invalid_email` | not `x@y.z` shaped, or > 255 chars |
| 3 | `invalid_name` | blank first name, or first/last name > 255 |
| 4 | `invalid_phone` | not a phone number by the phone rule (NULL/blank too) |
| 5 | `invalid_fulfillment` | not `delivery`/`pickup` (NULL means delivery) |
| 6 | `pickup_unavailable` | pickup while `pickup_enabled` is off or `pickup_address` is blank |
| 7 | `invalid_shipping_address` | delivery only: not an object; `street` (≤ 500) / `city` (≤ 120) missing or not text; `district` not one of the 25 (case-insensitive; stored canonical); `postal_code` > 20; `country` given and not "Sri Lanka". Pickup ignores `p_shipping` and stores `{}` |
| 8 | `invalid_note` | note > 1000 chars |
| 9 | `invalid_items` | not an array, 0 or > 50 lines, a line that is not an object, `product_id`/`variant_id` missing or not an integer (numeric strings are fine) |
| 10 | `invalid_quantity` | quantity missing, not an integer, 0, > 10, or one variant > 10 across lines |
| 11 | `invalid_currency` | not a supported code (NULL too) |
| 12 | `invalid_exchange_rate` | NULL, ≤ 0, > 1000, NaN/Infinity, or ≠ 1 for LKR |
| 13 | `unknown_product:<product id>` | product missing or inactive (checked per variant in (product_id, variant_id) order) |
| 14 | `invalid_variant:<product name>` | variant missing, inactive or of another product |
| 15 | `out_of_stock:<label>` | tracked stock < quantity. `<label>` = product name, plus ` (<variant name>)` when the product has more than one active variant |
| 16 | `invalid_discount_code` | code malformed, unknown, inactive, not started or expired (a blank code = no code) |
| 17 | `discount_exhausted` | usage limit reached |
| 18 | `discount_minimum_not_met:<min>` | pre-discount subtotal < minimum; `<min>` like `20000.00` |
| 19 | `cod_limit_exceeded:<max>` | COD and `total > cod_max_total`; `<max>` like `100000.00` |

On success (one transaction): decrements tracked stock, counts the discount use, inserts the
order (`status 'pending'`, `view_token`), the lines (snapshots) and the timeline row
`Order placed` / "We have received your order.", marks the checkout autosave row converted (only
when `public.abandoned_carts` exists, the id matches, `lower(email)` matches and it is not yet
converted — never fails the order), and adds `total` to the signed-in buyer's
`customers.total_spent` / `orders_count` (guests: `customer_id` NULL). Returns:

```jsonc
{
  "order_id": "DO-10001", "view_token": "2f60852a-…", "created_at": "2026-09-22T14:27:57.68+00:00",
  "subtotal": 14350.00, "shipping_fee": 450.00, "discount_code": "OPENING10", "discount_amount": 1435.00,
  "total": 13365.00,              // NB: "total" here; the order views call it "total_price"
  "currency": "USD", "exchange_rate": 0.003300,   // as recorded (display only)
  "payment_method": "bank_transfer", "payment_status": "awaiting_transfer", "fulfillment": "delivery",
  "email": "guest@example.lk", "first_name": "Nimal", "last_name": "Perera", "phone": "+94771234567",
  "shipping_address": { "street": "12 Galle Road", "city": "Colombo 03", "district": "Colombo", "postal_code": "00300", "country": "Sri Lanka" },
  "customer_note": "Call first",
  "items": [{ "product_id": 7, "variant_id": 11, "product_name": "…", "brand": "…", "variant_name": "Standard",
              "sku": "DUOLINK-128GB", "image_url": "/images/products/sto-03.webp", "quantity": 2,
              "unit_price": 4450.00, "line_total": 8900.00 }]   // (product_id, variant_id) order
}
```

**`/api/checkout` must** (blueprint §9.4, BUILD_SPEC §9 WP-C):
1. body cap, honeypot (answer as `invalid_items`), rate limit per IP **and** per email before the RPC;
2. map `{ productId, variantId, qty }` → `[{ product_id, variant_id, quantity }]`;
3. send `p_abandoned_cart_id` **only when it is a UUID** — otherwise `null` (the autosave id is
   `""` during hydration; a non-UUID string fails with `22P02` before the function runs);
4. send `p_discount_code` only when the shopper applied one (a refused code fails the whole order —
   the checkout should have removed codes that `quote_order` marked invalid);
5. call with the **session** client (so a signed-in buyer's `auth.uid()` links the order), `p_currency`/`p_exchange_rate` from `useCurrency()`, `p_payment_method`, `p_fulfillment`, `p_customer_note`;
6. map errors with the table below; emails after commit, fail-soft (confirmation to `email`,
   owner alert to `ORDER_NOTIFICATION_EMAIL`); bank-transfer confirmations list the amount, the
   order number as reference and the account (bank, branch, account name, number, extra note);
7. respond `{ ok: true, orderId, viewToken, subtotal, shippingFee, discountAmount, total, paymentMethod, paymentStatus, fulfillment }`
   and redirect to `/order/<orderId>?t=<viewToken>` (keep a sessionStorage copy).

**Route error map for `place_order`** (split `error.message` on the first `:`; never interpolate
anything but the listed details):

| code (P0001) | HTTP | suggested copy |
| --- | --- | --- |
| `out_of_stock:<label>` | 409 | "Sorry — “<label>” just sold out or doesn't have enough stock left. Please update your basket." |
| `unknown_product:<id>` | 409 | "An item in your basket is no longer available. Please remove it and try again." (don't show the id) |
| `invalid_variant:<name>` | 409 | "The option you chose for “<name>” is no longer available. Please choose another." |
| `discount_minimum_not_met:<min>` | 422 | "This code needs a minimum order of Rs. <min formatted>." |
| `invalid_discount_code`, `discount_exhausted` | 422 | one message for both (blueprint §9.6, `lib/discount-copy.ts`): "This code can't be used for this order." |
| `cod_limit_exceeded:<max>` | 422 | "Cash on delivery is available for orders up to Rs. <max formatted>. Please choose bank transfer." |
| `unsupported_payment_method` | 422 | "That payment method isn't available right now. Please choose another." |
| `pickup_unavailable` | 422 | "Showroom pickup isn't available right now. Please choose delivery." |
| `invalid_fulfillment` | 422 | "Please choose delivery or showroom pickup." |
| `invalid_email` | 422 | "Please enter a valid email address." |
| `invalid_name` | 422 | "Please enter your first name." |
| `invalid_phone` | 422 | "Please enter a valid phone number, e.g. 077 123 4567." |
| `invalid_shipping_address` | 422 | "Please enter your street address, city and district." |
| `invalid_note` | 422 | "Delivery notes can be up to 1,000 characters." |
| `invalid_items` | 422 | "Your basket couldn't be read. Please refresh the page and try again." (also the honeypot answer) |
| `invalid_quantity` | 422 | "You can order up to 10 of each item." |
| `invalid_currency`, `invalid_exchange_rate` | 422 | "We couldn't confirm your display currency. Please refresh and try again." |
| `store_unavailable` | 503 | "Checkout is temporarily unavailable. Please try again shortly." (log: `store_settings` row missing — 03) |
| `PGRST202` / `42883` | 503 | `MIGRATIONS_PENDING_MESSAGE` (log "apply 09_order_rpcs.sql") |
| `40P01` / `40001` (should not happen) | 503 | "Please try again." (the whole order rolled back — safe to retry once) |
| `22P02` | 422 | should be unreachable (validate the cart id); "Please refresh the page and try again." |
| anything else | 500 | "We could not place your order. Please try again." |

### `validate_discount(p_code, p_subtotal)` — advisory preview

Never counts a use, never raises. `p_subtotal` is clamped to [0, 1,000,000,000] (NULL → 0).
Returns `{"valid": true|false, "discount_amount": 900.00|0, "reason": null|"invalid"|"expired"|"exhausted"|"minimum_not_met", "minimum": null|20000.00}`
(`minimum` only with `minimum_not_met`). Same verdict as `quote_order.discount` and `place_order`.
`/api/discount` (blueprint §9.6, WP-C — built): constant shape
`{ ok: true, valid, discountAmount, message, minimum, code }` (`minimum` only for
`minimum_not_met`, so the UI can render it through `<Price>`); one message for every reason except
`minimum_not_met` (`src/lib/discount-copy.ts`, shared with the assistant); on RPC failure, an
unconfigured project or the route's 20 / min limit: `valid: null` with the blueprint's "We could
not check this code just now…" line. Codes are not listable; there is no
in-DB throttle here (nothing but a yes/no leaks), so keep the route's per-IP limit.

### `track_guest_order(p_order_id, p_email)` — `/api/track`

Both must match (email case-insensitive). In-DB throttle: 8 per 15 min per order number **and**
per `md5(email)`; every lookup charges both buckets; a miss charges both again (a miss costs
double); a throttled call records nothing. Blank number or email → `null` (charges nothing).
Returns `null` (no match — wrong and missing look alike), `{"throttled": true}`, or the **order
view**:

```jsonc
{ "order_id", "status", "created_at", "fulfillment", "subtotal", "shipping_fee", "discount_code",
  "discount_amount", "total_price", "currency", "exchange_rate", "payment_method", "payment_status",
  "tracking_number", "tracking_url",
  "items": [{ "product_id", "variant_id", "product_name", "brand", "variant_name", "sku", "image_url",
              "quantity", "unit_price", "line_total" }],                    // by line id
  "timeline": [{ "status", "location", "description", "at" }] }             // oldest first
```
Never the address, phone, email, note, view token, payment reference or packing charges.
Route: POST `{ order, email }` (never in a URL), route limit 15 / 15 min per IP; answer `null`
**and** `{"throttled": true}` with the **same** 404 body (P14): "We couldn't find an order with
that number and email. Check both and try again in a few minutes."

### `view_order(p_order_id, p_token)` — `/order/[id]?t=<view_token>`

The token is the credential (an order number alone never is). Right token → the order view
**plus**:
```jsonc
{ "first_name": "Nimal",
  "shipping": { "city": "Colombo 03", "district": "Colombo" },   // delivery orders; null for pickup — never street/phone/email
  "pickup": { "address": "<store_settings.pickup_address>", "note": "<pickup_note>" },   // pickup orders; else null
  "bank_transfer": { "account_name": "Dock One Solutions Pvt Ltd", "bank_name": "Bank of Ceylon",
                     "branch": "Vishaka", "account_number": "79503030", "instructions": null } }
                                                                  // only while bank_transfer + awaiting_transfer; else null
```
Wrong/NULL token or unknown order → `null`; each wrong token costs 2 of 8 per 15 min on that order
number, and once that bucket is full further wrong tokens answer `{"throttled": true}`. The
**right token always works and costs nothing** (sequential numbers: a throttle on the right token
would let anyone lock a shopper out of their own page). Page: `noindex`, server component; treat
`null` and `throttled` alike → `notFound()`; if the UUID in `?t=` is malformed, don't call (a
non-UUID is `22P02`). Show "Awaiting your transfer" + the instructions when present.

### `admin_set_order_status(...)` — `POST /api/admin/order-status` (WP-C)

Admin re-checked inside (42501). Assignable: `pending, accepted, fulfilled, out_for_delivery,
delivered, cancelled` (= `ASSIGNABLE_ORDER_STATUSES`). Transitions: any assignable status on a
non-cancelled order (moving back corrects a mistake); **a cancelled order is final**.
`out_for_delivery` needs a tracking number (given now or already stored) for **delivery** orders;
pickup orders become "Ready for pickup" without one. `p_tracking_number`/`p_tracking_url`/
`p_packing_charges` NULL or blank = keep the stored value.

Cancelling (in the same transaction, exactly once): restocks every tracked variant of the order
(capped at 1,000,000; untracked stay untracked), returns the discount use (by `discount_id`, or
by code if the code row was re-created), and subtracts `total_price` / 1 order from the
customer's rollup (never below 0). It does **not** change `payment_status` (void or refund it
with `admin_set_payment_status`).

Timeline: a status change adds the label for the new status (pickup-aware); a note and/or a new
tracking number adds its text as the description ("<note> Tracking reference <n>."); the same
status with only a note/tracking/URL change adds an `Update` row; packing charges alone add no row.

Errors (message = `code:human text`; show the text to the admin):

| SQLSTATE | code | when |
| --- | --- | --- |
| 42501 | `not_authorised` | caller is not an admin |
| 22023 | `invalid_status` | not an assignable status |
| 22023 | `invalid_tracking_number` | > 100 chars |
| 22023 | `invalid_tracking_url` | not `https://…`, > 500 chars, whitespace/backslash |
| 22023 | `invalid_packing_charges` | outside 0–100000 (NaN too) |
| 22023 | `invalid_note` | > 500 chars |
| 22023 | `order_not_found` | no such order |
| 22023 | `invalid_transition` | cancelled → anything else |
| 22023 | `tracking_required` | `out_for_delivery` on a delivery order with no tracking number |

Returns (also when nothing changed):
```jsonc
{ "order_id", "status", "previous_status", "changed": true|false, "timeline_label": "Out for delivery"|null,
  "fulfillment", "email", "first_name", "last_name", "total_price", "currency", "exchange_rate",
  "payment_method", "payment_status",
  "amount_due",          // total_price while payment_status is pending_collection/awaiting_transfer, else 0
  "tracking_number", "tracking_url", "packing_charges" }
```
Route: 403 on 42501, 422 with the detail on 22023. Send the customer email **only when
`changed && status !== previous_status`** and the new status is `out_for_delivery` (tracking
reference; "Rs. <amount_due> to pay on delivery" when `payment_method = 'cod'` and
`amount_due > 0`; for pickup orders "Ready for pickup" + the pickup address from settings) or
`delivered` (the 48 h window). Return `emailed: <address>|null`. Then revalidate nothing
(orders are not cached).

### `admin_set_payment_status(p_order_id, p_status, p_payment_ref)`

Admin re-checked (42501 `not_authorised`). Allowed: `pending_collection|awaiting_transfer → paid`,
`paid → refunded`, anything → `void` **only on a cancelled order**. Same status → only a new
`payment_ref` is saved (no timeline row). Each status change adds `Payment received` /
`Payment refunded` / `No payment due`. Errors (22023): `invalid_payment_status` (not
paid/refunded/void), `invalid_payment_ref` (> 120), `order_not_found`,
`invalid_payment_transition:<from> cannot become <to>[ (cancel the order first)].`. Returns
`{order_id, status, payment_status, previous_payment_status, payment_ref, changed, timeline_label, payment_method, fulfillment, email, first_name, last_name, total_price}`.
COD orders are marked `paid` by the admin after the courier remits the cash; bank transfers when
the money arrives. May be called from the admin client (session) or a route; no email is required.

### Internal helpers (no grants — for other SQL authors; do not duplicate their logic, P6)

| Signature | Returns | Contract |
| --- | --- | --- |
| `_lk_districts()` | text[] | the 25 districts (same strings as `customers_district_valid` and `DISTRICTS`) |
| `_canonical_district(text)` | text | case-insensitive match → canonical name, else NULL |
| `_json_text(jsonb, text)` | text | object field as trimmed text when string/number, '' → NULL |
| `_normalize_phone(text)` | text | the phone rule → E.164 or NULL |
| `_normalize_order_ref(text)` | text | `#10001`/`do-10001`/`10001` → `DO-10001`; other text upper-cased, ≤ 64; blank → NULL |
| `_parse_order_items(jsonb)` | TABLE `(line int, product_id int, variant_id int, quantity int, well_formed bool)` | malformed values → NULL |
| `_delivery_fee(subtotal numeric, fulfillment text, fee numeric, threshold numeric)` | numeric | the delivery rule |
| `_discount_amount(kind text, value numeric, subtotal numeric)` | numeric | whole-rupee discount |
| `_discount_check(code text, subtotal numeric)` | jsonb `{discount_id, code, valid, amount, reason, minimum}` | the one discount verdict (never counts a use) — SQL-4's `list_live_offers` / assistant maths should use it with `_delivery_fee` |
| `_order_status_label(status text, fulfillment text)` | text | timeline labels |
| `_order_view(order_id text)` | jsonb | the shopper-safe order view above (callers must authorise first) |

---

## 10_wishlists.sql — saved items (SQL-2)

#### `wishlists`

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `customer_id` | uuid | NOT NULL (FK → customers ON DELETE CASCADE) | | |
| `product_id` | integer | NOT NULL (FK → products ON DELETE CASCADE) | | |
| `list_type` | text | NOT NULL | `'favorite'` | `favorite\|buy_later` (`wishlists_list_type_valid`) |
| `created_at` | timestamptz | NOT NULL | `now()` | |

PK `wishlists_pkey (customer_id, product_id, list_type)` — a duplicate is `23505 wishlists_pkey`.

**RLS per verb**: anon ✗ no privilege (42501); shopper SELECT/INSERT/DELETE own rows
(`customer_id = auth.uid()`, INSERT WITH CHECK), **no UPDATE privilege** (move = delete + insert);
admin SELECT all (read-only). TRUNCATE revoked.

| Signature | Grant | Returns | Contract |
| --- | --- | --- | --- |
| `merge_wishlist(p_product_ids int[])` | **U** | int[] | sign-in merge: takes the first 100 distinct non-NULL ids (of the first 1000 elements), inserts those that are **visible** products as `favorite` (existing rows untouched, idempotent), returns the account's visible favourites **newest first**. Raises `not_signed_in` (P0001) with no JWT or no `customers` row |

Client (WP-D, `lib/wishlist.ts`, browser client):
- On sign-in: `rpc('merge_wishlist', { p_product_ids: localIds })` → `number[]` → replace the local
  list with it.
- Add: `from('wishlists').insert({ customer_id: user.id, product_id, list_type: 'favorite' })` —
  treat `23505` as success; or `.upsert(row, { onConflict: 'customer_id,product_id,list_type', ignoreDuplicates: true })`
  (a merging upsert needs UPDATE and fails with 42501).
- Remove: `.delete().eq('customer_id', user.id).eq('product_id', id).eq('list_type', 'favorite')`.
- Read: `.select('product_id, list_type, created_at').order('created_at', { ascending: false })`;
  rows of hidden products stay (they return with the product) — fetch cards by id and drop the
  ones that come back empty.

**As built (WP-D):** AuthListener calls `wishlist.syncAccount(uid)` on `INITIAL_SESSION` (with a
session) and on a new `SIGNED_IN`. With items saved locally it sends them (≤ 100 ids — the guest
store is capped at the same 100) to `merge_wishlist`, uses the returned array (visible favourites,
newest first) as the in-memory account list and removes the sent ids from localStorage. With
nothing local it reads the table under RLS:
`.select('product_id, created_at, products!inner(id)').eq('customer_id', uid).eq('list_type', 'favorite').eq('products.is_active', true).gt('products.variant_count', 0).order('created_at', { ascending: false })`
— the inner join keeps visible products only (so the header count and /wishlist agree; the
explicit filters also cover an admin, whose RLS reads every product). Toggles: `insert(...).select('product_id')` (23505 = already saved; anything else →
roll back + toast) and `delete().eq(customer_id).eq(product_id).eq(list_type).select('product_id')`
(0 rows = already gone). `list_type` is always `favorite` (no `buy_later` UI). Cards:
`GET /api/wishlist/products?ids=` → `getProductsByIds` (≤ 100). Sign-out clears both the account
list and the local list. Tested: INSERT/DELETE … RETURNING as the owner, and an admin's merge is
scoped to the admin's own rows.

---

## 11_reviews.sql — product reviews and ratings (SQL-2)

#### `product_reviews`

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | NOT NULL (PK) | bigserial | |
| `product_id` | integer | NOT NULL (FK → products ON DELETE CASCADE) | | |
| `customer_id` | uuid | yes (FK → customers ON DELETE SET NULL) | | NULL after the account is deleted (the review stays under its public name) |
| `author_name` | text | NOT NULL | | public name, 1–60 after trim (default "First L.") |
| `rating` | smallint | NOT NULL | | 1–5 |
| `title` | text | yes | | ≤ 120 |
| `body` | text | NOT NULL | | 10–4000 chars after trim |
| `status` | text | NOT NULL | `'pending'` | `pending\|approved\|rejected` |
| `is_verified_purchase` | boolean | NOT NULL | `false` | set by `submit_review` only |
| `is_featured` | boolean | NOT NULL | `false` | homepage testimonial candidate; forced `false` unless `approved` |
| `admin_reply` | text | yes | | ≤ 2000, public |
| `created_at` / `updated_at` | timestamptz | NOT NULL | `now()` | |

One review per customer per product: unique partial index `product_reviews_one_per_customer
(product_id, customer_id) WHERE customer_id IS NOT NULL`. Constraint names:
`product_reviews_rating_valid`, `product_reviews_status_valid`, `product_reviews_text_lengths`.

**RLS / privileges per verb**

| verb | anon | shopper | admin |
| --- | --- | --- | --- |
| SELECT | `approved` rows; **column grant without `customer_id`** → anon must name columns (`select('*')` = 42501) | `approved` rows + own rows (any status); all columns | all rows |
| INSERT | ✗ | ✗ (42501 RLS) | ✗ **42501 `review_insert_managed:…`** — reviews come only from `submit_review` |
| UPDATE | ✗ | 0 rows | **moderation columns only**: `status`, `is_featured`, `admin_reply`; any other column → **22023 `review_field_managed:<column> …`** |
| DELETE | ✗ | 0 rows | ✓ (spam) |

A signed-in shopper can read the `customer_id` of approved reviews (needed for "my review"
queries and the admin link). Account ids are identifiers, never credentials: no function may trust
a caller-supplied customer id.

| Signature | Grant | Returns | Contract |
| --- | --- | --- | --- |
| `submit_review(p_product_id int, p_rating int, p_title text, p_body text, p_author_name text)` | **U** | jsonb `{review_id, status, is_verified_purchase}` | see below |
| `get_review_summary(p_product_id int)` | **A** | jsonb `{product_id, total, average, counts: {"1": n, "2": n, "3": n, "4": n, "5": n}}` | approved reviews only; `average` 2 dp, `0` when none; never raises (unknown id → zeros) |
| `product_reviews_guard()` | — | trigger `product_reviews_10_guard` BEFORE INSERT/UPDATE | the column rules above; passes no-JWT callers and `app.trusted_write = 'on'`; clears `is_featured` on non-approved rows |
| `refresh_product_rating(p_product_id int)` | — | void | recomputes the product's rating from approved reviews via 04's `_apply_product_rating` |
| `product_reviews_rollup()` | — | trigger `product_reviews_rollup` AFTER INSERT/UPDATE/DELETE | keeps `products.rating_avg` / `rating_count` = approved reviews (both products when a review moves) |

**`submit_review`** checks in order (P0001): `not_signed_in` (no JWT or no customers row) →
`rate_limited` (5 successful submissions per hour per account; a refused submission rolls back
and costs nothing) → `unknown_product` (missing or hidden) → `invalid_rating` (not 1–5) →
`invalid_title` (> 120) → `invalid_body` (not 10–4000 after trim) → `invalid_author_name` (blank
and no profile name, or > 60). Verified purchase = a **delivered** order containing the product,
owned by the account **or** placed with the account's **confirmed** email. Upsert on
(product, customer): a changed rating/title/body/name returns the review to `pending` (and drops
`is_featured`); an identical resubmission keeps its status. Blank title → NULL.

`/api/reviews` (WP-J) error map: `not_signed_in` 401 "Please sign in to write a review." ·
`rate_limited` 429 "You've sent several reviews just now — please try again later." ·
`unknown_product` 404 "This product isn't available for reviews." · `invalid_rating` 422 "Choose
1 to 5 stars." · `invalid_title` 422 "Titles can be up to 120 characters." · `invalid_body` 422
"Reviews need 10 to 4,000 characters." · `invalid_author_name` 422 "Add a display name (up to 60
characters)." Success copy: "Thanks! Your review will appear once it's approved."

Reads:
- Public list (stateless anon client, tag `reviews`):
  `from('product_reviews').select('id, author_name, rating, title, body, is_verified_purchase, admin_reply, created_at').eq('product_id', id).eq('status', 'approved').order('created_at', { ascending: false })`.
- Summary: `rpc('get_review_summary', { p_product_id: id })`; cards and JSON-LD use
  `products.rating_avg` / `rating_count` (derived, approved only; show nothing when 0).
- "My review" (session client): `.select('id, rating, title, body, author_name, status').eq('product_id', id).eq('customer_id', user.id).maybeSingle()`.
- Homepage testimonial: `.select('author_name, rating, title, body, product_id').eq('status', 'approved').eq('is_featured', true).order('created_at', { ascending: false }).limit(1)`.
- Admin moderation: `.update({ status, is_featured, admin_reply }).eq('id', id).select()` → check
  the returned row (`is_featured` comes back `false` unless approved), then revalidate the
  `reviews` and `catalogue` tags (ratings changed). Delete: `.delete().eq('id', id).select()`.

Implementation (WP-J): `src/lib/reviews.ts` (`getReviewSummary`, `getApprovedReviews` — cached,
tag `reviews`, 5 per page, dates pre-formatted in Asia/Colombo on the server);
`GET /api/reviews?productId=&page=` (≤ page 50, 60/min per IP) and
`POST /api/reviews { productId, rating, title?, body, authorName?, company }` (16 KB cap, honeypot
answered like a success, 10/h per IP, session client → `submit_review`, the error map above; when
an edit sends a previously APPROVED review back to `pending` the route revalidates `reviews` +
`catalogue`); `components/reviews/ProductReviews` on `/product/[id]`; admin tab
`components/admin/tabs/ReviewsTab.tsx` (+ `components/admin/reviews/*`) through the kit's
`updateRows` / `deleteRows` with `revalidate: ["reviews", "catalogue"]`.

---

## Cross-agent contracts from SQL-2 (07–11)

- **Abandoned carts (SQL-3, 13):** `place_order` runs
  `UPDATE public.abandoned_carts SET converted = TRUE, converted_order_id = <order id>, updated_at = now() WHERE id = p_abandoned_cart_id AND lower(email) = <order email> AND NOT converted`
  when `to_regclass('public.abandoned_carts')` exists. Keep those blueprint column names (a renamed
  column is swallowed and carts never convert). `converted_order_id` may reference
  `orders(id) ON DELETE SET NULL` (the orders guard allows that SET NULL).
- **Best sellers / analytics (SQL-3/WP-H):** revenue and units come from `orders.total_price` /
  `order_items.quantity` of orders with `status <> 'cancelled'`; bucket days with
  `created_at AT TIME ZONE 'Asia/Colombo'`.
- **Assistant (SQL-4):** order lookups should reuse `_normalize_order_ref` and the same throttle
  shape as `track_guest_order`; offer maths through `_discount_check` / `_discount_amount` /
  `_delivery_fee`; never return `usage_count`. Anything that writes `orders` must set
  `app.trusted_write = 'on'` (and restore it) or it hits `orders_10_guard`.
- **Stock writers (WP-K, 23_admin_catalogue):** any function that locks or updates several
  `inventory` rows in one transaction must do it in `(product_id, variant_id)` order, like
  `place_order` and the cancellation, to stay deadlock-free.

---

## 12_leads.sql — newsletter, contact inquiries, suppression list (SQL-REST)

#### `email_suppressions` (SEALED: RLS on, no policy, no privileges for anon or authenticated — admins included)

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `email` | text | NOT NULL (PK part) | | lower-cased + trimmed (CHECK `email_suppressions_email_valid`, 3–255) |
| `reason` | text | NOT NULL (PK part) | | `cart_recovery\|newsletter\|all` (`email_suppressions_reason_valid`) |
| `created_at` | timestamptz | NOT NULL | `now()` | |

Keyed on the PERSON: `stop_cart_recovery` (13) writes `cart_recovery`, `unsubscribe_newsletter`
writes `newsletter`; `all` is for the owner in the SQL editor. The recovery claim (13) and
`capture_abandoned_cart` read it. No app code can read it — marketing sends start from
`admin_newsletter_mailing_list()` (below), which applies the check inside the database
(active AND no `newsletter`/`all` suppression).

#### `newsletter_subscribers`

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | integer | NOT NULL (PK) | serial | |
| `email` | text | NOT NULL, unique `newsletter_subscribers_email_key` | | lower-cased + trimmed (`newsletter_subscribers_email_valid`, 3–255) |
| `source` | text | NOT NULL | `'footer'` | 1–50 chars (`newsletter_subscribers_source_valid`); the FIRST capture point is kept |
| `unsubscribe_token` | uuid | NOT NULL, unique | `gen_random_uuid()` | the `/newsletter/unsubscribe?token=` credential |
| `confirmed_at` | timestamptz | yes | | reserved for a double opt-in flow (nothing sets it today) |
| `unsubscribed_at` | timestamptz | yes | | NULL = subscribed |
| `created_at` | timestamptz | NOT NULL | `now()` | |

#### `contact_inquiries`

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | uuid | NOT NULL (PK) | `gen_random_uuid()` | |
| `name` | text | NOT NULL | | 1–255 |
| `email` | text | NOT NULL | | lower-cased by the RPC, 3–255 |
| `subject` | text | NOT NULL | | 1–255 |
| `message` | text | NOT NULL | | ≤ 5000 (the RPC requires 15–5000) |
| `status` | text | NOT NULL | `'new'` | `new\|answered` (`contact_inquiries_status_valid`) |
| `answered_at` | timestamptz | yes | | set by the reply route |
| `admin_reply` | text | yes | | ≤ 10000; the text that was emailed (NULL when answered by phone) |
| `replied_by` | text | yes | | ≤ 255; the admin's email |
| `created_at` | timestamptz | NOT NULL | `now()` | |

Constraint names: `contact_inquiries_status_valid`, `contact_inquiries_text_lengths`.

**RLS per verb**

| table | anon | shopper | admin |
| --- | --- | --- | --- |
| `email_suppressions` | ✗ no privilege (42501) | ✗ no privilege (42501) | ✗ no privilege (42501) |
| `newsletter_subscribers` | ✗ no privilege (42501) | SELECT 0 rows · UPDATE/DELETE 0 rows · INSERT 42501 | ALL (`newsletter_admin_all`) |
| `contact_inquiries` | ✗ no privilege (42501) | SELECT 0 rows · UPDATE/DELETE 0 rows · INSERT 42501 | ALL — all four verbs (`contact_inquiries_admin_all`) |

| Signature | Grant | Returns | Contract |
| --- | --- | --- | --- |
| `subscribe_newsletter(p_email text, p_source text DEFAULT 'footer')` | **A** | boolean | lower-cases/trims the email; not `x@y.z` (or > 255) → **FALSE** (nothing stored); otherwise upsert and **TRUE for new AND existing addresses** (no enumeration). `source` = trimmed `p_source` cut to 50, blank/NULL → `footer`; an existing subscriber keeps its first source. An explicit signup re-activates an unsubscribed address (`unsubscribed_at = NULL`) and deletes its `newsletter` suppression (fresh consent). Never raises |
| `unsubscribe_newsletter(p_token uuid)` | **A** | boolean | sets `unsubscribed_at` (the first time is kept) and adds a `newsletter` suppression; **always TRUE** (unknown/NULL tokens too). Never raises for a UUID (a non-UUID string is `22P02` before the function runs — validate with `isUuid`) |
| `admin_newsletter_mailing_list()` | **U** (admin re-checked → `42501 not_authorised:…`) | jsonb | the marketing list for the Subscribers tab's CSV: `[{email, source, created_at, confirmed_at, unsubscribe_token}]` oldest first, `[]` when empty — only subscribers with `unsubscribed_at IS NULL` and **no** `newsletter`/`all` suppression (blueprint §9.11 "check email_suppressions before any marketing send"; the suppression list stays sealed). The token is for each email's `/newsletter/unsubscribe?token=` link |
| `submit_contact_inquiry(p_name text, p_email text, p_subject text, p_message text)` | **A** | void (`data` is `null`) | trims all four, lower-cases the email; checks **in this order** (P0001): `invalid_name` (not 1–255) → `invalid_email` → `invalid_subject` (not 1–255) → `invalid_message` (not 15–5000); inserts `status 'new'` |

Routes (WP-E, as built):
- `POST /api/newsletter { email, source, company }` (64 KB, honeypot → the same `{ ok: true }`,
  10/h per IP) → `rpc('subscribe_newsletter', { p_email, p_source })`: `data === false` → 422
  "Please enter a valid email address."; `true` → `{ ok: true }` for new and existing addresses.
  The route accepts `source` ∈ `home`, `footer`, `assistant` (anything else → `footer`, the SQL
  default); `finder` is set by 14. Nothing is emailed on signup.
- `POST /api/newsletter/unsubscribe { token }` (20/10 min per IP) → `rpc('unsubscribe_newsletter', { p_token })`;
  `{ ok: true }` for every token (a malformed one gets it without calling). The page
  `/newsletter/unsubscribe?token=` asks first, then posts.
- `POST /api/contact { name, email, subject, message, company }` (64 KB, honeypot → fake success,
  3/h per IP) → `submit_contact_inquiry`; error map: `invalid_name` 422 "Please enter your name." ·
  `invalid_email` 422 "Please enter a valid email address." · `invalid_subject` 422 "Please add a
  subject." · `invalid_message` 422 "Messages need 15 to 5,000 characters." (each with `field`).
  Then the owner alert email (fail-soft).
- `POST /api/admin/inquiry-reply { id, mode: 'email', reply } | { id, mode: 'phone' }` (same-origin +
  admin, session client, admin RLS): email mode SENDS FIRST (to the stored address), then
  `update({ status: 'answered', answered_at, admin_reply: reply, replied_by: admin.email }).eq('id', id).select(…)`;
  send failed → 502, inquiry untouched; sent but 0 rows/error → 200 `{ ok, emailed, warning }`.
  Phone mode = the same update with `admin_reply: null`, guarded by `.eq('status', 'new')` (0 rows → 409).
  Replying to an answered inquiry → 409. Nothing sets `answered_at` automatically.
- Subscribers tab: `from('newsletter_subscribers').select('*', { count: 'exact' })` paginated;
  counts by source → `admin_newsletter_growth(30)` (17); CSV = `rpc('admin_newsletter_mailing_list')`.
- Inquiries tab: `from('contact_inquiries')` paginated by status; delete = `deleteRows` (admin RLS)
  behind a confirmation; answering only through the route above.

---

## 13_abandoned_carts.sql — checkout autosave + three-stage recovery (SQL-REST)

#### `abandoned_carts` (admin only; anon no privilege)

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | uuid | NOT NULL (PK) | | the browser's per-session checkout id (`useCheckoutAutosave().cartId`) |
| `email` | text | NOT NULL | | lower-cased + trimmed (`abandoned_carts_email_valid`) |
| `first_name`, `last_name` | text | yes | | ≤ 255, blank → NULL |
| `phone` | text | yes | | ≤ 50, as typed (not normalised) |
| `shipping_address` | jsonb | yes | | sanitised object: only `street` (≤ 500), `city` (≤ 120), `district` (canonical of the 25, else dropped), `postal_code` (≤ 20), `country` (≤ 80); NULL when nothing usable |
| `cart_items` | jsonb | NOT NULL (array) | `'[]'` | `[{product_id, variant_id, quantity, name, variant_name, price, image}]` — **re-read from the catalogue at capture** |
| `total_price` | numeric(12,2) | NOT NULL | `0` | LKR Σ `price × quantity` of `cart_items` |
| `currency` | text | NOT NULL | `'LKR'` | display currency (one of the 7), record only |
| `exchange_rate` | numeric(14,6) | NOT NULL | `1` | record only |
| `converted` | boolean | NOT NULL | `false` | set by `place_order` |
| `converted_order_id` | text | yes (FK → orders ON DELETE SET NULL) | | |
| `recovery_stage` | smallint | NOT NULL | `0` | 0 = nothing sent; N = reminder N claimed (0–9) |
| `last_recovery_at` | timestamptz | yes | | |
| `recovery_token` | uuid | NOT NULL, unique | `gen_random_uuid()` | `/recover?token=` and `/recover/stop?token=` |
| `recovery_opted_out` | boolean | NOT NULL | `false` | |
| `created_at` | timestamptz | NOT NULL | `now()` | |
| `updated_at` | timestamptz | NOT NULL | `now()` | = the abandonment time; moved only by an autosave or the conversion (**no touch trigger**; the claim never touches it) |

Constraint names: `abandoned_carts_email_valid`, `abandoned_carts_items_array`,
`abandoned_carts_shipping_object`, `abandoned_carts_money_valid`, `abandoned_carts_currency_valid`,
`abandoned_carts_stage_valid`, `abandoned_carts_text_lengths`.
**RLS**: anon ✗ no privilege; shopper SELECT/UPDATE/DELETE 0 rows, INSERT 42501; admin ALL
(`abandoned_carts_admin_all`). One-time grandfathering (marker `app_config.cart_recovery_backfilled_at`)
opted out every cart that existed when 13 was first applied — never a consent signal.

| Signature | Grant | Returns | Contract |
| --- | --- | --- | --- |
| `capture_abandoned_cart(p_id uuid, p_email text, p_first_name text, p_last_name text, p_phone text, p_shipping jsonb, p_cart_items jsonb, p_total numeric, p_currency text DEFAULT 'LKR', p_exchange_rate numeric DEFAULT 1)` | **A** | uuid (always `p_id`) | see below |
| `claim_abandoned_carts_for_recovery(p_secret text, p_stage smallint, p_min_age_minutes int, p_min_gap_minutes int, p_max_age_hours int, p_limit int)` | **A** + secret `cart_recovery` | jsonb array | see below |
| `release_abandoned_cart_recovery(p_secret text, p_id uuid, p_stage smallint)` | **A** + secret `cart_recovery` | boolean | rewinds the cart to `p_stage − 1` and clears `last_recovery_at` **only if** it is still at `p_stage`; TRUE = released, FALSE = nothing to release (also NULL id / stage outside 1–9). P0001 `unauthorized` |
| `get_recovery_cart(p_token uuid)` | **A** | jsonb | `{"found": false}` or `{"found": true, "converted", "first_name", "cart_items", "opted_out"}` — **never** the email, address or phone |
| `stop_cart_recovery(p_token uuid)` | **A** | boolean | adds a `cart_recovery` suppression for the cart's (lower-cased) email and opts out **every** cart of that address; **always TRUE** (unknown/NULL tokens too) |

**`capture_abandoned_cart`** — the autosave (2 s debounce, best-effort):
- `p_cart_items` = the place_order line shape `[{product_id, variant_id, quantity}]` (other keys are
  ignored). Each line is re-read from the catalogue: kept only when the product is visible (active,
  ≥ 1 active variant) and the variant is active and belongs to it; repeats of one variant are merged;
  quantity capped at 10; lines with quantity < 1 or malformed ids dropped. Names, variant names,
  prices and images in the stored snapshot come from the DATABASE (P4). `total_price` is computed —
  **`p_total` is ignored** (kept for the blueprint signature).
- Email-guarded upsert on `p_id`: a different address, or a converted cart, is never overwritten
  (the call still answers the id). A later autosave never clears `recovery_opted_out`.
- A NEW cart from an address with a `cart_recovery` or `all` suppression is born opted out.
- ≤ 25 open (unconverted) carts per address: the 26th NEW id → `too_many_carts`; autosaves of an
  existing cart are always allowed.
- Currency not in `LKR, USD, GBP, EUR, AUD, INR, AED`, or a rate outside (0, 1000] → stored as LKR / 1.
- Errors (P0001): `invalid_input` (NULL id; email not `x@y.z` or > 255; items NULL / not an array /
  > 50 lines) · `too_many_carts`. The route answers `{ ok: false }` silently on any error.
- Route (`/api/abandoned-cart`, WP-E): body = `{ id: cartId, email, firstName, lastName, phone, shipping, items, subtotal, currency, exchangeRate }`
  → `rpc('capture_abandoned_cart', { p_id: id, p_email: email, p_first_name, p_last_name, p_phone, p_shipping: shipping, p_cart_items: items.map(i => ({ product_id: i.productId, variant_id: i.variantId, quantity: i.qty })), p_total: subtotal, p_currency: currency, p_exchange_rate: exchangeRate })`.
  Only call once the draft has a valid email and `id` is a UUID (`""` during hydration).
  Checkout sends the same `cartId` as `p_abandoned_cart_id` to `place_order`, which marks the row
  converted (only when the order's email matches) — verified by 13's and 98's tests.
  As built (WP-E): 64 KB, 60/10 min per IP, answer `{ ok }` only (422 invalid_input, 429
  too_many_carts/limit, 503 migration). `useCheckoutAutosave` (2 s debounce, flushed on unmount /
  tab hidden) never creates an empty cart, sends no address for pickup, and — because the id is
  bound to the FIRST address saved — handles an email correction by emptying the old cart (an empty
  cart is never claimed) and continuing on a fresh id (the one checkout then sends to place_order).

**`claim_abandoned_carts_for_recovery`** — the hourly job (`POST /api/cart-recovery`, bearer
`CART_RECOVERY_SECRET` = `app_config.cart_recovery`):
- Clamps: `p_stage` 1..9 (else P0001 `invalid_stage`), `p_limit` 1..200 (NULL → 25),
  `p_min_age_minutes` 0..43200 (NULL → 60), `p_min_gap_minutes` 0..43200 (NULL → 60),
  `p_max_age_hours` 1..8760 (NULL → 336). Wrong/short/missing secret or no app_config row → P0001
  `unauthorized`.
- A cart is due for stage N when: not converted; not opted out; at stage N−1; `updated_at` at least
  `min_age` minutes and at most `max_age` hours ago; `last_recovery_at` NULL or ≥ `min_gap` minutes
  ago; a real address; `total_price > 0` and ≥ 1 line; the address is not suppressed
  (`cart_recovery`/`all`); **no order** from that address created since 1 hour before the
  abandonment; **no later cart** from that address (one reminder per person, about the most recent
  cart). Oldest due first, up to `p_limit`.
- The claim stamps `recovery_stage = N`, `last_recovery_at = now()` in the same statement (exclusive:
  a concurrent or repeated claim gets nothing; a cart converted meanwhile is skipped) and never
  touches `updated_at`.
- Returns `[{"id", "email", "first_name", "last_name", "token", "cart_items", "total_price", "currency", "abandoned_at"}]`
  (oldest first; `[]` when nothing is due) — never the phone or address. Send, and on a failed
  send call `release_abandoned_cart_recovery(p_secret, id, N)`. `more = (claimed.length === limit)`.
- Stage timing lives in `src/lib/cart-recovery.ts` (60 / 1440 / 4320 minutes, max age 336 h,
  batch 20, concurrency 3); the DB only stores which stage a cart reached.
- Emails: the stored `cart_items` names/prices/images are catalogue values at capture time; the
  `/recover` page still re-reads the live catalogue (prices may have changed) and restores ITEMS only.

Admin tab: `from('abandoned_carts').select('*', { count: 'exact' }).order('updated_at', { ascending: false }).range(…)`;
show `recovery_stage` as "N of 3 sent", `recovery_opted_out`, `converted`. "Send due reminders" →
`adminApi('/api/cart-recovery')` (admin session). Recovery figures → `admin_recovery_stats` (17).

Job route as built (WP-E, `POST /api/cart-recovery`, `dynamic = "force-dynamic"`; schedule in
`docs/build/JOBS.md`): 503 unless `CART_RECOVERY_SECRET` (≥ 20) and email are configured — before
any DB work; bearer compared in constant time, else same-origin admin session, else 401; per stage
`claim(p_secret, N, p_min_age_minutes = afterMinutes(N) | ?minAgeMinutes, p_min_gap_minutes =
minGapMinutes(N) (60 / 1380 / 2880), p_max_age_hours = 336, p_limit = 20)`; sends 3 at a time;
`release(…)` on a failed send (an address the provider can't take, or a row the email can't be
built from, is counted failed and NOT released — retrying can't fix it); answers `{ ok, stages: [{ stage, claimed, sent, failed, more }] }`; P0001 `unauthorized`
from the claim → 503 `secret_mismatch`. `?stage=` / `?minAgeMinutes=` only with the bearer secret.
Restore/stop: `/recover?token=` (server: `get_recovery_cart` + live catalogue; island merges items
into the bag, never the address) · `/recover/stop?token=` asks, then `POST /api/cart-recovery/unsubscribe
{ token }` (20/10 min per IP) → `stop_cart_recovery`, `{ ok: true }` for every token.

---

## 14_finder.sql — guided finder capture + insights (SQL-REST; WP-F)

#### `finder_responses` (admin only; anon no privilege)

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | NOT NULL (PK) | bigserial | |
| `session_id` | uuid | yes | | unique when not NULL (**partial** index `finder_responses_session_key`) |
| `customer_id` | uuid | yes (FK → customers ON DELETE SET NULL) | | only the caller's own account |
| `email` | text | yes | | lower-cased (`finder_responses_email_valid`) |
| `answers` | jsonb | NOT NULL (object) | `'{}'` | route-allowlisted `{category, use?, budget?, portability?, avoid: [...]}` (see below) |
| `recommended_product_ids` | integer[] | NOT NULL | `'{}'` | ≤ 12, no NULLs (`finder_responses_ids_valid`); the route stores the ≤ 3 picks it re-derived |
| `profile` | jsonb | NOT NULL (object) | `'{}'` | `{axis: number 0..10}` ≤ 20 keys; the route sends only `performance, portability, battery, value, weight` |
| `created_at` / `updated_at` | timestamptz | NOT NULL | `now()` | `updated_at` moves on every upsert |

**RLS**: anon ✗ no privilege; shopper 0 rows (not even their own) / INSERT 42501; admin ALL.

| Signature | Grant | Returns | Contract |
| --- | --- | --- | --- |
| `record_finder_response(p_session_id uuid, p_answers jsonb, p_email text DEFAULT NULL, p_recommended int[] DEFAULT NULL, p_profile jsonb DEFAULT NULL, p_customer_id uuid DEFAULT NULL)` | **A** | void | see below |
| `admin_finder_insights(p_days int DEFAULT 30)` | **U** (admin re-checked inside) | jsonb | see below |

**`record_finder_response`**
- One row per `p_session_id` (`ON CONFLICT (session_id) WHERE session_id IS NOT NULL`): a later call
  replaces `answers`, `recommended_product_ids`, `profile`; `email` and `customer_id` are never
  blanked by a later call without them (COALESCE).
- Size clamps (the ROUTE allowlists answers against `QUESTIONS`): answers must be an object with
  ≤ 20 keys and ≤ 8 KB; ≤ 12 picks (NULL and non-positive ids dropped, order kept); profile keeps
  ≤ 20 entries whose key matches `^[a-z][a-z0-9_]{0,39}$` and whose value is a JSON number, clamped
  0..10 (2 dp) — anything else is dropped, a non-object profile → `{}`.
- `p_email`: lower-cased; invalid → ignored. A valid email is **subscribed to the newsletter with
  source `finder`** (via `subscribe_newsletter`, which re-activates an address that had
  unsubscribed — the "email me my picks" form says it also subscribes). The blueprint's
  §9.14 step 8 names the source `quiz`, Appendix A 11 / §7.5 name it `finder`; the SQL uses
  **`finder`**, so the route does NOT call `subscribe_newsletter` itself.
- **`p_customer_id` is attached only when it equals `auth.uid()` of the caller** (and has a customers
  row): call with the **session** client (`createSessionSupabase()`) and pass `user.id` (or NULL).
  An id sent with the anon key, or someone else's id, is ignored (stricter than the blueprint's "if
  the account exists": account ids are identifiers, never credentials — see 11's note).
- Errors (P0001): `invalid_session` (NULL) · `invalid_answers` · `invalid_recommendations`.

**Stored `answers` shape** (written only by `POST /api/quiz`, allowlisted by `parseAnswers` in
`src/lib/quiz.ts`): `category` = a category id with finder-eligible products; `use` ∈
`everyday|gaming|creative|mobile|backup|ergonomic`; `budget` ∈ `entry|mid|premium|any`;
`portability` ∈ `light|any`; `avoid` = array of `wired`, `heavy`, `brand:<Brand>` (catalogue
spelling). Questions the finder didn't ask for that category (its stock can't honour them) are
absent. `none` is never stored (an empty `avoid` means nothing avoided).

**`admin_finder_insights(p_days)`** — the admin Finder insights tab (blueprint §11.2). 42501
`not_authorised:…` for anyone but an admin (anon has no EXECUTE → 42501 too). Window = responses whose
LATEST submission (`updated_at`) falls in the last `p_days` business days including today
(Asia/Colombo via 17's `_business_window_start` — resolved at call time, so the chain must be applied
through 17); `p_days` clamped 1..365 (NULL → 30). One row = one finder session. Returns:
```json
{
  "days": 30, "since": "…", "timezone": "Asia/Colombo",
  "responses": 60, "with_email": 17, "signed_in": 0, "short": 13, "empty": 0,
  "categories": [{ "category": "laptops", "responses": 29, "short": 4, "empty": 0 }],
  "answers":    [{ "category": "laptops", "question": "use", "value": "gaming", "count": 9 }],
  "gaps":       [{ "category": "mice", "use": "ergonomic", "budget": "premium", "portability": null,
                   "avoid": ["wired"], "picks": 2, "count": 2 }]
}
```
`short` = fewer than 3 picks, `empty` = none; `answers` covers `use`, `budget`, `portability` (single)
and `avoid` (each token counted); `gaps` = ≤ 25 answer sets that got fewer than 3 picks, most asked
first. Values are cut to 80 characters. Test: 14_finder.test.sql (53 checks).

Routes / UI (WP-F):
- `POST /api/quiz` `{ sessionId, answers, email?, company }` → 64 KB cap → honeypot (fake success,
  `{ok:true, emailed:true}` when an email was sent) → 20/h per IP (`quiz:ip:<hmac>`) → `isUuid`,
  `parseAnswers` against `fetchCatalogueForFinder()`, email shape (and 503 when email isn't
  configured — no address is collected for a promise that can't be kept) → picks + profile
  RE-DERIVED server-side (`recommend()` / `profileFor()`; nothing from the body but the answers) →
  `rpc('record_finder_response', { p_session_id, p_answers, p_email, p_recommended, p_profile, p_customer_id })`
  with the SESSION client → `invalid_*` 422, missing function 503 (logs `14_finder.sql`) → the results
  email (fail-soft) → `{ ok: true }` / `{ ok: true, emailed }`.
- Finder insights tab: `supabase.rpc('admin_finder_insights', { p_days })` (7 / 30 / 90) + `categories`
  names.

## 15_content_pages.sql — CMS pages and blog posts (SQL-REST; owned by WP-G)

Reviewed by WP-G against `lib/cms.ts` and the admin Content tab: the schema is unchanged (every
column the TypeScript names exists here); the test now starts from empty tables (seed 33 publishes
`privacy`) and also covers the queries the storefront and the tab run.

#### `cms_pages`

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | integer | NOT NULL (PK) | serial | |
| `slug` | text | NOT NULL, unique `cms_pages_slug_key` | | `^[a-z0-9][a-z0-9-]*$`, ≤ 120 (`cms_pages_slug_format`) — `privacy`, `terms`, `returns`, others at `/pages/<slug>` |
| `title` | text | NOT NULL | | 1–200 after trim |
| `summary` | text | yes | | ≤ 500 |
| `content` | text | NOT NULL | | ≤ 200 000; as authored — **sanitise on render** |
| `cover_image` | text | yes | | `/path` or `https://…`, ≤ 1000 |
| `seo_title` / `seo_description` | text | yes | | ≤ 120 / ≤ 320 |
| `is_published` | boolean | NOT NULL | `false` | |
| `show_in_footer` | boolean | NOT NULL | `false` | requires `footer_group` (`cms_pages_footer_needs_group`) |
| `footer_group` | text | yes | | `customer_service\|company\|legal` (`cms_pages_footer_group_valid`) |
| `sort_order` | integer | NOT NULL | `100` | order within the footer column |
| `created_at` / `updated_at` | timestamptz | NOT NULL | `now()` | touch trigger |

#### `blog_posts`

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | integer | NOT NULL (PK) | serial | |
| `slug` | text | NOT NULL, unique `blog_posts_slug_key` | | same format (`blog_posts_slug_format`) → `/blogs/<slug>` |
| `title` | text | NOT NULL | | 1–200 |
| `summary` | text | yes | | ≤ 500 |
| `content` | text | NOT NULL | | ≤ 200 000; sanitise on render |
| `cover_image` | text | yes | | `/path` or `https://…` |
| `author` | text | yes | | ≤ 120 |
| `tags` | text[] | NOT NULL | `'{}'` | ≤ 20, each 1–40 chars, no NULL/empty (`blog_posts_tags_valid`) |
| `published_at` | timestamptz | yes | | **set to `now()` by trigger when a post is published without a date**; kept on unpublish/republish |
| `is_published` | boolean | NOT NULL | `false` | |
| `seo_title` / `seo_description` | text | yes | | ≤ 120 / ≤ 320 |
| `created_at` / `updated_at` | timestamptz | NOT NULL | `now()` | touch trigger |

Constraint names also: `cms_pages_text_lengths`, `blog_posts_text_lengths` (lengths + cover URL).
Trigger `blog_posts_10_publish_date` (function `blog_posts_publish_date()`, no grants).

**RLS per verb (both tables)**: anon/shopper SELECT **only `is_published` rows** (drafts are
invisible — a real 404); anon has no INSERT/UPDATE/DELETE privilege (42501); shopper writes 0 rows /
INSERT 42501; admin ALL.

**As built (WP-G)** — storefront reads, `src/lib/cms.ts` (server-only, stateless anon client,
cached under tag `content`; every query ALSO filters `is_published` so the intent survives a
policy change):
- `getPage(slug)` → `from('cms_pages').select('slug, title, summary, content, cover_image, seo_title, seo_description, footer_group, created_at, updated_at').eq('slug', slug).eq('is_published', true).maybeSingle()`
  → `CmsPage | null`; `getPost(slug)` → `from('blog_posts').select('slug, title, summary, cover_image, author, tags, published_at, updated_at, content, seo_title, seo_description, created_at').eq('slug', slug).eq('is_published', true).maybeSingle()`.
  `null` = no such published row → `notFound()` (a real 404). A **failed** read throws (route error
  boundary; ISR keeps the last good render) — except during `next build`, where it yields `null` so
  an unreachable database never fails a build. Slugs failing `^[a-z0-9][a-z0-9-]*$`/≤ 120 never query.
- `listPosts({ page })` → `from('blog_posts').select('slug, title, summary, cover_image, author, tags, published_at, updated_at', { count: 'exact' }).eq('is_published', true).order('published_at', { ascending: false }).order('id', { ascending: false }).range(…)`,
  12 per page (`BLOG_PAGE_SIZE`, pages 1..500). A page past the end (`PGRST103`) → a head count and
  an empty page with the real total. Fails soft with `failed: true` (the page says "couldn't load",
  never "no posts yet").
- Content is Markdown-lite **as authored**; pages render it with `renderMarkdown()`
  (`src/lib/markdown.ts`), which always runs the allowlist sanitiser (`src/lib/sanitize.ts`,
  blueprint §6.6). Cover images pass `safeImageUrl` (site path or our storage) before `next/image`.
- Routes: `privacy`, `terms`, `returns` → `/privacy`, `/terms`, `/returns`; any other page →
  `/pages/<slug>` (`/pages/privacy` etc. 308 to the dedicated route); posts → `/blogs/<slug>`.
  `cmsPageHref(slug)` / `blogPostHref(slug)` / `CMS_ROUTE_SLUGS` in
  `src/components/content/cms-shared.ts` (plain module; re-exported by `lib/cms.ts`).

Footer (WP-B): `from('cms_pages').select('slug, title, footer_group, sort_order').eq('show_in_footer', true).order('footer_group').order('sort_order')`
(published rows only via RLS — add `.eq('is_published', true)` too); link with `cmsPageHref(slug)`.

Admin (WP-G, `src/components/admin/tabs/ContentTab.tsx` + `components/admin/content/*`, browser
client under admin RLS, through the kit): list = `select('<list columns — no content>', { count: 'exact' })`
+ `.or(title/slug(/author) ilike)` + optional `.eq('is_published', …)` + `.order(<title|slug|updated_at|sort_order|published_at>, nullsLast).order('id', desc).range()`;
editor = `select('*').eq('id', id).maybeSingle()`; slug hint = `select('id').eq('slug', slug).neq('id', ownId).limit(1)`;
save = `insertRow` / `updateRows(…, { id }, { expect: 1 })` with the saved row read back; quick
"Unpublish" = `updateRows({ is_published: false }, { id }, { expect: 1 })`; delete =
`deleteRows({ id }, { expect: 1 })` behind a ConfirmDialog (type the slug for a published record).
Every write revalidates `content`. Constraint copy: `cms_pages_slug_key` / `blog_posts_slug_key`
(23505) "Another page/post already uses this address (slug)…", `…_slug_format`,
`cms_pages_footer_needs_group`, `cms_pages_footer_group_valid`, `blog_posts_tags_valid`,
`…_text_lengths` (23514). The form validates the same limits first (`CMS_LIMITS`), refuses to
publish empty content, and refuses a future `published_at` (nothing schedules posts). Images:
`content-images/pages/<slug>/…`, `content-images/blog/<slug>/…` (cover + "Insert image"); uploads
the saved record doesn't reference are deleted after the save or on discard.

---

## 33_seed_content_pages.sql — the privacy page TEMPLATE (WP-G; review before launch)

One row, guarded by the `app_config` marker `seed_33_content_pages` and `ON CONFLICT (slug) DO
NOTHING` (an owner's own `privacy` page is never touched; deleting the row and re-running never
brings it back): `cms_pages` `privacy` — title "Privacy policy", a summary, Markdown-lite content,
`is_published = TRUE`, `show_in_footer = TRUE`, `footer_group = 'legal'`, `sort_order = 10`, no
cover or SEO copy. Blueprint §12.1.6: the page lists everything this build collects (§12.2 as
implemented: orders, checkout details saved before submit + up to three reminders, newsletter,
contact messages, finder answers, assistant conversations (redacted; what is sent to OpenAI) and the
order-lookup audit (email domain only), consent-gated analytics, account/profile, saved items,
reviews, hashed abuse-protection records), the retention periods of `22_retention.sql` (§12.5), the
processors actually used (Supabase, Resend, OpenAI, an exchange-rate service with no personal data),
the browser storage keys in use and how to ask for erasure. The business name, postal address,
contact email, hosting provider, order-record retention and "any other service" are `[BRACKETED]`
placeholders; the page opens with a "Template — have it reviewed" note. The self-verifying block
refuses to seed a page that misses any of those disclosures.

NOT seeded (nothing invented): terms, returns (the returns-window setting alone can't state a true
policy and a copy of it would drift from Settings), refund, cookie, about, delivery, warranty,
showroom, careers, corporate pages, blog posts. `/terms` and `/returns` answer 404 and stay out of
the footer until the owner publishes them.

Keep it true: the retention periods hold only once `POST /api/maintenance` runs daily (22's OPS
NOTE); a new form, service or storage key must be added to the page in the same change. Test:
`supabase/tests/33_seed_content_pages.test.sql`.

---

## 16_storefront_content.sql — hero slides, promo tiles, content blocks, best sellers (SQL-REST)

Links everywhere here must be a site path (`/`, `/shop?category=laptops`, `/#flash-deals`) or
`https://…` — never `//host`, `http:`, `javascript:`, `mailto:` or a backslash. Images: `/path`
(first char after `/` not `/`) or `https://…`, ≤ 1000.

#### `hero_slides`

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | integer | NOT NULL (PK) | serial | |
| `image_url` | text | yes | | NULL → render the fallback scene |
| `fallback_scene` | text | NOT NULL | `'paper'` | `night\|paper\|lime\|violet` |
| `tone` | text | NOT NULL | `'light'` | `dark\|light` |
| `background` | text | NOT NULL | — (required) | `#rgb` or `#rrggbb` |
| `chip` | text | yes | | ≤ 40 (e.g. "Grand opening"; also usable as the slider dot's label — there is no separate label column) |
| `eyebrow` | text | yes | | ≤ 80 |
| `title` | text | NOT NULL | | 1–200; plain text with `{lime:…}` / `{violet:…}` spans and line breaks — parse safely, never as HTML |
| `body` | text | yes | | ≤ 500 |
| `cta_label` + `cta_href` | text | yes | | both or neither; label 1–40, href ≤ 500 |
| `secondary_label` + `secondary_href` | text | yes | | both or neither |
| `readout` | text[] | NOT NULL | `'{}'` | ≤ 6 lines × ≤ 40 chars, no NULLs |
| `position` | integer | NOT NULL | `100` | ascending; ties by id (not unique — reorder in one upsert) |
| `is_active` | boolean | NOT NULL | `true` | |
| `starts_at` / `ends_at` | timestamptz | yes | | NULL = open-ended; `ends_at > starts_at` |
| `created_at` / `updated_at` | timestamptz | NOT NULL | `now()` | touch trigger |

Constraint names: `hero_slides_scene_valid`, `hero_slides_tone_valid`, `hero_slides_background_valid`,
`hero_slides_links_valid`, `hero_slides_image_valid`, `hero_slides_schedule_valid`,
`hero_slides_readout_valid`, `hero_slides_text_lengths`.

#### `promo_tiles` (the four bento slots)

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `slot` | smallint | NOT NULL (PK) | | 1–4 (`promo_tiles_slot_valid`); the geometry per slot stays in code; upsert on `slot` |
| `image_url` | text | yes | | |
| `fallback_scene` | text | NOT NULL | `'paper'` | |
| `tone` | text | NOT NULL | `'light'` | |
| `background` | text | NOT NULL | — (required) | hex |
| `eyebrow` | text | yes | | ≤ 40 |
| `title_lines` | text[] | NOT NULL | — (required) | 1–4 lines × ≤ 40 chars, none blank |
| `body` | text | yes | | ≤ 160 |
| `cta_label` | text | yes | | 1–40 |
| `href` | text | NOT NULL | | the whole tile links here |
| `image_position` | text | yes | | a CSS object-position (`85% bottom`, `center 88%`): `^[a-z0-9%. -]{1,40}$` |
| `is_active` | boolean | NOT NULL | `true` | |
| `created_at` / `updated_at` | timestamptz | NOT NULL | `now()` | |

Constraint names: `promo_tiles_slot_valid`, `promo_tiles_scene_valid`, `promo_tiles_tone_valid`,
`promo_tiles_background_valid`, `promo_tiles_href_valid`, `promo_tiles_image_valid`,
`promo_tiles_position_valid`, `promo_tiles_title_valid`, `promo_tiles_text_lengths`, `promo_tiles_pkey` (23505).

#### `content_blocks`

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `key` | text | NOT NULL (PK) | | `^[a-z0-9_]+$`, ≤ 64: `hero_perks`, `trust_row`, `order_your_way`, `store_status`, `testimonial`, `new_arrivals_feature` |
| `data` | jsonb | NOT NULL | `'{}'` | an object or an array, ≤ 32 KB of JSON text (`content_blocks_data_valid`); the per-key shape is validated by `lib/content.ts` (zod) |
| `updated_at` | timestamptz | NOT NULL | `now()` | set by trigger |
| `updated_by` | uuid | yes (FK → customers ON DELETE SET NULL) | | set by trigger to `auth.uid()` (NULL for SQL-editor/seed writes) |

**RLS per verb**: `hero_slides` public SELECT = `is_active AND (starts_at IS NULL OR starts_at <= now()) AND (ends_at IS NULL OR ends_at > now())`
(evaluated when the query runs: a cached page shows a schedule change only after it revalidates);
`promo_tiles` public SELECT = `is_active`; `content_blocks` public SELECT = every row. anon has no
write privilege (42501); shoppers write 0 rows / INSERT 42501; admin ALL on all three.

| Signature | Grant | Returns | Contract |
| --- | --- | --- | --- |
| `get_best_sellers(p_limit int DEFAULT 5, p_days int DEFAULT 90)` | **A** | TABLE `(product_id int, rank int)` — an **array** | visible products only (`is_active AND variant_count > 0`), ranked by units sold (Σ `order_items.quantity` of orders with `status <> 'cancelled'` created in the last `p_days` days, rolling), ties by `sort_order`, `id`; then topped up with `is_bestseller` products that sold nothing in the window, by `sort_order`, `id`; no duplicates; `rank` 1..n. Clamps: `p_limit` 1..24 (NULL → 5), `p_days` 1..365 (NULL → 90). Never returns sales figures; never raises |
| `admin_reorder_hero_slides(p_ids int[])` | **U** (admin re-checked → 42501 `not_authorised:…`) | jsonb `{ids: [...]}` | ONE statement: `position` = 10, 20, 30 … in array order; slides not listed keep theirs. 22023 `invalid_slides:` (NULL/empty, > 100, NULL entry, duplicate) · 22023 `slide_not_found:Slide <ids> no longer exists…` (a slide deleted meanwhile fails the whole reorder — it is never re-created, unlike an upsert) |
| `admin_set_featured_collections(p_ids text[])` | **U** (admin re-checked → 42501) | jsonb `{featured: [...]}` | the homepage row in ONE statement: listed collections → `is_featured = TRUE`, `sort_order` = 10, 20 … in array order; every other featured collection → `is_featured = FALSE` (its `sort_order` kept). `'{}'`/NULL = feature none; an inactive collection may be listed (shown once active). 22023 `invalid_collections:` (> 12, NULL entry, duplicate) · 22023 `collection_not_found:Collection <ids> no longer exists…` |

**`content_blocks.data` shapes** (validated by the zod schemas in `src/components/home/content-model.ts`,
shared by `lib/content.ts`, the storefront and the admin; an invalid block is logged and its section hidden):

| key | shape |
| --- | --- |
| `hero_perks` | `{items: [{icon, title ≤ 40, text ≤ 80, requires?}]}` — 1–4 items; `icon` ∈ `truck shield returns warranty support cod store whatsapp` |
| `trust_row` | `{items: [{icon, title ≤ 60, text ≤ 160, requires?}]}` — 1–6 items; `icon` ∈ `secure delivery returns support warranty` (the animated set) |
| `order_your_way` | `{title ≤ 60, body ≤ 300, items: [{icon, title ≤ 40, text ≤ 80, requires?}] (≤ 4), art?: {top?: slug\|null, bottom?: slug\|null}}` |
| `store_status` | `{rows: [{label ≤ 40, value ≤ 24, level 0–1}] (≤ 6), banner ≤ 60}` |
| `testimonial` | `{quote 10–600, author ≤ 60, detail ≤ 60}` — owner-entered, from a real customer; a featured APPROVED review (11) replaces it; never seeded |
| `new_arrivals_feature` | `{product: slug, title ≤ 60, kicker ≤ 60}` — resolved server-side; a missing/hidden product hides the tile |

`requires` ⊆ `cod | bank_transfer | pickup | whatsapp | phone`: the item shows only while the store
offers it — the same rules as `quote_order`'s flags (`cod_enabled`; bank transfer enabled **and**
its account name, bank and number set; pickup enabled **and** address set) and a WhatsApp / phone number with ≥ 7 digits.
Text fields are plain text with a safe mini-markup (never HTML): `{lime:…}` / `{violet:…}` spans, line
breaks (a newline or the two characters `\n`), `Rs. 12,900`-style prices rendered through `<Price>`, and
two settings placeholders — `{free_delivery_threshold}` (hidden while `free_delivery_threshold` is NULL)
and `{returns_window_days}` (hidden while it is 0). The same text rules apply to `store_settings.ticker_items`
and `announcement`.

Reads (WP-B `src/lib/content.ts`, anon client — as built): `from('hero_slides').select('*').order('position').order('id')`
(tag `content`, revalidate 120 s so schedules apply within ~2 minutes; re-filtered to the window at render
time); `from('promo_tiles').select('*').order('slot')`; `from('content_blocks').select('key, data')` (tag
`content`); `rpc('get_best_sellers', { p_limit: 5 })` (tag `catalogue`, revalidate 120 s) → ids in `rank`
order → `getProductsByIds`; featured review = `product_reviews.select('author_name, rating, title, body,
is_verified_purchase, created_at').eq('status','approved').eq('is_featured',true)` newest first, limit 1
(tag `reviews`); store-wide rating = five `head: true` exact counts of approved reviews per star (no rows
transferred; tag `reviews`); footer = `cms_pages.select('slug, title, show_in_footer, footer_group,
sort_order').eq('is_published', true).or('show_in_footer.eq.true,slug.in.(privacy,terms,returns,store-locator)')`
+ a `head: true` count of published `blog_posts` (tag `content`).
Admin writes (Homepage tab, `src/components/admin/homepage/*`): slides `insertRow/updateRows/deleteRows`
and the reorder through **`admin_reorder_hero_slides`** (one call); tiles `upsertRows(…, { onConflict: 'slot' })`
(the columns listed above, never `created_at`/`updated_at`), clear = `deleteRows({slot})`; blocks
`upsertRows({key, data}, { onConflict: 'key' })`, remove = `deleteRows({key})` — all revalidate `content`;
featured row through **`admin_set_featured_collections`** (revalidates `catalogue`); flash-deal flags
`updateRows('products', { is_flash_deal }, { id })` (revalidates `catalogue`).

---

## 17_analytics.sql — event log, track_event, dashboard aggregates (SQL-REST)

#### `analytics_events` (written only by `track_event`)

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | bigint | NOT NULL (PK) | bigserial | |
| `event_type` | text | NOT NULL | | CHECK `analytics_events_type_valid`: exactly `page_view, product_view, category_view, collection_view, search, add_to_cart, remove_from_cart, begin_checkout, wishlist_add, finder_complete, assistant_open, newsletter_signup` (= `EVENT_TYPES` in `src/lib/analytics.ts`) |
| `session_id` | uuid | NOT NULL | | the browser's analytics session |
| `customer_id` | uuid | yes | | `auth.uid()` (no FK) |
| `product_id` | integer | yes | | no FK |
| `value` | numeric(12,2) | yes | | LKR for commerce events; the result count for `search` |
| `page` | text | yes | | path only |
| `metadata` | jsonb | NOT NULL (object) | `'{}'` | ≤ 2 KB |
| `created_at` | timestamptz | NOT NULL | `now()` | |

**RLS**: anon ✗ no privilege; authenticated SELECT only (admins see all rows, shoppers 0 rows);
nobody inserts/updates/deletes through the API (not even admins: 42501).

| Signature | Grant | Returns |
| --- | --- | --- |
| `track_event(p_session_id uuid, p_event_type text, p_product_id int DEFAULT NULL, p_value numeric DEFAULT NULL, p_page text DEFAULT NULL, p_metadata jsonb DEFAULT NULL)` | **A** | void — **never raises** |
| `admin_sales_overview(p_from date DEFAULT NULL, p_to date DEFAULT NULL)` | **U** (admin re-checked → 42501) | jsonb |
| `admin_funnel(p_days int DEFAULT 30)` | **U** | jsonb |
| `admin_top_products(p_days int DEFAULT 30, p_limit int DEFAULT 10)` | **U** | jsonb |
| `admin_search_terms(p_days int DEFAULT 30, p_limit int DEFAULT 20)` | **U** | jsonb |
| `admin_low_stock(p_limit int DEFAULT 50)` | **U** | jsonb |
| `admin_recovery_stats(p_days int DEFAULT 30)` | **U** | jsonb |
| `admin_newsletter_growth(p_days int DEFAULT 30)` | **U** | jsonb |
| `admin_order_status_counts()` | **U** | jsonb |
| `_business_tz()` → `'Asia/Colombo'`, `_business_window_start(p_days int)` → timestamptz | — (internal; reused by 19/21) | |

**`track_event`** (route `/api/events`: 8 KB cap, UUID + `isEventType` check, **session client** so
signed-in shoppers attach, always 204): unknown types and NULL sessions are dropped before any
throttle; 300 events per session per hour and 50 000 per hour store-wide (then dropped);
`product_id` kept when > 0; `value` kept when 0..100 000 000 (2 dp); `page` loses its query string
and fragment, ≤ 200; `metadata` kept when an object ≤ 2 KB. Send `search` as
`track("search", { value: resultCount, metadata: { query, results: resultCount } })`.

As built (WP-H):
- **Client** `src/lib/analytics.ts` (plain module, window-guarded; `/api/events` imports the same
  `EVENT_TYPES`/`isEventType`): `track()` sends nothing until the shopper chose "Allow analytics" in
  the ConsentBanner (localStorage `dockone.consent.v1` = `"analytics"` | `"essential"`); the session id
  lives in localStorage `dockone.analytics.v1` (`{id, last}`), is created only after consent, rotates
  after 30 min idle, is deleted when consent is withdrawn and rotated on `dockone:signed-out`.
  Transport: `navigator.sendBeacon` (JSON blob), fallback `fetch(..., { keepalive: true })`; a payload
  over 8 KB drops its metadata. `page_view` comes from `PageViewTracker` (path only, on route change).
- **Route** `POST /api/events` body `{ sessionId, type, page?, productId?, value?, metadata? }`: refuses
  cross-origin browsers (still 204), cleans `page` (path only, must start with `/`), keeps ≤ 20
  metadata keys (`^[A-Za-z][A-Za-z0-9_]{0,39}$`) with scalar values (strings ≤ 200), and replaces
  emails / `DO-` order numbers / phone-like numbers in `page` and text metadata with `[email]` /
  `[order]` / `[number]` (a TS mirror of 19's `redact_pii`) before calling `track_event`.
- **Dashboard tab** (`components/admin/tabs/DashboardTab.tsx`): date presets Today / 7D / 30D / 90D
  (Colombo days) → `admin_sales_overview(p_from, p_to)` with the preset's days and every `p_days`
  aggregate with the same day count; `admin_low_stock(10)` and `admin_order_status_counts()` are
  "right now" / all time and labelled so; the "stock this" list merges `admin_search_terms(p_days,
  20).zero_results` with `admin_assistant_overview(p_days).zero_result_terms` by normalised term (19
  missing → site searches only, with a note). One banner when 17 is missing.
- **Reports tab**: `admin_sales_overview(from, to)` for the summary (ranges clamped to 366 days so the
  summary always covers the exported range); exports page through `orders` (`select('*,
  order_items(count)', { count: 'exact' })`) and `order_items` (`select('*, orders!inner(id,
  created_at, status, fulfillment)')` filtered on `orders.created_at`) until the exact count is
  reached — verified through a real PostgREST with `db-max-rows = 7`.

**Admin aggregates** — every one raises `42501 not_authorised:<text>` for non-admins (anon has no
EXECUTE). Windows (`p_days`, clamped 1..365, NULL → 30) = the last `p_days` **business days in
Asia/Colombo including today** (from local midnight `p_days − 1` days ago). Metric definitions are
in the migration header (revenue = Σ `total_price` of non-cancelled orders, packing charges never
included; AOV = revenue / orders; open = not delivered and not cancelled; funnel = distinct
sessions per step + non-cancelled orders; zero-result search = `metadata.results` (or `value`) = 0).

- `admin_sales_overview(p_from, p_to)` — inclusive business-day range; NULL `p_to` → today, NULL
  `p_from` → `p_to − 29`; reversed dates swapped; > 366 days keeps the last 366; dates clamped to
  2000-01-01..2999-12-31 →
  `{"from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "timezone": "Asia/Colombo", "currency": "LKR", "revenue": 6000.00, "orders": 3, "aov": 2000.00, "cancelled": 1, "daily": [{"day": "YYYY-MM-DD", "orders": 1, "revenue": 2000.00}, …]}`
  (`daily` has one entry per day of the range, zeros included).
- `admin_funnel(p_days)` → `{"days", "since", "timezone", "sessions", "product_view", "add_to_cart", "begin_checkout", "orders"}`.
- `admin_top_products(p_days, p_limit)` (`p_limit` 1..50, NULL → 10) →
  `{"days", "since", "top_viewed": [{"product_id", "slug", "name", "brand", "views", "units_sold"}], "top_sold": [{"product_id", "slug", "name", "brand", "units_sold", "views"}]}`
  (`slug/name/brand` NULL for a deleted product).
- `admin_search_terms(p_days, p_limit)` (`p_limit` 1..100, NULL → 20) →
  `{"days", "since", "total_searches", "zero_result_searches", "top": [{"term", "searches", "zero_results"}], "zero_results": [{"term", "searches"}]}`
  (terms lower-cased, trimmed, whitespace collapsed, ≤ 100; blank ignored). For the "stock this"
  list also show `admin_assistant_overview().zero_result_terms` (19).
- `admin_low_stock(p_limit)` (1..500, NULL → 50) →
  `{"total", "items": [{"product_id", "variant_id", "product_name", "variant_name", "sku", "stock_level", "low_stock_threshold"}]}`
  (tracked, active variants of active products with `stock_level <= low_stock_threshold`, sold out first).
- `admin_recovery_stats(p_days)` — carts CREATED in the window →
  `{"days", "since", "captured", "with_items", "reminded_1", "reminded_2", "reminded_3", "converted", "converted_after_reminder", "opted_out", "recovered_revenue"}`.
- `admin_newsletter_growth(p_days)` →
  `{"days", "since", "total", "active", "new", "unsubscribed", "by_source": [{"source", "total", "active", "new"}], "daily": [{"day", "new"}]}`.
- `admin_order_status_counts()` (all time) →
  `{"total", "open", "counts": {"pending", "processing", "accepted", "fulfilled", "shipped", "out_for_delivery", "delivered", "cancelled"}}`.

Dashboard (WP-H): `adminRpc` / `useAdminQuery(({ supabase }) => supabase.rpc('admin_funnel', { p_days: 30 }))`;
numbers arrive as JSON numbers (`Number()` anyway); `since` is an ISO timestamptz; `day` is `YYYY-MM-DD`
(Colombo). Missing function (`PGRST202`) → banner "apply 17_analytics.sql".

---

## 18_site_lock.sql — pre-launch site lock (SQL-REST)

#### `site_lock` (SEALED singleton: no policy, no privileges for anon or authenticated — only the functions)

| column | type | default | notes |
| --- | --- | --- | --- |
| `id` | boolean (PK, CHECK `id`) | `true` | exactly one row, created by the migration |
| `locked` | boolean | `false` | the stored flag |
| `pin_hash` | text | NULL | bcrypt (`crypt(pin, gen_salt('bf', 10))`) |
| `unlock_token` | uuid | `gen_random_uuid()` | the bypass cookie value; rotated with every new PIN |
| `headline` | text | `'Launching soon'` | 1–120 |
| `message` | text | `'We are putting the finishing touches to the store.'` | 1–1000 |
| `launch_at` | timestamptz | NULL | |
| `auto_unlock` | boolean | `true` | the lock ends by itself at `launch_at` (DB clock) |
| `failed_attempts` | int | `0` | 0–10 |
| `locked_out_until` | timestamptz | NULL | the cool-off |
| `updated_at` / `updated_by` | timestamptz / uuid (FK → customers) | | set by `set_site_lock` |

| Signature | Grant | Returns | Contract |
| --- | --- | --- | --- |
| `get_site_lock()` | **A** | TABLE, **one row in an array**: `(locked bool, headline text, message text, launch_at timestamptz, auto_unlock bool, has_pin bool, unlock_fingerprint text, server_now timestamptz)` | `locked` = EFFECTIVE lock: `locked AND NOT (auto_unlock AND launch_at IS NOT NULL AND now() >= launch_at)`; `unlock_fingerprint` = lower-hex sha256 of the token's text; never the token or hash |
| `verify_site_lock_pin(p_pin text)` | **A** | text (the token) or NULL | NULL for: no PIN set, cooling off (checked BEFORE comparing), blank/NULL, > 64 chars, wrong. Trimmed. Each wrong PIN (non-blank, ≤ 64 chars) is a strike; the 10th consecutive strike starts a **15-minute** cool-off (and resets the counter); a right PIN resets strikes and cool-off |
| `admin_site_lock_state()` | **U** (42501 `not_authorised`) | TABLE, one row: `(locked, effective_locked, headline, message, launch_at, auto_unlock, has_pin, updated_at, server_now)` | |
| `admin_site_lock_token()` | **U** (42501) | text | the current token (to refresh the operator's own bypass cookie) |
| `set_site_lock(p_locked bool DEFAULT NULL, p_pin text DEFAULT NULL, p_headline text DEFAULT NULL, p_message text DEFAULT NULL, p_launch_in_hours numeric DEFAULT NULL, p_clear_launch bool DEFAULT FALSE, p_auto_unlock bool DEFAULT NULL)` | **U** (42501) | void | NULL/blank = unchanged. A new PIN (6–12 digits, trimmed) is bcrypt-hashed and **rotates the token**. `p_launch_in_hours` → `launch_at = now() + hours`; `p_clear_launch` → NULL; re-locking after a passed launch time clears it. Every save resets strikes/cool-off. 22023 codes: `invalid_pin` · `invalid_launch` (not in (0, 8760]) · `invalid_headline` (> 120) · `invalid_message` (> 1000) · `pin_required` (locking with no PIN stored or given). Message = `code:human text` |

Routes (WP-H): proxy `lib/site-lock.ts` → `rpc('get_site_lock')` → `data[0]` (cache 15 s, failures
too; fail to the last good state, else unlocked); bypass cookie valid when
`timingSafeEqual(sha256hex(cookie), unlock_fingerprint)`. `POST /api/site-lock/unlock { pin }` →
`rpc('verify_site_lock_pin', { p_pin })` → string = set the httpOnly cookie; `null` = one generic
message (wrong / no PIN / cooling off). `GET/POST /api/admin/site-lock` (session client): state →
`rpc('admin_site_lock_state')` → `data[0]`; save → `rpc('set_site_lock', {…})` (void: `requireData: false`),
then `rpc('admin_site_lock_token')` → refresh the operator's cookie, `invalidateSiteLockCache()`;
42501 → 403, 22023 → 422 with the detail.

As built (WP-H), verified end to end against PostgREST:
- Bypass cookie `dockone_site_access` = the token; httpOnly, `SameSite=Lax`, `Path=/`, 30 days,
  `Secure` in production or over https. `SITE_LOCK_ALWAYS_OPEN` (lib/site-lock.ts) = `/admin`,
  `/api/admin`, `/api/site-lock`, `/api/cart-recovery`, `/api/maintenance`, `/auth`, `/launching-soon`
  (the gate re-checks them even though src/proxy.ts skips them). Locked pages are rewritten to
  `/launching-soon` (`X-Robots-Tag: noindex, nofollow`, `Cache-Control: private, no-store`); APIs get
  `503 { error, code: "site_locked" }`. The 15 s cache lives on `globalThis`, so the admin route's
  `invalidateSiteLockCache()` reaches the proxy when both run in one process; a cached lock also ends
  locally at an auto-unlock launch time (DB clock offset kept from `server_now`).
- `POST /api/site-lock/unlock { pin, company }` (2 KB, honeypot, 10/min/IP bucket `site-lock:ip`):
  `200 { ok: true }` + cookie · `401 { ok: false, error: "That PIN didn't work. Check it and try again." }`
  for a wrong PIN, no PIN set, a cool-off, a malformed PIN (not 6–12 digits → no DB call) and the
  honeypot alike · `429` route limit · `503` unconfigured / migration pending (`code: migration_pending`).
- `GET /api/admin/site-lock` → `{ state: { locked, effectiveLocked, headline, message, launchAt,
  autoUnlock, hasPin, updatedAt, serverNow } }`. `POST` body `{ locked?, pin?, headline?, message?,
  launchAt?: ISO | null, autoUnlock? }` (omitted = unchanged; `launchAt: null` → `p_clear_launch`;
  an ISO time → `p_launch_in_hours` from the server clock, to the second) → `{ ok: true, state,
  cookieRefreshed }`. Same-origin + `getAdminIdentity()` first (403).

---

## 19_assistant_core.sql — conversation log and insights (SQL-REST)

This migration OWNS `assistant_messages`' shape and `log_assistant_turn`'s signature.

#### `assistant_sessions`

| column | type | null | default | notes |
| --- | --- | --- | --- | --- |
| `id` | uuid | NOT NULL (PK) | | the browser's chat session id |
| `client_key` | text | yes | | `^[0-9a-f]{16,64}$` only (`assistant_sessions_client_key_valid`) — pass `hashKey(clientKey(request))`; a raw IP is stored as NULL |
| `customer_id` | uuid | yes (FK → customers ON DELETE SET NULL) | | set by 21's claim |
| `message_count` | int | NOT NULL | `0` | rows logged (user + assistant) |
| `created_at` / `last_seen_at` | timestamptz | NOT NULL | `now()` | |

#### `assistant_messages`

| column | type | null | notes |
| --- | --- | --- | --- |
| `id` | bigint (PK) | NOT NULL | order a transcript by `id` |
| `session_id` | uuid | NOT NULL | FK → assistant_sessions ON DELETE CASCADE |
| `role` | text | NOT NULL | `user\|assistant` |
| `content` | text | NOT NULL | PII-redacted |
| `product_ids` / `added_product_ids` | int[] | yes | assistant rows: shown / added by the agent (≤ 12) |
| `tapped_product_ids` | int[] | yes | user rows: ADD taps (≤ 12) |
| `outcome` | text | yes | assistant rows: `truncated\|bad_ids\|no_image_match\|no_match\|no_tools\|dead_end\|answered\|failed` (`assistant_messages_outcome_valid`); NULL = unclassified |
| `question_id` | text | yes | ≤ 32 |
| `tools_used` / `search_terms` | text[] | yes | ≤ 12 × 40 / ≤ 8 × 80 (terms redacted) |
| `page` | text | yes | path only, ≤ 120 |
| `model` | text | yes | ≤ 60 |
| `latency_ms` | int | yes | 0..600 000 |
| `input_tokens` / `output_tokens` / `cache_read_tokens` | int | yes | 0..10 000 000 (NULL stays NULL) |
| `has_image` | boolean | NOT NULL (default false) | user rows |
| `photo_reading` | text | yes | assistant rows, ≤ 200, redacted |
| `created_at` | timestamptz | NOT NULL | |

**RLS**: anon ✗ no privilege; authenticated SELECT only (admins all rows, shoppers 0 rows); nobody
writes through the API (42501) — only `log_assistant_turn`, 21's claim, `forget_assistant_customer`
and retention.

| Signature | Grant | Returns | Contract |
| --- | --- | --- | --- |
| `redact_pii(p_text text)` | — | text | emails → `[email]`; `DO-10001` / `do 10001` / `DO10001` → `[order]`; phone shapes (`077 123 4567`, `+94 77 123 4567`, `0771234567`, `(011) 234-5678`) and remaining 7+ digit runs → `[number]`; prices/specs survive |
| `clamp_ints(int[], p_limit int DEFAULT 12)`, `clamp_labels(text[], p_limit int DEFAULT 8, p_len int DEFAULT 40)` | — | arrays | order-preserving; NULL/blank dropped |
| `log_assistant_turn(p_session_id uuid, p_user_content text, p_assistant_content text DEFAULT '', p_outcome text DEFAULT NULL, p_shown_product_ids int[] DEFAULT NULL, p_added_product_ids int[] DEFAULT NULL, p_tapped_product_ids int[] DEFAULT NULL, p_question_id text DEFAULT NULL, p_tools_used text[] DEFAULT NULL, p_search_terms text[] DEFAULT NULL, p_page text DEFAULT NULL, p_model text DEFAULT NULL, p_latency_ms int DEFAULT NULL, p_input_tokens int DEFAULT NULL, p_output_tokens int DEFAULT NULL, p_has_image boolean DEFAULT FALSE, p_photo_reading text DEFAULT NULL, p_client_key text DEFAULT NULL, p_cache_read_tokens int DEFAULT NULL)` | **A** | void — **never raises** | ONE call per turn writes the user row and the assistant row. Nothing when the session is NULL or both texts are blank. Texts trimmed, ≤ 8000, redacted. Unknown outcome → NULL. Past 400 messages in a session nothing more is stored. Any error is swallowed and the whole turn rolls back — **a clean return does not prove a write** (smoke query in the OPS NOTE) |
| `admin_assistant_overview(p_days int DEFAULT 30)` | **U** (42501) | jsonb | below |
| `admin_assistant_sessions(p_days int DEFAULT 30, p_struggles_only boolean DEFAULT FALSE, p_limit int DEFAULT 50, p_offset int DEFAULT 0)` | **U** (42501) | jsonb | below |
| `admin_assistant_transcript(p_session_id uuid)` | **U** (42501) | SETOF `assistant_messages` (array of rows, ≤ 400, by id) | |

Route (`/api/assistant`, WP-I, `lib/assistant/insights.ts`): call with **named arguments**
(`rpc('log_assistant_turn', { p_session_id, p_user_content, p_assistant_content, p_outcome, p_shown_product_ids, p_added_product_ids, p_tapped_product_ids, p_question_id, p_tools_used, p_search_terms, p_page, p_model, p_latency_ms, p_input_tokens, p_output_tokens, p_has_image, p_photo_reading, p_client_key: hashKey(clientKey(request)), p_cache_read_tokens })`);
`p_model` = `MODEL_IDS.text` / `.vision`; the outcome union in `types.ts` must equal the list above.

Insights (window = the last `p_days` business days, Asia/Colombo, 1..365):
- `admin_assistant_overview(p_days)` →
  `{"days", "since", "timezone", "totals": {"sessions", "turns", "adds", "photos", "struggles", "median_latency_ms", "input_tokens", "output_tokens", "cache_read_tokens"}, "outcomes": {the 8 labels: n}, "hours": {"0": n … "23": n}, "terms": [{"term", "turns"}], "zero_result_terms": [{"term", "turns"}], "demand": [{"product_id", "brand", "name", "shown", "taken"}], "photo_demand": [{"reading", "turns"}], "tools": [{"tool", "calls"}]}`
  — `turns` = assistant rows; `adds` = agent adds + shopper taps; `struggles` = assistant rows with
  an outcome other than `answered`; an unclassified (NULL) outcome counts as `answered`;
  `median_latency_ms` is a number or null; `hours` are local hours of user messages;
  `zero_result_terms` come from `no_match` / `no_image_match` turns; `photo_demand` from
  `no_image_match` readings (`unclear` excluded). Lists ≤ 25 (demand ≤ 30).
- `admin_assistant_sessions(p_days, p_struggles_only, p_limit 1..200, p_offset 0..100000)` →
  `{"total", "items": [{"session_id", "customer_id", "message_count", "turns", "struggles", "photos", "adds", "first_message", "last_outcome", "created_at", "last_seen_at"}]}`
  (sessions seen in the window, newest first; `first_message` = first user message, ≤ 160, redacted).

---

## 20_assistant_offers.sql — offers for the assistant (SQL-REST)

| Signature | Grant | Returns |
| --- | --- | --- |
| `list_live_offers(p_session_id uuid DEFAULT NULL)` | **A** | TABLE `(code text, title text, kind text, value numeric, min_requirement numeric, ends_at timestamptz, exclusive boolean)` — an array, ≤ 8 rows |
| `admin_offer_performance(p_since timestamptz DEFAULT NULL, p_until timestamptz DEFAULT NULL, p_assistant_only boolean DEFAULT NULL)` | **U** (42501) | TABLE `(code text, title text, exclusive boolean, orders_count bigint, cancelled_count bigint, revenue numeric, discount_given numeric)` |

- **Live** = `is_active`, started, not ended (`ends_at` NULL or ≥ now), under its usage limit.
- **Public** rows (`exclusive = false`): `code`, `title`, `min_requirement` only — `kind`, `value`,
  `ends_at` are NULL (the model gets no amount to do maths with).
- **Exclusive** (`assistant_only`) rows appear only when `p_session_id` names a session with ≥ 4
  logged messages, created > 60 s ago and seen in the last 24 h; each such call costs 1 of 6 per
  session per hour, then 1 of 400 per hour store-wide (the store-wide bucket is charged only after
  the session one passes); when either is spent the call silently returns public codes only.
  Exclusive rows carry `kind` (`percentage|fixed_amount`), `value`, `ends_at`. Order: exclusive
  first, then `min_requirement`, `code`. **Never** `usage_count` / `usage_limit`.
- Price a code against the bag with `validate_discount(p_code, p_subtotal)` (09) — the same verdict
  `place_order` applies; delivery on the PRE-discount subtotal (`deliveryFeeFor`). A code offered to
  the shopper is parked with `stashOfferCode()`; checkout still applies and `place_order` redeems.
- `admin_offer_performance`: orders placed in `[p_since, p_until]` (defaults: last 90 days until
  now; reversed bounds swapped; > 366 days keeps the latest 366) matched to a code by
  `orders.discount_id`, or — when that link is NULL — by the `discount_code` snapshot
  (case-insensitive). `revenue` / `discount_given` = Σ `total_price` / `discount_amount` of the
  NON-cancelled ones. Every code is listed (zeros when unused), most used first.
  `p_assistant_only`: NULL all, TRUE exclusive only, FALSE public only.

---

## 21_assistant_memory_lookup.sql — returning-customer memory, forget, private order lookup (SQL-REST)

#### `assistant_order_lookups` (admin SELECT only; anon no privilege; nobody writes through the API)

| column | type | notes |
| --- | --- | --- |
| `id` | bigint (PK) | |
| `session_id` | uuid | no FK |
| `client_key` | text | `^[0-9a-f]{16,64}$` or NULL |
| `order_ref` | text | normalised (`DO-10001`), ≤ 64 |
| `email_domain` | text | the part after `@` only — **never the address**, ≤ 80 |
| `found` | boolean NOT NULL | |
| `created_at` | timestamptz | pruned after 30 days (here on every lookup, and by 22) |

| Signature | Grant | Returns | Contract |
| --- | --- | --- | --- |
| `get_assistant_customer_context(p_session_id uuid DEFAULT NULL, p_client_key text DEFAULT NULL)` | **U** | jsonb or NULL | below |
| `forget_assistant_customer(p_customer_id uuid)` | **U** (admin re-checked → 42501 `not_authorised`) | int | deletes the customer's assistant sessions (messages cascade); returns sessions deleted |
| `lookup_order_for_assistant(p_order_id text, p_email text, p_session_id uuid DEFAULT NULL, p_client_key text DEFAULT NULL)` | **A** | jsonb or NULL | below |

**`get_assistant_customer_context`** — **session client only** (reads `auth.uid()`; takes no
customer id). NULL when not signed in or no customers row. Otherwise
`{"firstName": "Ann" | null, "owns": [{"productId", "variantId", "name", "brand", "variant", "boughtOn": "September 2026", "status"}], "profile": {"performance"?, "portability"?, "battery"?, "value"?, "weight"?}}`:
- `owns`: ≤ 20 distinct product/variant lines (deleted products kept apart by line) from the
  account's last 5 **non-cancelled** orders — by `customer_id` OR its confirmed sign-in email —
  cancelled orders filtered BEFORE the limit; newest first; `boughtOn` in Asia/Colombo; no prices.
- `profile`: the newest non-empty finder profile of this account (14), keys allowlisted to the finder
  axes (BUILD_SPEC §1), numbers clamped 0..10; `{}` when none.
- `firstName`: trimmed, ≤ 40 — still sanitise to letters/marks/`'`/`-`/space in `customer.ts`.
- Claim: links `p_session_id` to the account only if that session has no customer, was seen in the
  last 24 h, and its `client_key` is NULL or equals `p_client_key` (hashKey output, case-insensitive).

**`lookup_order_for_assistant`** (`POST /api/assistant/order`, never the model): the number accepts
what a shopper types (`DO-10001`, `do-10001`, `#10001`, `10001`); email compared case-insensitively.
- blank number or email → `null` (charges nothing, not audited);
- throttle shared with `track_guest_order`: buckets `track:ref:<DO-n>` and `track:mail:<md5(email)>`,
  8 per 15 min each, both charged per lookup and again on a miss → `{"throttled": true}` (not
  audited; says nothing about the pair);
- miss (wrong or missing alike) → `null`; hit →
  `{"orderId", "status", "fulfillment", "placedAt", "trackingNumber", "trackingUrl", "items": [{"productId", "variantId", "name", "variant", "quantity"}], "events": [{"status", "location", "description", "updatedAt"}]}`
  — no money, address, phone or email; `fulfillment` is `delivery|pickup` (WP-I: so a pickup order's
  `out_for_delivery` reads "Ready for pickup" through `orderStatusLabel`); items in line order, events oldest first;
- every non-throttled lookup writes an audit row (email domain only) — the audit never costs the answer.
Route: malformed ref/email → answer as a miss (404) without calling; `null` → 404; `throttled` → 429.

---

## 22_retention.sql — daily housekeeping (SQL-REST)

| Signature | Grant | Returns |
| --- | --- | --- |
| `run_retention(p_secret text)` | **A** + secret `maintenance` | jsonb `{"rate_limit_hits", "assistant_order_lookups", "analytics_events", "assistant_sessions", "assistant_messages", "abandoned_carts", "finder_responses"}` (rows deleted) |

Deletes: `rate_limit_hits` older than 1 day · `assistant_order_lookups` 30 days · `analytics_events`
13 months · `assistant_sessions` last seen 12 months ago (messages cascade, not re-counted) ·
`assistant_messages` older than 12 months in sessions that remain · `abandoned_carts` whose later
of `updated_at` and `last_recovery_at` is 90 days ago · `finder_responses` with no email and no
account, `updated_at` 12 months ago. **Orders, customers, reviews, subscribers and suppressions are
never touched.** P0001 `unauthorized` on a wrong/short/missing secret or a missing app_config row.
Route (`POST /api/maintenance`, WP-H): check `Authorization: Bearer <MAINTENANCE_SECRET>`
(constant-time) before any DB work → `rpc('run_retention', { p_secret })` → log/return the report.
As built: `503` when `MAINTENANCE_SECRET` is unset/short (checked first) · `401` for a missing/wrong
bearer · `200 { ok: true, ranAt, deleted: { rate_limit_hits, assistant_order_lookups,
analytics_events, assistant_sessions, assistant_messages, abandoned_carts, finder_responses }, total }`
· `503` when the database's `app_config.maintenance` differs (P0001 `unauthorized`) or 22 is missing.
Daily schedule, curl/cron lines and log lines: `docs/build/JOBS.md` (with the hourly cart-recovery job).

---

## Tests for 12–22 (SQL-REST)

`supabase/tests/12_leads … 22_retention.test.sql` (one per migration), plus:
- `98_end_to_end.test.sql` — FULL chain only (skipped under `VERIFY_ONLY`): seed catalogue present →
  `quote_order` → `capture_abandoned_cart` → guest COD `place_order` (charges exactly the quote,
  stock −2, one discount use) → the autosave row converted → `track_guest_order` + `view_order` →
  admin `out_for_delivery` (tracking required) → `delivered` → sign-up, confirmation links the
  guest order and adopts its spend → `submit_review` is a verified purchase → a signed-in second
  order cancelled: stock, discount use and lifetime value reverse → dashboard + recovery figures →
  `run_retention` refuses a wrong secret, runs with the right one, orders survive. It uses the first
  visible seed product and pins settings/stock/discount itself.
- `99_privileges.test.sql` (shared; SQL-REST finalised it for 01–22): the complete grant-A and
  grant-U allowlists, sealed tables (including `email_suppressions` and `site_lock` for both roles),
  a named list of internal helpers (`verify_job_secret`, `_rate_limit_hit`, `link_guest_orders`,
  `redact_pii`, `clamp_ints`, `clamp_labels`, `_business_tz`, …) and **every trigger function**
  asserted non-executable by anon and authenticated, no function in both allowlists, no anon/PUBLIC
  write policy anywhere, and live 42501 checks as anon and as a signed-in shopper.
  **Every new granted function must be added to it** (another author's migration fails the audit
  until its row exists).

---

## 23_admin_catalogue.sql — admin product save, collection members, admin list views (WP-K)

Depends on 02 (`is_admin`), 04, 05 and 07 (`order_items`). Everything here is for the admin
Products / Collections / Inventory tabs; anon has no privilege on any of it.

| Signature | Grant | Returns |
| --- | --- | --- |
| `admin_save_product(p_product jsonb, p_variants jsonb DEFAULT NULL)` | **U** (admin re-checked in the body → 42501) | jsonb (below) |
| `admin_set_collection_products(p_collection_id text, p_product_ids int[])` | **U** (admin re-checked → 42501) | `{collection_id, manual_count, member_count}` |
| view `admin_product_list` | SELECT to authenticated only (`security_invoker`) | one row per product |
| view `admin_inventory` | SELECT to authenticated only (`security_invoker`) | one row per variant |
| `products_forget_collection_art()` | — (trigger AFTER DELETE on products) | removes the deleted id from `collections.feature_product_ids` |
| `_admin_json_text/_int/_money/_bool/_text_array(…)` | — | internal JSON field readers (raise the 22023 messages below) |

### `admin_save_product` — one transaction: product + variants + costs + stock

`p_product` (object):
- no `id` (or null) = **create** — the database assigns the id; `slug`, `brand`, `name` required.
- with `id` = **update** — only the keys present change (absent = keep; `null` clears a nullable column).
- Allowed keys: `id, slug, brand, name, subtitle, description, category_id, image_urls[], cutout_url,
  tags[], attributes{}, warranty_months, is_active, is_new, is_bestseller, is_featured,
  is_flash_deal, sort_order, seo_title, seo_description`. Anything else is refused
  (`price`, `compare_at_price`, `image_url`, `variant_count`, … are derived). `image_url` follows
  `image_urls[1]` (04's trigger); tags/URLs are validated by 04's `products_normalize`.

`p_variants`: `NULL` = leave the variants alone (update only). Otherwise the **complete** list,
1–100 objects, in selector order:
- each needs `name` (unique per product, case-insensitive) and `price` (≥ 0, ≤ 2 decimals; the
  CHECK caps it at 100,000,000);
- `id` = an existing variant **of this product** (update); no `id` = new;
- optional: `sku` (unique store-wide, no spaces; `null` clears), `option_values` (≤ 10 text pairs,
  trimmed, blank pairs dropped), `compare_at_price`, `position` (new rows default to list order),
  `is_active`, `weight_g` — absent on an update = keep;
- `cost_price`: present → a number upserts `product_costs`, `null` deletes it; absent → untouched;
- stock — **only when supplied**: `track_stock: false` deletes the inventory row (untracked: always
  sells); `track_stock: true` and/or `stock_level` / `low_stock_threshold` make sure the row exists
  (a new row starts from the column defaults: 0 in stock, threshold 3) and write the given values.
  None of the three (or all null) = **stock untouched** — the admin UI sends them only when edited,
  so an order that sold stock while the editor was open is never overwritten (blueprint §11.2).
- existing variants **not listed** are removed: **deactivated** (kept) when any `order_items` row
  references them, otherwise deleted. A kept variant keeps its name and SKU (a new variant can't
  take them) and can be re-activated by listing it again.
- names/SKUs may be swapped between listed variants in one save (they are parked first).

Returns `{product_id, created, slug, price, compare_at_price, variant_count, default_variant_id,
variants: [{id, name, created}] (list order; [] when p_variants is NULL), deleted_variant_ids: [],
deactivated_variant_ids: []}`. Any failure rolls back everything.

Lock order: the product's `inventory` rows first, in `(product_id, variant_id)` order, before any
product/variant row — the same order as `place_order` and the cancellation in
`admin_set_order_status`.

Errors (message = `code:human text` — show the text):

| SQLSTATE | code | when |
| --- | --- | --- |
| 42501 | `not_authorised` | caller is not an admin (anon: no EXECUTE → 42501 too) |
| 22023 | `invalid_product` | not an object, unknown/derived key, wrong type, text too long, flag/sort null |
| 22023 | `invalid_slug` | slug blank or not `^[a-z0-9][a-z0-9-]*$` (≤ 120) |
| 22023 | `product_not_found` | the id doesn't exist (deleted meanwhile) |
| 22023 | `variants_required` | a new product without variants, or an empty list |
| 22023 | `invalid_variant` | not an object, unknown key, id of another product / repeated, missing name or price, bad number, SKU with spaces, bad options, > 100 variants |
| 22023 | `invalid_stock` | `track_stock` not boolean, stock not 0–1,000,000, threshold not 0–100,000 |
| 22023 | `duplicate_variant_name` / `duplicate_sku` | two listed variants share a name / SKU |
| 22023 | `variant_name_taken` / `sku_taken` | a kept (order-referenced) variant, or another product, already uses it (the text names the product) |
| 22023 | `invalid_image_url`, `invalid_tags` | from 04's `products_normalize` |
| 23505 | `products_slug_key`, `product_variants_sku_key`, `product_variants_product_name_key` | unique (e.g. slug taken, or a concurrent save took a SKU) |
| 23514 | `product_variants_price_valid`, `products_text_lengths`, `products_warranty_valid`, `inventory_levels_valid`, … | CHECKs of 04/05 |
| 23503 | `products_category_id_fkey` | unknown category |

TypeScript: `src/lib/admin/catalogue.ts` — `buildProductSave(form)` builds the arguments,
`PRODUCT_WRITE` maps every code/constraint above to admin copy; call with
`adminRpc("admin_save_product", payload, PRODUCT_WRITE)` (revalidates `catalogue` after success).

### `admin_set_collection_products(p_collection_id, p_product_ids)`

The collection's **hand-picked** (`source = 'manual'`) members become exactly `p_product_ids`,
positions 0, 1, 2 … in that order (`'{}'`/NULL = none) — one call, so a reorder can't half-apply
(blueprint §11.3). A listed product that was a rule member becomes manual; for an **automated**
collection the rule rows are then re-derived (`_refresh_collection_rule_members`), so a product
that leaves the picks but matches the rules falls back to its rule row. Errors (22023):
`collection_not_found`, `invalid_products` (> 500, NULL entry, duplicate), `unknown_product`
(the text lists the ids); 42501 `not_authorised`.

### Views (RLS of the underlying tables applies — anon: no privilege; shopper: no stock rows)

`admin_product_list` — the Products tab: `id, slug, brand, name, subtitle, category_id,
category_name, price, compare_at_price, default_variant_id, variant_count, image_url, cutout_url,
is_active, is_new, is_bestseller, is_featured, is_flash_deal, sort_order, rating_avg, rating_count,
created_at, updated_at, variants_total, skus` (space-separated, for search)`, tracked_variants,
stock_total` (NULL when no variant is tracked)`, low_stock_variants, has_low_stock`.

`admin_inventory` — the Inventory tab, one row per variant (tracked or not): `variant_id,
product_id, variant_name, sku, position, variant_is_active, price, product_name, brand,
product_slug, category_id, category_name, image_url, product_is_active, tracked, stock_level,
low_stock_threshold, is_low, stock_updated_at`. **Admin low stock** = a tracked, active variant
of an active product with `stock_level <= low_stock_threshold` — the same rule as 17's
`admin_low_stock` (dashboard); sold out counts, unlike the shopper-facing
`get_product_availability().low_stock`. `admin_product_list.stock_total` sums every tracked
variant (units on hand); `low_stock_variants`/`has_low_stock` use the low-stock rule. "Low stock first" =
`.order('is_low', {ascending:false}).order('stock_level', {nullsFirst:false})`.
Inline edits write `inventory` directly (admin RLS): update `.eq('variant_id', id).select()` →
check 1 row; tracking on = `insert({variant_id})` (product_id and the defaults are filled in);
tracking off = delete (confirm first: the variant then sells without limit).

---

## 30_seed_catalogue.sql — DEMO catalogue (replace or delete before launch)

The approved design's placeholder catalogue moved into the database **and nothing more** (owner's
rule, BUILD_SPEC §3): every value comes from the old static `src/data/products.ts`, the
CategoryPopouts cards and the Collections tiles, plus the existing `public/images/**` files. One
atomic `DO` block guarded by the `app_config` marker `seed_30_catalogue_demo` (re-runs are no-ops;
deleting the demo rows never resurrects them). Self-verifying: raises (and rolls back) unless every
from-price equals the design AND no demo row carries invented data.

| design key | slug | brand | subtitle (the design's spec line) | price / compare-at | `attributes` |
| --- | --- | --- | --- | --- | --- |
| lap-01 | `vanta-g15-gaming-laptop` | Vanta | Ryzen 7 · RTX 4060 · 16GB · 1TB SSD | 489,900 / 549,900 | specs `cpu "Ryzen 7", gpu "RTX 4060", ram_gb 16, storage_gb 1000, storage_type "SSD"` · use_cases `gaming` |
| lap-02 | `aeroslim-14-ultrabook` | AeroSlim | Core Ultra 5 · 16GB · 512GB · 1.2kg | 329,900 / 369,900 | `cpu "Core Ultra 5", ram_gb 16, storage_gb 512, weight_kg 1.2` |
| lap-03 | `forge-studio-16-creator-laptop` | Forge | Core Ultra 9 · RTX 4070 · 32GB · 1TB | 724,900 / 799,900 | `cpu "Core Ultra 9", gpu "RTX 4070", ram_gb 32, storage_gb 1000` · `creative` |
| lap-04 | `campus-13-everyday-laptop` | Campus | Core i3 · 8GB · 256GB SSD | 164,900 / 189,900 | `cpu "Core i3", ram_gb 8, storage_gb 256, storage_type "SSD"` · `everyday` |
| sto-01 | `bolt-x-portable-ssd-1tb` | Bolt X | USB-C 3.2 · 1050MB/s · IP65 | 28,900 / 36,500 | `capacity_gb 1000, type "Portable SSD", interface "USB-C 3.2", speed_mbps 1050, rugged "IP65"` |
| sto-02 | `atlas-slim-external-hdd-2tb` | Atlas | USB 3.0 · 2.5-inch · Aluminium | 24,500 / 28,900 | `capacity_gb 2000, type "External HDD", interface "USB 3.0"` |
| sto-03 | `duolink-flash-drive-128gb` | DuoLink | USB-C + USB-A · Metal body | 4,450 / 5,900 | `capacity_gb 128, type "Flash drive", interface "USB-C + USB-A"` |
| sto-04 | `vault-desktop-backup-drive-8tb` | Vault | USB 3.2 · Auto-backup software | 64,900 / 74,900 | `capacity_gb 8000, type "Desktop drive", interface "USB 3.2"` · `backup` |
| key-01 | `kairo-75-wireless-mechanical-keyboard` | Kairo | Hot-swap · Gasket mount · Tri-mode | 32,900 / 38,900 | `switch "Mechanical", hot_swap true, connectivity ["Tri-mode wireless"]` |
| key-02 | `onyx-pro-full-size-rgb-keyboard` | Onyx | Linear red switches · Aluminium plate | 21,900 / 27,500 | `layout "Full-size", switch "Linear red", backlight "RGB"` |
| key-03 | `feather-slim-wireless-keyboard` | Feather | Low-profile · Multi-device Bluetooth | 12,900 / 15,500 | `connectivity ["Multi-device Bluetooth"]` |
| key-04 | `volt-60-compact-keyboard-acid-lime` | Volt | 60% · PBT keycaps · Coiled cable | 18,500 / 22,900 | `layout "60%", keycaps "PBT"` |
| mou-01 | `glide-mx-ergonomic-wireless-mouse` | Glide | 8K DPI · Metal scroll wheel · USB-C | 24,900 / 29,900 | `dpi_max 8000, connectivity ["Wireless"]` · `ergonomic` |
| mou-02 | `aero-lite-gaming-mouse-58g` | Aero Lite | 26K sensor · Honeycomb shell | 14,900 / 18,900 | `dpi_max 26000, weight_g 58` · `gaming` |
| mou-03 | `grip-vertical-ergonomic-mouse` | Grip | 57° grip angle · Silent clicks | 9,900 / 12,500 | `grip "vertical", silent true` · `ergonomic` |
| mou-04 | `pebble-go-travel-mouse` | Pebble | Bluetooth · Silent · 12-month battery | 5,450 / 6,900 | `connectivity ["Bluetooth"], silent true` · `mobile` |

- **Variants:** exactly ONE per product — name `Standard`, the design's price / compare-at,
  `position 0`, `option_values {}`, **no SKU**, no weight. Every product: `variant_count 1`.
- **Specs** hold only facts written in the spec line or the name (a key is absent when unknown —
  never `null`-filled, never guessed). Storage sizes are decimal GB (1TB = 1000). The single
  unlabelled MB/s figure on sto-01 is `speed_mbps` (the design doesn't say read or write).
  `use_cases` only where the NAME says it: Gaming → `gaming`, Creator → `creative`, Everyday →
  `everyday`, Travel → `mobile`, Backup → `backup` (the finder vocabulary) and Ergonomic →
  `ergonomic` (no finder equivalent). No `highlights`, no `in_the_box`.
- **Not seeded (would be invented):** descriptions, tags, warranty months, SEO copy, `is_featured`,
  extra variants/configurations, SKUs, inventory rows (**no row = not tracked = always sells**;
  `get_product_availability` returns nothing for them and `list_in_stock_product_ids` lists all
  16), `product_costs`, reviews/ratings (`rating_avg 0`, `rating_count 0`), category/collection
  descriptions, rule-driven collections.
- Art: `image_urls = ['/images/products/<key>.webp']`, `cutout_url = '/images/cutouts/<key>.webp'`;
  categories `stage_image_url = '/images/stages/<id>.webp'`.
- Flags: `is_flash_deal` lap-02, sto-01, key-02, lap-04, mou-02, sto-02 · `is_new` key-04, sto-04,
  mou-04, key-03, lap-03 (`created_at` staggered so "newest first" gives exactly that order) ·
  `is_bestseller` lap-01, mou-01, key-01, sto-01, lap-04. `sort_order` (10…160) reproduces the
  homepage flash-deal and best-seller row orders.
- Categories: laptops (night, hero lap-02), storage (paper, hero sto-01), keyboards (lime, hero
  key-01), mice (violet, hero mou-01); sort 10/20/30/40; name + tagline from the design; no
  description.
- Collections: `work-from-home` [lap-02 / key-03], `gaming-zone` [key-02 / mou-02], `campus-kit`
  [lap-04 / sto-03], `creator-studio` [lap-03 / sto-04] — manual, curated, featured, title +
  subtitle from the tiles, `feature_product_ids = [back, front]`, and those two products are the
  members (positions 0 and 1).
- Removal statement: in the file header (the four collections + the 16 products by slug;
  categories stay).

---

## 31_seed_storefront.sql — DEMO homepage + chrome content (WP-B; replace or delete before launch)

One atomic `DO` block guarded by the `app_config` marker `seed_31_storefront_demo`. It moves the
approved homepage/chrome copy (old `Hero.tsx`, `PromoGrid.tsx`, `TrustRow.tsx`, `OrderYourWay.tsx`,
`SignalSection.tsx`, `NewArrivals.tsx`, `Ticker.tsx`, `src/data/site.ts`) into the database with the
P15 fixes, and never overwrites the owner:

| target | what | rule |
| --- | --- | --- |
| `store_settings` | phone `+94 11 234 5678`, WhatsApp `+94 77 123 4567`, email `hello@dockone.lk`, address = pickup address `No. 42, Galle Road, Colombo 03` (all **placeholders**), pickup note `Collect in Colombo 03, same day`, ticker (5 lines), labels `['COD','BANK TRANSFER']`, `flash_sale_title 'Flash deals'` | only columns still NULL/empty; `delivery_fee 450` / threshold `15000` are 03's defaults; the bank columns are **not touched** (03 fills the store's real account); `flash_sale_ends_at` stays **NULL** (the section hides until a real end time) |
| `hero_slides` | the 3 slides (images `/images/hero/{opening,laptops,gear}.webp`, positions 10/20/30) | only into an EMPTY table |
| `promo_tiles` | slots 1–4 (images `/images/promo/*.webp`, hrefs `/shop?category=<id>`, object positions from the old classes) | `ON CONFLICT (slot) DO NOTHING` |
| `content_blocks` | `hero_perks`, `trust_row`, `order_your_way` (art: `atlas-slim-external-hdd-2tb` / `aero-lite-gaming-mouse-58g`), `store_status`, `new_arrivals_feature` (`forge-studio-16-creator-laptop`) | `ON CONFLICT (key) DO NOTHING`; **no `testimonial`** (the old quote was invented) |

Removed as claims the store cannot back: "-40%" / "Up to 40% off" (deepest seeded discount 24.6 %),
the instalment offer ("or split it into 3 interest-free instalments", "Pay in 3", "Pay in 3 instalments"),
"Cards" and "instalments" from the perks, "Encrypted checkout — cards," from the trust row, the 10K+ /
99 % store-status rows, the invented testimonial and its 5.0 / 1,284 rating, and the VISA / MASTERCARD /
AMEX / INSTALMENTS labels. Settings-backed facts use the placeholders `{free_delivery_threshold}` /
`{returns_window_days}`; the payment/WhatsApp/pickup items carry `requires`.
Self-verifying: raises (rolling back) unless the slides/tiles/blocks it inserted are complete and live and
none of its copy matches the forbidden-claims pattern (cards, instalments, "encrypted", 10K+, 99 %, 40 %,
"verified buyer"), and it refuses to seed a testimonial. Removal statements: in the file header.
Tested (`31_seed_storefront.test.sql`): seeded values, `quote_order`'s flags (COD, pickup and bank
transfer — 03's real account — all yes), live slides/tiles for anon, block shapes and product slugs, the forbidden-claims
scan over everything seeded, idempotency, and a deliberate re-seed that fills only empty values.
Other test authors: a fully migrated database now carries these rows (03's and 16's tests reset them first).

---

## 32_seed_discounts.sql — DEMO discount code (WP-C; replace or delete before launch)

One atomic `DO` block guarded by the `app_config` marker `seed_32_discounts_demo` (re-runs are
no-ops; deleting the code never resurrects it). It inserts exactly the code the approved basket
already accepted (`src/data/site.ts` `promoCodes: { OPENING10: 0.1 }`) and nothing else:

| code | title | kind / value | min | limit | dates | active | assistant_only |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `OPENING10` | `OPENING10 — 10% off` | percentage / 10 | 0 | NULL (unlimited) | none | ✓ | ✗ |

- `ON CONFLICT DO NOTHING` on the `upper(code)` index: an owner-created OPENING10 is left as is.
- Self-verifying: the inserted row must be exactly the table above and `_discount_check('opening10', 10000)`
  must give 1000; otherwise the seed raises and rolls back.
- Removal (header): `DELETE FROM public.discounts WHERE upper(code) = 'OPENING10';` — orders keep
  their `discount_code` / `discount_amount` snapshot; or pause it with `is_active = FALSE`.
- Tested (`32_seed_discounts.test.sql`): stored values, no other codes, idempotent re-run,
  quote_order / validate_discount / place_order take exactly 10 % (whole rupees) and count one use,
  deletion keeps order snapshots, re-running never re-creates it.
- Other test authors: a fully migrated database now contains this ONE public discount row
  (e.g. `list_live_offers` returns it; `count(*) FROM discounts` is 1 before your fixtures).

---

## Apply order + secrets checklist (the owner, in the Supabase SQL editor)

**1. Apply the migrations in number order** — each file is idempotent (safe to paste again), and
`scripts/db/bundle.sh FROM TO` concatenates a range into one paste (`supabase/bundles/FROM-TO.sql`):

| step | files | then |
| --- | --- | --- |
| schema | `01` → `22` in order (`01_foundation` … `11_reviews`, `12_leads`, `13_abandoned_carts`, `14_finder`, `15_content_pages`, `16_storefront_content`, `17_analytics`, `18_site_lock`, `19_assistant_core`, `20_assistant_offers`, `21_assistant_memory_lookup`, `22_retention`) | deploy the app code that uses them (a missing function answers 503 "apply migration NN") |
| admin catalogue | `23_admin_catalogue` | |
| DEMO seeds | `30_seed_catalogue`, `31_seed_storefront`, `32_seed_discounts`, `33_seed_content_pages` (whichever exist) | replace or delete before launch (each header has the removal statement) — except 33, the privacy page TEMPLATE the blueprint requires: fill in its placeholders and have it reviewed instead |

Dependencies that make the order matter: 13 needs 12 (`email_suppressions`) and 09's helpers; 14
needs 12 (`subscribe_newsletter`) — and its `admin_finder_insights` calls 17's `_business_window_start` when run; 17 needs 12–13; 19 needs 17 (`_business_tz`); 20 needs 19; 21
needs 09, 14, 17, 19; 22 needs 13, 14, 17, 19, 21.

**2. Secrets** — generate each in the SQL editor and set the SAME value in the host's environment
(values must be ≥ 20 characters; an unset/short secret keeps the feature closed or, for the rate
limiter, open):

```sql
INSERT INTO public.app_config (name, value) VALUES
  ('rate_limit',    replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
  ('cart_recovery', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')),
  ('maintenance',   replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
SELECT name, value FROM public.app_config WHERE name IN ('rate_limit', 'cart_recovery', 'maintenance');
```

| app_config row | env var | used by | without it |
| --- | --- | --- | --- |
| `rate_limit` | `RATE_LIMIT_SECRET` | `check_rate_limit` (01) — every public route's limiter; also the HMAC key of `hashKey()` (rate-limit buckets and the assistant `client_key`) | every route limit **fails open** (log line "Rate limiting unavailable") — treat as a deploy error. In-DB throttles (tracking, order view/lookup, reviews, events, offers, PIN strikes) still work |
| `cart_recovery` | `CART_RECOVERY_SECRET` | `claim_abandoned_carts_for_recovery`, `release_abandoned_cart_recovery` (13) via `POST /api/cart-recovery` | autosaves are captured, **no reminder is ever sent** (job 401/503) |
| `maintenance` | `MAINTENANCE_SECRET` | `run_retention` (22) via `POST /api/maintenance` | **nothing is ever pruned** — the privacy page's retention periods would be untrue |

**3. Schedule the jobs** (any cron; bearer = the env value):
`curl -X POST https://<domain>/api/cart-recovery -H "Authorization: Bearer $CART_RECOVERY_SECRET"` hourly;
`curl -X POST https://<domain>/api/maintenance -H "Authorization: Bearer $MAINTENANCE_SECRET"` daily.

**4. The rest of the go-live list**: Supabase Auth "Confirm email" ON + custom SMTP (02); promote
the owner once after they sign up (`UPDATE public.customers SET is_admin = TRUE WHERE lower(email) = lower('<owner>')`);
settings — check the bank account (filled by 03), `pickup_address` or pickup off (09);
`OPENAI_API_KEY` for the assistant; optional site lock before launch (18).

**5. Verify the privilege surface on the live database** (every TRUE must be intended — compare with
the allowlists in `supabase/tests/99_privileges.test.sql`):

```sql
SELECT p.oid::regprocedure AS fn, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' ORDER BY 2 DESC, 3 DESC, 1;
```
