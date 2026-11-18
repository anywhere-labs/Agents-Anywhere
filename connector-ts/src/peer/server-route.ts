// Normal mode: an Agent reaches another device's sessions through the Server's client API, authenticated as a
// delegation of its supervisor session (`POST /api/v3/device/agent-delegations`). The Server checks the account and
// cross-device switches when it issues the token and the route table on every call; the target device checks the
// grant's caller again.
import type { AgentActorRef, GatewayRequest, GatewayResponse } from '../application/ports/index.js'
import type { PeerDirectory, PeerRoute } from './gateway.js'

export interface Delegation {
  readonly token: string
  /** Epoch ms. */
  readonly expiresAt: number
}

export interface ServerRouteDeps {
  /** Asks the Server for a delegation token of the supervisor session's grant. */
  readonly delegate: (actor: AgentActorRef) => Promise<Delegation>
  /** One HTTP call to the Server's `/api/v2/<path>` with a bearer token. */
  readonly http: (request: GatewayRequest, token: string) => Promise<GatewayResponse>
  readonly now: () => number
}

/** Refreshes a token this long before it expires. */
const MARGIN_MS = 60_000

export class ServerRoute implements PeerRoute {
  private readonly tokens = new Map<string, Promise<Delegation>>()

  /** The account directory through the same delegation. */
  public readonly directory: PeerDirectory = { request: (actor, request) => this.call(actor, request) }

  public constructor(private readonly deps: ServerRouteDeps) {}

  /** The Server routes by the session (or `connectorId` of a creation), so the device id is not part of the call. */
  public request(_deviceId: string, actor: AgentActorRef, request: GatewayRequest): Promise<GatewayResponse> {
    return this.call(actor, request)
  }

  private async call(actor: AgentActorRef, request: GatewayRequest): Promise<GatewayResponse> {
    for (let attempt = 0; ; attempt++) {
      const delegation = await this.delegation(actor)
      const response = await this.deps.http(request, delegation.token)
      if (response.status === 401 && attempt === 0) {
        this.tokens.delete(actor.grantId)
        continue
      }
      return response
    }
  }

  /** Forgets the tokens of a revoked grant (the Server revokes them too, `collab.grant.changed`). */
  public forget(grantId: string): void {
    this.tokens.delete(grantId)
  }

  /** The current delegation of a grant (also authenticates the tunnel WebSocket of encrypted mode). */
  public async delegation(actor: AgentActorRef): Promise<Delegation> {
    const cached = this.tokens.get(actor.grantId)
    if (cached !== undefined) {
      const delegation = await cached.catch(() => null)
      if (delegation !== null && delegation.expiresAt - this.deps.now() > MARGIN_MS) return delegation
    }
    const next = this.deps.delegate(actor)
    this.tokens.set(actor.grantId, next)
    next.catch(() => {
      if (this.tokens.get(actor.grantId) === next) this.tokens.delete(actor.grantId)
    })
    return next
  }
}
