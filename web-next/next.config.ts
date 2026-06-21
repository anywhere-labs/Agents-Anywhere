import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const apiTarget = process.env.AGENTS_ANYWHERE_API ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  devIndicators: false,
  async rewrites() {
    return [
      "/auth/:path*",
      "/admin/:path*",
      "/health",
      "/agents/:path*",
      "/approvals/:path*",
      "/connectors/:path*",
      "/pairing/:path*",
      "/sessions/:path*",
      "/connector/:path*"
    ].map((source) => ({
      source,
      destination: `${apiTarget}${source}`
    }));
  }
};

export default withNextIntl(nextConfig);
