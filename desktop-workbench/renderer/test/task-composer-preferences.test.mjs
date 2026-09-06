import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  availableNewSessionSelectionPreference,
  newSessionSelectionScope,
  preferredAvailableOptionId,
  withNewSessionSelectionPreference,
} from "../src/features/dashboard/new-session-preferences.ts"
import {
  modelIdsForSelectionId,
  permissionIdForSelectionId,
} from "../src/components/session/catalog-selection.ts"

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

test("new session preference survives disconnect and restores every available selection", () => {
  const deviceOptions = [{ id: "device-fallback" }, { id: "device-preferred" }]
  const agentOptions = [{ id: "agent-fallback" }, { id: "agent-preferred" }]
  const models = [
    {
      id: "model-fallback",
      displayName: "Fallback",
      default: true,
      enabled: true,
      selectionId: "model:fallback",
      metadata: {},
      reasoningItems: [],
    },
    {
      id: "model-preferred",
      displayName: "Preferred",
      default: false,
      enabled: true,
      selectionId: null,
      metadata: {},
      reasoningItems: [{
        id: "reasoning-preferred",
        displayName: "Preferred reasoning",
        default: false,
        enabled: true,
        selectionId: "model:preferred:reasoning",
        metadata: {},
      }],
    },
  ]
  const permissions = [
    {
      id: "permission-fallback",
      displayName: "Fallback",
      default: true,
      enabled: true,
      selectionId: "permission:fallback",
      metadata: {},
    },
    {
      id: "permission-preferred",
      displayName: "Preferred",
      default: false,
      enabled: true,
      selectionId: "permission:preferred",
      metadata: {},
    },
  ]
  const modelCatalog = { runtime: "example", revision: 1, models }
  const permissionCatalog = { runtime: "example", revision: 1, permissions }
  const modelOptions = models.map((model) => ({
    id: model.id,
    enabled: model.enabled,
    reasoningItems: model.reasoningItems.map((reasoning) => ({
      id: reasoning.id,
      enabled: reasoning.enabled,
    })),
  }))
  const permissionOptions = permissions.map((permission) => ({
    id: permission.id,
    enabled: permission.enabled,
  }))

  const preference = withNewSessionSelectionPreference(
    null,
    "device-preferred",
    "agent-preferred",
    {
      model: "model:preferred:reasoning",
      permission: "permission:preferred",
    },
  )
  const storedPreference = structuredClone(preference)
  const scope = newSessionSelectionScope(preference.connectorId, preference.agent)
  const selectionPreference = preference.selections[scope]

  let selectedDevice = preferredAvailableOptionId(deviceOptions, "", preference.connectorId)
  let selectedAgent = preferredAvailableOptionId(agentOptions, "", preference.agent)
  let selectedCatalog = availableNewSessionSelectionPreference(
    modelOptions,
    permissionOptions,
    modelIdsForSelectionId(modelCatalog, selectionPreference.model),
    permissionIdForSelectionId(permissionCatalog, selectionPreference.permission),
  )
  assert.equal(selectedDevice, "device-preferred")
  assert.equal(selectedAgent, "agent-preferred")
  assert.deepEqual(selectedCatalog, {
    model: { modelId: "model-preferred", reasoningId: "reasoning-preferred" },
    permissionId: "permission-preferred",
  })

  selectedDevice = preferredAvailableOptionId([], selectedDevice, preference.connectorId)
  selectedAgent = preferredAvailableOptionId([], selectedAgent, preference.agent)
  selectedCatalog = availableNewSessionSelectionPreference([], [], null, "")
  assert.equal(selectedDevice, "")
  assert.equal(selectedAgent, "")
  assert.deepEqual(selectedCatalog, { model: null, permissionId: null })
  assert.deepEqual(preference, storedPreference)

  selectedDevice = preferredAvailableOptionId(deviceOptions, selectedDevice, preference.connectorId)
  selectedAgent = preferredAvailableOptionId(agentOptions, selectedAgent, preference.agent)
  selectedCatalog = availableNewSessionSelectionPreference(
    modelOptions,
    permissionOptions,
    modelIdsForSelectionId(modelCatalog, selectionPreference.model),
    permissionIdForSelectionId(permissionCatalog, selectionPreference.permission),
  )
  assert.equal(selectedDevice, "device-preferred")
  assert.equal(selectedAgent, "agent-preferred")
  assert.deepEqual(selectedCatalog, {
    model: { modelId: "model-preferred", reasoningId: "reasoning-preferred" },
    permissionId: "permission-preferred",
  })

  const updatedPreference = withNewSessionSelectionPreference(
    preference,
    "device-fallback",
    "agent-fallback",
    { model: "model:fallback", permission: "permission:fallback" },
  )
  const updatedScope = newSessionSelectionScope(updatedPreference.connectorId, updatedPreference.agent)
  const updatedSelection = updatedPreference.selections[updatedScope]
  assert.equal(preferredAvailableOptionId(deviceOptions, selectedDevice, updatedPreference.connectorId), "device-fallback")
  assert.equal(preferredAvailableOptionId(agentOptions, selectedAgent, updatedPreference.agent), "agent-fallback")
  assert.deepEqual(
    availableNewSessionSelectionPreference(
      modelOptions,
      permissionOptions,
      modelIdsForSelectionId(modelCatalog, updatedSelection.model),
      permissionIdForSelectionId(permissionCatalog, updatedSelection.permission),
    ),
    {
      model: { modelId: "model-fallback", reasoningId: "" },
      permissionId: "permission-fallback",
    },
  )

  assert.equal(source.match(/preferredAvailableOptionId\(/g)?.length, 2)
  assert.equal(source.match(/availableNewSessionSelectionPreference\(/g)?.length, 1)
})

test("catalog preferences are reapplied whenever the selected scope reloads", () => {
  assert.doesNotMatch(source, /devicePreferenceAppliedRef/)
  assert.doesNotMatch(source, /agentPreferenceAppliedForDeviceRef/)
  assert.doesNotMatch(source, /selectionPreferenceAppliedForScopeRef/)

  const selectionRestore = sourceBetween(
    "const scope = newSessionSelectionScope(selectedConnectorId, selectedAgent)",
    "const selectedPermissionOption",
  )
  assert.match(selectionRestore, /availableNewSessionSelectionPreference\(/)
  assert.match(selectionRestore, /modelIdsForSelectionId\(modelCatalog, selectionPreference\.model\)/)
  assert.match(selectionRestore, /permissionIdForSelectionId\(permissionCatalog, selectionPreference\.permission\)/)
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
