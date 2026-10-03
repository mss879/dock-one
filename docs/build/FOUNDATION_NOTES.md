# Foundation notes (F-core) — read before writing TypeScript

The TypeScript foundation every work package builds on. BUILD_SPEC wins over this file; this file is
the "how" for the modules BUILD_SPEC §5 names. Signatures below are **final** — keep them. If one
truly must change, change it and every caller in the same step, and say so in your report.

Stack as installed: `next 16.3.5` (Turbopack, **Proxy** not middleware, `cacheComponents` **off**),
`react 19.3`, `@supabase/supabase-js 2.116`, `@supabase/ssr 0.12.7`, `zod 4.6`, `resend 6.28`,
`ai 7.0` + `@ai-sdk/openai 4.0` (blueprint §3.1 — swapped in by the orchestrator after phase 1), `sanitize-html 2.17`, `server-only`. Only F installs packages.

---

## 0. Ground rules

- **Server modules start with `import "server-only";`** (a leading `// STUB …` comment is fine).
  Exceptions, on purpose: `lib/supabase/proxy.ts` and `lib/site-lock-gate.ts` — they are bundled into
  `src/proxy.ts`, which is compiled outside the React server graph. Never import either from a client file.
- **Client modules start with `"use client";`.** Pure logic both sides need lives in plain modules
  (no directive): `delivery.ts`, `currency-shared.ts`, `catalogue-shared.ts`, `settings-shared.ts`,
  `sri-lanka.ts`, `html.ts`, `rpc-errors.ts`, `cache-tags.ts`, `finder/questions.ts`, `env.ts`.
- **Secrets never touch `lib/env.ts`.** Public config = `lib/env.ts`; secrets = `lib/env.server.ts`.
- **No service-role key.** Privileged work = SECURITY DEFINER RPCs that re-check the caller.
- **Storefront pages never read cookies** (no `createSessionSupabase`, `getSessionUser`,
  `getAdminIdentity` in `(store)` pages/layouts that should stay static). Read the viewer
  client-side with `useViewer()`. Account, checkout, order and admin pages are dynamic and may.
- **Every shopper-facing price renders through `<Price>`.** Emails/admin use `formatLKR`.
- **Errors are a contract:** SQL raises `snake_code:detail`; routes map with `mapRpcError`.
- Stale `… 2.ts` files in `.next/types` (iCloud duplicates — blueprint lesson 45) break `tsc`.
  The repo lives in `~/Desktop`; if `tsc` suddenly reports duplicate identifiers under `.next/`,
  delete `.next` (build output only) and rebuild.

---

## 1. Module map

| Area | Files |
| --- | --- |
| Env | `lib/env.ts` (public), `lib/env.server.ts` (secrets), `.env.example` |
| Supabase | `lib/supabase/server.ts` (stateless anon), `session.ts` (cookie-bound), `browser.ts` (singleton, PKCE), `proxy.ts` (session refresh for `src/proxy.ts`) |
| Request boundary | `lib/request-guard.ts`, `lib/rate-limit.ts`, `lib/rpc-errors.ts`, `lib/http.ts`, `lib/html.ts` |
| Proxy + config | `src/proxy.ts`, `next.config.ts`, `lib/site-lock-gate.ts` + `lib/site-lock.ts` (WP-H) |
| Caching | `lib/cache-tags.ts`, `lib/cache.ts`, `app/api/admin/revalidate/route.ts`, `lib/revalidate-client.ts` |
| Identity | `lib/auth.ts` (server), `lib/viewer.ts` (client) |
| Settings | `lib/settings-shared.ts`, `lib/settings.ts` (server), `lib/delivery.ts` (pure), `components/providers/StoreSettingsProvider.tsx` |
| Catalogue | `lib/catalogue-shared.ts` (client-safe), `lib/catalogue.ts` (server) |
| Money | `lib/format.ts` (`formatLKR`), `lib/currency-shared.ts`, `lib/currency.ts` (client), `app/api/rates/route.ts`, `components/ui/Price.tsx`, `components/ui/CurrencySelect.tsx` |
| Client stores | `lib/store.ts`, `lib/cart.ts`, `lib/wishlist.ts`, `lib/offer-code.ts`, `lib/checkout-autosave.ts`, `lib/analytics.ts`, `lib/viewed.ts`, `lib/toast.ts` |
| Product UI | `components/product/{ProductCard,ProductImage,AddToCartButton,WishlistButton,Rating}.tsx` |
| UI primitives | `components/ui/{form,Breadcrumbs,PageHeader,Notice,Pagination,EmptyState,Price,CurrencySelect,Button,Sheet,Toaster,Wireframe,Scene,Cross,SectionHeader}.tsx` |
| Email | `lib/email/send.ts`, `lib/email/layout.ts` (templates: `lib/email/templates/<feature>.ts`, by owners) |
| Finder | `lib/quiz.ts` (client-safe engine), `lib/quiz-catalogue.ts` (server), `lib/attribute-lexicon.ts`, `lib/attribute-axes.ts` (WP-F; the early `lib/finder/` stubs were folded in and deleted) |
| Feature islands (were stubs; all implemented) | `components/reviews/ProductReviews.tsx` (WP-J), `components/analytics/{ConsentBanner,PageViewTracker}.tsx` (WP-H), `components/assistant/AssistantWidget.tsx` (WP-I), `components/account/AuthListener.tsx` (WP-D), `components/seo/SiteJsonLd.tsx` (WP-A) |
| App shell | `app/layout.tsx` (html/body/fonts/metadata only), `app/(store)/layout.tsx` (chrome + providers + stubs), `app/(store)/page.tsx`, `app/(store)/cart/page.tsx` |
| Misc | `lib/sri-lanka.ts` |

