/**
 * The DSH plugin route (D5, contracts/dsh-bridge/3.0): one RuntimeHandle per connected DSH host.
 * A's `host/dsh-socket.ts` verifies the hello and hands over the paused socket; ACP ndjson runs on
 * it with the plugin as the Agent and this Connector as the Client (B's generic ACP engine).
 */
import type { Duplex } from 'node:stream'
import { AcpRuntimeHandle, peerConnection } from '../../../acp/handle.js'
import { JsonRpcPeer, ndjsonTransport } from '../../../acp/jsonrpc.js'
import { dshPluginDialect } from './dialect.js'

/** What the host-side listener verified (A's `DshHello`, contracts/dsh-bridge/3.0 `hello`). */
export interface DshHostHello {
  readonly hostInstance: string
  readonly hostKind: 'desktop' | 'web' | 'headless' | 'unknown'
  readonly dshVersion: string
  readonly pluginVersion: string
  readonly dshHome?: string
}

export interface DshPluginRoute {
  readonly hello: DshHostHello
  readonly handle: AcpRuntimeHandle
  /** Resolves when the host disconnects (plugin unloaded, DSH quit, replaced by a newer connection). */
  readonly closed: Promise<string>
}

/** Runs ACP on a verified host connection. `socket` may be paused with the bytes after the hello unshifted. */
export function dshPluginRoute(connection: { hello: DshHostHello, socket: Duplex }, instanceId: string): DshPluginRoute {
  const peer = new JsonRpcPeer(ndjsonTransport(connection.socket, connection.socket))
  connection.socket.resume()
  connection.socket.once('close', () => peer.close('DSH host disconnected'))
  const dialect = dshPluginDialect()
  const handle = new AcpRuntimeHandle({ type: 'dsh', instanceId, dialect, connect: peerConnection(peer, dialect), nativeInventory: true })
  return { hello: connection.hello, handle, closed: peer.whenClosed() }
}
