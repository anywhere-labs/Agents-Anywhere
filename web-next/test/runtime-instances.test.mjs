import assert from "node:assert/strict"
import test from "node:test"

import {
  catalogItemDisabledReason,
  catalogItemEnabled,
  modelIdsForSelectionId,
  permissionIdForSelectionId,
  selectionIdForModelCatalog,
  selectionIdForPermissionCatalog,
} from "../src/components/session/catalog-selection.ts"
import { findCapability } from "../src/components/session/capabilities.ts"
import {
  addableRuntimeTypes,
  configuredRuntimeInstances,
  mergeRuntimeTypes,
  namedInstanceRequiredConfigFields,
  reconfigurableRuntimeInstance,
  runtimeConfigDraft,
  runtimeCreationDefaults,
  runtimeInstanceName,
  runtimeTypeCanCreateInstance,
  sessionRuntimeId,
  sessionRuntimeName,
  sessionRuntimeRequestIdentity,
  sessionRuntimeType,
} from "../src/features/dashboard/runtime-instances.ts"

const legacyRuntime = {
  connectorId: "connector-1",
  runtimeId: "dsh",
  runtimeType: "dsh",
  displayName: "DeepSeek Harness",
  present: true,
  configured: false,
  active: false,
  status: "available",
  discovery: { available: true },
  metadata: { storageMode: "dsh-native" },
  schema: { type: "object" },
  uiSchema: {},
  config: null,
  error: null,
  lastDiscoveredAt: "2026-08-25T00:00:00Z",
  updatedAt: "2026-08-25T00:00:00Z",
}

test("runtime identity keeps provider type separate from a named instance", () => {
  assert.deepEqual(sessionRuntimeRequestIdentity("codex", "rti_work"), {
    runtime: "codex",
    runtimeId: "rti_work",
  })
  assert.deepEqual(sessionRuntimeRequestIdentity("codex", "codex"), { runtime: "codex" })
  assert.equal(sessionRuntimeType({ runtime: "codex", runtimeId: "rti_work" }), "codex")
  assert.equal(sessionRuntimeId({ runtime: "codex", runtimeId: "rti_work" }), "rti_work")
  assert.equal(sessionRuntimeName({ runtime: "codex", runtimeId: "rti_work" }), "rti_work")
  assert.equal(runtimeInstanceName({ ...legacyRuntime, name: "Work" }), "Work")
})

test("an unavailable provider can still create an instance for custom configuration", () => {
  const [runtimeType] = mergeRuntimeTypes([], [{
    ...legacyRuntime,
    runtimeId: "claude",
    runtimeType: "claude",
    displayName: "Claude Code",
    present: true,
    discovery: { available: false },
  }])
  assert.equal(runtimeType.available, false)
  assert.equal(runtimeTypeCanCreateInstance(runtimeType, []), true)
})

test("an unconfigured compatibility instance is offered as addable without displaying it", () => {
  const [runtimeType] = mergeRuntimeTypes([], [legacyRuntime])
  assert.equal(runtimeType.runtimeType, "dsh")
  assert.equal(runtimeType.instancePolicy, "single")
  assert.equal(runtimeType.metadata.storageMode, "dsh-native")
  assert.equal(runtimeTypeCanCreateInstance(runtimeType, [legacyRuntime]), true)
  assert.deepEqual(configuredRuntimeInstances([legacyRuntime]), [])
  assert.equal(reconfigurableRuntimeInstance(runtimeType, [legacyRuntime]), legacyRuntime)
  assert.deepEqual(addableRuntimeTypes([runtimeType], [legacyRuntime]), [runtimeType])
})

test("configured instances and addable types are mutually scoped", () => {
  const configured = { ...legacyRuntime, configured: true, config: {} }
  const [runtimeType] = mergeRuntimeTypes([], [configured])

  assert.deepEqual(configuredRuntimeInstances([configured]), [configured])
  assert.equal(runtimeTypeCanCreateInstance(runtimeType, [configured]), false)
  assert.deepEqual(addableRuntimeTypes([runtimeType], [configured]), [])
})

test("instance availability follows the runtime descriptor policy", () => {
  const [baseType] = mergeRuntimeTypes([], [legacyRuntime])
  const singleType = {
    ...baseType,
    runtimeType: "example",
    displayName: "Example",
    instancePolicy: "single",
    maxInstances: 1,
  }
  const configured = {
    ...legacyRuntime,
    runtimeId: "rti_example",
    runtimeType: "example",
    configured: true,
    config: {},
  }

  assert.equal(runtimeTypeCanCreateInstance(singleType, []), true)
  assert.equal(runtimeTypeCanCreateInstance(singleType, [configured]), false)
})

