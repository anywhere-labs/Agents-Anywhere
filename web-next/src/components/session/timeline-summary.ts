import type { TimelineItem } from "@/features/dashboard/types"

export type TimelineRunCounts = {
  reasoning: number
  tools: number
}

export function timelineRunCounts(items: readonly TimelineItem[]): TimelineRunCounts {
  let reasoning = 0
  let tools = 0

  for (const item of items) {
    const kind = typeof item.content.kind === "string" ? item.content.kind : ""
    if (item.type === "system" && kind === "reasoning") {
      reasoning += 1
      continue
    }
    if (item.type === "tool" || (item.type === "artifact" && kind === "file_change")) {
      tools += 1
    }
  }

  return { reasoning, tools }
}
