import "server-only";

/**
 * The finder's domain lexicon (blueprint §9.14 step 2, §17.1 consumer-electronics row "spec
 * thresholds → scores"). SERVER-ONLY: the browser receives only the per-product vectors this
 * produces (lib/quiz-catalogue.ts), never these tables.
 *
 * Rules
 * - Tables map spec fragments to axis readings, ordered SPECIFIC-BEFORE-GENERAL; within a table
 *   the FIRST match wins ("rtx 4070" before "rtx", "core ultra 7" before "core 7").
 *   Numeric specs use threshold tables ordered highest first (the first threshold met wins).
 * - Readings are defensible facts about the COMPONENT (a tier within its family, a physical
 *   measurement, a drive type) — never a guess about the product. A spec the tables don't
 *   recognise produces no reading: unknown stays unknown.
 * - Each axis is the weighted mean of the readings actually present (the weights say how much
 *   each spec speaks to that axis in that category — the blueprint's "weight each attribute by
 *   where it sits"). Every reading records WHICH spec drove it and a fact phrase built only from
 *   that spec's own value ("axisNotes"), so explanations can quote it.
 * - `value` (price-value) is not read here: it needs the category's prices, so
 *   lib/quiz-catalogue.ts computes it.
 * - Uses implied by specs are limited to unambiguous ones (a dedicated gaming GPU → gaming; a
 *   portable SSD or flash drive → on the move; an external/desktop hard drive → backup; a
 *   vertical grip → ergonomic; a 16K+ DPI sensor → gaming; a laptop ≤ 1.5 kg → on the move).
 *   Everything else comes from `attributes.use_cases`.
 */

import type { Axis, AxisScores } from "@/lib/attribute-axes";
import type { SpecValue } from "@/lib/catalogue-shared";
import { USE_CASES, type FinderDriver, type FinderFeature, type FinderStyle, type UseCase } from "@/lib/quiz";

// ── Shapes ────────────────────────────────────────────────────────────────────

export type SpecReading = {
  /** performance / portability / battery readings (value is added by quiz-catalogue). */
  axes: AxisScores;
  notes: Partial<Record<Axis, FinderDriver[]>>;
  /** Physical property: 0 (featherweight) – 10 (heavy) for the category; null = unknown. */
  weight: number | null;
  weightG: number | null;
  heavy: boolean | null;
  wireless: boolean | null;
  uses: UseCase[];
  styles: FinderStyle[];
  features: FinderFeature[];
  context: string | null;
  /** Storage capacity in GB (drives storage price-value), null when not stated. */
  capacityGb: number | null;
  /** The value driver phrase for storage ("8 TB of space"), null elsewhere. */
  capacityText: string | null;
};

/** One component reading before the axis is combined. */
type Part = { axis: Axis; spec: string; reading: number; weight: number; text: string };

type Fragment = { match: RegExp; reading: number; uses?: UseCase[]; tag?: string };
type Threshold = readonly [min: number, reading: number];

// ── Text helpers (fact phrases are built only from the spec's own value) ─────

const clean = (value: string, max = 60) => value.replace(/[®™]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const norm = (value: string) => clean(value, 200).toLowerCase();

const number = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 1 });

/** "a"/"an" by the sound of the first word ("an 8,000 DPI sensor", "an AMD…", "a USB-C…"). */
function withArticle(phrase: string): string {
  const first = phrase.trim();
  const digits = first.match(/^[\d,.]+/)?.[0]?.replace(/,/g, "") ?? null;
  if (digits !== null) {
    const whole = digits.split(".")[0];
    const an = whole.startsWith("8") || ((whole.length === 2 || whole.length === 5) && /^1[18]/.test(whole));
    return `${an ? "an" : "a"} ${first}`;
  }
  if (/^(usb|uni|eu|one)/i.test(first)) return `a ${first}`;
  if (/^(hdmi|hdd|ssd|rgb|nvme|lcd|led|oled|ip\d|msi|amd|m\d|rtx)/i.test(first)) return `an ${first}`;
  return /^[aeiou]/i.test(first) ? `an ${first}` : `a ${first}`;
}

