import type { NextConfig } from "next"

const controlUrl = (process.env.AA_CONTROL_SERVER_URL ?? "").replace(/\/+$/, "")

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  transpilePackages: ["meshcall"],
  async rewrites() {
    if (!controlUrl) return []
    return [
      {
        source: "/api/control/:path*",
        destination: `${controlUrl}/:path*`,
      },
    ]
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ]
  },
}

export default nextConfig
