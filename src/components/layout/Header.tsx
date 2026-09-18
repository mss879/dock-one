import Link from "next/link";
import { mainNav } from "@/data/site";
import { HeaderCounters } from "./HeaderCounters";
import { Logo } from "./Logo";
import { MobileMenu } from "./MobileMenu";
import { ProfileMenu } from "./ProfileMenu";
import { SearchBar } from "./SearchBar";
import { SysClock } from "./SysClock";

export function Header() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/92 backdrop-blur-md">
      <div className="shell flex h-16 items-center gap-3 lg:h-[72px] lg:gap-6">
        <MobileMenu />
        <Logo />

        <nav aria-label="Main" className="hidden h-full items-center border-l border-line pl-6 lg:flex">
          <ul className="label flex items-center font-medium">
            {mainNav.slice(1).map((item, i) => (
              <li key={item.label} className="flex items-center">
                {i > 0 && (
                  <span aria-hidden className="px-2.5 text-violet xl:px-3.5">
                    /
                  </span>
                )}
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
