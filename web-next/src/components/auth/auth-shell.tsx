"use client"

import { LocaleSwitcher } from "@/components/locale-switcher"

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Top nav */}
      <header className="flex items-center justify-between px-8 py-5">
        <span className="aa-wordmark text-xl">Agents Anywhere</span>
        <nav className="flex items-center gap-4 text-sm text-muted-foreground">
          <a href="#" className="transition-colors hover:text-foreground">GitHub</a>
          <LocaleSwitcher size="sm" variant="ghost" className="text-foreground" />
        </nav>
      </header>

      {/* Centered content */}
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          {children}
        </div>
      </main>
    </div>
  )
}
