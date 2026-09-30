/**
 * Business-time-zone dates for the admin (blueprint §11.3.5). Plain module.
 *
 * Every report day is an Asia/Colombo calendar day. Days are "YYYY-MM-DD" strings built from
 * the zone's own date parts (Intl), NEVER by slicing `toISOString()` — that is the UTC date,
 * which is yesterday between midnight and 05:30 in Colombo. A range is inclusive of both days
 * and turns into instants for PostgREST:
 *
 *   const { gte, lt } = rangeBounds(range);          // 00:00 on `from` … 00:00 the day after `to`
 *   query.gte("created_at", gte).lt("created_at", lt);
 *
 * Server code (SQL aggregates) should receive the same days plus BUSINESS_TIME_ZONE.
 */

export const BUSINESS_TIME_ZONE = "Asia/Colombo";

export type Ymd = string;
export type DateRange = { from: Ymd; to: Ymd };
export type DatePreset = "today" | "7d" | "30d" | "90d" | "custom";
export type DateRangeValue = DateRange & { preset: DatePreset };

export const DATE_PRESETS: readonly { key: DatePreset; label: string; short: string; days: number | null }[] = [
  { key: "today", label: "Today", short: "Today", days: 1 },
  { key: "7d", label: "Last 7 days", short: "7D", days: 7 },
  { key: "30d", label: "Last 30 days", short: "30D", days: 30 },
  { key: "90d", label: "Last 90 days", short: "90D", days: 90 },
  { key: "custom", label: "Custom range", short: "Custom", days: null },
];

/** Longest custom range the picker accepts (keeps aggregate reads bounded). */
export const MAX_RANGE_DAYS = 400;

