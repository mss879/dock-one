# Dock One Solutions — domain model

How the catalogue is shaped in the database, for everyone who reads or writes it: storefront
(WP-A, WP-B), commerce (WP-C), finder (WP-F), assistant (WP-I), admin (WP-K).
Source of truth: `supabase/migrations/04_catalogue.sql`, `05_inventory.sql`, `06_catalogue_search.sql`.
Exact signatures, grants and error codes are in `docs/build/SQL_NOTES.md`.

```text
categories 1───* products 1───* product_variants 1───0..1 inventory      (no row = not tracked)
     │  hero_product_id ──► products        │              1───0..1 product_costs   (admin only)
     │                                      *
     │                          product_collections (manual | rule rows)
     │                                      *
     └──────────────────────────────── collections (manual | automated, rules JSON)
```

---

## 1. Variant model B — every purchasable configuration is a priced row

The blueprint offers two variant models (§7.3). Dock One uses **model B** because configurations
change the price (a 32 GB laptop costs more than the 16 GB one).

- **Every product has at least one variant.** A product with a single option has exactly one
  variant named **`Standard`**; the storefront hides the selector when `variant_count = 1`.
- A variant is a row in `product_variants`: `name` (what the shopper sees on the selector and in the
  basket, e.g. `16GB / 1TB`, `Tactile brown`, `Graphite`), `option_values` (the same choice as
  structured data, e.g. `{"Memory":"16GB","Storage":"1TB"}`, string values only), `price`,
  `compare_at_price` (list price, shown struck through only when it is greater than `price`),
  `sku` (unique, no whitespace), `position` (selector order), `is_active`, `weight_g`.
- Variant names are unique per product (case-insensitive).
- **The variant is the unit of sale.** Cart lines are keyed by `variantId`; `place_order` /
  `quote_order` (09) price every line from `product_variants` and check stock on the variant;
  `order_items` reference `variant_id` and snapshot `product_name`, `brand`, `variant_name`, `sku`
  and `image_url`, so order history stays readable after a product or variant is deleted.
- Same-price choices (switch type, colour) are still separate variants: they are separate stock.
  Per-variant images are not modelled; the product gallery applies to every variant.
- `attributes.specs` (below) describes the **base (cheapest) configuration**. What differs between
  variants lives in `option_values` — e.g. `specs.ram_gb = 16` and the upgraded variant's
  `option_values.Memory = "32GB"`.

## 2. The "from" price rollup

`products.price` and `products.compare_at_price` are the **from-price**: what cards, sorting,
price filters and price-based collection rules use. They are **derived — never write them**.

| Derived column on `products` | Rule |
| --- | --- |
| `price` | price of the cheapest **active** variant (ties: lowest `position`, then lowest id) |
| `compare_at_price` | that variant's `compare_at_price` **only when it is greater than its price**, else `NULL` |
| `default_variant_id` | that cheapest active variant — what "Add to basket" on a card adds |
| `variant_count` | number of **active** variants |
| `rating_avg`, `rating_count` | written only by 11_reviews through `_apply_product_rating()` |

- Recomputed by a trigger on every variant insert, delete, and update of `price`,
  `compare_at_price`, `is_active`, `position` or `product_id` (moving a variant re-derives both
  products).
- With **no active variant**, `variant_count = 0` and `default_variant_id = NULL`; the last price is
  kept but nobody sees it: **shoppers only ever see products with `is_active AND variant_count > 0`**
  (enforced by RLS, by `search_products`, facets and availability).
- Writes to derived columns from anywhere else (admin UI, SQL editor) are silently restored by the
  `products_20_derived` trigger. A freshly inserted product starts at price 0 with no variants and is
  invisible until its first active variant is added. The admin UI therefore saves the product, then
  its variants, and reads the price back.
- The catalogue writers mark their own UPDATE with the transaction-local setting
  `app.catalogue_rollup = 'on'` (and restore it); clients cannot set it.

