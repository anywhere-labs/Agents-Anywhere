import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import vm from "node:vm"
import ts from "typescript"

const source = ts.transpileModule(
  readFileSync(new URL("../src/lib/session-title.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText
const context = vm.createContext({ exports: {} })
vm.runInContext(source, context)
const { sessionTitleFromPrompt, SESSION_TITLE_MAX_CHARS } = context.exports

test("session title keeps short prompts and collapses whitespace", () => {
  assert.equal(sessionTitleFromPrompt("Short title"), "Short title")
  assert.equal(sessionTitleFromPrompt("  fix   the\n\tlogin  bug  "), "fix the login bug")
})

test("session title is null for blank prompts", () => {
  assert.equal(sessionTitleFromPrompt(""), null)
  assert.equal(sessionTitleFromPrompt("   \n\t  "), null)
})

test("session title caps pasted documents like the server", () => {
  const pasted = "请帮我分析下面这份文档\n\n" + "这是一段很长的正文。".repeat(400)
  const collapsed = pasted.split(/\s+/).filter(Boolean).join(" ")
  const title = sessionTitleFromPrompt(pasted)
  assert.equal(SESSION_TITLE_MAX_CHARS, 48)
  assert.equal(title, `${collapsed.slice(0, 48).trimEnd()}...`)
  assert.ok(title.length <= 51)
})

test("session title matches the server when the cut lands on a space", () => {
  // The request sends the raw prompt; the server applies this same cap once.
  const prompt = `${"a".repeat(47)} ${"b".repeat(10)}`
  assert.equal(sessionTitleFromPrompt(prompt), `${"a".repeat(47)}...`)
})
