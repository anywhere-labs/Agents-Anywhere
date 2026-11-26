// The bundle's end of `aa.render/2` (docs/v3/mobile-bridge.md §1): picks the channel the page runs in, posts web →
// native messages, unpacks native → web messages (`batch` included) and routes them by type. Framework-free so it is
// tested without a DOM (tests/embed-bridge.test.ts).

import {
  NATIVE_TYPES,
  PROTOCOL,
  PROTOCOL_VERSION,
  type NativeMessage,
  type NativeMessageOf,
  type NativeMessageType,
  type OutboundMessage,
  type WebMessage,
} from "./protocol"

export type Channel = "ios" | "android" | "browser" | "none"

/** The globals the channels live on (window in the page; a fake in tests). */
export interface BridgeHost {
  webkit?: { messageHandlers?: { aa?: { postMessage(message: unknown): void } } }
  AndroidAA?: { postMessage(json: string): void }
  parent?: { postMessage(message: unknown, targetOrigin: string): void } | unknown
  addEventListener?(type: "message", listener: (event: { data: unknown; source?: unknown }) => void): void
  removeEventListener?(type: "message", listener: (event: { data: unknown; source?: unknown }) => void): void
  aa?: { receive(message: unknown): void; bridge?: Bridge }
}

export function detectChannel(host: BridgeHost): Channel {
  if (host.webkit?.messageHandlers?.aa) return "ios"
  if (host.AndroidAA && typeof host.AndroidAA.postMessage === "function") return "android"
  if (host.addEventListener) return "browser"
  return "none"
}

type Handler<T extends NativeMessageType> = (message: NativeMessageOf<T>) => void
type AnyHandler = (message: NativeMessage) => void

const nativeTypes = new Set<string>(NATIVE_TYPES)

export interface BridgeOptions {
  host: BridgeHost
  version: string
  capabilities: readonly string[]
  /** Override the detected channel (tests). */
  channel?: Channel
  /** Report a dropped message (bad JSON, wrong version). Default: console.warn. */
  onDrop?: (reason: string, raw: unknown) => void
}

export class Bridge {
  readonly channel: Channel
  private readonly host: BridgeHost
  private readonly handlers = new Map<string, Set<AnyHandler>>()
  private readonly any = new Set<AnyHandler>()
  private readonly opts: BridgeOptions
  private readyPosted = false
  private onWindowMessage?: (event: { data: unknown; source?: unknown }) => void

  constructor(opts: BridgeOptions) {
    this.opts = opts
    this.host = opts.host
    this.channel = opts.channel ?? detectChannel(opts.host)
  }

  /** Install `window.aa.receive` (and the browser `message` listener). Call once, before `ready`. */
  install(): this {
    const receive = (message: unknown) => this.receive(message)
    this.host.aa = { receive, bridge: this }
    if (this.channel === "browser" && this.host.addEventListener) {
      this.onWindowMessage = (event) => this.receive(event.data)
      this.host.addEventListener("message", this.onWindowMessage)
    }
    return this
  }

  uninstall() {
    if (this.onWindowMessage) this.host.removeEventListener?.("message", this.onWindowMessage)
    if (this.host.aa?.bridge === this) delete this.host.aa
  }

  /** The handshake (doc §1): native sends nothing else before this. Posted once. */
  ready() {
    if (this.readyPosted) return
    this.readyPosted = true
    this.post({ type: "ready", version: this.opts.version, protocol: PROTOCOL, capabilities: [...this.opts.capabilities] })
  }

  get isReady() {
    return this.readyPosted
  }

  post(message: OutboundMessage) {
    const full = { v: PROTOCOL_VERSION, ...message } as WebMessage
    const host = this.host
    switch (this.channel) {
      case "ios":
        host.webkit!.messageHandlers!.aa!.postMessage(full)
        return
      case "android":
        host.AndroidAA!.postMessage(JSON.stringify(full))
        return
      case "browser": {
        const parent = host.parent as { postMessage?: (m: unknown, o: string) => void } | undefined
        parent?.postMessage?.(full, "*")
        return
      }
      case "none":
        return
    }
  }

  on<T extends NativeMessageType>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type)
    if (!set) this.handlers.set(type, (set = new Set()))
    set.add(handler as AnyHandler)
    return () => void set.delete(handler as AnyHandler)
  }

  /** Every native message after batch unpacking (term.* go to the terminal transport this way). */
  onAny(handler: AnyHandler): () => void {
    this.any.add(handler)
    return () => void this.any.delete(handler)
  }

  /** `window.aa.receive`: an object, or its JSON. `batch` is unpacked in order. */
  receive(raw: unknown) {
    let message: unknown = raw
    if (typeof raw === "string") {
      try {
        message = JSON.parse(raw)
      } catch {
        this.drop("invalid JSON", raw)
        return
      }
    }
    if (!message || typeof message !== "object") return this.drop("not an object", raw)
    const m = message as { v?: unknown; type?: unknown; messages?: unknown }
    if (typeof m.type !== "string") return this.drop("no type", raw)
    // Our own outbound message echoed back (browser debug at top level: parent === window).
    if (!nativeTypes.has(m.type)) return
    if (m.v !== PROTOCOL_VERSION) return this.drop(`unsupported version ${String(m.v)}`, raw)
    if (m.type === "batch") {
      if (!Array.isArray(m.messages)) return this.drop("batch without messages", raw)
      for (const inner of m.messages) this.receive(inner)
      return
    }
    this.dispatch(message as NativeMessage)
  }

  private dispatch(message: NativeMessage) {
    for (const h of [...this.any]) this.safely(h, message)
    const set = this.handlers.get(message.type)
    if (set) for (const h of [...set]) this.safely(h, message)
  }

  private safely(h: AnyHandler, message: NativeMessage) {
    try {
      h(message)
    } catch (error) {
      // One bad handler must not stop the rest of a batch.
      console.error(`[aa.render] handler for ${message.type} failed`, error)
    }
  }

  private drop(reason: string, raw: unknown) {
    ;(this.opts.onDrop ?? ((r: string) => console.warn(`[aa.render] dropped message: ${r}`)))(reason, raw)
  }
}
