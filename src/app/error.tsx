"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/components/ui/Button";
import { Cross } from "@/components/ui/Cross";
import { site } from "@/data/site";

/*
 * The brand error page for anything that throws below the root layout (a failed page-defining
 * read, a render error). Errors are copy, not stack traces (blueprint P13): the shopper sees a
 * plain message and a retry; the detail stays in the logs (production hands the client only a
 * digest).
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main id="main" className="shell flex min-h-dvh flex-col items-center justify-center py-16 text-center">
      <Link href="/" className="label font-semibold hover:text-violet-ink">
        {site.name}
      </Link>
      <div aria-hidden className="bg-grid relative mt-12 grid size-40 place-items-center border border-line [--grid-size:16px]">
        <Cross className="-top-[6px] -left-[6px]" />
        <Cross className="-right-[6px] -bottom-[6px]" />
        <span className="display text-7xl text-ink/20">!</span>
      </div>
      <p className="label mt-8 font-semibold text-violet-ink">&gt; Something_went_wrong</p>
      <h1 className="display mt-2 text-[clamp(2.5rem,6vw,4.5rem)]">
        That didn&apos;t load<span className="text-violet">_</span>
      </h1>
      <p className="mt-3 max-w-md text-[15px] text-ink-2">Something went wrong on our side. Please try again in a moment.</p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
        <Button onClick={() => retry()}>Try again</Button>
        <Link href="/" className="label inline-flex min-h-10 items-center font-semibold hover:text-violet-ink">
          [ Back to home ]
        </Link>
      </div>
    </main>
  );
}
