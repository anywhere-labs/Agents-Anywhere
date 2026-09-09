import assert from "node:assert/strict"
import test from "node:test"

import {
  isRuntimeNotRunningCode,
  runtimeErrorReason,
  runtimeIsNotStarted,
  runtimeIsSelectable,
  runtimeStatusTone,
} from "../src/features/dashboard/runtime-status-presentation.ts"

function runtime(overrides = {}) {
  return {
    connectorId: "connector-1",
    runtimeId: "rti_work",
    runtimeType: "dsh",
    name: "Work",
    displayName: "Work",
    typeDisplayName: "DeepSeek Harness",
    present: true,
    available: false,
    reason: null,
    configured: true,
    active: false,
    status: "stopped",
    discovery: {},
    metadata: {},
    schema: { type: "object" },
    uiSchema: {},
    defaults: {},
    capabilities: {},
    config: {},
    error: null,
    lastDiscoveredAt: "2026-09-09T00:00:00Z",
    createdAt: "2026-09-09T00:00:00Z",
    updatedAt: "2026-09-09T00:00:00Z",
    ...overrides,
  }
}

test("a configured but unstarted instance is neutral, not a fault", () => {
  const stopped = runtime()
  assert.equal(runtimeIsNotStarted(stopped), true)
  assert.equal(runtimeStatusTone(stopped), "neutral")
  assert.equal(runtimeIsSelectable(stopped), false)
})

test("running and in-flight instances keep their own tone", () => {
  assert.equal(runtimeStatusTone(runtime({ active: true, status: "running" })), "ok")
  assert.equal(runtimeStatusTone(runtime({ active: true, status: "starting" })), "progress")
  assert.equal(runtimeStatusTone(runtime({ active: true, status: "stopping" })), "progress")
  assert.equal(runtimeIsSelectable(runtime({ active: true, status: "running" })), true)
  // A starting instance is imminent, so it must not disappear from the selector.
  assert.equal(runtimeIsSelectable(runtime({ active: true, status: "starting" })), true)
})

test("a not-running failure is a warning, a real failure is an error", () => {
  const notStarted = runtime({
    active: true,
    status: "error",
    error: { code: "runtime_unavailable", message: "请启动 DSH，并启用手机连接插件。" },
  })
  assert.equal(runtimeStatusTone(notStarted), "warning")
  assert.equal(runtimeErrorReason(notStarted), "请启动 DSH，并启用手机连接插件。")

  const broken = runtime({
    active: true,
    status: "error",
    error: { code: "runtime_upstream_error", message: "runtime crashed" },
  })
  assert.equal(runtimeStatusTone(broken), "error")
  assert.equal(runtimeErrorReason(broken), "runtime crashed")
})

test("not-running codes are recognised and unknown errors fall back to the code", () => {
  for (const code of ["runtime_unavailable", "runtime_not_started", "runtime_not_configured", "connector_offline"]) {
    assert.equal(isRuntimeNotRunningCode(code), true)
  }
  assert.equal(isRuntimeNotRunningCode("runtime_conflict"), false)
  assert.equal(isRuntimeNotRunningCode(null), false)
  assert.equal(runtimeErrorReason(runtime({ status: "error", error: { code: "runtime_conflict" } })), "runtime_conflict")
})
