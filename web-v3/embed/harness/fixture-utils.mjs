// Helpers shared by the dev harness (embed/harness) and the headless smoke test (embed/scripts/smoke.mjs) to play a
// fixture the way native would.

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/
const TIME_KEYS = new Set(["created_at", "updated_at", "started_at", "ended_at", "at", "since"])

function walk(value, fn) {
  if (Array.isArray(value)) return value.map((v) => walk(v, fn))
  if (value && typeof value === "object") {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = TIME_KEYS.has(k) && typeof v === "string" && ISO.test(v) ? fn(v) : walk(v, fn)
    return out
  }
  return value
}

/**
 * Shift every timestamp in a fixture so its latest one is `now`: durations ("用时 3 秒") stay as recorded and running
 * steps do not read "运行中 · 461 分".
 */
export function rebaseTimes(fixture, now = Date.now()) {
  let latest = 0
  walk(fixture, (v) => {
    latest = Math.max(latest, Date.parse(v))
    return v
  })
  if (!latest) return fixture
  const delta = now - latest
  return walk(fixture, (v) => new Date(Date.parse(v) + delta).toISOString())
}

/** Native's answer to `load_older`: up to `page_size` of the fixture's older items before `before_seq`. */
export function olderPage(fixture, request) {
  const older = fixture.responders?.older ?? { messages: [], page_size: 0 }
  const before = older.messages.filter((m) => m.seq < request.before_seq)
  const page = older.page_size > 0 ? before.slice(-older.page_size) : []
  return { v: 2, type: "conversation.older", session_id: request.session_id, messages: page, has_more: before.length > page.length }
}

/** Native's answer to `file.read`. */
export function fileData(fixture, request) {
  const file = fixture.responders?.files?.[request.path]
  return file
    ? { v: 2, type: "file.data", request_id: request.request_id, ok: true, base64: file.base64, mime: file.mime }
    : { v: 2, type: "file.data", request_id: request.request_id, ok: false, error: "not_found" }
}
