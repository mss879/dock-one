import Link from "next/link";
import { Clock, Mail, MapPin, Phone } from "lucide-react";
import { site } from "@/data/site";
import { Cross } from "@/components/ui/Cross";
import { getCategories } from "@/lib/catalogue";
import { getFooterLinks } from "@/lib/content";
import { getStoreSettings, SOCIAL_NETWORKS, type SocialNetwork } from "@/lib/settings";
import { telHref } from "./contact";
import { CookieSettingsButton } from "./CookieSettingsButton";
import { Logo } from "./Logo";
import { shopLinks, type NavLink } from "./nav";

const SOCIAL_LABELS: Record<SocialNetwork, string> = { facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" };

/** Brand column + N link columns. */
const LG_COLUMNS: Record<number, string> = {
  1: "lg:grid-cols-[1.5fr_repeat(1,1fr)]",
  2: "lg:grid-cols-[1.5fr_repeat(2,1fr)]",
  3: "lg:grid-cols-[1.5fr_repeat(3,1fr)]",
  4: "lg:grid-cols-[1.5fr_repeat(4,1fr)]",
};

/**
 * The dark footer. Contact rows, socials, the business registration number and the "We accept" labels
 * come from store_settings and render ONLY when set (BUILD_SPEC §1, P15). Link columns: Shop (active
 * categories, deals, new arrivals, the product finder) + Customer service / Company / Legal from the
 * published CMS pages and the fixed routes whose page exists (lib/content getFooterLinks).
 */
export async function Footer() {
  const [settings, categories, links] = await Promise.all([getStoreSettings(), getCategories(), getFooterLinks()]);
  const columns: { title: string; links: NavLink[] }[] = [{ title: "Shop", links: shopLinks(categories) }, ...links.columns];
  const tel = telHref(settings.phone);
  const socials = SOCIAL_NETWORKS.flatMap((network) => {
    const href = settings.socials[network];
    return href ? [{ label: SOCIAL_LABELS[network], href }] : [];
  });
  const labels = settings.acceptedPaymentLabels;
  const year = new Date().getFullYear();

  return (
    <footer className="bg-night text-paper">
      <div className={`shell relative grid gap-10 border-b border-night-line py-14 md:grid-cols-2 ${LG_COLUMNS[columns.length] ?? LG_COLUMNS[4]}`}>
        <Cross className="top-4 right-4 text-night-mute sm:right-6 lg:right-8" />
        <div>
          <Logo tone="dark" />
          <p className="mt-4 max-w-xs text-sm text-night-mute">{site.description}</p>
          {(settings.phone || settings.email || settings.address || settings.openingHours) && (
            <ul className="mt-5 space-y-2 text-sm">
              {settings.phone && (
                <li className="flex items-center gap-2.5">
                  <Phone aria-hidden className="size-4 shrink-0 text-lime" />
                  {tel ? (
                    <a href={tel} className="font-mono hover:text-lime">
                      {settings.phone}
                    </a>
                  ) : (
                    <span className="font-mono">{settings.phone}</span>
                  )}
                </li>
              )}
              {settings.email && (
                <li className="flex items-center gap-2.5">
                  <Mail aria-hidden className="size-4 shrink-0 text-lime" />
                  <a href={`mailto:${settings.email}`} className="hover:text-lime">
                    {settings.email}
                  </a>
                </li>
              )}
              {settings.address && (
                <li className="flex items-center gap-2.5">
                  <MapPin aria-hidden className="size-4 shrink-0 text-lime" />
                  {settings.mapUrl ? (
                    <a href={settings.mapUrl} target="_blank" rel="noopener noreferrer" className="hover:text-lime">
                      {settings.address}
                      <span className="sr-only"> (map, opens in a new tab)</span>
                    </a>
                  ) : (
                    settings.address
                  )}
                </li>
              )}
              {settings.openingHours && (
                <li className="flex items-start gap-2.5">
                  <Clock aria-hidden className="mt-0.5 size-4 shrink-0 text-lime" />
                  <span className="whitespace-pre-line">{settings.openingHours}</span>
                </li>
              )}
            </ul>
          )}
          {settings.businessRegNo && <p className="label mt-5 text-night-mute">Business reg. no. {settings.businessRegNo}</p>}
        </div>

        {columns.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <h2 className="label mb-4 font-semibold text-night-mute">{column.title}</h2>
            <ul className="space-y-2.5 text-sm">
              {column.links.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="transition-colors hover:text-lime">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="shell flex flex-col gap-5 py-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="label flex flex-wrap items-center gap-x-5 gap-y-1">
          {socials.length > 0 && (
            <ul className="flex flex-wrap gap-x-5 gap-y-1">
              {socials.map((social) => (
                <li key={social.label}>
                  <a href={social.href} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center text-night-mute transition-colors hover:text-lime">
                    {social.label} <span aria-hidden>&nbsp;↗</span>
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          <CookieSettingsButton className="inline-flex min-h-10 cursor-pointer items-center text-night-mute transition-colors hover:text-lime" />
        </div>
        {labels.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="label mr-1 text-night-mute">We accept</span>
            {labels.map((label, i) => (
              <span key={`${label}-${i}`} className="label border border-night-line px-2 py-1 font-semibold">
                {label}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* status bar from the CYBR_ reference */}
      <div className="border-t border-night-line">
        <div className="shell label flex flex-col items-stretch gap-0 px-0 sm:flex-row sm:items-center sm:px-6 lg:px-8">
          <p className="flex items-center gap-2 px-4 py-3 text-night-mute sm:px-0">
            <span className="size-1.5 bg-lime" /> Connection secure
            <span className="hidden md:inline">
              {"//"} © {year} {site.name}. All rights reserved.
            </span>
          </p>
          <p aria-hidden className="bg-violet px-5 py-3 font-semibold sm:mx-auto">
            &gt; Access granted<span className="animate-blink">_</span>
          </p>
          <p aria-hidden className="hidden gap-5 py-3 text-night-mute lg:flex">
            <span>Scn: 0007</span>
            <span>Node: CMB_01</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
