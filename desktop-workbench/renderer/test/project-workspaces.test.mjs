import assert from "node:assert/strict"
import test from "node:test"
import { ApiError } from "../src/lib/api/errors.ts"
import { availableProjectName, findWorkspaceProject, resolveWorkspaceProject, workspaceName, workspacePathKey } from "../src/features/dashboard/project-workspaces.ts"

const project = (id, name, connectorId, workspacePath) => ({ id, name, connectorId, workspacePath })
const conflict = () => new ApiError({ status: 409, kind: "http", code: "project_name_conflict", detail: "Name already used" })

test("workspace matching follows device and canonical POSIX paths", () => {
  const projects = [project("a", "custom", "mac", "/Users/me/repo"), project("b", "custom2", "other", "/Users/me/repo")]
  assert.equal(findWorkspaceProject(projects, "mac", "/Users//me/./repo/")?.id, "a")
  assert.equal(findWorkspaceProject(projects, "other", "/Users/me/dir/../repo")?.id, "b")
  assert.equal(findWorkspaceProject(projects, "missing", "/Users/me/repo"), undefined)
  assert.equal(findWorkspaceProject(projects, "mac", "/users/me/repo"), undefined)
  assert.notEqual(workspacePathKey("/repo\\name"), workspacePathKey("/repo/name"))
})

test("Windows drive and UNC paths match separators, trailing slash and case", () => {
  const projects = [project("win", "work", "pc", "C:\\Users\\Me\\Repo"), project("unc", "shared", "pc", "\\\\server\\share\\repo")]
  assert.equal(findWorkspaceProject(projects, "pc", "c:/users/me/repo/", "windows")?.id, "win")
  assert.equal(findWorkspaceProject(projects, "pc", "//SERVER/share/REPO/", "windows")?.id, "unc")
  assert.equal(workspacePathKey("C:\\"), workspacePathKey("c:/"))
})

test("names derive from paths and avoid conflicts across devices without changing existing names", () => {
  assert.equal(workspaceName("/work/My App/"), "My App")
  assert.equal(workspaceName("C:\\work\\项目\\"), "项目")
  assert.equal(workspaceName("/"), "Workspace")
  assert.equal(workspaceName("C:\\"), "Workspace")
  assert.equal(workspaceName("\\\\server\\share\\"), "Workspace")
  assert.equal(workspaceName("/repo\\name"), "repo\\name")
  const projects = [project("one", "repo"), project("two", "repo (1)"), project("four", "repo (3)")]
  assert.equal(availableProjectName(" repo ", projects), "repo (2)")
  assert.equal(availableProjectName("repo", projects, "one"), "repo")
  assert.equal(projects[0].name, "repo")
  const long = "文".repeat(255)
  assert.equal(Array.from(availableProjectName(long, [project("long", long)])).length, 255)
  assert.ok(availableProjectName(long, [project("long", long)]).endsWith(" (1)"))
})

test("directory mode reuses an existing project without invoking a write", async () => {
  const existing = project("chosen", "User chosen name", "mac", "/work/repo")
  const resolved = await resolveWorkspaceProject({ projects: [existing], connectorId: "mac", path: "/work/repo/", list: () => assert.fail("already known"), create: () => assert.fail("must not create or rename") })
  assert.equal(resolved, existing)
})

test("a fresh project list reuses a workspace created by another client", async () => {
  const existing = project("chosen", "User chosen name", "mac", "/work/repo")
  const resolved = await resolveWorkspaceProject({ projects: [], connectorId: "mac", path: "/work/repo/", list: async () => [existing], create: () => assert.fail("must not create or rename") })
  assert.equal(resolved, existing)
})

test("a new directory uses existing list/create operations with a unique name and returns the actual project", async () => {
  let request
  const actual = project("server-id", "repo (2)", "mac", "/work/repo")
  const fresh = [project("other-device", "repo", "pc", "/work/repo"), project("other-path", "repo (1)", "mac", "/other")]
  const resolved = await resolveWorkspaceProject({ projects: [], connectorId: "mac", path: " /work/repo/ ", list: async () => fresh, create: async payload => { request = payload; return actual } })
  assert.deepEqual(request, { name: "repo (2)", connectorId: "mac", workspacePath: "/work/repo/", manuallyCreated: false })
  assert.equal(resolved, actual)
})

test("a concurrent workspace creation is reused after a conflict", async () => {
  const existing = project("concurrent", "Custom name", "pc", "C:\\work\\Repo")
  let reads = 0, writes = 0
  const resolved = await resolveWorkspaceProject({
    projects: [], connectorId: "pc", path: "c:/work/repo/", deviceOs: "windows",
    list: async () => ++reads === 1 ? [] : [existing],
    create: async () => { writes++; throw conflict() },
  })
  assert.equal(resolved, existing)
  assert.equal(writes, 1)
})

test("a concurrent name collision refreshes names before retrying creation", async () => {
  const taken = project("taken", "repo", "pc", "/other")
  const actual = project("created", "repo (1)", "mac", "/work/repo")
  let reads = 0
  const requests = []
  const resolved = await resolveWorkspaceProject({
    projects: [], connectorId: "mac", path: "/work/repo",
    list: async () => ++reads === 1 ? [] : [taken],
    create: async payload => { requests.push(payload); if (requests.length === 1) throw conflict(); return actual },
  })
  assert.deepEqual(requests.map(payload => payload.name), ["repo", "repo (1)"])
  assert.ok(requests.every(payload => payload.manuallyCreated === false))
  assert.equal(resolved, actual)
})

test("repeated conflicts stop after three creation attempts", async () => {
  let reads = 0, writes = 0
  const failure = conflict()
  await assert.rejects(resolveWorkspaceProject({
    projects: [], connectorId: "mac", path: "/repo",
    list: async () => { reads++; return [] },
    create: async () => { writes++; throw failure },
  }), error => error === failure)
  assert.equal(reads, 3)
  assert.equal(writes, 3)
})

test("failed resolution propagates to the composer instead of inventing a project", async () => {
  for (const failure of [new Error("offline"), new ApiError({ status: 403, kind: "forbidden", detail: "Forbidden" }), new ApiError({ status: 409, kind: "http", code: "other_conflict", detail: "Conflict" })]) {
    let writes = 0
    await assert.rejects(resolveWorkspaceProject({ projects: [], connectorId: "mac", path: "/repo", list: async () => [], create: async () => { writes++; throw failure } }), error => error === failure)
    assert.equal(writes, 1)
  }
})

test("a failed lookup or invalid workspace never creates a project", async () => {
  const failure = new Error("offline")
  await assert.rejects(resolveWorkspaceProject({ projects: [], connectorId: "mac", path: "/repo", list: async () => { throw failure }, create: () => assert.fail("lookup failed") }), error => error === failure)
  for (const selection of [{ connectorId: "mac", path: " " }, { connectorId: "", path: "/repo" }]) {
    await assert.rejects(resolveWorkspaceProject({ projects: [], ...selection, list: () => assert.fail("invalid workspace"), create: () => assert.fail("invalid workspace") }))
  }
})
