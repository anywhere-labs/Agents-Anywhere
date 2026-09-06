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

test("pairing starts with the Desktop-or-Linux platform flow", () => {
  assert.match(source, /type Platform = "macos" \| "windows" \| "linux"/)
  assert.match(source, /type Step =[\s\S]*\| "platform"[\s\S]*\| "desktop-install"[\s\S]*\| "linux-method"/)
  assert.match(source, /step === "platform"/)
  assert.match(source, /selectPlatform\("macos"\)/)
  assert.match(source, /selectPlatform\("windows"\)/)
  assert.match(source, /selectPlatform\("linux"\)/)
  assert.match(source, /DESKTOP_DOWNLOAD_URL/)
})

test("Linux supports both CLI command and pair-code setup", () => {
  assert.match(source, /type LinuxMethod = "terminal" \| "pair-code"/)
  assert.match(source, /routeToLinuxMethod\("terminal"\)/)
  assert.match(source, /routeToLinuxMethod\("pair-code"\)/)
  assert.match(source, /dashboardApi\.createConnector/)
  assert.match(source, /uvx anywhere-cli start/)
  assert.match(source, /uvx anywhere-cli pair/)
  assert.match(source, /dashboardApi\.claimPairing/)
})

test("Linux pairing waits in the app-level Agent setup provider after the form closes", () => {
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

test("closing after creating a Linux credential asks for confirmation", () => {
  assert.match(source, /const shouldConfirmExit = connectorId !== null && createdThisFlow/)
  const closeHandler = sourceBetween("const handleOpenChange", "const goBack")
  assert.match(closeHandler, /if \(!nextOpen && shouldConfirmExit\)/)
  assert.match(closeHandler, /setExitGuardOpen\(true\)/)
})
