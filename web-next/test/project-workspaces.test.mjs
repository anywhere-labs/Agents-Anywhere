import assert from "node:assert/strict"
import test from "node:test"
import { ApiError } from "../src/lib/api/errors.ts"
import { projectWorkspacePath, resolveWorkspaceProject, workspaceName, workspacePathKey } from "../src/features/dashboard/project-workspaces.ts"

const project = (id, connectorId = "mac", runtimeId = "rti_work", workspacePath = "/work/repo") => ({
  id, name: "repo", connectorId, runtimeId, runtime: "codex", workspacePath, sourceState: "active",
})
const resolve = options => resolveWorkspaceProject({
  projects: [], connectorId: "mac", path: "/work/repo", runtime: "codex", runtimeId: "rti_work",
  requestId: "stable-request", translate: key => key, create: () => assert.fail("unexpected write"), ...options,
})

test("canonical POSIX paths preserve case and literal backslashes", () => {
  assert.equal(workspacePathKey("/Users//me/./repo/"), "/Users/me/repo")
  assert.equal(workspacePathKey("/Users/me/dir/../repo"), "/Users/me/repo")
  assert.notEqual(workspacePathKey("/Users/me/repo"), workspacePathKey("/users/me/repo"))
  assert.notEqual(workspacePathKey("/repo\\name"), workspacePathKey("/repo/name"))
})

test("Windows drive and UNC keys normalize separators, trailing slash and case", () => {
  assert.equal(workspacePathKey("C:\\Users\\Me\\Repo"), workspacePathKey("c:/users/me/repo/", "windows"))
  assert.equal(workspacePathKey("\\\\server\\share\\repo"), workspacePathKey("//SERVER/share/REPO/", "windows"))
  assert.equal(workspacePathKey("C:\\"), workspacePathKey("c:/"))
})

test("suggested names derive from paths without enforcing global name uniqueness", () => {
  assert.equal(workspaceName("/work/My App/"), "My App")
  assert.equal(workspaceName("C:\\work\\项目\\"), "项目")
  for (const path of ["/", "C:\\", "\\\\server\\share\\"]) assert.equal(workspaceName(path), "Workspace")
  assert.equal(workspaceName("/repo\\name"), "repo\\name")
})

test("explicit identity selects the exact project even when roots and names coincide", async () => {
  const selected = project("chosen")
  assert.equal(await resolve({ projects: [project("other"), selected], projectId: "chosen" }), selected)
})

test("explicit selection cannot cross device or Runtime instance or select inactive sources", async () => {
  for (const selected of [project("chosen", "other"), project("chosen", "mac", "rti_other"), { ...project("chosen"), sourceState: "historical" }]) {
    await assert.rejects(resolve({ projects: [selected], projectId: "chosen" }), /projectUnavailable/)
  }
})

test("directory collisions require explicit selection and never silently merge identities", async () => {
  for (const projects of [[project("one")], [project("one"), project("two")]]) {
    await assert.rejects(resolve({ projects, path: "/work//repo/" }), /explicitSelectionRequired/)
  }
})

test("another device or instance does not prevent same-name same-path creation", async () => {
  let request
  const actual = project("created")
  const resolved = await resolve({ projects: [project("other-device", "pc"), project("other-instance", "mac", "rti_other")],
    create: async payload => { request = payload; return actual },
  })
  assert.deepEqual(request, { name: "repo", connectorId: "mac", workspacePath: "/work/repo", runtime: "codex", runtimeId: "rti_work", requestId: "stable-request" })
  assert.equal(resolved, actual)
})

test("creation errors propagate without retrying under a new identity", async () => {
  for (const failure of [new Error("offline"), new ApiError({ status: 403, kind: "forbidden", detail: "Forbidden" }), new ApiError({ status: 409, kind: "http", detail: "Conflict" })]) {
    let writes = 0
    await assert.rejects(resolve({ create: async () => { writes++; throw failure } }), error => error === failure)
    assert.equal(writes, 1)
  }
})

test("missing Runtime scope fails before any write", async () => {
  for (const scope of [{ runtime: undefined }, { runtimeId: undefined }]) await assert.rejects(resolve(scope), /runtimeRequired/)
})

test("workspace defaults prefer a healthy root and preserve a valid explicit root", () => {
  const selected = { ...project("multi"), workspacePath: "/unknown", roots: ["/unknown", "/ok", "/second"], rootStates: { "/unknown": "unknown", "/ok": "present", "/second": "present" } }
  assert.equal(projectWorkspacePath(selected), "/ok")
  assert.equal(projectWorkspacePath(selected, "/second/"), "/second/")
  assert.equal(projectWorkspacePath(selected, "/unrelated"), "/ok")
})
