import Link from "next/link";
import { site } from "@/data/site";

export function Logo({ tone = "light" }: { tone?: "light" | "dark" }) {
  const ink = tone === "dark" ? "bg-paper" : "bg-ink";
  return (
    <Link href="/" aria-label={`${site.name} — home`} className="flex shrink-0 items-center gap-2.5">
      <span aria-hidden className="grid size-7 grid-cols-3 grid-rows-3 gap-[2px]">
        <i className={ink} /> <i /> <i className="bg-violet" />
        <i /> <i className={ink} /> <i />
        <i className="bg-lime outline-1 outline-ink/20" /> <i /> <i className={ink} />
      </span>
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