---

## 2. Environment — `lib/env.ts`, `lib/env.server.ts`

```ts
// lib/env.ts (client-safe)
export const supabaseUrl: string;            // origin, "" when unset/invalid
export const supabaseAnonKey: string;
export const isSupabaseConfigured: boolean;
export const supabaseStoragePublicPrefix: string; // `${supabaseUrl}/storage/v1/object/public/`
export const siteUrl: string;                 // NEXT_PUBLIC_SITE_URL origin, fallback https://dockonesolutions.com
export function absoluteUrl(path?: string): string; // absoluteUrl("/order/DO-10001")
export const isProduction: boolean;

// lib/env.server.ts (server-only)
export const serverEnv: {
  rateLimitSecret; cartRecoverySecret; maintenanceSecret;
  resendApiKey; resendFromEmail; resendReplyTo; orderNotificationEmail;
  openaiApiKey; assistantModel, assistantVisionModel /* overrides only; defaults live in lib/assistant/model.ts */;
  assistantVisionEnabled: boolean; timezone /* "Asia/Colombo" */; clientIpHeader /* "x-real-ip" */; fxApiUrl;
};
export const MIN_SECRET_LENGTH = 20;
export function isUsableSecret(value: string): boolean; // mirrors verify_job_secret (≥ 20 chars)
```

Job routes (`/api/cart-recovery`, `/api/maintenance`) must check `isUsableSecret(serverEnv.xSecret)`
**before** any DB work and compare the bearer token in constant time
(`crypto.timingSafeEqual` over SHA-256 digests).

**Boot/build guard:** `next.config.ts` throws in the production build/server phases when the
Supabase URL or anon key is missing. In development everything fails soft (empty catalogue,
default settings, one warning).

---

## 3. Supabase clients

| Function | File | Identity | Use |
| --- | --- | --- | --- |
| `createServerSupabase(): SupabaseClient` | `lib/supabase/server.ts` | anon, stateless (one shared instance) | public reads, anon-granted RPCs, `checkRateLimit` |
| `await createSessionSupabase(): Promise<SupabaseClient>` | `lib/supabase/session.ts` | the signed-in viewer (cookies) | `auth.uid()` RPCs, owner-scoped reads, admin checks. Makes the route dynamic |
| `getBrowserSupabase(): SupabaseClient \| null` | `lib/supabase/browser.ts` | the viewer (browser) | sign in/out, wishlist sync, dashboard. **null when unconfigured — handle it** |
| `updateSession(request)` / `carrySessionCookies(from, to)` | `lib/supabase/proxy.ts` | — | only `src/proxy.ts` |

Both server factories throw `SupabaseNotConfiguredError` when env is missing — check
`isSupabaseConfigured` first in routes (→ 503), readers go through `readFailSoft` which swallows it.
Both also send `ROUTE_HEADERS` (`lib/supabase/route-token.ts`: `x-dockone-route` = HMAC of
RATE_LIMIT_SECRET), which the database's direct-call brake (`_trusted_route_call()`, 01) checks —
so always call the public write RPCs through these factories, never through a hand-made client.
The browser client never sends it.
Wrap every browser auth call in try/catch (blueprint §14 lesson 30).

PostgREST gotchas already handled in the foundation — follow the same patterns:
- a select naming a column that doesn't exist fails the **whole** query → use the shared field constants;
- `categories ↔ products` has **two** relationships (`products.category_id`, `categories.hero_product_id`):
  embed with a hint — `category:categories!category_id(name)` — or you get PGRST201;
- `DECIMAL` may arrive as a string → normalise with `toNumber()` from `catalogue-shared`;
- `RETURNS TABLE` RPCs come back as arrays → `data?.[0]`;
- responses are capped at 1000 rows (Supabase `max-rows`) → page with `.range()` for aggregates;
- typed selects: the client is untyped (`Database = any`); a select built from a `string` constant
  returns loosely typed rows — read them as `Record<string, unknown>` and normalise.

---

## 4. Request boundary

