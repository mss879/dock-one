/** "Rs. 489,900" — fixed locale so server and client render identically. */
export function formatLKR(amount: number) {
  return `Rs. ${Math.round(amount).toLocaleString("en-US")}`;
}

export function pad2(n: number) {
  return String(n).padStart(2, "0");
}
