import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("../src/components/settings/archived-sessions-tab.tsx", import.meta.url),
  "utf8",
)

// Web now shares one session inventory with every project view, so the archived
// tab filters the sessions it is handed instead of paging a project on its own.
test("project archive filtering reads the shared inventory instead of per-project pages", () => {
  assert.match(source, /sessions: WorkspaceSessionView\[\]/)
  assert.match(source, /const projectId = projectIdFromFilter\(projectFilter\)/)
  assert.doesNotMatch(source, /listProjectSessions/)
})

test("the archived tab no longer fences in-flight project pages", () => {
  assert.doesNotMatch(source, /loadMoreRequestIdRef/)
  assert.doesNotMatch(source, /projectFilterRef/)
})
