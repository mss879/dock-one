/**
 * Admin catalogue (WP-K) — the one module the Products, Categories, Collections and Inventory
 * tabs share (P6): write options (constraint names → copy, business codes → copy), row types,
 * the product/category/collection form models, validation that mirrors the database, the
 * payload for `admin_save_product` (23_admin_catalogue.sql), the per-category spec templates
 * (BUILD_SPEC §4.4) and every read the tabs make.
 *
 * Plain module (client-side use only; no React): reads take the caller's Supabase client — in
 * the tabs that is the admin's browser client through `useAdminQuery`, so RLS applies. Writes go
 * through the kit (`lib/admin/write.ts`): tables under admin RLS with `{ error }` + row-count
 * checks, or the admin RPCs in 23. Blueprint §11.2 (Products/Collections/Inventory write paths),
 * §11.3 (engineering rules). Contract: docs/build/SQL_NOTES.md (04, 05, 23).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CacheTag } from "@/lib/cache-tags";
import {
  safeImageUrl,
  toNullableNumber,
  toNumber,
  toStringArray,
  toText,
  type SpecValue,
} from "@/lib/catalogue-shared";
import type { ErrorTable } from "@/lib/rpc-errors";
import { unwrapPage, unwrapRow, unwrapRows, type AdminPage } from "./query";
import { orIlike } from "./search";

// ── Migrations and cache tags ─────────────────────────────────────────────────

export const CATALOGUE_MIGRATION = "04_catalogue.sql";
export const INVENTORY_MIGRATION = "05_inventory.sql";
export const ADMIN_CATALOGUE_MIGRATION = "23_admin_catalogue.sql";
/** Products, variants, categories and collections are cached under this tag (lib/cache.ts). */
export const CATALOGUE_TAGS: CacheTag[] = ["catalogue"];

// ── Write options: constraint names and business codes → admin copy ──────────

const detail = (text: string) => text || "The database refused this change.";

/** `code:detail` errors from admin_save_product and 04's product triggers (22023). */
export const PRODUCT_SAVE_ERRORS: ErrorTable = {
  invalid_product: { status: 422, message: detail },
  invalid_slug: { status: 422, message: detail },
  invalid_variant: { status: 422, message: detail },
  invalid_stock: { status: 422, message: detail },
  product_not_found: { status: 422, message: detail },
  variants_required: { status: 422, message: detail },
  duplicate_variant_name: { status: 422, message: detail },
  duplicate_sku: { status: 422, message: detail },
  variant_name_taken: { status: 422, message: detail },
  sku_taken: { status: 422, message: detail },
  invalid_image_url: {
    status: 422,
    message: (d) => `An image address isn't allowed (${d}). Use images uploaded here, or site paths that start with “/”.`,
  },
  invalid_tags: { status: 422, message: (d) => `Tags: ${d}.` },
  not_authorised: { status: 403, message: "Only an admin can do this. Sign in again as an admin." },
};

/** 04/05 constraint names the product save can hit (23505 / 23514 / 23503). */
export const PRODUCT_CONSTRAINTS: Record<string, string> = {
  products_slug_key: "Another product already uses this slug. Choose a different one.",
  products_slug_format: "The slug can only use lower-case letters, digits and hyphens (up to 120 characters).",
  products_text_lengths:
    "A text field is too long (brand ≤ 80, name ≤ 200, card spec line ≤ 200, description ≤ 10,000, SEO title ≤ 120, SEO description ≤ 320 characters).",
  products_warranty_valid: "Warranty must be between 0 and 240 months.",
  products_attributes_object: "Specs must be a JSON object.",
  products_category_id_fkey: "The chosen category doesn't exist any more. Pick another and save again.",
  product_variants_price_valid: "Variant prices must be between Rs. 0 and Rs. 100,000,000.",
  product_variants_sku_key: "Another variant already uses one of these SKUs. SKUs must be unique across the store.",
  product_variants_product_name_key: "Two variants of this product can't share a name.",
  product_variants_sku_format: "SKUs are 1–64 characters without spaces.",
  product_variants_name_valid: "Variant names are 1–120 characters.",
  product_variants_options_valid: "Variant options must be name/value text pairs.",
  product_variants_weight_valid: "Variant weights must be between 0 and 1,000,000 g.",
  product_costs_cost_valid: "Cost prices can't be negative.",
  inventory_levels_valid: "Stock must be 0–1,000,000 and the low-stock threshold 0–100,000.",
};

export const PRODUCT_WRITE = {
  entity: "product",
  migration: ADMIN_CATALOGUE_MIGRATION,
  constraints: PRODUCT_CONSTRAINTS,
  errors: PRODUCT_SAVE_ERRORS,
  revalidate: CATALOGUE_TAGS,
};

/** Direct table writes on products (activate/deactivate, delete) — 04 under admin RLS. */
export const PRODUCT_TABLE_WRITE = {
  entity: "product",
  migration: CATALOGUE_MIGRATION,
  constraints: PRODUCT_CONSTRAINTS,
  errors: PRODUCT_SAVE_ERRORS,
  revalidate: CATALOGUE_TAGS,
};

export const CATEGORY_WRITE = {
  entity: "category",
  migration: CATALOGUE_MIGRATION,
  constraints: {
    categories_pkey: "Another category already uses this slug. Choose a different one.",
    categories_id_format: "The slug can only use lower-case letters, digits and hyphens (up to 64 characters).",
    categories_scene_valid: "Pick one of the four scenes.",
    categories_text_lengths:
      "A field is too long, or the stage image isn't a site path or an https address (name ≤ 80, tagline ≤ 160, description ≤ 4,000, SEO title ≤ 120, SEO description ≤ 320 characters).",
    products_category_id_fkey:
      "This category still has products. Move them to another category (or delete them) first — or hide the category instead.",
    categories_hero_product_id_fkey: "The chosen hero product doesn't exist any more. Pick another and save again.",
  } as Record<string, string>,
  revalidate: CATALOGUE_TAGS,
};

export const COLLECTION_ERRORS: ErrorTable = {
  invalid_collection_rules: { status: 422, message: (d) => `Rules: ${d}.` },
  collection_not_found: { status: 422, message: detail },
  invalid_products: { status: 422, message: detail },
  unknown_product: { status: 422, message: detail },
  not_authorised: { status: 403, message: "Only an admin can do this. Sign in again as an admin." },
};

export const COLLECTION_WRITE = {
  entity: "collection",
  migration: CATALOGUE_MIGRATION,
  constraints: {
    collections_pkey: "Another collection already uses this slug. Choose a different one.",
    collections_id_format: "The slug can only use lower-case letters, digits and hyphens (up to 80 characters).",
    collections_type_valid: "Choose hand-picked or automatic membership.",
    collections_match_valid: "Choose whether products must match any rule or all rules.",
    collections_kind_valid: "Choose curated, brand or line.",
    collections_rules_array: "Rules must be a list.",
    collections_feature_valid: "Pick at most two tile products.",
    collections_text_lengths:
      "A field is too long, or the cover image isn't a site path or an https address (title ≤ 120, tile line ≤ 200, description ≤ 4,000, SEO title ≤ 120, SEO description ≤ 320 characters).",
  } as Record<string, string>,
  errors: COLLECTION_ERRORS,
  revalidate: CATALOGUE_TAGS,
};

export const COLLECTION_MEMBERS_WRITE = { ...COLLECTION_WRITE, migration: ADMIN_CATALOGUE_MIGRATION };

export const INVENTORY_WRITE = {
  entity: "stock record",
  migration: INVENTORY_MIGRATION,
  constraints: {
    inventory_levels_valid: "Stock must be 0–1,000,000 and the low-stock threshold 0–100,000.",
    inventory_pkey: "Stock tracking is already on for this variant. Reload the list.",
    inventory_variant_product_fkey: "This variant doesn't exist any more. Reload the list.",
  } as Record<string, string>,
  revalidate: CATALOGUE_TAGS,
};

