#!/usr/bin/env node
// Headless smoke test of the BUILT bundle (embed/dist/aa-render.html) at 390×844, light and dark: loads it the way
// the iOS app does (window.webkit.messageHandlers.aa + window.aa.receive), replays the fixtures, checks the bridge
// round trips (ready, answer, load_older, file.read, scroll_state, term.attach / term.key → term.input) and writes
// screenshots to embed/.artifacts/.
//
//   corepack yarn embed:build && corepack yarn embed:smoke
//
// Browser: Playwright's Chromium (PLAYWRIGHT_CHROMIUM=/path/to/chrome to pick one; otherwise the Playwright cache, then
// the installed Google Chrome).
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { chromium } from "playwright-core"

import { fileData, olderPage, rebaseTimes } from "../harness/fixture-utils.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EMBED = path.join(HERE, "..")
const HTML = path.join(EMBED, "dist", "aa-render.html")
const OUT = path.join(EMBED, ".artifacts")
const fixture = (name) => rebaseTimes(JSON.parse(readFileSync(path.join(EMBED, "fixtures", `${name}.json`), "utf8")))

if (!existsSync(HTML)) {
  console.error("embed/dist/aa-render.html is missing: run `corepack yarn embed:build` first")
  process.exit(1)
}
mkdirSync(OUT, { recursive: true })

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM) return process.env.PLAYWRIGHT_CHROMIUM
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright")
  const candidates = []
  if (existsSync(cache)) {
    for (const dir of readdirSync(cache).sort().reverse()) {
      if (dir.startsWith("chromium_headless_shell-")) {
        candidates.push(
          path.join(cache, dir, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
          path.join(cache, dir, "chrome-headless-shell-mac-x64", "chrome-headless-shell"),
          path.join(cache, dir, "chrome-headless-shell-linux64", "chrome-headless-shell"),
          path.join(cache, dir, "chrome-linux", "headless_shell")
        )
      }
    }
  }
  candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
  return candidates.find((p) => existsSync(p))
}

const failures = []
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) failures.push(what)
}

const browser = await chromium.launch({ executablePath: findChromium(), headless: true })

async function openPage(scheme) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`))
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`)
  })
  // The iOS channel: what the page posts lands in window.__out.
  await page.addInitScript(() => {
    window.__out = []
    window.webkit = { messageHandlers: { aa: { postMessage: (m) => window.__out.push(JSON.parse(JSON.stringify(m))) } } }
  })
  await page.goto(pathToFileURL(HTML).href)
  await page.waitForFunction(() => window.__out.some((m) => m.type === "ready"), null, { timeout: 15_000 })
  const send = (messages) => page.evaluate((batch) => window.aa.receive(JSON.stringify(batch)), { v: 2, type: "batch", messages })
  const outbox = () => page.evaluate(() => window.__out)
  const waitOut = (pred, what, timeout = 8000) =>
    page
      .waitForFunction(new Function("m", `return window.__out.some(${pred})`), null, { timeout })
      .then(() => true)
      .catch(() => {
        console.log(`  (timed out waiting for ${what})`)
        return false
      })
  const theme = (insets = { top: 59, bottom: 96, left: 0, right: 0 }) => ({ v: 2, type: "theme", scheme, insets, font_scale: 1 })
  return { context, page, errors, send, outbox, waitOut, theme }
}

