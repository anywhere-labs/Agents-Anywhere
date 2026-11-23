"use client"

import Link from "next/link"

import { BrandWordmark } from "@/components/brand-wordmark"

/**
 * The sign-in pages' frame: brand wordmark at the top left (hover-free),
 * optional right header slot (e.g. language switcher), centred content that
 * rises into view, and a quiet `footer` below.
 */
export function SignInShell({
  brandName,
  homeHref = "/account",
  headerEnd,
  children,
  footer,
}: {
  brandName?: string
  homeHref?: string
  headerEnd?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex items-center justify-between p-4">
        <Link
          href={homeHref}
          className="inline-flex h-8 items-center rounded-full px-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BrandWordmark size="sm" name={brandName} />
        </Link>
        {headerEnd}
      </header>
      <main className="flex flex-1 animate-in items-center justify-center px-6 py-8 duration-700 fade-in slide-in-from-bottom-3 motion-reduce:animate-none">
        {children}
      </main>
      {/* Balances the header height so centred content stays optically centred. */}
      <footer className="flex min-h-12 items-end justify-center px-6 pb-8">
        {footer}
      </footer>
    </div>
  )
}

/** A step's title and optional subtitle. */
export function StepHeading({
  title,
  description,
}: {
  title: React.ReactNode
  description?: React.ReactNode
}) {
  return (
    <div className="mb-4 flex flex-col items-center gap-2 text-center">
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {description && (
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
    </div>
  )
}

/** A centred status block with a borderless standalone icon (for errors/results). */
export function ResultCard({
  icon: Icon,
  tone = "default",
  title,
  description,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  tone?: "default" | "destructive" | "success"
  title: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex w-full max-w-sm flex-col items-center text-center">
      <Icon
        className={
          tone === "destructive"
            ? "size-8 stroke-[1.5] text-destructive"
            : tone === "success"
              ? "size-8 stroke-[1.5] text-success"
              : "size-8 stroke-[1.5] text-muted-foreground"
        }
      />
      <h1 className="mt-4 text-2xl font-bold tracking-tight">{title}</h1>
      {description && (
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
      )}
      {children && <div className="mt-8 flex w-full flex-col gap-3">{children}</div>}
    </div>
  )
}