// ── Small helpers ─────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** "AeroSlim 14 Ultrabook" → "aeroslim-14-ultrabook" (accents folded; anything else → "-"). */
export function slugify(text: string, max = 120): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

export function slugProblem(slug: string, max: number): string | null {
  if (!slug) return "A slug is required.";
  if (slug.length > max) return `Up to ${max} characters.`;
  if (!SLUG_RE.test(slug)) return "Lower-case letters, digits and hyphens only, starting with a letter or digit.";
  return null;
}

const bool = (value: unknown) => value === true;
const trimmed = (value: string) => value.trim();
const orNull = (value: string) => {
  const text = value.trim();
  return text === "" ? null : text;
};

/** Embedded PostgREST relations arrive as an object or a one-element array. */
function firstRow(value: unknown): Row | null {
  const row = Array.isArray(value) ? value[0] : value;
  return row && typeof row === "object" ? (row as Row) : null;
}

/** `rel(count)` embeds arrive as [{ count: n }]. */
function embeddedCount(value: unknown): number {
  const row = firstRow(value);
  return row ? Math.max(0, Math.trunc(toNumber(row.count, 0))) : 0;
}

function plainObject(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Row) } : {};
}

// ── Categories and brands (selects, filters, pickers) ─────────────────────────

export type CategoryOption = { id: string; name: string; isActive: boolean };

export async function fetchCategoryOptions(supabase: SupabaseClient, signal?: AbortSignal): Promise<CategoryOption[]> {
  let query = supabase.from("categories").select("id, name, is_active, sort_order").order("sort_order").order("name").range(0, 499);
  if (signal) query = query.abortSignal(signal);
  return unwrapRows<Row>(await query, CATALOGUE_MIGRATION)
    .map((row) => ({ id: String(row.id ?? ""), name: toText(row.name, 120) ?? String(row.id ?? ""), isActive: row.is_active !== false }))
    .filter((option) => option.id !== "");
}

/** Distinct brands (case-insensitive), from up to 1,000 products — suggestions and the list filter. */
export async function fetchBrands(supabase: SupabaseClient, signal?: AbortSignal): Promise<string[]> {
  let query = supabase.from("products").select("brand").order("brand").range(0, 999);
  if (signal) query = query.abortSignal(signal);
  const seen = new Map<string, string>();
  for (const row of unwrapRows<Row>(await query, CATALOGUE_MIGRATION)) {
    const brand = toText(row.brand, 80);
    if (brand && !seen.has(brand.toLowerCase())) seen.set(brand.toLowerCase(), brand);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
}

/** Distinct tags in use (from up to 1,000 products) — suggestions for tag rules. */
export async function fetchTags(supabase: SupabaseClient, signal?: AbortSignal): Promise<string[]> {
  let query = supabase.from("products").select("tags").range(0, 999);
  if (signal) query = query.abortSignal(signal);
  const tags = new Set<string>();
  for (const row of unwrapRows<Row>(await query, CATALOGUE_MIGRATION)) for (const tag of toStringArray(row.tags, 30)) tags.add(tag);
  return [...tags].sort();
}

// ── Product list (view admin_product_list, 23) ────────────────────────────────

export type AdminProductListRow = {
  id: number;
  slug: string;
  name: string;
  brand: string;
  subtitle: string | null;
  categoryId: string | null;
  categoryName: string | null;
  price: number;
  compareAtPrice: number | null;
  variantCount: number;
  variantsTotal: number;
  imageUrl: string | null;
  isActive: boolean;
  isNew: boolean;
  isBestseller: boolean;
  isFeatured: boolean;
  isFlashDeal: boolean;
  sortOrder: number;
  trackedVariants: number;
  stockTotal: number | null;
  lowStockVariants: number;
  hasLowStock: boolean;
  updatedAt: string | null;
};

export function normalizeProductListRow(row: Row): AdminProductListRow {
  const price = toNumber(row.price, 0);
  const compare = toNullableNumber(row.compare_at_price);
  return {
    id: toNumber(row.id, 0),
    slug: String(row.slug ?? ""),
    name: toText(row.name, 200) ?? "",
    brand: toText(row.brand, 80) ?? "",
    subtitle: toText(row.subtitle, 200),
    categoryId: toText(row.category_id, 64),
    categoryName: toText(row.category_name, 80),
    price,
    compareAtPrice: compare !== null && compare > price ? compare : null,
    variantCount: toNumber(row.variant_count, 0),
    variantsTotal: toNumber(row.variants_total, 0),
    imageUrl: safeImageUrl(row.image_url),
    isActive: row.is_active !== false,
    isNew: bool(row.is_new),
    isBestseller: bool(row.is_bestseller),
    isFeatured: bool(row.is_featured),
    isFlashDeal: bool(row.is_flash_deal),
    sortOrder: toNumber(row.sort_order, 100),
    trackedVariants: toNumber(row.tracked_variants, 0),
    stockTotal: toNullableNumber(row.stock_total),
    lowStockVariants: toNumber(row.low_stock_variants, 0),
    hasLowStock: bool(row.has_low_stock),
    updatedAt: toText(row.updated_at, 64),
  };
}

export type ProductStatusFilter = "all" | "active" | "inactive";
export type ProductFlagFilter = "" | "new" | "bestseller" | "featured" | "flash";
export type ProductListFilters = {
  search: string;
  categoryId: string;
  brand: string;
  status: ProductStatusFilter;
  flag: ProductFlagFilter;
  lowStock: boolean;
};
export const EMPTY_PRODUCT_FILTERS: ProductListFilters = { search: "", categoryId: "", brand: "", status: "all", flag: "", lowStock: false };

/** Sortable columns of the list (the DataTable's sort keys map 1:1 to view columns). */
export const PRODUCT_SORT_COLUMNS = ["name", "brand", "category_name", "price", "sort_order", "stock_total", "updated_at"] as const;
export type ProductSort = { key: string; direction: "asc" | "desc" } | null;

const FLAG_COLUMNS: Record<Exclude<ProductFlagFilter, "">, string> = {
  new: "is_new",
  bestseller: "is_bestseller",
  featured: "is_featured",
  flash: "is_flash_deal",
};

export async function fetchProductPage(
  supabase: SupabaseClient,
  options: { filters: ProductListFilters; sort: ProductSort; from: number; to: number; signal?: AbortSignal },
): Promise<AdminPage<AdminProductListRow>> {
  const { filters, sort } = options;
  let query = supabase.from("admin_product_list").select("*", { count: "exact" });
  const search = orIlike(["name", "brand", "slug", "subtitle", "skus"], filters.search);
  if (search) query = query.or(search);
  if (filters.categoryId === "__none__") query = query.is("category_id", null);
  else if (filters.categoryId) query = query.eq("category_id", filters.categoryId);
  if (filters.brand) query = query.eq("brand", filters.brand);
  if (filters.status === "active") query = query.eq("is_active", true);
  if (filters.status === "inactive") query = query.eq("is_active", false);
  if (filters.flag) query = query.eq(FLAG_COLUMNS[filters.flag], true);
  if (filters.lowStock) query = query.eq("has_low_stock", true);
  const key = sort && (PRODUCT_SORT_COLUMNS as readonly string[]).includes(sort.key) ? sort.key : "sort_order";
  const ascending = sort ? sort.direction === "asc" : true;
  query = query.order(key, { ascending, nullsFirst: false });
  if (key !== "name") query = query.order("name", { ascending: true });
  query = query.order("id", { ascending: true }).range(options.from, options.to);
  if (options.signal) query = query.abortSignal(options.signal);
  const page = unwrapPage<Row>(await query, ADMIN_CATALOGUE_MIGRATION);
  return { ...page, rows: page.rows.map(normalizeProductListRow) };
}

/** Another product already uses this slug? (the unique constraint stays the authority). */
export async function isProductSlugTaken(supabase: SupabaseClient, slug: string, exceptId: number | null, signal?: AbortSignal): Promise<boolean> {
  let query = supabase.from("products").select("id").eq("slug", slug);
  if (exceptId) query = query.neq("id", exceptId);
  query = query.limit(1);
  if (signal) query = query.abortSignal(signal);
  return unwrapRows(await query, CATALOGUE_MIGRATION).length > 0;
}

// ── Product picker / art lookups (products table, 04) ─────────────────────────

export type ProductPick = {
  id: number;
  slug: string;
  name: string;
  brand: string;
  categoryId: string | null;
  imageUrl: string | null;
  cutoutUrl: string | null;
  isActive: boolean;
  variantCount: number;
};

const PICK_FIELDS = "id, slug, name, brand, category_id, image_url, cutout_url, is_active, variant_count";

export function normalizeProductPick(row: Row): ProductPick | null {
  const id = toNumber(row.id, 0);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    id,
    slug: String(row.slug ?? ""),
    name: toText(row.name, 200) ?? `#${id}`,
    brand: toText(row.brand, 80) ?? "",
    categoryId: toText(row.category_id, 64),
    imageUrl: safeImageUrl(row.image_url),
    cutoutUrl: safeImageUrl(row.cutout_url),
    isActive: row.is_active !== false,
    variantCount: toNumber(row.variant_count, 0),
  };
}

