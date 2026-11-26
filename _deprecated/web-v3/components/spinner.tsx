import { Loader2 } from "lucide-react"

import { cn } from "@/lib/utils"

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      aria-hidden="true"
      className={cn("size-4 animate-spin text-muted-foreground", className)}
    />
  )
}

/** Centred spinner filling the viewport, for redirects and session checks. */
export function FullPageSpinner({ label }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-svh flex-col items-center justify-center gap-3"
    >
      <Spinner className="size-5" />
      {label && <p className="text-sm text-muted-foreground">{label}</p>}
    </div>
  )
}
