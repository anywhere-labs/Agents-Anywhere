"use client"

import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { useTranslations } from "next-intl"

export function LoadingState({
  label,
  className,
}: {
  label?: string
  className?: string
}) {
  const t = useTranslations("common")
  return (
    <div className={cn("flex items-center justify-center gap-2 text-sm text-muted-foreground", className)}>
      <Spinner className="size-4" />
      <span>{label ?? t("loading")}</span>
    </div>
  )
}
