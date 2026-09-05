import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  availableNewSessionSelectionPreference,
  newSessionSelectionScope,
  preferredAvailableOptionId,
  withNewSessionSelectionPreference,
} from "../src/features/dashboard/new-session-preferences.ts"

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

test("new session preference survives disconnect and restores available choices", () => {
  const preference = withNewSessionSelectionPreference(
    null,
    "device-preferred",
    "agent-preferred",
    { model: "model-preferred", permission: "permission-preferred" },
  )
  const scope = newSessionSelectionScope(preference.connectorId, preference.agent)

  assert.equal(
    preferredAvailableOptionId(
      [{ id: "device-fallback" }, { id: "device-preferred" }],
      "",
      preference.connectorId,
    ),
    "device-preferred",
  )
  assert.equal(preferredAvailableOptionId([], "device-preferred", preference.connectorId), "")
  assert.deepEqual(
    availableNewSessionSelectionPreference(
      [{ id: "model-preferred", enabled: true, reasoningItems: [] }],
      [{ id: "permission-preferred", enabled: true }],
      { modelId: "model-preferred", reasoningId: "" },
      preference.selections[scope].permission,
    ),
    {
      model: { modelId: "model-preferred", reasoningId: "" },
      permissionId: "permission-preferred",
    },
  )
})

test("device, agent, permission, model, and reasoning changes persist immediately", () => {
  assert.match(source, /const preferenceRef = React\.useRef<NewSessionPreference \| null>\(null\)/)
  assert.doesNotMatch(source, /devicePreferenceAppliedRef/)
  assert.doesNotMatch(source, /agentPreferenceAppliedForDeviceRef/)
  assert.doesNotMatch(source, /selectionPreferenceAppliedForScopeRef/)

  const persist = sourceBetween("const persistPreference", "React.useEffect(() => {")
  assert.match(persist, /preferenceRef\.current = next/)
  assert.match(persist, /writeNewSessionPreference\(next\)/)

  const handlers = sourceBetween("const handleDeviceChange", "const requiresModelSelection")
  assert.match(handlers, /const handleDeviceChange/)
  assert.match(handlers, /const handleAgentChange/)
  assert.match(handlers, /const handlePermissionChange/)
  assert.match(handlers, /const handleModelChange/)
  assert.equal(handlers.match(/persistTargetPreference\(/g)?.length, 4)

  assert.match(source, /onDeviceChange=\{handleDeviceChange\}/)
  assert.match(source, /onAgentChange=\{handleAgentChange\}/)
  assert.match(source, /onPrimaryChange=\{handleDeviceChange\}/)
  assert.match(source, /onSecondaryChange=\{handleAgentChange\}/)
  assert.match(source, /onPermissionChange=\{handlePermissionChange\}/)
  assert.match(source, /onModelChange=\{handleModelChange\}/)
})

test("catalog reload reapplies stored model and permission selections", () => {
  const restore = sourceBetween(
    "const scope = newSessionSelectionScope(selectedConnectorId, selectedAgent)",
    "const selectedPermissionOption",
  )
  assert.match(restore, /availableNewSessionSelectionPreference\(/)
  assert.match(restore, /setSelectedModel\(availablePreference\.model\.modelId\)/)
  assert.match(restore, /setSelectedPermissionMode\(availablePreference\.permissionId\)/)

  const create = sourceBetween("const handleCreate", "return (\n")
  assert.match(create, /withNewSessionSelectionPreference\(\s*preferenceRef\.current/)
  assert.match(create, /persistPreference\(nextPreference\)/)
})
