// aa.render/2 bridge (web-v3/embed): channels, the ready handshake, batch unpacking and routing, and the round trips
// the conversation and terminal views make (answer, load_older, file.read, term.*), without a DOM.
import { afterEach, describe, expect, it, vi } from "vitest"

import { Bridge, detectChannel, type BridgeHost } from "@/embed/src/bridge"
import { EmbedController, fileLink } from "@/embed/src/controller"
import { FileCache } from "@/embed/src/file-cache"
import { CAPABILITIES, type NativeMessage, type WebMessage } from "@/embed/src/protocol"
import { TerminalChannel, termKeyAction } from "@/embed/src/terminal-channel"
import { createBridgeTerminalTransport } from "@/lib/terminal/bridge-transport"
import type { Control, Message, Session, TerminalOutputFrame } from "@/lib/types/v3"

function iosHost() {
  const sent: WebMessage[] = []
  const host: BridgeHost = { webkit: { messageHandlers: { aa: { postMessage: (m) => sent.push(structuredClone(m) as WebMessage) } } } }
  return { host, sent }
}

function setup() {
  const { host, sent } = iosHost()
  const bridge = new Bridge({ host, version: "test", capabilities: CAPABILITIES, onDrop: () => {} }).install()
  const controller = new EmbedController(bridge)
  const receive = (m: unknown) => host.aa!.receive(m)
  const out = <T extends WebMessage["type"]>(type: T) => sent.filter((m): m is Extract<WebMessage, { type: T }> => m.type === type)
  return { host, sent, bridge, controller, receive, out }
}

const session: Session = {
  id: "s1",
  title: "t",
  agent: "pi",
  device: { id: "d1", name: "Dev" },
  cwd: "/w",
  created_at: "2026-11-22T00:00:00Z",
  updated_at: "2026-11-22T00:00:00Z",
  message_count: 2,
  config: [],
}
const control: Control = {
  state: "running",
  steer: "native",
  pending: [{ request_id: "r1", message_id: "a1", tool_call_id: "c1", title: "ls", options: [{ id: "ok", name: "Allow", kind: "allow_once" }] }],
  queued: [],
}
const msg = (seq: number, role: "user" | "assistant" = "user"): Message =>
  role === "user"
    ? { id: `u${seq}`, seq, done: true, role, created_at: session.created_at, parts: [{ type: "text", text: `m${seq}` }] }
    : { id: `a${seq}`, seq, done: true, role, turn_id: "u1", created_at: session.created_at, parts: [{ type: "text", text: `a${seq}` }] }

const viewConversation = { v: 2, type: "view.conversation", device_id: "d1", session_id: "s1", agent: "pi", readonly: false, encrypted: false } as const
const snapshot = (messages: Message[], has_more = true) =>
  ({ v: 2, type: "conversation.event", session_id: "s1", event: { type: "snapshot", session, messages, has_more, control } }) as const

afterEach(() => {
  vi.useRealTimers()
})

describe("channels", () => {
  it("detects iOS, Android and the browser", () => {
    expect(detectChannel(iosHost().host)).toBe("ios")
    expect(detectChannel({ AndroidAA: { postMessage() {} } })).toBe("android")
    expect(detectChannel({ addEventListener() {}, parent: {} })).toBe("browser")
    expect(detectChannel({})).toBe("none")
  })

  it("posts JSON strings on Android and objects to window.parent in the browser", () => {
    const strings: string[] = []
    const android = new Bridge({ host: { AndroidAA: { postMessage: (s) => strings.push(s) } }, version: "1", capabilities: [] })
    android.post({ type: "copy", text: "hi" })
    expect(JSON.parse(strings[0])).toEqual({ v: 2, type: "copy", text: "hi" })

    const posted: unknown[] = []
    let listener: ((e: { data: unknown }) => void) | undefined
    const browserHost: BridgeHost = {
      parent: { postMessage: (m: unknown, origin: string) => posted.push([m, origin]) },
      addEventListener: (_t, l) => void (listener = l),
      removeEventListener: () => {},
    }
    const browser = new Bridge({ host: browserHost, version: "1", capabilities: [] }).install()
    browser.post({ type: "haptic", kind: "light" })
    expect(posted).toEqual([[{ v: 2, type: "haptic", kind: "light" }, "*"]])
    // native → web in the browser is window.postMessage
    const seen: NativeMessage[] = []
    browser.onAny((m) => seen.push(m))
    listener!({ data: { v: 2, type: "scroll", to: "top" } })
    // Our own outbound message echoed back (top-level page: parent === window) is ignored.
    listener!({ data: { v: 2, type: "haptic", kind: "light" } })
    expect(seen.map((m) => m.type)).toEqual(["scroll"])
  })
})

