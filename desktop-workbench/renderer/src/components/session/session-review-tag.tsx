"use client"

import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export function SessionReviewTag({
  fileCount,
  onReview,
}: {
  fileCount: number
  onReview: () => void
}) {
  const t = useTranslations("dashboard.session.tools")

  if (fileCount === 0) return null

  return (
    <div className="pointer-events-none flex justify-center px-4 pt-2">
      <Badge
        variant="outline"
        className="pointer-events-auto h-auto max-w-full gap-2 rounded-full bg-card/85 py-1 pr-1 pl-3 shadow-sm backdrop-blur-xl transition-shadow duration-200 hover:shadow-lg hover:shadow-foreground/10 supports-backdrop-filter:bg-card/70"
      >
        <span className="truncate" aria-live="polite" aria-atomic="true">
          {t("reviewFilesChanged", { count: fileCount })}
        </span>
        <Button type="button" variant="default" size="xs" className="rounded-full" onClick={onReview}>
          {t("review")}
        </Button>
      </Badge>
    </div>
  )
}
