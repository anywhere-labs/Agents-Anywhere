import type * as React from "react"

/** A page section's label: quiet, like the sidebar's group labels (v2's section headings). */
export function SectionLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-1 flex min-h-8 items-center justify-between gap-2 px-2">
      <h2 className="text-xs font-medium text-muted-foreground">{children}</h2>
      {action}
    </div>
  )
}
