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
    ...["/signoff", "/signoff/:path*"].map((source) => ({
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
