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

test("quick setup: the card shows choosing, progress or done", () => {
  const linked = { status: "linked" }
  assert.equal(presentation.quickSetupPhase({ link: null }, false, false), "setup")
  assert.equal(presentation.quickSetupPhase({ link: null }, false, true), "progress")
  assert.equal(presentation.quickSetupPhase({ link: linked, quickSetup: { state: "syncing" } }, false, false), "progress")
  assert.equal(presentation.quickSetupPhase({ link: linked, quickSetup: { state: "failed", step: "apply" } }, true, false), "progress")
  assert.equal(presentation.quickSetupPhase({ link: linked, quickSetup: { state: "done" } }, false, false), "done")
  assert.equal(presentation.quickSetupPhase({ link: linked }, true, false), "done")
  assert.equal(presentation.quickSetupPhase({ link: linked }, false, false), "done")
  // Changing models on a configured account keeps the account page in view.
  assert.equal(presentation.quickSetupPhase({ link: linked, quickSetup: { state: "applying" } }, true, false), "done")
  assert.equal(presentation.quickSetupPhase({ link: { status: "reauth_required" } }, true, false), "setup")
})

test("quick setup: each step reads from the link and its progress", () => {
  const linked = { status: "linked" }
  assert.deepEqual(presentation.quickSetupSteps({ link: null }, true), { authorize: "active", sync: "pending", apply: "pending" })
  assert.deepEqual(presentation.quickSetupSteps({ link: linked, quickSetup: { state: "syncing" } }, false), { authorize: "done", sync: "active", apply: "pending" })
  assert.deepEqual(presentation.quickSetupSteps({ link: linked, quickSetup: { state: "failed", step: "sync" } }, false), { authorize: "done", sync: "failed", apply: "pending" })
  assert.deepEqual(presentation.quickSetupSteps({ link: linked, quickSetup: { state: "applying" } }, false), { authorize: "done", sync: "done", apply: "active" })
})

test("quick setup: runtimes changing their own settings are not ticked by default", () => {
  const candidates = [
    { connectorId: "c", runtimeId: "codex", decision: "apply" },
    { connectorId: "c", runtimeId: "dsh", decision: "apply", requiresConfirmation: true },
    { connectorId: "d", runtimeId: "codex", decision: "skip", reason: "device_offline" },
  ]
  assert.deepEqual([...presentation.defaultQuickSelection(candidates)], ["c/codex"])
})

test("quick setup: a runtime served by a managed instance is not new", () => {
  const candidates = [
    { connectorId: "c", runtimeId: "codex", runtimeType: "codex", decision: "apply", effect: "restart" },
    { connectorId: "c", runtimeId: "pi", runtimeType: "pi", decision: "apply", effect: "new_instance" },
    { connectorId: "c", runtimeId: "claude", runtimeType: "claude", decision: "apply", effect: "restart" },
  ]
  const assigned = [
    { connectorId: "c", runtimeId: "codex" },
    { connectorId: "c", runtimeId: "pi-managed", runtimeType: "pi", createdRuntime: true },
  ]
  assert.deepEqual(presentation.newQuickCandidates(candidates, assigned).map((item) => item.runtimeId), ["claude"])
})
