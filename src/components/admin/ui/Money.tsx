import { formatLKR } from "@/lib/format";

/**
 * LKR in the admin (BUILD_SPEC §2.7: admin and emails use formatLKR — the base currency, never
 * the shopper's display currency). null/undefined render an em dash, never "Rs. 0".
 */
export function Money({
  amount,
  className = "",
  signed = false,
}: {
  amount: number | string | null | undefined;
  className?: string;
  /** Show "+" for positive values (deltas, adjustments). Negative always shows "−". */
  signed?: boolean;
}) {
  const value = typeof amount === "string" ? Number(amount) : amount;
  if (value == null || !Number.isFinite(value)) {
    return (
      <span className={`text-adm-mute ${className}`}>
        <span aria-hidden>—</span>
        <span className="sr-only">No amount</span>
      </span>
    );
  }
  const sign = value < 0 ? "−" : signed && value > 0 ? "+" : "";
  return <span className={`font-mono tabular-nums whitespace-nowrap ${className}`}>{`${sign}${formatLKR(Math.abs(value))}`}</span>;
}
