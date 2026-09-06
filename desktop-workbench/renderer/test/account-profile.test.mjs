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
const { normalizeAuthMe, normalizeDesktopOAuthMe } = await import("../src/features/auth/normalize-me.ts")
hooks.deregister()

const account = {
  userId: "stable-account-id",
  email: "member@example.com",
  displayName: "小明",
  emailVerified: true,
  role: "member",
  disabled: false,
  avatar: null,
  serverTime: "2026-09-06T00:00:00Z",
}

for (const wrapped of [false, true]) {
  test(`Desktop login and account refresh retain nickname and email (wrapped response: ${wrapped})`, () => {
    const payload = wrapped ? { user: account, serverTime: account.serverTime } : account
    assert.deepEqual(normalizeDesktopOAuthMe(payload), account)
    assert.deepEqual(normalizeAuthMe(payload, { userId: "fallback-id", role: "admin" }), account)
    assert.equal(accountDisplayName(normalizeAuthMe(payload, account)), "小明")
  })
}

test("missing profile fields stay editable without exposing the internal account ID as a nickname", () => {
  const normalized = normalizeAuthMe({ emailVerified: "true" }, account)
  assert.equal(normalized.userId, account.userId)
  assert.equal(normalized.role, account.role)
  assert.equal(normalized.displayName, "")
  assert.equal(normalized.email, null)
  assert.equal(normalized.emailVerified, false)
  assert.equal(accountDisplayName(normalized), "—")
  assert.equal(accountDisplayName({ ...normalized, email: account.email }), account.email)
})

test("Desktop OAuth still rejects accounts without a stable ID or valid role", () => {
  for (const payload of [null, { ...account, userId: " " }, { ...account, role: "unknown" }]) {
    assert.throws(() => normalizeDesktopOAuthMe(payload), /invalid account/)
  }
})

test("profile saves, email verification and subsequent refresh use the same account", async () => {
  const requests = []
  let savedAccount = { ...account }
  const api = new AuthApi(new ApiClient({ fetcher: async (url, options) => {
    const path = new URL(url, "https://example.test").pathname
    const body = options.body ? JSON.parse(options.body) : undefined
    requests.push({ path, method: options.method, body, authorization: options.headers.get("authorization") })
    if (path === "/api/v2/auth/config") return Response.json({ emailVerificationRequired: true })
    if (path === "/api/v2/auth/email-code") return Response.json({ retryAfter: 60, expiresIn: 600 })
    if (path === "/api/v2/auth/me/profile") savedAccount = { ...savedAccount, displayName: body.displayName }
    if (path === "/api/v2/auth/me/email") savedAccount = { ...savedAccount, email: body.email }
    return Response.json(savedAccount)
  } }))

  assert.equal((await api.config()).emailVerificationRequired, true)
  assert.equal((await api.updateProfile("session", "  新昵称  ")).displayName, "新昵称")
  assert.equal((await api.sendEmailCode(" NEW@Example.com ", "bind", "session")).retryAfter, 60)
  assert.equal((await api.updateEmail("session", " NEW@Example.com ", "012345")).email, "new@example.com")
  const refreshed = normalizeAuthMe(await api.me("session"), account)
  assert.deepEqual(refreshed, { ...account, displayName: "新昵称", email: "new@example.com" })
  assert.equal(accountDisplayName(refreshed), "新昵称")
  assert.deepEqual(requests, [
    { path: "/api/v2/auth/config", method: "GET", body: undefined, authorization: null },
    { path: "/api/v2/auth/me/profile", method: "PUT", body: { displayName: "新昵称" }, authorization: "Bearer session" },
    { path: "/api/v2/auth/email-code", method: "POST", body: { email: "new@example.com", purpose: "bind" }, authorization: "Bearer session" },
    { path: "/api/v2/auth/me/email", method: "PUT", body: { email: "new@example.com", code: "012345" }, authorization: "Bearer session" },
    { path: "/api/v2/auth/me", method: "GET", body: undefined, authorization: "Bearer session" },
  ])
})

test("email changes also support servers with verification disabled", async () => {
  let sentBody
  const api = new AuthApi(new ApiClient({ fetcher: async (_url, options) => {
    sentBody = JSON.parse(options.body)
    return Response.json(account)
  } }))
  await api.updateEmail("session", " MEMBER@Example.com ")
  assert.deepEqual(sentBody, { email: "member@example.com" })
})

test("email-code authentication failures propagate without anonymous retries", async () => {
  const requests = []
  const api = new AuthApi(new ApiClient({ fetcher: async (_url, options) => {
    requests.push(options.headers.get("authorization"))
    return Response.json({ detail: "Authentication required" }, { status: 401 })
  } }))
  await assert.rejects(api.sendEmailCode("new@example.com", "bind", "expired-session"), (error) => error.status === 401)
  assert.deepEqual(requests, ["Bearer expired-session"])
})

test("Desktop uses the Web nickname and email validation rules", () => {
  assert.equal(isValidDisplayName("  小明  "), true)
  assert.equal(isValidDisplayName(" "), false)
  assert.equal(isValidDisplayName("a".repeat(64)), true)
  assert.equal(isValidDisplayName("a".repeat(65)), false)
  assert.equal(isValidEmail("a+b@example.com"), true)
  assert.equal(isValidEmail("old_username"), false)
  assert.equal(isValidEmail("name@ example.com"), false)
})
