import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { IntlMessageFormat } from "intl-messageformat"

// Rich-text tags the UI renders with t.rich; any other <word> must be quoted ('<task>').
const RICH_TAGS = new Set(["here", "beta"])

function* messages(value, path = []) {
  if (typeof value === "string") yield [path.join("."), value]
  else for (const [key, child] of Object.entries(value)) yield* messages(child, [...path, key])
}

for (const locale of ["en", "zh-CN"]) {
  test(`messages: every ${locale} message parses as ICU and uses only known rich tags`, () => {
    const catalog = JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"))
    const failures = []
    for (const [key, text] of messages(catalog)) {
      try {
        const format = new IntlMessageFormat(text, locale)
        const tags = []
        const walk = nodes => { for (const node of nodes) { if (node.type === 8) { tags.push(node.value); walk(node.children) } } }
        walk(format.getAst())
        for (const tag of tags) if (!RICH_TAGS.has(tag)) failures.push(`${key}: unexpected tag <${tag}>`)
      } catch (error) { failures.push(`${key}: ${error.message}`) }
    }
    assert.deepEqual(failures, [])
  })
}

test("messages: the /plan description renders its literal placeholder", () => {
  const en = JSON.parse(readFileSync(new URL("../messages/en.json", import.meta.url), "utf8"))
  assert.match(new IntlMessageFormat(en.planning.commandDescription, "en").format(), /\/plan <task> drafts/)
})
