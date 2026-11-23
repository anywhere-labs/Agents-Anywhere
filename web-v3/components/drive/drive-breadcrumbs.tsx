"use client"

import { ChevronRightIcon } from "lucide-react"

import { driveFolderLabel } from "@/components/drive/drive-labels"
import { useI18n } from "@/components/i18n-provider"
import { DRIVE_ROOT, driveBreadcrumbs } from "@/lib/drive/paths"
import { cn } from "@/lib/utils"

/** Path of the open folder, root first; every level but the last goes back to it. */
export function DriveBreadcrumbs({
  path,
  onNavigate,
  className,
}: {
  path: string
  onNavigate: (path: string) => void
  className?: string
}) {
  const { t } = useI18n()
  const crumbs = [
    { path: DRIVE_ROOT, label: driveFolderLabel(DRIVE_ROOT, "", t) },
    ...driveBreadcrumbs(path).map((crumb) => ({
      path: crumb.path,
      label: driveFolderLabel(crumb.path, crumb.name, t),
    })),
  ]
  return (
    <nav aria-label={t("drive.breadcrumb")} className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 flex-wrap items-center gap-y-1 text-sm">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1
          return (
            <li key={crumb.path} className="flex min-w-0 items-center">
              {index > 0 && <ChevronRightIcon aria-hidden className="mx-0.5 size-4 shrink-0 text-muted-foreground" />}
              {last ? (
                <span aria-current="page" className="max-w-64 truncate px-2 py-1 font-medium text-foreground">
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onNavigate(crumb.path)}
                  className="max-w-48 truncate rounded-full px-2 py-1 text-muted-foreground transition-colors outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {crumb.label}
                </button>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
