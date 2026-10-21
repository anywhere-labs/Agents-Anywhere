"use client"

import type { ReactNode } from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"

const COLUMNS = {
  3: "grid-cols-3",
  4: "grid-cols-2 xl:grid-cols-4",
  5: "grid-cols-2 sm:grid-cols-3 xl:grid-cols-5",
  6: "grid-cols-2 sm:grid-cols-3 xl:grid-cols-6",
} as const

/**
 * A row of headline figures on one surface. The cells share hairlines instead
 * of each wearing its own card, so the row reads as one set of numbers for the
 * selected range rather than six unrelated boxes.
 */
export function StatGrid({
  children,
  columns = 6,
  inset = false,
  className,
}: {
  children: ReactNode
  columns?: keyof typeof COLUMNS
  /** Inside another card: a plain hairline frame instead of a card. */
  inset?: boolean
  className?: string
}) {
  const grid = cn("grid gap-px bg-border", COLUMNS[columns])
  if (inset) {
    return <div className={cn("overflow-hidden rounded-lg border border-border", grid, className)}>{children}</div>
  }
  return (
    <Card className={cn("gap-0 py-0", className)}>
      <div className={grid}>{children}</div>
    </Card>
  )
}

export function StatTile({
  label,
  value,
  helper,
  className,
}: {
  label: string
  value: string
  helper?: string | null
  className?: string
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 bg-card px-5 py-4", className)}>
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold leading-tight tracking-tight">{value}</div>
      {helper ? <div className="truncate text-xs text-muted-foreground">{helper}</div> : null}
    </div>
  )
}

export function ChartCard({
  title,
  hint,
  children,
  className,
}: {
  title: string
  hint?: string | null
  children: ReactNode
  className?: string
}) {
  return (
    <Card className={cn("gap-4 py-5", className)}>
      <CardHeader className="px-5 pb-0">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardHeader>
      <CardContent className="px-5">{children}</CardContent>
    </Card>
  )
}

export function EmptyNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-40 items-center justify-center text-sm text-muted-foreground", className)}>
      {children}
    </div>
  )
}