```ts
// lib/request-guard.ts (server-only)
readJsonBody<T = unknown>(request: Request, maxBytes = DEFAULT_BODY_LIMIT /* 64 KB */): Promise<{ ok: true; body: T } | { ok: false; status: 400 | 413 }>
ASSISTANT_BODY_LIMIT = 512 KB
isPlainObject(value): value is Record<string, unknown>
isBot(company: unknown): boolean              // honeypot field is always named `company`
isSameOrigin(request): boolean                // admin POSTs: refuse cross-origin browsers
cleanText(value, max): string                 // trimmed, control chars stripped, "" for non-strings
cleanLine(value, max): string                 // + whitespace collapsed (names, subjects)
toInt(value, min, max): number | null
toFiniteNumber(value, min, max): number | null
isEmailAddress(value): value is string
isUuid(value): value is string

// lib/rate-limit.ts (server-only) — fails OPEN, logs once; loud startup error in prod when the secret is unusable
checkRateLimit(supabase: SupabaseClient, bucketName: string, max: number, windowSeconds: number): Promise<boolean> // true = allowed
clientKey(request): string                    // CLIENT_IP_HEADER → x-real-ip → first x-forwarded-for → "unknown"
hashKey(value): string                        // HMAC-SHA256(RATE_LIMIT_SECRET), 32 hex, lower-cased input
bucket(feature, dimension, value): string     // "checkout:email:<hmac>"
ipBucket(feature, request): string            // "checkout:ip:<hmac of client ip>"

// lib/rpc-errors.ts (plain)
isMissingFunction(e) / isMissingRelation(e) / isMissingColumn(e) / isSchemaMismatch(e) / isTransportError(e)
parseDbError(message): { code: string | null; detail: string }
mapRpcError(error, table: ErrorTable, fallback?): { status; message; code }
  // missing fn/table → 503 MIGRATIONS_PENDING_MESSAGE; DB unreachable → 503; table hit; 42501 → 403; else 500
logDbError(scope, error, migration?)          // "[scope] is missing — apply migration NN_x.sql (…)"
MIGRATIONS_PENDING_MESSAGE, GENERIC_ERROR_MESSAGE, NOT_AUTHORISED_MESSAGE, TEMPORARILY_UNAVAILABLE_MESSAGE
type ErrorTable = Record<string, { status: number; message: string | ((detail: string) => string) }>

// lib/http.ts (server-only)
json(data, status = 200, init?)               // NextResponse.json with Cache-Control: private, no-store
jsonError(message, status, code?)             // { error, code? }
noContent()                                    // 204 (beacons)
MESSAGES.{invalid, tooLarge, slowDown, unavailable, notConfigured, generic, forbidden}

// lib/html.ts (plain)
escapeHtml(value): string
jsonLdScript(data): string                    // for <script type="application/ld+json" dangerouslySetInnerHTML>
safeNext(value, fallback = "/"): string       // open-redirect guard for ?next= / ?redirect=
```

### 4.1 Public-write route template (blueprint §6.7, real helper names)

```ts
// src/app/api/<feature>/route.ts
import type { NextRequest } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { json, MESSAGES } from "@/lib/http";
import { checkRateLimit, ipBucket, bucket } from "@/lib/rate-limit";
import { cleanLine, isBot, isEmailAddress, isPlainObject, readJsonBody } from "@/lib/request-guard";
import { logDbError, mapRpcError, type ErrorTable } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server"; // or createSessionSupabase() when auth.uid() matters

const ERRORS: ErrorTable = {
  out_of_stock: { status: 409, message: (name) => `“${name}” is out of stock.` },
  invalid_email: { status: 422, message: "Enter a valid email address." },
};

export async function POST(request: NextRequest) {
  if (!isSupabaseConfigured) return json({ error: MESSAGES.notConfigured }, 503);

  const parsed = await readJsonBody(request);                                   // 1. bounded read
  if (!parsed.ok) return json({ error: MESSAGES.invalid }, parsed.status);
  if (!isPlainObject(parsed.body)) return json({ error: MESSAGES.invalid }, 422);
  const body = parsed.body;

  if (isBot(body.company)) return json({ ok: true });                           // 2. honeypot: indistinguishable

  const supabase = createServerSupabase();
  if (!(await checkRateLimit(supabase, ipBucket("feature", request), 10, 3600))) // 3. throttle BEFORE db work
    return json({ error: MESSAGES.slowDown }, 429);

  const email = cleanLine(body.email, 254).toLowerCase();                        // 4. validate, trim, clamp, allowlist
  if (!isEmailAddress(email)) return json({ error: "Enter a valid email address." }, 422);
  if (!(await checkRateLimit(supabase, bucket("feature", "email", email), 3, 3600)))
    return json({ error: MESSAGES.slowDown }, 429);

  const { data, error } = await supabase.rpc("feature_fn", { p_email: email }); // 5. ONE trusted write
  if (error) {
    logDbError("feature", error, "NN_feature.sql");
    const mapped = mapRpcError(error, ERRORS);                                   // 6. code → copy + status
    return json({ error: mapped.message }, mapped.status);
  }

  try { await sendSideEffects(data); } catch (e) { console.error("[feature] side effect failed", e); } // 7. fail-soft
  return json({ ok: true });
}
```

Admin routes: `if (!isSameOrigin(request)) → 403`, then `const admin = await getAdminIdentity(); if (!admin) → 403`,
then the session client (`createSessionSupabase()`) so the RPC's own `is_admin()` check sees the operator.

---

## 5. Proxy, headers, config

- `src/proxy.ts`: `/admin/*` except `/admin/signin` → `updateSession()`; signed out → **307**
  `/admin/signin?redirect=<path+query>` (cookies carried, `X-Robots-Tag: noindex`). Always-open paths
  (skip the lock): `/admin`, `/api/admin`, `/api/site-lock`, `/api/cart-recovery`, `/api/maintenance`,
  `/auth`, `/launching-soon`. Everything else → `siteLockGate(request)` (WP-H). Session areas
  refreshed: `/account`, `/wishlist`, `/checkout`, `/order`, `/admin`. The matcher skips `_next/*`,
  `/images/*`, favicon, `sitemap.xml`, `robots.txt`, `manifest.*` and any path with a static-file
  extension (slugs never contain dots). API routes **do** pass through (the lock answers them with JSON 503).