/** Up to `limit` products matching a search (name, brand, slug), optionally in one category. */
export async function searchProducts(
  supabase: SupabaseClient,
  options: { search: string; categoryId?: string | null; limit?: number; signal?: AbortSignal },
): Promise<ProductPick[]> {
  let query = supabase.from("products").select(PICK_FIELDS);
  const search = orIlike(["name", "brand", "slug"], options.search);
  if (search) query = query.or(search);
  if (options.categoryId) query = query.eq("category_id", options.categoryId);
  query = query.order("is_active", { ascending: false }).order("sort_order").order("name").limit(Math.min(Math.max(options.limit ?? 12, 1), 50));
  if (options.signal) query = query.abortSignal(options.signal);
  return unwrapRows<Row>(await query, CATALOGUE_MIGRATION)
    .map(normalizeProductPick)
    .filter((p): p is ProductPick => p !== null);
}

/** Products by id, in the requested order; unknown ids are dropped. */
export async function fetchProductsByIds(supabase: SupabaseClient, ids: readonly number[], signal?: AbortSignal): Promise<ProductPick[]> {
  const wanted = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (wanted.length === 0) return [];
  let query = supabase.from("products").select(PICK_FIELDS).in("id", wanted);
  if (signal) query = query.abortSignal(signal);
  const found = unwrapRows<Row>(await query, CATALOGUE_MIGRATION)
    .map(normalizeProductPick)
    .filter((p): p is ProductPick => p !== null);
  return wanted.map((id) => found.find((p) => p.id === id)).filter((p): p is ProductPick => Boolean(p));
}

// ── Specs (BUILD_SPEC §4.4, docs/domain-model.md §3) ──────────────────────────

export type SpecField =
  | { key: string; label: string; kind: "text"; hint?: string; suggestions?: readonly string[] }
  | { key: string; label: string; kind: "number"; unit?: string; decimals?: boolean; hint?: string }
  | { key: string; label: string; kind: "list"; hint?: string; suggestions?: readonly string[] }
  | { key: string; label: string; kind: "bool" }
  | { key: string; label: string; kind: "choice"; options: readonly string[] };

/** The typed spec editor per category id. Categories without a template keep their specs as they are. */
export const SPEC_TEMPLATES: Readonly<Record<string, readonly SpecField[]>> = {
  laptops: [
    { key: "cpu", label: "Processor (CPU)", kind: "text" },
    { key: "gpu", label: "Graphics (GPU)", kind: "text" },
    { key: "ram_gb", label: "Memory", kind: "number", unit: "GB" },
    { key: "storage_gb", label: "Storage", kind: "number", unit: "GB", hint: "Decimal: 1 TB = 1000" },
    { key: "storage_type", label: "Storage type", kind: "text", suggestions: ["NVMe SSD", "SATA SSD", "HDD"] },
    { key: "display", label: "Display", kind: "text" },
    { key: "refresh_hz", label: "Refresh rate", kind: "number", unit: "Hz" },
    { key: "weight_kg", label: "Weight", kind: "number", unit: "kg", decimals: true },
    { key: "battery_wh", label: "Battery capacity", kind: "number", unit: "Wh", decimals: true },
    { key: "battery_h", label: "Battery life (rated)", kind: "number", unit: "hours", decimals: true },
    { key: "os", label: "Operating system", kind: "text" },
    { key: "ports", label: "Ports", kind: "list", hint: "One port per entry, e.g. 2x Thunderbolt 4 (USB-C)" },
  ],
  storage: [
    { key: "capacity_gb", label: "Capacity", kind: "number", unit: "GB", hint: "Decimal: 1 TB = 1000" },
    { key: "type", label: "Type", kind: "choice", options: ["Portable SSD", "External HDD", "Flash drive", "Desktop drive"] },
    { key: "interface", label: "Interface", kind: "text" },
    { key: "read_mbps", label: "Read speed", kind: "number", unit: "MB/s" },
    { key: "write_mbps", label: "Write speed", kind: "number", unit: "MB/s" },
    { key: "rugged", label: "Rugged rating", kind: "choice", options: ["IP65"] },
    { key: "weight_g", label: "Weight", kind: "number", unit: "g" },
  ],
  keyboards: [
    { key: "layout", label: "Layout", kind: "choice", options: ["60%", "75%", "TKL", "Full-size"] },
    { key: "switch", label: "Switches", kind: "text" },
    { key: "hot_swap", label: "Hot-swap sockets", kind: "bool" },
    { key: "connectivity", label: "Connectivity", kind: "list", suggestions: ["Bluetooth", "2.4GHz wireless", "USB-C wired"] },
    { key: "backlight", label: "Backlight", kind: "text", suggestions: ["RGB", "Per-key RGB", "White", "None"] },
    { key: "keycaps", label: "Keycaps", kind: "text" },
    { key: "battery_h", label: "Battery life (rated)", kind: "number", unit: "hours", hint: "Leave empty for wired-only" },
    { key: "weight_g", label: "Weight", kind: "number", unit: "g" },
    { key: "os_compat", label: "Works with", kind: "list", suggestions: ["Windows", "macOS", "Linux"] },
  ],
  mice: [
    { key: "sensor", label: "Sensor", kind: "text" },
    { key: "dpi_max", label: "Maximum DPI", kind: "number", unit: "DPI" },
    { key: "weight_g", label: "Weight", kind: "number", unit: "g" },
    { key: "connectivity", label: "Connectivity", kind: "list", suggestions: ["Bluetooth", "2.4GHz USB receiver", "USB wired"] },
    { key: "buttons", label: "Buttons", kind: "number" },
    { key: "grip", label: "Grip", kind: "choice", options: ["palm", "claw", "fingertip", "vertical"] },
    { key: "battery_h", label: "Battery life (rated)", kind: "number", unit: "hours", hint: "Leave empty for wired mice" },
    { key: "silent", label: "Silent clicks", kind: "bool" },
  ],
};

export function specTemplate(categoryId: string | null | undefined): readonly SpecField[] | null {
  return categoryId && Object.prototype.hasOwnProperty.call(SPEC_TEMPLATES, categoryId) ? SPEC_TEMPLATES[categoryId] : null;
}

/** attributes.use_cases vocabulary (BUILD_SPEC §4.4) — the finder's `use` answers. */
export const USE_CASES: readonly { value: string; label: string }[] = [
  { value: "everyday", label: "Everyday" },
  { value: "gaming", label: "Gaming" },
  { value: "creative", label: "Creative work" },
  { value: "mobile", label: "On the move" },
  { value: "backup", label: "Backup" },
  { value: "ergonomic", label: "Ergonomic" },
];
export const MAX_HIGHLIGHTS = 5;
export const MAX_IN_THE_BOX = 20;

