import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  availableRuntimeTypes,
  nextRuntimeInstanceName,
  recommendedRuntimeTypes,
  runtimeInstanceOptions,
} from "./runtime-instances"

const runtimeTypes = [
  {
    runtimeType: "custom-acp",
    displayName: "Custom ACP",
    available: true,
    recommended: false,
    recommendationRank: null,
  },
  {
    runtimeType: "claude",
    displayName: "Claude",
    available: true,
    recommended: true,
    recommendationRank: 20,
  },
  {
    runtimeType: "codex",
    displayName: "Codex",
    available: true,
    recommended: true,
    recommendationRank: 10,
  },
  {
    runtimeType: "missing",
    displayName: "Missing",
    available: false,
    recommended: true,
    recommendationRank: 0,
  },
]

test("recommended and custom add flows use available type descriptors", () => {
  assert.deepEqual(
    recommendedRuntimeTypes(runtimeTypes).map((runtimeType) => runtimeType.runtimeType),
    ["codex", "claude"],
  )
  assert.deepEqual(
    availableRuntimeTypes(runtimeTypes).map((runtimeType) => runtimeType.runtimeType),
    ["codex", "claude", "custom-acp"],
  )
})

test("instances of one type remain distinct and composer options use runtime IDs", () => {
  const instances = [
    {
      runtimeId: "rti_work",
      runtimeType: "codex",
      name: "Work Codex",
      typeDisplayName: "Codex",
    },
    {
      runtimeId: "rti_personal",
      runtimeType: "codex",
      name: "Personal Codex",
      typeDisplayName: "Codex",
    },
  ]

  assert.deepEqual(runtimeInstanceOptions(instances), [
    { id: "rti_personal", label: "Personal Codex", description: "Codex" },
    { id: "rti_work", label: "Work Codex", description: "Codex" },
  ])
  assert.equal(nextRuntimeInstanceName("Codex", [{ ...instances[0]!, name: "Codex" }]), "Codex 2")
})

test("Codex Home copy exists in English and Chinese", () => {
  for (const locale of ["en", "zh-CN"]) {
    const messages = JSON.parse(
      readFileSync(new URL(`../../../messages/${locale}.json`, import.meta.url), "utf8"),
    ) as {
      dashboard: {
        device: {
          runtimeConfigFields: {
            codexHome?: { label?: string; description?: string }
          }
        }
      }
    }
    const codexHome = messages.dashboard.device.runtimeConfigFields.codexHome
    assert.ok(codexHome?.label)
    assert.ok(codexHome.description)
  }
})
