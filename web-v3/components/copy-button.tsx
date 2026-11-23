"use client"

import { Check, Copy } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"

/** Copy `value` to the clipboard and confirm with a check mark. */
export function CopyButton({
  value,
  label,
  copyLabel = "Copy",
  copyFailedLabel = "Could not copy to clipboard.",
  variant = "ghost",
  size = "icon-sm",
  className,
}: {
  value: string
  /** Visible text; without it the button is icon-only. */
  label?: string
  copyLabel?: string
  copyFailedLabel?: string
  variant?: React.ComponentProps<typeof Button>["variant"]
  size?: React.ComponentProps<typeof Button>["size"]
  className?: string
}) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1500)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      toast.error(copyFailedLabel)
    }
  }

  const Icon = copied ? Check : Copy
  return (
    <Button
      type="button"
      variant={variant}
      size={label ? (size === "icon-sm" ? "sm" : size) : size}
      className={className}
      onClick={() => void copy()}
      aria-label={label ? undefined : copyLabel}
    >
      <Icon data-icon={label ? "inline-start" : undefined} />
      {label}
    </Button>
  )
}
