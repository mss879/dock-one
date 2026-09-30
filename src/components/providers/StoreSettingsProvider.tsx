"use client";

import { createContext, use, type ReactNode } from "react";
import { DEFAULT_PUBLIC_SETTINGS, type PublicStoreSettings } from "@/lib/settings-shared";

const StoreSettingsContext = createContext<PublicStoreSettings>(DEFAULT_PUBLIC_SETTINGS);

/**
 * Hands the server-fetched public settings (see src/app/(store)/layout.tsx) to client islands.
 * Outside the provider (admin, holding page) `useStoreSettings()` returns the SQL defaults.
 */
export function StoreSettingsProvider({ value, children }: { value: PublicStoreSettings; children: ReactNode }) {
  return <StoreSettingsContext value={value}>{children}</StoreSettingsContext>;
}

export function useStoreSettings(): PublicStoreSettings {
  return use(StoreSettingsContext);
}
