import { describe, expect, it } from "vitest"

import { base64ToBytes, textToBase64 } from "@/lib/terminal/base64"
import { createBridgeTerminalTransport, type TerminalBridge } from "@/lib/terminal/bridge-transport"
import {
  canType,
  TerminalSession,
  type TerminalLinkHandlers,
  type TerminalRenderer,
  type TerminalSessionOptions,
  type TerminalTimers,
  type TerminalTransport,
} from "@/lib/terminal/session"
import type {
  TerminalAttachRequest,
  TerminalController,
  TerminalInputFrame,
  TerminalOutputFrame,
} from "@/lib/types/v3"

// ── Fakes ──

class FakeTimers implements TerminalTimers {
  private t = 0
  private seq = 0
  private tasks = new Map<number, { at: number; fn: () => void }>()

  now = () => this.t
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq
    this.tasks.set(id, { at: this.t + ms, fn })
    return id
  }
  clearTimeout = (handle: unknown) => {
    this.tasks.delete(handle as number)
  }
  advance(ms: number) {
    const end = this.t + ms
    for (;;) {
      const next = [...this.tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.tasks.delete(next[0])
      this.t = next[1].at
      next[1].fn()
    }
    this.t = end
  }
  get pending() {
    return this.tasks.size
  }
}

interface FakeLink {
  request: TerminalAttachRequest
  handlers: TerminalLinkHandlers
  sent: TerminalInputFrame[]
  closed: boolean
}

class MockTransport implements TerminalTransport {
  links: FakeLink[] = []

  attach(request: TerminalAttachRequest, handlers: TerminalLinkHandlers) {
    const link: FakeLink = { request, handlers, sent: [], closed: false }
    this.links.push(link)
    return {
      send: (frame: TerminalInputFrame) => {
        if (!link.closed) link.sent.push(frame)
      },
      close: () => {
        link.closed = true
      },
    }
  }

  get last(): FakeLink {
    return this.links[this.links.length - 1]
  }

  push(frame: TerminalOutputFrame) {
    this.last.handlers.frame(frame)
  }

  drop(info?: Parameters<TerminalLinkHandlers["closed"]>[0]) {
    this.last.handlers.closed(info)
  }
}

class RecordingRenderer implements TerminalRenderer {
  ops: string[] = []
  text = ""
  cols = 0
  rows = 0

  reset(data: Uint8Array, cols: number, rows: number) {
    this.text = new TextDecoder().decode(data)
    this.cols = cols
    this.rows = rows
    this.ops.push(`reset:${cols}x${rows}`)
  }
  write(data: Uint8Array) {
    const chunk = new TextDecoder().decode(data)
    this.text += chunk
    this.ops.push(`write:${chunk}`)
  }
  resize(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
    this.ops.push(`resize:${cols}x${rows}`)
  }
}

const b64 = (text: string) => textToBase64(text)
const decode = (frame: TerminalInputFrame) =>
  frame.type === "input" ? new TextDecoder().decode(base64ToBytes(frame.data)) : null

const other: TerminalController = {
  client_id: "e2e:other",
  label: "iPhone",
  connected: true,
  since: "2026-11-22T00:00:00Z",
}
const me: TerminalController = { ...other, client_id: "e2e:me", label: "Chrome · macOS" }

function setup(options: Partial<TerminalSessionOptions> = {}) {
  const transport = new MockTransport()
  const renderer = new RecordingRenderer()
  const timers = new FakeTimers()
  const session = new TerminalSession({
    terminalId: "t1",
    transport,
    renderer,
    timers,
    random: () => 0.5,
    label: "Chrome · macOS",
    ...options,
  })
  session.start()
  return { session, transport, renderer, timers }
}

function snapshot(seq = 3, cols = 80, rows = 24, data = "$ "): TerminalOutputFrame {
  return { type: "snapshot", data: b64(data), seq, cols, rows }
}

function control(
  partial: Partial<Extract<TerminalOutputFrame, { type: "control" }>> = {}
): TerminalOutputFrame {
  return { type: "control", controller: null, generation: 0, you: false, cols: 80, rows: 24, ...partial }
}

// ── Tests ──

