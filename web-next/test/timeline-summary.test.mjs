import assert from "node:assert/strict"
import test from "node:test"

import { timelineRunCounts } from "../src/components/session/timeline-summary.ts"

function item(id, type, kind) {
  return { id, type, content: { kind } }
}

test("timeline run summary counts every semantic tool kind", () => {
  const items = [
    item("reasoning-1", "system", "reasoning"),
    item("reasoning-2", "system", "reasoning"),
    item("command", "tool", "command"),
    item("file-change", "tool", "file_change"),
    item("mcp", "tool", "mcp"),
    item("web-search", "tool", "web_search"),
    item("input-request", "tool", "input_request"),
    item("generic", "tool", "tool_call"),
    item("orphan", "tool", "tool_result"),
    item("agent-call", "tool", "agent_call"),
    item("history-file-change", "artifact", "file_change"),
    item("diff", "artifact", "diff"),
  ]

  assert.deepEqual(timelineRunCounts(items), { reasoning: 2, tools: 9 })
})
