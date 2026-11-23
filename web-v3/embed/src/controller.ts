// The bundle's state, outside React: every native message is applied here the moment it arrives (a `batch` with
// `view.conversation` followed by its snapshot must not depend on a component having mounted), and React only
// subscribes. Tested without a DOM in tests/embed-bridge.test.ts.

import { TimelineStore } from "@/lib/timeline/store"
import type { Control, Message, Session } from "@/lib/types/v3"

import type { Bridge } from "./bridge"
import { FileCache } from "./file-cache"
import type {
  ConversationCachedMessage,
  Insets,
  NativeMessage,
  OutboundMessage,
  ThemeMessage,
  ViewConversationMessage,
  ViewTerminalMessage,
} from "./protocol"
import { TerminalChannel, termKeyAction, type KeyAction } from "./terminal-channel"

export interface Appearance {
  scheme: "light" | "dark"
  insets: Insets
  fontScale: number
  reduceMotion: boolean
  highContrast: boolean
}

export type View =
  | { kind: "none" }
  | {
      kind: "conversation"
      device_id: string
      session_id: string
      agent: string
      readonly: boolean
      encrypted: boolean
      me: string
      /** Showing `conversation.cached`: read-only and marked stale until a live snapshot arrives. */
      stale: boolean
      /** A snapshot or a cache has arrived. */
      loaded: boolean
    }
  | {
      kind: "terminal"
      device_id: string
      terminal_id: string
      label: string
      attach_mode: "view" | "control"
      term_mode: "pty" | "pipe" | "script"
      owner: "user" | "agent"
      cols: number
      rows: number
      /** Bumped per `view.terminal`, so re-opening the same terminal remounts it. */
      nonce: number
    }

export interface EmbedState {
  appearance: Appearance
  locale: "zh-CN" | "en"
  view: View
}

export type ScrollRequest = { to: "top" | "bottom"; at: number }

const LOAD_OLDER_TIMEOUT_MS = 15_000

function initialScheme(): "light" | "dark" {
  try {
    return globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  } catch {
    return "light"
  }
}

function initialLocale(): "zh-CN" | "en" {
  const lang = (globalThis.navigator?.language ?? "zh-CN").toLowerCase()
  return lang.startsWith("en") ? "en" : "zh-CN"
}

const EMPTY_CONTROL: Control = { state: "disconnected", steer: "none", pending: [], queued: [] }

function cachedSession(view: Extract<View, { kind: "conversation" }>, messages: Message[]): Session {
  const at = messages.at(-1)?.created_at ?? new Date(0).toISOString()
  return {
    id: view.session_id,
    title: "",
    agent: view.agent,
    device: { id: view.device_id, name: "" },
    cwd: "",
    created_at: messages[0]?.created_at ?? at,
    updated_at: at,
    message_count: messages.length,
    config: [],
  }
}

export class EmbedController {
  readonly store = new TimelineStore()
  readonly files: FileCache
  private state: EmbedState
  private readonly listeners = new Set<() => void>()
  private readonly scrollListeners = new Set<(r: ScrollRequest) => void>()
  private readonly keyListeners = new Set<(a: KeyAction) => void>()
  private terminal: TerminalChannel | null = null
  private olderTimer: ReturnType<typeof setTimeout> | null = null
  private terminalNonce = 0
  private lastScrollState: { at_bottom: boolean; distance: number } | null = null
  private readonly offs: (() => void)[] = []

  constructor(private readonly bridge: Bridge) {
    this.files = new FileCache({ post: (m) => this.post(m) })
    this.state = {
      appearance: { scheme: initialScheme(), insets: { top: 0, bottom: 0, left: 0, right: 0 }, fontScale: 1, reduceMotion: false, highContrast: false },
      locale: initialLocale(),
      view: { kind: "none" },
    }
    this.offs.push(bridge.onAny((m) => this.handle(m)))
  }