describe("handshake and batches", () => {
  it("installs window.aa.receive and posts ready once, with version, protocol and capabilities", () => {
    const { host, bridge, sent } = setup()
    expect(typeof host.aa?.receive).toBe("function")
    bridge.ready()
    bridge.ready()
    expect(sent).toEqual([{ v: 2, type: "ready", version: "test", protocol: "aa.render/2", capabilities: [...CAPABILITIES] }])
  })

  it("unpacks batches in order (nested too), accepts JSON strings and drops other versions", () => {
    const { bridge, receive } = setup()
    const drops: string[] = []
    ;(bridge as unknown as { opts: { onDrop: (r: string) => void } }).opts.onDrop = (r) => drops.push(r)
    const seen: string[] = []
    bridge.onAny((m) => seen.push(m.type === "scroll" ? `scroll:${m.to}` : m.type))
    receive(
      JSON.stringify({
        v: 2,
        type: "batch",
        messages: [
          { v: 2, type: "scroll", to: "top" },
          { v: 2, type: "batch", messages: [{ v: 2, type: "scroll", to: "bottom" }] },
          { v: 1, type: "scroll", to: "top" },
          { v: 2, type: "future.thing" },
          { v: 2, type: "locale", locale: "en" },
        ],
      })
    )
    receive("{not json")
    expect(seen).toEqual(["scroll:top", "scroll:bottom", "locale"])
    expect(drops).toEqual(["unsupported version 1", "invalid JSON"])
  })

  it("keeps going after a handler throws", () => {
    const { bridge, receive } = setup()
    const seen: string[] = []
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    bridge.on("scroll", () => {
      throw new Error("boom")
    })
    bridge.on("locale", (m) => seen.push(m.locale))
    receive({ v: 2, type: "batch", messages: [{ v: 2, type: "scroll", to: "top" }, { v: 2, type: "locale", locale: "en" }] })
    expect(seen).toEqual(["en"])
    spy.mockRestore()
  })
})

describe("routing into state", () => {
  it("applies theme and locale", () => {
    const { controller, receive } = setup()
    receive({ v: 2, type: "batch", messages: [{ v: 2, type: "theme", scheme: "dark", insets: { top: 59, bottom: 90, left: 0, right: 0 }, font_scale: 1.2, reduce_motion: true }, { v: 2, type: "locale", locale: "en" }] })
    const s = controller.getState()
    expect(s.appearance).toEqual({ scheme: "dark", insets: { top: 59, bottom: 90, left: 0, right: 0 }, fontScale: 1.2, reduceMotion: true, highContrast: false })
    expect(s.locale).toBe("en")
  })

  it("view.conversation then its snapshot in one batch fills the timeline; other sessions' events are ignored", () => {
    const { controller, receive } = setup()
    receive({ v: 2, type: "batch", messages: [viewConversation, snapshot([msg(1), msg(2, "assistant")])] })
    expect(controller.getState().view).toMatchObject({ kind: "conversation", session_id: "s1", loaded: true, stale: false })
    expect(controller.store.get().messages.map((m) => m.seq)).toEqual([1, 2])
    receive({ v: 2, type: "conversation.event", session_id: "other", event: { type: "message", message: msg(9) } })
    receive({ v: 2, type: "conversation.event", session_id: "s1", event: { type: "message", message: msg(3) } })
    expect(controller.store.get().messages.map((m) => m.seq)).toEqual([1, 2, 3])
  })

  it("conversation.cached shows read-only stale content until a live snapshot", () => {
    const { controller, receive, out } = setup()
    receive(viewConversation)
    receive({ v: 2, type: "conversation.cached", session_id: "s1", messages: [msg(1)], control: null, stale: true })
    expect(controller.getState().view).toMatchObject({ stale: true, loaded: true })
    expect(controller.canAnswer()).toBe(false)
    controller.answer("r1", "ok")
    expect(controller.loadOlder()).toBe(false)
    expect(out("answer")).toHaveLength(0)
    receive(snapshot([msg(1)]))
    expect(controller.getState().view).toMatchObject({ stale: false })
    expect(controller.canAnswer()).toBe(true)
  })
})

