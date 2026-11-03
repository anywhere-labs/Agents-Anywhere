import assert from "node:assert/strict"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"

const hooks = registerSource()
const model = await import("../src/features/model-config/runtime-model.ts")
hooks.deregister()

const codex = {
  connectorId: "dev",
  runtimeId: "codex",
  present: true,
  active: true,
  status: "running",
  config: { modelGateway: { baseUrl: "https://gateway.example/v1" }, customModels: [], model: { modelId: "gpt-5" } },
  modelConnection: { protocols: ["openai_responses"], modelField: "model", modeField: null },
}
const pi = {
  connectorId: "dev",
  runtimeId: "pi",
  present: true,
  active: true,
  status: "running",
  config: { executionMode: "managed" },
  modelConnection: { protocols: ["openai_chat"], modelField: "model", modeField: "executionMode" },
}
const dsh = { connectorId: "dev", runtimeId: "dsh", config: {}, modelConnection: { protocols: ["anthropic"] } }

const tokens = {
  id: "tokens",
  name: "Anywhere",
  state: "active",
  preferences: { disabled: ["gpt-old"], names: { "gpt-5": "GPT-5 (AA)" } },
  offers: [
    { format: "openai_chat", baseUrl: "https://t/v1", models: [{ id: "deepseek" }] },
    { format: "openai_responses", baseUrl: "https://t/v1", models: [{ id: "gpt-5", name: "GPT-5" }, { id: "gpt-old" }] },
  ],
}
const anthropicOnly = { id: "claude", name: "Claude gateway", state: "active", offers: [{ format: "anthropic", baseUrl: "https://c", models: [{ id: "opus" }] }] }
const detached = { id: "old", name: "Old", state: "detached", offers: [{ format: "openai_responses", baseUrl: "https://o", models: [{ id: "x" }] }] }

test("runtime model: only runtimes declaring a model field are listed, by device", () => {
  const groups = model.runtimesByDevice([{ id: "other" }, { id: "dev" }], [codex, pi, dsh])
  assert.deepEqual(groups.map((group) => [group.connector.id, group.runtimes.map((item) => item.runtimeId)]), [["dev", ["codex", "pi"]]])
})

test("runtime model: a channel is each active profile offering a protocol the runtime speaks", () => {
  const channels = model.channelsFor(codex, [tokens, anthropicOnly, detached], "本机配置")
  assert.deepEqual(channels.map((item) => [item.id, item.format]), [["tokens", "openai_responses"], [model.LOCAL_CHANNEL, null]])
})

test("runtime model: runtimes with run modes have no local channel", () => {
  assert.equal(model.offersLocalChannel(pi), false)
  assert.deepEqual(model.channelsFor(pi, [tokens], "本机").map((item) => item.id), ["tokens"])
})

test("runtime model: the matched offer follows the runtime's protocol order", () => {
  assert.equal(model.matchOffer(["openai_responses", "openai_chat"], tokens.offers).format, "openai_responses")
  assert.equal(model.matchOffer(["anthropic"], tokens.offers), null)
})

test("runtime model: profile models drop turned-off ones and use renamed names", () => {
  const channel = model.channelsFor(codex, [tokens], "本机")[0]
  assert.deepEqual(model.channelModels(channel, codex, [tokens], null), [{ id: "gpt-5", name: "GPT-5 (AA)" }])
})

test("runtime model: local models leave out the ones Agents Anywhere imported", () => {
  const catalog = { models: [
    { id: "gpt-5.5", displayName: "GPT-5.5", metadata: { source: "codex.model/list" } },
    { id: "gpt-5", displayName: "GPT-5", metadata: { source: "runtime.config.customModels", custom: true } },
    { id: "off", displayName: "Off", metadata: { enabled: false } },
  ] }
  assert.deepEqual(model.localModels(catalog), [{ id: "gpt-5.5", name: "GPT-5.5" }])
})

test("runtime model: the current channel and model come from the assignment and config", () => {
  assert.equal(model.currentChannelId(codex, [{ connectorId: "dev", runtimeId: "codex", profileId: "tokens" }]), "tokens")
  assert.equal(model.currentChannelId(codex, []), model.LOCAL_CHANNEL)
  assert.equal(model.currentChannelId(pi, []), null)
  assert.deepEqual(model.currentRuntimeModel(codex), { modelId: "gpt-5" })
  assert.equal(model.currentRuntimeModel(pi), null)
})

test("runtime model: only a running instance on an online device can change", () => {
  assert.equal(model.runtimeModelEditable(codex, true), true)
  assert.equal(model.runtimeModelEditable(codex, false), false)
  assert.equal(model.runtimeModelEditable({ ...codex, status: "stopped" }, true), false)
  assert.equal(model.runtimeModelEditable({ ...codex, present: false }, true), false)
})

test("runtime model: saving changes only the model and keeps the rest of the config", () => {
  const config = model.withRuntimeModel(codex, { modelId: "gpt-5.5", effortId: "high" })
  assert.deepEqual(config, { ...codex.config, model: { modelId: "gpt-5.5", effortId: "high" } })
  assert.equal("model" in model.withRuntimeModel(codex, null), false)
  assert.deepEqual(codex.config.model, { modelId: "gpt-5" })
})

test("runtime model: the change depends on the channel chosen", () => {
  const next = { modelId: "gpt-5.5" }
  assert.equal(model.planRuntimeModelChange(codex, "tokens", "tokens", next).kind, "save")
  assert.deepEqual(model.planRuntimeModelChange(codex, "tokens", "claude", next), { kind: "apply", profileId: "claude", model: next })
  assert.deepEqual(model.planRuntimeModelChange(codex, "tokens", model.LOCAL_CHANNEL, next), { kind: "restore-then-save", model: next })
  assert.equal(model.planRuntimeModelChange(codex, model.LOCAL_CHANNEL, model.LOCAL_CHANNEL, next).kind, "save")
})