  dispose() {
    for (const off of this.offs) off()
    this.terminal?.dispose()
    this.files.clear()
  }

  // ── Subscription ──

  getState = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  onScrollRequest(listener: (r: ScrollRequest) => void) {
    this.scrollListeners.add(listener)
    return () => void this.scrollListeners.delete(listener)
  }
  onTermKey(listener: (a: KeyAction) => void) {
    this.keyListeners.add(listener)
    return () => void this.keyListeners.delete(listener)
  }

  private set(next: Partial<EmbedState>) {
    this.state = { ...this.state, ...next }
    for (const l of [...this.listeners]) l()
  }

  private setView(view: View) {
    this.set({ view })
  }

  post(message: OutboundMessage) {
    this.bridge.post(message)
  }

  // ── Native → web ──

  private handle(m: NativeMessage) {
    switch (m.type) {
      case "theme":
        return this.applyTheme(m)
      case "locale":
        if (m.locale === "en" || m.locale === "zh-CN") this.set({ locale: m.locale })
        return
      case "view.conversation":
        return this.openConversation(m)
      case "conversation.event": {
        const v = this.state.view
        if (v.kind !== "conversation" || v.session_id !== m.session_id || !m.event) return
        this.store.apply(m.event)
        if (m.event.type === "snapshot" && (v.stale || !v.loaded)) this.setView({ ...v, stale: false, loaded: true })
        return
      }
      case "conversation.older": {
        const v = this.state.view
        if (v.kind !== "conversation" || v.session_id !== m.session_id) return
        this.clearOlderTimer()
        const older = m.messages ?? []
        // An empty page ends the paging even if it says otherwise (no request loop on a confused native side).
        this.store.prependOlder(older, !!m.has_more && older.length > 0)
        return
      }
      case "conversation.cached":
        return this.applyCached(m)
      case "file.data":
        return this.files.handle(m)
      case "view.terminal":
        return this.openTerminal(m)
      case "term.key": {
        if (this.state.view.kind !== "terminal") return
        const action = termKeyAction(m)
        if (action.kind === "none") return
        for (const l of [...this.keyListeners]) l(action)
        return
      }
      case "scroll":
        if (m.to !== "top" && m.to !== "bottom") return
        for (const l of [...this.scrollListeners]) l({ to: m.to, at: Date.now() })
        return
      default:
        // term.* frames go to the TerminalChannel through its own onAny subscription.
        return
    }
  }

