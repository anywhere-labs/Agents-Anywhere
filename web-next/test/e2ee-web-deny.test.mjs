import assert from "node:assert/strict"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"

registerSource()
const { webDeniedByE2ee } = await import("../src/features/auth/e2ee.ts")

test("the Web client is closed only when encryption is required and Web is denied", () => {
  assert.equal(webDeniedByE2ee({ e2ee: { mode: "required", web: "deny", preview: "allow" } }), true)
  assert.equal(webDeniedByE2ee({ e2ee: { mode: "required", web: "allow", preview: "deny" } }), false)
  assert.equal(webDeniedByE2ee({ e2ee: { mode: "off", web: "deny", preview: "deny" } }), false)
  // Servers without end-to-end encryption omit the field.
  assert.equal(webDeniedByE2ee({}), false)
  assert.equal(webDeniedByE2ee(null), false)
})
