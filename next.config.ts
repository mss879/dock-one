import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    formats: ["image/avif", "image/webp"],
    // Next 16 only serves qualities on this allowlist (default is [75]).
    qualities: [75, 90],
  },
};

export default nextConfig;
