/** "Rs. 489,900" — fixed locale so server and client render identically. */
export function formatLKR(amount: number) {
  return `Rs. ${Math.round(amount).toLocaleString("en-US")}`;
}

/** Like formatLKR, but never rounds: "Rs. 12,900" or "Rs. 12,900.50" — for an amount to transfer. */
export function formatLKRExact(amount: number) {
  const cents = Math.round(amount * 100) % 100 !== 0;
  return `Rs. ${amount.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** What a banking app's amount field takes: "12900" or "12900.50" (no "Rs.", no commas). */
export function plainAmount(amount: number) {
  const fixed = (Math.round(amount * 100) / 100).toFixed(2);
  return fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed;
}

export function pad2(n: number) {
  return String(n).padStart(2, "0");
}
