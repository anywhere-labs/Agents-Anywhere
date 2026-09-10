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
const pairingSource = readFileSync(
  new URL("../src/components/device-pairing-provider.tsx", import.meta.url),
  "utf8",
)
const desktopSource = readFileSync(
  new URL("../src/features/desktop/desktop-connector-context.tsx", import.meta.url),
  "utf8",
)

function sourceBetween(start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`)
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

test("CLI pairing keeps watching after the form closes and completes without another dialog", () => {
  const waiting = sourceBetween("const startConnectorWaiting", "const handleOpenChange")
  assert.match(waiting, /waitForConnector\(connectorId\)/)
  assert.match(waiting, /readyConnectorIds\.includes\(connectorId\)/)
  assert.match(waiting, /!open \|\| !waitingOnline/)
  assert.match(waiting, /closePairing\(\)/)
  assert.match(waiting, /clearPairing\(connectorId\)/)
  assert.doesNotMatch(source, /dashboardApi\.getConnector|pollingRef/)

  const close = sourceBetween("const closePairing", "const completePairing")
  assert.match(close, /reset\(\)/)
  assert.match(close, /onOpenChange\(false\)/)
  assert.doesNotMatch(close, /removeRequest|watchPairingConnector/)
  assert.match(pairingSource, /<PendingPairing/)
  assert.match(pairingSource, /return watchPairingConnector/)
  assert.match(pairingSource, /refreshData\(\)/)
  assert.doesNotMatch(pairingSource, /Dialog|requestAgentSetup|quickAddRuntime/)
})

test("pair-code completion closes the form and refreshes once", () => {
  const complete = sourceBetween("const completePairing", "const startConnectorWaiting")
  assert.doesNotMatch(complete, /AgentSetup|Dialog/)
  assert.match(complete, /closePairing\(\)/)
  assert.match(complete, /onConnectorCreated\?\.\(\)/)
  assert.equal(source.match(/onConnectorCreated\?\.\(\)/g)?.length, 1)
})

test("Desktop connection and pairing have no Agent setup trigger or runtime configuration requests", () => {
  assert.doesNotMatch(source, /type Step =[^;]*\| "agents"/)
  assert.doesNotMatch(source, /discoverConnectorRuntimeOverview/)
  assert.doesNotMatch(source, /createConnectorRuntime/)
  assert.doesNotMatch(source, /setConnectorRuntimeActive/)
  assert.doesNotMatch(desktopSource, /AgentSetup|agentSetup|trackBinding|takeOnline/)
  assert.doesNotMatch(demoSource, /AgentSetup/)
  assert.match(demoSource, /<DevicePairingProvider>/)
})

test("workspace refresh does not manually close the pairing dialog", () => {
  const callbackStart = demoSource.indexOf("onConnectorCreated={() => {")
  const callbackEnd = demoSource.indexOf("}}", callbackStart)
  assert.notEqual(callbackStart, -1)
  assert.notEqual(callbackEnd, -1)
  const callback = demoSource.slice(callbackStart, callbackEnd)

  assert.match(callback, /refreshData\(\)/)
  assert.doesNotMatch(callback, /closePairDeviceDialog\(\)/)
})

test("closing after creating a CLI credential asks for confirmation", () => {
  assert.match(source, /const shouldConfirmExit = connectorId !== null && createdThisFlow/)
  const closeHandler = sourceBetween("const handleOpenChange", "const goBack")
  assert.match(closeHandler, /if \(!nextOpen && shouldConfirmExit\)/)
  assert.match(closeHandler, /setExitGuardOpen\(true\)/)
})
