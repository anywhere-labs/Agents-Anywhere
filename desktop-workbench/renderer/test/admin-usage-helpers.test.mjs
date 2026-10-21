import assert from "node:assert/strict"
import test from "node:test"

import {
  clampRange,
  formatDurationMs,
  formatPercent,
  formatShortDate,
  localToday,
  presetRange,
  segmentRangeLabel,
  shiftDate,
} from "../src/features/admin-usage/report-helpers.ts"

test("localToday follows the viewer's timezone instead of UTC", () => {
  const late = new Date("2026-10-09T22:30:00Z")
  assert.equal(localToday("UTC", late), "2026-10-09")
  assert.equal(localToday("Asia/Shanghai", late), "2026-10-10")
  assert.equal(localToday("America/Los_Angeles", late), "2026-10-09")
})

test("preset ranges end today and span the preset length", () => {
  assert.deepEqual(presetRange("7d", "2026-10-10"), { from: "2026-10-04", to: "2026-10-10" })
  assert.deepEqual(presetRange("30d", "2026-10-10"), { from: "2026-09-11", to: "2026-10-10" })
  assert.deepEqual(presetRange("90d", "2026-03-01"), { from: "2025-12-02", to: "2026-03-01" })
  assert.equal(shiftDate("2026-03-01", -1), "2026-02-28")
})

test("clampRange rejects reversed, invalid, and oversized ranges", () => {
  assert.deepEqual(clampRange({ from: "2026-01-01", to: "2026-01-31" }), { from: "2026-01-01", to: "2026-01-31" })
  assert.equal(clampRange({ from: "2026-02-01", to: "2026-01-31" }), null)
  assert.equal(clampRange({ from: "2026-02-30", to: "2026-03-01" }), null)
  assert.equal(clampRange({ from: "2024-01-01", to: "2026-01-01" }), null)
})

test("formatters render durations, percents, and axis dates", () => {
  assert.equal(formatDurationMs(null), "—")
  assert.equal(formatDurationMs(420), "420 ms")
  assert.equal(formatDurationMs(2_345), "2.3 s")
  assert.equal(formatDurationMs(45_000), "45 s")
  assert.equal(formatDurationMs(125_000), "2m 05s")
  assert.equal(formatDurationMs(3_720_000), "1h 02m")
  assert.equal(formatPercent(0.1234), "12.3%")
  assert.equal(formatPercent(null), "—")
  assert.equal(formatShortDate("2026-10-05"), "10-05")
  assert.equal(segmentRangeLabel(1, 5), "1–5")
  assert.equal(segmentRangeLabel(21, null), "≥ 21")
})
