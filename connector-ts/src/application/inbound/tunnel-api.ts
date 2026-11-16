/**
 * What a secure channel calls once a client is authorised: the same client API as normal mode (contracts/e2ee/1.0
 * README, "通道消息"). The adapter that maps paths to Conversation use cases implements this; Conversation itself
 * never learns that the request came through Noise, only who the caller is (docs/v3/11-e2ee-noise.md §6).
 */

export interface ChannelCaller {
  readonly clientId: string
  readonly label: string
  readonly platform: string | null
}

export interface TunnelApiRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly body: unknown
}

export interface TunnelApiResponse {
  readonly status: number
  readonly body: unknown
}

export interface TunnelSubscription {
  readonly sessionId: string
  readonly afterCursor: string | null
}

export interface TunnelApi {
  request(caller: ChannelCaller, request: TunnelApiRequest): Promise<TunnelApiResponse>
  /** Start pushing the session's client events; returns the function that stops it. */
  subscribe(caller: ChannelCaller, subscription: TunnelSubscription, emit: (event: Record<string, unknown>) => void): Promise<() => void>
}
