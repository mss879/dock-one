import type { MetadataRoute } from "next";
import { site } from "@/data/site";

/** Web app manifest (blueprint §5): brand name, colours from DESIGN.md (paper / ink), the logo-mark icons (scripts/images/icons.py). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: site.name,
    short_name: site.wordmark[0],
    description: site.description,
    start_url: "/",
    display: "browser",
    background_color: "#f3f3f1",
    theme_color: "#0b0b0c",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