describe("TerminalSession: snapshot, output and ordering", () => {
  it("writes the snapshot into a fresh terminal sized to it, then live output in seq order", () => {
    const { session, transport, renderer } = setup()
    expect(transport.last.request).toEqual({ id: "t1", mode: "view", label: "Chrome · macOS" })
    transport.push(snapshot(3, 100, 30, "hello"))
    transport.push({ type: "output", data: b64(" world"), seq: 4 })
    transport.push({ type: "output", data: b64("!"), seq: 5 })
    expect(renderer.ops).toEqual(["reset:100x30", "write: world", "write:!"])
    expect(renderer.text).toBe("hello world!")
    expect(session.getState()).toMatchObject({ status: "live", seq: 5, cols: 100, rows: 30 })
  })

  it("drops output already covered by the snapshot", () => {
    const { transport, renderer } = setup()
    transport.push(snapshot(5))
    transport.push({ type: "output", data: b64("old"), seq: 5 })
    transport.push({ type: "output", data: b64("new"), seq: 6 })
    expect(renderer.ops).toEqual(["reset:80x24", "write:new"])
  })

  it("re-attaches for a fresh snapshot when a chunk is missing", () => {
    const { session, transport, renderer } = setup()
    transport.push(snapshot(5))
    transport.push({ type: "output", data: b64("gap"), seq: 7 })
    expect(renderer.ops).toEqual(["reset:80x24"])
    expect(transport.links).toHaveLength(2)
    expect(transport.links[0].closed).toBe(true)
    expect(transport.last.request.resume_seq).toBeUndefined()
    transport.push(snapshot(7, 80, 24, "fresh"))
    expect(renderer.text).toBe("fresh")
    expect(session.getState().seq).toBe(7)
  })

  it("decodes UTF-8 split across chunks as bytes", () => {
    const { transport, renderer } = setup()
    const bytes = new TextEncoder().encode("中")
    const part = (b: Uint8Array) => btoa(String.fromCharCode(...b))
    transport.push(snapshot(0, 80, 24, ""))
    // The renderer receives raw bytes; xterm.js reassembles them. Here we check bytes are passed through intact.
    const received: number[] = []
    renderer.write = (data: Uint8Array) => {
      received.push(...data)
    }
    transport.push({ type: "output", data: part(bytes.subarray(0, 1)), seq: 1 })
    transport.push({ type: "output", data: part(bytes.subarray(1)), seq: 2 })
    expect(new TextDecoder().decode(new Uint8Array(received))).toBe("中")
  })

  it("stops on exit and never reconnects", () => {
    const { session, transport, timers } = setup()
    transport.push(snapshot())
    transport.push({ type: "exit", exit_code: 130, exit_signal: null })
    transport.drop()
    timers.advance(60_000)
    expect(transport.links).toHaveLength(1)
    expect(session.getState()).toMatchObject({ status: "exited", exit: { code: 130, signal: null } })
    expect(session.input("ls\n")).toBe("dropped")
  })
})

