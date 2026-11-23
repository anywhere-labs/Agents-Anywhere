#!/usr/bin/env node
// Record real `aa.v3.Sessions/watch` events (and a terminal attach) from a running local v3 stack into fixtures for
// the embed harness (web-v3/embed/harness). Client path as scripts/v3-e2e-agents.mjs (branch chore/v3/local-stack):
// control-plane login → client Router token → watch_devices → open_tunnel → Sessions create / watch / send → delete.
//
//   node embed/scripts/record-fixtures.mjs [agent]        (run from web-v3/)
//
// Env: AA_V3_CONTROL (http://127.0.0.1:8790), AA_V3_ADMIN_EMAIL, AA_V3_ADMIN_PASSWORD, AA_V3_KEEP_SESSIONS=1,
// AA_V3_SKIP_SESSION=1 (terminal only).
// Never starts, stops or restarts the stack: it only acts as one more client. The raw recordings are turned into the
// harness fixtures by `embed/scripts/build-fixtures.mjs`.
import { mkdtemp, writeFile } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { Mesh, Router } from "meshcall"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, "..", "fixtures", "raw")
const CONTROL = process.env.AA_V3_CONTROL ?? "http://127.0.0.1:8790"
const EMAIL = process.env.AA_V3_ADMIN_EMAIL ?? "dev@aa.local"
const PASSWORD = process.env.AA_V3_ADMIN_PASSWORD ?? "aa-dev-password"
const TURN_TIMEOUT_MS = Number(process.env.AA_V3_TURN_TIMEOUT_MS ?? 240_000)
const CLIENT_ID = "embed-fixture-recorder"