function specsFrom(value: unknown): Record<string, SpecValue> {
  const out: Record<string, SpecValue> = {};
  for (const [key, raw] of Object.entries(plainObject(value))) {
    if (raw === null || typeof raw === "string" || typeof raw === "boolean") out[key] = raw;
    else if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
    else if (Array.isArray(raw) && raw.every((item) => typeof item === "string")) out[key] = raw as string[];
    // other shapes (objects, mixed arrays) are not ours to edit: keepSpecs() carries them over untouched
  }
  return out;
}

function isEmptySpec(value: SpecValue | undefined): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

/**
 * Set one spec key the way docs/domain-model.md wants it: a value → written; emptied → `null`
 * when the key was already there ("unknown", never invented), removed when it never was (so an
 * untouched product doesn't grow empty keys — a product without specs stays out of the finder).
 */
export function withSpec(
  specs: Record<string, SpecValue>,
  original: Readonly<Record<string, unknown>>,
  key: string,
  value: SpecValue | undefined,
): Record<string, SpecValue> {
  const next = { ...specs };
  if (isEmptySpec(value)) {
    if (Object.prototype.hasOwnProperty.call(original, key)) next[key] = null;
    else delete next[key];
  } else {
    next[key] = value as SpecValue;
  }
  return next;
}

// ── Product form ──────────────────────────────────────────────────────────────

export type OptionPair = { key: string; name: string; value: string };

export type VariantForm = {
  /** React key: `v<id>` for saved variants, a client uid for new rows. */
  key: string;
  id: number | null;
  name: string;
  sku: string;
  options: OptionPair[];
  price: number | null;
  compareAtPrice: number | null;
  isActive: boolean;
  cost: number | null;
  track: boolean;
  stock: number | null;
  threshold: number | null;
  /** What the database had when the editor loaded (stock and cost are sent only when changed). */
  loaded: { cost: number | null; track: boolean; stock: number | null; threshold: number | null } | null;
};

export type ProductForm = {
  id: number | null;
  slug: string;
  /** The admin edited the slug by hand (new products stop following the name). */
  slugTouched: boolean;
  name: string;
  brand: string;
  categoryId: string;
  subtitle: string;
  description: string;
  imageUrls: string[];
  cutoutUrl: string | null;
  tags: string[];
  /** The whole attributes object as loaded (unknown keys are written back untouched). */
  attributesLoaded: Row;
  specs: Record<string, SpecValue>;
  highlights: string[];
  useCases: string[];
  inTheBox: string[];
  warrantyMonths: number | null;
  isActive: boolean;
  isNew: boolean;
  isBestseller: boolean;
  isFeatured: boolean;
  isFlashDeal: boolean;
  sortOrder: number | null;
  seoTitle: string;
  seoDescription: string;
  variants: VariantForm[];
  /** Read-only (derived by the database). */
  price: number | null;
  compareAtPrice: number | null;
  variantCount: number;
  updatedAt: string | null;
};

export const DEFAULT_THRESHOLD = 3; // = inventory.low_stock_threshold's column default (05)
export const MAX_VARIANTS = 100; // = admin_save_product's cap (23)
export const MAX_OPTIONS = 10;

export function emptyVariant(key: string, name = ""): VariantForm {
  return {
    key,
    id: null,
    name,
    sku: "",
    options: [],
    price: null,
    compareAtPrice: null,
    isActive: true,
    cost: null,
    track: false,
    stock: null,
    threshold: DEFAULT_THRESHOLD,
    loaded: null,
  };
}

export function emptyProductForm(variantKey: string): ProductForm {
  return {
    id: null,
    slug: "",
    slugTouched: false,
    name: "",
    brand: "",
    categoryId: "",
    subtitle: "",
    description: "",
    imageUrls: [],
    cutoutUrl: null,
    tags: [],
    attributesLoaded: {},
    specs: {},
    highlights: [],
    useCases: [],
    inTheBox: [],
    warrantyMonths: null,
    isActive: true,
    isNew: false,
    isBestseller: false,
    isFeatured: false,
    isFlashDeal: false,
    sortOrder: 100,
    seoTitle: "",
    seoDescription: "",
    variants: [emptyVariant(variantKey, "Standard")],
    price: null,
    compareAtPrice: null,
    variantCount: 0,
    updatedAt: null,
  };
}

/** Named columns (04 only) — never `*`: that would drag 06's search_vector along. */
export const PRODUCT_EDIT_FIELDS =
  "id, slug, brand, name, subtitle, description, category_id, price, compare_at_price, variant_count, image_urls, cutout_url, tags, attributes, warranty_months, is_active, is_new, is_bestseller, is_featured, is_flash_deal, sort_order, seo_title, seo_description, updated_at";
const VARIANT_EDIT_FIELDS = "id, sku, name, option_values, price, compare_at_price, position, is_active, cost:product_costs(cost_price)";

function variantFromRow(row: Row, stock: Row | undefined): VariantForm {
  const id = toNumber(row.id, 0);
  const cost = toNullableNumber(firstRow(row.cost)?.cost_price);
  const options: OptionPair[] = Object.entries(plainObject(row.option_values)).map(([name, value], index) => ({
    key: `o${id}-${index}`,
    name,
    value: typeof value === "string" ? value : String(value ?? ""),
  }));
  const tracked = stock !== undefined;
  const level = tracked ? toNullableNumber(stock.stock_level) : null;
  const threshold = tracked ? toNullableNumber(stock.low_stock_threshold) : DEFAULT_THRESHOLD;
  return {
    key: `v${id}`,
    id,
    name: toText(row.name, 120) ?? "",
    sku: toText(row.sku, 64) ?? "",
    options,
    price: toNullableNumber(row.price),
    compareAtPrice: toNullableNumber(row.compare_at_price),
    isActive: row.is_active !== false,
    cost,
    track: tracked,
    stock: level,
    threshold,
    loaded: { cost, track: tracked, stock: level, threshold: tracked ? threshold : null },
  };
}

export function productFormFromRows(product: Row, variants: Row[], stock: Row[]): ProductForm {
  const attributes = plainObject(product.attributes);
  const stockByVariant = new Map<number, Row>(stock.map((row) => [toNumber(row.variant_id, 0), row]));
  return {
    id: toNumber(product.id, 0),
    slug: String(product.slug ?? ""),
    slugTouched: true,
    name: toText(product.name, 200) ?? "",
    brand: toText(product.brand, 80) ?? "",
    categoryId: toText(product.category_id, 64) ?? "",
    subtitle: toText(product.subtitle, 200) ?? "",
    description: typeof product.description === "string" ? product.description : "",
    imageUrls: toStringArray(product.image_urls, 12),
    cutoutUrl: toText(product.cutout_url, 1000),
    tags: toStringArray(product.tags, 30),
    attributesLoaded: attributes,
    specs: specsFrom(attributes.specs),
    highlights: toStringArray(attributes.highlights, 50),
    useCases: toStringArray(attributes.use_cases, 50),
    inTheBox: toStringArray(attributes.in_the_box, 50),
    warrantyMonths: toNullableNumber(product.warranty_months),
    isActive: product.is_active !== false,
    isNew: bool(product.is_new),
    isBestseller: bool(product.is_bestseller),
    isFeatured: bool(product.is_featured),
    isFlashDeal: bool(product.is_flash_deal),
    sortOrder: toNullableNumber(product.sort_order) ?? 100,
    seoTitle: toText(product.seo_title, 120) ?? "",
    seoDescription: toText(product.seo_description, 320) ?? "",
    variants: variants.map((row) => variantFromRow(row, stockByVariant.get(toNumber(row.id, 0)))),
    price: toNullableNumber(product.price),
    compareAtPrice: toNullableNumber(product.compare_at_price),
    variantCount: toNumber(product.variant_count, 0),
    updatedAt: toText(product.updated_at, 64),
  };
}

