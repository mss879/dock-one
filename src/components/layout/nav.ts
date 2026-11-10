import { categoryHref, collectionHref, type Category } from "@/lib/catalogue-shared";

/**
 * The chrome's link lists (blueprint §5 routes, BUILD_SPEC §6/§7). Plain module: the server header,
 * top bar and footer build them; the client mobile menu receives them as props.
 */

export type NavLink = { label: string; href: string };

export type NavGroup = { label: string; items: (NavLink & { note: string | null })[] };

/** One thing in the navbar: a dropdown menu, or a single link. */
export type NavEntry = ({ kind: "menu" } & NavGroup) | ({ kind: "link" } & NavLink);

/**
 * A row of the stored main menu (48 nav_menu_items, read by lib/navigation.ts). `collection` is the
 * embedded collection — null while it is hidden (the storefront reads collections as anon).
 */
export type NavMenuRow = {
  id: number;
  parentId: number | null;
  kind: "menu" | "category" | "collection" | "link";
  label: string | null;
  href: string | null;
  categoryId: string | null;
  collectionId: string | null;
  position: number;
  visible: boolean;
  collection: { title: string; subtitle: string | null } | null;
};

type NavCategory = Pick<Category, "id" | "name" | "tagline">;

/**
 * The navbar as it was before 48 (dropdowns grouped by category id in code), without Deals and New
 * — the menu shown while the stored one can't be read (48 not applied yet). After 48 the shop
 * edits the menu in admin → Homepage & navbar → Navbar.
 */
const DEFAULT_MENUS: { label: string; ids: string[] }[] = [
  { label: "Computing", ids: ["laptops", "monitors", "storage", "components"] },
  { label: "Accessories", ids: ["keyboards", "mice", "audio", "power-charging"] },
  { label: "Cameras", ids: ["cameras", "polaroid-camera"] },
];

const categoryItem = (category: NavCategory, label: string | null = null) => ({
  label: label ?? category.name,
  href: categoryHref(category.id),
  note: category.tagline,
});

/**
 * What the navbar shows, in order: the stored menu's visible items (a category or collection that
 * is hidden drops out; a menu left empty is skipped), then "More" with every active category that
 * no item points at — so a category added later is never left out of the navbar. `rows` null =
 * the stored menu can't be read: the built-in menu instead. Categories come in their admin order.
 */
export function buildNavEntries(rows: readonly NavMenuRow[] | null, categories: readonly NavCategory[]): NavEntry[] {
  const byId = new Map(categories.map((category) => [category.id, category]));
  const entries: NavEntry[] = [];
  let placed: Set<string>;

  if (rows === null) {
    placed = new Set(DEFAULT_MENUS.flatMap((menu) => menu.ids));
    for (const menu of DEFAULT_MENUS) {
      const items = categories.filter((category) => menu.ids.includes(category.id)).map((category) => categoryItem(category));
      if (items.length > 0) entries.push({ kind: "menu", label: menu.label, items });
    }
  } else {
    placed = new Set(rows.map((row) => row.categoryId).filter((id): id is string => id !== null));
    const ordered = [...rows].sort((a, b) => a.position - b.position || a.id - b.id);
    const resolve = (row: NavMenuRow): (NavLink & { note: string | null }) | null => {
      if (!row.visible) return null;
      if (row.kind === "category") {
        const category = row.categoryId ? byId.get(row.categoryId) : undefined;
        return category ? categoryItem(category, row.label) : null;
      }
      if (row.kind === "collection") {
        return row.collection && row.collectionId
          ? { label: row.label ?? row.collection.title, href: collectionHref(row.collectionId), note: row.collection.subtitle }
          : null;
      }
      if (row.kind === "link") return row.label && row.href ? { label: row.label, href: row.href, note: null } : null;
      return null;
    };
    for (const row of ordered.filter((candidate) => candidate.parentId === null && candidate.visible)) {
      if (row.kind === "menu") {
        const items = ordered
          .filter((child) => child.parentId === row.id)
          .map(resolve)
          .filter((item): item is NonNullable<typeof item> => item !== null);
        if (row.label && items.length > 0) entries.push({ kind: "menu", label: row.label, items });
      } else {
        const item = resolve(row);
        if (item) entries.push({ kind: "link", label: item.label, href: item.href });
      }
    }
  }

  const more = categories.filter((category) => !placed.has(category.id)).map((category) => categoryItem(category));
  if (more.length > 0) entries.push({ kind: "menu", label: "More", items: more });
  return entries;
}

/** The phone menu's flat list: Shop, then every navbar item (a menu's items in its place), once each. */
export function mobileNav(entries: readonly NavEntry[]): NavLink[] {
  const seen = new Set<string>(["/shop"]);
  const links: NavLink[] = [{ label: "Shop", href: "/shop" }];
  for (const entry of entries) {
    const items = entry.kind === "menu" ? entry.items : [entry];
    for (const item of items) {
      if (seen.has(item.href)) continue;
      seen.add(item.href);
      links.push({ label: item.label, href: item.href });
    }
  }
  return links;
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
