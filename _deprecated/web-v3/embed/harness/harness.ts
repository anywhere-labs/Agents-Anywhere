/// <reference types="vite/client" />
// The dev harness: plays recorded fixtures into the render bundle through the browser channel of `aa.render/2`
// (native → web: iframe.contentWindow.postMessage; web → native: window.parent.postMessage), acting as the native app:
// it waits for `ready`, batches per frame, answers `load_older` and `file.read`, and sends theme / scroll / term.key.
//
//   corepack yarn embed:dev   → http://127.0.0.1:5179/harness/
import type { NativeMessage, WebMessage } from "../src/protocol"
import { fileData, olderPage, rebaseTimes } from "./fixture-utils.mjs"

interface Fixture {
  name: string
  description: string
  steps: { at: number; message: NativeMessage }[]
  responders: { older: { messages: unknown[]; page_size: number }; files: Record<string, { mime: string; base64: string }> }
}

const modules = import.meta.glob<Fixture>("../fixtures/*.json", { eager: true, import: "default" })
const fixtures = Object.entries(modules)
  .filter(([file]) => !file.endsWith("/index.json"))
  .map(([, f]) => f)
  .sort((a, b) => a.name.localeCompare(b.name))

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const frame = $<HTMLIFrameElement>("frame")
const log = $<HTMLPreElement>("log")
const select = $<HTMLSelectElement>("fixture")

for (const f of fixtures) select.add(new Option(f.name, f.name))
select.value = fixtures.find((f) => f.name === "conversation-showcase")?.name ?? fixtures[0]?.name ?? ""

// ── Native side of the bridge ──

let ready = false
let queue: NativeMessage[] = []
let pending: NativeMessage[] = []
let flushScheduled = false
let current: Fixture | null = null

function line(dir: "in" | "out", m: unknown) {
  const el = document.createElement("div")
  el.className = dir
  const text = JSON.stringify(m)
  el.textContent = `${dir === "in" ? "→ web " : "← web "}${text.length > 400 ? `${text.slice(0, 400)}…` : text}`
  log.append(el)
  while (log.childElementCount > 400) log.firstElementChild?.remove()
  log.scrollTop = log.scrollHeight
}

function deliver(messages: NativeMessage[]) {
  if (!messages.length) return
  const payload = messages.length === 1 ? messages[0] : ({ v: 2, type: "batch", messages } as NativeMessage)
  line("in", messages.length === 1 ? payload : { type: "batch", count: messages.length, types: messages.map((m) => m.type) })
  frame.contentWindow?.postMessage(payload, "*")
}

/** Native sends nothing before `ready`, then coalesces one frame's messages into one batch. */
function send(...messages: NativeMessage[]) {
  if (!ready) {
    queue.push(...messages)
    return
  }
  if (!$<HTMLInputElement>("batching").checked) {
    for (const m of messages) deliver([m])
    return
  }
  pending.push(...messages)
  if (flushScheduled) return
  flushScheduled = true
  setTimeout(() => {
    flushScheduled = false
    const batch = pending
    pending = []
    deliver(batch)
  }, 16)
}

window.addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return
  const m = e.data as WebMessage
  if (!m || typeof m !== "object" || m.v !== 2) return
  line("out", m)
  if (m.type === "ready") {
    ready = true
    send(theme(), locale())
    const q = queue
    queue = []
    send(...q)
    return
  }
  if (!$<HTMLInputElement>("respond").checked || !current) return
  if (m.type === "load_older") setTimeout(() => send(olderPage(current, m) as NativeMessage), 300)
  if (m.type === "file.read") setTimeout(() => send(fileData(current, m) as NativeMessage), 150)
})

// ── Theme ──

