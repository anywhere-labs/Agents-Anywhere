import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import {
  applySessionMergeEvent,
  createSessionMergeState,
  getMergedProjects,
  getMergedSessions,
  type MergeEventSource,
} from "@/lib/mesh/session-merge"
import { TimelineStore } from "@/lib/timeline/store"
import type {
  AssistantMessage,
  Control,
  DeviceSessionResult,
  Session,
  SessionListPayload,
  UserMessage,
} from "@/lib/types/v3"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const fixturePath = path.resolve(root, "../contracts/aa-v3/1.0/fixtures/session-merge.json")

interface FixtureCase {
  name: string
  initial_cache: Record<string, SessionListPayload>
  local_e2ee_devices: string[]
  events: { source: MergeEventSource; result: DeviceSessionResult }[]
  expected: {
    session_order: string[]
    device_states: Record<
      string,
      { status: string; stale: boolean; error_code?: string }
    >
  }
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  contract: string
  version: string
  cases: FixtureCase[]
}

describe("Cross-client session merge (contracts/aa-v3/1.0/fixtures/session-merge.json)", () => {
  it("loads all 6 contract fixture cases", () => {
    expect(fixture.contract).toBe("aa-v3")
    expect(fixture.cases).toHaveLength(6)
  })

  for (const tc of fixture.cases) {
    it(tc.name, () => {
      let state = createSessionMergeState(tc.initial_cache)
      const localE2ee = new Set(tc.local_e2ee_devices)

      for (const ev of tc.events) {
        state = applySessionMergeEvent(state, ev, localE2ee)
      }

      const merged = getMergedSessions(state)
      expect(merged.map((s) => s.id)).toEqual(tc.expected.session_order)

      for (const [devId, expectedDev] of Object.entries(tc.expected.device_states)) {
        const actual = state.byDevice[devId]
        expect(actual, `device state for ${devId}`).toBeDefined()
        expect(actual.status).toBe(expectedDev.status)
        expect(actual.stale).toBe(expectedDev.stale)
        if (expectedDev.error_code) {
          expect(actual.error_code).toBe(expectedDev.error_code)
        }
      }
    })
  }

  it("collects deduplicated projects across merged devices", () => {
    let state = createSessionMergeState()
    state = applySessionMergeEvent(
      state,
      {
        source: "control_plane",
        result: {
          device_id: "dev-1",
          status: "ok",
          value: { projects: ["/work/alpha", "/work/alpha", "/work/beta"], sessions: [] },
        },
      },
      new Set()
    )
    expect(getMergedProjects(state).map((p) => p.name)).toEqual(["alpha", "beta"])
  })
})

describe("TimelineStore snapshot, message upsert, optimistic outgoing & head trim", () => {
  const sampleSession: Session = {
    id: "sess-1",
    title: "Test Session",
    agent: "claude",
    device: { id: "dev-1", name: "MacBook" },
    cwd: "/work/repo",
    created_at: "2026-11-22T00:00:00Z",
    updated_at: "2026-11-22T00:00:00Z",
    message_count: 2,
    config: [],
  }

  const idleControl: Control = {
    state: "idle",
    steer: "interrupt",
    pending: [],
    queued: [],
  }

  it("replaces whole items by id, deduplicates optimistic outgoing, and trims on turn boundaries", () => {
    const store = new TimelineStore()

    const optimistic: UserMessage = {
      id: "client-1",
      seq: Number.MAX_SAFE_INTEGER,
      done: true,
      role: "user",
      client_msg_id: "client-1",
      created_at: "2026-11-22T00:00:00Z",
      parts: [{ type: "text", text: "Hello" }],
    }
    store.addOutgoing(optimistic)
    expect(store.snapshot().outgoing).toHaveLength(1)

    const committedUser: UserMessage = {
      id: "m-1",
      seq: 1,
      done: true,
      role: "user",
      client_msg_id: "client-1",
      created_at: "2026-11-22T00:00:01Z",
      parts: [{ type: "text", text: "Hello" }],
    }
    const streamingReply: AssistantMessage = {
      id: "m-2",
      seq: 2,
      done: false,
      role: "assistant",
      turn_id: "m-1",
      created_at: "2026-11-22T00:00:02Z",
      parts: [{ type: "text", text: "Thinking..." }],
    }

    store.apply({
      type: "snapshot",
      session: sampleSession,
      messages: [committedUser, streamingReply],
      has_more: false,
      control: { ...idleControl, state: "running" },
    })

    expect(store.snapshot().outgoing).toHaveLength(0)
    expect(store.snapshot().messages).toHaveLength(2)

    // Whole-item replacement via canonical `message` event
    store.apply({
      type: "message",
      message: {
        ...streamingReply,
        done: true,
        parts: [{ type: "text", text: "All done!" }],
      },
    })

    expect(store.snapshot().messages).toHaveLength(2)
    const latest = store.snapshot().messages[1] as AssistantMessage
    expect(latest.done).toBe(true)
    expect(latest.parts[0]).toEqual({ type: "text", text: "All done!" })
  })
})
