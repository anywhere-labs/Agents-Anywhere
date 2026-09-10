import type { TimelineItem } from "@/features/dashboard/types"

const CLAUDE_INTERRUPTED_REQUEST_MARKERS = new Set([
  "[Request interrupted by user]",
  "[Request interrupted by user for tool use]",
])
const CLAUDE_NO_RESPONSE_MARKER = "No response requested."

export function messageText(item: TimelineItem): string {
  return (
    textOf(item.content.text) ||
    textOf(item.content.content) ||
    textOf(item.content.message) ||
    textOf(item.content.rawText) ||
    ""
  )
}

export function isVisibleTimelineItem(item: TimelineItem): boolean {
  if (item.type !== "message" || textOf(item.source.runtime) !== "claude") return true
  const text = messageText(item).trim()
  if (item.role === "user" && CLAUDE_INTERRUPTED_REQUEST_MARKERS.has(text)) return false
  return !(item.role === "assistant" && text === CLAUDE_NO_RESPONSE_MARKER)
}

export function runtimeLabel(runtime: string): string {
  if (runtime === "codex") return "Codex"
  if (runtime === "claude") return "Claude Code"
  if (runtime === "dsh") return "DeepSeek Harness"
  if (runtime === "opencode") return "OpenCode"
  return runtime.slice(0, 1).toUpperCase() + runtime.slice(1)
}

export function sortTimelineItems(items: TimelineItem[]): TimelineItem[] {
  return [...items].sort(compareTimelineItems)
}

export function compareTimelineItems(
  a: TimelineItem,
  b: TimelineItem,
): number {
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
