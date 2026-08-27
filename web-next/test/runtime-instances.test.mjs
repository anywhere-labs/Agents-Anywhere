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
  isAdditionalCodexRuntimeType,
  mergeRuntimeTypes,
  reconfigurableRuntimeInstance,
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

test("only an additional configured Codex instance gets the multi-instance label", () => {
  const [baseType] = mergeRuntimeTypes([], [legacyRuntime])
  const codexType = {
    ...baseType,
    runtimeType: "codex",
    displayName: "Codex",
    instancePolicy: "multiple",
    maxInstances: null,
  }
  const configuredCodex = {
    ...legacyRuntime,
    runtimeId: "rti_codex",
    runtimeType: "codex",
    configured: true,
    config: {},
  }

  assert.equal(isAdditionalCodexRuntimeType(codexType, []), false)
  assert.equal(isAdditionalCodexRuntimeType(codexType, [configuredCodex]), true)
  assert.equal(
    isAdditionalCodexRuntimeType(codexType, [{ ...configuredCodex, configured: false }]),
    false,
  )
  assert.equal(
    isAdditionalCodexRuntimeType({ ...codexType, runtimeType: "claude" }, [configuredCodex]),
    false,
  )
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
