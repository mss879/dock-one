/**
 * Spec filters on /shop (Website changes, November 2026 — "For laptops, add RAM, SSD capacity,
 * graphics, screen size, touch, OS, and condition. Use capacity for drives and refresh rate for
 * monitors"). A PLAIN module: the shop page (server) counts and matches; the filter panel (client)
 * builds the links.
 *
 * Every value comes from the product's own specs (products.attributes.specs, edited in admin →
 * Products → Specifications). Nothing is guessed: a laptop whose specs don't state its graphics is
 * simply not under any Graphics value. The two readings that use the display text ("15.6-inch FHD",
 * "16-inch touch") do so only when the dedicated key (screen_in / touch) is absent.
 */

import type { SpecValue } from "@/lib/catalogue-shared";

export type SpecFacetKey = "ram" | "ssd" | "gpu" | "screen" | "touch" | "os" | "condition" | "capacity" | "refresh";

export type SpecFacetDef = {
  key: SpecFacetKey;
  label: string;
  /** The product's value(s) for this facet (empty = it doesn't say). Values are stable URL keys. */
  read: (specs: Record<string, SpecValue>) => string[];
  /** How a value is shown. */
  format: (value: string) => string;
  /** Sort order of the values (numbers ascending by default). */
  numeric?: boolean;
};

/** Which facets a category shows, in order. Categories not listed have no spec filters. */
export const CATEGORY_SPEC_FACETS: Readonly<Record<string, readonly SpecFacetKey[]>> = {
  laptops: ["ram", "ssd", "gpu", "screen", "touch", "os", "condition"],
  storage: ["capacity"],
  monitors: ["refresh", "screen"],
};

const num = (value: SpecValue | undefined): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+(\.\d+)?$/.test(value.trim())) return Number(value.trim());
  return null;
};
const text = (value: SpecValue | undefined): string | null => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, 80) : null);

/** Decimal storage (1 TB = 1000 GB), as drives are sold. */
function capacityLabel(gb: number): string {
  if (gb >= 1000) {
    const tb = gb / 1000;
    return `${Number.isInteger(tb) ? tb : tb.toFixed(1).replace(/\.0$/, "")} TB`;
  }
  return `${gb} GB`;
}

