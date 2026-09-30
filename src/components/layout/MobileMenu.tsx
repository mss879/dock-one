"use client";

import Link from "next/link";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import type { NavLink } from "./nav";

/** The phone-size menu. Items and contact come from the server header (active categories, store settings). */
export function MobileMenu({ items, utility, hotline }: { items: NavLink[]; utility: NavLink[]; hotline: { display: string; href: string } | null }) {
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
              {items.map((item, i) => (
                <li key={item.href} className="border-b border-line">
                  <Link href={item.href} onClick={close} className="group flex h-14 items-center gap-4 px-5 hover:bg-surface">
                    <span className="label text-violet-ink">/{String(i + 1).padStart(2, "0")}</span>
                    <span className="display flex-1 text-2xl">{item.label}</span>
                    <ArrowUpRight aria-hidden className="size-4 text-mute group-hover:text-violet" />
                  </Link>
                </li>
              ))}
            </ul>
            <ul className="label flex flex-col gap-1 p-5 text-ink-2">
              {utility.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} onClick={close} className="flex h-10 items-center">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          {hotline && (
            <div className="label shrink-0 border-t border-ink bg-ink p-5 text-night-mute">
              <p>Hotline</p>
              <a href={hotline.href} className="mt-1 flex min-h-10 items-center font-mono text-base tracking-normal text-paper">
                {hotline.display}
              </a>
            </div>
          )}
        </div>
      </Sheet>
    </>
  );
}
