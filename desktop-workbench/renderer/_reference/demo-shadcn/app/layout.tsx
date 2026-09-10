import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";

const fontSans = Geist({subsets:['latin'],variable:'--font-sans'});


export const metadata: Metadata = {
  title: "Agents Anywhere",
  description: "Give the agent a task and run it on any of your devices.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${fontSans.variable} bg-background`}>
      <body
        className="antialiased"
      >
        <ThemeProvider defaultTheme="dark">{children}</ThemeProvider>
      </body>
    </html>
  );
}
