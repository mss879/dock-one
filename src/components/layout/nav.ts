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
