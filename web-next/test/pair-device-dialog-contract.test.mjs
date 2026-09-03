import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(
  new URL("../src/components/pair-device-dialog.tsx", import.meta.url),
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

test("skipping setup does not create a runtime and explicit creation starts it", () => {
  const finish = sourceBetween("const handleSuccessClose", "const replaceRuntime")
  assert.match(finish, /reset\(\)/)
  assert.match(finish, /onOpenChange\(false\)/)
  assert.doesNotMatch(finish, /createConnectorRuntime|setConnectorRuntimeActive/)

  const create = sourceBetween("const createAndStartRuntime", "const addRuntime")
  assert.match(create, /createConnectorRuntime/)
  assert.match(create, /config,\s*active: true/)
})
