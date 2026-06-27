import type { TimelineItem } from "@/features/dashboard/types"

export function messageText(item: TimelineItem): string {
  return (
    textOf(item.content.text) ||
    textOf(item.content.content) ||
    textOf(item.content.message) ||
    textOf(item.content.rawText) ||
    ""
  )
}

export function runtimeLabel(runtime: string): string {
  return runtime.slice(0, 1).toUpperCase() + runtime.slice(1)
}

export function sortTimelineItems(items: TimelineItem[]): TimelineItem[] {
  return [...items].sort(compareTimelineItems)
}

export function compareTimelineItems(a: TimelineItem, b: TimelineItem): number {
  return a.orderSeq - b.orderSeq || a.updatedSeq - b.updatedSeq || a.id.localeCompare(b.id)
}

export function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

export function firstTextOf(...values: unknown[]): string | null {
  for (const value of values) {
    const text = textOf(value)
    if (text) return text
  }
  return null
}

export function commandText(value: unknown): string | null {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map((part) => String(part)).join(" ")
  return null
}

export function stringSetting(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export function recordsOf(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
}
