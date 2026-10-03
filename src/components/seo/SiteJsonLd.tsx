import { site } from "@/data/site";
import { absoluteUrl, siteUrl } from "@/lib/env";
import { getStoreSettings, SOCIAL_NETWORKS } from "@/lib/settings";
import { JsonLd } from "./JsonLd";

/**
 * Organization JSON-LD for every storefront page (blueprint §9.1 "Root layout: Organization"),
 * mounted by src/app/(store)/layout.tsx. Built from the brand name + the store_settings row,
 * and ONLY from fields that are set (blueprint §1: contact and social details are rendered
 * only when set — never a placeholder that could pass for a real one).
 */
export async function SiteJsonLd() {
  const settings = await getStoreSettings();
  const sameAs = SOCIAL_NETWORKS.map((network) => settings.socials[network]).filter((url): url is string => Boolean(url));

  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": `${siteUrl}/#organization`,
    name: settings.storeName || site.name,
    url: absoluteUrl("/"),
    // The client's logo as supplied (gold on ink), 512px square — scripts/images/icons.py.
    logo: { "@type": "ImageObject", url: absoluteUrl("/brand/dock-one-logo-512.png"), width: 512, height: 512 },
  };
  if (settings.email) data.email = settings.email;
  if (settings.phone) data.telephone = settings.phone;
  if (settings.address) data.address = { "@type": "PostalAddress", streetAddress: settings.address, addressCountry: "LK" };
  if (settings.phone || settings.email) {
    data.contactPoint = {
      "@type": "ContactPoint",
      contactType: "customer service",
      ...(settings.phone ? { telephone: settings.phone } : {}),
      ...(settings.email ? { email: settings.email } : {}),
    };
  }
  if (sameAs.length > 0) data.sameAs = sameAs;

  return <JsonLd data={data} />;
}
