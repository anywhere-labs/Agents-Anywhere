// The pieces settings are built from (the settings dialog, an agent's settings): a titled group, a card of rows, a row
// with its label and hint on the left and its control on the right, and a quiet note.
import type * as React from "react"

export function Group({ title, description, action, children }: { title?: string; description?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      {(title || description || action) && (
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            {title && <h3 className="text-sm font-medium text-foreground">{title}</h3>}
            {description && <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function Card({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border rounded-2xl bg-card px-4">{children}</div>
}

export function Row({ label, hint, children }: { label: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{label}</p>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      {children !== undefined && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

export function Note({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-sm text-muted-foreground">{children}</p>
}
