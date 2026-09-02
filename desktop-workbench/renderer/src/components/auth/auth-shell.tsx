"use client"

import { LocaleSwitcher } from "@/components/locale-switcher"

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* Top nav */}
      <header className="aa-window-drag flex shrink-0 items-center justify-between pb-5 pl-24 pr-8 pt-12">
        <span className="aa-wordmark hidden text-xl md:inline">Agents Anywhere</span>
        <nav className="aa-window-no-drag flex items-center gap-4 text-sm text-muted-foreground">
          <a href="#" className="hidden transition-colors hover:text-foreground md:inline">GitHub</a>
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
