import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, existsSync } from "node:fs"
import { registerHooks } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import { resolve, dirname } from "node:path"
import ts from "typescript"

// Resolve the same source aliases as the app and transpile TypeScript for the
// headless Node runner, including constructor parameter properties in ApiClient.
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url))
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : ""
    if (specifier.startsWith("@/") || (parent.startsWith(sourceRoot) && specifier.startsWith("."))) {
      const base = specifier.startsWith("@/") ? resolve(sourceRoot, specifier.slice(2)) : resolve(dirname(parent), specifier)
      const found = [base, `${base}.ts`, `${base}/index.ts`].find((path) => existsSync(path) && path.endsWith(".ts"))
      if (found) return { url: pathToFileURL(found).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(pathToFileURL(sourceRoot).href) && url.endsWith(".ts")) {
      return { format: "module", shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText }
    }
    return nextLoad(url, context)
  },
})
const { AuthApi } = await import("../src/features/auth/api.ts")
const { ApiClient } = await import("../src/lib/api/client.ts")
const { accountDisplayName, isValidEmail, isValidDisplayName } = await import("../src/features/auth/account-profile.ts")
hooks.deregister()

function fixture() {
  const requests = []
  const api = new AuthApi(new ApiClient({ fetcher: async (url, options) => {
    requests.push({ path: new URL(url, "https://example.test").pathname, body: JSON.parse(options.body), authorization: options.headers.get("authorization") })
    return new Response(JSON.stringify(String(url).endsWith("/password-salt") ? { salt: "test-salt" } : { userId: "stable-id", email: "member@example.com", displayName: "Member" }), { headers: { "content-type": "application/json" } })
  } }))
  return { api, requests }
}

test("email login normalizes identity and sends only a derived password verifier", async () => {
  const { api, requests } = fixture()
  await api.login({ email: " Member@Example.COM ", password: "test password" })
  assert.deepEqual(requests[0].body, { email: "member@example.com" })
  assert.equal(requests[1].path, "/api/v2/auth/login")
  assert.deepEqual(Object.keys(requests[1].body).sort(), ["email", "passwordVerifier"])
  assert.equal(requests[1].body.email, "member@example.com")
  assert.match(requests[1].body.passwordVerifier, /^[\w-]{43}$/)
  assert.equal(requests[1].authorization, null)
})

test("registration carries display name and verification code without a username", async () => {
  const { api, requests } = fixture()
  await api.register({ email: " Member@Example.com ", displayName: "  小明  ", passwordVerifier: "verifier", passwordSalt: "salt", code: "012345", setupToken: "setup" })
  assert.deepEqual(requests[0].body, { email: "member@example.com", displayName: "小明", passwordVerifier: "verifier", passwordSalt: "salt", code: "012345", setupToken: "setup" })
})

test("email binding and profile changes keep authenticated stable account identity", async () => {
  const { api, requests } = fixture()
  await api.sendEmailCode(" NEW@Example.com ", "bind", "session")
  await api.updateEmail("session", " NEW@Example.com ", "012345")
  await api.updateProfile("session", "  New name  ")
  assert.deepEqual(requests.map((item) => item.authorization), ["Bearer session", "Bearer session", "Bearer session"])
  assert.deepEqual(requests.map((item) => item.body), [{ email: "new@example.com", purpose: "bind" }, { email: "new@example.com", code: "012345" }, { displayName: "New name" }])
})

test("admin creation sends required email code and uses stable IDs for later updates", async () => {
  const { api, requests } = fixture()
  await api.createUser("admin", { email: " Member@Example.com ", displayName: " Member ", code: "123456", role: "member", passwordVerifier: "verifier", passwordSalt: "salt" })
  assert.deepEqual(requests[0].body, { email: "member@example.com", displayName: "Member", code: "123456", role: "member", passwordVerifier: "verifier", passwordSalt: "salt" })
  await api.updateUser("admin", "stable/id", { displayName: " Updated " })
  assert.equal(requests[1].path, "/api/v2/admin/users/stable%2Fid")
  assert.deepEqual(requests[1].body, { displayName: "Updated" })
})

test("OAuth linking derives the password with email; OAuth signup preserves its pending token for codes", async () => {
  const { api, requests } = fixture()
  await api.finalizeOAuth({ pendingToken: "pending", email: " Member@Example.com ", password: "password" })
  assert.deepEqual(requests[0].body, { email: "member@example.com" })
  assert.equal(requests[1].body.email, "member@example.com")
  assert.equal(requests[1].body.password, undefined)
  assert.equal(requests[1].body.userId, undefined)
  await api.sendEmailCode("member@example.com", "register", undefined, "pending")
  assert.deepEqual(requests[2].body, { email: "member@example.com", purpose: "register", pendingToken: "pending" })
})

test("display name validation allows Unicode and spaces; email and display identity stay separate", () => {
  assert.equal(isValidDisplayName("  小明  "), true)
  assert.equal(isValidDisplayName(" "), false)
  assert.equal(isValidDisplayName("a".repeat(65)), false)
  assert.equal(isValidEmail("a+b@example.com"), true)
  assert.equal(isValidEmail("old_username"), false)
  assert.equal(isValidEmail("name@ example.com"), false)
  assert.equal(accountDisplayName({ displayName: "同名用户", email: "one@example.com", userId: "internal" }), "同名用户")
  assert.equal(accountDisplayName({ displayName: "", email: "one@example.com", userId: "internal" }), "one@example.com")
  assert.equal(accountDisplayName({ userId: "old_username" }), "—")
})

test("email-code authentication failures are propagated without retrying anonymously", async () => {
  const requests = []
  const api = new AuthApi(new ApiClient({ fetcher: async (url, options) => {
    requests.push({ url, authorization: options.headers.get("authorization") })
    return new Response(JSON.stringify({ detail: "Authentication required" }), { status: 401, headers: { "content-type": "application/json" } })
  } }))
  await assert.rejects(api.sendEmailCode("new@example.com", "bind", "expired-session"), (error) => error.status === 401 && error.message.includes("Authentication required"))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].authorization, "Bearer expired-session")
})

test("bootstrap email-code requests carry the setup token", async () => {
  const { api, requests } = fixture()
  await api.sendEmailCode(" ADMIN@Example.com ", "register", undefined, undefined, "setup-token")
  assert.deepEqual(requests[0].body, { email: "admin@example.com", purpose: "register", setupToken: "setup-token" })
  assert.equal(requests[0].authorization, null)
})
