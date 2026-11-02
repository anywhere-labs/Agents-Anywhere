import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { registerSource } from "./helpers/onboarding-source.mjs"

const hooks = registerSource()
const presentation = await import("../src/features/model-config/presentation.ts")
hooks.deregister()

const messages = (locale) => JSON.parse(readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), "utf8"))

function keys(value, prefix = "") {
  if (!value || typeof value !== "object") return [prefix]
  return Object.entries(value).flatMap(([key, item]) => keys(item, prefix ? `${prefix}.${key}` : key))
}

test("model config: stable runtimes carry no maturity badge", () => {
  assert.equal(presentation.maturityBadge("stable"), null)
  assert.equal(presentation.maturityBadge(undefined), null)
  assert.equal(presentation.maturityBadge("beta"), "beta")
  assert.equal(presentation.maturityBadge("experimental"), "experimental")
})

test("model config: saved and applied read differently", () => {
  assert.equal(presentation.connectionStateTone("applied"), "ok")
  assert.equal(presentation.connectionStateTone("saved_pending"), "progress")
  assert.equal(presentation.connectionStateTone("failed"), "error")
  assert.equal(presentation.connectionStateTone("managed_externally"), "warning")
  assert.equal(presentation.assignmentStatusTone("outdated"), "warning")
})

test("model config: only runtimes that declare a connection are listed", () => {
  const runtimes = [
    { runtimeId: "codex", modelConnection: { protocols: ["openai_responses"] } },
    { runtimeId: "other", modelConnection: null },
    { runtimeId: "pi-managed", modelConnection: { protocols: ["openai_chat"] }, managedBy: "model-config" },
  ]
  assert.deepEqual(presentation.modelConfigurableRuntimes(runtimes).map((item) => item.runtimeId), ["codex", "pi-managed"])
})

test("model config: model IDs parse from lines or commas without duplicates", () => {
  assert.deepEqual(presentation.parseModelIds("gpt-5\n deepseek-v3, gpt-5\n\n"), ["gpt-5", "deepseek-v3"])
})

test("model config: both languages carry the same strings", () => {
  const zh = messages("zh-CN")
  const en = messages("en")
  for (const path of [["pages", "settings", "modelConfigs"], ["runtimeMaturity"]]) {
    const pick = (root) => path.reduce((value, key) => value[key], root)
    assert.deepEqual(keys(pick(zh)).sort(), keys(pick(en)).sort())
  }
  assert.equal(typeof zh.pages.settings.modelConfigsTitle, "string")
  assert.equal(zh.dashboard.device.showModelGatewayApiKey, undefined)
})
