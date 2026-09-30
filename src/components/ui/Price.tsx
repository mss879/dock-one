"use client";

import { useCurrency } from "@/lib/currency";
import { formatLKR } from "@/lib/format";

type Props = {
  /** LKR amount (the only transactional currency). */
  amount: number;
  /** Optional list price; rendered struck-through before the price, only when > amount. */
  compareAt?: number | null;
  className?: string;
  compareClassName?: string;
};

/**
 * Every shopper-facing price renders through this (BUILD_SPEC §2.7). In LKR it prints exactly
 * what formatLKR prints ("Rs. 489,900") — also on the server and during hydration. In another
 * display currency it prints "USD 1,469.70" with a title saying the charge is in LKR.
 *
 * With `compareAt` it returns two siblings (<s> then <span>) so the caller's wrapper keeps
 * its layout: `<p className="font-mono …"><Price amount={p} compareAt={c} … /></p>`.
 */
export function Price({ amount, compareAt = null, className, compareClassName }: Props) {
  const { format, isBase } = useCurrency();
  const title = (value: number) => (isBase ? undefined : `Approximate. You're charged ${formatLKR(value)} (LKR).`);
  const price = (
    <span className={className} title={title(amount)}>
      {format(amount)}
    </span>
  );
  if (compareAt === null || !(compareAt > amount)) return price;
  return (
    <>
      <s className={compareClassName} title={title(compareAt)}>
        <span className="sr-only">Was </span>
        {format(compareAt)}
      </s>
      {price}
    </>
  );
}