/** "NVIDIA GeForce RTX 4050 (6GB)" → "NVIDIA RTX 4050"; "Intel UHD Graphics" stays. */
function gpuValue(raw: string): string {
  return raw
    .replace(/\([^)]*\)/g, "")
    .replace(/\bGeForce\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function screenInches(specs: Record<string, SpecValue>): number | null {
  const own = num(specs.screen_in);
  if (own !== null) return own;
  const display = text(specs.display);
  const match = display?.match(/(\d{2}(?:\.\d)?)\s*(?:-?\s*inch|"|”|in\b)/i);
  return match ? Number(match[1]) : null;
}

export const SPEC_FACETS: Readonly<Record<SpecFacetKey, SpecFacetDef>> = {
  ram: {
    key: "ram",
    label: "RAM",
    read: (s) => {
      const n = num(s.ram_gb);
      return n !== null && n > 0 ? [String(n)] : [];
    },
    format: (v) => `${v} GB`,
    numeric: true,
  },
  ssd: {
    key: "ssd",
    label: "SSD capacity",
    read: (s) => {
      const n = num(s.storage_gb);
      const type = text(s.storage_type);
      // an SSD, or a laptop whose storage type isn't stated; never a hard drive
      return n !== null && n > 0 && (!type || /ssd|nvme/i.test(type)) ? [String(n)] : [];
    },
    format: (v) => capacityLabel(Number(v)),
    numeric: true,
  },
  gpu: {
    key: "gpu",
    label: "Graphics",
    read: (s) => {
      const gpu = text(s.gpu);
      return gpu ? [gpuValue(gpu)] : [];
    },
    format: (v) => v,
  },
  screen: {
    key: "screen",
    label: "Screen size",
    read: (s) => {
      const inches = screenInches(s);
      return inches !== null && inches >= 7 && inches <= 100 ? [String(inches)] : [];
    },
    format: (v) => `${v}"`,
    numeric: true,
  },
  touch: {
    key: "touch",
    label: "Touch",
    read: (s) => {
      if (s.touch === true) return ["yes"];
      if (s.touch === false) return [];
      return /\btouch/i.test(text(s.display) ?? "") ? ["yes"] : [];
    },
    format: () => "Touchscreen",
  },
  os: {
    key: "os",
    label: "Operating system",
    read: (s) => {
      const os = text(s.os);
      return os ? [os] : [];
    },
    format: (v) => v,
  },
  condition: {
    key: "condition",
    label: "Condition",
    read: (s) => {
      const c = text(s.condition);
      return c ? [c] : [];
    },
    format: (v) => v,
  },
  capacity: {
    key: "capacity",
    label: "Capacity",
    read: (s) => {
      const n = num(s.capacity_gb);
      return n !== null && n > 0 ? [String(n)] : [];
    },
    format: (v) => capacityLabel(Number(v)),
    numeric: true,
  },
  refresh: {
    key: "refresh",
    label: "Refresh rate",
    read: (s) => {
      const n = num(s.refresh_hz);
      return n !== null && n > 0 ? [String(Math.round(n))] : [];
    },
    format: (v) => `${v} Hz`,
    numeric: true,
  },
};

export const SPEC_FACET_KEYS = Object.keys(SPEC_FACETS) as SpecFacetKey[];

/** Selected values per facet, from / for the URL (?spec_ram=8,16&spec_os=Windows%2011). */
export type SpecSelection = Partial<Record<SpecFacetKey, string[]>>;

export const specParam = (key: SpecFacetKey) => `spec_${key}`;

const MAX_VALUES = 12;

/** Read ?spec_* from the URL: known facets only, ≤ 12 values each, ≤ 80 characters a value. */
export function parseSpecSelection(get: (name: string) => string | undefined): SpecSelection {
  const out: SpecSelection = {};
  for (const key of SPEC_FACET_KEYS) {
    const raw = get(specParam(key));
    if (!raw) continue;
    const values = [...new Set(raw.split(",").map((v) => v.trim()).filter((v) => v && v.length <= 80))].slice(0, MAX_VALUES).sort();
    if (values.length) out[key] = values;
  }
  return out;
}

export function hasSpecSelection(selection: SpecSelection): boolean {
  return Object.values(selection).some((values) => (values?.length ?? 0) > 0);
}

export function specSelectionCount(selection: SpecSelection): number {
  return Object.values(selection).filter((values) => (values?.length ?? 0) > 0).length;
}

/** Does a product's specs match every selected facet (any one value within a facet)? */
export function matchesSpecs(specs: Record<string, SpecValue>, selection: SpecSelection, except?: SpecFacetKey): boolean {
  for (const key of SPEC_FACET_KEYS) {
    if (key === except) continue;
    const wanted = selection[key];
    if (!wanted || wanted.length === 0) continue;
    const have = SPEC_FACETS[key].read(specs);
    if (!have.some((value) => wanted.includes(value))) return false;
  }
  return true;
}

export type SpecFacetOption = { value: string; label: string; count: number };
export type SpecFacet = { key: SpecFacetKey; label: string; options: SpecFacetOption[] };

/**
 * The facets of a category with their values and counts. A facet's counts are taken over the
 * products matching every OTHER selected facet (so a picked value never empties its own list);
 * a facet with no values in the category is left out; picked values always stay listed.
 */
export function buildSpecFacets(categoryId: string | null, products: readonly { specs: Record<string, SpecValue> }[], selection: SpecSelection): SpecFacet[] {
  const keys = categoryId ? (CATEGORY_SPEC_FACETS[categoryId] ?? []) : [];
  const facets: SpecFacet[] = [];
  for (const key of keys) {
    const def = SPEC_FACETS[key];
    const counts = new Map<string, number>();
    for (const product of products) {
      if (!matchesSpecs(product.specs, selection, key)) continue;
      for (const value of new Set(def.read(product.specs))) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    for (const picked of selection[key] ?? []) if (!counts.has(picked)) counts.set(picked, 0);
    if (counts.size === 0) continue;
    const options = [...counts.entries()]
      .map(([value, count]) => ({ value, label: def.format(value), count }))
      .sort((a, b) => (def.numeric ? Number(a.value) - Number(b.value) : a.label.localeCompare(b.label)));
    facets.push({ key, label: def.label, options });
  }
  return facets;
}