Example (seed 30): Vanta G15 has one `Standard` variant at Rs. 489,900 (was 549,900) → the card shows
**Rs. 489,900**, struck-through **Rs. 549,900**. The demo seed carries only what the old static site had,
so every seeded product has exactly one variant; the owner adds priced configurations in the admin.

## 3. `products.attributes` — the domain facts (BUILD_SPEC §4.4)

`attributes` is a JSON object (CHECK). Shape:

```jsonc
{
  "specs":      { /* per category, snake_case keys, numbers as numbers */ },
  "highlights": ["short selling points", "…"],          // ≤ 5, shown as bullets on the product page
  "use_cases":  ["everyday" | "gaming" | "creative" | "mobile" | "backup" | "ergonomic"],   // from the product name only
  "in_the_box": ["what ships in the box", "…"]
}
```

A product **without `specs` is excluded from the finder** (guessing is worse than omitting).
The tables below are the full vocabulary. A product carries **only the keys its spec line or name
actually states** — an absent key means unknown (never invented). The demo seed parses the old
card spec line, so it fills only a few keys per product.

### laptops

| key | type | example / allowed | unit |
| --- | --- | --- | --- |
| `cpu` | string | `"AMD Ryzen 7 7840HS"` | |
| `gpu` | string | `"NVIDIA GeForce RTX 4060 (8GB)"`, `"Intel Arc Graphics (integrated)"` | |
| `ram_gb` | number | `16` | GB |
| `storage_gb` | number | `1000` (1 TB = 1000) | GB (decimal) |
| `storage_type` | string | `"NVMe SSD"`, `"SATA SSD"`, `"HDD"` | |
| `display` | string | `"15.6-inch FHD IPS, 165Hz"` | |
| `refresh_hz` | number | `165` | Hz |
| `weight_kg` | number | `2.3` | kg |
| `battery_wh` | number | `90` | Wh |
| `battery_h` | number | `6` (rated) | hours |
| `os` | string | `"Windows 11 Home"` | |
| `ports` | string[] | `["2x Thunderbolt 4 (USB-C)", "HDMI 2.1"]` | |

### storage

| key | type | example / allowed | unit |
| --- | --- | --- | --- |
| `capacity_gb` | number | `1000` | GB (decimal) |
| `type` | string | `"Portable SSD"` \| `"External HDD"` \| `"Flash drive"` \| `"Desktop drive"` | |
| `interface` | string | `"USB-C (USB 3.2 Gen 2, 10Gbps)"` | |
| `read_mbps` | number | `1050` | MB/s |
| `speed_mbps` | number | `1050` — a single unlabelled figure (the old spec line said "1050MB/s") | MB/s |
| `write_mbps` | number | `1000` | MB/s |
| `rugged` | string \| null | `"IP65"` or `null` | |
| `weight_g` | number | `58` | g |

### keyboards

| key | type | example / allowed | unit |
| --- | --- | --- | --- |
| `layout` | string | `"60%"` \| `"75%"` \| `"TKL"` \| `"Full-size"` | |
| `switch` | string | `"Linear red"`, `"Low-profile scissor"`, `"Linear red or tactile brown (hot-swap)"` | |
| `hot_swap` | boolean | `true` | |
| `connectivity` | string[] | `["Bluetooth 5.1", "2.4GHz wireless", "USB-C wired"]` | |
| `backlight` | string | `"RGB"`, `"Per-key RGB"`, `"White"`, `"None"` | |
| `keycaps` | string | `"Double-shot PBT"` | |
| `battery_h` | number \| null | `100`; `null` for wired-only | hours |
| `weight_g` | number | `1050` | g |
| `os_compat` | string[] | `["Windows", "macOS", "Linux"]` | |

### mice

| key | type | example / allowed | unit |
| --- | --- | --- | --- |
| `sensor` | string | `"26K optical gaming sensor"` | |
| `dpi_max` | number | `26000` | DPI |
| `weight_g` | number | `58` | g |
| `connectivity` | string[] | `["Bluetooth", "2.4GHz USB receiver"]`, `["USB wired"]` | |
| `buttons` | number | `6` | |
| `grip` | string | `"palm"` \| `"claw"` \| `"fingertip"` \| `"vertical"` | |
| `battery_h` | number \| null | `1680`; `null` for wired | hours (rated) |
| `silent` | boolean | `true` | |