async function http(pathname, body, token) {
  const res = await fetch(CONTROL + pathname, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${pathname}: HTTP ${res.status} ${text}`)
  return JSON.parse(text)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const login = await http("/auth/login", { email: EMAIL, password: PASSWORD })
const rt = await http("/auth/router-token", { client_id: CLIENT_ID, platform: "web" }, login.access_token)
const control = await Mesh.connect(new Router(rt.tokens[0].router_url), { token: rt.tokens[0].token })
const devices = control.serverStream("aa.v3.Control", "watch_devices", {})
const snapshot = (await devices.next()).value
const list = snapshot.devices ?? []
const device = list.find((d) => d.presence === "online") ?? list[0]
if (!device) throw new Error("no device")
devices.cancel?.()
const opened = await control.unary("aa.v3.Control", "open_tunnel", { device_id: device.id, client_id: CLIENT_ID })
const tunnel = await Mesh.connect(new Router(opened.router_url), { tunnel: opened.credential })
const call = (svc, method, req) => tunnel.unary(svc, method, req, { instance: device.id, timeoutMs: TURN_TIMEOUT_MS + 10_000 })

const status = await call("aa.v3.Device", "status", {})
const runtimes = (status.runtimes ?? []).map((r) => r.id ?? r)
const agent = process.argv[2] ?? runtimes.find((r) => /^pi/i.test(r)) ?? runtimes[0]
console.log(`device ${device.id} "${device.name}" runtimes=${runtimes.join(",")} → recording ${agent}`)

// A small project for the agent to look at.
const cwd = await mkdtemp(path.join(os.tmpdir(), "aa-embed-fixture-"))
await writeFile(path.join(cwd, "README.md"), "# Demo\n\nA tiny project used to record renderer fixtures.\n\n- add(a, b) returns the sum\n")
await writeFile(path.join(cwd, "math.ts"), "export function add(a: number, b: number) {\n  return a + b\n}\n")

if (process.env.AA_V3_SKIP_SESSION !== "1") {
  const session = await call("aa.v3.Sessions", "create", { agent, cwd, title: `embed fixture ${agent}` })
  const started = Date.now()
  const events = []
  const abort = new AbortController()
  const watch = tunnel.serverStream("aa.v3.Sessions", "watch", { id: session.id }, { instance: device.id, signal: abort.signal })
  const watching = (async () => {
    try {
      for await (const event of watch) events.push({ t: Date.now() - started, event })
    } catch (error) {
      if (!abort.signal.aborted) console.error("watch ended:", error?.message ?? error)
    }
  })()

  const prompts = [
    "Look at the files in the current directory (use your tools to list them and read README.md and math.ts), then explain in two short bullet points what the project does and show the add function in a fenced ts code block.",
    "Now add a `sub(a, b)` function to math.ts next to add, then reply with one sentence.",
  ]
  for (const text of prompts) {
    const sent = await call("aa.v3.Sessions", "send", { session_id: session.id, text, wait: true, client_msg_id: `rec_${Date.now()}` })
    console.log(`turn ${sent.turn_result ?? "?"} ${sent.error ?? ""} reply=${JSON.stringify((sent.reply_text ?? "").slice(0, 100))}`)
    // `wait` gives up after ~28 s: wait for the turn to really end.
    const deadline = Date.now() + TURN_TIMEOUT_MS
    await sleep(1000)
    while (Date.now() < deadline) {
      const last = events.findLast((e) => e.event.type === "control" || e.event.type === "snapshot")
      const state = last?.event.control?.state
      if (state && state !== "running" && Date.now() - started - (last?.t ?? 0) > 1500) break
      await sleep(500)
    }
  }
  await sleep(1000)
  abort.abort()
  watch.cancel?.("done")
  await Promise.race([watching, sleep(1000)])
  const page = await call("aa.v3.Sessions", "list_messages", { session_id: session.id, limit: 200 })

  const slug = agent.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
  await writeFile(
    path.join(OUT, `watch-${slug}.json`),
    JSON.stringify(
      { recorded_at: new Date().toISOString(), source: "aa.v3.Sessions/watch", agent, device: { id: device.id, name: device.name, mode: device.mode_hint }, session_id: session.id, events, list_messages: page },
      null,
      2
    ) + "\n"
  )
  console.log(`watch: ${events.length} events, ${page.messages.length} messages → fixtures/raw/watch-${slug}.json`)
  if (!process.env.AA_V3_KEEP_SESSIONS) await call("aa.v3.Sessions", "delete", { id: session.id }).catch(() => undefined)
}

// ── Terminal ──
try {
  const term = await call("aa.v3.Terminals", "create", { cwd, cols: 48, rows: 20 })
  const frames = []
  const t0 = Date.now()
  const duplex = tunnel.duplex("aa.v3.Terminals", "attach", { id: term.id, mode: "control", cols: 48, rows: 20, label: "fixture recorder" }, { instance: device.id })
  const reading = (async () => {
    try {
      for await (const f of duplex) frames.push({ t: Date.now() - t0, frame: f })
    } catch {
      /* closed */
    }
  })()
  const b64 = (s) => Buffer.from(s, "utf8").toString("base64")
  await sleep(1200)
  for (const line of ["ls -la\r", "printf '\\033[1;32mgreen\\033[0m \\033[1;34mblue\\033[0m \\xe4\\xb8\\xad\\xe6\\x96\\x87\\n'\r", "cat README.md\r"]) {
    const generation = frames.findLast((f) => f.frame.type === "control")?.frame.generation ?? 0
    await duplex.send({ type: "input", data: b64(line), generation })
    await sleep(700)
  }
  await sleep(800)
  await duplex.closeSend().catch(() => undefined)
  duplex.cancel?.("done")
  await Promise.race([reading, sleep(1000)])
  await call("aa.v3.Terminals", "kill", { id: term.id }).catch(() => undefined)
  await writeFile(path.join(OUT, "terminal.json"), JSON.stringify({ recorded_at: new Date().toISOString(), source: "aa.v3.Terminals/attach", info: term, frames }, null, 2) + "\n")
  console.log(`terminal: ${frames.length} frames (${[...new Set(frames.map((f) => f.frame.type))].join(",")}) → fixtures/raw/terminal.json`)
} catch (error) {
  console.error("terminal recording failed:", error?.message ?? error)
}

await tunnel.close()
await control.close()
process.exit(0)
