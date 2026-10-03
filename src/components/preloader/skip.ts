/*
 * Shared by the store layout (server) and the preloader (client): kept out of the "use client"
 * modules because a server component can't read plain values exported from those.
 */

export const PRELOADER_ID = "pl-dock";
export const SEEN_KEY = "dockone:preloader";
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/**
 * Inlined by the store layout right after the overlay: on a hard load it hides the overlay before
 * the first paint when it already played this session, or when the visitor prefers reduced motion.
 */
export const PRELOADER_SKIP_SCRIPT = `try{var e=document.getElementById(${JSON.stringify(PRELOADER_ID)});if(e&&(sessionStorage.getItem(${JSON.stringify(SEEN_KEY)})||matchMedia(${JSON.stringify(REDUCED_MOTION)}).matches))e.setAttribute("data-skip","")}catch(_){}`;
