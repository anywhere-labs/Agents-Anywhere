import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("../src/components/settings/archived-sessions-tab.tsx", import.meta.url),
  "utf8",
)

test("project archive filtering loads the selected project's own pages", () => {
  assert.match(source, /const projectId = projectIdFromFilter\(projectFilter\)/)
  assert.match(
    source,
    /dashboardApi\.listProjectSessions\(token, projectId, \{ archived: true, limit: 100 \}\)/,
  )
  assert.match(
    source,
    /dashboardApi\.listProjectSessions\(token, selectedProjectId, \{[\s\S]*?cursor: nextCursor/,
  )
})

test("changing the project filter fences in-flight archive pages", () => {
  assert.match(source, /const loadMoreRequestIdRef = React\.useRef\(0\)/)
  assert.match(source, /const projectFilterRef = React\.useRef\(projectFilter\)/)
  assert.match(source, /requestId !== loadMoreRequestIdRef\.current/)
  assert.match(source, /projectFilterRef\.current !== filterAtRequestStart/)
})