describe("TerminalSession: generation stamping and control", () => {
  it("stamps the current generation on input and resize", () => {
    const { session, transport, timers } = setup({ localSize: { cols: 120, rows: 40 } })
    transport.push(snapshot())
    transport.push(control({ controller: me, generation: 4, you: true, cols: 80, rows: 24 }))
    // Becoming controller pushes this window's size right away.
    timers.advance(0)
    expect(transport.last.sent).toEqual([{ type: "resize", cols: 120, rows: 40, generation: 4 }])
    expect(session.input("ls\n")).toBe("sent")
    expect(transport.last.sent[1]).toMatchObject({ type: "input", generation: 4 })
    expect(decode(transport.last.sent[1])).toBe("ls\n")

    transport.push(control({ controller: me, generation: 5, you: true, cols: 120, rows: 40 }))
    session.input("x")
    expect(transport.last.sent[2]).toMatchObject({ type: "input", generation: 5 })
  })

  it("debounces controller resizes and never sends one as a viewer", () => {
    const { session, transport, timers, renderer } = setup()
    transport.push(snapshot())
    transport.push(control({ controller: other, generation: 2, you: false }))
    session.localResize(50, 20)
    timers.advance(1000)
    expect(transport.last.sent).toEqual([])
    // Viewers keep rendering at the controller's size.
    expect(renderer.cols).toBe(80)

    transport.push(control({ controller: me, generation: 3, you: true }))
    timers.advance(0)
    expect(transport.last.sent).toEqual([{ type: "resize", cols: 50, rows: 20, generation: 3 }])
    transport.push(control({ controller: me, generation: 3, you: true, cols: 50, rows: 20 }))
    session.localResize(60, 20)
    session.localResize(70, 20)
    timers.advance(299)
    expect(transport.last.sent).toHaveLength(1)
    timers.advance(1)
    expect(transport.last.sent[1]).toEqual({ type: "resize", cols: 70, rows: 20, generation: 3 })
    expect(renderer.cols).toBe(70)
  })

  it("drops input when someone else controls and raises the take-over prompt instead", () => {
    const { session, transport } = setup()
    transport.push(snapshot())
    transport.push(control({ controller: other, generation: 2, you: false }))
    expect(canType(session.getState())).toBe(false)
    expect(session.input("rm -rf /\n")).toBe("blocked")
    expect(transport.last.sent).toEqual([])
    expect(session.getState().takeoverPrompt).toBe(true)
    session.dismissTakeoverPrompt()
    expect(session.getState().takeoverPrompt).toBe(false)
  })

  it("never claims or sends for pointer-generated input (wheel, mouse) unless controller", () => {
    const { session, transport } = setup()
    transport.push(snapshot())
    transport.push(control({ controller: null, generation: 1 }))
    expect(session.input("\x1b[A", { intent: "pointer" })).toBe("dropped")
    expect(transport.last.sent).toEqual([])
    expect(session.getState().takeoverPrompt).toBe(false)
  })

  it("explicit take-over sends claim with this window's size, or keep_size", () => {
    const { session, transport } = setup({ localSize: { cols: 40, rows: 30 } })
    transport.push(snapshot())
    transport.push(control({ controller: other, generation: 2 }))
    session.input("a")
    expect(session.claim()).toBe(true)
    expect(transport.last.sent).toEqual([{ type: "claim", cols: 40, rows: 30 }])
    expect(session.getState()).toMatchObject({ claimPending: true, takeoverPrompt: false })
    // A take-over does not replay keys typed before it.
    transport.push(control({ controller: me, generation: 3, you: true, cols: 40, rows: 30 }))
    expect(transport.last.sent).toHaveLength(1)

    const second = setup({ localSize: { cols: 40, rows: 30 } })
    second.transport.push(snapshot())
    second.transport.push(control({ controller: other, generation: 2 }))
    second.session.claim({ keepSize: true })
    expect(second.transport.last.sent).toEqual([{ type: "claim", keep_size: true }])
    second.transport.push(control({ controller: me, generation: 3, you: true, cols: 80, rows: 24 }))
    // keep_size: the PTY keeps 80x24, local window changes do not resize it…
    second.session.localResize(41, 30)
    second.timers.advance(1000)
    expect(second.transport.last.sent).toHaveLength(1)
    expect(second.renderer.cols).toBe(80)
    // …until an explicit resize (pinch / "fit to my window").
    second.session.localResize(41, 30, { explicit: true })
    second.timers.advance(300)
    expect(second.transport.last.sent[1]).toEqual({ type: "resize", cols: 41, rows: 30, generation: 3 })
  })

  it("release is only sent by the controller", () => {
    const { session, transport } = setup()
    transport.push(snapshot())
    transport.push(control({ controller: other, generation: 2 }))
    expect(session.release()).toBe(false)
    transport.push(control({ controller: me, generation: 3, you: true }))
    expect(session.release()).toBe(true)
    expect(transport.last.sent.at(-1)).toEqual({ type: "release" })
  })

  it("losing control mid-typing cancels pending resize and stops sending", () => {
    const { session, transport, timers } = setup({ localSize: { cols: 80, rows: 24 } })
    transport.push(snapshot())
    transport.push(control({ controller: me, generation: 3, you: true }))
    session.localResize(90, 24)
    transport.push(control({ controller: other, generation: 4, you: false }))
    timers.advance(1000)
    expect(transport.last.sent.filter((f) => f.type === "resize")).toEqual([])
    expect(session.input("x")).toBe("blocked")
  })
})

