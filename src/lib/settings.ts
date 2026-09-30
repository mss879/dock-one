import "server-only";
import { CACHE_TAGS, cached, readFailSoft, throwDbError } from "@/lib/cache";
import { isSupabaseConfigured } from "@/lib/env";
import { isMissingRelation } from "@/lib/rpc-errors";
import { createServerSupabase } from "@/lib/supabase/server";
import { DEFAULT_STORE_SETTINGS, normalizeStoreSettings, type StoreSettings } from "@/lib/settings-shared";

export {
  DEFAULT_PUBLIC_SETTINGS,
  DEFAULT_STORE_SETTINGS,
  phoneDigits,
  SOCIAL_NETWORKS,
  toPublicSettings,
  type PublicStoreSettings,
  type SocialNetwork,
  type StoreSettings,
} from "@/lib/settings-shared";
export { amountToFreeDelivery, deliveryFeeFor, type DeliveryRule, type Fulfillment } from "@/lib/delivery";

const MIGRATION = "03_store_settings.sql";

const readSettingsRow = cached(
  async (): Promise<Record<string, unknown> | null> => {
    const { data, error } = await createServerSupabase().from("store_settings").select("*").eq("id", true).maybeSingle();
    if (error) {
      if (isMissingRelation(error)) {
        console.error(`[settings] store_settings is missing — apply migration ${MIGRATION}. Using defaults.`);
        return null; // schema not there yet: defaults are the honest answer; cached briefly like any read
      }
      throwDbError("settings.getStoreSettings", error, MIGRATION);
    }
    if (!data) console.error(`[settings] store_settings has no row — re-run migration ${MIGRATION}. Using defaults.`);
    return (data as Record<string, unknown> | null) ?? null;
  },
  ["settings:store_settings:v1"],
  { tags: [CACHE_TAGS.settings] },
);

/**
 * The store settings singleton (cached, tag `settings`). Never throws: a missing table/row or
 * a DB/transport error yields DEFAULT_STORE_SETTINGS (= the SQL column defaults) and a log line.
 */
export async function getStoreSettings(): Promise<StoreSettings> {
  if (!isSupabaseConfigured) return DEFAULT_STORE_SETTINGS;
  return readFailSoft("settings.getStoreSettings", async () => normalizeStoreSettings(await readSettingsRow()), DEFAULT_STORE_SETTINGS);
}
