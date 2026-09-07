import assert from "node:assert/strict"
import test from "node:test"
import { DesktopAgentSetup } from "../src/features/desktop/agent-setup.ts"

const binding = { connectorId: "local-new", name: "Office Mac", serverUrl: "https://server.example" }

test("new local pairing waits for that device to be online and prompts only once", () => {
  const setup = new DesktopAgentSetup()
  setup.trackBinding(null, binding)
  assert.equal(setup.takeOnline("remote-device"), null)
  assert.deepEqual(setup.takeOnline(binding.connectorId), { id: binding.connectorId, name: binding.name })
  assert.equal(setup.takeOnline(binding.connectorId), null)
  setup.trackBinding(null, binding)
  assert.equal(setup.takeOnline(binding.connectorId), null)
})

test("opening or reconnecting an already-paired Desktop does not prompt", () => {
  const setup = new DesktopAgentSetup()
  setup.trackBinding(binding.connectorId, binding)
  assert.equal(setup.takeOnline(binding.connectorId), null)
})

test("retrying after an online timeout retains the new pairing prompt", () => {
  const setup = new DesktopAgentSetup()
  setup.trackBinding(null, binding)
  setup.trackBinding(binding.connectorId, binding)
  assert.deepEqual(setup.takeOnline(binding.connectorId), { id: binding.connectorId, name: binding.name })
})

test("pairing again after the local device was deleted prompts for the replacement", () => {
  const setup = new DesktopAgentSetup()
  setup.trackBinding("deleted-device", binding)
  assert.equal(setup.takeOnline("deleted-device"), null)
  assert.deepEqual(setup.takeOnline(binding.connectorId), { id: binding.connectorId, name: binding.name })
  const next = { ...binding, connectorId: "local-next" }
  setup.trackBinding(binding.connectorId, next)
  assert.deepEqual(setup.takeOnline(next.connectorId), { id: next.connectorId, name: next.name })
})
