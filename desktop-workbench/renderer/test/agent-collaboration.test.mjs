import assert from "node:assert/strict"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"
import {
  collabEscalationOf,
  collabPanelVisible,
  collabToolOf,
  digestPreview,
  hostsAgentTools,
  instanceSettingsOf,
  messageAuthorOf,
  parseCollabSettings,
  parseCollabView,
  sessionCollabEdges,
  sessionCollabIndicator,
  sessionTitleOf,
  splitAroundPlaceholder,
  supervisedRows,
  supervisionCandidates,
  supervisionTransitions,
  transitionTarget,
  withInstanceSettings,
  SESSION_PLACEHOLDER,
} from "../src/features/collab/model.ts"

const hook = registerSource()
const { collabApi, allowAgentAccess } = await import("../src/features/collab/api.ts")
hook.deregister()

const edge = (id, supervisor, target, state = "active", createdBy = "human") => ({
  supervisionId: id, supervisorSessionId: supervisor, targetSessionId: target, state, createdBy,
})

test("collab: session views carry origin and supervision edges; malformed entries are dropped", () => {
  const edges = sessionCollabEdges({
    origin: { kind: "agent", bySessionId: "s_parent", byDeviceId: null, depth: 1 },
    supervisors: [edge("sv1", "s_parent", "s_child"), { supervisionId: "broken" }],
    supervised: "nope",
  })
  assert.deepEqual(edges.origin, { kind: "agent", bySessionId: "s_parent", byDeviceId: null, depth: 1 })
  assert.equal(edges.supervisors.length, 1)
  assert.deepEqual(edges.supervised, [])
  assert.equal(sessionCollabEdges({ origin: { kind: "human", bySessionId: "x" } }).origin, null)
})

test("collab: list rows mark Agent-created and supervised sessions; ended edges do not count", () => {
  assert.equal(sessionCollabIndicator({}), null)
  assert.deepEqual(sessionCollabIndicator({ origin: { kind: "agent", bySessionId: "p", depth: 1 } }), { createdByAgent: true, supervised: false })
  assert.deepEqual(sessionCollabIndicator({ supervisors: [edge("a", "p", "c", "paused")] }), { createdByAgent: false, supervised: true })
  assert.equal(sessionCollabIndicator({ supervisors: [edge("a", "p", "c", "ended")] }), null)
})

test("collab: message authors are read only from user messages", () => {
  const agent = { type: "message", role: "user", content: { text: "hi", author: { kind: "agent", sessionId: "s1", deviceId: "d1", supervisionId: null } } }
  assert.deepEqual(messageAuthorOf(agent), { kind: "agent", sessionId: "s1", deviceId: "d1", supervisionId: null })
  assert.equal(messageAuthorOf({ ...agent, role: "assistant" }), null)
  assert.equal(messageAuthorOf({ type: "message", role: "user", content: { author: { kind: "human" } } }), null)
  assert.equal(messageAuthorOf({ type: "message", role: "user", content: { author: { kind: "supervision", supervisionId: "sv" } } }).kind, "supervision")
})

test("collab: escalations and collaboration tool calls", () => {
  const escalation = { type: "system", content: { kind: "collab_escalation", question: "Merge?", fromSessionId: "s1", targetSessionId: "s2" } }
  assert.deepEqual(collabEscalationOf(escalation), { question: "Merge?", context: null, fromSessionId: "s1", targetSessionId: "s2" })
  assert.equal(collabEscalationOf({ type: "system", content: { kind: "collab_escalation" } }), null)
  assert.equal(collabEscalationOf({ type: "marker", content: escalation.content }), null)
  assert.deepEqual(collabToolOf({ type: "tool", content: { collabTool: { tool: "aa_spawn", sessionId: "s9" } } }), { tool: "aa_spawn", known: true, sessionId: "s9" })
  assert.deepEqual(collabToolOf({ type: "tool", content: { collabTool: { tool: "aa_future" } } }), { tool: "aa_future", known: false, sessionId: null })
  assert.equal(collabToolOf({ type: "tool", content: {} }), null)
})

