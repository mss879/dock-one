/**
 * Brand constants only (BUILD_SPEC §1). Everything the owner edits — contact details, the delivery
 * rule, payment labels, socials, the ticker — lives in store_settings (admin → Store settings);
 * navigation comes from the active categories and the published CMS pages; prices and discount codes
 * come from the database. The description states only what the approved copy states elsewhere
 * (official warranty, cash on delivery, island-wide delivery).
 */
export const site = {
  name: "Dock One Solutions",
  /** wordmark: big line + small line */
  wordmark: ["Dock One", "Solutions"] as const,
  description:
    "Sri Lanka's tech store for laptops, storage devices, keyboards and mice. Official warranty, cash on delivery and island-wide delivery.",
};
