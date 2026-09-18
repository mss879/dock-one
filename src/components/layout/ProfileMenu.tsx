"use client";

import Link from "next/link";
import { ChevronRight, Headset, Heart, MapPin, Package, Truck, User } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { site } from "@/data/site";
import { useWishlist } from "@/lib/wishlist";

const links = [
  { label: "My orders", icon: Package },
  { label: "Wishlist", icon: Heart },
  { label: "Saved addresses", icon: MapPin },
  { label: "Track an order", icon: Truck },
  { label: "Support", icon: Headset },
];

/** Account dropdown. No auth yet — this is the signed-out state. */
export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const saved = useWishlist().length;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger}
        type="button"
        aria-label="Account"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={`grid size-11 place-items-center border transition-colors duration-150 ${open ? "border-ink bg-ink text-paper" : "border-transparent hover:border-ink"}`}
      >
        <User aria-hidden className="size-5" />
      </button>

      {open && (
        <div id={panelId} className="absolute top-[calc(100%+10px)] right-0 z-50 w-[300px] border border-ink bg-surface shadow-[6px_6px_0_0_var(--color-ink)]">
          <div className="label flex items-center justify-between bg-ink px-4 py-2 text-paper">
            <span>Guest_session</span>
            <span className="flex items-center gap-1.5 text-night-mute">
              <span className="size-1.5 bg-lime" /> Not signed in
            </span>
          </div>
          <div className="border-b border-line p-4">
            <p className="display text-2xl">Welcome to {site.wordmark[0]}</p>
            <p className="mt-1 text-sm text-ink-2">Sign in to track orders, save addresses and check out faster.</p>
            <div className="mt-3.5 grid grid-cols-2 gap-2">
              <Link href="#" onClick={() => setOpen(false)} className="label grid h-10 place-items-center bg-violet font-semibold text-white transition-colors hover:bg-ink">
                Sign in
              </Link>
              <Link href="#" onClick={() => setOpen(false)} className="label grid h-10 place-items-center border border-ink font-semibold transition-colors hover:bg-ink hover:text-paper">
                Register
              </Link>
            </div>
          </div>
          <ul className="py-1.5">
            {links.map(({ label, icon: Icon }) => (
              <li key={label}>
                <Link href="#" onClick={() => setOpen(false)} className="group flex h-10 items-center gap-3 px-4 text-sm transition-colors hover:bg-paper">
                  <Icon aria-hidden className="size-4 text-mute group-hover:text-violet-ink" />
                  <span className="flex-1">{label}</span>
                  {label === "Wishlist" && saved > 0 && <span className="label bg-lime px-1.5 font-bold">{saved}</span>}
                  <ChevronRight aria-hidden className="size-3.5 text-mute opacity-0 transition-opacity group-hover:opacity-100" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