test("collab: digest previews collapse long text", () => {
  assert.deepEqual(digestPreview("a\nb"), { preview: "a\nb", truncated: false })
  const long = digestPreview(Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n"), 3)
  assert.equal(long.truncated, true)
  assert.equal(long.preview, "line 0\nline 1\nline 2\n…")
})

test("collab: placeholders split translated sentences for links", () => {
  assert.deepEqual(splitAroundPlaceholder(`由 ${SESSION_PLACEHOLDER} 的 Agent 发送`, SESSION_PLACEHOLDER), ["由 ", null, " 的 Agent 发送"])
  assert.deepEqual(splitAroundPlaceholder(`Created by ${SESSION_PLACEHOLDER}`, SESSION_PLACEHOLDER), ["Created by ", null])
  assert.deepEqual(splitAroundPlaceholder("no marker", SESSION_PLACEHOLDER), ["no marker"])
  assert.equal(sessionTitleOf([{ id: "a", title: " A " }], "a"), "A")
  assert.equal(sessionTitleOf([{ id: "a", title: "" }], "a"), null)
})

test("collab: the device view parses with defaults and merges with directory edges", () => {
  const view = parseCollabView({
    available: true,
    grant: { grantId: "g", state: "active", depth: 0, crossDevice: true, authority: { interrupt: true }, limits: { maxActiveChildren: 4, maxDepth: 2, wakesPerHour: 20 } },
    supervisions: [{ supervisionId: "sv1", targetSessionId: "t1", state: "paused", pausedReason: "budget", triggers: ["turn_end", "bogus"], createdBy: "agent" }, { bad: true }],
    actions: [{ actionId: "a1", verb: "spawn", targetSessionId: "t1", outcome: "accepted", errorCode: null, at: "2026-11-18T00:00:00Z" }],
  }, "s0")
  assert.equal(view.sessionId, "s0")
  assert.equal(view.grant.authority.steer, true)
  assert.equal(view.grant.authority.interrupt, true)
  assert.deepEqual(view.supervisions[0].triggers, ["turn_end"])
  assert.equal(view.supervisions.length, 1)
  assert.equal(view.actions[0].verb, "spawn")

  const rows = supervisedRows([edge("sv1", "s0", "t1", "active"), edge("sv2", "s0", "t2", "ended"), edge("sv3", "s0", "t3")], view)
  assert.deepEqual(rows.map((row) => [row.supervisionId, row.state, row.detail !== null]), [["sv1", "paused", true], ["sv3", "active", false], ["sv2", "ended", false]])

  const edges = sessionCollabEdges({})
  assert.equal(collabPanelVisible(null, edges), false)
  assert.equal(collabPanelVisible({ ...view, available: false, supervisions: [] }, edges), false)
  assert.equal(collabPanelVisible(view, edges), true)
  assert.equal(collabPanelVisible(null, sessionCollabEdges({ supervised: [edge("x", "s0", "t")] })), true)
})

test("collab: supervision transitions and candidates", () => {
  assert.deepEqual(supervisionTransitions("active"), ["pause", "end"])
  assert.deepEqual(supervisionTransitions("paused"), ["resume", "end"])
  assert.deepEqual(supervisionTransitions("ended"), [])
  assert.equal(transitionTarget("resume"), "active")
  const sessions = [{ id: "s0" }, { id: "t1" }, { id: "t2", archived: true }, { id: "t3" }, { id: "t4" }]
  const rows = supervisedRows([edge("a", "s0", "t1"), edge("b", "s0", "t4", "ended")], null)
  assert.deepEqual(supervisionCandidates(sessions, "s0", rows).map((session) => session.id), ["t3", "t4"])
})

test("collab: settings default to off and instance authority defaults to steer and close", () => {
  const empty = parseCollabSettings(null)
  assert.deepEqual(empty, { enabled: false, crossDevice: false, instances: {} })
  assert.deepEqual(instanceSettingsOf(empty, "codex-1").authority, { steer: true, interrupt: false, respondApproval: false, reviewPlan: false, close: true })
  const next = withInstanceSettings(empty, "codex-1", { enabled: true, authority: { respondApproval: true } })
  assert.deepEqual(next.instances["codex-1"], { enabled: true, crossDevice: false, authority: { steer: true, interrupt: false, respondApproval: true, reviewPlan: false, close: true } })
  assert.deepEqual(parseCollabSettings({ enabled: true, crossDevice: true, instances: { r: { enabled: true, authority: { close: false } } } }).instances.r.authority.close, false)
})

test("collab: instance switches follow the agent tools host capability", () => {
  const set = (capabilities) => ({ capabilities })
  assert.equal(hostsAgentTools(null), false)
  assert.equal(hostsAgentTools(set([{ capabilityId: "runtime.agent_tools.host", supported: true }]), "r1"), true)
  assert.equal(hostsAgentTools(set([{ capabilityId: "runtime.agent_tools.host", supported: false, runtimeId: "r1" }, { capabilityId: "runtime.agent_tools.host", supported: true }]), "r1"), false)
  assert.equal(hostsAgentTools(set([{ capabilityId: "runtime.config", supported: true }]), "r1"), false)
})

test("collab api: session routes and settings use the client API paths and bodies", async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null })
    const path = String(url)
    const payload = path.endsWith("/collab")
      ? { sessionId: "s 1", available: true, grant: null, supervisions: [], actions: [] }
      : path.includes("/supervisions")
        ? { supervision: { supervisionId: "sv1", targetSessionId: "t1", state: "active", triggers: ["turn_end"], authority: {}, createdBy: "human" } }
        : { enabled: true, crossDevice: false, instances: {} }
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })
  }
  try {
    assert.equal((await collabApi.getSessionCollab("tk", "s 1")).available, true)
    await collabApi.createSupervision("tk", "s 1", { targetSessionId: "t1", targetDeviceId: "d2" })
    await collabApi.updateSupervision("tk", "s 1", "sv1", { state: "paused" })
    await collabApi.getSettings("tk")
    await collabApi.putSettings("tk", { enabled: true, crossDevice: false, instances: {} })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ["GET", "/api/v2/sessions/s%201/collab"],
    ["POST", "/api/v2/sessions/s%201/collab/supervisions"],
    ["PATCH", "/api/v2/sessions/s%201/collab/supervisions/sv1"],
    ["GET", "/api/v2/agent-collaboration/settings"],
    ["PUT", "/api/v2/agent-collaboration/settings"],
  ])
  assert.equal(typeof calls[1].body.operationId, "string")
  assert.deepEqual({ ...calls[1].body, operationId: undefined }, { operationId: undefined, targetSessionId: "t1", targetDeviceId: "d2" })
  assert.deepEqual({ ...calls[2].body, operationId: undefined }, { operationId: undefined, state: "paused" })
  assert.deepEqual(calls[4].body, { enabled: true, crossDevice: false, instances: {} })
})

