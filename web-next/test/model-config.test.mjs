import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { registerSource } from "./helpers/onboarding-source.mjs"

const hooks = registerSource()
const presentation = await import("../src/features/model-config/presentation.ts")
const channel = await import("../src/features/model-config/channel.ts")
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

const row = (runtimeId, state, extra = {}) => ({
  connectorId: "c", runtimeId, override: null, desired: "tokens", actual: state === "applied" ? "tokens" : "native", state, ...extra,
})

test("channel: progress counts only runtimes taking part", () => {
  const state = { channel: "tokens", revision: 3, switch: null, runtimes: [
    row("codex", "applied"),
    row("pi", "waiting_online", { connectorId: "d" }),
    row("dsh", "unsupported", { reason: "confirmation_required" }),
  ] }
  const progress = channel.channelProgress(state)
  assert.equal(progress.phase, "running")
  assert.deepEqual([progress.total, progress.applied, progress.unfinished, progress.offlineDevices, progress.unsupported], [2, 1, 1, 1, 1])
  assert.equal(channel.channelProgress({ ...state, runtimes: [row("codex", "applied"), row("x", "restored")] }).phase, "attention")
  assert.equal(channel.channelProgress({ ...state, runtimes: [row("codex", "applied")] }).phase, "done")
  assert.equal(channel.channelProgress(null).phase, "none")
})

test("channel: runtimes belong to the channel they should use", () => {
  const state = { channel: "tokens", revision: 2, switch: null, runtimes: [
    row("codex", "applied"),
    row("claude", "switching", { override: "native", desired: "native", actual: "tokens" }),
  ] }
  assert.deepEqual(channel.channelRows(state, "tokens").map((item) => item.runtimeId), ["codex"])
  assert.deepEqual(channel.channelRows(state, "native").map((item) => item.runtimeId), ["claude"])
  assert.deepEqual(channel.channelRows(null, "tokens"), [])
})

test("channel: Anywhere is wanted while it is the default, chosen or still in use", () => {
  const state = (current, runtimes) => ({ channel: current, revision: 1, switch: null, runtimes })
  assert.equal(channel.tokensWanted(state("tokens", [])), true)
  assert.equal(channel.tokensWanted(state("native", [row("codex", "applied", { desired: "native", actual: "tokens" })])), true)
  assert.equal(channel.tokensWanted(state("native", [row("codex", "pending", { override: "tokens" })])), true)
  assert.equal(channel.tokensWanted(state("native", [row("codex", "applied", { desired: "native", actual: "native" })])), false)
  assert.equal(channel.tokensWanted(null), false)
})

test("channel: a managed instance reads the row of the runtime it serves", () => {
  const state = { channel: "tokens", revision: 1, switch: null, runtimes: [row("pi", "applied")] }
  const runtimes = [
    { connectorId: "c", runtimeId: "pi", runtimeType: "pi" },
    { connectorId: "c", runtimeId: "pi-aa", runtimeType: "pi", managedBy: "model-config" },
    { connectorId: "c", runtimeId: "other", runtimeType: "other" },
  ]
  assert.equal(channel.channelRowFor(state, runtimes, [], { connectorId: "c", runtimeId: "pi-aa" })?.runtimeId, "pi")
  assert.equal(channel.channelRowFor(state, runtimes, [], { connectorId: "c", runtimeId: "other" }), null)
  assert.equal(channel.usesAnywhere(channel.channelRowFor(state, runtimes, [], { connectorId: "c", runtimeId: "pi" })), true)
  assert.equal(channel.usesAnywhere(row("codex", "waiting_idle")), false)
})

test("channel: a profile is referenced while current, chosen or in use", () => {
  const state = { channel: "native", revision: 1, switch: null, runtimes: [row("codex", "applied", { override: "mpr_1", desired: "mpr_1", actual: "mpr_1" })] }
  assert.equal(channel.channelReferenced(state, "mpr_1"), true)
  assert.equal(channel.channelReferenced(state, "mpr_2"), false)
  assert.equal(channel.channelReferenced({ ...state, channel: "mpr_2" }, "mpr_2"), true)
  assert.equal(channel.channelUsers(state, "mpr_1"), 1)
})

test("model config: protocols entered by hand start from the detected address", () => {
  assert.equal(presentation.protocolBaseUrl(" https://relay.example/v1/ ", "openai_chat"), "https://relay.example/v1")
  assert.equal(presentation.protocolBaseUrl("https://relay.example/v1", "anthropic"), "https://relay.example")
  assert.equal(presentation.protocolBaseUrl("https://relay.example/api/anthropic", "anthropic"), "https://relay.example/api/anthropic")
  assert.ok(presentation.MANUAL_PROTOCOL_CODES.includes("gateway_unreachable"))
  assert.ok(!presentation.MANUAL_PROTOCOL_CODES.includes("gateway_key_rejected"))
})
