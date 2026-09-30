"use client";

import { useSyncExternalStore } from "react";
import { getConsentSnapshot, getServerConsentSnapshot, subscribeConsent, type ConsentSnapshot } from "@/lib/analytics";

/**
 * The shopper's storage choice (lib/analytics.ts). `ready` is false on the server and during
 * hydration — render nothing consent-dependent until it is true (no hydration mismatch, and no
 * flash of the banner for shoppers who already chose).
 */
export function useConsent(): ConsentSnapshot {
  return useSyncExternalStore(subscribeConsent, getConsentSnapshot, getServerConsentSnapshot);
}
