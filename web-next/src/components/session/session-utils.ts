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
  const turnAnchors = new Map<string, number>()
  for (const item of items) {
    if (!item.turnId) continue
    const current = turnAnchors.get(item.turnId)
    const anchor = item.type === "turn.start" ? item.orderSeq : (current ?? item.orderSeq)
    turnAnchors.set(item.turnId, current === undefined ? anchor : Math.min(current, anchor))
  }
  return [...items].sort((a, b) => compareTimelineItems(a, b, turnAnchors))
}

export function compareTimelineItems(
  a: TimelineItem,
  b: TimelineItem,
  turnAnchors?: ReadonlyMap<string, number>,
): number {
  if (turnAnchors) {
    const aAnchor = a.turnId ? turnAnchors.get(a.turnId) : undefined
    const bAnchor = b.turnId ? turnAnchors.get(b.turnId) : undefined
    const blockOrder = (aAnchor ?? a.orderSeq) - (bAnchor ?? b.orderSeq)
    if (blockOrder !== 0) return blockOrder
    if (a.turnId && a.turnId === b.turnId) {
      const boundaryOrder = timelineBoundaryOrder(a) - timelineBoundaryOrder(b)
      if (boundaryOrder !== 0) return boundaryOrder
      const createdOrder = a.createdAt.localeCompare(b.createdAt)
      if (createdOrder !== 0) return createdOrder
    }
  }
  return a.orderSeq - b.orderSeq || a.updatedSeq - b.updatedSeq || a.id.localeCompare(b.id)
}

function timelineBoundaryOrder(item: TimelineItem): number {
  if (item.type === "turn.start") return -1
  if (item.type === "turn.end") return 1
  return 0
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