test("creation defaults and required fields come only from the descriptor", () => {
  const [baseType] = mergeRuntimeTypes([], [legacyRuntime])
  const codexType = {
    ...baseType,
    runtimeType: "codex",
    displayName: "Codex",
    defaults: { useSystemCodex: true },
    schema: {
      type: "object",
      properties: {
        codexHome: { type: "string" },
        modelGateway: { type: "object" },
      },
    },
    uiSchema: {},
  }

  assert.deepEqual(runtimeCreationDefaults(codexType), { useSystemCodex: true })
  assert.deepEqual(namedInstanceRequiredConfigFields(codexType), [])

  const declared = {
    ...codexType,
    uiSchema: { requiredForNamedInstance: ["codexHome", "modelGateway", "codexHome", "missing"] },
  }
  assert.deepEqual(namedInstanceRequiredConfigFields(declared), ["codexHome", "modelGateway"])
})

test("an unconfigured named instance gets descriptor defaults when resumed", () => {
  const [baseType] = mergeRuntimeTypes([], [legacyRuntime])
  const runtimeType = {
    ...baseType,
    runtimeType: "example",
    displayName: "Example",
    defaults: { workspace: "default" },
  }
  const pendingRuntime = {
    ...legacyRuntime,
    runtimeId: "rti_example_2",
    runtimeType: "example",
    name: "Example 2",
    displayName: "Example 2",
    configured: false,
    config: null,
  }

  assert.deepEqual(runtimeConfigDraft(runtimeType, pendingRuntime), { workspace: "default" })
})

test("a runtime type without a configuration schema is not addable", () => {
  const [runtimeType] = mergeRuntimeTypes([], [legacyRuntime])
  const withoutSchema = { ...runtimeType, schema: null }

  assert.equal(runtimeTypeCanCreateInstance(withoutSchema, []), false)
})

test("capability lookup prefers instance scope and falls back to provider scope", () => {
  const capabilities = {
    revision: 1,
    capabilities: [
      { capabilityId: "catalog.model", runtime: "codex", supported: true },
      {
        capabilityId: "catalog.model",
        runtime: "codex",
        runtimeId: "rti_work",
        supported: false,
      },
    ],
  }
  assert.equal(
    findCapability(capabilities, "catalog.model", {
      runtimeId: "rti_work",
      runtimeType: "codex",
    })?.supported,
    false,
  )
  assert.equal(
    findCapability(capabilities, "catalog.model", {
      runtimeId: "rti_other",
      runtimeType: "codex",
    })?.supported,
    true,
  )
})

test("disabled catalog values never resolve to submission selections", () => {
  const disabledPermission = {
    id: "custom",
    displayName: "Custom",
    selectionId: "permission:custom",
    enabled: false,
    disabledReason: "Not available for this instance",
    metadata: {},
  }
  const metadataDisabledPermission = {
    ...disabledPermission,
    id: "metadata-disabled",
    selectionId: "permission:metadata-disabled",
    enabled: undefined,
    disabledReason: undefined,
    metadata: { enabled: false, disabledReason: "Policy" },
  }
  const permissionCatalog = {
    runtime: "dsh",
    revision: 1,
    permissions: [disabledPermission, metadataDisabledPermission],
  }
  assert.equal(catalogItemEnabled(disabledPermission), false)
  assert.equal(catalogItemEnabled(metadataDisabledPermission), false)
  assert.equal(catalogItemDisabledReason(metadataDisabledPermission), "Policy")
  assert.equal(selectionIdForPermissionCatalog(permissionCatalog, "custom"), null)
  assert.equal(permissionIdForSelectionId(permissionCatalog, "permission:custom"), "")

  const modelCatalog = {
    runtime: "codex",
    revision: 1,
    models: [{
      id: "model",
      displayName: "Model",
      default: true,
      enabled: true,
      selectionId: null,
      metadata: {},
      reasoningItems: [{
        id: "high",
        displayName: "High",
        default: true,
        enabled: false,
        selectionId: "model:high",
        metadata: {},
      }],
    }],
  }
  assert.equal(selectionIdForModelCatalog(modelCatalog, "model", "high"), null)
  assert.equal(modelIdsForSelectionId(modelCatalog, "model:high"), null)
})
