import assert from "node:assert/strict"
import test from "node:test"
import { sortProjectsBySessionActivity } from "../src/components/sidebar/project-list-order.ts"
import { projectHasVisibleSessions } from "../src/components/sidebar/project-visibility.ts"
import { createProjectSidebarPreferenceStore, projectSidebarPreferenceKey } from "../src/components/sidebar/project-sidebar-preferences.ts"

const time = hour => `2026-09-06T${String(hour).padStart(2, "0")}:00:00Z`
const project = (id, activity, overrides = {}) => ({
  id, name: id, lastActivityAt: activity, createdAt: time(1), activeSessionCount: activity ? 1 : 0,
  sidebarSessionCounts: { active: activity ? 1 : 0, archived: 0 },
  manuallyCreated: true, pinned: false, pinnedAt: null, ...overrides,
})
const ids = projects => projects.map(project => project.id)
const memoryStorage = () => {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } }
}

test("project order uses the newest session across all pages, not project creation or pin time", () => {
  const projects = [
    project("new-project", time(5), { createdAt: time(9), pinnedAt: time(11), pinned: true }),
    project("recent-session", time(10), { createdAt: time(2), pinnedAt: time(3), pinned: true }),
  ]
  assert.deepEqual(ids(sortProjectsBySessionActivity(projects)), ["recent-session", "new-project"])
  assert.deepEqual(ids(projects), ["new-project", "recent-session"])
})

test("truly empty projects stay first; archived or unloaded sessions do not make a project empty", () => {
  const projects = [
    project("active", time(10)),
    project("archived-only", time(5), { activeSessionCount: 0, sidebarSessionCounts: { active: 0, archived: 2 } }),
    project("empty-older", null),
    project("empty-newer", null, { createdAt: time(2) }),
  ]
  assert.deepEqual(ids(sortProjectsBySessionActivity(projects)), ["empty-newer", "empty-older", "active", "archived-only"])
  const legacy = project("unloaded", null, { activeSessionCount: 3 })
  const archived = project("archived", null, { sidebarSessionCounts: { active: 0, archived: 1 } })
  assert.deepEqual(ids(sortProjectsBySessionActivity([legacy, archived, projects[2]])), ["empty-older", "archived", "unloaded"])
})

test("a new loaded session updates order before the server project aggregate catches up", () => {
  const projects = [project("first", time(10)), project("updated", time(5)), project("was-empty", null)]
  const sessions = [
    { projectId: "updated", sortAt: time(11), lastActivityAt: time(8) },
    { projectId: "was-empty", lastActivityAt: time(9) },
    { projectId: null, sortAt: time(23) },
  ]
  assert.deepEqual(ids(sortProjectsBySessionActivity(projects, sessions)), ["updated", "first", "was-empty"])
  assert.deepEqual(ids(sortProjectsBySessionActivity(projects.slice(0, 2), [{ projectId: "first", sortAt: time(3) }])), ["first", "updated"])
})

test("empty priority follows the existing Web manual-project exception without revealing hidden projects", () => {
  const projects = [
    project("automatic-empty", null, { manuallyCreated: false }),
    project("manual-empty", null),
    project("recent", time(10)),
    project("archived-automatic", time(5), { manuallyCreated: false, activeSessionCount: 0, sidebarSessionCounts: { active: 0, archived: 2 } }),
  ]
  const sessions = [{ projectId: "archived-automatic", archived: true, pinned: false }]
  const visible = status => projects.filter(item => projectHasVisibleSessions(item, sessions, status))
  assert.deepEqual(ids(sortProjectsBySessionActivity(visible("active"))), ["manual-empty", "recent"])
  assert.deepEqual(ids(sortProjectsBySessionActivity(visible("all"))), ["manual-empty", "recent", "archived-automatic"])
  assert.deepEqual(ids(sortProjectsBySessionActivity([projects[0], projects[2], projects[1]])), ["manual-empty", "recent", "automatic-empty"])
})

test("equal or invalid activity timestamps keep a deterministic project order", () => {
  const projects = [project("b", "invalid"), project("a", "invalid"), project("latest", time(10))]
  assert.deepEqual(ids(sortProjectsBySessionActivity(projects)), ["latest", "a", "b"])
  assert.deepEqual(ids(sortProjectsBySessionActivity([project("b", time(1), { name: "same" }), project("a", time(1), { name: "same" })])), ["a", "b"])
})

test("project and section expansion survive a new sidebar store without writing default state", () => {
  const storage = memoryStorage()
  const key = projectSidebarPreferenceKey("server", "user")
  const first = createProjectSidebarPreferenceStore(storage, key)
  assert.equal(storage.getItem(key), null)
  first.setProjectExpanded("one", true)
  first.setProjectExpanded("two", true)
  first.setProjectExpanded("one", false)
  first.setProjectsExpanded(false)
  const restored = createProjectSidebarPreferenceStore(storage, key)
  assert.deepEqual(restored.getSnapshot(), { projectsExpanded: false, expandedProjectIds: ["two"] })
  assert.deepEqual(restored.getServerSnapshot(), { projectsExpanded: true, expandedProjectIds: [] })
  assert.equal(restored.getSnapshot(), restored.getSnapshot())
})

test("project expansion is isolated by server and account", () => {
  const storage = memoryStorage()
  const create = (server, user) => createProjectSidebarPreferenceStore(storage, projectSidebarPreferenceKey(server, user))
  create("server-a", "user-a").setProjectExpanded("same-project", true)
  assert.deepEqual(create("server-a", "user-b").getSnapshot().expandedProjectIds, [])
  assert.deepEqual(create("server-b", "user-a").getSnapshot().expandedProjectIds, [])
  assert.deepEqual(create("server-a", "user-a").getSnapshot().expandedProjectIds, ["same-project"])
})

test("corrupt or unavailable browser storage keeps expansion usable headlessly", () => {
  const storage = memoryStorage()
  storage.setItem("key", "invalid")
  assert.deepEqual(createProjectSidebarPreferenceStore(storage, "key").getSnapshot().expandedProjectIds, [])
  storage.setItem("key", JSON.stringify({ projectsExpanded: false, expandedProjectIds: ["one", 3, null, "", "one"], accessToken: "unused" }))
  const store = createProjectSidebarPreferenceStore(storage, "key")
  assert.deepEqual(store.getSnapshot(), { projectsExpanded: false, expandedProjectIds: ["one"] })
  for (const storage of [null, { getItem() { throw new Error("blocked") }, setItem() { throw new Error("blocked") } }]) {
    const fallback = createProjectSidebarPreferenceStore(storage, "key")
    fallback.setProjectExpanded("one", true)
    fallback.setProjectsExpanded(false)
    assert.deepEqual(fallback.getSnapshot(), { projectsExpanded: false, expandedProjectIds: ["one"] })
  }
})

test("storage refresh updates subscribers and repeated toggles do not duplicate expanded IDs", () => {
  const storage = memoryStorage()
  const store = createProjectSidebarPreferenceStore(storage, "key")
  let updates = 0
  const unsubscribe = store.subscribe(() => { updates++ })
  store.setProjectExpanded("one", true)
  store.setProjectExpanded("one", true)
  assert.equal(updates, 1)
  storage.setItem("key", JSON.stringify({ projectsExpanded: true, expandedProjectIds: ["other"] }))
  store.refresh()
  assert.deepEqual(store.getSnapshot().expandedProjectIds, ["other"])
  assert.equal(updates, 2)
  unsubscribe()
  store.setProjectsExpanded(false)
  assert.equal(updates, 2)
})
