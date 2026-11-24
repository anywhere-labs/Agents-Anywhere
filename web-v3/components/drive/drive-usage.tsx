"use client"

// How much of the cloud drive is used against its limits, on the drive page and in Settings › Drive: a bar for the
// space, which turns amber and then red as it fills, and under it the limits every file meets (the largest one
// allowed, how long files are kept) with the file count. An unlimited drive has no bar, only what it holds.
import { useI18n } from "@/components/i18n-provider"
import { Progress, ProgressLabel, ProgressValue } from "@/components/ui/progress"
import { formatDriveDuration } from "@/lib/drive/entries"
import type { DriveQuotaView } from "@/lib/types/v3"
import { cn } from "@/lib/utils"
import { formatSize } from "@/lib/workbench/time"

/** How full the drive is: amber from 80%, red from 95%, where a typical upload no longer fits. */
export function driveUsageLevel(used: number, quota: number): "normal" | "high" | "full" {
  const ratio = used / quota
  if (ratio >= 0.95) return "full"
  if (ratio >= 0.8) return "high"
  return "normal"
}

export function DriveUsage({ quota, className }: { quota: DriveQuotaView; className?: string }) {
  const { t, locale } = useI18n()
  const total = quota.quota_bytes
  const used = formatSize(quota.used_bytes)
  const limits = [
    quota.max_file_bytes != null ? t("drive.maxFile", { size: formatSize(quota.max_file_bytes) }) : null,
    t("drive.retention", { duration: formatDriveDuration(quota.default_ttl_seconds, locale) }),
    t("drive.fileCount", { count: quota.file_count }),
  ]
    .filter(Boolean)
    .join(" · ")

  if (total == null || total <= 0) {
    return (
      <div className={cn("space-y-1", className)}>
        <p className="text-sm text-foreground">{t("drive.usageUnlimited", { used })}</p>
        <p className="text-xs text-muted-foreground">{limits}</p>
      </div>
    )
  }

  const level = driveUsageLevel(quota.used_bytes, total)
  return (
    <div className={cn("space-y-2", className)}>
      <Progress
        value={Math.min(100, (quota.used_bytes / total) * 100)}
        className={cn(
          "items-baseline gap-x-3 gap-y-2",
          level === "high" && "[&_[data-slot=progress-indicator]]:bg-warning",
          level === "full" && "[&_[data-slot=progress-indicator]]:bg-destructive"
        )}
      >
        <ProgressLabel className="font-normal text-foreground">
          {t("drive.usage", { used, quota: formatSize(total) })}
        </ProgressLabel>
        <ProgressValue className={cn("text-xs", level !== "normal" && "text-foreground")} />
      </Progress>
      <p className="text-xs text-muted-foreground">{limits}</p>
    </div>
  )
}
