import assert from "node:assert/strict"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"

registerSource()
const pairing = await import("../src/components/session/session-pairing.ts")
const { reportContentTransportRequired } = await import("../src/lib/transport/content-transport.ts")

test("pairing needs are recorded per session from the first refused request, before any view subscribes", () => {
  reportContentTransportRequired("sess_a", "e2ee_not_paired")
  assert.equal(pairing.sessionPairingCode("sess_a"), "e2ee_not_paired")

  let changes = 0
  const stop = pairing.subscribeSessionPairing(() => changes++)
  reportContentTransportRequired("sess_a", "e2ee_not_paired")
  reportContentTransportRequired("sess_b", "connector_offline")
  reportContentTransportRequired(null, "e2ee_required")
  assert.equal(changes, 0)
  assert.equal(pairing.sessionPairingCode("sess_b"), null)

  reportContentTransportRequired("sess_a", "device_pin_mismatch")
  assert.equal(pairing.sessionPairingCode("sess_a"), "device_pin_mismatch")
  pairing.clearSessionPairing("sess_a")
  assert.equal(pairing.sessionPairingCode("sess_a"), null)
  assert.equal(changes, 2)
  stop()
})