/** Everything the editor needs for one product: the row, its variants (+ cost), its stock rows. */
export async function fetchProductForEdit(supabase: SupabaseClient, id: number, signal?: AbortSignal): Promise<ProductForm | null> {
  let productQuery = supabase.from("products").select(PRODUCT_EDIT_FIELDS).eq("id", id);
  let variantQuery = supabase.from("product_variants").select(VARIANT_EDIT_FIELDS).eq("product_id", id).order("position").order("id").range(0, 199);
  let stockQuery = supabase.from("inventory").select("variant_id, stock_level, low_stock_threshold").eq("product_id", id).range(0, 199);
  if (signal) {
    productQuery = productQuery.abortSignal(signal);
    variantQuery = variantQuery.abortSignal(signal);
    stockQuery = stockQuery.abortSignal(signal);
  }
  const [product, variants, stock] = await Promise.all([productQuery.maybeSingle(), variantQuery, stockQuery]);
  const row = unwrapRow<Row>(product, CATALOGUE_MIGRATION);
  if (!row) return null;
  return productFormFromRows(row, unwrapRows<Row>(variants, CATALOGUE_MIGRATION), unwrapRows<Row>(stock, INVENTORY_MIGRATION));
}

// ── Validation (mirrors 04/05/23 so the admin sees problems before saving) ────

export type ProductErrors = {
  fields: Partial<Record<"name" | "slug" | "brand" | "subtitle" | "description" | "seoTitle" | "seoDescription" | "warrantyMonths" | "sortOrder" | "variants", string>>;
  /** keyed by VariantForm.key, then field */
  variants: Record<string, Partial<Record<"name" | "sku" | "price" | "compareAtPrice" | "cost" | "stock" | "threshold" | "options", string>>>;
  count: number;
};

const MAX_PRICE = 100_000_000; // product_variants_price_valid

export function validateProductForm(form: ProductForm): ProductErrors {
  const fields: ProductErrors["fields"] = {};
  const variants: ProductErrors["variants"] = {};
  const name = trimmed(form.name);
  if (!name) fields.name = "A name is required.";
  else if (name.length > 200) fields.name = "Up to 200 characters.";
  const brand = trimmed(form.brand);
  if (!brand) fields.brand = "A brand is required.";
  else if (brand.length > 80) fields.brand = "Up to 80 characters.";
  const slugIssue = slugProblem(trimmed(form.slug), 120);
  if (slugIssue) fields.slug = slugIssue;
  if (trimmed(form.subtitle).length > 200) fields.subtitle = "Up to 200 characters.";
  if (trimmed(form.description).length > 10000) fields.description = "Up to 10,000 characters.";
  if (trimmed(form.seoTitle).length > 120) fields.seoTitle = "Up to 120 characters.";
  if (trimmed(form.seoDescription).length > 320) fields.seoDescription = "Up to 320 characters.";
  if (form.warrantyMonths !== null && (form.warrantyMonths < 0 || form.warrantyMonths > 240)) fields.warrantyMonths = "0 to 240 months.";
  if (form.sortOrder !== null && (!Number.isInteger(form.sortOrder) || Math.abs(form.sortOrder) > 1_000_000)) fields.sortOrder = "A whole number.";

  if (form.variants.length === 0) fields.variants = "A product needs at least one variant (call it “Standard” when there is only one option).";
  if (form.variants.length > MAX_VARIANTS) fields.variants = `At most ${MAX_VARIANTS} variants.`;
  const names = new Map<string, number>();
  const skus = new Map<string, number>();
  for (const v of form.variants) {
    names.set(trimmed(v.name).toLowerCase(), (names.get(trimmed(v.name).toLowerCase()) ?? 0) + 1);
    if (trimmed(v.sku)) skus.set(trimmed(v.sku), (skus.get(trimmed(v.sku)) ?? 0) + 1);
  }
  for (const v of form.variants) {
    const e: ProductErrors["variants"][string] = {};
    const vName = trimmed(v.name);
    if (!vName) e.name = "Name required.";
    else if (vName.length > 120) e.name = "Up to 120 characters.";
    else if ((names.get(vName.toLowerCase()) ?? 0) > 1) e.name = "Two variants have this name.";
    const sku = trimmed(v.sku);
    if (sku && /\s/.test(sku)) e.sku = "No spaces.";
    else if (sku.length > 64) e.sku = "Up to 64 characters.";
    else if (sku && (skus.get(sku) ?? 0) > 1) e.sku = "Two variants use this SKU.";
    if (v.price === null) e.price = "Price required.";
    else if (v.price < 0 || v.price > MAX_PRICE) e.price = "Rs. 0 to 100,000,000.";
    if (v.compareAtPrice !== null && v.compareAtPrice < 0) e.compareAtPrice = "Can't be negative.";
    if (v.cost !== null && v.cost < 0) e.cost = "Can't be negative.";
    if (v.track) {
      if (v.stock !== null && (v.stock < 0 || v.stock > 1_000_000)) e.stock = "0 to 1,000,000.";
      if (v.threshold !== null && (v.threshold < 0 || v.threshold > 100_000)) e.threshold = "0 to 100,000.";
    }
    const optionNames = new Set<string>();
    for (const pair of v.options) {
      const n = trimmed(pair.name);
      const val = trimmed(pair.value);
      if (!n && !val) continue;
      if (!n || !val) e.options = "Each option needs a name and a value.";
      else if (n.length > 40 || val.length > 60) e.options = "Option names up to 40, values up to 60 characters.";
      else if (optionNames.has(n.toLowerCase())) e.options = `“${n}” appears twice.`;
      optionNames.add(n.toLowerCase());
    }
    if (v.options.filter((pair) => trimmed(pair.name) || trimmed(pair.value)).length > MAX_OPTIONS) e.options = `Up to ${MAX_OPTIONS} options.`;
    if (Object.keys(e).length) variants[v.key] = e;
  }
  const count = Object.keys(fields).length + Object.values(variants).reduce((n, e) => n + Object.keys(e).length, 0);
  return { fields, variants, count };
}

// ── The admin_save_product payload ────────────────────────────────────────────

function optionsObject(options: OptionPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of options) {
    const name = trimmed(pair.name);
    const value = trimmed(pair.value);
    if (name && value) out[name] = value;
  }
  return out;
}

/** attributes = what was loaded (unknown keys kept) + the edited parts; empty parts that never existed stay absent. */
export function buildAttributes(form: ProductForm): Row {
  const out: Row = { ...form.attributesLoaded };
  const had = (key: string) => Object.prototype.hasOwnProperty.call(form.attributesLoaded, key);
  const loadedSpecs = plainObject(form.attributesLoaded.specs);
  // specs: edited values over the loaded object, so shapes the editor can't show survive untouched
  const specs: Row = { ...loadedSpecs };
  for (const key of Object.keys(loadedSpecs)) {
    if (!Object.prototype.hasOwnProperty.call(form.specs, key) && key in specsFrom({ [key]: loadedSpecs[key] })) delete specs[key];
  }
  for (const [key, value] of Object.entries(form.specs)) {
    // text is kept as typed while editing; saved trimmed (a blank one never reaches here: withSpec)
    specs[key] = typeof value === "string" ? value.trim() : Array.isArray(value) ? value.map(trimmed).filter(Boolean) : value;
  }
  if (Object.keys(specs).length > 0 || had("specs")) out.specs = specs;
  const list = (key: string, value: string[]) => {
    const clean = value.map(trimmed).filter(Boolean);
    if (clean.length > 0 || had(key)) out[key] = clean;
  };
  list("highlights", form.highlights);
  list("use_cases", form.useCases);
  list("in_the_box", form.inTheBox);
  return out;
}

export type ProductSavePayload = { p_product: Row; p_variants: Row[] };

/**
 * The exact arguments for `admin_save_product` (23). Every editable product key is sent (the RPC
 * writes only keys that are present); every variant is listed (absent ones are removed by the RPC);
 * cost and stock are sent ONLY when they differ from what was loaded, so an order that sold stock
 * while the editor was open is never overwritten (blueprint §11.2).
 */