describe("TerminalSession: auto-claim", () => {
  it("claims when nobody controls and the user types, then sends the queued keys with the new generation", () => {
    const { session, transport } = setup({ localSize: { cols: 100, rows: 30 } })
    transport.push(snapshot())
    transport.push(control({ controller: null, generation: 6 }))
    expect(canType(session.getState())).toBe(true)
    expect(session.input("l")).toBe("queued")
    expect(session.input("s")).toBe("queued")
    expect(transport.last.sent).toEqual([{ type: "claim", cols: 100, rows: 30 }])
    transport.push(control({ controller: me, generation: 7, you: true, cols: 100, rows: 30 }))
    const inputs = transport.last.sent.filter((f) => f.type === "input")
    expect(inputs.map(decode)).toEqual(["l", "s"])
    expect(inputs.every((f) => f.type === "input" && f.generation === 7)).toBe(true)
  })

  it("auto-claim can keep the size", () => {
    const { session, transport } = setup({ localSize: { cols: 40, rows: 20 }, keepSizeOnAutoClaim: true })
    transport.push(snapshot())
    transport.push(control({ controller: null, generation: 1 }))
    session.input("x")
    expect(transport.last.sent).toEqual([{ type: "claim", keep_size: true }])
  })

  it("drops the queue if the claim is lost to another client or times out", () => {
    const { session, transport, timers } = setup()
    transport.push(snapshot())
    transport.push(control({ controller: null, generation: 1 }))
    session.input("x")
    timers.advance(5000)
    expect(session.getState().claimPending).toBe(false)
    transport.push(control({ controller: me, generation: 2, you: true }))
    expect(transport.last.sent.filter((f) => f.type === "input")).toEqual([])
  })

  it("agent-owned terminals never claim", () => {
    const { session, transport } = setup({ owner: "agent" })
    transport.push(snapshot())
    transport.push(control({ controller: null, generation: 0 }))
    expect(session.input("x")).toBe("dropped")
    expect(session.claim()).toBe(false)
    expect(transport.last.sent).toEqual([])
  })
})

describe("TerminalSession: rejected frames", () => {
  it("records stale-generation rejections", () => {
    const { session, transport } = setup()
    transport.push(snapshot())
    transport.push(control({ controller: me, generation: 3, you: true }))
    transport.push({ type: "rejected", reason: "stale_generation", generation: 4 })
    expect(session.getState().lastRejected).toMatchObject({ reason: "stale_generation", generation: 4 })
    expect(session.getState().readOnly).toBe(false)
  })

  it("agent_owned turns the terminal read-only", () => {
    const { session, transport } = setup()
    transport.push(snapshot())
    transport.push(control({ controller: null }))
    session.input("x")
    transport.push({ type: "rejected", reason: "agent_owned", generation: 0 })
    expect(session.getState()).toMatchObject({ readOnly: true, claimPending: false })
    expect(session.input("y")).toBe("dropped")
  })
})

