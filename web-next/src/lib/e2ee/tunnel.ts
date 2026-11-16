// The client's side of `WS /api/v3/tunnel` (contracts/e2ee/1.0 ClientTunnelFrame / ClientTunnelEnd): one socket
// carries every channel of this client; the Server only reads `route` and `n` and forwards them to the device.

import type { ChannelItem, ChannelWire } from "./transport"

export interface TunnelRoute {
  readonly deviceId: string
  readonly clientId: string
  readonly ch: string
}

/** What the tunnel needs from a WebSocket; `WebSocket` satisfies it. */
export interface TunnelSocket {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code?: number }) => void) | null
  onerror: ((event: unknown) => void) | null
  onopen: ((event: unknown) => void) | null
}

export interface ChannelSink {
  receive(item: ChannelItem): void
  ended(code: string): void
}

const OPEN = 1
const routeKey = (route: TunnelRoute) => `${route.deviceId}\n${route.clientId}\n${route.ch}`

/** Multiplexes channels over one tunnel socket; reopens the socket lazily after it drops. */
export class TunnelMux {
  readonly #open: () => Promise<TunnelSocket>
  #socket: Promise<TunnelSocket> | null = null
  readonly #sinks = new Map<string, ChannelSink>()

  constructor(open: () => Promise<TunnelSocket>) {
    this.#open = open
  }

  /** The wire for one channel; incoming items for `route` go to `sink`. */
  wire(route: TunnelRoute, sink: ChannelSink): ChannelWire {
    const key = routeKey(route)
    this.#sinks.set(key, sink)
    return {
      send: async (item) => {
        const socket = await this.#connected()
        socket.send(JSON.stringify({ t: "tun", route, n: item.n, ct: item.ct }))
      },
      end: (code = "closed") => {
        if (this.#sinks.get(key) !== sink) return
        this.#sinks.delete(key)
        void this.#socket?.then((socket) => {
          if (socket.readyState === OPEN) socket.send(JSON.stringify({ t: "end", route, code }))
        }).catch(() => undefined)
      },
    }
  }

  close(): void {
    const socket = this.#socket
    this.#socket = null
    void socket?.then((value) => value.close(1000)).catch(() => undefined)
    this.#endAll("closed")
  }

  #connected(): Promise<TunnelSocket> {
    this.#socket ??= this.#connect()
    return this.#socket
  }

  async #connect(): Promise<TunnelSocket> {
    let socket: TunnelSocket
    try {
      socket = await this.#open()
    } catch (error) {
      this.#socket = null
      throw error
    }
    const ready = new Promise<TunnelSocket>((resolve, reject) => {
      if (socket.readyState === OPEN) resolve(socket)
      socket.onopen = () => resolve(socket)
      socket.onerror = () => reject(new Error("tunnel socket failed"))
      socket.onclose = (event) => {
        reject(new Error("tunnel socket closed"))
        this.#socket = null
        // 1008 is the Server's E2EE refusal; any other close looks like the device going away.
        this.#endAll(event?.code === 1008 ? "e2ee_required" : "connector_offline")
      }
    })
    socket.onmessage = (event) => this.#dispatch(event.data)
    try {
      return await ready
    } catch (error) {
      this.#socket = null
      throw error
    }
  }

  #dispatch(data: unknown): void {
    if (typeof data !== "string") return
    let frame: { t?: string; route?: TunnelRoute; n?: number; ct?: string; code?: string }
    try {
      frame = JSON.parse(data)
    } catch {
      return
    }
    if (!frame.route) return
    const key = routeKey(frame.route)
    const sink = this.#sinks.get(key)
    if (!sink) return
    if (frame.t === "tun" && typeof frame.n === "number" && typeof frame.ct === "string") sink.receive({ n: frame.n, ct: frame.ct })
    else if (frame.t === "end") {
      this.#sinks.delete(key)
      sink.ended(typeof frame.code === "string" ? frame.code : "closed")
    }
  }

  #endAll(code: string): void {
    const sinks = [...this.#sinks.values()]
    this.#sinks.clear()
    for (const sink of sinks) sink.ended(code)
  }
}
