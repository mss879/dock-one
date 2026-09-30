import {
  Bot,
  Boxes,
  ChartColumn,
  Compass,
  FileText,
  FolderTree,
  Inbox,
  LayoutDashboard,
  LayoutTemplate,
  Layers,
  LockKeyhole,
  Mail,
  Package,
  ReceiptText,
  Settings,
  ShoppingCart,
  Star,
  TicketPercent,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ComponentType } from "react";

/**
 * THE list of admin tabs (BUILD_SPEC §7, blueprint §11.1–11.2). The sidebar, the URL (`?tab=`),
 * the page title and the lazy loader all come from here — add a tab here and nowhere else.
 *
 * Each tab is the default export of `components/admin/tabs/<PascalKey>Tab.tsx`, loaded on demand
 * (its code and its data load only when the tab is opened). Owners replace their STUB file's body
 * and keep the default export.
 */

export const ADMIN_GROUPS = ["Overview", "Commerce", "Catalogue", "Customers", "Growth", "Content", "Settings"] as const;
export type AdminGroup = (typeof ADMIN_GROUPS)[number];

export type AdminTabKey =
  | "dashboard"
  | "orders"
  | "discounts"
  | "abandoned-carts"
  | "reports"
  | "products"
  | "categories"
  | "collections"
  | "inventory"
  | "reviews"
  | "customers"
  | "inquiries"
  | "subscribers"
  | "finder-insights"
  | "assistant-insights"
  | "homepage"
  | "content"
  | "settings"
  | "site-lock";

export type AdminTabOwner = "WP-A" | "WP-B" | "WP-C" | "WP-D" | "WP-E" | "WP-F" | "WP-G" | "WP-H" | "WP-I" | "WP-J" | "WP-K";

export type AdminTabDef = {
  key: AdminTabKey;
  label: string;
  group: AdminGroup;
  icon: LucideIcon;
  /** Work package that builds the tab (BUILD_SPEC §7). */
  owner: AdminTabOwner;
  /** One line: what the tab is for (shown in the stub and as the tab's description). */
  summary: string;
  /** Lazy loader — a literal import() so the bundler splits every tab into its own chunk. */
  load: () => Promise<{ default: ComponentType }>;
};