Conventions: wireless connectivity strings contain `Bluetooth`, `2.4GHz` or `wireless`; wired ones
contain `wired` (the finder's "avoid wired only" reads this). A keyboard with `backlight` other than
`None` counts as lit; one containing `RGB` counts for "avoid RGB".

### Other product facts

- `subtitle` — the one-line spec shown on cards (`Ryzen 7 · RTX 4060 · 16GB · 1TB SSD`).
- `brand` (required) — the product line for the demo brands (`Vanta`, `AeroSlim`, `Bolt X`, …).
- `tags` — lower-case facet words, normalised by trigger (trimmed, lower-cased, de-duplicated,
  ≤ 30, ≤ 40 chars): category singular (`laptop`, `mouse`), brand slug, and facets such as
  `gaming`, `wireless`, `rgb`, `usb-c`, `portable`, `ergonomic`, `silent`, `student`, `backup`.
  Rule collections match on them.
- `warranty_months` — rendered on the product page (`null` = not stated).
- Merchandising flags: `is_new` (New arrivals, newest `created_at` first), `is_bestseller`
  (topped-up best sellers), `is_featured`, `is_flash_deal` (Flash deals; the countdown is
  `store_settings.flash_sale_ends_at`), `sort_order` (ascending in every list).
- `seo_title`, `seo_description` — optional overrides (pages derive them when NULL).

## 4. Images

- `image_urls` is the gallery; **`image_url` always equals `image_urls[1]`** (a trigger keeps
  them in step both ways: editing the gallery updates `image_url`; setting `image_url` moves it to
  the front; clearing the only image empties both). There is **no placeholder** — `NULL` means no
  image and the UI falls back to its CSS scene/wireframe art.
- `cutout_url` — the transparent cut-out used by category pop-outs, collection tiles and banners.
- `categories.stage_image_url` — the photographic stage behind a category's cut-out; `scene`
  (`night|paper|lime|violet`) is the CSS fallback.
- Allowed URL forms everywhere: site-relative paths (`/images/products/lap-01.webp`, the existing
  files in `public/images/**`) or `https://…` (Supabase Storage). Protocol-relative `//host` and
  other schemes are refused (`invalid_image_url`, SQLSTATE 22023). ≤ 12 gallery images.
- Admin uploads: bucket `product-images` (`products/<id>/<n>.webp`) and `content-images`
  (homepage/blog art). Public buckets, raster images only (webp/jpeg/png/avif), 5 MB, admin-only
  writes.

## 5. Categories

`id` is the slug (`/shop?category=<id>`), `name`, `tagline` (pop-out card line), `description`,
`stage_image_url`, `scene`, `hero_product_id` (the product whose cut-out fronts the card; cleared
automatically if that product is deleted), `sort_order`, `is_active`. Category counts shown to
shoppers are **real** (`catalogue_facets()` counts visible products). Renaming a slug cascades to
products; deleting a category that still has products is refused (FK, SQLSTATE 23503) — move the
products first. Deactivating a category hides it from navigation and facets only; its products stay
visible (in /shop, search, collections) until they are deactivated themselves.

## 6. Collections

Two independent axes (blueprint §7.3):

- **`type`** — how membership is kept: `manual` (the admin picks products) or `automated` (rules).
- **`kind`** — what it means: `curated` (themes like *Work from home*), `brand`, `line`.

Membership lives in **one** join table, `product_collections (product_id, collection_id, position,
source)`, for both types; `source` is `manual` or `rule`. The storefront reads that one table.

**Rules** (`collections.rules`, `match = 'any' | 'all'`):

```json
[{ "field": "price", "relation": "lt", "value": "25000" },
 { "field": "tag",   "relation": "equals", "value": "wireless" }]
```

| field | relations | value | compares |
| --- | --- | --- | --- |
| `tag` | `equals`, `not_equals` | text | `products.tags` (case-insensitive) |
| `brand` | `equals`, `not_equals` | text | `products.brand` (case-insensitive) |
| `category` | `equals`, `not_equals` | category id | `products.category_id` |
| `price` | `lt`, `lte`, `gt`, `gte` | number | the **from-price** |
| `is_new` | `equals` | `true` / `false` | `products.is_new` |
| `is_flash_deal` | `equals` | `true` / `false` | `products.is_flash_deal` |

- Malformed rules are refused at write time (`invalid_collection_rules:<why>`, SQLSTATE 22023),
  ≤ 20 rules. An automated collection with no rules has no members.
- **Re-evaluated both ways**: a product change (tags, brand, category, from-price via its variants,
  `is_new`, `is_flash_deal`) re-checks that product against every automated collection; a
  collection change (`type`, `rules`, `match`) re-checks every product. Only `source = 'rule'`
  rows are rewritten — manual rows are never touched, and a manual row for the same pair wins.
  Switching a collection to `manual` drops its rule rows and keeps its manual ones.
- Rule membership ignores `is_active`; shoppers only ever see memberships of **active collections**
  and **visible products** (RLS).
- Homepage "Featured collections": `is_featured = true`, ordered by `sort_order`; the tile text is
  `title` + `subtitle`; the tile art is `feature_product_ids = [back, front]` (≤ 2 product ids,
  de-duplicated) rendered from those products' `cutout_url`. Unknown or hidden ids render nothing.

Seeded (demo): `work-from-home`, `gaming-zone`, `campus-kit`, `creator-studio` — manual and featured,
each with exactly its two homepage tile products as members (what the old site showed). No automated
collections are seeded; the rules above are for the owner to use.

**Member order on the storefront:** hand-picked (manual) members come first, in the admin's order; rule members follow (they are written with `position = 100000`, see `_refresh_collection_rule_members` in 04 and `admin_set_collection_products` in 23).

## 7. Inventory tracking

- `inventory` has **one row per tracked variant** (`variant_id` PK, `product_id` derived from the
  variant, `stock_level ≥ 0`, `low_stock_threshold` default 3). Admin-only table.
- **No row = not tracked = always sells.** A row makes the variant tracked; `stock_level = 0` means
  sold out. When in doubt, create a row with 0 — the safe default (blueprint lesson 18).
- `place_order` (09) locks tracked rows `FOR UPDATE` in a fixed order, refuses with
  `out_of_stock:<name>` when short, and decrements inside the order transaction; cancelling an order
  (`admin_set_order_status`) restocks tracked variants. Editing a product never resets stock.
- Shoppers see stock only through two functions:
  - `get_product_availability(product_ids)` → `(product_id, variant_id, stock_level, low_stock)` for
    tracked, active variants of visible products, ≤ 24 products per call. `low_stock` =
    `0 < stock_level ≤ threshold`; the threshold itself is never exposed. A variant **absent** from
    the result is untracked (available) — unless it is inactive, which the storefront already knows.
    Suggested bands: absent → "In stock"; `stock_level = 0` → "Sold out"; `low_stock` → "Only N left";
    otherwise "In stock".
  - `list_in_stock_product_ids()` → ids of visible products with at least one active variant that is
    untracked or has stock > 0 (for "in stock only" filters and the finder).

## 8. Search

`products.search_vector` (06) is maintained by trigger with weights **A** name + brand, **B**
subtitle, **C** category id + name, tags, active variant names / SKUs / option values, **D**
description + `attributes` strings (specs, highlights, use_cases, in_the_box). It is refreshed on
product writes, variant writes and category renames. `search_products(q, limit, offset)` prefix-
matches every word, folds simple plurals, ignores filler words, and falls back to trigram similarity
for typos when `pg_trgm` is installed. See SQL_NOTES for the exact contract.