const KEEP_CASE = /^(Bluetooth|USB|Thunderbolt|Wi-?Fi|NVMe|SSD|HDD|RGB|PBT|ABS|IP\d|Hall|Cherry|Gateron|Kailh)/;
/** Lower-case the first letter unless it starts a proper noun or an acronym. */
function lowerFirst(text: string): string {
  if (!text || KEEP_CASE.test(text) || /^[A-Z0-9]{2,}\b/.test(text)) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Decimal storage sizes, as drives are sold (1 TB = 1000 GB). */
export function capacityLabel(gb: number): string {
  if (gb >= 1000) return `${number(gb / 1000)} TB`;
  return `${number(gb)} GB`;
}

// ── Readers ───────────────────────────────────────────────────────────────────

function firstMatch(text: string, table: readonly Fragment[]): Fragment | null {
  for (const entry of table) if (entry.match.test(text)) return entry;
  return null;
}

function threshold(value: number, table: readonly Threshold[]): number {
  for (const [min, reading] of table) if (value >= min) return reading;
  return table[table.length - 1][1];
}

/** For "lower is better" measurements (weight): the first row whose ceiling is met wins. */
function ceiling(value: number, table: readonly Threshold[]): number {
  for (const [max, reading] of table) if (value <= max) return reading;
  return table[table.length - 1][1];
}

const asText = (value: SpecValue | undefined): string | null => (typeof value === "string" && value.trim() ? value : null);
const asList = (value: SpecValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((v) => typeof v === "string" && v.trim()).map((v) => clean(v)) : typeof value === "string" && value.trim() ? [clean(value)] : [];
function asNumber(value: SpecValue | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// THE LEXICON — ordered tables, specific before general, first match wins
// ═════════════════════════════════════════════════════════════════════════════

/** Laptop processors → performance (tier within its family). */
export const CPU_TABLE: readonly Fragment[] = [
  { match: /\bcore\s*m[357]\b/, reading: 2.5 },
  { match: /\bcore\s*ultra\s*9\b/, reading: 9.5 },
  { match: /\bcore\s*ultra\s*7\b/, reading: 8.5 },
  { match: /\bcore\s*ultra\s*5\b/, reading: 7 },
  { match: /\bcore\s*ultra\b/, reading: 7 },
  { match: /\bcore\s*i9\b|\bi9-\d/, reading: 9 },
  { match: /\bcore\s*i7\b|\bi7-\d/, reading: 8 },
  { match: /\bcore\s*i5\b|\bi5-\d/, reading: 6.5 },
  { match: /\bcore\s*i3\b|\bi3-\d/, reading: 4 },
  { match: /\bcore\s*7\b/, reading: 7.5 },
  { match: /\bcore\s*5\b/, reading: 6 },
  { match: /\bcore\s*3\b/, reading: 3.5 },
  { match: /\bryzen\s*ai\s*(max\+?|9)\b/, reading: 9.5 },
  { match: /\bryzen\s*ai\s*7\b/, reading: 8.5 },
  { match: /\bryzen\s*ai\s*5\b/, reading: 7 },
  { match: /\bryzen\s*9\b/, reading: 9 },
  { match: /\bryzen\s*7\b/, reading: 8 },
  { match: /\bryzen\s*5\b/, reading: 6.5 },
  { match: /\bryzen\s*3\b/, reading: 4 },
  { match: /\bm[1-4]\s*(ultra|max)\b/, reading: 10 },
  { match: /\bm4\s*pro\b/, reading: 9.5 },
  { match: /\bm[1-3]\s*pro\b/, reading: 9 },
  { match: /\bm4\b/, reading: 8.5 },
  { match: /\bm3\b/, reading: 8 },
  { match: /\bm2\b/, reading: 7.5 },
  { match: /\bm1\b/, reading: 6.5 },
  { match: /\bsnapdragon\s*x\s*elite\b/, reading: 8 },
  { match: /\bsnapdragon\s*x\s*plus\b/, reading: 7 },
  { match: /\bsnapdragon\b/, reading: 5 },
  { match: /\bpentium\b/, reading: 2 },
  { match: /\bceleron\b/, reading: 1.5 },
  { match: /\bn(50|97|100|150|200|250|300|305)\b/, reading: 2 },
  { match: /\bathlon\b/, reading: 2 },
  { match: /\bmediatek\b/, reading: 2.5 },
];

/**
 * Laptop graphics → performance. `tag: "dedicated"` = a discrete consumer GPU (the fact that
 * makes a laptop game-capable → use "gaming"); `tag: "workstation"` = pro GPUs (→ "creative").
 */
export const GPU_TABLE: readonly Fragment[] = [
  { match: /\brtx\s*(a\d{3,4}|\d{4}\s*ada)\b|\bquadro\b/, reading: 7, uses: ["creative"], tag: "workstation" },
  { match: /\brtx\s*(5090|4090)\b/, reading: 10, uses: ["gaming"], tag: "dedicated" },
  { match: /\brtx\s*(5080|4080)\b/, reading: 9.5, uses: ["gaming"], tag: "dedicated" },
  { match: /\brtx\s*5070\s*ti\b/, reading: 9.2, uses: ["gaming"], tag: "dedicated" },
  { match: /\brtx\s*(5070|4070|3080)\b/, reading: 8.5, uses: ["gaming"], tag: "dedicated" },
  { match: /\brtx\s*(5060|4060|3070)\b/, reading: 7.5, uses: ["gaming"], tag: "dedicated" },
  { match: /\brtx\s*(5050|4050|3060)\b/, reading: 6.5, uses: ["gaming"], tag: "dedicated" },
  { match: /\brtx\s*(3050|2050)\b/, reading: 5, uses: ["gaming"], tag: "dedicated" },
  { match: /\bgtx\b/, reading: 4, uses: ["gaming"], tag: "dedicated" },
  { match: /\brx\s*(7900|6850)/, reading: 9, uses: ["gaming"], tag: "dedicated" },
  { match: /\brx\s*(7800|6800)/, reading: 8.5, uses: ["gaming"], tag: "dedicated" },
  { match: /\brx\s*(7700|6700)/, reading: 7.5, uses: ["gaming"], tag: "dedicated" },
  { match: /\brx\s*(7600|6600)/, reading: 7, uses: ["gaming"], tag: "dedicated" },
  { match: /\brx\s*(6500|6450|6550)/, reading: 4.5, uses: ["gaming"], tag: "dedicated" },
  { match: /\bradeon\s*rx\b|\brx\s*\d{4}/, reading: 6.5, uses: ["gaming"], tag: "dedicated" },
  { match: /\barc\s*a\d{3}m?\b/, reading: 4.5, uses: ["gaming"], tag: "dedicated" },
  { match: /\brtx\b/, reading: 6.5, uses: ["gaming"], tag: "dedicated" },
  { match: /\bradeon\s*8\d0m\b/, reading: 4.5 },
  { match: /\bradeon\s*7\d0m\b/, reading: 4 },
  { match: /\bradeon\s*6\d0m\b/, reading: 3.5 },
  { match: /\barc\s*1[34]0v\b|\barc\s*graphics\b|\bintel\s*arc\b/, reading: 3.5 },
  { match: /\biris\s*xe\b/, reading: 2.5 },
  { match: /\buhd\b/, reading: 1.5 },
  { match: /\bradeon\b/, reading: 3 },
  { match: /\bintegrated\b/, reading: 2 },
];

/** Laptop drive technology → performance. */
export const LAPTOP_STORAGE_TYPE_TABLE: readonly Fragment[] = [
  { match: /\bnvme\b|\bpcie\b/, reading: 8, tag: "NVMe SSD" },
  { match: /\bssd\b|solid[\s-]*state/, reading: 7, tag: "SSD" },
  { match: /\bemmc\b/, reading: 2, tag: "eMMC" },
  { match: /\bhdd\b|hard\s*(disk|drive)/, reading: 2.5, tag: "hard drive" },
];

/** External storage interfaces → performance (link speed). */
export const INTERFACE_TABLE: readonly Fragment[] = [
  { match: /thunderbolt\s*5/, reading: 10 },
  { match: /thunderbolt|\busb\s*4\b|\busb4\b|40\s*gbps/, reading: 9.5 },
  { match: /3\.2\s*gen\s*2\s*x\s*2|20\s*gbps/, reading: 9 },
  { match: /3\.[12]\s*gen\s*2|10\s*gbps/, reading: 7.5 },
  { match: /3\.[12]\s*gen\s*1|5\s*gbps/, reading: 5 },
  { match: /usb[\s-]*(type[\s-]*)?[ac]?[\s-]*3(\.\d)?\b/, reading: 5 },
  { match: /usb[\s-]*(type[\s-]*)?[ac]?[\s-]*2(\.0)?\b/, reading: 1.5 },
];

/**
 * External storage types (the admin's `type` vocabulary) → drive character.
 * performance: SSDs are fast, hard drives slow (only used when no speed is stated);
 * portability / physical weight: fixed by the form factor where the type fixes it.
 */
type StorageType = { match: RegExp; label: string; performance: number | null; portability: number; weight: number | null; heavy: boolean | null; uses: UseCase[] };
export const STORAGE_TYPE_TABLE: readonly StorageType[] = [
  { match: /portable\s*ssd/, label: "Portable SSD", performance: 7.5, portability: 9, weight: 1, heavy: false, uses: ["mobile"] },
  { match: /flash|thumb|pen\s*drive/, label: "Flash drive", performance: null, portability: 10, weight: 0.5, heavy: false, uses: ["mobile"] },
  { match: /external\s*(hdd|hard)/, label: "External hard drive", performance: 3, portability: 6, weight: null, heavy: null, uses: ["backup"] },
  { match: /desktop/, label: "Desktop drive", performance: null, portability: 1.5, weight: 8, heavy: true, uses: ["backup"] },
  { match: /\bssd\b/, label: "External SSD", performance: 7.5, portability: 8, weight: null, heavy: null, uses: [] },
  { match: /\bhdd\b|hard\s*drive/, label: "Hard drive", performance: 3, portability: 5, weight: null, heavy: null, uses: ["backup"] },
];

/** Keyboard layouts → portability (and the style label's size word). */
type Layout = { match: RegExp; portability: number; label: string; text: string };
export const LAYOUT_TABLE: readonly Layout[] = [
  { match: /\b60\s*%/, portability: 9.5, label: "Compact 60%", text: "a compact 60% layout" },
  { match: /\b65\s*%/, portability: 9, label: "Compact 65%", text: "a compact 65% layout" },
  { match: /\b75\s*%/, portability: 8, label: "75%", text: "a 75% layout" },
  { match: /\btkl\b|tenkeyless|\b80\s*%/, portability: 6, label: "Tenkeyless", text: "a tenkeyless layout" },
  { match: /\b9[68]\s*%|\b1800\b/, portability: 4.5, label: "96%", text: "a 96% layout" },
  { match: /full[\s-]*size|\b100\s*%/, portability: 2.5, label: "Full-size", text: "a full-size layout" },
];

/** Keyboard switches → performance (actuation technology); low-profile also helps portability. */
type Switch = Fragment & { family: "mechanical" | "low-profile" | null; portability?: number };
export const SWITCH_TABLE: readonly Switch[] = [
  { match: /hall[\s-]*effect|magnetic/, reading: 9, family: "mechanical" },
  { match: /optical/, reading: 8.5, family: "mechanical" },
  { match: /low[\s-]*profile\s*(mechanical|linear|tactile|clicky)/, reading: 6.5, family: "low-profile", portability: 8 },
  { match: /low[\s-]*profile/, reading: 5, family: "low-profile", portability: 8 },
  { match: /mechanical|linear|tactile|clicky|\b(red|brown|blue|silver|yellow)\b|cherry|gateron|kailh|outemu/, reading: 7, family: "mechanical" },
  { match: /scissor/, reading: 5, family: null, portability: 7 },
  { match: /membrane|rubber\s*dome/, reading: 3.5, family: null },
];

/** Wireless and wired connection words (docs/domain-model.md §3 conventions). */
const WIRELESS = /tri[\s-]*mode|bluetooth|2\.4\s*g(hz)?|wireless|\brf\b|dongle|receiver/;
const WIRED = /wired|\busb\b|usb-?[ac]|cable|corded/;

/** IP ratings that mean dust AND water resistance (first digit ≥ 5, second ≥ 4). */
const IP_RATING = /\bip\s*([5-6])([4-9])\b/i;

// ── Numeric thresholds (highest first; weights use ceilings, lowest first) ───

const RAM_GB: readonly Threshold[] = [[64, 10], [32, 9], [24, 8], [16, 7], [12, 5.5], [8, 4], [0, 2]];
const LAPTOP_STORAGE_GB: readonly Threshold[] = [[2000, 9], [1000, 8], [512, 6], [256, 4], [0, 2]];
const REFRESH_HZ: readonly Threshold[] = [[240, 9.5], [165, 8.5], [144, 8], [120, 7], [90, 6], [0, 4]];
const LAPTOP_BATTERY_H: readonly Threshold[] = [[18, 10], [14, 9], [11, 8], [9, 7], [7, 5.5], [5, 4], [0, 2.5]];
const LAPTOP_BATTERY_WH: readonly Threshold[] = [[90, 9], [75, 8], [60, 6.5], [50, 5], [40, 4], [0, 3]];
const DRIVE_SPEED_MBPS: readonly Threshold[] = [[3000, 10], [2000, 9.5], [1000, 8.5], [800, 7.5], [500, 6.5], [300, 5], [150, 3.5], [80, 2.5], [0, 1.5]];
const KEYBOARD_BATTERY_H: readonly Threshold[] = [[1000, 10], [400, 9], [200, 8], [100, 7], [50, 5.5], [20, 4], [0, 3]];
const MOUSE_BATTERY_H: readonly Threshold[] = [[2000, 10], [500, 9], [150, 7.5], [70, 6], [30, 4.5], [0, 3]];
const MOUSE_DPI: readonly Threshold[] = [[25000, 10], [18000, 9], [12000, 8], [8000, 7], [4000, 5.5], [2000, 4], [0, 3]];
/** A 16K+ DPI sensor is a gaming-class sensor. */
const GAMING_DPI = 16000;

/** Per-category weight scales: [ceiling, portability] and [ceiling, heaviness]; heavy above `heavyAbove`. */
type WeightScale = { unit: "kg" | "g"; portability: readonly Threshold[]; heaviness: readonly Threshold[]; heavyAbove: number };
export const WEIGHT_SCALES: Record<string, WeightScale> = {
  laptops: {
    unit: "kg",
    portability: [[1.0, 10], [1.3, 9], [1.6, 7.5], [2.0, 5.5], [2.5, 3.5], [Number.POSITIVE_INFINITY, 2]],
    heaviness: [[1.0, 1], [1.3, 2], [1.6, 3.5], [2.0, 5.5], [2.5, 7.5], [Number.POSITIVE_INFINITY, 9]],
    heavyAbove: 2.0,
  },
  storage: {
    unit: "g",
    portability: [[60, 10], [150, 9], [300, 7], [600, 5], [1200, 2.5], [Number.POSITIVE_INFINITY, 1.5]],
    heaviness: [[60, 0.5], [150, 1.5], [300, 3], [600, 5], [1200, 7.5], [Number.POSITIVE_INFINITY, 9]],
    heavyAbove: 600,
  },
  keyboards: {
    unit: "g",
    portability: [[400, 9.5], [600, 8], [800, 6.5], [1000, 5], [1300, 3.5], [Number.POSITIVE_INFINITY, 2]],
    heaviness: [[400, 1.5], [600, 3], [800, 4.5], [1000, 6], [1300, 7.5], [Number.POSITIVE_INFINITY, 9]],
    heavyAbove: 1000,
  },
  mice: {
    unit: "g",
    portability: [[60, 9.5], [80, 9], [100, 8], [120, 6.5], [140, 5], [Number.POSITIVE_INFINITY, 3.5]],
    heaviness: [[60, 1], [80, 2.5], [100, 4], [120, 5.5], [140, 7], [Number.POSITIVE_INFINITY, 8.5]],
    heavyAbove: 120,
  },
};

/** Laptop screen size (inches) → portability. */
const SCREEN_INCHES: readonly Threshold[] = [[13.4, 9], [14.5, 8], [15.6, 5], [16.1, 4.5], [Number.POSITIVE_INFINITY, 2.5]];
/** A laptop at or under this weight is a carry-everywhere machine (use "mobile"). */
const MOBILE_LAPTOP_KG = 1.5;
/** A drive this large is a backup drive. */
const BACKUP_CAPACITY_GB = 2000;

/**
 * How much each spec speaks to an axis, per category (weighted mean over the specs present).
 * Specs not listed for an axis don't move it.
 */
export const AXIS_WEIGHTS: Record<string, Partial<Record<Axis, Record<string, number>>>> = {
  laptops: {
    performance: { cpu: 0.4, gpu: 0.3, ram_gb: 0.15, storage: 0.1, refresh: 0.05 },
    portability: { weight: 0.7, screen: 0.3 },
    battery: { battery_h: 0.7, battery_wh: 0.3 },
  },
  storage: {
    performance: { speed: 0.6, interface: 0.25, type: 0.15 },
    portability: { type: 0.5, weight: 0.35, rugged: 0.15 },
  },
  keyboards: {
    performance: { switch: 1 },
    portability: { layout: 0.5, weight: 0.4, switch: 0.1 },
    battery: { battery_h: 1 },
  },
  mice: {
    performance: { dpi: 1 },
    portability: { weight: 1 },
    battery: { battery_h: 1 },
  },
};

/** Style nouns for the categories this lexicon knows. */
const NOUN: Record<string, string> = { laptops: "laptop", storage: "storage drive", keyboards: "keyboard", mice: "mouse" };

/** Style labels named by a use (tagged uses come first, so the product's own positioning leads). */
export const USE_STYLES: Record<string, Partial<Record<UseCase, string>>> = {
  laptops: { gaming: "Gaming laptop", creative: "Creator laptop", mobile: "Lightweight laptop", everyday: "Everyday laptop" },
  keyboards: { gaming: "Gaming keyboard" },
  mice: { gaming: "Gaming mouse", ergonomic: "Ergonomic mouse", mobile: "Travel mouse" },
};

// ═════════════════════════════════════════════════════════════════════════════
// readSpecs — one product's reading (the blueprint's readComposition)
// ═════════════════════════════════════════════════════════════════════════════

const round1 = (n: number) => Math.round(n * 10) / 10;

function combine(categoryId: string, parts: Part[]): { axes: AxisScores; notes: Partial<Record<Axis, FinderDriver[]>> } {
  const axes: AxisScores = {};
  const notes: Partial<Record<Axis, FinderDriver[]>> = {};
  const table = AXIS_WEIGHTS[categoryId] ?? {};
  for (const axis of ["performance", "portability", "battery"] as const) {
    const weights = table[axis] ?? {};
    const mine = parts.filter((p) => p.axis === axis && (weights[p.spec] ?? p.weight) > 0);
    if (mine.length === 0) continue;
    let total = 0;
    let sum = 0;
    for (const p of mine) {
      const w = weights[p.spec] ?? p.weight;
      total += w;
      sum += w * p.reading;
    }
    axes[axis] = round1(sum / total);
    const drivers = mine
      .filter((p) => p.text)
      .sort((a, b) => b.reading - a.reading || (weights[b.spec] ?? b.weight) - (weights[a.spec] ?? a.weight))
      .map<FinderDriver>((p) => ({ spec: p.spec, text: p.text, reading: p.reading }));
    if (drivers.length > 0) notes[axis] = drivers;
  }
  return { axes, notes };
}

function addUse(uses: UseCase[], ...more: (UseCase | undefined)[]) {
  for (const use of more) if (use && !uses.includes(use)) uses.push(use);
}

/**
 * Read one product's specs into axis readings, physical facts, uses, style labels, citeable
 * features and a context clause. `useCases` = `attributes.use_cases` (unknown values ignored).
 */
export function readSpecs(categoryId: string, specs: Record<string, SpecValue>, useCases: readonly string[]): SpecReading {
  const parts: Part[] = [];
  const uses: UseCase[] = [];
  const features: FinderFeature[] = [];
  /** Category-specific labels (drive type, keyboard build, wireless mouse). */
  const styles: FinderStyle[] = [];
  const useStyles: Partial<Record<UseCase, string>> = { ...(USE_STYLES[categoryId] ?? {}) };
  let context: string | null = null;
  let weight: number | null = null;
  let weightG: number | null = null;
  let heavy: boolean | null = null;
  let wireless: boolean | null = null;
  let capacityGb: number | null = null;
  let capacityText: string | null = null;

  for (const tag of useCases) if ((USE_CASES as readonly string[]).includes(tag)) addUse(uses, tag as UseCase);

  // ── shared facts: physical weight, connectivity, battery, ruggedness ──────
  const scale = WEIGHT_SCALES[categoryId];
  const kg = asNumber(specs.weight_kg);
  const grams = asNumber(specs.weight_g) ?? (kg !== null ? kg * 1000 : null);
  if (grams !== null && grams > 0) {
    weightG = Math.round(grams);
    if (scale) {
      const measured = scale.unit === "kg" ? grams / 1000 : grams;
      weight = ceiling(measured, scale.heaviness);
      heavy = measured > scale.heavyAbove;
      const text = withArticle(scale.unit === "kg" ? `${number(grams / 1000)} kg build` : `${number(grams)} g build`);
      parts.push({ axis: "portability", spec: "weight", reading: ceiling(measured, scale.portability), weight: 0.5, text });
      if (categoryId === "laptops" && grams / 1000 <= MOBILE_LAPTOP_KG) addUse(uses, "mobile");
    }
  }

  const connections = asList(specs.connectivity);
  if (connections.length > 0) {
    const wirelessEntries = connections.filter((c) => WIRELESS.test(c.toLowerCase()));
    const wiredEntries = connections.filter((c) => !WIRELESS.test(c.toLowerCase()) && WIRED.test(c.toLowerCase()));
    if (wirelessEntries.length > 0) {
      wireless = true;
      features.push({ spec: "connectivity", text: `${lowerFirst(wirelessEntries.join(" and "))} connectivity`.replace(/connectivity connectivity$/, "connectivity"), uses: ["mobile", "everyday"], conflicts: [] });
    } else if (wiredEntries.length > 0) {
      wireless = false;
      features.push({ spec: "connectivity", text: withArticle(`${lowerFirst(wiredEntries.join(" and "))} connection`), uses: [], conflicts: ["wired"] });
    }
  }

  const rugged = asText(specs.rugged);
  const ip = rugged?.match(IP_RATING);
  if (ip) {
    context = `with ${ip[0].toUpperCase().replace(/\s+/g, "")} dust and water resistance`;
    parts.push({ axis: "portability", spec: "rugged", reading: 9, weight: 0.15, text: "" });
  }

  // ── per category ──────────────────────────────────────────────────────────
  if (categoryId === "laptops") {
    const cpu = asText(specs.cpu);
    if (cpu) {
      const hit = firstMatch(norm(cpu), CPU_TABLE);
      if (hit) {
        const name = clean(cpu);
        parts.push({ axis: "performance", spec: "cpu", reading: hit.reading, weight: 0.4, text: withArticle(/processor|cpu|chip/i.test(name) ? name : `${name} processor`) });
      }
    }
    const gpu = asText(specs.gpu);
    if (gpu) {
      const hit = firstMatch(norm(gpu), GPU_TABLE);
      if (hit) {
        const name = clean(gpu);
        parts.push({ axis: "performance", spec: "gpu", reading: hit.reading, weight: 0.3, text: /graphics|gpu/i.test(name) ? name : `${name} graphics` });
        addUse(uses, ...(hit.uses ?? []));
      }
    }
    const ram = asNumber(specs.ram_gb);
    if (ram !== null && ram > 0) parts.push({ axis: "performance", spec: "ram_gb", reading: threshold(ram, RAM_GB), weight: 0.15, text: `${number(ram)} GB of RAM` });

    const storageGb = asNumber(specs.storage_gb);
    const storageType = asText(specs.storage_type);
    const typeHit = storageType ? firstMatch(norm(storageType), LAPTOP_STORAGE_TYPE_TABLE) : null;
    if ((storageGb !== null && storageGb > 0) || typeHit) {
      const readings = [storageGb !== null && storageGb > 0 ? threshold(storageGb, LAPTOP_STORAGE_GB) : null, typeHit?.reading ?? null].filter((n): n is number => n !== null);
      const label = typeHit?.tag ?? "drive";
      const text = storageGb !== null && storageGb > 0 ? withArticle(`${capacityLabel(storageGb)} ${label}`) : `${label} storage`;
      parts.push({ axis: "performance", spec: "storage", reading: readings.reduce((a, b) => a + b, 0) / readings.length, weight: 0.1, text });
    }

    const display = asText(specs.display);
    const inches = display?.match(/(\d{2}(?:\.\d)?)\s*(?:"|”|''|-?\s*inch|\s*in\b)/i);
    if (inches) {
      const size = Number(inches[1]);
      if (size >= 10 && size <= 20) parts.push({ axis: "portability", spec: "screen", reading: ceiling(size, SCREEN_INCHES), weight: 0.3, text: withArticle(`${number(size)}-inch screen`) });
    }
    const hz = asNumber(specs.refresh_hz) ?? (display?.match(/(\d{2,3})\s*hz/i) ? Number(display.match(/(\d{2,3})\s*hz/i)![1]) : null);
    if (hz !== null && hz >= 30 && hz <= 600) parts.push({ axis: "performance", spec: "refresh", reading: threshold(hz, REFRESH_HZ), weight: 0.05, text: withArticle(`${number(hz)} Hz display`) });

    const hours = asNumber(specs.battery_h);
    if (hours !== null && hours > 0) parts.push({ axis: "battery", spec: "battery_h", reading: threshold(hours, LAPTOP_BATTERY_H), weight: 0.7, text: `a rated ${number(hours)}-hour battery` });
    const wh = asNumber(specs.battery_wh);
    if (wh !== null && wh > 0) parts.push({ axis: "battery", spec: "battery_wh", reading: threshold(wh, LAPTOP_BATTERY_WH), weight: 0.3, text: withArticle(`${number(wh)} Wh battery`) });

  } else if (categoryId === "storage") {
    const typeText = asText(specs.type);
    const type = typeText ? STORAGE_TYPE_TABLE.find((t) => t.match.test(norm(typeText))) ?? null : null;
    if (type) {
      if (type.performance !== null) parts.push({ axis: "performance", spec: "type", reading: type.performance, weight: 0.15, text: "" });
      parts.push({ axis: "portability", spec: "type", reading: type.portability, weight: 0.5, text: "" });
      if (weight === null && type.weight !== null) weight = type.weight;
      if (heavy === null && type.heavy !== null) heavy = type.heavy;
      addUse(uses, ...type.uses);
    }

    const read = asNumber(specs.read_mbps);
    const speed = asNumber(specs.speed_mbps);
    const fastest = Math.max(read ?? 0, speed ?? 0);
    if (fastest > 0) {
      const text = read !== null && read >= (speed ?? 0) ? `read speeds up to ${number(read)} MB/s` : `speeds up to ${number(speed ?? fastest)} MB/s`;
      parts.push({ axis: "performance", spec: "speed", reading: threshold(fastest, DRIVE_SPEED_MBPS), weight: 0.6, text });
    }
    const iface = asText(specs.interface);
    if (iface) {
      const lower = norm(iface);
      const hit = firstMatch(lower, INTERFACE_TABLE);
      if (hit) parts.push({ axis: "performance", spec: "interface", reading: hit.reading, weight: 0.25, text: withArticle(`${clean(iface)} connection`) });
      if (/usb[\s-]*c/.test(lower) && /usb[\s-]*a/.test(lower)) {
        features.push({ spec: "interface", text: "both USB-C and USB-A connectors", uses: ["mobile", "everyday"], conflicts: [] });
      }
    }

    const capacity = asNumber(specs.capacity_gb);
    if (capacity !== null && capacity > 0) {
      capacityGb = capacity;
      capacityText = `${capacityLabel(capacity)} of space`;
      if (capacity >= BACKUP_CAPACITY_GB) addUse(uses, "backup");
    }

    if (type) {
      const backupDesk = type.label === "Desktop drive" && uses.includes("backup");
      styles.push({ label: backupDesk ? "Desktop backup drive" : type.label, use: backupDesk ? "backup" : null, conflicts: type.heavy ? ["heavy"] : [] });
    }
  } else if (categoryId === "keyboards") {
    const layoutText = asText(specs.layout);
    const layout = layoutText ? LAYOUT_TABLE.find((l) => l.match.test(norm(layoutText))) ?? null : null;
    if (layout) parts.push({ axis: "portability", spec: "layout", reading: layout.portability, weight: 0.5, text: layout.text });

    const switchText = asText(specs.switch);
    const sw = switchText ? (SWITCH_TABLE.find((s) => s.match.test(norm(switchText))) ?? null) : null;
    if (sw && switchText) {
      const name = clean(switchText);
      parts.push({ axis: "performance", spec: "switch", reading: sw.reading, weight: 1, text: /switch/i.test(name) ? lowerFirst(name) : `${lowerFirst(name)} switches` });
      if (sw.portability) parts.push({ axis: "portability", spec: "switch", reading: sw.portability, weight: 0.1, text: "" });
    }

    if (specs.hot_swap === true) features.push({ spec: "hot_swap", text: "hot-swap switch sockets", uses: [], conflicts: [] });
    const backlight = asText(specs.backlight);
    if (backlight) {
      const b = norm(backlight);
      if (/per[\s-]*key\s*rgb/.test(b)) features.push({ spec: "backlight", text: "per-key RGB backlighting", uses: ["gaming"], conflicts: [] });
      else if (/rgb/.test(b)) features.push({ spec: "backlight", text: "RGB backlighting", uses: ["gaming"], conflicts: [] });
      else if (/white/.test(b)) features.push({ spec: "backlight", text: "white backlighting", uses: [], conflicts: [] });
    }
    const keycaps = asText(specs.keycaps);
    if (keycaps && /pbt/i.test(keycaps)) features.push({ spec: "keycaps", text: `${clean(keycaps)} keycaps`.replace(/keycaps keycaps$/i, "keycaps"), uses: [], conflicts: [] });

    const hours = asNumber(specs.battery_h);
    if (hours !== null && hours > 0) parts.push({ axis: "battery", spec: "battery_h", reading: threshold(hours, KEYBOARD_BATTERY_H), weight: 1, text: `a rated ${number(hours)}-hour battery` });

    const words = [wireless === true ? "wireless" : null, layout ? layout.label : null, sw?.family === "mechanical" ? "mechanical" : sw?.family === "low-profile" ? "low-profile" : null].filter(Boolean) as string[];
    if (words.length > 0) {
      const label = `${words.join(" ")} keyboard`;
      styles.push({ label: label.charAt(0).toUpperCase() + label.slice(1), use: null, conflicts: [] });
    }
  } else if (categoryId === "mice") {
    const dpi = asNumber(specs.dpi_max);
    const sensor = asText(specs.sensor);
    const sensorK = sensor?.match(/(\d{1,2}(?:\.\d)?)\s*k\b/i);
    const effective = dpi ?? (sensorK ? Number(sensorK[1]) * 1000 : null);
    if (effective !== null && effective > 0) {
      const text = dpi !== null ? withArticle(`${number(dpi)} DPI sensor`) : withArticle(/sensor/i.test(clean(sensor!)) ? clean(sensor!) : `${clean(sensor!)} sensor`);
      parts.push({ axis: "performance", spec: "dpi", reading: threshold(effective, MOUSE_DPI), weight: 1, text });
      if (effective >= GAMING_DPI) addUse(uses, "gaming");
    }
    if (sensor && /gaming/i.test(sensor)) addUse(uses, "gaming");

    const grip = asText(specs.grip);
    if (grip) {
      const g = norm(grip);
      if (/vertical/.test(g)) {
        addUse(uses, "ergonomic");
        features.push({ spec: "grip", text: "a vertical grip", uses: ["ergonomic"], conflicts: [] });
      } else if (/palm|claw|fingertip/.test(g)) {
        features.push({ spec: "grip", text: `a shape made for ${g.match(/palm|claw|fingertip/)![0]} grip`, uses: [], conflicts: [] });
      }
    }
    if (specs.silent === true) features.push({ spec: "silent", text: "silent clicks", uses: ["everyday", "mobile", "ergonomic"], conflicts: [] });

    const hours = asNumber(specs.battery_h);
    if (hours !== null && hours > 0) parts.push({ axis: "battery", spec: "battery_h", reading: threshold(hours, MOUSE_BATTERY_H), weight: 1, text: `a rated ${number(hours)}-hour battery` });

    if (/vertical/i.test(grip ?? "")) useStyles.ergonomic = "Vertical ergonomic mouse";
    if (wireless === true) styles.push({ label: "Wireless mouse", use: null, conflicts: [] });
  }

  const fromUses = uses.flatMap<FinderStyle>((use) => (useStyles[use] ? [{ label: useStyles[use]!, use, conflicts: [] }] : []));
  const noun = NOUN[categoryId];
  const ordered = [
    ...(categoryId === "storage" ? [...styles, ...fromUses] : [...fromUses, ...styles]),
    { label: noun ? noun.charAt(0).toUpperCase() + noun.slice(1) : "Product", use: null, conflicts: [] } satisfies FinderStyle,
  ];
  const labels = new Set<string>();
  const uniqueStyles = ordered.filter((style) => !labels.has(style.label) && labels.add(style.label));

  const { axes, notes } = combine(categoryId, parts);
  return { axes, notes, weight, weightG, heavy, wireless, uses, styles: uniqueStyles, features, context, capacityGb, capacityText };
}

/** A product with no usable specs is excluded from the finder (blueprint §7.3, §9.14 step 3). */
export function hasSpecs(specs: Record<string, SpecValue>): boolean {
  return Object.values(specs).some((v) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0));
}
