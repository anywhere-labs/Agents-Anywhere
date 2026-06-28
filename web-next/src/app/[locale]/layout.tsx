import { NextIntlClientProvider, hasLocale } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { Caveat, Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { notFound } from "next/navigation";
import type { Metadata, Viewport } from "next";
import "../globals.css";
import { routing } from "@/i18n/routing";
import { ThemeProvider } from "@/components/theme-provider";
import { ToasterProvider } from "@/components/toaster-provider";

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
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
    { media: "(prefers-color-scheme: light)", color: "#fafaf9" }
  ]
};

type LocaleLayoutProps = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params
}: LocaleLayoutProps) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }
  setRequestLocale(locale);
  const messages = await getMessages({ locale });

  return (
    <html lang={locale} suppressHydrationWarning>
      <body className={`${sans.variable} ${mono.variable} ${serif.variable} ${brand.variable} antialiased`}>
        <NextIntlClientProvider messages={messages}>
          <ThemeProvider defaultTheme="dark">{children}<ToasterProvider /></ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
