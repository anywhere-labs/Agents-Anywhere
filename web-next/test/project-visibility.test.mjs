import assert from "node:assert/strict"
import test from "node:test"
import {
  projectHasVisibleSessions,
  projectSessionMatchesStatus,
} from "../src/components/sidebar/project-visibility.ts"

const statuses = ["active", "archived", "all"]
const project = (active = 0, archived = 0, manuallyCreated = false) => ({
  id: "project",
  manuallyCreated,
  sidebarSessionCounts: { active, archived },
})

test("manual projects stay visible in every filter, including when empty", () => {
  for (const status of statuses) {
    assert.equal(projectHasVisibleSessions(project(0, 0, true), [], status), true)
    assert.equal(projectHasVisibleSessions(project(), [], status), false)
  }
})

test("automatic project visibility follows the selected session status", () => {
  assert.deepEqual(statuses.map((status) => projectHasVisibleSessions(project(2, 0), [], status)), [true, false, true])
  assert.deepEqual(statuses.map((status) => projectHasVisibleSessions(project(0, 3), [], status)), [false, true, true])
  assert.deepEqual(statuses.map((status) => projectHasVisibleSessions(project(2, 3), [], status)), [true, true, true])
})

test("server counts keep projects with unloaded history visible", () => {
  assert.equal(projectHasVisibleSessions(project(105, 0), [], "active"), true)
  const staleSession = { projectId: "project", archived: false, pinned: false }
  assert.equal(projectHasVisibleSessions(project(), [staleSession], "active"), false)
})

test("only rows actually shown inside projects count, including the pinned exception", () => {
  const oldServerProject = { id: "project" }
  const pinned = { projectId: "project", archived: false, pinned: true }
  assert.deepEqual(statuses.map((status) => projectHasVisibleSessions(oldServerProject, [pinned], status)), [false, false, false])
  const archived = { ...pinned, archived: true }
  assert.deepEqual(statuses.map((status) => projectHasVisibleSessions(oldServerProject, [archived], status)), [false, true, true])
  assert.equal(projectSessionMatchesStatus({ archived: false, pinned: false }, "active"), true)
  assert.equal(projectHasVisibleSessions(oldServerProject, [{ ...archived, projectId: "other" }], "archived"), false)
})

test("archiving a manual project removes its empty-project exception", () => {
  const before = project(0, 0, true)
  const after = { ...before, manuallyCreated: false }
  assert.equal(projectHasVisibleSessions(before, [], "active"), true)
  assert.equal(projectHasVisibleSessions(after, [], "active"), false)
  assert.equal(projectHasVisibleSessions(project(0, 4), [], "archived"), true)
})