type Instant = Date | number | string;

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function toMillis(value: Instant): number | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** The wall-clock parts of an instant in Asia/Colombo (null for an invalid date). */
export function zonedParts(value: Instant): ZonedParts | null {
  const ms = toMillis(value);
  if (ms === null) return null;
  const parts: Record<string, number> = {};
  for (const part of partsFormatter.formatToParts(ms)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Offset of the zone from UTC at an instant, in ms (Colombo: +5:30 = 19 800 000). */
function offsetAt(ms: number): number {
  const p = zonedParts(ms);
  if (!p) return 0;
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant (ms) of a Colombo wall-clock time. */
function zonedToMillis(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let ms = guess - offsetAt(guess);
  const corrected = guess - offsetAt(ms);
  if (corrected !== ms) ms = corrected; // DST-safe second pass (Colombo has none today)
  return ms;
}

export function isYmd(value: unknown): value is Ymd {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function ymdParts(ymd: Ymd): [number, number, number] {
  const [y, m, d] = ymd.split("-").map(Number);
  return [y, m, d];
}

/** Colombo calendar day of an instant ("" for an invalid date). */
export function ymdInZone(value: Instant): Ymd {
  const p = zonedParts(value);
  return p ? `${p.year}-${pad(p.month)}-${pad(p.day)}` : "";
}

/** Today in Colombo. */
export function todayYmd(now: Instant = Date.now()): Ymd {
  return ymdInZone(now);
}

/** Pure calendar arithmetic (no time zone involved). */
export function addDays(ymd: Ymd, days: number): Ymd {
  const [y, m, d] = ymdParts(ymd);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Whole days from `from` to `to`, inclusive (1 for a single day). */
export function daysInRange(range: DateRange): number {
  const [fy, fm, fd] = ymdParts(range.from);
  const [ty, tm, td] = ymdParts(range.to);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

/** Every day in the range, oldest first — to draw trend lines without gaps. */
export function eachDay(range: DateRange): Ymd[] {
  const days: Ymd[] = [];
  const count = Math.min(daysInRange(range), MAX_RANGE_DAYS + 1);
  for (let i = 0; i < count; i += 1) days.push(addDays(range.from, i));
  return days;
}

/** Start of a Colombo day as an ISO instant ("2026-09-21T18:30:00.000Z" for 22 Sep). */
export function startOfDayIso(ymd: Ymd): string {
  const [y, m, d] = ymdParts(ymd);
  return new Date(zonedToMillis(y, m, d)).toISOString();
}

/**
 * Instants for filtering a timestamptz column by an inclusive day range:
 * `gte` = 00:00:00 on `from`; `lt` = 00:00:00 on the day after `to` (use `.lt`);
 * `lte` = 23:59:59.999 on `to` (for APIs that need an inclusive end).
 */
export function rangeBounds(range: DateRange): { gte: string; lt: string; lte: string } {
  const gte = startOfDayIso(range.from);
  const lt = startOfDayIso(addDays(range.to, 1));
  return { gte, lt, lte: new Date(Date.parse(lt) - 1).toISOString() };
}

/** The same-length range immediately before `range` (for "vs previous period" deltas). */
export function previousRange(range: DateRange): DateRange {
  const length = daysInRange(range);
  return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
}

/** Preset → inclusive Colombo days ending today. "custom" returns the last 30 days as a start. */
export function presetRange(preset: DatePreset, now: Instant = Date.now()): DateRange {
  const today = todayYmd(now);
  const days = DATE_PRESETS.find((p) => p.key === preset)?.days ?? 30;
  return { from: addDays(today, -(days - 1)), to: today };
}

export function rangeValue(preset: Exclude<DatePreset, "custom">, now: Instant = Date.now()): DateRangeValue {
  return { preset, ...presetRange(preset, now) };
}

/** Validate/repair a custom range: real days, from ≤ to, not in the future, ≤ MAX_RANGE_DAYS. */
export function normalizeRange(range: Partial<DateRange>, now: Instant = Date.now()): DateRange {
  const today = todayYmd(now);
  let from = isYmd(range.from) ? range.from : addDays(today, -29);
  let to = isYmd(range.to) ? range.to : today;
  if (to > today) to = today;
  if (from > to) [from, to] = [to, from];
  if (daysInRange({ from, to }) > MAX_RANGE_DAYS) from = addDays(to, -(MAX_RANGE_DAYS - 1));
  return { from, to };
}

const dayFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
const dayNoYearFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });

/** "22 Sep 2026" for a calendar day (formatted in UTC so the day never shifts). */
export function formatYmd(ymd: Ymd, options: { year?: boolean } = {}): string {
  if (!isYmd(ymd)) return "";
  const [y, m, d] = ymdParts(ymd);
  return (options.year === false ? dayNoYearFormatter : dayFormatter).format(Date.UTC(y, m - 1, d));
}

/** "1 – 22 Sep 2026", "28 Aug – 22 Sep 2026", "Today". */
export function formatRangeLabel(range: DateRange, now: Instant = Date.now()): string {
  if (range.from === range.to) return range.from === todayYmd(now) ? "Today" : formatYmd(range.from);
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  return `${formatYmd(range.from, { year: !sameYear })} – ${formatYmd(range.to)}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIME_ZONE,
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dateOnlyFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: BUSINESS_TIME_ZONE, day: "numeric", month: "short", year: "numeric" });
const timeOnlyFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: BUSINESS_TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "22 Sep 2026, 14:05" (Colombo). "" for an invalid/empty value. */
export function formatDateTime(value: Instant | null | undefined, mode: "datetime" | "date" | "time" = "datetime"): string {
  if (value == null || value === "") return "";
  const ms = toMillis(value);
  if (ms === null) return "";
  const formatter = mode === "date" ? dateOnlyFormatter : mode === "time" ? timeOnlyFormatter : dateTimeFormatter;
  return formatter.format(ms);
}

/** Hour of day (0–23) in Colombo — for "busy hours" charts. */
export function hourInZone(value: Instant): number | null {
  return zonedParts(value)?.hour ?? null;
}

/**
 * `<input type="datetime-local">` speaks the BROWSER's zone; the business speaks Colombo's.
 * These convert between an ISO instant and the input's "YYYY-MM-DDTHH:mm" in Colombo time,
 * so a flash-sale end time set from abroad still means Colombo time.
 */
export function isoToZonedInput(value: Instant | null | undefined): string {
  if (value == null || value === "") return "";
  const p = zonedParts(value);
  return p ? `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}` : "";
}

export function zonedInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d, h, mi, s] = match;
  if (!isYmd(`${y}-${m}-${d}`) || Number(h) > 23 || Number(mi) > 59) return null;
  return new Date(zonedToMillis(Number(y), Number(m), Number(d), Number(h), Number(mi), Number(s ?? 0))).toISOString();
}

/** File-name friendly range, e.g. "2026-09-01_2026-09-22". */
export function rangeSlug(range: DateRange): string {
  return range.from === range.to ? range.from : `${range.from}_${range.to}`;
}
