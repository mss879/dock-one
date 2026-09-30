/**
 * Product spec sheet formatting (BUILD_SPEC §4.4, docs/domain-model.md §3) — plain module.
 *
 * `products.attributes.specs` holds snake_case facts, numbers as numbers. This turns the keys
 * that are PRESENT into labelled, unit-formatted rows for the product page. Nothing is
 * inferred: a missing or null key is simply not shown, booleans read "Yes"/"No", and an
 * unknown key (added by the admin) is shown with a humanised label rather than dropped.
 */

import type { SpecValue } from "@/lib/catalogue-shared";

export type SpecRow = { key: string; label: string; value: string };

type SpecFormat = {
  label: string;
  /** Formats a number (or numeric string); strings/arrays/booleans use the generic rules. */
  number?: (n: number) => string;
};

const integer = (n: number) => Math.round(n).toLocaleString("en-US");
const decimal = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const withUnit = (unit: string, format: (n: number) => string = decimal) => (n: number) => `${format(n)} ${unit}`;

/** Storage sizes are decimal (1 TB = 1000 GB), as drives are sold. */
function capacity(gb: number): string {
  if (gb >= 1000 && gb % 1000 === 0) return `${integer(gb / 1000)} TB`;
  if (gb >= 1000) return `${decimal(gb / 1000)} TB`;
  return `${decimal(gb)} GB`;
}

/** Every documented key (docs/domain-model.md §3), in the order a spec sheet reads best. */
const FORMATS: Record<string, SpecFormat> = {
  // laptops
  cpu: { label: "Processor" },
  gpu: { label: "Graphics" },
  ram_gb: { label: "Memory", number: withUnit("GB", integer) },
  storage_gb: { label: "Storage", number: capacity },
  storage_type: { label: "Storage type" },
  display: { label: "Display" },
  refresh_hz: { label: "Refresh rate", number: withUnit("Hz", integer) },
  weight_kg: { label: "Weight", number: withUnit("kg") },
  battery_wh: { label: "Battery", number: withUnit("Wh") },
  battery_h: { label: "Battery life", number: withUnit("hours") },
  os: { label: "Operating system" },
  ports: { label: "Ports" },
  // storage
  capacity_gb: { label: "Capacity", number: capacity },
  type: { label: "Type" },
  interface: { label: "Interface" },
  speed_mbps: { label: "Speed", number: withUnit("MB/s", integer) },
  read_mbps: { label: "Read speed", number: withUnit("MB/s", integer) },
  write_mbps: { label: "Write speed", number: withUnit("MB/s", integer) },
  rugged: { label: "Rugged rating" },
  // keyboards
  layout: { label: "Layout" },
  switch: { label: "Switches" },
  hot_swap: { label: "Hot-swap sockets" },
  connectivity: { label: "Connectivity" },
  backlight: { label: "Backlight" },
  keycaps: { label: "Keycaps" },
  os_compat: { label: "Works with" },
  // mice
  sensor: { label: "Sensor" },
  dpi_max: { label: "Maximum DPI", number: integer },
  buttons: { label: "Buttons", number: integer },
  grip: { label: "Grip style" },
  silent: { label: "Silent clicks" },
  // shared
  weight_g: { label: "Weight", number: withUnit("g", integer) },
};

const ORDER = Object.keys(FORMATS);

/** `usb_hub_ports` → "Usb hub ports" (unknown admin-added keys). */
function humanise(key: string): string {
  const text = key.replace(/_/g, " ").trim();
  return text ? text[0].toUpperCase() + text.slice(1) : key;
}

const capitalise = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

function formatValue(key: string, value: SpecValue): string | null {
  const format = FORMATS[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return format?.number ? format.number(value) : decimal(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => item.trim()).filter(Boolean);
    return items.length > 0 ? items.join(", ") : null;
  }
  const text = value.trim();
  if (!text) return null;
  // A numeric string for a numeric key (e.g. typed by hand) still gets its unit.
  if (format?.number && /^\d+(\.\d+)?$/.test(text)) return format.number(Number(text));
  return key === "grip" ? capitalise(text) : text;
}

/**
 * Rows for the spec table: documented keys first (in sheet order), then any other keys in the
 * order they were stored. Values that are null/empty are skipped — never guessed.
 */
export function formatSpecs(specs: Record<string, SpecValue> | null | undefined): SpecRow[] {
  if (!specs) return [];
  const keys = Object.keys(specs);
  const ordered = [...ORDER.filter((key) => keys.includes(key)), ...keys.filter((key) => !(key in FORMATS))];
  const rows: SpecRow[] = [];
  for (const key of ordered) {
    const value = formatValue(key, specs[key]);
    if (value === null) continue;
    rows.push({ key, label: FORMATS[key]?.label ?? humanise(key), value });
  }
  return rows;
}
