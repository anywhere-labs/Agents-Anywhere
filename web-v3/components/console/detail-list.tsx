"use client"

import { cn } from "@/lib/utils"

export interface DetailItem {
  /** Stable React key (internal only — never rendered to end users). */
  key: string
  /** Human-readable localized title. */
  label: React.ReactNode
  /** Optional multi-line explanation of what this item covers. */
  description?: React.ReactNode
  /** Right-aligned formatted value (e.g. "512 MB", "7 天", "Unlimited"). */
  value: React.ReactNode
}

/**
 * Hairline-divided key/value list for plans, quotas, and account attributes.
 * Keeps raw internal field keys out of end-user interfaces while aligning
 * multi-line explanations on the left with tabular values on the right.
 */
export function DetailList({
  items,
  emptyText,
  className,
}: {
  items: readonly DetailItem[]
  emptyText?: React.ReactNode
  className?: string
}) {
  if (items.length === 0) {
    return emptyText ? (
      <p className={cn("text-sm text-muted-foreground", className)}>{emptyText}</p>
    ) : null
  }

  return (
    <dl className={cn("divide-y divide-border", className)}>
      {items.map((item) => (
        <div
          key={item.key}
          className="flex flex-col gap-1.5 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-8"
        >
          <dt className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{item.label}</p>
            {item.description && (
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {item.description}
              </p>
            )}
          </dt>
          <dd className="shrink-0 text-sm font-semibold tabular-nums text-foreground sm:pt-0.5 sm:text-right">
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Borderless `rounded-card bg-card` surface hosting a title, optional
 * description, and a hairline-separated `DetailList`.
 */
export function DetailCard({
  title,
  description,
  items,
  emptyText,
  headerAction,
  className,
}: {
  title?: React.ReactNode
  description?: React.ReactNode
  items: readonly DetailItem[]
  emptyText?: React.ReactNode
  headerAction?: React.ReactNode
  className?: string
}) {
  const hasHeader = Boolean(title || description || headerAction)

  return (
    <div className={cn("flex flex-col gap-5 rounded-card bg-card p-6", className)}>
      {hasHeader && (
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {title && (
              <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
            )}
            {description && (
              <p className="text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {headerAction && <div className="shrink-0">{headerAction}</div>}
        </div>
      )}
      <div className={cn(hasHeader && "border-t border-border pt-5")}>
        <DetailList items={items} emptyText={emptyText} />
      </div>
    </div>
  )
}
