"use client";

import { usePathname } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { DockingPreloader } from "./DockingPreloader";
import { REDUCED_MOTION, SEEN_KEY } from "./skip";

/*
 * Plays the Docking preloader on the homepage only, once per browser session, never under
 * reduced motion. Mounted first in the store layout so it is the first thing that paints.
 *
 * A hard load can't read sessionStorage on the server, so the overlay is always server-rendered
 * on "/" and PRELOADER_SKIP_SCRIPT (skip.ts, inlined right after it by the layout) hides it before
 * the first paint when it has already played. Client-side navigations read sessionStorage directly.
 */

const subscribe = () => () => {};
function alreadySeen() {
  try {
    return Boolean(sessionStorage.getItem(SEEN_KEY)) || matchMedia(REDUCED_MOTION).matches;
  } catch {
    return false;
  }
}

export function HomePreloader() {
  const pathname = usePathname();
  const seen = useSyncExternalStore(subscribe, alreadySeen, () => false);
  const [done, setDone] = useState(false);
  if (pathname !== "/" || seen || done) return null;

  const finish = () => {
    try {
      sessionStorage.setItem(SEEN_KEY, "1");
    } catch {
      // storage blocked: it simply plays again next time
    }
    setDone(true);
  };
  return <DockingPreloader onDone={finish} />;
}