test("collab api: agent access reads A's identity, approves it on B, then pins B on A", async () => {
  const calls = []
  const steps = []
  const deps = {
    pinnedDevicePub: async (deviceId) => (deviceId === "B" ? "B".repeat(43) : null),
    call: async (deviceId, method, path, body) => {
      calls.push([deviceId, method, path, body ?? null])
      if (path.endsWith("agent-identity")) return { deviceId: "A", identityPub: "A".repeat(43), label: "A agent" }
      if (path.endsWith("peers/pin")) return { peers: [{ deviceId: "B", identityPubFingerprint: "fp", label: "B", pinnedAt: "now" }] }
      return {}
    },
  }
  const result = await allowAgentAccess(deps, { sourceDeviceId: "A", targetDeviceId: "B", targetLabel: "Laptop B" }, "Mac A 的 Agent", (step) => steps.push(step))
  assert.equal(result.peers[0].deviceId, "B")
  assert.deepEqual(steps, ["identity", "approve", "pin"])
  assert.deepEqual(calls, [
    ["A", "GET", "/e2ee/v1/agent-identity", null],
    ["B", "POST", "/e2ee/v1/trust/approve", { clientIdentityPub: "A".repeat(43), label: "Mac A 的 Agent", platform: "agent" }],
    ["A", "POST", "/e2ee/v1/peers/pin", { deviceId: "B", deviceIdentityPub: "B".repeat(43), label: "Laptop B" }],
  ])
  await assert.rejects(allowAgentAccess(deps, { sourceDeviceId: "B", targetDeviceId: "A", targetLabel: "" }, "x"), (error) => error.code === "e2ee_not_paired")
})
