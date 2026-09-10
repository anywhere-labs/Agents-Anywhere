import assert from "node:assert/strict"
import test from "node:test"

import { needsOlderTimelinePage } from "../src/components/session/timeline-autofill.ts"

const short = { scrollHeight: 400, clientHeight: 800 }
const scrollable = { scrollHeight: 900, clientHeight: 800 }

test("a timeline shorter than its viewport keeps asking for older pages", () => {
  assert.equal(needsOlderTimelinePage(short, true), true)
})

test("a scrollable timeline waits for the user to scroll instead", () => {
  assert.equal(needsOlderTimelinePage(scrollable, true), false)
})

test("the last page stops the request loop", () => {
  assert.equal(needsOlderTimelinePage(short, false), false)
})

test("a hidden timeline never asks for pages", () => {
  assert.equal(needsOlderTimelinePage({ scrollHeight: 0, clientHeight: 0 }, true), false)
  assert.equal(needsOlderTimelinePage(null, true), false)
})