export const ADMIN_TABS: readonly AdminTabDef[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    group: "Overview",
    icon: LayoutDashboard,
    owner: "WP-H",
    summary: "Revenue, orders, average order value and trend, the funnel, top viewed vs sold, zero-result searches, low stock, recovery and newsletter growth — all from real data.",
    load: () => import("./tabs/DashboardTab"),
  },
  {
    key: "orders",
    label: "Orders",
    group: "Commerce",
    icon: ReceiptText,
    owner: "WP-C",
    summary: "Every order with filters and pagination, a detail drawer, status and payment changes, tracking, the timeline and invoice printing.",
    load: () => import("./tabs/OrdersTab"),
  },
  {
    key: "discounts",
    label: "Discounts",
    group: "Commerce",
    icon: TicketPercent,
    owner: "WP-C",
    summary: "Create, pause and delete discount codes; assistant-only codes with a usage limit; offer performance.",
    load: () => import("./tabs/DiscountsTab"),
  },
  {
    key: "abandoned-carts",
    label: "Abandoned carts",
    group: "Commerce",
    icon: ShoppingCart,
    owner: "WP-E",
    summary: "Checkouts that were started but not finished, each cart's reminder stage and opt-out state, and “Send due reminders”.",
    load: () => import("./tabs/AbandonedCartsTab"),
  },
  {
    key: "reports",
    label: "Reports",
    group: "Commerce",
    icon: ChartColumn,
    owner: "WP-H",
    summary: "Sales and order reports for any Sri Lanka date range, exported as CSV or printed to PDF.",
    load: () => import("./tabs/ReportsTab"),
  },
  {
    key: "products",
    label: "Products",
    group: "Catalogue",
    icon: Package,
    owner: "WP-K",
    summary: "Create and edit products: details, flags, specs, variants with prices and SKUs, cost and stock per variant, gallery and cut-out images, SEO.",
    load: () => import("./tabs/ProductsTab"),
  },
  {
    key: "categories",
    label: "Categories",
    group: "Catalogue",
    icon: FolderTree,
    owner: "WP-K",
    summary: "Categories shown in the header, the homepage pop-outs and /shop — names, taglines, stage images, hero products and order.",
    load: () => import("./tabs/CategoriesTab"),
  },
  {
    key: "collections",
    label: "Collections",
    group: "Catalogue",
    icon: Layers,
    owner: "WP-K",
    summary: "Curated collections with manual membership or automatic rules, featured on the homepage.",
    load: () => import("./tabs/CollectionsTab"),
  },
  {
    key: "inventory",
    label: "Inventory",
    group: "Catalogue",
    icon: Boxes,
    owner: "WP-K",
    summary: "Stock level and low-stock threshold per variant, low stock first, edited inline.",
    load: () => import("./tabs/InventoryTab"),
  },
  {
    key: "reviews",
    label: "Reviews",
    group: "Catalogue",
    icon: Star,
    owner: "WP-J",
    summary: "Moderate product reviews: approve, reject and feature.",
    load: () => import("./tabs/ReviewsTab"),
  },
  {
    key: "customers",
    label: "Customers",
    group: "Customers",
    icon: Users,
    owner: "WP-D",
    summary: "Customer dossiers: orders by account or email, lifetime value, saved address and an admin note.",
    load: () => import("./tabs/CustomersTab"),
  },
  {
    key: "inquiries",
    label: "Inquiries",
    group: "Customers",
    icon: Inbox,
    owner: "WP-E",
    summary: "Messages from the contact form: reply by email, mark answered, delete.",
    load: () => import("./tabs/InquiriesTab"),
  },
  {
    key: "subscribers",
    label: "Subscribers",
    group: "Customers",
    icon: Mail,
    owner: "WP-E",
    summary: "Newsletter subscribers with counts by source and CSV export.",
    load: () => import("./tabs/SubscribersTab"),
  },
  {
    key: "finder-insights",
    label: "Finder insights",
    group: "Growth",
    icon: Compass,
    owner: "WP-F",
    summary: "What shoppers ask the product finder for — including what you may not stock.",
    load: () => import("./tabs/FinderInsightsTab"),
  },
  {
    key: "assistant-insights",
    label: "Assistant insights",
    group: "Growth",
    icon: Bot,
    owner: "WP-I",
    summary: "Tech desk assistant sessions, outcomes, busy hours, searches that found nothing, demand and transcripts (read-only).",
    load: () => import("./tabs/AssistantInsightsTab"),
  },
  {
    key: "homepage",
    label: "Homepage",
    group: "Content",
    icon: LayoutTemplate,
    owner: "WP-B",
    summary: "Hero slides, promo tiles, featured collections, the flash sale and the homepage content blocks.",
    load: () => import("./tabs/HomepageTab"),
  },
  {
    key: "content",
    label: "Pages & blog",
    group: "Content",
    icon: FileText,
    owner: "WP-G",
    summary: "Information pages (privacy, terms, returns, and any page you publish such as delivery or warranty) and blog posts.",
    load: () => import("./tabs/ContentTab"),
  },
  {
    key: "settings",
    label: "Store settings",
    group: "Settings",
    icon: Settings,
    owner: "WP-B",
    summary: "Delivery fee and free-delivery threshold, payment methods, pickup, the bank account for transfers, contact details, socials, ticker and legal ids.",
    load: () => import("./tabs/SettingsTab"),
  },
  {
    key: "site-lock",
    label: "Site lock",
    group: "Settings",
    icon: LockKeyhole,
    owner: "WP-H",
    summary: "Hold the storefront behind the “launching soon” page (headline, message, launch time) with a PIN for private previews.",
    load: () => import("./tabs/SiteLockTab"),
  },
];

export const DEFAULT_ADMIN_TAB: AdminTabKey = "dashboard";

const BY_KEY = new Map<string, AdminTabDef>(ADMIN_TABS.map((tab) => [tab.key, tab]));

export function isAdminTabKey(value: unknown): value is AdminTabKey {
  return typeof value === "string" && BY_KEY.has(value);
}

/** The tab for a `?tab=` value; unknown or missing → the dashboard. */
export function resolveAdminTab(value: string | null | undefined): AdminTabDef {
  return (value && BY_KEY.get(value)) || (BY_KEY.get(DEFAULT_ADMIN_TAB) as AdminTabDef);
}

export function getAdminTab(key: AdminTabKey): AdminTabDef {
  return BY_KEY.get(key) as AdminTabDef;
}

/** Tabs grouped for the sidebar, in ADMIN_GROUPS order. */
export function adminTabsByGroup(): { group: AdminGroup; tabs: AdminTabDef[] }[] {
  return ADMIN_GROUPS.map((group) => ({ group, tabs: ADMIN_TABS.filter((tab) => tab.group === group) }));
}

/** `/admin?tab=orders` (the dashboard is plain `/admin`). */
export function adminTabHref(key: AdminTabKey): string {
  return key === DEFAULT_ADMIN_TAB ? "/admin" : `/admin?tab=${encodeURIComponent(key)}`;
}
