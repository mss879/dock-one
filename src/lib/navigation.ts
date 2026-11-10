import "server-only";
import type { NavMenuRow } from "@/components/layout/nav";
import { CACHE_TAGS, cached, readFailSoft, throwDbError } from "@/lib/cache";
import { toNumber, toText } from "@/lib/catalogue-shared";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * The stored main menu (48 nav_menu_items) for the header and the phone menu — every row, switched
 * off ones too (they tell the header which categories are placed), with each collection item's
 * collection embedded (null while that collection is hidden: read as anon). Cached under `content`
 * (the navbar editor revalidates it) and `catalogue` (a renamed or hidden collection or category).
 * Fails soft to null — before 48 is applied, the header falls back to its built-in menu.
 */

export const NAV_MIGRATION = "48_navbar_menu.sql";
type Row = Record<string, unknown>;

const KINDS = new Set<NavMenuRow["kind"]>(["menu", "category", "collection", "link"]);

function normalizeRow(row: Row): NavMenuRow | null {
  const id = toNumber(row.id, 0);
  const kind = row.kind as NavMenuRow["kind"];
  if (!Number.isInteger(id) || id <= 0 || !KINDS.has(kind)) return null;
  const parentId = row.parent_id === null || row.parent_id === undefined ? null : toNumber(row.parent_id, 0) || null;
  const embedded = Array.isArray(row.collection) ? row.collection[0] : row.collection;
  const collection =
    embedded && typeof embedded === "object"
      ? { title: toText((embedded as Row).title, 120) ?? "", subtitle: toText((embedded as Row).subtitle, 200) }
      : null;
  return {
    id,
    parentId,
    kind,
    label: toText(row.label, 40),
    href: toText(row.href, 500),
    categoryId: toText(row.category_id, 64),
    collectionId: toText(row.collection_id, 80),
    position: toNumber(row.position, 0),
    visible: row.is_visible !== false,
    collection: collection && collection.title ? collection : null,
  };
}

const readNavMenu = cached(
  async (): Promise<NavMenuRow[]> => {
    const { data, error } = await createServerSupabase()
      .from("nav_menu_items")
      .select("id, parent_id, kind, label, href, category_id, collection_id, position, is_visible, collection:collections(title, subtitle)")
      .order("position")
      .order("id")
      .limit(500);
    if (error) throwDbError("navigation.getNavMenu", error, NAV_MIGRATION);
    return (Array.isArray(data) ? (data as Row[]) : []).map(normalizeRow).filter((row): row is NavMenuRow => row !== null);
  },
  ["navigation:menu:v1"],
  { tags: [CACHE_TAGS.content, CACHE_TAGS.catalogue] },
);

/** The stored menu rows, or null when they can't be read (48 not applied, database down). Never throws. */
export function getNavMenuRows(): Promise<NavMenuRow[] | null> {
  return readFailSoft("navigation.getNavMenu", readNavMenu, null);
}
