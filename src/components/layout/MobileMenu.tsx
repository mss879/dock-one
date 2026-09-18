"use client";

import Link from "next/link";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { useState } from "react";
import { mainNav, site, utilityNav } from "@/data/site";
import { Sheet } from "@/components/ui/Sheet";

export function MobileMenu() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <button type="button" aria-label="Open menu" onClick={() => setOpen(true)} className="-ml-2 grid size-11 place-items-center lg:hidden">
        <Menu aria-hidden className="size-6" />
      </button>
      <Sheet open={open} onClose={close} side="left" label="Menu">
        <div className="flex h-full flex-col">
          <div className="flex h-16 shrink-0 items-center justify-between border-b border-ink px-5">
            <p className="label font-semibold">/ Menu</p>
            <button type="button" onClick={close} aria-label="Close menu" className="-mr-2 grid size-11 place-items-center">
              <X aria-hidden className="size-5" />
            </button>
          </div>
          <nav aria-label="Main" className="flex-1 overflow-y-auto">
            <ul>
              {mainNav.map((item, i) => (
                <li key={item.label} className="border-b border-line">
                  <Link href={item.href} onClick={close} className="group flex h-14 items-center gap-4 px-5 hover:bg-surface">
                    <span className="label text-violet-ink">/{String(i + 1).padStart(2, "0")}</span>
                    <span className="display flex-1 text-2xl">{item.label}</span>
                    <ArrowUpRight aria-hidden className="size-4 text-mute group-hover:text-violet" />
                  </Link>
                </li>
              ))}
            </ul>
            <ul className="label flex flex-col gap-1 p-5 text-ink-2">
              {utilityNav.map((item) => (
                <li key={item.label}>
                  <Link href={item.href} onClick={close} className="flex h-10 items-center">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="label shrink-0 border-t border-ink bg-ink p-5 text-night-mute">
            <p>Hotline</p>
            <a href={`tel:${site.phone.replace(/\s/g, "")}`} className="mt-1 block font-mono text-base tracking-normal text-paper">
              {site.phone}
            </a>
          </div>
        </div>
      </Sheet>
    </>
  );
}