describe("round trips", () => {
  it("answer carries the session, request and option", () => {
    const { controller, receive, out } = setup()
    receive({ v: 2, type: "batch", messages: [viewConversation, snapshot([msg(1)])] })
    controller.answer("r1", "ok")
    expect(out("answer")).toEqual([{ v: 2, type: "answer", session_id: "s1", request_id: "r1", option_id: "ok" }])
  })

  it("readonly conversations never answer", () => {
    const { controller, receive, out } = setup()
    receive({ v: 2, type: "batch", messages: [{ ...viewConversation, readonly: true }, snapshot([msg(1)])] })
    controller.answer("r1", "ok")
    expect(out("answer")).toEqual([])
  })

  it("load_older: one request at a time, before the oldest seq; conversation.older prepends", () => {
    const { controller, receive, out } = setup()
    receive({ v: 2, type: "batch", messages: [viewConversation, snapshot([msg(10), msg(11, "assistant")])] })
    expect(controller.loadOlder()).toBe(true)
    expect(controller.loadOlder()).toBe(false)
    expect(out("load_older")).toEqual([{ v: 2, type: "load_older", session_id: "s1", before_seq: 10 }])
    receive({ v: 2, type: "conversation.older", session_id: "s1", messages: [msg(8), msg(9, "assistant")], has_more: false })
    const s = controller.store.get()
    expect(s.messages.map((m) => m.seq)).toEqual([8, 9, 10, 11])
    expect(s.has_more).toBe(false)
    expect(s.loadingOlder).toBe(false)
    expect(controller.loadOlder()).toBe(false)
  })

  it("load_older gives up after a while when native never answers", () => {
    vi.useFakeTimers()
    const { controller, receive } = setup()
    receive({ v: 2, type: "batch", messages: [viewConversation, snapshot([msg(10)])] })
    controller.loadOlder()
    expect(controller.store.get().loadingOlder).toBe(true)
    vi.advanceTimersByTime(16_000)
    expect(controller.store.get().loadingOlder).toBe(false)
  })

  it("an empty older page ends paging", () => {
    const { controller, receive } = setup()
    receive({ v: 2, type: "batch", messages: [viewConversation, snapshot([msg(10)])] })
    controller.loadOlder()
    receive({ v: 2, type: "conversation.older", session_id: "s1", messages: [], has_more: true })
    expect(controller.store.get().has_more).toBe(false)
  })

  it("file.read → file.data resolves bytes; failures and unknown ids are handled", async () => {
    const { controller, receive, out } = setup()
    const ok = controller.files.read("/w/a.png", 1024)
    const bad = controller.files.read("/w/missing.png")
    const [r1, r2] = out("file.read")
    expect(r1).toMatchObject({ path: "/w/a.png", max_bytes: 1024 })
    expect(r1.request_id).not.toBe(r2.request_id)
    receive({ v: 2, type: "file.data", request_id: "nope", ok: true, base64: "AA==" })
    receive({ v: 2, type: "file.data", request_id: r1.request_id, ok: true, base64: btoa("PNG!"), mime: "image/png" })
    receive({ v: 2, type: "file.data", request_id: r2.request_id, ok: false, error: "not_found" })
    const got = await ok
    expect(new TextDecoder().decode(got.bytes)).toBe("PNG!")
    expect(got.mime).toBe("image/png")
    await expect(bad).rejects.toThrow("not_found")
  })

  it("image URLs: asked once per path, ready after file.data, bounded", async () => {
    const posts: WebMessage[] = []
    const files = new FileCache({ post: (m) => posts.push({ v: 2, ...m } as WebMessage), maxEntries: 1 })
    const changed = vi.fn()
    files.subscribe(changed)
    expect(files.url("/a.png", "image/png")).toBeUndefined()
    expect(files.url("/a.png", "image/png")).toBeUndefined()
    expect(posts).toHaveLength(1)
    const req = posts[0] as Extract<WebMessage, { type: "file.read" }>
    files.handle({ v: 2, type: "file.data", request_id: req.request_id, ok: true, base64: btoa("x") })
    await Promise.resolve()
    await Promise.resolve()
    expect(files.url("/a.png")).toMatch(/^(blob:|data:image\/png)/)
    expect(changed).toHaveBeenCalled()
    files.url("/b.png")
    const req2 = posts[1] as Extract<WebMessage, { type: "file.read" }>
    files.handle({ v: 2, type: "file.data", request_id: req2.request_id, ok: true, base64: btoa("y") })
    await Promise.resolve()
    await Promise.resolve()
    expect(files.status("/a.png")).toBe("none")
    expect(files.status("/b.png")).toBe("ready")
  })

  it("links: web links to open_link, file:// links to open_file with the line", () => {
    const { controller, out } = setup()
    controller.openLink("https://example.com/x")
    controller.openLink("file:///Users/dev/demo/src/a%20b.ts#L12")
    controller.openFile("/w/c.ts")
    expect(out("open_link")).toEqual([{ v: 2, type: "open_link", url: "https://example.com/x" }])
    expect(out("open_file")).toEqual([
      { v: 2, type: "open_file", path: "/Users/dev/demo/src/a b.ts", line: 12 },
      { v: 2, type: "open_file", path: "/w/c.ts" },
    ])
    expect(fileLink("https://x")).toBeNull()
  })

  it("copy, haptic and scroll_state (only meaningful changes)", () => {
    const { controller, out } = setup()
    controller.copy("text")
    controller.haptic("medium")
    controller.reportScroll(true, 0)
    controller.reportScroll(true, 3)
    controller.reportScroll(false, 400)
    controller.reportScroll(false, 410)
    controller.reportScroll(false, 900)
    expect(out("copy")).toEqual([{ v: 2, type: "copy", text: "text" }])
    expect(out("haptic")).toEqual([{ v: 2, type: "haptic", kind: "warning" }])
    expect(out("scroll_state").map((m) => [m.at_bottom, m.distance])).toEqual([
      [true, 0],
      [false, 400],
      [false, 900],
    ])
  })

  it("scroll requests reach the view", () => {
    const { controller, receive } = setup()
    const seen: string[] = []
    controller.onScrollRequest((r) => seen.push(r.to))
    receive({ v: 2, type: "batch", messages: [{ v: 2, type: "scroll", to: "bottom" }, { v: 2, type: "scroll", to: "sideways" }] })
    expect(seen).toEqual(["bottom"])
  })
})

