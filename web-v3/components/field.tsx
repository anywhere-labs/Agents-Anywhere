import { cn } from "@/lib/utils"

/** Label, optional hint, control and error, stacked. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
  trailing,
}: {
  label: React.ReactNode
  htmlFor?: string
  hint?: React.ReactNode
  error?: React.ReactNode
  children: React.ReactNode
  className?: string
  /** Shown at the end of the label row (e.g. "Forgot password?"). */
  trailing?: React.ReactNode
}) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
        </label>
        {trailing}
      </div>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

/** A notice inside a form or card: info, success, warning or error. */
export function Notice({
  tone = "info",
  children,
  className,
  icon,
}: {
  tone?: "info" | "success" | "warning" | "error"
  children: React.ReactNode
  className?: string
  icon?: React.ReactNode
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-left text-sm",
        tone === "info" && "bg-surface-raised text-foreground-secondary",
        tone === "success" && "bg-success/10 text-success",
        tone === "warning" && "bg-warning/10 text-warning",
        tone === "error" && "bg-destructive/10 text-destructive",
        className
      )}
    >
      {icon && <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
