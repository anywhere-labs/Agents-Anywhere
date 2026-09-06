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
const setupSource = readFileSync(
  new URL("../src/components/agent-setup-provider.tsx", import.meta.url),
  "utf8",
)

function sourceBetween(start, end) {
  const startIndex = source.indexOf(start)
  const endIndex = source.indexOf(end, startIndex + start.length)
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`)
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`)
  return source.slice(startIndex, endIndex)
}

test("CLI pairing waits in the app-level Agent setup provider after the form closes", () => {
  const waiting = sourceBetween("const startConnectorWaiting", "const handleOpenChange")
  assert.match(waiting, /waitForConnector\(connector\)/)
  assert.match(waiting, /readyConnectorIds\.includes\(connectorId\)/)
  assert.match(waiting, /!open \|\| !waitingOnline/)
  assert.match(waiting, /closePairing\(\)/)
  assert.doesNotMatch(source, /dashboardApi\.getConnector|pollingRef/)

  const close = sourceBetween("const closePairing", "const completePairing")
  assert.match(close, /reset\(\)/)
  assert.match(close, /onOpenChange\(false\)/)
  assert.doesNotMatch(close, /removeRequest|watchPairingConnector/)
  assert.match(setupSource, /<PendingPairing/)
  assert.match(setupSource, /return watchPairingConnector/)
  assert.match(setupSource, /queue\.find\(\(item\) => !item\.waitingOnline\)/)
})

test("pair-code completion still requests Agent setup and refreshes once", () => {
  const complete = sourceBetween("const completePairing", "const startConnectorWaiting")
  assert.match(complete, /requestAgentSetup\(pairedConnector\)/)
  assert.match(complete, /closePairing\(\)/)
  assert.match(complete, /onConnectorCreated\?\.\(\)/)
  assert.equal(source.match(/onConnectorCreated\?\.\(\)/g)?.length, 1)
})

test("pairing keeps runtime requests in the shared Agent setup flow", () => {
  assert.doesNotMatch(source, /type Step =[^;]*\| "agents"/)
  assert.doesNotMatch(source, /discoverConnectorRuntimeOverview/)
  assert.doesNotMatch(source, /createConnectorRuntime/)
  assert.doesNotMatch(source, /setConnectorRuntimeActive/)
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
