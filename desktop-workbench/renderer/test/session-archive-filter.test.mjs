import assert from "node:assert/strict"
import test from "node:test"
import { defaultFilter, filterSessions } from "../src/lib/demo-api.ts"

const sourceStates = ["available", "archived", "unavailable", "deleted", "missing"]
const session = (sourceAvailability, archived = false) => ({
  id: sourceAvailability,
  connectorId: "device",
  runtime: "codex",
  title: "Session",
  archived,
  sourceAvailability,
  userArchived: !archived,
  archiveSource: "both",
})

test("AA active sessions stay visible regardless of agent archive metadata", () => {
  const active = sourceStates.map((state) => session(state))
  assert.deepEqual(filterSessions(active, defaultFilter, "").map((item) => item.id), sourceStates)
  const archived = sourceStates.map((state) => session(state, true))
  assert.deepEqual(filterSessions(archived, defaultFilter, ""), [])
})

test("connector, runtime and title filters still apply to AA active sessions", () => {
  const active = [session("archived")]
  assert.equal(filterSessions(active, { ...defaultFilter, connectorId: "other" }, "").length, 0)
  assert.equal(filterSessions(active, { ...defaultFilter, runtime: "claude" }, "").length, 0)
  assert.equal(filterSessions(active, defaultFilter, "missing title").length, 0)
  assert.equal(filterSessions(active, defaultFilter, "session").length, 1)
})
