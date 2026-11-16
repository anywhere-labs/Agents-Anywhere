import assert from "node:assert/strict"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"

registerSource()
const { sessionWorkState } = await import("../src/components/sidebar/session-work-state.ts")

test("the session list shows plan review first, then the goal state", () => {
  assert.equal(sessionWorkState({ planState: "awaiting_review", goalState: "active" }), "planReview")
  assert.equal(sessionWorkState({ planState: "planning", goalState: "paused" }), "goalPaused")
  assert.equal(sessionWorkState({ planState: "none", goalState: "active" }), "goalActive")
  assert.equal(sessionWorkState({ planState: "none", goalState: "completed" }), null)
  assert.equal(sessionWorkState({}), null)
})