export function buildProductSave(form: ProductForm): ProductSavePayload {
  const p_product: Row = {
    slug: trimmed(form.slug),
    brand: trimmed(form.brand),
    name: trimmed(form.name),
    subtitle: orNull(form.subtitle),
    description: orNull(form.description),
    category_id: form.categoryId || null,
    image_urls: form.imageUrls,
    cutout_url: form.cutoutUrl,
    tags: form.tags,
    attributes: buildAttributes(form),
    warranty_months: form.warrantyMonths,
    is_active: form.isActive,
    is_new: form.isNew,
    is_bestseller: form.isBestseller,
    is_featured: form.isFeatured,
    is_flash_deal: form.isFlashDeal,
    sort_order: form.sortOrder ?? 100,
    seo_title: orNull(form.seoTitle),
    seo_description: orNull(form.seoDescription),
  };
  if (form.id) p_product.id = form.id;

  const p_variants = form.variants.map((v, index) => {
    const row: Row = {
      name: trimmed(v.name),
      sku: orNull(v.sku),
      option_values: optionsObject(v.options),
      price: v.price,
      compare_at_price: v.compareAtPrice,
      position: index,
      is_active: v.isActive,
    };
    if (v.id) row.id = v.id;
    const was = v.loaded;
    // cost: new variant → only when entered; saved variant → only when changed (null clears it)
    if (was ? v.cost !== was.cost : v.cost !== null) row.cost_price = v.cost;
    // stock: only what changed
    if (!was || !was.track) {
      if (v.track) {
        row.track_stock = true;
        if (v.stock !== null) row.stock_level = v.stock;
        if (v.threshold !== null) row.low_stock_threshold = v.threshold;
      }
    } else if (!v.track) {
      row.track_stock = false;
    } else {
      if (v.stock !== null && v.stock !== was.stock) row.stock_level = v.stock;
      if (v.threshold !== null && v.threshold !== was.threshold) row.low_stock_threshold = v.threshold;
    }
    return row;
  });
  return { p_product, p_variants };
}

/** The admin_save_product result. */
export type ProductSaveResult = {
  product_id: number;
  created: boolean;
  slug: string;
  variants: { id: number; name: string; created: boolean }[];
  deleted_variant_ids: number[];
  deactivated_variant_ids: number[];
};

/** A stable fingerprint of what would be saved — "unsaved changes?" without false alarms. */
export function productFingerprint(form: ProductForm): string {
  const payload = buildProductSave(form);
  return JSON.stringify([payload.p_product, payload.p_variants]);
}

// ── Categories ────────────────────────────────────────────────────────────────

export const SCENES = [
  { value: "night", label: "Night (dark stage)" },
  { value: "paper", label: "Paper (light stage)" },
  { value: "lime", label: "Lime" },
  { value: "violet", label: "Violet" },
] as const;
export type Scene = (typeof SCENES)[number]["value"];

export type AdminCategoryRow = {
  id: string;
  name: string;
  tagline: string | null;
  description: string | null;
  stageImageUrl: string | null;
  heroProductId: number | null;
  hero: { id: number; name: string; imageUrl: string | null; cutoutUrl: string | null } | null;
  scene: Scene;
  sortOrder: number;
  isActive: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  productCount: number;
};

function toSceneValue(value: unknown): Scene {
  return SCENES.some((s) => s.value === value) ? (value as Scene) : "paper";
}

export function normalizeCategoryRow(row: Row): AdminCategoryRow {
  const hero = firstRow(row.hero);
  const heroId = toNullableNumber(row.hero_product_id);
  return {
    id: String(row.id ?? ""),
    name: toText(row.name, 80) ?? String(row.id ?? ""),
    tagline: toText(row.tagline, 160),
    description: toText(row.description, 4000),
    stageImageUrl: toText(row.stage_image_url, 1000),
    heroProductId: heroId,
    hero: hero && heroId
      ? { id: heroId, name: toText(hero.name, 200) ?? `#${heroId}`, imageUrl: safeImageUrl(hero.image_url), cutoutUrl: safeImageUrl(hero.cutout_url) }
      : null,
    scene: toSceneValue(row.scene),
    sortOrder: toNumber(row.sort_order, 100),
    isActive: row.is_active !== false,
    seoTitle: toText(row.seo_title, 120),
    seoDescription: toText(row.seo_description, 320),
    productCount: embeddedCount(row.product_count),
  };
}

export async function fetchCategoryPage(
  supabase: SupabaseClient,
  options: { search: string; from: number; to: number; signal?: AbortSignal },
): Promise<AdminPage<AdminCategoryRow>> {
  let query = supabase
    .from("categories")
    .select("*, product_count:products!products_category_id_fkey(count), hero:products!categories_hero_product_id_fkey(id, name, image_url, cutout_url)", {
      count: "exact",
    });
  const search = orIlike(["id", "name", "tagline"], options.search);
  if (search) query = query.or(search);
  query = query.order("sort_order").order("name").range(options.from, options.to);
  if (options.signal) query = query.abortSignal(options.signal);
  const page = unwrapPage<Row>(await query, CATALOGUE_MIGRATION);
  return { ...page, rows: page.rows.map(normalizeCategoryRow) };
}

export type CategoryForm = {
  originalId: string | null;
  id: string;
  idTouched: boolean;
  name: string;
  tagline: string;
  description: string;
  stageImageUrl: string | null;
  heroProductId: number | null;
  scene: Scene;
  sortOrder: number | null;
  isActive: boolean;
  seoTitle: string;
  seoDescription: string;
};

export function emptyCategoryForm(): CategoryForm {
  return {
    originalId: null,
    id: "",
    idTouched: false,
    name: "",
    tagline: "",
    description: "",
    stageImageUrl: null,
    heroProductId: null,
    scene: "paper",
    sortOrder: 100,
    isActive: true,
    seoTitle: "",
    seoDescription: "",
  };
}

export function categoryFormFromRow(row: AdminCategoryRow): CategoryForm {
  return {
    originalId: row.id,
    id: row.id,
    idTouched: true,
    name: row.name,
    tagline: row.tagline ?? "",
    description: row.description ?? "",
    stageImageUrl: row.stageImageUrl,
    heroProductId: row.heroProductId,
    scene: row.scene,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    seoTitle: row.seoTitle ?? "",
    seoDescription: row.seoDescription ?? "",
  };
}

export type CategoryErrors = Partial<Record<"id" | "name" | "tagline" | "description" | "sortOrder" | "seoTitle" | "seoDescription", string>>;

export function validateCategoryForm(form: CategoryForm): CategoryErrors {
  const errors: CategoryErrors = {};
  const idIssue = slugProblem(trimmed(form.id), 64);
  if (idIssue) errors.id = idIssue;
  const name = trimmed(form.name);
  if (!name) errors.name = "A name is required.";
  else if (name.length > 80) errors.name = "Up to 80 characters.";
  if (trimmed(form.tagline).length > 160) errors.tagline = "Up to 160 characters.";
  if (trimmed(form.description).length > 4000) errors.description = "Up to 4,000 characters.";
  if (form.sortOrder === null || !Number.isInteger(form.sortOrder)) errors.sortOrder = "A whole number.";
  if (trimmed(form.seoTitle).length > 120) errors.seoTitle = "Up to 120 characters.";
  if (trimmed(form.seoDescription).length > 320) errors.seoDescription = "Up to 320 characters.";
  return errors;
}

/** The categories row to insert/update (never the hero of another category's products — any product may be the hero). */
export function categoryRow(form: CategoryForm): Row {
  return {
    id: trimmed(form.id),
    name: trimmed(form.name),
    tagline: orNull(form.tagline),
    description: orNull(form.description),
    stage_image_url: form.stageImageUrl,
    hero_product_id: form.heroProductId,
    scene: form.scene,
    sort_order: form.sortOrder ?? 100,
    is_active: form.isActive,
    seo_title: orNull(form.seoTitle),
    seo_description: orNull(form.seoDescription),
  };
}

// ── Collections ───────────────────────────────────────────────────────────────

export const COLLECTION_KINDS = [
  { value: "curated", label: "Curated (a theme)" },
  { value: "brand", label: "Brand" },
  { value: "line", label: "Product line" },
] as const;
export type CollectionKind = (typeof COLLECTION_KINDS)[number]["value"];

