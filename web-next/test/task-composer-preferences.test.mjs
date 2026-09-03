import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("../src/components/task-composer.tsx", import.meta.url),
  "utf8",
)

function sourceBetween(start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`)
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

test("new session selections persist through one immediate preference path", () => {
  assert.match(source, /const preferenceRef = React\.useRef<NewSessionPreference \| null>\(null\)/)

  const persist = sourceBetween(
    "const persistPreference",
    "React.useEffect(() => {",
  )
  assert.match(persist, /preferenceRef\.current = next/)
  assert.match(persist, /writeNewSessionPreference\(next\)/)

  const targetPersistence = sourceBetween(
    "const persistTargetPreference",
    "React.useEffect(() => {",
  )
  assert.match(targetPersistence, /withNewSessionSelectionPreference\(/)
  assert.match(targetPersistence, /persistPreference\(/)
  assert.match(targetPersistence, /selection\.model !== undefined/)
  assert.match(targetPersistence, /selection\.permission !== undefined/)
})

test("device, agent, permission, model, and reasoning changes use immediate persistence", () => {
  const handlers = sourceBetween(
    "const handleDeviceChange",
    "const requiresModelSelection",
  )
  assert.match(handlers, /const handleDeviceChange/)
  assert.match(handlers, /const handleAgentChange/)
  assert.match(handlers, /const handlePermissionChange/)
  assert.match(handlers, /const handleModelChange/)
  assert.equal(handlers.match(/persistTargetPreference\(/g)?.length, 4)
  assert.match(handlers, /setSelectedReasoning\(reasoning\)/)
  assert.match(handlers, /model: selectionIdForModelCatalog\(/)
  assert.match(handlers, /permission: selectionIdForPermissionCatalog\(/)

  assert.match(source, /onDeviceChange=\{handleDeviceChange\}/)
  assert.match(source, /onAgentChange=\{handleAgentChange\}/)
  assert.match(source, /onPrimaryChange=\{handleDeviceChange\}/)
  assert.match(source, /onSecondaryChange=\{handleAgentChange\}/)
  assert.match(source, /onPermissionChange=\{handlePermissionChange\}/)
  assert.match(source, /onModelChange=\{handleModelChange\}/)
  assert.match(source, /onSelect=\{\(\) => handlePermissionChange\(item\.id\)\}/)
  assert.match(source, /handleModelChange\(modelItem\.id, ""\)/)
  assert.match(source, /handleModelChange\(modelItem\.id, item\.id\)/)
})

test("session creation retains preference persistence as a final fallback", () => {
  const create = sourceBetween("const handleCreate", "return (\n")
  assert.match(create, /withNewSessionSelectionPreference\(\s*preferenceRef\.current/)
  assert.match(create, /persistPreference\(nextPreference\)/)
  assert.doesNotMatch(create, /writeNewSessionPreference\(nextPreference\)/)
})
