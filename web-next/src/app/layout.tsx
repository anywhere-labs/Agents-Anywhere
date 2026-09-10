import { Caveat, Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { ToasterProvider } from "@/components/toaster-provider";
import { I18nProvider } from "@/i18n/client-provider";

const sans = Geist({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-geist"
});

const mono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-geist-mono"
});

const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-instrument-serif"
});

const brand = Caveat({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-caveat"
});

export const metadata: Metadata = {
  title: "Agents Anywhere",
  description: "Remote control plane for coding agents",
  applicationName: "Agents Anywhere",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      {
        url: "/favicon-dark-mode.png",
        type: "image/png",
        media: "(prefers-color-scheme: dark)"
      },
      {
        url: "/favicon-light-mode.png",
        type: "image/png",
        media: "(prefers-color-scheme: light)"
      },
      {
        url: "/favicon-dark-mode.png",
        type: "image/png"
      }
    ],
    apple: [
      {
        url: "/apple-touch-icon.png",
        sizes: "180x180",
        type: "image/png"
      }
    ]
  },
  appleWebApp: {
    capable: true,
    title: "Agents Anywhere",
    statusBarStyle: "black-translucent"
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
    { media: "(prefers-color-scheme: light)", color: "#fafaf9" }
  ]
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${sans.variable} ${mono.variable} ${serif.variable} ${brand.variable} antialiased`}>
        <I18nProvider>
          <ThemeProvider defaultTheme="dark">
            {children}
            <ToasterProvider />
          </ThemeProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
