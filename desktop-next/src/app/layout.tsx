import type { Metadata, Viewport } from "next"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { ToasterProvider } from "@/components/toaster-provider"

export const metadata: Metadata = {
  title: "Agents Anywhere Connector",
  description: "Desktop connector controller for Agents Anywhere",
  applicationName: "Agents Anywhere Connector",
}

export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
    { media: "(prefers-color-scheme: light)", color: "#fafaf9" },
  ],
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">
        <ThemeProvider defaultTheme="dark">
          {children}
          <ToasterProvider />
        </ThemeProvider>
      </body>
    </html>
  )
}
