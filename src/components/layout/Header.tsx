import Link from "next/link";
import { getCategories } from "@/lib/catalogue";
import { getFooterLinks } from "@/lib/content";
import { getStoreSettings } from "@/lib/settings";
import { telHref } from "./contact";
import { HeaderCounters } from "./HeaderCounters";
import { Logo } from "./Logo";
import { MobileMenu } from "./MobileMenu";
import { mainNav, navGroups, utilityNav } from "./nav";
import { NavDropdown } from "./NavDropdown";
import { ProfileMenu } from "./ProfileMenu";
import { SearchBar } from "./SearchBar";
import { SysClock } from "./SysClock";

function NavSlash() {
  return (
    <span aria-hidden className="px-3 text-violet xl:px-4">
      /
    </span>
  );
}

/**
 * Sticky header. Desktop nav = the active categories in hover dropdowns (navGroups), then Deals and
 * New. The mobile menu keeps the flat list: Shop, every category, Deals, New.
 */
export async function Header() {
  const [categories, settings, links] = await Promise.all([getCategories(), getStoreSettings(), getFooterLinks()]);
  const nav = mainNav(categories);
  const groups = navGroups(categories);
  const extras = nav.slice(-2); // Deals, New
  const tel = telHref(settings.phone);
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/92 backdrop-blur-md">
      <div className="shell flex h-16 items-center gap-3 lg:h-[72px] lg:gap-6">
        <MobileMenu items={nav} utility={utilityNav(links.storeLocator)} hotline={settings.phone && tel ? { display: settings.phone, href: tel } : null} />
        <Logo />

        <nav aria-label="Main" className="hidden h-full items-center border-l border-line pl-6 lg:flex">
          <ul className="label flex h-full items-center font-medium">
            {groups.map((group, i) => (
              <li key={group.label} className="flex h-full items-center">
                {i > 0 && <NavSlash />}
                <NavDropdown group={group} />
              </li>
            ))}
            {extras.map((item) => (
              <li key={item.href} className="flex h-full items-center">
                <NavSlash />
                <Link href={item.href} className="relative py-2 transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-px after:origin-left after:scale-x-0 after:bg-ink after:transition-transform hover:text-violet-ink hover:after:scale-x-100">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <SearchBar id="search-desktop" className="hidden flex-1 md:flex" />
        <SysClock />

        <div className="ml-auto flex items-center gap-1 md:ml-0">
          <ProfileMenu />
          <HeaderCounters />
        </div>
      </div>
      <div className="shell pb-3 md:hidden">
        <SearchBar id="search-mobile" />
      </div>
    </header>
  );
}
