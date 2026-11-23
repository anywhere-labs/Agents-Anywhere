import type { NextConfig } from "next"

const controlUrl = (process.env.AA_CONTROL_SERVER_URL ?? "").replace(/\/+$/, "")

// `AA_DESKTOP_EXPORT=1` builds the static bundle that `desktop-v3/` ships inside the app and serves from its
// `app://` protocol (see `lib/platform/desktop.ts`). The desktop shell answers `/api/control/*` itself, so
// rewrites and response headers (server-only features) are left out of that build.
const desktopExport = process.env.AA_DESKTOP_EXPORT === "1"

const nextConfig: NextConfig = desktopExport
  ? {
      output: "export",
      // Separate from `.next` so a running `next dev` is not disturbed; the export itself goes to `out/`.
      distDir: ".next-desktop",
      poweredByHeader: false,
      transpilePackages: ["meshcall"],
      images: { unoptimized: true },
      env: { NEXT_PUBLIC_AA_DESKTOP_EXPORT: "1" },
    }
  : {
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
