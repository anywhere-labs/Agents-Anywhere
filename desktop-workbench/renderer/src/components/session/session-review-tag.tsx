"use client"

import { useTranslations } from "next-intl"

import type { ReviewFileChange } from "@/components/session/session-review-model"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

export function SessionReviewTag({
  files,
  onReview,
}: {
  files: ReviewFileChange[]
  onReview: () => void
}) {
  const t = useTranslations("dashboard.session.tools")

  if (files.length === 0) return null

  const additions = files.reduce((total, file) => total + file.additions, 0)
  const deletions = files.reduce((total, file) => total + file.deletions, 0)

  return (
    <div className="pointer-events-none flex justify-center px-4 pt-2">
      <Badge
        variant="outline"
        className="pointer-events-auto h-auto max-w-full gap-3 rounded-xl bg-card/85 py-1.5 pr-1.5 pl-4 shadow-sm backdrop-blur-xl supports-backdrop-filter:bg-card/70"
      >
        <span className="flex min-w-0 items-center gap-2 text-sm font-normal" aria-live="polite" aria-atomic="true">
          <span className="truncate text-muted-foreground">
            {t("reviewFilesChanged", { count: files.length })}
          </span>
          <span className="flex shrink-0 gap-1 tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
            <span className="text-red-600 dark:text-red-400">-{deletions}</span>
          </span>
        </span>
        <Button type="button" variant="default" size="sm" className="rounded-lg" onClick={onReview}>
          {t("review")}
        </Button>
      </Badge>
    </div>
  )
}
