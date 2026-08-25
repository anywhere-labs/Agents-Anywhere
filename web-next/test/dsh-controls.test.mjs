import assert from "node:assert/strict"
import test from "node:test"

import {
  capabilityIsUsable,
  findCapability,
} from "../src/components/session/capabilities.ts"
import { modelCatalogDisplayName } from "../src/components/session/catalog-selection.ts"

test("capability lookup uses the current session runtime", () => {
  const capabilitySet = {
    revision: 1,
    capabilities: [
      {
        capabilityId: "catalog.permission",
        runtime: "codex",
        supported: false,
        available: true,
        allowed: true,
      },
      {
        capabilityId: "catalog.permission",
        runtime: "dsh",
        supported: true,
        available: true,
        allowed: true,
      },
    ],
  }

  assert.equal(findCapability(capabilitySet, "catalog.permission", "dsh")?.runtime, "dsh")
  assert.equal(capabilityIsUsable(capabilitySet, "catalog.permission", "dsh"), true)
})

test("DSH model variants label an empty reasoning effort as Default", () => {
  const defaultVariant = {
    id: "deepseek-default",
    displayName: "DeepSeek",
    selectionId: "dsh:model:default",
    default: true,
    description: null,
    reasoningItems: [],
    metadata: {
      provider: "deepseek",
      model: "deepseek-chat",
      reasoningEffort: null,
    },
  }
  const explicitVariant = {
    ...defaultVariant,
    id: "deepseek-high",
    selectionId: "dsh:model:high",
    default: false,
    metadata: {
      ...defaultVariant.metadata,
      reasoningEffort: "high",
    },
  }

  assert.equal(
    modelCatalogDisplayName(defaultVariant, [defaultVariant, explicitVariant], "DeepSeek", "Default"),
    "DeepSeek · Default",
  )
  assert.equal(
    modelCatalogDisplayName(defaultVariant, [defaultVariant], "DeepSeek", "Default"),
    "DeepSeek",
  )
})
