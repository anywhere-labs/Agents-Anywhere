import type { NextConfig } from "next";

const apiTarget = process.env.AGENTS_ANYWHERE_API ?? "http://127.0.0.1:8000";
const proxyClientMaxBodySize = 100 * 1024 * 1024;
const staticExport = process.env.NEXT_OUTPUT === "export";
const browserApiTarget = staticExport ? "" : apiTarget;

const nextConfig: NextConfig = {
  devIndicators: false,
  allowedDevOrigins: ["**.*", "localhost", "*.localhost"],
  output: staticExport ? "export" : undefined,
  trailingSlash: staticExport,
  env: {
    NEXT_PUBLIC_AGENTS_ANYWHERE_API: browserApiTarget,
  },
  experimental: {
    // Full timeline sync uses HTTP ingest through this same-origin proxy.
    proxyClientMaxBodySize,
  },
  ...(staticExport
    ? {}
    : {
        async rewrites() {
          return [
            {
              source: "/api/:path*",
              destination: `${apiTarget}/api/:path*`
            }
          ];
        }
      })
};

export default nextConfig;
