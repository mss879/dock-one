import Link from "next/link";
import { collectionHref, getCategories, getNavCollection } from "@/lib/catalogue";
import { getFooterLinks } from "@/lib/content";
import { getNavMenuRows } from "@/lib/navigation";
import { getStoreSettings } from "@/lib/settings";
import { telHref } from "./contact";
import { ElectricNavLink } from "./ElectricNavLink";
import { HeaderCounters } from "./HeaderCounters";
import { Logo } from "./Logo";
import { MobileMenu } from "./MobileMenu";
import { buildNavEntries, mobileNav, utilityNav } from "./nav";
import { NavDropdown } from "./NavDropdown";
import { ProfileMenu } from "./ProfileMenu";
import { SearchBar } from "./SearchBar";
import { SysClock } from "./SysClock";

/** `tight` (while a sale item is shown) keeps the narrower spacing up to 2xl to make room for it. */
function NavSlash({ tight = false }: { tight?: boolean }) {
  return (
    <span aria-hidden className={`px-3 text-violet ${tight ? "2xl:px-4" : "xl:px-4"}`}>
      /
    </span>
  );
}

/**
 * Sticky header. Desktop nav = the stored main menu (48: admin → Homepage & navbar → Navbar) — hover
 * dropdowns and single links in the shop's order, then "More" for any category no item places
 * (buildNavEntries). The phone menu gets the same items as a flat list (mobileNav). The row is wider
 * than the page content (shell-wide), so wide screens don't leave the navbar boxed in the middle.
 *
 * The navbar sale collection (11.11, then Black Friday…; admin → Collections → Navbar, migration
 * 45) is an electric item: at the end of the desktop nav, before the search bar on tablets, beside
 * it on phones and at the top of the phone menu. The desktop row has no spare width for it below
 * 1280px (the search would be squeezed to nothing), so while it shows, 1024–1279px keeps the tablet
 * arrangement (menu button, item, full search) and the dropdown nav starts at xl, a little tighter
 * up to 2xl.
 */
export async function Header() {
  const [categories, settings, links, navCollection, menuRows] = await Promise.all([
    getCategories(),
    getStoreSettings(),
    getFooterLinks(),
    getNavCollection(),
    getNavMenuRows(),
  ]);
  const entries = buildNavEntries(menuRows, categories);
  const sale = navCollection ? { label: navCollection.title, href: collectionHref(navCollection.id) } : null;
  const tight = sale !== null;
  const tel = telHref(settings.phone);
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/92 backdrop-blur-md">
      <div className={`shell-wide flex h-16 items-center gap-3 lg:h-[72px] ${tight ? "lg:gap-4 2xl:gap-6" : "lg:gap-6"}`}>
        <MobileMenu
          items={mobileNav(entries)}
          sale={sale}
          utility={utilityNav(links.storeLocator)}
          hotline={settings.phone && tel ? { display: settings.phone, href: tel } : null}
        />
        <Logo />

        <nav aria-label="Main" className={`hidden h-full items-center border-l border-line ${tight ? "pl-5 xl:flex 2xl:pl-6" : "pl-6 lg:flex"}`}>
          <ul className="label flex h-full items-center font-medium">
            {entries.map((entry, i) => (
              <li key={`${entry.kind}:${entry.label}:${i}`} className="flex h-full items-center">
                {i > 0 && <NavSlash tight={tight} />}
                {entry.kind === "menu" ? (
                  <NavDropdown group={entry} />
                ) : (
                  <Link
                    href={entry.href}
                    className="relative py-2 whitespace-nowrap transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-px after:origin-left after:scale-x-0 after:bg-ink after:transition-transform hover:text-violet-ink hover:after:scale-x-100"
                  >
                    {entry.label}
                  </Link>
                )}
              </li>
            ))}
            {sale && (
              <li className="ml-3 flex h-full items-center 2xl:ml-5">
                <ElectricNavLink href={sale.href} label={sale.label} className="h-9" />
              </li>
            )}
          </ul>
        </nav>

        {sale && (
          <div className="hidden shrink-0 md:flex xl:hidden">
            <ElectricNavLink href={sale.href} label={sale.label} className="h-9" />
          </div>
        )}
        <SearchBar id="search-desktop" className="hidden flex-1 md:flex" />
        <SysClock />

        <div className="ml-auto flex items-center gap-1 md:ml-0">
          <ProfileMenu />
          <HeaderCounters />
        </div>
      </div>
      <div className="shell-wide flex gap-2.5 pb-3 md:hidden">
        <SearchBar id="search-mobile" className="flex-1" />
        {sale && <ElectricNavLink href={sale.href} label={sale.label} className="h-11 max-w-[45%]" />}
      </div>
    </header>
  );
}
