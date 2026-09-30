"use client";

import { openConsentSettings } from "@/lib/analytics";

/** Footer "Cookie settings": re-opens the consent choice (essential vs analytics — blueprint §12.1.7, WP-H's banner). */
export function CookieSettingsButton({ className = "" }: { className?: string }) {
  return (
    <button type="button" onClick={() => openConsentSettings()} className={className}>
      Cookie settings
    </button>
  );
}
