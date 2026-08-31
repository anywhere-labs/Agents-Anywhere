import assert from "node:assert/strict"
import test from "node:test"

import { resolveComposerActions } from "../src/components/session/composer-actions.ts"

test("an active empty composer exposes interrupt only on the button", () => {
  assert.deepEqual(
    resolveComposerActions({ hasInput: false, canInterruptActiveTurn: true }),
    { button: "interrupt", enter: "submit" },
  )
})

test("typing during an active turn changes the button to submit", () => {
  assert.deepEqual(
    resolveComposerActions({ hasInput: true, canInterruptActiveTurn: true }),
    { button: "submit", enter: "submit" },
  )
})
