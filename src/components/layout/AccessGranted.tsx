import Image from "next/image";

/** The agency that designed and built the site — its canonical address (the bare domain and http 301 here). */
const ARC_AI_URL = "https://www.arcai.agency";

/**
 * The white "> ACCESS GRANTED_" chip in the footer's status bar, signed by the agency that built the
 * site. Every 8 s the HUD half types itself out (a white shutter carrying the cursor steps right one
 * character at a time), then a violet scan line sweeps the credit and the Arc AI logo glitches as it
 * passes — CSS only, globals.css "Footer status chip". At rest, and under reduced motion, the chip
 * reads in full.
 *
 * The credit is a plain followed link (no nofollow / sponsored / ugc) rendered on the server on every
 * storefront page; its anchor text is "Designed by" + the logo's alt. rel="noopener" without
 * "noreferrer", so the agency's analytics see the visits as referrals from this site.
 */
export function AccessGranted() {
  return (
    <div className="flex flex-wrap items-stretch bg-surface text-ink sm:mx-auto">
      <span aria-hidden className="flex min-h-10 items-center border-r border-line px-3 font-semibold sm:px-5">
        <span className="whitespace-pre">{"> "}</span>
        <span className="relative overflow-hidden">
          Access granted
          <span className="invisible">_</span>
          <span className="access-shutter absolute inset-0 bg-surface">
            <span className="animate-blink absolute top-0 left-0">_</span>
          </span>
        </span>
      </span>
      <a
        href={ARC_AI_URL}
        target="_blank"
        rel="noopener"
        className="group relative flex min-h-10 items-center gap-2 overflow-hidden px-3 sm:gap-2.5 sm:px-4"
      >
        <span className="text-mute transition-colors group-hover:text-violet-ink">Designed by</span>{" "}
        <Image src="/brand/arc-ai-logo.webp" alt="Arc AI" width={80} height={20} quality={90} className="access-logo h-[18px] w-auto sm:h-5" />
        <span aria-hidden className="text-mute transition-[color,translate] duration-150 ease-brut group-hover:translate-x-px group-hover:-translate-y-px group-hover:text-violet-ink">
          ↗
        </span>
        <span className="sr-only"> (opens in a new tab)</span>
        <span aria-hidden className="access-scan pointer-events-none absolute inset-0" />
      </a>
    </div>
  );
}
