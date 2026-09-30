import type { MetadataRoute } from "next";
import { site } from "@/data/site";

/** Web app manifest (blueprint §5): brand name, colours from DESIGN.md (paper / ink), the existing icon. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: site.name,
    short_name: site.wordmark[0],
    description: site.description,
    start_url: "/",
    display: "browser",
    background_color: "#f3f3f1",
    theme_color: "#0b0b0c",
    icons: [{ src: "/favicon.ico", sizes: "any", type: "image/x-icon" }],
  };
}
