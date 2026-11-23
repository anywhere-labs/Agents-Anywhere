// `aa.render/2`: the bridge between the native iOS / Android apps and this WebView render bundle
// (docs/v3/mobile-bridge.md). This file is the single source of truth for the wire format: native code mirrors it,
// and `embed/protocol.schema.json` is generated from it (`corepack yarn embed:schema`).
//
// Channels (doc §1):
//   web → native   iOS      window.webkit.messageHandlers.aa.postMessage(obj)
//                  Android  window.AndroidAA.postMessage(JSON.stringify(obj))
//                  browser  window.parent.postMessage(obj, "*")
//   native → web   iOS / Android  window.aa.receive(<json>)      browser  window.postMessage(obj, "*")
//
// Every message is `{ v: 2, type, ... }`, snake_case fields, bytes as standard base64. The bundle posts `ready` first;
// native queues everything until it has seen `ready`, and coalesces one frame's (~16 ms) messages into one `batch`.
// Unknown `type`s are ignored on both sides (forward compatible); a message with another `v` is dropped.

import type {
  Control,
  Message,
  TerminalController,
  TerminalRejectReason,
  WatchEvent,
} from "../../lib/types/v3"

export type { Control, Message, WatchEvent }

export const PROTOCOL = "aa.render/2"
export const PROTOCOL_VERSION = 2

/** What this bundle can do, sent in `ready.capabilities`. Native may hide features the bundle does not list. */
export const CAPABILITIES = [
  "batch",
  "theme",
  "locale",
  "conversation",
  "conversation.cached",
  "load_older",
  "answer",
  "file.read",
  "scroll",
  "scroll_state",
  "terminal",
  "term.key",
  "open_link",
  "open_file",
  "copy",
  "haptic",
] as const
export type Capability = (typeof CAPABILITIES)[number]

interface Envelope<T extends string> {
  /** Always 2. */
  v: 2
  type: T
}

// ── Native → web (doc §2) ──────────────────────────────────────────────────────────────────────────────────────

export interface Insets {
  top: number
  bottom: number
  left: number
  right: number
}

/** Appearance and the safe area covered by native glass controls (CSS px); re-sent whenever it changes. */
export interface ThemeMessage extends Envelope<"theme"> {
  scheme: "light" | "dark"
  insets: Insets
  /** Dynamic Type / font scale; 1 = default (16 px root). */
  font_scale?: number
  reduce_motion?: boolean
  high_contrast?: boolean
}

export interface LocaleMessage extends Envelope<"locale"> {
  locale: "zh-CN" | "en"
}

/** Switch to a conversation: the page clears and waits for a `conversation.event` snapshot (or `conversation.cached`). */
export interface ViewConversationMessage extends Envelope<"view.conversation"> {
  device_id: string
  session_id: string
  agent: string
  /** No approvals from the thread (e.g. a viewer without answer rights); native still shows its own dock. */
  readonly: boolean
  encrypted: boolean
  /** Extension: the reader's account name (`author` / `answered.by` equal to it read "你" and are not labelled). */
  me?: string
}

/** One `aa.v3.Sessions/watch` WatchEvent, forwarded as is (`snapshot` / `message` / `item` / `session` / `control`). */
export interface ConversationEventMessage extends Envelope<"conversation.event"> {
  session_id: string
  event: WatchEvent
}

/** The answer to `load_older`: items before `before_seq`, oldest first. */
export interface ConversationOlderMessage extends Envelope<"conversation.older"> {
  session_id: string
  messages: Message[]
  has_more: boolean
}

/** Offline: what native cached, drawn read-only and marked stale until a live snapshot replaces it. */
export interface ConversationCachedMessage extends Envelope<"conversation.cached"> {
  session_id: string
  messages: Message[]
  control: Control | null
  stale: true
}

/** The answer to `file.read`. */
export interface FileDataMessage extends Envelope<"file.data"> {
  request_id: string
  ok: boolean
  /** The bytes (standard base64) when ok. */
  base64?: string
  mime?: string
  error?: string
}

/** Switch to a terminal. The bundle then posts `term.attach`. */
export interface ViewTerminalMessage extends Envelope<"view.terminal"> {
  device_id: string
  terminal_id: string
  /** The name this client reports as controller when it attaches (`attach.label`). */
  controller_label?: string
  /** Extension: "control" when this device just created the terminal (doc terminal-proposal §3). Default "view". */
  attach_mode?: "view" | "control"
  /** Extension: `TerminalInfo.mode`; "pipe" / "script" show the "no full-screen programs" note. Default "pty". */
  term_mode?: "pty" | "pipe" | "script"
  /** Extension: `TerminalInfo.owner`; "agent" terminals are read-only. Default "user". */
  owner?: "user" | "agent"
  /** Extension: the size from `TerminalInfo`, used until the snapshot arrives. */
  cols?: number
  rows?: number
}

/** Fields every `term.*` message from native may carry: the terminal it is about (others are ignored). */
interface TermTarget {
  terminal_id?: string
}