- `next.config.ts`: `poweredByHeader: false`; CSP (`default-src 'self'`, `script-src 'self' 'unsafe-inline'`
  (+ `'unsafe-eval'` in dev only), `img-src 'self' data: blob: <supabase origin>`, `connect-src 'self'
  <supabase https> <supabase wss>`, `frame-ancestors 'none'`, `form-action 'self'`, `object-src 'none'`,
  `upgrade-insecure-requests` only on an https production site); `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(),
  geolocation=(), payment=(), usb=()`, HSTS (prod), `X-Robots-Tag` on `/admin` and `/api`.
  `images.remotePatterns` = our Supabase host + port + `/storage/v1/object/public/**` only.
  `experimental.proxyClientMaxBodySize: "650kb"` (exists in 16.3 — note it **truncates**, it does
  not reject; our own `readJsonBody` caps (≤ 512 KB) are what enforce 413).
- **CSP consequences for you:** no third-party scripts, fonts, iframes or images. Anything external
  (maps embed, analytics vendor) needs a CSP change in `next.config.ts` — ask F. The Anthropic API
  and the FX API are called server-side, so they need nothing.

---

## 6. Caching — `lib/cache.ts`

```ts
CACHE_TAGS = { catalogue: "catalogue", content: "content", settings: "settings", reviews: "reviews" }
type CacheTag; ALL_CACHE_TAGS; isCacheTag(v)                // also in lib/cache-tags.ts (client-safe)
DEFAULT_REVALIDATE = 300                                   // seconds: safety net only
cached(fn, keyParts, { tags, revalidate? }): typeof fn     // React cache() ∘ unstable_cache
readFailSoft(scope, read, fallback): Promise<T>            // logs + returns fallback, never throws
throwDbError(scope, error, migration?): never              // inside cached fns
class DataReadError
```

Rules:
1. `cacheComponents` stays **off**; no `"use cache"`. Use `cached()` for every storefront DB read.
2. The function passed to `cached()` must **throw** on error (`throwDbError`) — `unstable_cache` never
   stores a thrown result — and the exported reader wraps it in `readFailSoft` to return a fallback.
   Never `return []` from inside a cached fn on a transient error: that empty result would be cached.
