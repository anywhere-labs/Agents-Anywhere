/**
 * What a secure channel calls once a client is authorised: the same client API as normal mode (contracts/e2ee/1.0
 * README, channel messages section). The adapter that maps paths to Conversation use cases implements this; Conversation itself
 * receives the authenticated caller identity from the MeshCall content service.
 */

import type { ClientServerFacts } from '../../generated/device-meshcall/v1_0/client-call-request.js'
import type { CommandAck } from '../../generated/device-meshcall/v1_0/command-ack.js'

export interface ChannelCaller {
  readonly clientId: string
  readonly label: string
  readonly platform: string | null
  /**
   * An Agent acting for a supervisor session (agent collaboration): set by the Server from a delegation token
   * (`ClientCaller.agent`), by the device's own collaboration tools in-process, or from the request of an `agent`
   * channel client. `supervisionId`: the request is a supervision wake.
   */
  readonly agent?: AgentActor | null
}

export interface AgentActor {
  readonly deviceId: string
  readonly sessionId: string
  readonly grantId: string
  readonly supervisionId?: string | null
}

export interface TunnelApiRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly body: unknown
}

export interface TunnelApiResponse {
  readonly status: number
  readonly body: unknown
  /** A text body's media type (`text/markdown; charset=utf-8`); absent for JSON. */
  readonly contentType?: string
}

/**
 * Per-request facts of a normal-mode `Client/call` (contracts/device-meshcall/1.0, Client section); a request
 * through a secure channel has none.
 */
export interface TunnelCallContext {
  /** The receipt identity of a command route: the inbox runs (or replays) the request's command under it. */
  readonly command?: { readonly commandId: string; readonly inputDigest: string; readonly deadline: string }
  /** Facts the Server owns; they win over the body. */
  readonly server?: ClientServerFacts
  /** Called with the ack of the request's command once the inbox settled (or replayed) it. */
  readonly onCommand?: (commandId: string, ack: CommandAck) => void
}

export interface TunnelSubscription {
  /** `session` (the session WebSocket) or `terminal` (`terminals-v2/{terminalId}/stream`); default session. */
  readonly stream?: 'session' | 'terminal'
  /** The session of a `session` stream ('' for a terminal stream). */
  readonly sessionId: string
  readonly afterCursor: string | null
  /** The terminal of a `terminal` stream. */
  readonly terminalId?: string
  /** Terminal output after this sequence is replayed first (the stream's `fromSeq`). */
  readonly fromSeq?: number
}

export interface TunnelApi {
  request(caller: ChannelCaller, request: TunnelApiRequest, context?: TunnelCallContext): Promise<TunnelApiResponse>
  /** Start pushing the stream's client events (session or terminal); returns the function that stops it. */
  subscribe(caller: ChannelCaller, subscription: TunnelSubscription, emit: (event: Record<string, unknown>) => void): Promise<() => void>
}
