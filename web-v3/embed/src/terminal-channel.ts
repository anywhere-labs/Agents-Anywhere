// The terminal's side of the bridge: adapts `lib/terminal/bridge-transport.ts` (which speaks `term.*` with an `id`
// field) to `aa.render/2` (`terminal_id`, doc §2–§3), and maps native's extra-keys bar (`term.key`) to what the
// terminal should receive, with the same sequences as the Web row (`lib/terminal/keys.ts`).

import type { TerminalBridge } from "@/lib/terminal/bridge-transport"
import { applyCtrl, type ExtraKey, type KeyModifiers } from "@/lib/terminal/keys"

import type { Bridge } from "./bridge"
import type { NativeMessage, OutboundMessage, TermKeyMessage } from "./protocol"

const OUT_TYPES = new Set(["term.attach", "term.detach", "term.input", "term.resize", "term.claim", "term.release"])

/**
 * term.* frames for `terminalId` that arrive before the transport listens (a replay that sends frames right after
 * `view.terminal`) are held and handed over when it starts listening; they are not lost.
 */
export class TerminalChannel implements TerminalBridge {
  private readonly listeners = new Set<(type: string, payload: Record<string, unknown>) => void>()
  private held: NativeMessage[] = []
  private readonly off: () => void

  constructor(
    private readonly bridge: Pick<Bridge, "post" | "onAny">,
    readonly terminalId: string
  ) {
    this.off = bridge.onAny((m) => this.inbound(m))
  }

  dispose() {
    this.off()
    this.listeners.clear()
    this.held = []
  }

  post(type: string, payload: Record<string, unknown>) {
    if (!OUT_TYPES.has(type)) return
    const { id, ...rest } = payload
    this.bridge.post({ ...rest, type, terminal_id: typeof id === "string" ? id : this.terminalId } as OutboundMessage)
  }

  listen(handler: (type: string, payload: Record<string, unknown>) => void): () => void {
    this.listeners.add(handler)
    if (this.held.length) {
      const held = this.held
      this.held = []
      for (const m of held) this.deliver(m)
    }
    return () => void this.listeners.delete(handler)
  }

  private inbound(m: NativeMessage) {
    if (!m.type.startsWith("term.") || m.type === "term.key") return
    const target = (m as { terminal_id?: unknown }).terminal_id
    if (typeof target === "string" && target !== this.terminalId) return
    if (!this.listeners.size) {
      // Keep the latest snapshot and what follows it; bounded.
      if (m.type === "term.snapshot") this.held = []
      if (this.held.length < 2000) this.held.push(m)
      return
    }
    this.deliver(m)
  }

  private deliver(m: NativeMessage) {
    const { v: _v, type, terminal_id: _t, ...rest } = m as NativeMessage & { terminal_id?: string }
    void _v
    void _t
    // The transport filters by `id` when present.
    const payload: Record<string, unknown> = { ...rest, id: this.terminalId }
    for (const l of [...this.listeners]) l(type, payload)
  }
}

// ── term.key ───────────────────────────────────────────────────────────────────────────────────────────────────

const NAMED: Record<string, ExtraKey> = {
  escape: "escape",
  esc: "escape",
  tab: "tab",
  up: "up",
  arrowup: "up",
  down: "down",
  arrowdown: "down",
  left: "left",
  arrowleft: "left",
  right: "right",
  arrowright: "right",
  home: "home",
  end: "end",
  pageup: "pageUp",
  pgup: "pageUp",
  pagedown: "pageDown",
  pgdn: "pageDown",
}

const LITERAL: Record<string, string> = {
  enter: "\r",
  return: "\r",
  backspace: "\x7f",
  delete: "\x1b[3~",
  space: " ",
}

export type KeyAction =
  | { kind: "key"; key: ExtraKey; mods: KeyModifiers }
  | { kind: "text"; data: string }
  | { kind: "toggle_ctrl" }
  | { kind: "none" }

/** What a `term.key` from native means for the terminal. */
export function termKeyAction(m: Pick<TermKeyMessage, "key" | "ctrl" | "alt" | "shift">): KeyAction {
  const raw = m.key ?? ""
  const mods: KeyModifiers = { ctrl: !!m.ctrl, alt: !!m.alt, shift: !!m.shift }
  const name = raw.length > 1 ? raw.toLowerCase().replace(/[_\-\s]/g, "") : raw
  if (name === "ctrl" || name === "control") return { kind: "toggle_ctrl" }
  const named = NAMED[name]
  if (named) return { kind: "key", key: named, mods }
  let data = LITERAL[name]
  if (data === undefined) {
    // A single character (code point) from the bar, e.g. { key: "c", ctrl: true }.
    if ([...raw].length !== 1) return { kind: "none" }
    data = raw
  }
  if (mods.ctrl) data = applyCtrl(data)
  if (mods.alt) data = `\x1b${data}`
  return { kind: "text", data }
}
