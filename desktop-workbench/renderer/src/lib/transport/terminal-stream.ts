// A device terminal's live stream behind one interface: the terminal WebSocket in normal mode, or a channel
// subscription (`TunnelSubscribe {stream: "terminal"}`) when the device's content is encrypted. Through the channel,
// input and resize are requests to the same paths as the REST API (`…/write`, `…/resize`).

import { contentTransportForDevice, type ContentRequest } from "./content-transport"

export type TerminalClientMessage = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number }

export type TerminalStream = {
  onopen: (() => void) | null
  onmessage: ((message: { data: unknown }) => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  /** Live and accepting input. */
  readonly isOpen: boolean
  send(message: TerminalClientMessage): void
  close(): void
}

/**
 * `basePath` is the namespaced `/connectors/{connectorId}/terminals-v2/{terminalId}`; `webSocketUrl` builds the
 * normal-mode stream URL (only called in normal mode).
 */
export function openTerminalStream(target: {
  connectorId: string
  terminalId: string
  basePath: string
  webSocketUrl: () => string
}): TerminalStream {
  const tunnel = contentTransportForDevice(target.connectorId, "GET", `${target.basePath}/stream`)
  if (tunnel?.openTerminalStream) {
    const events = tunnel.openTerminalStream(target.terminalId)
    let open = false
    // Keystrokes must arrive in order: one request at a time.
    let queue: Promise<unknown> = Promise.resolve()
    const stream: TerminalStream = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      get isOpen() {
        return open
      },
      send(message) {
        if (!open) return
        const request: ContentRequest =
          message.type === "input"
            ? { method: "POST", path: `${target.basePath}/write`, body: { dataBase64: message.data } }
            : { method: "POST", path: `${target.basePath}/resize`, body: { cols: message.cols, rows: message.rows } }
        queue = queue.then(() => tunnel.request(request)).catch(() => stream.onerror?.())
      },
      close() {
        open = false
        events.close()
      },
    }
    events.onopen = () => {
      open = true
      stream.onopen?.()
    }
    events.onmessage = (message) => stream.onmessage?.(message)
    events.onerror = () => stream.onerror?.()
    events.onclose = () => {
      open = false
      stream.onclose?.()
    }
    return stream
  }

  const socket = new WebSocket(target.webSocketUrl())
  const stream: TerminalStream = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    get isOpen() {
      return socket.readyState === WebSocket.OPEN
    },
    send(message) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    },
    close() {
      socket.close()
    },
  }
  socket.onopen = () => stream.onopen?.()
  socket.onmessage = (event) => stream.onmessage?.({ data: event.data })
  socket.onerror = () => stream.onerror?.()
  socket.onclose = () => stream.onclose?.()
  return stream
}
