import type { NextConfig } from "next";
import path from "node:path";

const apiTarget = process.env.AGENTS_ANYWHERE_API ?? "http://127.0.0.1:8000";
const apiNamespace = process.env.AGENTS_ANYWHERE_API_NAMESPACE ?? "/api/v2";
const proxyClientMaxBodySize = 100 * 1024 * 1024;
const staticExport = process.env.NEXT_OUTPUT === "export";
const browserApiTarget = staticExport ? "" : apiTarget;
const apiRoutePrefixes = [
  "/admin",
  "/agents",
  "/auth",
  "/connector",
  "/connectors",
  "/health",
  "/oauth",
  "/pairing",
  "/sessions",
  "/.well-known",
];

const nextConfig: NextConfig = {
  devIndicators: false,
  allowedDevOrigins: ["**.*", "localhost", "*.localhost"],
  output: staticExport ? "export" : undefined,
  trailingSlash: staticExport,
  turbopack: {
    root: path.resolve(__dirname, ".."),
  },
  env: {
    NEXT_PUBLIC_AGENTS_ANYWHERE_API: browserApiTarget,
    NEXT_PUBLIC_AGENTS_ANYWHERE_API_NAMESPACE: apiNamespace,
  },
  experimental: {
    // Full timeline sync uses HTTP ingest through this same-origin proxy.
    proxyClientMaxBodySize,
  },
  ...(staticExport
    ? {}
    : {
        async rewrites() {
          const namespace = normalizeApiNamespace(apiNamespace);
          if (namespace) {
            const source = `${namespace}/:path*`;
            return [{ source, destination: `${apiTarget}${source}` }];
          }
          return apiRoutePrefixes.map((prefix) => ({
            source: `${prefix}/:path*`,
            destination: `${apiTarget}${prefix}/:path*`
          }));
        }
      })
};

function normalizeApiNamespace(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export default nextConfig;
