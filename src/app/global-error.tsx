"use client";

import { useEffect } from "react";
import { site } from "@/data/site";
import "./globals.css";

/*
 * Last-resort error page: replaces the ROOT layout when it fails, so it brings its own
 * <html>/<body> and styles (the brand fonts may not load here; the CSS fallbacks keep the look).
 * No internal detail is shown (blueprint P13).
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-dvh bg-paper text-ink">
        <title>{`Something went wrong — ${site.name}`}</title>
        <main className="shell flex min-h-dvh flex-col items-center justify-center py-16 text-center">
          <p className="label font-semibold">{site.name}</p>
          <p className="label mt-10 font-semibold text-violet-ink">&gt; Something_went_wrong</p>
          <h1 className="display mt-2 text-[clamp(2.5rem,6vw,4.5rem)]">
            That didn&apos;t load<span className="text-violet">_</span>
          </h1>
          <p className="mt-3 max-w-md text-[15px] text-ink-2">Something went wrong on our side. Please try again in a moment.</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <button type="button" onClick={() => retry()} className="label inline-flex h-11 items-center bg-ink px-5 font-semibold text-paper transition-colors hover:bg-violet">
              Try again
            </button>
            {/* a full page load: the app shell itself failed, so client navigation can't be trusted */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="label inline-flex min-h-10 items-center font-semibold hover:text-violet-ink">
              [ Back to home ]
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
