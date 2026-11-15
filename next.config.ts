import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  redirects: async () => [{ source: "/", destination: "/passport", permanent: false }],
  // The customer pages carry a link token in the URL fragment and show a third party's job details:
  // keep them out of caches, search indexes and referrers.
  headers: async () => [
    // Every page and API response: never framed by another site (clickjacking), no MIME sniffing.
    {
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    },
    ...["/signoff", "/signoff/:path*", "/invite/:path*", "/auth/:path*", "/forgot-password", "/reset-password"].map((source) => ({
      source,
      headers: [
        { key: "Cache-Control", value: "no-store" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    })),
  ],
  experimental: {
    // proxy.ts buffers request bodies (default cap 10 MB). Uploads may be
    // 10 MB plus multipart overhead, so leave headroom or they get truncated.
    proxyClientMaxBodySize: "11mb",
  },
};

export default nextConfig;
