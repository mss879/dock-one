"use client";

import { ArrowUpRight, ChevronDown } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { NavGroup } from "./nav";

/**
 * One desktop nav group ("Computing", "Accessories"…): opens on hover, on click (touch screens) and
 * from the keyboard; Escape or a click elsewhere closes it. The panel lists the group's categories
 * with their taglines.
 */
export function NavDropdown({ group }: { group: NavGroup }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const show = () => {
    cancelClose();
    setOpen(true);
  };
  const hide = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => cancelClose, []);

  return (
    <div
      ref={root}
      className="relative flex h-full items-center"
      onPointerEnter={(e) => e.pointerType === "mouse" && show()}
      onPointerLeave={(e) => e.pointerType === "mouse" && hide()}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 py-2 uppercase transition-colors hover:text-violet-ink ${open ? "text-violet-ink" : ""}`}
      >
        {group.label}
        <ChevronDown aria-hidden className={`size-3.5 transition-transform duration-300 ease-brut ${open ? "rotate-180" : ""}`} />
      </button>

      <div
        id={panelId}
        hidden={!open}
        className="absolute top-full left-1/2 z-50 w-[320px] -translate-x-1/2 border border-ink bg-surface text-ink shadow-[6px_6px_0_0_var(--color-ink)]"
      >
        <span aria-hidden className="block h-1 bg-violet" />
        <p className="label border-b border-line px-4 py-2.5 text-mute">
          <span className="text-violet-ink">/</span> {group.label} · {String(group.items.length).padStart(2, "0")}
        </p>
        <ul className="py-1.5">
          {group.items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={() => setOpen(false)}
                className="group/item flex items-center gap-3 px-4 py-2.5 normal-case tracking-normal transition-colors hover:bg-violet-soft focus-visible:bg-violet-soft"
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-sans text-[14px] leading-5 font-medium">{item.label}</span>
                  {item.note && <span className="block truncate font-sans text-[12px] leading-4 text-mute">{item.note}</span>}
                </span>
                <ArrowUpRight aria-hidden className="size-4 shrink-0 text-violet-ink opacity-0 transition-opacity group-hover/item:opacity-100 group-focus-visible/item:opacity-100" />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
