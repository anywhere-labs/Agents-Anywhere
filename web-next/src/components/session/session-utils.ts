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

/** True when the latest user turn already has non-empty assistant text (TTFB landed). */
export function hasAssistantTextAfterLatestUser(items: TimelineItem[]): boolean {
  let lastUserIdx = -1
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item?.type === "message" && item.role === "user") {
      lastUserIdx = i
      break
    }
  }
  const start = lastUserIdx < 0 ? 0 : lastUserIdx + 1
  for (let i = start; i < items.length; i += 1) {
    const item = items[i]
    if (item?.type === "message" && item.role === "assistant" && messageText(item).trim()) {
      return true
    }
  }
  return false
}

export function runtimeLabel(runtime: string): string {
  switch (runtime) {
    case "codex":
      return "Codex"
    case "claude":
      return "Claude"
    case "gemini":
      return "Gemini CLI"
    case "grok_build":
      return "Grok Build"
    case "cursor":
      return "Cursor"
    case "codebuddy":
      return "CodeBuddy"
    case "opencode":
      return "OpenCode"
    default:
      return runtime.slice(0, 1).toUpperCase() + runtime.slice(1)
  }
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