export type RuleField = "tag" | "brand" | "category" | "price" | "is_new" | "is_flash_deal";
export type RuleRelation = "equals" | "not_equals" | "lt" | "lte" | "gt" | "gte";
export type RuleValueKind = "text" | "brand" | "category" | "money" | "flag";

/** The pairs 04's collections_validate() accepts — nothing else can be saved. */
export const RULE_FIELDS: readonly { field: RuleField; label: string; relations: readonly RuleRelation[]; value: RuleValueKind }[] = [
  { field: "tag", label: "Tag", relations: ["equals", "not_equals"], value: "text" },
  { field: "brand", label: "Brand", relations: ["equals", "not_equals"], value: "brand" },
  { field: "category", label: "Category", relations: ["equals", "not_equals"], value: "category" },
  { field: "price", label: "Price (the “from” price)", relations: ["lt", "lte", "gt", "gte"], value: "money" },
  { field: "is_new", label: "New arrival", relations: ["equals"], value: "flag" },
  { field: "is_flash_deal", label: "Flash deal", relations: ["equals"], value: "flag" },
];
export const RELATION_LABELS: Record<RuleRelation, string> = {
  equals: "is",
  not_equals: "is not",
  lt: "is below",
  lte: "is at most",
  gt: "is above",
  gte: "is at least",
};
export const MAX_RULES = 20;

export type RuleForm = { key: string; field: RuleField; relation: RuleRelation; value: string };

export function ruleFieldDef(field: RuleField) {
  return RULE_FIELDS.find((def) => def.field === field) ?? RULE_FIELDS[0];
}

export function rulesFromJson(value: unknown, keyPrefix = "r"): RuleForm[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((rule): rule is Row => Boolean(rule) && typeof rule === "object" && !Array.isArray(rule))
    .map((rule, index) => {
      const def = RULE_FIELDS.find((d) => d.field === rule.field) ?? RULE_FIELDS[0];
      const relation = def.relations.includes(rule.relation as RuleRelation) ? (rule.relation as RuleRelation) : def.relations[0];
      const raw = rule.value;
      return {
        key: `${keyPrefix}${index}`,
        field: def.field,
        relation,
        value: typeof raw === "string" ? raw : typeof raw === "number" || typeof raw === "boolean" ? String(raw) : "",
      };
    });
}

/** Rules as 04 stores them: values are text ("25000", "true"), trimmed. */
export function rulesToJson(rules: RuleForm[]): { field: RuleField; relation: RuleRelation; value: string }[] {
  return rules.map((rule) => ({ field: rule.field, relation: rule.relation, value: rule.value.trim() }));
}

/** Mirrors collections_validate() (04). */
export function ruleProblem(rule: RuleForm): string | null {
  const def = ruleFieldDef(rule.field);
  const value = rule.value.trim();
  if (!def.relations.includes(rule.relation)) return "Pick a comparison.";
  if (!value) return "Enter a value.";
  if (value.length > 120) return "Up to 120 characters.";
  if (def.value === "money" && !/^\d{1,10}(\.\d{1,2})?$/.test(value)) return "Enter an amount in rupees.";
  if (def.value === "flag" && value !== "true" && value !== "false") return "Choose yes or no.";
  return null;
}

export type MemberForm = { productId: number; product: ProductPick | null };

export type CollectionForm = {
  originalId: string | null;
  id: string;
  idTouched: boolean;
  title: string;
  subtitle: string;
  description: string;
  coverImage: string | null;
  kind: CollectionKind;
  type: "manual" | "automated";
  rules: RuleForm[];
  match: "any" | "all";
  isActive: boolean;
  isFeatured: boolean;
  /** [back, front] — at most two */
  featureProductIds: number[];
  sortOrder: number | null;
  seoTitle: string;
  seoDescription: string;
};

export type AdminCollectionRow = {
  id: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  coverImage: string | null;
  kind: CollectionKind;
  type: "manual" | "automated";
  rules: unknown;
  match: "any" | "all";
  isActive: boolean;
  isFeatured: boolean;
  featureProductIds: number[];
  sortOrder: number;
  seoTitle: string | null;
  seoDescription: string | null;
  memberCount: number;
};

export function normalizeCollectionRow(row: Row): AdminCollectionRow {
  const kind = COLLECTION_KINDS.some((k) => k.value === row.kind) ? (row.kind as CollectionKind) : "curated";
  return {
    id: String(row.id ?? ""),
    title: toText(row.title, 120) ?? String(row.id ?? ""),
    subtitle: toText(row.subtitle, 200),
    description: toText(row.description, 4000),
    coverImage: toText(row.cover_image, 1000),
    kind,
    type: row.type === "automated" ? "automated" : "manual",
    rules: row.rules,
    match: row.match === "all" ? "all" : "any",
    isActive: row.is_active !== false,
    isFeatured: bool(row.is_featured),
    featureProductIds: (Array.isArray(row.feature_product_ids) ? row.feature_product_ids : [])
      .map((id) => toNumber(id, 0))
      .filter((id) => Number.isInteger(id) && id > 0)
      .slice(0, 2),
    sortOrder: toNumber(row.sort_order, 100),
    seoTitle: toText(row.seo_title, 120),
    seoDescription: toText(row.seo_description, 320),
    memberCount: embeddedCount(row.member_count),
  };
}

export async function fetchCollectionPage(
  supabase: SupabaseClient,
  options: { search: string; from: number; to: number; signal?: AbortSignal },
): Promise<AdminPage<AdminCollectionRow>> {
  let query = supabase.from("collections").select("*, member_count:product_collections(count)", { count: "exact" });
  const search = orIlike(["id", "title", "subtitle"], options.search);
  if (search) query = query.or(search);
  query = query.order("sort_order").order("title").range(options.from, options.to);
  if (options.signal) query = query.abortSignal(options.signal);
  const page = unwrapPage<Row>(await query, CATALOGUE_MIGRATION);
  return { ...page, rows: page.rows.map(normalizeCollectionRow) };
}

export function emptyCollectionForm(): CollectionForm {
  return {
    originalId: null,
    id: "",
    idTouched: false,
    title: "",
    subtitle: "",
    description: "",
    coverImage: null,
    kind: "curated",
    type: "manual",
    rules: [],
    match: "any",
    isActive: true,
    isFeatured: false,
    featureProductIds: [],
    sortOrder: 100,
    seoTitle: "",
    seoDescription: "",
  };
}

export function collectionFormFromRow(row: AdminCollectionRow): CollectionForm {
  return {
    originalId: row.id,
    id: row.id,
    idTouched: true,
    title: row.title,
    subtitle: row.subtitle ?? "",
    description: row.description ?? "",
    coverImage: row.coverImage,
    kind: row.kind,
    type: row.type,
    rules: rulesFromJson(row.rules),
    match: row.match,
    isActive: row.isActive,
    isFeatured: row.isFeatured,
    featureProductIds: row.featureProductIds,
    sortOrder: row.sortOrder,
    seoTitle: row.seoTitle ?? "",
    seoDescription: row.seoDescription ?? "",
  };
}

export type CollectionErrors = Partial<Record<"id" | "title" | "subtitle" | "description" | "sortOrder" | "seoTitle" | "seoDescription" | "rules", string>> & {
  ruleRows?: Record<string, string>;
};

export function validateCollectionForm(form: CollectionForm): CollectionErrors {
  const errors: CollectionErrors = {};
  const idIssue = slugProblem(trimmed(form.id), 80);
  if (idIssue) errors.id = idIssue;
  const title = trimmed(form.title);
  if (!title) errors.title = "A title is required.";
  else if (title.length > 120) errors.title = "Up to 120 characters.";
  if (trimmed(form.subtitle).length > 200) errors.subtitle = "Up to 200 characters.";
  if (trimmed(form.description).length > 4000) errors.description = "Up to 4,000 characters.";
  if (form.sortOrder === null || !Number.isInteger(form.sortOrder)) errors.sortOrder = "A whole number.";
  if (trimmed(form.seoTitle).length > 120) errors.seoTitle = "Up to 120 characters.";
  if (trimmed(form.seoDescription).length > 320) errors.seoDescription = "Up to 320 characters.";
  if (form.type === "automated") {
    if (form.rules.length > MAX_RULES) errors.rules = `At most ${MAX_RULES} rules.`;
    const rows: Record<string, string> = {};
    for (const rule of form.rules) {
      const problem = ruleProblem(rule);
      if (problem) rows[rule.key] = problem;
    }
    if (Object.keys(rows).length) {
      errors.ruleRows = rows;
      errors.rules = errors.rules ?? "Fix the highlighted rules.";
    }
  }
  return errors;
}

