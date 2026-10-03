import Link from "next/link";
import { LogoIcon } from "@/components/brand/LogoArt";
import { site } from "@/data/site";

/** The client's DO icon (components/brand) beside the site's "DOCK ONE_" wordmark. */
export function Logo({ tone = "light" }: { tone?: "light" | "dark" }) {
  return (
    <Link href="/" aria-label={`${site.name} — home`} className="flex shrink-0 items-center gap-2.5">
      <LogoIcon className="size-8" />
      <span className="flex flex-col">
        <span className="display text-[24px] leading-[0.95] tracking-wide">
          {site.wordmark[0]}
          <span aria-hidden className="animate-blink text-violet">_</span>
        </span>
        <span className={`label text-[9px] leading-none tracking-[0.42em] ${tone === "dark" ? "text-night-mute" : "text-mute"}`}>{site.wordmark[1]}</span>
      </span>
    </Link>
  );
}
