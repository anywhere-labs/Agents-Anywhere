import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  devIndicators: false,
  assetPrefix: "./",
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
}

export default nextConfig
