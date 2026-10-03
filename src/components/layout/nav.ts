import { categoryHref, type Category } from "@/lib/catalogue-shared";

/**
 * The chrome's link lists (blueprint §5 routes, BUILD_SPEC §6/§7). Plain module: the server header,
 * top bar and footer build them; the client mobile menu receives them as props.
 */

export type NavLink = { label: string; href: string };

/** The EXISTING nav items: Shop, one link per active category, Deals, New. */
export function mainNav(categories: readonly Pick<Category, "id" | "name">[]): NavLink[] {
  return [
    { label: "Shop", href: "/shop" },
    ...categories.map((category) => ({ label: category.name, href: categoryHref(category.id) })),
    { label: "Deals", href: "/shop?filter=deals" },
    { label: "New", href: "/shop?filter=new" },
  ];
}

export type NavGroup = { label: string; items: (NavLink & { note: string | null })[] };

/**
 * The desktop header's dropdown groups. Categories are a flat, admin-managed list, so the grouping
 * lives here by category id; a category not listed (e.g. one added later in the admin) lands in
 * "More", so nothing ever drops out of the nav. Empty groups are left out.
 */
const NAV_GROUPS: { label: string; ids: string[] }[] = [
  { label: "Computing", ids: ["laptops", "monitors", "storage", "components"] },
  { label: "Accessories", ids: ["keyboards", "mice", "audio", "power-charging"] },
  { label: "Cameras", ids: ["cameras", "polaroid-camera"] },
];

export function navGroups(categories: readonly Pick<Category, "id" | "name" | "tagline">[]): NavGroup[] {
  const toItem = (category: Pick<Category, "id" | "name" | "tagline">) => ({ label: category.name, href: categoryHref(category.id), note: category.tagline });
  const grouped = new Set(NAV_GROUPS.flatMap((group) => group.ids));
  return [
    ...NAV_GROUPS.map((group) => ({
      label: group.label,
      // category order (admin sort order), not the order of the ids above
      items: categories.filter((category) => group.ids.includes(category.id)).map(toItem),
    })),
    { label: "More", items: categories.filter((category) => !grouped.has(category.id)).map(toItem) },
  ].filter((group) => group.items.length > 0);
}

/** Top-bar utility links; "Store locator" only while its published page exists (lib/content getFooterLinks). */
export function utilityNav(storeLocator: NavLink | null): NavLink[] {
  return [{ label: "Track order", href: "/track" }, { label: "Support", href: "/contact" }, ...(storeLocator ? [storeLocator] : [])];
}

/** The footer's Shop column: categories, then the deals / new-arrivals listings and the guided finder. */
export function shopLinks(categories: readonly Pick<Category, "id" | "name">[]): NavLink[] {
  return [
    ...categories.map((category) => ({ label: category.name, href: categoryHref(category.id) })),
    { label: "Flash deals", href: "/shop?filter=deals" },
    { label: "New arrivals", href: "/shop?filter=new" },
    { label: "Product finder", href: "/discover" },
  ];
}