describe("TerminalSession: reconnect", () => {
  it("reconnects with resume_seq and backoff, and continues without a snapshot when resumed", () => {
    const { session, transport, timers, renderer } = setup()
    transport.push(snapshot(10))
    transport.push({ type: "output", data: b64("a"), seq: 11 })
    transport.drop({ error: new Error("socket closed") })
    expect(session.getState()).toMatchObject({ status: "reconnecting", attempt: 1 })
    timers.advance(499)
    expect(transport.links).toHaveLength(1)
    timers.advance(1)
    expect(transport.links).toHaveLength(2)
    expect(transport.last.request).toMatchObject({ id: "t1", mode: "view", resume_seq: 11 })
    transport.push({ type: "output", data: b64("b"), seq: 12 })
    transport.push(control())
    expect(renderer.ops).toEqual(["reset:80x24", "write:a", "write:b"])
    expect(session.getState()).toMatchObject({ status: "live", attempt: 0, seq: 12 })
  })

  it("backs off exponentially up to the cap", () => {
    const { transport, timers } = setup({ backoff: { baseMs: 100, maxMs: 400 } })
    transport.drop()
    const delays: number[] = []
    for (let i = 0; i < 5; i++) {
      let waited = 0
      const before = transport.links.length
      while (transport.links.length === before) {
        timers.advance(10)
        waited += 10
      }
      delays.push(waited)
      transport.drop()
    }
    expect(delays).toEqual([100, 200, 400, 400, 400])
  })

  it("falls back to a fresh snapshot after resumes keep failing", () => {
    const { transport, timers } = setup()
    transport.push(snapshot(10))
    transport.drop()
    timers.advance(1000)
    expect(transport.last.request.resume_seq).toBe(10)
    transport.drop()
    timers.advance(2000)
    expect(transport.last.request.resume_seq).toBe(10)
    transport.drop()
    timers.advance(4000)
    expect(transport.last.request.resume_seq).toBeUndefined()
  })

  it("asks for a snapshot after being dropped for falling behind", () => {
    const { transport, timers } = setup()
    transport.push(snapshot(10))
    transport.drop({ snapshotNext: true })
    timers.advance(1000)
    expect(transport.last.request.resume_seq).toBeUndefined()
  })

  it("a controller that drops re-attaches with mode=control inside the grace period only", () => {
    const { transport, timers } = setup({ localSize: { cols: 90, rows: 30 } })
    transport.push(snapshot())
    transport.push(control({ controller: me, generation: 2, you: true, cols: 90, rows: 30 }))
    transport.drop()
    timers.advance(600)
    expect(transport.last.request).toMatchObject({ mode: "control", cols: 90, rows: 30, resume_seq: 3 })
    // Comes back as a viewer this time: someone else took over during the grace period.
    transport.push(control({ controller: other, generation: 3, you: false }))
    transport.drop()
    timers.advance(1200)
    expect(transport.last.request.mode).toBe("view")
  })

  it("does not reconnect after a fatal error", () => {
    const { session, transport, timers } = setup()
    transport.drop({ error: new Error("terminal_not_found"), fatal: true })
    timers.advance(60_000)
    expect(transport.links).toHaveLength(1)
    expect(session.getState()).toMatchObject({ status: "closed", error: "terminal_not_found" })
  })

  it("ignores frames from a superseded attach and stops everything on dispose", () => {
    const { session, transport, timers, renderer } = setup()
    transport.push(snapshot(1))
    const first = transport.links[0]
    session.reconnectNow()
    first.handlers.frame({ type: "output", data: b64("stale"), seq: 2 })
    expect(renderer.ops).toEqual(["reset:80x24"])
    session.dispose()
    expect(transport.last.closed).toBe(true)
    timers.advance(60_000)
    expect(timers.pending).toBe(0)
  })

  it("the creating device attaches with mode=control and its size", () => {
    const { transport } = setup({ initialMode: "control", localSize: { cols: 132, rows: 43 } })
    expect(transport.last.request).toEqual({
      id: "t1",
      mode: "control",
      cols: 132,
      rows: 43,
      label: "Chrome · macOS",
    })
  })
})

describe("bridge transport (mobile WebView)", () => {
  it("maps term.* messages to frames and back", () => {
    const posted: [string, Record<string, unknown>][] = []
    let listener: ((type: string, payload: Record<string, unknown>) => void) | null = null
    const bridge: TerminalBridge = {
      post: (type, payload) => posted.push([type, payload]),
      listen: (handler) => {
        listener = handler
        return () => {
          listener = null
        }
      },
    }
    const renderer = new RecordingRenderer()
    const session = new TerminalSession({
      terminalId: "t9",
      transport: createBridgeTerminalTransport(bridge),
      renderer,
      timers: new FakeTimers(),
    })
    session.start()
    expect(posted[0]).toEqual(["term.attach", { id: "t9", mode: "view" }])
    listener!("term.snapshot", { id: "t9", data: b64("hi"), seq: 1, cols: 80, rows: 24 })
    listener!("term.output", { id: "other", data: b64("ignored"), seq: 2 })
    listener!("term.control", { controller: me, generation: 1, you: true, cols: 80, rows: 24 })
    session.input("q")
    expect(renderer.text).toBe("hi")
    expect(posted.at(-1)).toEqual(["term.input", { id: "t9", data: b64("q"), generation: 1 }])
    session.release()
    expect(posted.at(-1)).toEqual(["term.release", { id: "t9" }])
    session.dispose()
    expect(posted.at(-1)).toEqual(["term.detach", { id: "t9" }])
    expect(listener).toBeNull()
  })
})
