import type { NextConfig } from "next";

// The browser talks to this app only; /v1/* is forwarded to the API, so there is no CORS and the API address is not
// baked into the page. In production nginx routes /v1 to the API directly and this rewrite is not used.
const apiOrigin = process.env.API_ORIGIN ?? "http://localhost:3001";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: "/v1/:path*", destination: `${apiOrigin}/v1/:path*` }];
  },
  async headers() {
    return [
      {
        // A service worker must always be re-checked, otherwise a fixed worker reaches users days late.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Content-Type", value: "text/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
