/**
 * The dashboard's four tabs (blueprint §9.13), in order. Plain module: the server page validates
 * `?tab=` against it and the client island renders it. ProfileMenu links to `?tab=<key>`.
 */
export const DASHBOARD_TABS = [
  { key: "orders", label: "Order history" },
  { key: "saved", label: "Saved items" },
  { key: "tracking", label: "Tracking" },
  { key: "settings", label: "Settings" },
] as const;

export type DashboardTab = (typeof DASHBOARD_TABS)[number]["key"];

export function isDashboardTab(value: unknown): value is DashboardTab {
  return typeof value === "string" && DASHBOARD_TABS.some((tab) => tab.key === value);
}