  private applyTheme(m: ThemeMessage) {
    const prev = this.state.appearance
    const insets = m.insets ?? prev.insets
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0)
    this.set({
      appearance: {
        scheme: m.scheme === "dark" ? "dark" : "light",
        insets: { top: num(insets.top), bottom: num(insets.bottom), left: num(insets.left), right: num(insets.right) },
        fontScale: typeof m.font_scale === "number" && m.font_scale > 0 ? Math.min(3, Math.max(0.5, m.font_scale)) : 1,
        reduceMotion: !!m.reduce_motion,
        highContrast: !!m.high_contrast,
      },
    })
  }

  private openConversation(m: ViewConversationMessage) {
    this.closeTerminal()
    this.clearOlderTimer()
    this.store.reset()
    this.files.clear()
    this.lastScrollState = null
    this.setView({
      kind: "conversation",
      device_id: m.device_id,
      session_id: m.session_id,
      agent: m.agent,
      readonly: !!m.readonly,
      encrypted: !!m.encrypted,
      me: typeof m.me === "string" ? m.me : "",
      stale: false,
      loaded: false,
    })
  }

  private applyCached(m: ConversationCachedMessage) {
    const v = this.state.view
    if (v.kind !== "conversation" || v.session_id !== m.session_id) return
    const messages = m.messages ?? []
    // Offline: what native cached replaces whatever was shown; no paging back while offline.
    this.store.reset()
    this.store.apply({ type: "snapshot", session: cachedSession(v, messages), messages, has_more: false, control: m.control ?? EMPTY_CONTROL })
    this.setView({ ...v, stale: true, loaded: true })
  }

  private openTerminal(m: ViewTerminalMessage) {
    this.closeTerminal()
    this.clearOlderTimer()
    this.store.reset()
    this.files.clear()
    this.terminal = new TerminalChannel(this.bridge, m.terminal_id)
    this.setView({
      kind: "terminal",
      device_id: m.device_id,
      terminal_id: m.terminal_id,
      label: m.controller_label ?? "",
      attach_mode: m.attach_mode === "control" ? "control" : "view",
      term_mode: m.term_mode ?? "pty",
      owner: m.owner === "agent" ? "agent" : "user",
      cols: m.cols && m.cols > 0 ? m.cols : 80,
      rows: m.rows && m.rows > 0 ? m.rows : 24,
      nonce: ++this.terminalNonce,
    })
  }

  private closeTerminal() {
    this.terminal?.dispose()
    this.terminal = null
  }

  /** The bridge the current terminal view's transport uses. */
  terminalChannel(): TerminalChannel | null {
    return this.terminal
  }

  // ── Web → native ──

  private conversation() {
    const v = this.state.view
    return v.kind === "conversation" ? v : null
  }

  /** Whether the thread may answer approvals itself (`answer`). */
  canAnswer() {
    const v = this.conversation()
    return !!v && !v.readonly && !v.stale
  }

  answer(request_id: string, option_id: string) {
    const v = this.conversation()
    if (!v || !this.canAnswer()) return
    this.post({ type: "answer", session_id: v.session_id, request_id, option_id })
  }

  /** Ask for the page before the oldest item shown (once at a time; given up after a while). */
  loadOlder(): boolean {
    const v = this.conversation()
    const s = this.store.get()
    if (!v || v.stale || !s.has_more || s.loadingOlder || !s.messages.length) return false
    this.store.setLoadingOlder(true)
    this.post({ type: "load_older", session_id: v.session_id, before_seq: s.messages[0].seq })
    this.olderTimer = setTimeout(() => {
      this.olderTimer = null
      this.store.setLoadingOlder(false)
    }, LOAD_OLDER_TIMEOUT_MS)
    return true
  }

  private clearOlderTimer() {
    if (this.olderTimer) clearTimeout(this.olderTimer)
    this.olderTimer = null
  }

  /** Links never navigate inside the WebView: web links go to the system, file links (and paths) to native's file page. */
  openLink(url: string) {
    const file = fileLink(url)
    if (file) this.post({ type: "open_file", ...file })
    else this.post({ type: "open_link", url })
  }

  openFile(path: string, line?: number) {
    this.post({ type: "open_file", path, ...(line && line > 0 ? { line } : {}) })
  }

  copy(text: string) {
    this.post({ type: "copy", text })
  }

  haptic(style: "light" | "medium" | "success" | "warning") {
    this.post({ type: "haptic", kind: style === "medium" ? "warning" : style })
  }

  /** `scroll_state`, only when it changes enough to matter (at_bottom flips, or 24 px). */
  reportScroll(at_bottom: boolean, distance: number) {
    const d = Math.max(0, Math.round(distance))
    const last = this.lastScrollState
    if (last && last.at_bottom === at_bottom && Math.abs(last.distance - d) < 24) return
    this.lastScrollState = { at_bottom, distance: d }
    this.post({ type: "scroll_state", at_bottom, distance: d })
  }
}

/** `file:///abs/path#L12` (agents link files this way) → open_file. */
export function fileLink(url: string): { path: string; line?: number } | null {
  if (!url.startsWith("file://")) return null
  try {
    const u = new URL(url)
    const path = decodeURIComponent(u.pathname)
    const line = /^#L(\d+)/.exec(u.hash)?.[1]
    return line ? { path, line: Number(line) } : { path }
  } catch {
    return null
  }
}
