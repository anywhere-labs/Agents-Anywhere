// aa.render/2 JSON Schema (web-v3/embed/protocol.schema.json): current with embed/src/protocol.ts, and every fixture
// message (real recorded watch events included) and every message the bundle posts validates against it.
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"

import Ajv from "ajv"
import { describe, expect, it } from "vitest"

import { Bridge, type BridgeHost } from "@/embed/src/bridge"
import { EmbedController } from "@/embed/src/controller"
import { CAPABILITIES, NATIVE_TYPES, WEB_TYPES } from "@/embed/src/protocol"
import { createBridgeTerminalTransport } from "@/lib/terminal/bridge-transport"

const EMBED = path.join(__dirname, "..", "embed")
const schema = JSON.parse(readFileSync(path.join(EMBED, "protocol.schema.json"), "utf8"))

function validator() {
  const ajv = new Ajv({ allErrors: true, strict: false })
  return ajv.compile(schema)
}

describe("protocol.schema.json", () => {
  it("is current with embed/src/protocol.ts", async () => {
    const { generateProtocolSchema, serialize } = await import("../embed/scripts/gen-schema.mjs")
    expect(readFileSync(path.join(EMBED, "protocol.schema.json"), "utf8")).toBe(serialize(generateProtocolSchema()))
  }, 30_000)

  it("lists every message type, either way", () => {
    const types = new Set<string>()
    const collect = (name: string) => {
      for (const ref of schema.definitions[name].anyOf ?? []) {
        const def = schema.definitions[ref.$ref.split("/").pop()]
        types.add(def.properties.type.const)
      }
    }
    collect("NativeMessage")
    collect("WebMessage")
    expect([...types].sort()).toEqual([...NATIVE_TYPES, ...WEB_TYPES].sort())
  })

  it("validates every fixture message (recorded aa.v3.Sessions/watch events included)", () => {
    const validate = validator()
    const dir = path.join(EMBED, "fixtures")
    const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "index.json")
    expect(files.length).toBeGreaterThanOrEqual(3)
    let count = 0
    for (const f of files) {
      const fixture = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { steps: { message: unknown }[] }
      for (const [i, step] of fixture.steps.entries()) {
        const ok = validate(step.message)
        if (!ok) throw new Error(`${f} step ${i}: ${JSON.stringify(validate.errors?.slice(0, 3))}`)
        count++
      }
    }
    expect(count).toBeGreaterThan(100)
  })

  it("validates what the bundle posts", () => {
    const validate = validator()
    const sent: unknown[] = []
    const host: BridgeHost = { webkit: { messageHandlers: { aa: { postMessage: (m) => sent.push(structuredClone(m)) } } } }
    const bridge = new Bridge({ host, version: "3.0.0", capabilities: CAPABILITIES }).install()
    const controller = new EmbedController(bridge)
    bridge.ready()
    const receive = (m: unknown) => host.aa!.receive(m)
    receive({ v: 2, type: "view.conversation", device_id: "d", session_id: "s", agent: "pi", readonly: false, encrypted: false })
    receive({
      v: 2,
      type: "conversation.event",
      session_id: "s",
      event: {
        type: "snapshot",
        session: { id: "s", title: "", agent: "pi", device: { id: "d", name: "" }, cwd: "/", created_at: "2026-11-22T00:00:00Z", updated_at: "2026-11-22T00:00:00Z", message_count: 1, config: [] },
        messages: [{ id: "u", seq: 5, done: true, role: "user", created_at: "2026-11-22T00:00:00Z", parts: [{ type: "text", text: "hi" }] }],
        has_more: true,
        control: { state: "idle", steer: "native", pending: [], queued: [] },
      },
    })
    controller.answer("r", "o")
    controller.loadOlder()
    void controller.files.read("/a.png", 10).catch(() => {})
    controller.openLink("https://x.dev")
    controller.openLink("file:///a/b.ts#L3")
    controller.copy("c")
    controller.haptic("success")
    controller.reportScroll(false, 120)
    receive({ v: 2, type: "view.terminal", device_id: "d", terminal_id: "t" })
    const link = createBridgeTerminalTransport(controller.terminalChannel()!).attach({ id: "t", mode: "control", cols: 80, rows: 24, label: "x" }, { frame() {}, closed() {} })
    link.send({ type: "input", data: "AA==", generation: 1 })
    link.send({ type: "resize", cols: 10, rows: 5, generation: 1 })
    link.send({ type: "claim", cols: 10, rows: 5 })
    link.send({ type: "release" })
    link.close()

    const types = new Set(sent.map((m) => (m as { type: string }).type))
    expect([...types].sort()).toEqual([...WEB_TYPES].sort())
    for (const m of sent) {
      if (!validate(m)) throw new Error(`${JSON.stringify(m)}: ${JSON.stringify(validate.errors?.slice(0, 3))}`)
    }
    controller.dispose()
  })

  it("rejects malformed messages", () => {
    const validate = validator()
    expect(validate({ v: 1, type: "scroll", to: "top" })).toBe(false)
    expect(validate({ v: 2, type: "scroll", to: "sideways" })).toBe(false)
    expect(validate({ v: 2, type: "answer", session_id: "s" })).toBe(false)
  })
})
