import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const apiNamespace = "/api/v2";
const apiTarget = process.env.AGENTS_ANYWHERE_API ?? "http://127.0.0.1:8000";
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
  ...(staticExport
    ? {}
    : {
        async rewrites() {
          return [
            "/.well-known/:path*",
            "/auth/:path*",
            "/oauth/:path*",
            "/admin/:path*",
            "/health",
            "/agents/:path*",
            "/approvals/:path*",
            "/connectors/:path*",
            "/pairing/:path*",
            "/sessions/:path*",
            "/connector/:path*"
          ].map((path) => ({
            source: `${apiNamespace}${path}`,
            destination: `${apiTarget}${apiNamespace}${path}`
          }));
        }
      })
};

export default withNextIntl(nextConfig);