const num = (id: string) => Number($<HTMLInputElement>(id).value) || 0
function theme(): NativeMessage {
  return {
    v: 2,
    type: "theme",
    scheme: $<HTMLInputElement>("dark").checked ? "dark" : "light",
    insets: { top: num("inset-top"), bottom: num("inset-bottom"), left: 0, right: 0 },
    font_scale: num("font") || 1,
    reduce_motion: $<HTMLInputElement>("motion").checked,
    high_contrast: $<HTMLInputElement>("contrast").checked,
  }
}
const locale = (): NativeMessage => ({ v: 2, type: "locale", locale: $<HTMLSelectElement>("locale").value as "zh-CN" | "en" })

function layoutGlass() {
  $("glass-top").style.height = `${num("inset-top")}px`
  $("glass-bottom").style.height = `${num("inset-bottom")}px`
  document.body.classList.toggle("hide-glass", !$<HTMLInputElement>("glass").checked)
  const dark = $<HTMLInputElement>("dark").checked
  $("phone").style.colorScheme = dark ? "dark" : "light"
}
for (const id of ["dark", "inset-top", "inset-bottom", "font", "motion", "contrast"]) {
  $(id).addEventListener("change", () => {
    layoutGlass()
    send(theme())
  })
}
$("glass").addEventListener("change", layoutGlass)
$("locale").addEventListener("change", () => send(locale()))

// ── Playing a fixture ──

let timers: ReturnType<typeof setTimeout>[] = []
let cursor = 0

function load(): Fixture {
  const f = fixtures.find((x) => x.name === select.value)!
  current = rebaseTimes(f) as Fixture
  $("desc").textContent = f.description
  cursor = 0
  for (const t of timers) clearTimeout(t)
  timers = []
  return current
}

function stepMessage(m: NativeMessage): NativeMessage {
  if (m.type === "view.conversation" && $<HTMLInputElement>("readonly").checked) return { ...m, readonly: true }
  return m
}

$("play").addEventListener("click", () => {
  const f = load()
  const speed = Number($<HTMLSelectElement>("speed").value)
  for (const s of f.steps) timers.push(setTimeout(() => send(stepMessage(s.message)), s.at / speed))
})
$("instant").addEventListener("click", () => {
  const f = load()
  send(...f.steps.map((s) => stepMessage(s.message)))
})
$("step").addEventListener("click", () => {
  if (!current || current.name !== select.value || cursor >= current.steps.length) load()
  const s = current!.steps[cursor++]
  if (s) send(stepMessage(s.message))
})
select.addEventListener("change", () => load())

for (const b of document.querySelectorAll<HTMLButtonElement>("[data-scroll]")) {
  b.addEventListener("click", () => send({ v: 2, type: "scroll", to: b.dataset.scroll as "top" | "bottom" }))
}

// ── term.key (native's extra-keys bar) ──

const KEYS: [string, Partial<Record<"ctrl" | "alt" | "shift", boolean>>, string][] = [
  ["escape", {}, "Esc"],
  ["ctrl", {}, "Ctrl"],
  ["tab", {}, "Tab"],
  ["left", {}, "←"],
  ["up", {}, "↑"],
  ["down", {}, "↓"],
  ["right", {}, "→"],
  ["home", {}, "Home"],
  ["end", {}, "End"],
  ["page_up", {}, "PgUp"],
  ["page_down", {}, "PgDn"],
  ["c", { ctrl: true }, "^C"],
  ["enter", {}, "⏎"],
]
for (const [key, mods, label] of KEYS) {
  const b = document.createElement("button")
  b.textContent = label
  b.addEventListener("click", () => send({ v: 2, type: "term.key", key, ...mods }))
  $("keys").append(b)
}

// ── Bundle ──

function reload() {
  ready = false
  queue = []
  pending = []
  const src = document.querySelector<HTMLInputElement>('input[name="bundle"]:checked')!.value
  frame.src = new URL(src, location.href).href
  load()
  // The fixture is queued and goes out right after `ready`.
  send(...current!.steps.filter((s) => s.at === 0).map((s) => stepMessage(s.message)))
}
$("reload").addEventListener("click", reload)
for (const r of document.querySelectorAll('input[name="bundle"]')) r.addEventListener("change", reload)

layoutGlass()
reload()
