import { formatDateTime } from "@/lib/admin/dates";

/**
 * A timestamp in Sri Lanka time (Asia/Colombo), whatever the admin's device zone is.
 * Renders <time dateTime="…ISO…" title="full date">.
 */
export function DateTime({
  value,
  mode = "datetime",
  className = "",
}: {
  value: string | number | Date | null | undefined;
  mode?: "datetime" | "date" | "time";
  className?: string;
}) {
  const text = formatDateTime(value, mode);
  if (!text) {
    return <span className={`text-adm-mute ${className}`}>—</span>;
  }
  const iso = value instanceof Date ? value.toISOString() : typeof value === "number" ? new Date(value).toISOString() : String(value);
  return (
    <time dateTime={iso} title={`${formatDateTime(value, "datetime")} (Sri Lanka time)`} className={`whitespace-nowrap tabular-nums ${className}`}>
      {text}
    </time>
  );
}
