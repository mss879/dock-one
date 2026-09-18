import Link from "next/link";
import { Truck } from "lucide-react";
import { utilityNav, site } from "@/data/site";
import { formatLKR } from "@/lib/format";

export function TopBar() {
  return (
    <div className="border-b border-night-line bg-ink text-paper">
      <div className="shell label flex h-9 items-center justify-between gap-6">
        <p className="hidden shrink-0 gap-4 text-night-mute md:flex">
          <span>
            Lang: <span className="text-paper">EN</span>
          </span>
          <span>
            Cur: <span className="text-paper">{site.currency}</span>
          </span>
        </p>
        <p className="flex min-w-0 flex-1 items-center justify-center gap-2 md:flex-none">
          <Truck aria-hidden className="size-3.5 shrink-0 text-lime" />
          <span className="truncate">
            <span className="max-sm:hidden">
              Island-wide delivery <span className="text-night-mute">{"//"}</span>{" "}
            </span>
            Free <span className="sm:hidden">delivery </span>over {formatLKR(site.freeDeliveryThreshold)}
          </span>
        </p>
        <nav aria-label="Utility" className="hidden shrink-0 md:block">
          <ul className="flex gap-5">
            {utilityNav.map((item) => (
              <li key={item.label}>
                <Link href={item.href} className="text-night-mute transition-colors hover:text-lime">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}
