import assert from "node:assert/strict"
import test from "node:test"
import { availableProjectName, findWorkspaceProject, resolveWorkspaceProject, workspaceName, workspacePathKey } from "../src/features/dashboard/project-workspaces.ts"

const project = (id, name, connectorId, workspacePath) => ({ id, name, connectorId, workspacePath })

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
  const resolved = await resolveWorkspaceProject({ projects: [existing], connectorId: "mac", path: "/work/repo/", resolve: () => assert.fail("must not create or rename") })
  assert.equal(resolved, existing)
})

test("a new directory resolves through the server and returns its actual ID and canonical path", async () => {
  let request
  const actual = project("server-id", "repo (2)", "mac", "/work/repo")
  const resolved = await resolveWorkspaceProject({ projects: [], connectorId: "mac", path: " /work/repo/ ", resolve: async payload => { request = payload; return actual } })
  assert.deepEqual(request, { connectorId: "mac", workspacePath: "/work/repo/" })
  assert.equal(resolved, actual)
})

test("failed resolution propagates to the composer instead of inventing a project", async () => {
  const failure = new Error("offline")
  await assert.rejects(resolveWorkspaceProject({ projects: [], connectorId: "mac", path: "/repo", resolve: async () => { throw failure } }), error => error === failure)
  await assert.rejects(resolveWorkspaceProject({ projects: [], connectorId: "mac", path: " ", resolve: () => assert.fail("invalid path") }))
})
