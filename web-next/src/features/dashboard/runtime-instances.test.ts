import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  availableRuntimeTypes,
  findCreatedRuntime,
  nextRuntimeInstanceName,
  recommendedRuntimeTypes,
  runtimeErrorMessage,
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

test("failed create refresh identifies the persisted instance by immutable ID", () => {
  const failed = findCreatedRuntime(
    new Set(["rti_existing"]),
    [
      {
        runtimeId: "rti_existing",
        runtimeType: "codex",
        name: "Existing",
        typeDisplayName: "Codex",
      },
      {
        runtimeId: "rti_failed",
        runtimeType: "codex",
        name: "Work Codex",
        typeDisplayName: "Codex",
      },
    ],
    "codex",
    "  work   codex  ",
  )

  assert.equal(failed?.runtimeId, "rti_failed")
})

test("runtime errors prefer direct and nested messages before codes", () => {
  assert.equal(runtimeErrorMessage({ code: "outer", message: "Direct failure" }), "Direct failure")
  assert.equal(
    runtimeErrorMessage({ code: "outer", detail: { error: { message: "Home is already in use" } } }),
    "Home is already in use",
  )
  assert.equal(runtimeErrorMessage({ code: "runtime_resource_conflict" }), "runtime_resource_conflict")
  assert.equal(runtimeErrorMessage({ detail: { code: "nested_failure" } }), "nested_failure")
})

test("runtime instance and Codex Home copy exists in English and Chinese", () => {
  for (const locale of ["en", "zh-CN"]) {
    const messages = JSON.parse(
      readFileSync(new URL(`../../../messages/${locale}.json`, import.meta.url), "utf8"),
    ) as {
      dashboard: {
        device: {
          [key: string]: unknown
          runtimeConfigFields: {
            codexHome?: { label?: string; description?: string }
          }
        }
      }
    }
    const codexHome = messages.dashboard.device.runtimeConfigFields.codexHome
    assert.ok(codexHome?.label)
    assert.ok(codexHome.description)
    for (const key of [
      "addedRuntimeInstances",
      "recommendedRuntimeTypes",
      "addCustomRuntime",
      "runtimeType",
      "runtimeInstanceName",
      "renameRuntime",
      "runtimeRenameFailed",
      "runtimeUnknownError",
    ]) {
      assert.equal(typeof messages.dashboard.device[key], "string", `${locale}: ${key}`)
    }
  }
})

test("device and pairing screens share runtime management and error UI", () => {
  const componentRoot = new URL("../../components/", import.meta.url)
  const devicePage = readFileSync(new URL("pages/device-page.tsx", componentRoot), "utf8")
  const pairingDialog = readFileSync(new URL("pair-device-dialog.tsx", componentRoot), "utf8")
  const manager = readFileSync(new URL("runtime-instance-manager.tsx", componentRoot), "utf8")

  assert.match(devicePage, /<RuntimeInstanceManager/)
  assert.match(pairingDialog, /<RuntimeInstanceManager/)
  assert.match(manager, /<RuntimeErrorBadge error=\{runtime\.error\}/)
  assert.ok((manager.match(/await fetchRuntimeData\(\)/g) ?? []).length >= 4)
})
