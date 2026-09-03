import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("../src/components/pair-device-dialog.tsx", import.meta.url),
  "utf8",
)
const demoSource = readFileSync(
  new URL("../src/components/demo.tsx", import.meta.url),
  "utf8",
)

function sourceBetween(start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`)
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

test("pairing waits for online and enters explicit agent setup without closing", () => {
  assert.match(source, /type Step = .*\| "agents"/)
  assert.match(source, /step === "agents"/)
  assert.match(source, /discoverConnectorRuntimeOverview/)
  assert.doesNotMatch(source, /\bcompletePairing\b/)

  const polling = sourceBetween(
    "const startConnectorPolling",
    "React.useEffect(() =>",
  )
  assert.match(
    polling,
    /if \(connector\.status === "online"\) \{\s*enterAgentsStep\(cid\)/,
  )
  assert.doesNotMatch(polling, /onOpenChange\(false\)/)

  const claim = sourceBetween("const handleClaim", "const handleForceClose")
  assert.match(
    claim,
    /stopPolling\(\)\s*const claimGeneration = pollingGenerationRef\.current/,
  )
  assert.match(
    claim,
    /if \(claimGeneration !== pollingGenerationRef\.current\) return/,
  )
  assert.match(claim, /startConnectorPolling\(claimedConnectorId\)/)
  assert.doesNotMatch(claim, /enterAgentsStep|onOpenChange\(false\)/)
})

test("online completion is idempotent and only reports success once", () => {
  const enterAgents = sourceBetween(
    "const enterAgentsStep",
    "const startConnectorPolling",
  )
  assert.match(
    enterAgents,
    /if \(onlineNotificationRef\.current === cid\) return\s*onlineNotificationRef\.current = cid/,
  )
  assert.equal(source.match(/onConnectorCreated\?\.\(\)/g)?.length, 1)
})

test("agent setup follows connector presence and reloads after reconnect", () => {
  assert.match(source, /watchConnectorPresence\(\{/)
  assert.match(source, /initialOnline: agentSetupPresenceRef\.current === "online"/)
  assert.match(source, /if \(reconnected\) void loadRuntimes\(cid\)/)
  assert.match(source, /runtimeLoadIdRef\.current \+= 1/)
  assert.match(source, /!agentSetupOnline \? \(\s*<Alert>/)
  assert.match(source, /waitingReconnectTitle/)

  const agentsStep = sourceBetween(
    '{/* ── Step: Configure agents ── */}',
    "</DialogContent>",
  )
  assert.match(
    agentsStep,
    /disabled=\{!agentSetupOnline \|\| runtimesLoading \|\| savingRuntimeId !== null\}/,
  )
})

test("workspace refresh does not close the explicit agent setup step", () => {
  const callbackStart = demoSource.indexOf("onConnectorCreated={() => {")
  const callbackEnd = demoSource.indexOf("}}", callbackStart)
  assert.notEqual(callbackStart, -1)
  assert.notEqual(callbackEnd, -1)
  const callback = demoSource.slice(callbackStart, callbackEnd)

  assert.match(callback, /refreshData\(\)/)
  assert.doesNotMatch(callback, /closePairDeviceDialog\(\)/)
})

test("skipping setup does not create a runtime and explicit creation starts it", () => {
  const finish = sourceBetween("const handleSuccessClose", "const replaceRuntime")
  assert.match(finish, /reset\(\)/)
  assert.match(finish, /onOpenChange\(false\)/)
  assert.doesNotMatch(finish, /createConnectorRuntime|setConnectorRuntimeActive/)

  const create = sourceBetween("const createAndStartRuntime", "const addRuntime")
  assert.match(create, /createConnectorRuntime/)
  assert.match(create, /config,\s*active: true/)
})

test("a configured inactive runtime keeps a configure-and-start retry", () => {
  const agentsStep = sourceBetween(
    '{/* ── Step: Configure agents ── */}',
    "</DialogContent>",
  )
  assert.match(agentsStep, /runtime\.active \? \(/)
  assert.match(agentsStep, /onClick=\{\(\) => setConfigRuntime\(runtime\)\}/)
  assert.match(agentsStep, /\{t\("configureAndStart"\)\}/)
  assert.match(source, /submitDisabled=\{!agentSetupOnline\}/)
})
