"use client"

import { EmptyState } from "@/components/console/page-header"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

export interface DataColumn<T> {
  id: string
  header: React.ReactNode
  cell: (row: T) => React.ReactNode
  /** Applied to the header and every cell of the column. */
  className?: string
}

function defaultFormatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A list as a table, with its loading, error and empty states. Columns
 * render their own cells; the table keeps no data of its own.
 */
export function DataTable<T>({
  rows,
  columns,
  rowId,
  pending,
  error,
  formatError = defaultFormatError,
  empty,
  onRowClick,
  rowClassName,
  className,
}: {
  rows: readonly T[]
  columns: readonly DataColumn<T>[]
  rowId: (row: T) => string | number
  pending?: boolean
  error?: unknown
  formatError?: (error: unknown) => string
  /** Shown when there are no rows; see `EmptyState`. */
  empty: React.ComponentProps<typeof EmptyState>
  /** Opens a row, e.g. its details; buttons inside cells stop the click. */
  onRowClick?: (row: T) => void
  rowClassName?: (row: T) => string | undefined
  className?: string
}) {
  if (pending) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full rounded-2xl" />
        ))}
      </div>
    )
  }
  if (error) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        {formatError(error)}
      </p>
    )
  }
  if (rows.length === 0) return <EmptyState {...empty} />

  return (
    <Table className={className}>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead key={column.id} className={column.className}>
              {column.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={rowId(row)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={cn("h-14", onRowClick && "cursor-pointer", rowClassName?.(row))}
          >
            {columns.map((column) => (
              <TableCell key={column.id} className={column.className}>
                {column.cell(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