/** `aa.v3.Terminals/attach` output frames, forwarded (data = base64). */
export interface TermSnapshotMessage extends Envelope<"term.snapshot">, TermTarget {
  data: string
  seq: number
  cols: number
  rows: number
}
export interface TermOutputMessage extends Envelope<"term.output">, TermTarget {
  data: string
  seq: number
}
export interface TermControlMessage extends Envelope<"term.control">, TermTarget {
  controller: TerminalController | null
  generation: number
  you: boolean
  cols: number
  rows: number
}
export interface TermRejectedMessage extends Envelope<"term.rejected">, TermTarget {
  reason: TerminalRejectReason
  generation: number
}
export interface TermExitMessage extends Envelope<"term.exit">, TermTarget {
  exit_code: number | null
  exit_signal?: string | null
}
/** Native's attach ended. `fatal`: do not reconnect. `snapshot_next`: the stream fell behind, start from a snapshot. */
export interface TermClosedMessage extends Envelope<"term.closed">, TermTarget {
  fatal?: boolean
  snapshot_next?: boolean
}

/**
 * A key from native's extra-keys bar. `key`: escape, tab, up, down, left, right, home, end, page_up, page_down, a
 * single character (sent with `ctrl` / `alt`), or `ctrl` alone to latch Ctrl for the next typed character.
 */
export interface TermKeyMessage extends Envelope<"term.key"> {
  key: string
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
}

/** A native button (e.g. "back to bottom"). */
export interface ScrollMessage extends Envelope<"scroll"> {
  to: "bottom" | "top"
}

export interface BatchMessage extends Envelope<"batch"> {
  messages: NativeMessage[]
}

export type NativeMessage =
  | ThemeMessage
  | LocaleMessage
  | ViewConversationMessage
  | ConversationEventMessage
  | ConversationOlderMessage
  | ConversationCachedMessage
  | FileDataMessage
  | ViewTerminalMessage
  | TermSnapshotMessage
  | TermOutputMessage
  | TermControlMessage
  | TermRejectedMessage
  | TermExitMessage
  | TermClosedMessage
  | TermKeyMessage
  | ScrollMessage
  | BatchMessage

// ── Web → native (doc §3) ──────────────────────────────────────────────────────────────────────────────────────

export interface ReadyMessage extends Envelope<"ready"> {
  /** The bundle's version (web-v3 package version). */
  version: string
  protocol: typeof PROTOCOL
  capabilities: string[]
}

export interface LoadOlderMessage extends Envelope<"load_older"> {
  session_id: string
  before_seq: number
}

export interface AnswerMessage extends Envelope<"answer"> {
  session_id: string
  request_id: string
  option_id: string
}

export interface OpenLinkMessage extends Envelope<"open_link"> {
  url: string
}

export interface OpenFileMessage extends Envelope<"open_file"> {
  path: string
  line?: number
}

export interface FileReadMessage extends Envelope<"file.read"> {
  request_id: string
  path: string
  max_bytes?: number
}

export interface CopyMessage extends Envelope<"copy"> {
  text: string
}

export interface HapticMessage extends Envelope<"haptic"> {
  kind: "light" | "success" | "warning"
}

export interface ScrollStateMessage extends Envelope<"scroll_state"> {
  at_bottom: boolean
  /** CSS px from the bottom of the thread. */
  distance: number
}

export interface TermAttachMessage extends Envelope<"term.attach"> {
  terminal_id: string
  mode?: "view" | "control"
  cols?: number
  rows?: number
  /** Last output seq rendered: native resumes the attach from there (doc terminal-proposal §4). */
  resume_seq?: number
  label?: string
}

export interface TermDetachMessage extends Envelope<"term.detach"> {
  terminal_id: string
}

export interface TermInputMessage extends Envelope<"term.input"> {
  terminal_id: string
  /** base64 */
  data: string
  generation: number
}

export interface TermResizeMessage extends Envelope<"term.resize"> {
  terminal_id: string
  cols: number
  rows: number
  generation: number
}

export interface TermClaimMessage extends Envelope<"term.claim"> {
  terminal_id: string
  cols?: number
  rows?: number
  keep_size?: boolean
}

export interface TermReleaseMessage extends Envelope<"term.release"> {
  terminal_id: string
}

export type WebMessage =
  | ReadyMessage
  | LoadOlderMessage
  | AnswerMessage
  | OpenLinkMessage
  | OpenFileMessage
  | FileReadMessage
  | CopyMessage
  | HapticMessage
  | ScrollStateMessage
  | TermAttachMessage
  | TermDetachMessage
  | TermInputMessage
  | TermResizeMessage
  | TermClaimMessage
  | TermReleaseMessage

/** Every message on the bridge, either way (the JSON Schema's root). */
export type BridgeMessage = NativeMessage | WebMessage

export type NativeMessageType = NativeMessage["type"]
export type WebMessageType = WebMessage["type"]

/** Types only native sends: a page that receives its own outbound message (browser debug, top level) ignores it. */
export const NATIVE_TYPES: readonly NativeMessageType[] = [
  "theme",
  "locale",
  "view.conversation",
  "conversation.event",
  "conversation.older",
  "conversation.cached",
  "file.data",
  "view.terminal",
  "term.snapshot",
  "term.output",
  "term.control",
  "term.rejected",
  "term.exit",
  "term.closed",
  "term.key",
  "scroll",
  "batch",
]

export const WEB_TYPES: readonly WebMessageType[] = [
  "ready",
  "load_older",
  "answer",
  "open_link",
  "open_file",
  "file.read",
  "copy",
  "haptic",
  "scroll_state",
  "term.attach",
  "term.detach",
  "term.input",
  "term.resize",
  "term.claim",
  "term.release",
]

/** Distributes Omit over a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A web → native message without its `v` (the bridge stamps it). */
export type OutboundMessage = DistributiveOmit<WebMessage, "v">

export type NativeMessageOf<T extends NativeMessageType> = Extract<NativeMessage, { type: T }>
