import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  devIndicators: false,
  assetPrefix: process.env.NODE_ENV === "production" ? "./" : undefined,
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
}

export default nextConfig
