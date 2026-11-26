#!/usr/bin/env node
// Turn the raw recordings (embed/fixtures/raw/*.json, written by record-fixtures.mjs, not committed: they hold the
// recording machine's names and paths) into the harness fixtures (embed/fixtures/*.json, committed): personal details
// replaced, wrapped as `aa.render/2` messages with their recorded timing. Also writes the synthetic "showcase"
// fixture covering what a short real recording cannot (approvals, plans, subagents, attachments, paging).
//
//   node embed/scripts/build-fixtures.mjs        (run from web-v3/)
//
// A fixture: { name, description, steps: [{ at, message }], responders: { older: { messages, page_size }, files } }
// `at` = ms after the fixture starts. Responders answer the bundle's requests like native would: `load_older` with up
// to page_size of `older.messages` before `before_seq`, `file.read` with `files[path]` ({ mime, base64 }).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { crc32, deflateSync } from "node:zlib"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(HERE, "..", "fixtures")
const RAW = path.join(DIR, "raw")

const DEMO_CWD = "/Users/dev/demo"
const DEVICE_NAME = "Dev Laptop"

// ── Sanitising ──

function scrubText(s) {
  return s
    .replace(/(?:\/private)?\/var\/folders\/[^\s"'`)\]\\]*?\/T\/aa-embed-fixture-[A-Za-z0-9]+/g, DEMO_CWD)
    // A path cut off mid-stream (a text item still being written).
    .replace(/(?:\/private)?\/var\/folders\/[A-Za-z0-9_/.-]*/g, DEMO_CWD)
    .replace(/aa-embed-fixture-[A-Za-z0-9]+/g, "demo")
    .replace(/HUAWEI[- ]MateBook[- ]Pro[^"\\\s:/]*/g, "dev-laptop")
    .replace(/t4wefan/g, "dev")
    .replace(/usr_[0-9a-f]{8,}/g, "usr_dev")
}

function scrub(value) {
  if (typeof value === "string") return scrubText(value)
  if (Array.isArray(value)) return value.map(scrub)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]))
  return value
}

/** Pi's start-up banner lists the recording machine's skills and extensions: keep its first lines only. */
function trimBanner(message) {
  if (message?.role !== "assistant" || message.parts?.[0]?.type !== "text") return message
  const text = message.parts[0].text
  if (!/^\*\*pi v/.test(text)) return message
  const head = text.split("\n").slice(0, 1).join("\n")
  return { ...message, parts: [{ ...message.parts[0], text: `${head}\n\n_(skills and extensions of the recording machine omitted)_` }] }
}

function scrubEvent(event) {
  const e = scrub(event)
  if (e.session?.device) e.session.device.name = DEVICE_NAME
  if (e.message) e.message = trimBanner(e.message)
  if (e.messages) e.messages = e.messages.map(trimBanner)
  return e
}

const v2 = (type, fields) => ({ v: 2, type, ...fields })

// ── Recorded conversations ──

function conversationFixture(raw) {
  const sessionId = raw.session_id
  const steps = [
    { at: 0, message: v2("view.conversation", { device_id: raw.device.id, session_id: sessionId, agent: raw.agent, readonly: false, encrypted: raw.device.mode === "encrypted" }) },
  ]
  // Recorded timing, with long waits (model latency) shortened to 1.2 s.
  let at = 50
  let last = raw.events[0]?.t ?? 0
  for (const { t, event } of raw.events) {
    at += Math.min(1200, Math.max(0, t - last))
    last = t
    steps.push({ at, message: v2("conversation.event", { session_id: sessionId, event: scrubEvent(event) }) })
  }
  return {
    name: `conversation-${raw.agent}`,
    description: `Real aa.v3.Sessions/watch events of a ${raw.agent} session (two turns: reading files, then an edit), recorded ${raw.recorded_at.slice(0, 10)} from the local v3 stack.`,
    steps,
    responders: { older: { messages: [], page_size: 0 }, files: {} },
  }
}

function cachedFixture(raw) {
  const messages = raw.list_messages.messages.map((m) => trimBanner(scrub(m)))
  const control = scrub(raw.events.findLast((e) => e.event.type === "control" || e.event.type === "snapshot")?.event.control ?? null)
  return {
    name: "conversation-cached",
    description: `Offline: the cached copy of the ${raw.agent} session (conversation.cached), read-only and marked stale.`,
    steps: [
      { at: 0, message: v2("view.conversation", { device_id: raw.device.id, session_id: raw.session_id, agent: raw.agent, readonly: false, encrypted: false }) },
      { at: 30, message: v2("conversation.cached", { session_id: raw.session_id, messages, control: control && { ...control, state: "disconnected" }, stale: true }) },
    ],
    responders: { older: { messages: [], page_size: 0 }, files: {} },
  }
}

// ── Terminal ──

function terminalFixture(raw) {
  const id = raw.info.id
  const steps = [
    { at: 0, message: v2("view.terminal", { device_id: "dev_demo", terminal_id: id, controller_label: "iPhone", attach_mode: "view", term_mode: raw.info.mode, owner: raw.info.owner, cols: raw.info.cols, rows: raw.info.rows }) },
  ]
  for (const { t, frame } of raw.frames) {
    const f = { ...frame }
    if (typeof f.data === "string") f.data = Buffer.from(scrubText(Buffer.from(f.data, "base64").toString("utf8")), "utf8").toString("base64")
    if (f.type === "control") {
      // Recorded as the recorder's own attach; replayed as someone else controlling (the phone is a viewer).
      f.controller = f.controller && { ...f.controller, client_id: "user:usr_dev/client:desktop", label: "MacBook" }
      f.you = false
    }
    steps.push({ at: 100 + t, message: v2(`term.${f.type}`, { terminal_id: id, ...Object.fromEntries(Object.entries(f).filter(([k]) => k !== "type")) }) })
  }
  return {
    name: "terminal",
    description: `A real aa.v3.Terminals/attach stream (zsh: ls, colours, CJK, cat), recorded ${raw.recorded_at.slice(0, 10)}; replayed with another device in control.`,
    steps,
    responders: { older: { messages: [], page_size: 0 }, files: {} },
  }
}

// ── Synthetic showcase ──

/** A small PNG (gradient with a disc), so image attachments have real bytes to fetch through file.read. */
function demoPng(width = 320, height = 200) {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0
    for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3
      const inDisc = (x - width * 0.62) ** 2 + (y - height * 0.45) ** 2 < (height * 0.28) ** 2
      raw[i] = inDisc ? 250 : Math.round(40 + (x / width) * 120)
      raw[i + 1] = inDisc ? 204 : Math.round(90 + (y / height) * 100)
      raw[i + 2] = inDisc ? 80 : 200
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}

function showcaseFixture() {
  const sid = "ses_showcase"
  const t0 = Date.parse("2026-11-22T09:00:00Z")
  let seq = 100
  const at = (s) => new Date(t0 + s * 1000).toISOString()
  const user = (text, extra = {}) => ({ id: `u${seq}`, seq: seq++, done: true, role: "user", created_at: at(seq), author: "dev@aa.local", parts: [{ type: "text", text }], ...extra })
  const asst = (turn, part, extra = {}) => ({ id: `a${seq}`, seq: seq++, done: true, role: "assistant", turn_id: turn, created_at: at(seq * 3), parts: [part], ...extra })

  // Older pages (load_older): two short turns before the snapshot's first item.
  const olderPages = []
  for (let page = 0; page < 2; page++) {
    const msgs = []
    for (let k = 0; k < 2; k++) {
      const n = page * 2 + k
      const u = { id: `old-u${n}`, seq: 10 + n * 2, done: true, role: "user", created_at: at(n), author: "dev@aa.local", parts: [{ type: "text", text: `Earlier question #${n + 1}: what does step ${n + 1} of the setup do?` }] }
      const a = { id: `old-a${n}`, seq: 11 + n * 2, done: true, role: "assistant", turn_id: u.id, created_at: at(n + 1), parts: [{ type: "text", text: `Step ${n + 1} installs the Connector and pairs it with your account. Nothing else changes on the machine.` }] }
      msgs.push(u, a)
    }
    olderPages.unshift(msgs)
  }

  const u1 = user("帮我看看这张截图里的布局问题，顺便把 `README.md` 里的安装步骤整理成表格。", {
    parts: [
      { type: "text", text: "帮我看看这张截图里的布局问题，顺便把 `README.md` 里的安装步骤整理成表格。" },
      { type: "image", path: `${DEMO_CWD}/.agents-anywhere/attachments/${sid}/a1b2-screenshot.png`, mime: "image/png", name: "screenshot.png", size: 48213 },
      { type: "file", path: `${DEMO_CWD}/.agents-anywhere/attachments/${sid}/c3d4-spec.pdf`, mime: "application/pdf", name: "spec.pdf", size: 1_284_000 },
    ],
  })
  const turn1 = u1.id
  const m = [
    u1,
    asst(turn1, { type: "thinking", text: "The screenshot shows the header overlapping the list. Let me check the layout file and the README first." }),
    asst(turn1, { type: "plan", entries: [
      { content: "Read the layout component", status: "completed" },
      { content: "Fix the header overlap", status: "in_progress" },
      { content: "Turn the install steps into a table", status: "pending" },
    ] }),
    asst(turn1, { type: "tool", id: "call_read", title: "Read src/layout.tsx", kind: "read", status: "completed", input: { path: `${DEMO_CWD}/src/layout.tsx`, offset: 10, limit: 12 }, output: "export function Layout({ children }) {\n  return (\n    <div className=\"min-h-dvh\">\n      <Header className=\"fixed top-0\" />\n      <main>{children}</main>\n    </div>\n  )\n}\n", locations: [{ path: `${DEMO_CWD}/src/layout.tsx`, line: 10 }] }),
    asst(turn1, { type: "tool", id: "call_search", title: "Search \"fixed top-0\"", kind: "search", status: "completed", input: { pattern: "fixed top-0" }, output: "src/layout.tsx:13\nsrc/nav.tsx:4" }),
    asst(turn1, { type: "tool", id: "call_edit", title: "Edit src/layout.tsx", kind: "edit", status: "completed", input: { path: `${DEMO_CWD}/src/layout.tsx` }, diffs: [{ path: `${DEMO_CWD}/src/layout.tsx`, old_text: "      <Header className=\"fixed top-0\" />\n      <main>{children}</main>\n", new_text: "      <Header className=\"sticky top-0 z-10\" />\n      <main className=\"pt-2\">{children}</main>\n" }] }),
    asst(turn1, { type: "subagent", id: "sub_1", title: "Check other pages for the same overlap", agent_type: "explorer", status: "completed", started_at: at(400), ended_at: at(430), tool_count: 2, parts: [], result: "Only `src/settings.tsx` uses the same fixed header; it needs the same change." }),
    { ...asst(turn1, { type: "tool", id: "call_sub_grep", title: "grep -rn \"<Header\" src", kind: "execute", status: "completed", input: { command: "grep -rn \"<Header\" src" }, output: { stdout: "src/layout.tsx:13:      <Header className=\"sticky top-0 z-10\" />\nsrc/settings.tsx:8:      <Header className=\"fixed top-0\" />\n", exit_code: 0 } }), subagent_id: "sub_1" },
    asst(turn1, { type: "text", text: "布局问题出在 `Header` 用了 `fixed`，内容被盖住了。我改成了 `sticky`，并给主区加了一点上边距。\n\n安装步骤整理如下：\n\n| 步骤 | 命令 | 说明 |\n| --- | --- | --- |\n| 1 | `npm i -g @anywhere-labs/connector` | 安装 Connector |\n| 2 | `aa login` | 登录账号 |\n| 3 | `aa pair` | 扫码配对手机 |\n\n```ts\nexport function Layout({ children }: { children: React.ReactNode }) {\n  return <Header className=\"sticky top-0 z-10\" />\n}\n```\n\n复杂度大约是 $O(n \\log n)$。另见 [settings.tsx](file://" + DEMO_CWD + "/src/settings.tsx#L8) 和 [文档](https://example.com/docs)。" }),
  ]
  const u2 = user("顺便跑一下测试")
  const turn2 = u2.id
  const runTool = asst(turn2, { type: "tool", id: "call_test", title: "npm test", kind: "execute", status: "pending", input: { command: "npm test -- --run", cwd: DEMO_CWD } }, { done: false })
  m.push(
    u2,
    asst(turn2, { type: "compaction", id: "cmp_1", status: "completed", trigger: "auto", tokens_before: 182_000, tokens_after: 41_000, at: at(600), ended_at: at(605) }),
    asst(turn2, { type: "tool", id: "call_fetch", title: "Fetch https://example.com/changelog", kind: "fetch", status: "failed", input: { url: "https://example.com/changelog" }, output: "network unreachable" }),
    runTool
  )
  const pending = {
    request_id: "perm_1",
    message_id: runTool.id,
    tool_call_id: "call_test",
    title: "npm test -- --run",
    options: [
      { id: "allow", name: "允许", kind: "allow_once" },
      { id: "always", name: "总是允许", kind: "allow_always" },
      { id: "reject", name: "拒绝", kind: "reject_once" },
    ],
  }
  const control = {
    state: "running",
    steer: "native",
    pending: [pending],
    answered: [],
    queued: [{ client_msg_id: "q1", author: "dev@aa.local", content: "测试通过后帮我提交一下" }],
    usage: { used: 41_000, size: 200_000, updated_at: at(610) },
  }
  const session = { id: sid, title: "Fix header overlap", agent: "claude", device: { id: "dev_demo", name: DEVICE_NAME }, cwd: DEMO_CWD, created_at: at(0), updated_at: at(610), message_count: m.length + 8, config: [] }

  // After the answer: the tool runs and streams, then the turn ends.
  const answered = { ...control, pending: [], answered: [{ request_id: "perm_1", by: "dev@aa.local", device: "iPhone", option_id: "allow", at: at(620) }] }
  const running = { ...runTool, done: false, parts: [{ ...runTool.parts[0], status: "in_progress" }] }
  const done = { ...runTool, done: true, parts: [{ ...runTool.parts[0], status: "completed", output: { stdout: " ✓ src/layout.test.tsx (3 tests) 41ms\n ✓ src/nav.test.tsx (2 tests) 12ms\n\n Test Files  2 passed (2)\n      Tests  5 passed (5)\n", exit_code: 0 } }] }
  const finalText = { id: `a${seq}`, seq: seq++, done: false, role: "assistant", turn_id: turn2, created_at: at(700), parts: [{ type: "text", text: "测试全部通过（5 个用例）。" }] }

  const png = demoPng().toString("base64")
  return {
    name: "conversation-showcase",
    description: "Synthetic: every part the thread draws (thinking, plan, tools, diff, subagent, compaction, table, code, math, file links, image and file attachments, a queued message) with a pending approval that is answered, then streamed to the end. has_more pages back twice.",
    steps: [
      { at: 0, message: v2("view.conversation", { device_id: "dev_demo", session_id: sid, agent: "claude", readonly: false, encrypted: true, me: "dev@aa.local" }) },
      { at: 50, message: v2("conversation.event", { session_id: sid, event: { type: "snapshot", session, messages: m, has_more: true, control } }) },
      { at: 4000, message: v2("conversation.event", { session_id: sid, event: { type: "control", control: answered } }) },
      { at: 4200, message: v2("conversation.event", { session_id: sid, event: { type: "message", message: running } }) },
      { at: 5200, message: v2("conversation.event", { session_id: sid, event: { type: "message", message: done } }) },
      { at: 5600, message: v2("conversation.event", { session_id: sid, event: { type: "message", message: finalText } }) },
      { at: 6000, message: v2("conversation.event", { session_id: sid, event: { type: "message", message: { ...finalText, done: true, parts: [{ type: "text", text: "测试全部通过（5 个用例）。要我顺便把 `settings.tsx` 也改了吗？" }] } } }) },
      { at: 6200, message: v2("conversation.event", { session_id: sid, event: { type: "control", control: { ...answered, state: "idle" } } }) },
    ],
    responders: {
      older: { messages: olderPages.flat().sort((a, b) => a.seq - b.seq), page_size: 4 },
      files: { [u1.parts[1].path]: { mime: "image/png", base64: png } },
    },
  }
}

// ── Write ──

const written = []
const write = (fixture) => {
  writeFileSync(path.join(DIR, `${fixture.name}.json`), JSON.stringify(fixture, null, 1) + "\n")
  written.push(`${fixture.name} (${fixture.steps.length} steps)`)
}

if (existsSync(RAW)) {
  const raws = readdirSync(RAW).filter((f) => f.endsWith(".json"))
  for (const f of raws.filter((f) => f.startsWith("watch-"))) {
    const raw = JSON.parse(readFileSync(path.join(RAW, f), "utf8"))
    write(conversationFixture(raw))
    if (raw.agent === "pi") write(cachedFixture(raw))
  }
  if (raws.includes("terminal.json")) write(terminalFixture(JSON.parse(readFileSync(path.join(RAW, "terminal.json"), "utf8"))))
} else {
  console.warn("no embed/fixtures/raw: only the synthetic fixture is rebuilt (record with embed/scripts/record-fixtures.mjs)")
}
write(showcaseFixture())
writeFileSync(
  path.join(DIR, "index.json"),
  JSON.stringify(readdirSync(DIR).filter((f) => f.endsWith(".json") && f !== "index.json").map((f) => f.replace(/\.json$/, "")).sort(), null, 2) + "\n"
)
console.log(`fixtures: ${written.join(", ")}`)