export function hasErrors(errors: Record<string, unknown>): boolean {
  return Object.values(errors).some((value) => (value && typeof value === "object" ? Object.keys(value).length > 0 : Boolean(value)));
}

/** The collections row to insert/update (parent/brand/theme/page_content are left as they are). */
export function collectionRow(form: CollectionForm): Row {
  return {
    id: trimmed(form.id),
    title: trimmed(form.title),
    subtitle: orNull(form.subtitle),
    description: orNull(form.description),
    cover_image: form.coverImage,
    kind: form.kind,
    type: form.type,
    rules: form.type === "automated" ? rulesToJson(form.rules) : [],
    match: form.match,
    is_active: form.isActive,
    is_featured: form.isFeatured,
    feature_product_ids: form.featureProductIds.slice(0, 2),
    sort_order: form.sortOrder ?? 100,
    seo_title: orNull(form.seoTitle),
    seo_description: orNull(form.seoDescription),
  };
}

export type CollectionMemberRow = { productId: number; position: number; source: "manual" | "rule"; product: ProductPick | null };

/** Members in the storefront's order (position, then product id) — up to 1,000. */
export async function fetchCollectionMembers(supabase: SupabaseClient, collectionId: string, signal?: AbortSignal): Promise<CollectionMemberRow[]> {
  let query = supabase
    .from("product_collections")
    .select(`product_id, position, source, product:products(${PICK_FIELDS})`)
    .eq("collection_id", collectionId)
    .order("position")
    .order("product_id")
    .range(0, 999);
  if (signal) query = query.abortSignal(signal);
  return unwrapRows<Row>(await query, CATALOGUE_MIGRATION).map((row) => {
    const product = firstRow(row.product);
    return {
      productId: toNumber(row.product_id, 0),
      position: toNumber(row.position, 0),
      source: row.source === "rule" ? "rule" : "manual",
      product: product ? normalizeProductPick(product) : null,
    };
  });
}

// ── Inventory (view admin_inventory, 23) ──────────────────────────────────────

export type AdminInventoryRow = {
  variantId: number;
  productId: number;
  productName: string;
  brand: string;
  productSlug: string;
  categoryId: string | null;
  categoryName: string | null;
  imageUrl: string | null;
  productIsActive: boolean;
  variantName: string;
  sku: string | null;
  variantIsActive: boolean;
  position: number;
  tracked: boolean;
  stockLevel: number | null;
  lowStockThreshold: number | null;
  isLow: boolean;
  stockUpdatedAt: string | null;
};

export function normalizeInventoryRow(row: Row): AdminInventoryRow {
  const tracked = bool(row.tracked);
  return {
    variantId: toNumber(row.variant_id, 0),
    productId: toNumber(row.product_id, 0),
    productName: toText(row.product_name, 200) ?? "",
    brand: toText(row.brand, 80) ?? "",
    productSlug: String(row.product_slug ?? ""),
    categoryId: toText(row.category_id, 64),
    categoryName: toText(row.category_name, 80),
    imageUrl: safeImageUrl(row.image_url),
    productIsActive: row.product_is_active !== false,
    variantName: toText(row.variant_name, 120) ?? "",
    sku: toText(row.sku, 64),
    variantIsActive: row.variant_is_active !== false,
    position: toNumber(row.position, 0),
    tracked,
    stockLevel: tracked ? toNullableNumber(row.stock_level) : null,
    lowStockThreshold: tracked ? toNullableNumber(row.low_stock_threshold) : null,
    isLow: bool(row.is_low),
    stockUpdatedAt: toText(row.stock_updated_at, 64),
  };
}

/**
 * The admin low-stock rule — a MIRROR of admin_inventory.is_low (23) and 17's admin_low_stock:
 * a tracked, on-sale (active variant of an active product) variant at or under its threshold.
 * Used only to refresh one row after a confirmed inline edit; the view stays the authority.
 */
export function isLowStock(row: { productIsActive: boolean; variantIsActive: boolean }, stock: number | null, threshold: number | null): boolean {
  return row.productIsActive && row.variantIsActive && stock !== null && threshold !== null && stock <= threshold;
}

export type InventoryFilters = { search: string; categoryId: string };

function inventoryQuery(supabase: SupabaseClient, filters: InventoryFilters, count: boolean) {
  let query = supabase.from("admin_inventory").select("*", count ? { count: "exact" } : undefined);
  const search = orIlike(["product_name", "brand", "variant_name", "sku"], filters.search);
  if (search) query = query.or(search);
  if (filters.categoryId === "__none__") query = query.is("category_id", null);
  else if (filters.categoryId) query = query.eq("category_id", filters.categoryId);
  // Low stock first (brief + blueprint §11.2), lowest stock first among them, then by product.
  return query
    .order("is_low", { ascending: false })
    .order("stock_level", { ascending: true, nullsFirst: false })
    .order("product_name", { ascending: true })
    .order("position", { ascending: true })
    .order("variant_id", { ascending: true });
}

export async function fetchInventoryPage(
  supabase: SupabaseClient,
  options: { filters: InventoryFilters; from: number; to: number; signal?: AbortSignal },
): Promise<AdminPage<AdminInventoryRow>> {
  let query = inventoryQuery(supabase, options.filters, true).range(options.from, options.to);
  if (options.signal) query = query.abortSignal(options.signal);
  const page = unwrapPage<Row>(await query, ADMIN_CATALOGUE_MIGRATION);
  return { ...page, rows: page.rows.map(normalizeInventoryRow) };
}

/** Every row for the current filters, 1,000 at a time (PostgREST caps a response at 1,000). */
export async function fetchInventoryForExport(supabase: SupabaseClient, filters: InventoryFilters, maxRows = 20_000): Promise<AdminInventoryRow[]> {
  const rows: AdminInventoryRow[] = [];
  for (let from = 0; from < maxRows; from += 1000) {
    const batch = unwrapRows<Row>(await inventoryQuery(supabase, filters, false).range(from, from + 999), ADMIN_CATALOGUE_MIGRATION);
    rows.push(...batch.map(normalizeInventoryRow));
    if (batch.length < 1000) break;
  }
  return rows;
}

export const INVENTORY_CSV_COLUMNS = [
  { label: "Product", value: (r: AdminInventoryRow) => r.productName },
  { label: "Brand", value: (r: AdminInventoryRow) => r.brand },
  { label: "Category", value: (r: AdminInventoryRow) => r.categoryName ?? "" },
  { label: "Variant", value: (r: AdminInventoryRow) => r.variantName },
  { label: "SKU", value: (r: AdminInventoryRow) => r.sku ?? "" },
  { label: "Stock tracked", value: (r: AdminInventoryRow) => (r.tracked ? "yes" : "no") },
  { label: "Stock", value: (r: AdminInventoryRow) => r.stockLevel },
  { label: "Low-stock threshold", value: (r: AdminInventoryRow) => r.lowStockThreshold },
  { label: "Low stock", value: (r: AdminInventoryRow) => (r.isLow ? "yes" : "no") },
  { label: "Product active", value: (r: AdminInventoryRow) => (r.productIsActive ? "yes" : "no") },
  { label: "Variant active", value: (r: AdminInventoryRow) => (r.variantIsActive ? "yes" : "no") },
  { label: "Stock updated", value: (r: AdminInventoryRow) => r.stockUpdatedAt ?? "" },
];
