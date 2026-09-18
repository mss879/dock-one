import Link from "next/link";
import { Mail, MapPin, Phone } from "lucide-react";
import { footerNav, paymentMethods, site } from "@/data/site";
import { Cross } from "@/components/ui/Cross";
import { Logo } from "./Logo";

const socials = ["Facebook", "Instagram", "TikTok", "YouTube"];

export function Footer() {
  return (
    <footer className="bg-night text-paper">
      <div className="shell relative grid gap-10 border-b border-night-line py-14 md:grid-cols-2 lg:grid-cols-[1.5fr_repeat(4,1fr)]">
        <Cross className="top-4 right-4 text-night-mute sm:right-6 lg:right-8" />
        <div>
          <Logo tone="dark" />
          <p className="mt-4 max-w-xs text-sm text-night-mute">{site.description}</p>
          <ul className="mt-5 space-y-2 text-sm">
            <li className="flex items-center gap-2.5">
              <Phone aria-hidden className="size-4 text-lime" />
              <a href={`tel:${site.phone.replace(/\s/g, "")}`} className="font-mono hover:text-lime">
                {site.phone}
              </a>
            </li>
            <li className="flex items-center gap-2.5">
              <Mail aria-hidden className="size-4 text-lime" />
              <a href={`mailto:${site.email}`} className="hover:text-lime">
                {site.email}
              </a>
            </li>
            <li className="flex items-center gap-2.5">
              <MapPin aria-hidden className="size-4 text-lime" /> {site.address}
            </li>
          </ul>
        </div>

        {footerNav.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <h2 className="label mb-4 font-semibold text-night-mute">{column.title}</h2>
            <ul className="space-y-2.5 text-sm">
              {column.links.map((label) => (
                <li key={label}>
                  <Link href="#" className="transition-colors hover:text-lime">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>

      <div className="shell flex flex-col gap-5 py-6 lg:flex-row lg:items-center lg:justify-between">
        <ul className="label flex flex-wrap gap-x-5 gap-y-2">
          {socials.map((name) => (
            <li key={name}>
              <Link href="#" className="text-night-mute transition-colors hover:text-lime">
                {name} ↗
              </Link>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <span className="label mr-1 text-night-mute">We accept</span>
          {paymentMethods.map((method) => (
            <span key={method} className="label border border-night-line px-2 py-1 font-semibold">
              {method}
            </span>
          ))}
        </div>
      </div>

      {/* status bar from the CYBR_ reference */}
      <div className="border-t border-night-line">
        <div className="shell label flex flex-col items-stretch gap-0 px-0 sm:flex-row sm:items-center sm:px-6 lg:px-8">
          <p className="flex items-center gap-2 px-4 py-3 text-night-mute sm:px-0">
            <span className="size-1.5 bg-lime" /> Connection secure
            <span className="hidden md:inline">
              {"//"} © 2026 {site.name}. All rights reserved.
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