describe("terminal over the bridge", () => {
  it("attach / frames / input / detach use terminal_id; frames sent right after view.terminal are not lost", () => {
    const { controller, receive, out } = setup()
    receive({
      v: 2,
      type: "batch",
      messages: [
        { v: 2, type: "view.terminal", device_id: "d1", terminal_id: "t1", controller_label: "iPhone" },
        { v: 2, type: "term.snapshot", terminal_id: "t1", data: btoa("$ "), seq: 3, cols: 80, rows: 24 },
        { v: 2, type: "term.output", terminal_id: "other", data: btoa("x"), seq: 1 },
      ],
    })
    expect(controller.getState().view).toMatchObject({ kind: "terminal", terminal_id: "t1", label: "iPhone", attach_mode: "view" })
    const channel = controller.terminalChannel()!
    const transport = createBridgeTerminalTransport(channel)
    const frames: TerminalOutputFrame[] = []
    const closed = vi.fn()
    const link = transport.attach({ id: "t1", mode: "view", cols: 40, rows: 20, label: "iPhone" }, { frame: (f) => frames.push(f), closed })
    expect(frames).toEqual([{ type: "snapshot", data: btoa("$ "), seq: 3, cols: 80, rows: 24 }])
    expect(out("term.attach")).toEqual([{ v: 2, type: "term.attach", terminal_id: "t1", mode: "view", cols: 40, rows: 20, label: "iPhone" }])

    receive({ v: 2, type: "term.output", terminal_id: "t1", data: btoa("ls"), seq: 4 })
    receive({ v: 2, type: "term.control", controller: null, generation: 2, you: true, cols: 80, rows: 24 })
    expect(frames.slice(1)).toEqual([
      { type: "output", data: btoa("ls"), seq: 4 },
      { type: "control", controller: null, generation: 2, you: true, cols: 80, rows: 24 },
    ])

    link.send({ type: "input", data: btoa("\r"), generation: 2 })
    link.send({ type: "resize", cols: 50, rows: 20, generation: 2 })
    link.send({ type: "claim", keep_size: true })
    link.send({ type: "release" })
    expect(out("term.input")).toEqual([{ v: 2, type: "term.input", terminal_id: "t1", data: btoa("\r"), generation: 2 }])
    expect(out("term.resize")).toEqual([{ v: 2, type: "term.resize", terminal_id: "t1", cols: 50, rows: 20, generation: 2 }])
    expect(out("term.claim")).toEqual([{ v: 2, type: "term.claim", terminal_id: "t1", keep_size: true }])
    expect(out("term.release")).toEqual([{ v: 2, type: "term.release", terminal_id: "t1" }])

    receive({ v: 2, type: "term.closed", terminal_id: "t1", fatal: true })
    expect(closed).toHaveBeenCalledWith({ fatal: true, snapshotNext: false })
    link.close()

    const link2 = transport.attach({ id: "t1", resume_seq: 4 }, { frame: () => {}, closed: () => {} })
    link2.close()
    expect(out("term.attach").at(-1)).toEqual({ v: 2, type: "term.attach", terminal_id: "t1", resume_seq: 4 })
    expect(out("term.detach")).toEqual([{ v: 2, type: "term.detach", terminal_id: "t1" }])
  })

  it("switching views drops the terminal channel", () => {
    const { controller, receive } = setup()
    receive({ v: 2, type: "view.terminal", device_id: "d1", terminal_id: "t1" })
    const channel = controller.terminalChannel() as TerminalChannel
    const seen = vi.fn()
    channel.listen(seen)
    receive(viewConversation)
    receive({ v: 2, type: "term.output", terminal_id: "t1", data: "AA==", seq: 1 })
    expect(seen).not.toHaveBeenCalled()
    expect(controller.terminalChannel()).toBeNull()
  })

  it("term.key maps native's bar like the web row", () => {
    expect(termKeyAction({ key: "escape" })).toEqual({ kind: "key", key: "escape", mods: { ctrl: false, alt: false, shift: false } })
    expect(termKeyAction({ key: "page_up" })).toMatchObject({ kind: "key", key: "pageUp" })
    expect(termKeyAction({ key: "PgDn" })).toMatchObject({ kind: "key", key: "pageDown" })
    expect(termKeyAction({ key: "up", shift: true })).toMatchObject({ kind: "key", key: "up", mods: { shift: true } })
    expect(termKeyAction({ key: "ctrl" })).toEqual({ kind: "toggle_ctrl" })
    expect(termKeyAction({ key: "c", ctrl: true })).toEqual({ kind: "text", data: "\x03" })
    expect(termKeyAction({ key: "b", alt: true })).toEqual({ kind: "text", data: "\x1bb" })
    expect(termKeyAction({ key: "enter" })).toEqual({ kind: "text", data: "\r" })
    expect(termKeyAction({ key: "中" })).toEqual({ kind: "text", data: "中" })
    expect(termKeyAction({ key: "nonsense" })).toEqual({ kind: "none" })
  })

  it("term.key reaches the terminal view only while a terminal is shown", () => {
    const { controller, receive } = setup()
    const seen = vi.fn()
    controller.onTermKey(seen)
    receive({ v: 2, type: "term.key", key: "tab" })
    receive({ v: 2, type: "view.terminal", device_id: "d1", terminal_id: "t1" })
    receive({ v: 2, type: "term.key", key: "tab" })
    expect(seen).toHaveBeenCalledTimes(1)
  })
})