for (const scheme of ["light", "dark"]) {
  console.log(`\n── ${scheme} ──`)
  const { context, page, errors, send, outbox, waitOut, theme } = await openPage(scheme)
  const ready = (await outbox()).find((m) => m.type === "ready")
  check(ready?.v === 2 && ready.protocol === "aa.render/2" && ready.capabilities.includes("term.key"), "ready handshake (v, protocol, capabilities)")

  // ── Showcase: the snapshot with a pending approval ──
  const show = fixture("conversation-showcase")
  await send([theme(), { v: 2, type: "locale", locale: "zh-CN" }, ...show.steps.slice(0, 2).map((s) => s.message)])
  await page.waitForSelector("[data-turn-id]")
  check(await page.evaluate(() => document.documentElement.classList.contains("dark")) === (scheme === "dark"), `theme.scheme → ${scheme} class`)

  // file.read for the image attachment → file.data
  const sawRead = await waitOut("(m) => m.type === 'file.read' && m.path.endsWith('screenshot.png')", "file.read")
  check(sawRead, "image attachment asks file.read")
  const read = (await outbox()).find((m) => m.type === "file.read")
  if (read) {
    await send([fileData(show, read)])
    const loaded = await page
      .waitForFunction(() => [...document.images].some((i) => i.alt === "screenshot.png" && i.naturalWidth > 1), null, { timeout: 5000 })
      .then(() => true)
      .catch(() => false)
    check(loaded, "file.data → image drawn from the bytes")
  }
  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(OUT, `conversation-showcase-${scheme}.png`) })

  // Approval card → answer
  const allow = page.getByRole("button", { name: "允许", exact: true })
  check((await allow.count()) > 0, "inline approval card drawn")
  if (await allow.count()) {
    await allow.first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(OUT, `conversation-approval-${scheme}.png`) })
    await allow.first().tap()
    const answered = await waitOut("(m) => m.type === 'answer' && m.request_id === 'perm_1' && m.option_id === 'allow' && m.session_id === 'ses_showcase'", "answer")
    check(answered, "tapping 允许 posts answer {session_id, request_id, option_id}")
  }
  // Rest of the turn streams in.
  await send(show.steps.slice(2).map((s) => s.message))
  await page.waitForTimeout(500)
  check((await outbox()).some((m) => m.type === "scroll_state"), "scroll_state reported")

  // Scroll to the top → load_older → conversation.older (twice: the fixture has two pages)
  for (let pageNo = 1; pageNo <= 2; pageNo++) {
    await page.evaluate(() => window.scrollTo(0, 0))
    const asked = await waitOut(`(m) => m.type === 'load_older' && m.session_id === 'ses_showcase' && window.__out.filter((x) => x.type === 'load_older').length >= ${pageNo}`, `load_older #${pageNo}`)
    check(asked, `scrolling to the top posts load_older #${pageNo}`)
    const req = (await outbox()).filter((m) => m.type === "load_older").at(-1)
    if (!req) break
    await send([olderPage(show, req)])
    await page.waitForTimeout(300)
  }
  check(await page.getByText("Earlier question #1").count() > 0, "older pages prepended")
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(OUT, `conversation-older-${scheme}.png`) })

  // Native "back to bottom" button
  await send([{ v: 2, type: "scroll", to: "bottom" }])
  await page.waitForTimeout(900)
  const atBottom = await page.evaluate(() => {
    const el = document.scrollingElement
    return el.scrollHeight - el.scrollTop - el.clientHeight < 30
  })
  check(atBottom, "scroll {to: bottom} reaches the end")
  await page.screenshot({ path: path.join(OUT, `conversation-end-${scheme}.png`) })

  // Links: web → open_link, file:// → open_file
  const fileLink = page.locator('a[href^="file://"]').first()
  if (await fileLink.count()) {
    await fileLink.scrollIntoViewIfNeeded()
    await fileLink.tap()
    check(await waitOut("(m) => m.type === 'open_file' && m.path.endsWith('/src/settings.tsx') && m.line === 8", "open_file"), "file:// link posts open_file {path, line}")
  } else {
    // Streamdown's sanitizer drops non-http(s) hrefs before they reach the link component (web app too).
    console.log("skip file:// link → open_file: Streamdown renders file:// links as [blocked] (see embed/README.md)")
  }

  // ── A real recording (pi), all at once ──
  const pi = fixture("conversation-pi")
  await send(pi.steps.map((s) => s.message))
  await page.waitForTimeout(1200)
  check(await page.getByText("sub(a, b)").count() > 0, "recorded pi session replayed")
  await page.screenshot({ path: path.join(OUT, `conversation-pi-${scheme}.png`) })

  const ag = fixture("conversation-antigravity")
  await send(ag.steps.map((s) => s.message))
  await page.waitForTimeout(1000)
  await page.screenshot({ path: path.join(OUT, `conversation-antigravity-${scheme}.png`) })

  // ── Offline cache ──
  const cached = fixture("conversation-cached")
  await send(cached.steps.map((s) => s.message))
  await page.waitForTimeout(600)
  check(await page.getByRole("status").count() > 0, "conversation.cached shows the stale banner")
  await page.screenshot({ path: path.join(OUT, `conversation-cached-${scheme}.png`) })

  // ── Terminal ──
  const term = fixture("terminal")
  const termId = term.steps[0].message.terminal_id
  await send([term.steps[0].message])
  check(await waitOut(`(m) => m.type === 'term.attach' && m.terminal_id === '${termId}'`, "term.attach"), "view.terminal → term.attach {terminal_id, …}")
  await send(term.steps.slice(1).map((s) => s.message))
  await page.waitForTimeout(1200)
  const text = await page.evaluate(() => document.querySelector(".xterm-rows")?.textContent ?? "")
  check(text.includes("README.md") && text.includes("中文"), "terminal frames drawn by xterm.js")
  await page.screenshot({ path: path.join(OUT, `terminal-${scheme}.png`) })
  // Become the controller, then a key from native's bar.
  const lastControl = term.steps.findLast((s) => s.message.type === "term.control").message
  await send([{ ...lastControl, you: true, controller: { ...lastControl.controller, label: "iPhone" } }])
  await page.waitForTimeout(200)
  await send([{ v: 2, type: "term.key", key: "c", ctrl: true }, { v: 2, type: "term.key", key: "up" }])
  check(await waitOut(`(m) => m.type === 'term.input' && m.terminal_id === '${termId}' && m.data === 'Aw=='`, "term.input ^C"), "term.key {c, ctrl} → term.input \\x03")
  // zsh's line editor turns on application cursor keys (DECCKM): ESC O A, otherwise ESC [ A.
  check(await waitOut(`(m) => m.type === 'term.input' && ['\\x1bOA', '\\x1b[A'].includes(atob(m.data))`, "term.input up"), "term.key {up} → term.input (ESC O A in DECCKM)")

  // Back to a conversation: the terminal detaches.
  await send([show.steps[0].message])
  check(await waitOut(`(m) => m.type === 'term.detach' && m.terminal_id === '${termId}'`, "term.detach"), "leaving the terminal posts term.detach")

  const csp = errors.filter((e) => /Content Security Policy|Refused to/i.test(e))
  check(csp.length === 0, `no CSP violations (${csp.length})`)
  const other = errors.filter((e) => !csp.includes(e))
  if (other.length) console.log("  page errors:\n   " + other.slice(0, 10).join("\n   "))
  check(!errors.some((e) => e.startsWith("pageerror")), "no uncaught page errors")
  await context.close()
}

await browser.close()
console.log(`\nscreenshots: ${path.relative(process.cwd(), OUT)}/`)
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
