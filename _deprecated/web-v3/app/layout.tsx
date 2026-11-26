import type { Metadata, Viewport } from "next"

import "@fontsource/caveat/500.css"
import "./harmonyos-sans-sc.css"
import "./globals.css"
import { Providers } from "@/components/providers"
import { APP_CONFIG } from "@/lib/config"

export const metadata: Metadata = {
  title: {
    default: APP_CONFIG.brandName,
    template: `%s · ${APP_CONFIG.brandName}`,
  },
  applicationName: APP_CONFIG.brandName,
  description: APP_CONFIG.description,
}

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang={APP_CONFIG.defaultLocale} suppressHydrationWarning className="antialiased">
      <body className="font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
