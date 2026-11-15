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
  experimental: {
    // proxy.ts buffers request bodies (default cap 10 MB). Uploads may be
    // 10 MB plus multipart overhead, so leave headroom or they get truncated.
    proxyClientMaxBodySize: "11mb",
  },
};

export default nextConfig;
