"use client"

import { ChevronLeft, ChevronRight } from "lucide-react"

import { Button } from "@/components/ui/button"

export interface PaginationLabels {
  previous?: string
  next?: string
  formatPage?: (info: { page: number; pageCount: number; total: number; showTotal: boolean }) => string
}

function defaultFormatPage({
  page,
  pageCount,
  total,
  showTotal,
}: {
  page: number
  pageCount: number
  total: number
  showTotal: boolean
}) {
  return showTotal
    ? `Page ${page} of ${pageCount} · ${total} records`
    : `Page ${page} of ${pageCount}`
}

/** Previous and next page controls under a table. */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  showTotal = false,
  labels,
}: {
  page: number
  pageSize: number
  total: number
  onPageChange: (page: number) => void
  showTotal?: boolean
  labels?: PaginationLabels
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  if (total === 0 || (pageCount <= 1 && !showTotal)) return null
  const formatPage = labels?.formatPage ?? defaultFormatPage

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 text-sm text-muted-foreground">
      <span>{formatPage({ page, pageCount, total, showTotal })}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={labels?.previous ?? "Previous page"}
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        <ChevronLeft />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={labels?.next ?? "Next page"}
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        <ChevronRight />
      </Button>
    </div>
  )
}
