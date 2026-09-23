"use client"

import * as React from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { LazyFileTree } from "@/components/panels/lazy-file-tree"
import type { FsEntry, FsListResult } from "@/features/dashboard/types"
import { filePathBreadcrumbParent } from "@/lib/file-path-breadcrumb"
import { cn } from "@/lib/utils"

export function FileBreadcrumbPicker({
  path, label, current, directory, caseInsensitivePaths, loadDirectory, onSelect, onBrowse,
}: {
  path: string
  label: string
  current: boolean
  directory: boolean
  caseInsensitivePaths: boolean
  loadDirectory: (path: string) => Promise<FsListResult>
  onSelect: (entry: FsEntry) => void
  onBrowse?: () => void
}) {
  const t = useTranslations("dashboard.panels.files")
  const [open, setOpen] = React.useState(false)
  const [result, setResult] = React.useState<FsListResult | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [attempt, setAttempt] = React.useState(0)
  const root = filePathBreadcrumbParent(path)

  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setResult(null)
    setError(null)
    void loadDirectory(root).then((value) => {
      if (!cancelled) setResult(value)
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
    })
    return () => { cancelled = true }
  }, [open, root, loadDirectory, attempt])

  const select = (entry: FsEntry) => {
    setOpen(false)
    onSelect(entry)
  }

  return (
    <Popover open={open} onOpenChange={(nextOpen) => {
      if (nextOpen) onBrowse?.()
      setOpen(nextOpen)
    }}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn("aa-file-preview-breadcrumb-segment px-1", current && "current")}
          title={path}
          aria-current={current ? "location" : undefined}
        >
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" aria-label={path} className="w-80 max-w-[calc(100vw-2rem)] gap-1 p-1">
        <div className="max-h-[min(24rem,var(--radix-popover-content-available-height))] overflow-auto">
          <LazyFileTree
            identity={`${root}:${attempt}`}
            rootPath={result?.path ?? root}
            entries={result?.entries ?? []}
            rootLoading={!result && !error}
            rootError={error}
            rootTruncated={Boolean(result?.truncated)}
            canLoad
            ariaLabel={path}
            caseInsensitivePaths={caseInsensitivePaths}
            selectedPath={path}
            initialExpandedPaths={directory ? [path] : []}
            labels={{ empty: t("empty"), loading: t("loading"), noConnector: t("noConnector"), retry: t("retry"), truncated: t("truncated") }}
            loadDirectory={loadDirectory}
            onOpenFile={select}
          />
          {error ? <Button variant="ghost" size="sm" onClick={() => setAttempt((value) => value + 1)}>{t("retry")}</Button> : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