3. Define cached fns at module level, pass every input as an argument (JSON-serialisable, normalised
   first — it's the cache key), return plain JSON (no Date/Map), never read `cookies()`/`headers()` inside.
4. A page that calls cached readers is static/ISR (smallest `revalidate` wins) and inherits their tags.
5. After a confirmed admin write, call `revalidateStorefront(tags)` (client) →
   `POST /api/admin/revalidate { tags }` → `revalidateTag(tag, { expire: 0 })`. Pick tags by what the
   write touches: products/categories/collections → `catalogue`; hero/promo/content blocks/CMS/blog →
   `content`; store settings → `settings`; reviews (+ rating rollups) → `reviews` **and** `catalogue`.
6. Live data never goes through the cache: stock (`get_product_availability`), quotes, orders, anything
   per-person. Call those from route handlers/dynamic pages or client islands.
7. Stale-on-error is built in: when a cached entry is stale and the refresh throws (DB blip),
   `unstable_cache` keeps serving the last good value and logs `revalidating cache with key: …` with the
   function source and the `DataReadError`. That log is expected during an outage — it is not a crash.
   Only a cold cache with a failing DB falls through to `readFailSoft`'s fallback.

### 6.1 Adding a cached fetcher (copy this)

```ts
// src/lib/content.ts (WP-B) — server-only
import "server-only";
import { CACHE_TAGS, cached, readFailSoft, throwDbError } from "@/lib/cache";
import { createServerSupabase } from "@/lib/supabase/server";

const MIGRATION = "16_storefront_content.sql";
const FIELDS: string = "id, title, image_url, position";            // one constant per shape

const readHeroSlides = cached(
  async (): Promise<HeroSlide[]> => {
    const { data, error } = await createServerSupabase().from("hero_slides").select(FIELDS).eq("is_active", true).order("position");
    if (error) throwDbError("content.getHeroSlides", error, MIGRATION);      // never cached
    return (Array.isArray(data) ? data : []).map(normalizeHeroSlide).filter(Boolean) as HeroSlide[];
  },
  ["content:hero-slides:v1"],                                               // bump v1 when the shape changes
  { tags: [CACHE_TAGS.content] },
);

export function getHeroSlides(): Promise<HeroSlide[]> {
  return readFailSoft("content.getHeroSlides", readHeroSlides, []);         // section hides when empty
}
```

With arguments: `const readX = cached(async (id: string) => …, ["x:v1"], {…})` and
`export async function getX(id) { if (!isSlug(id)) return null; return readFailSoft("x", () => readX(id), null); }`.

---

## 7. Identity

```ts
// lib/auth.ts (server-only; reads cookies → dynamic)
getSessionUser(): Promise<{ id; email; emailConfirmed } | null>   // react cache()
getAdminIdentity(): Promise<{ id; email } | null>                // customers.is_admin via the viewer's session; any doubt → null
requireAdmin(redirectTo = "/admin"): Promise<AdminIdentity>      // → /admin/signin?redirect=…
requireUser(redirectTo: string): Promise<SessionUser>            // → /signin?next=…
```
Admin layout AND page both call `requireAdmin()` (P9). Don't wrap `requireX()` in try/catch (redirect throws).

```ts
// lib/viewer.ts (client)
useViewer(): { status: "loading" | "guest" | "signed_in"; user: { id; email; firstName } | null; isAdmin }
refreshViewer(): Promise<void>        // call after sign-in / sign-out / profile edit
SIGNED_OUT_EVENT = "dockone:signed-out"   // AuthListener (WP-D) dispatches on window; WP-I clears the transcript
```
One shared store per tab; "loading" on the server and during hydration (render a neutral state, not
"guest", until it resolves). `isAdmin` is display-only.

---

## 8. Settings and delivery

```ts
// lib/settings.ts (server-only)
getStoreSettings(): Promise<StoreSettings>          // cached (tag settings); defaults on any failure
toPublicSettings(s): PublicStoreSettings            // strips updatedBy
// re-exports: StoreSettings, PublicStoreSettings, DEFAULT_STORE_SETTINGS, DEFAULT_PUBLIC_SETTINGS,
//             SOCIAL_NETWORKS, phoneDigits, deliveryFeeFor, amountToFreeDelivery, DeliveryRule, Fulfillment

// lib/settings-shared.ts (plain) — StoreSettings mirrors store_settings (03) in camelCase:
// storeName, deliveryFee, freeDeliveryThreshold (null = never free), codEnabled, codMaxTotal,
// bankTransferEnabled, bankAccountName, bankName, bankBranch, bankAccountNumber, bankTransferInstructions
// (the optional extra note), pickupEnabled, pickupAddress, pickupNote, phone, whatsapp,
// email, address, mapUrl, openingHours, businessRegNo, socials{facebook,instagram,tiktok,youtube},
// announcement, tickerItems[], acceptedPaymentLabels[], flashSaleTitle, flashSaleEndsAt (ISO),
// returnsWindowDays, warrantyNote, updatedAt, updatedBy
normalizeStoreSettings(row), phoneDigits(phone): string | null   // for wa.me / tel:
bankAccountFromSettings(s): BankAccount | null   // {accountName, bankName, branch, accountNumber, instructions}; null while name/bank/number missing
bankTransferReady(s): boolean                    // = 09's bank_transfer_available (enabled AND the account set)
normalizeBankAccount(raw), accountNumberDigits(n) // view_order's bank_transfer object; digits-only for the copy button
// UI: components/order/BankTransferDetails.tsx (the card: checkout, order page, fallback, /track,
// account orders, admin preview) + components/ui/CopyButton.tsx; lib/format.ts formatLKRExact/plainAmount

// lib/delivery.ts (plain) — MIRROR of place_order/quote_order in 09_order_rpcs.sql
deliveryFeeFor(subtotal, rule: { deliveryFee; freeDeliveryThreshold }, fulfillment: "delivery" | "pickup" = "delivery"): number
amountToFreeDelivery(subtotal, rule): number | null      // null = never free
```
Client: `useStoreSettings(): PublicStoreSettings` from `components/providers/StoreSettingsProvider`
(the `(store)` layout provides it; outside it returns the SQL defaults). Server components in the
storefront call `getStoreSettings()` directly (cached — free to call many times).

---

## 9. Catalogue

```ts
// lib/catalogue-shared.ts (client-safe)
type ProductCardData = { id; slug; name; brand; subtitle; categoryId; categoryName; price /* from */; compareAtPrice;
  imageUrl; cutoutUrl; ratingAvg; ratingCount; isNew; isFlashDeal; isBestseller; defaultVariantId; defaultVariantName; variantCount }
type ProductVariant = { id; sku; name; optionValues: Record<string,string>; price; compareAtPrice; position; weightG }
type ProductDetail = ProductCardData & { description; images[]; tags[]; attributes: { specs; highlights; useCases; inTheBox };
  warrantyMonths; isFeatured; seoTitle; seoDescription; variants: ProductVariant[]; createdAt; updatedAt }
type Category = { id; name; tagline; description; stageImageUrl; scene; sortOrder; seoTitle; seoDescription; heroProductId;
  hero: ProductArt | null; productCount: number | null }
type Collection = { id; title; subtitle; description; coverImage; kind; type; isFeatured; sortOrder; featureProductIds;
  featureProducts: ProductArt[]; seoTitle; seoDescription }
type ProductArt = { id; slug; name; categoryId; imageUrl; cutoutUrl }
type Brand = { name; count }
productHref(product|id) → /product/<id> · categoryHref(id) → /shop?category=<id> · collectionHref(id) → /collection/<id>
(blueprint §5 routes; other /shop URLs via shopHref()/parseShopQuery() in lib/catalogue-queries.ts — WP-A)
WP-A added to catalogue.ts: excludeIds, getProductById, findProductById/findCategory/findCollection (throw on DB error instead of a false 404), getCatalogueFacets, searchProductIds/searchRankedProductIds, fetchAvailability, getInStockProductIds, getSoldOutProductIds, getRelatedProducts.
discountPercent({ price, compareAtPrice }) · isSlug(v) · safeImageUrl(v) · toNumber/toNullableNumber/toText/toStringArray/toIdArray
normalizeProductCard/normalizeProductDetail/normalizeVariant/normalizeCategory/normalizeCollection/normalizeProductArt/normalizeAttributes

// lib/catalogue.ts (server-only; re-exports everything above)
PRODUCT_CARD_FIELDS, PRODUCT_DETAIL_FIELDS                 // the ONLY product column lists
getCategories(): Promise<Category[]>
getCategory(id): Promise<Category | null>
listProducts(filters?: { categoryId; brands; collectionId; priceMin; priceMax; flags: ("new"|"flash"|"bestseller"|"featured")[];
  ids; sort: "featured"|"newest"|"price_asc"|"price_desc"|"rating"|"name"; page; pageSize /* ≤ 48, default 24 */ })
  : Promise<{ items: ProductCardData[]; total; page; pageSize }>
getProductBySlug(slug): Promise<ProductDetail | null>      // null → notFound()
getProductsByIds(ids): Promise<ProductCardData[]>          // requested order; unknown ids dropped (P4)
getCollections({ featured? }): Promise<Collection[]>
getCollection(slug): Promise<Collection | null>            // its products: listProducts({ collectionId: slug })
getBrands({ categoryId? }): Promise<Brand[]>
PRODUCT_SORTS, PRODUCT_FLAGS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE
```
Semantics (verified against 04_catalogue.sql + seed 30 through a real PostgREST): the from-price and
`defaultVariantId` are the cheapest active variant (ties → position → id), exactly like the SQL rollup;
`variantCount` = active variants; products with none are invisible (RLS) and never listed.
`listProducts({ collectionId, sort: "featured" })` follows the collection's own member order.
Images are only ever same-origin paths (`/images/...`) or our Supabase public storage; anything else is
nulled so `next/image` can't throw — `ProductImage` then draws the category wireframe.

Example (server component):
```tsx
const { items, total } = await listProducts({ categoryId: "laptops", sort: "price_asc", page });
return <ul>{items.map((p) => <li key={p.id}><ProductCard product={p} /></li>)}</ul>;
```

---

## 10. Money

```ts
// lib/currency-shared.ts (plain)
BASE_CURRENCY = "LKR"; CURRENCIES (LKR, USD, GBP, EUR, AUD, INR, AED with decimals); CURRENCY_CODES; FALLBACK_RATES (per 1 LKR)
formatMoney(amountLkr, currency = "LKR", rates = FALLBACK_RATES): string   // LKR ≡ formatLKR ("Rs. 489,900"); else "USD 1,469.70"
sanitizeRates(raw): { rates; live }; isCurrencyCode(v)

// lib/currency.ts (client)
useCurrency(): { currency; setCurrency; rate; live; isBase; format(amountLkr); currencies }
setCurrency(code); loadRates(); CURRENCY_EVENT = "dockone:currency"
```
- `<Price amount={lkr} compareAt? className? compareClassName? />` — with `compareAt` it returns
  `<s>` + `<span>` siblings so your wrapper keeps its layout. Server render/hydration = LKR always.
- `<CurrencySelect tone="dark" />` — the "Cur: LKR" switcher for the top bar (WP-B wires it in `TopBar`).
- Checkout sends `currency` + `exchangeRate` = `useCurrency().currency` / `.rate` (recorded, never charged).
- `GET /api/rates` → `{ base: "LKR", rates, live }`, 12 h data cache, CDN-cacheable, static fallback.

---

## 11. Client stores

```ts
// lib/cart.ts — key "dockone.cart.v2"; ONE writer
type CartLine = { productId; variantId; qty; slug; name; brand; variantName; price; compareAtPrice; imageUrl; categoryId }
MAX_QTY = 10 /* = c_max_qty in place_order */; MAX_LINES = 50; clampQty(n)
cart.add(line: Omit<CartLine, "qty">, qty = 1): boolean      // false = invalid snapshot or 50 lines already
cart.setQty(variantId, qty) · cart.remove(variantId) · cart.clear() · cart.open() · cart.close() · cart.getLines()
cart.reprice(updates: { variantId; price?; compareAtPrice?; name?; brand?; variantName?; slug?; imageUrl?; remove? }[])
  // writes only when something changed (safe to call after every /api/quote)
cartSnapshotFromCard(product: ProductCardData): Omit<CartLine,"qty"> | null
cartSnapshotFromVariant(product: ProductDetail, variant: ProductVariant): Omit<CartLine,"qty">
useCart(): { lines; count; subtotal; savings; delivery /* delivery fulfilment, 0 when empty */; toFreeDelivery /* null = never free */; freeDeliveryThreshold }
useCartDrawer(): boolean
// add/remove call track("add_to_cart" | "remove_from_cart", …)

// lib/wishlist.ts — key "dockone.wishlist.v2" (numeric ids); WP-D makes it hybrid, same API
wishlist.toggle(productId: number, meta?: { name? }): boolean   // true = saved afterwards; tracks wishlist_add
wishlist.has(id) · wishlist.replace(ids) · wishlist.clear() · useWishlist(): number[]

// lib/offer-code.ts — ONE key, two slots (24 h TTL each)
//   parked  = a code the assistant offered: PREFILLS the promo field, the shopper presses Apply (blueprint §9.4, §10.7)
//   applied = the code the shopper applied with the promo field: every quote uses it, survives reloads
stashOfferCode(code): boolean (park) · takeOfferCode(): string | null (parked, read-and-clear) · peekOfferCode()
getAppliedOfferCode() · setAppliedOfferCode(code | null)
normalizeOfferCode(v) · OFFER_CODE_EVENT = "dockone:offer-code" (detail { code: string | null, applied: boolean })
// components/cart/useCartQuote.ts: discountCode (applied) · parkedCode (prefill) · consumeParkedOfferCode() (checkout mount)

// lib/checkout-autosave.ts — types + stable id are real; the debounced capture is WP-E's
type CheckoutShipping = { street; city; district; postal_code; country }   // = customers columns = p_shipping keys
type CheckoutDraft = { email; firstName; lastName; phone; fulfillment; shipping; items[{productId,variantId,qty,name,variantName,price}]; subtotal; currency; exchangeRate }
useCheckoutAutosave(draft: CheckoutDraft | null): { cartId: string }       // "" during SSR/hydration
getCheckoutCartId(): string · resetCheckoutCartId()                         // rotate after an order is placed

// lib/analytics.ts — plain module (browser parts guarded), WP-H
EVENT_TYPES / type EventType = page_view | product_view | category_view | collection_view | search | add_to_cart
  | remove_from_cart | begin_checkout | wishlist_add | finder_complete | assistant_open | newsletter_signup
track(type, { productId?, value?, metadata? }?): void (sends nothing until analytics consent); isEventType(v)
readConsent() · setConsent() · openConsentSettings() · subscribeConsent() — hooks in components/analytics/useConsent.ts
```
Shared window events: `dockone:currency`, `dockone:offer-code`, `dockone:signed-out`.
Storage keys in use (the privacy page, seed 33, lists them — add any new key there too): localStorage
`dockone.cart.v2`, `dockone.wishlist.v2`, `dockone.currency.v1`, `dockone.offer.v1` (parked + applied codes),
`dockone.consent.v1`, `dockone.assistant.v1` (transcript, 24 h), `dockone.assistant.nudge-off.v1`,
`dockone.analytics.v1` (30-min idle session id, only after consent), `dockone.admin.nav.v1` (admin sidebar only);
sessionStorage `dockone.rates.v1`, `dockone.checkout.id`, `dockone.order.v1` (last confirmation — no token,
address or phone), `dockone.viewed.v1`, `dockone.finder.v1`, `dockone.assistant.nudges.v1`; cookies: Supabase auth
(`sb-…-auth-token`) and `dockone_site_access` (site-lock bypass, 30 days).

Plain (server-importable) twins of client-only constants — import these from server code:
`lib/cart-limits.ts` (`MAX_QTY`, `MAX_LINES` — mirror place_order), `lib/offer-code-shared.ts`
(`normalizeOfferCode` — mirrors CHECK discounts_code_format). `clientKey()` in `lib/rate-limit.ts` accepts any
`{ headers }` object, so a server component can call `clientKey({ headers: await headers() })`.

---

## 12. Product components (keep the look)

- `ProductCard({ product: ProductCardData, sizes? })` — identical markup; "From" above the price when
  `variantCount > 1`; hides the category label/subtitle when null.
- `ProductImage({ src, alt, categoryId, kind: "tile" | "cutout", sizes, className, wireClassName?, eager?, decorative? })`
  — `next/image`; tiles 1000×1000; cut-outs nominal 1200×800 — give them a CSS width + `h-auto` and the
  file's natural aspect wins; `src` null/unsafe → `Wireframe`.
- `AddToCartButton({ product, tone?: "light"|"dark"|"violet", variant?: "icon"|"full" })` — one variant:
  adds the default variant + toast; several (or none): the same control is a link to the product page,
  labelled "Choose options for <name>" ("Choose options" text in the full variant).
- `WishlistButton({ productId: number, productName, tone? })`.
- `Rating({ value, count, tone? })` — renders **nothing** when `count` is 0 (no invented scores).
- `Wireframe({ category: string })` — generic drawing for unknown categories.

## 13. UI primitives (DESIGN.md look)

- `components/ui/form.tsx` ("use client"): `Field({ label, hint?, error?, required?, optional?, id?, className?, children })`
  wires id/aria-describedby/aria-invalid/required into `Input`, `Select`, `Textarea` placed inside it;
  `Checkbox({ label, hint?, …input })`; `RadioCard({ title, description?, meta?, icon?, …input })` (group in a
  `<fieldset>` with a `<legend>`); `FieldError`.
- `Breadcrumbs({ items: { label; href? }[] })` · `PageHeader({ title, crumbs?, eyebrow?, description?, actions? })`
  (renders the page `<h1>` "Title_") · `Notice({ tone: "info"|"success"|"error", title?, children })` (no reds) ·
  `Pagination({ page, pageCount, pathname, searchParams?, param? })` (links; page 1 drops the param) ·
  `EmptyState({ code, title, description?, action?: { label; href }, glyph? })`.
- `lib/sri-lanka.ts`: `DISTRICTS` (25), `District`, `isDistrict`, `normalizeLkPhone(v) → "+94771234567" | null`,
  `isLkPhone`, `formatLkPhone`, `isLkMobile`.

## 14. Email

```ts
// lib/email/send.ts (server-only) — never throws
isEmailConfigured: boolean
sendEmail({ to, subject, html, text, replyTo? }): Promise<{ ok: true; id } | { ok: false; skipped; reason }>
getOwnerNotificationAddress(): string | null   // ORDER_NOTIFICATION_EMAIL → RESEND_REPLY_TO → RESEND_FROM_EMAIL
validEmail(v) · bareAddress(v)

// lib/email/layout.ts (server-only) — tables + inline styles only
emailShell({ preheader, eyebrow, heading, intro, bodyHtml, footerLines? }): string
esc(v) · emailHref(href) · emailButton(href, label) · emailRows([{ label, value, strong? }]) · emailParagraph(text) ·
emailNote(text, "lime"|"violet") · emailLabel(text) · textFromLines(lines, footerLines?) · EMAIL_COLORS
```
Template recipe (`lib/email/templates/<feature>.ts`): build a typed payload with a constructor
function (lesson 34), render `emailShell({ … bodyHtml: emailRows(…) + emailButton(…) })`, and send the
same facts as `text: textFromLines([...])`. Never interpolate request-body prose (open mailer, lesson 10).
Footer lines come from `getStoreSettings()` (phone, address, business reg. no. — only when set).

---

## 15. Former stubs and how they are wired (all implemented by their owners)

| Stub | Where it's mounted | Owner | Contract |
| --- | --- | --- | --- |
| `ProductReviews({ productId, productName, ratingAvg, ratingCount })` (async server) | product page (WP-A places it) | WP-J | renders the section |
| `ConsentBanner()`, `PageViewTracker()` | `(store)/layout.tsx` | WP-H | no props |
| `AssistantWidget()` | `(store)/layout.tsx` | WP-I | no props |
| `AuthListener()` | `(store)/layout.tsx` | WP-D | no props; dispatches `SIGNED_OUT_EVENT` |
| `SiteJsonLd()` (async server) | `(store)/layout.tsx` | WP-A | Organization JSON-LD via `jsonLdScript` |
| `track()` | `lib/analytics.ts` (cart + wishlist already call it) | WP-H | final signature |
| `useCheckoutAutosave()` | checkout (WP-C) | WP-E | final signature |
| `recommend(answers, catalogue, { limit? }) → { productId, match, style, reason }[]` | `lib/quiz.ts` (+ `fetchCatalogueForFinder()` in `lib/quiz-catalogue.ts`) | WP-F | used by /discover, /api/quiz and the assistant |
| `siteLockGate(request) → NextResponse \| null` | `src/proxy.ts` | WP-H | no `server-only`; cheap; fail open |

Replace a stub's body in place; keep the file, export name and props.

## 16. TEMP adapters — removed

The `TEMP(foundation)` adapters are gone: the homepage and chrome read the database through `lib/content.ts`
(WP-B), `/cart` reads the live catalogue (WP-C), and `src/data/products.ts`, `src/data/image-manifest.json` and
`src/lib/images.ts` were deleted. `src/data/site.ts` keeps only the brand constants (name, wordmark, description).

## 17. Known gaps (as of F-core hand-off) — since resolved

- The admin shell was built by F-admin (ADMIN_KIT.md); every tab is implemented.
- `Hero.tsx` / `TopBar.tsx` read the delivery rule from `store_settings` through `<Price>`, and the "Cur:" readout
  is the `CurrencySelect`; `site.ts` no longer exports `productHref`, `promoCodes` or `paymentMethods` (WP-B).
- `ProfileMenu` / `HeaderCounters` are wired to the viewer and wishlist stores (WP-D).
- The dev-only `images.dangerouslyAllowLocalIP` is enabled **only** when the Supabase URL is a loopback
  host (a local Supabase stack), still pinned to that host/port/path.

## 18. How F-core was verified

- `npx tsc --noEmit -p .` and `npx eslint src next.config.ts` — clean.
- `next build` with dummy env (DB unreachable) — succeeds; readers fail soft; `/` and `/cart` are ISR (5 min).
- Unit tests (node:test, 13 groups) for delivery, money, JSON-LD/safeNext, rpc-errors, phones/districts,
  finder allowlist, catalogue/settings normalisers, offer codes, readJsonBody/honeypot/same-origin, rate-limit keys.
- Integration: migrations 01–06 + seed 30 on a throwaway Postgres (`scripts/db/verify.sh --keep`) behind a real
  PostgREST (Homebrew build, reports v16.3) with a `/rest/v1` shim — every catalogue/settings reader, all sorts/filters/pagination, collection
  order, brands, and the real `check_rate_limit` RPC (limit bites on call 3; wrong secret fails open).
- `next start` smoke against that stack: security headers, ISR headers, `/admin/*` → 307 with no markup,
  revalidate route 403 without a session / cross-origin, `/api/rates` live rates.
