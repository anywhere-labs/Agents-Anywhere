// `TerminalTransport` over a native ↔ WebView message bridge (mobile, docs/v3/terminal-proposal.md §6).
//
// Native → WebView: `term.snapshot`, `term.output`, `term.control`, `term.exit` (payload = the output frame's fields).
// WebView → native: `term.input`, `term.resize`, `term.claim`, `term.release` (payload = the input frame's fields).
//
// Beyond §6 (to be confirmed with the native side): `term.rejected` in (same as the frame), `term.closed` in
// (`{ fatal?, snapshot_next? }`, the native attach dropped), `term.attach` out (the attach request, so the native
// layer knows mode / size / resume_seq) and `term.detach` out. Every message may carry `id` = terminal id; messages
// for another terminal are ignored.

import type { TerminalLink, TerminalLinkHandlers, TerminalTransport } from "@/lib/terminal/session"
import type { TerminalAttachRequest, TerminalOutputFrame } from "@/lib/types/v3"

export interface TerminalBridge {
  post(type: string, payload: Record<string, unknown>): void
  /** Subscribe to native → WebView messages; returns an unsubscribe function. */
  listen(handler: (type: string, payload: Record<string, unknown>) => void): () => void
}

const INBOUND_FRAMES = new Set(["snapshot", "output", "control", "rejected", "exit"])

export function createBridgeTerminalTransport(bridge: TerminalBridge): TerminalTransport {
  return {
    attach(request: TerminalAttachRequest, handlers: TerminalLinkHandlers): TerminalLink {
      let open = true
      const unlisten = bridge.listen((type, payload) => {
        if (!open || !type.startsWith("term.")) return
        if (typeof payload.id === "string" && payload.id !== request.id) return
        const kind = type.slice("term.".length)
        if (INBOUND_FRAMES.has(kind)) {
          const { id: _id, ...fields } = payload
          void _id
          handlers.frame({ ...fields, type: kind } as TerminalOutputFrame)
        } else if (kind === "closed") {
          open = false
          unlisten()
          handlers.closed({ fatal: payload.fatal === true, snapshotNext: payload.snapshot_next === true })
        }
      })
      bridge.post("term.attach", { ...request })
      return {
        send(frame) {
          if (!open) return
          const { type, ...fields } = frame
          bridge.post(`term.${type}`, { id: request.id, ...fields })
        },
        close() {
          if (!open) return
          open = false
          unlisten()
          bridge.post("term.detach", { id: request.id })
        },
      }
    },
  }
}
