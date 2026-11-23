// `TerminalTransport` over the MeshCall `aa.v3.Terminals.attach` duplex (Web, Desktop).

import { MeshCallError, UnauthenticatedError, type RpcDuplex } from "meshcall/web"

import type { DeviceTunnelManager } from "@/lib/mesh/device-tunnel"
import { PairingError } from "@/lib/mesh/pairing"
import type { TerminalLink, TerminalLinkHandlers, TerminalTransport } from "@/lib/terminal/session"
import type { DeviceRecord, TerminalInputFrame, TerminalOutputFrame } from "@/lib/types/v3"

const FATAL_CODES = new Set([
  "not_found",
  "permission_denied",
  "invalid_argument",
  "method_not_found",
  "failed_precondition",
])

/** Errors after which reconnecting cannot help: the terminal is gone or this client may not attach. */
export function isFatalAttachError(error: unknown): boolean {
  if (error instanceof PairingError) return true
  if (error instanceof UnauthenticatedError) return false // the tunnel is refreshed on the next attach
  return error instanceof MeshCallError && FATAL_CODES.has(error.code)
}

export function createMeshTerminalTransport(
  manager: Pick<DeviceTunnelManager, "attachTerminal">,
  device: Pick<DeviceRecord, "id" | "mode_hint" | "presence">
): TerminalTransport {
  return {
    attach(request, handlers: TerminalLinkHandlers): TerminalLink {
      const abort = new AbortController()
      let duplex: RpcDuplex<TerminalInputFrame, TerminalOutputFrame> | null = null
      // Frames sent before the duplex is open (a claim right after the first frame cannot happen, but keep order).
      const outbox: TerminalInputFrame[] = []
      let closed = false

      const fail = (error?: unknown) => {
        if (closed) return
        closed = true
        if (abort.signal.aborted) return
        const fatal = error != null && isFatalAttachError(error)
        // A stream dropped for falling behind (resource_exhausted) starts over from a snapshot.
        const snapshotNext = error instanceof MeshCallError && error.code === "resource_exhausted"
        handlers.closed({ error, fatal, snapshotNext })
      }

      void (async () => {
        try {
          duplex = await manager.attachTerminal(device, request, abort.signal)
          if (abort.signal.aborted) {
            void duplex.closeSend().catch(() => undefined)
            return
          }
          for (const frame of outbox.splice(0)) void duplex.send(frame).catch(() => undefined)
          for await (const frame of duplex) {
            if (abort.signal.aborted) return
            handlers.frame(frame)
          }
          fail()
        } catch (error) {
          fail(error)
        }
      })()

      return {
        send(frame) {
          if (closed || abort.signal.aborted) return
          if (!duplex) {
            outbox.push(frame)
            return
          }
          void duplex.send(frame).catch(() => undefined)
        },
        close() {
          if (abort.signal.aborted) return
          abort.abort()
          closed = true
          const d = duplex
          if (d) {
            void d.closeSend().catch(() => undefined)
            void d.cancel("detached").catch(() => undefined)
          }
        },
      }
    },
  }
}
