/**
 * Collaboration rule violations. `code` is an AA error code listed in contracts/agent-tools/1.0/errors.json, so the
 * tools can return it to the Agent unchanged.
 */
export type CollabErrorCode =
  | 'agent_grant_revoked'
  | 'agent_scope_denied'
  | 'agent_depth_exceeded'
  | 'agent_children_exceeded'
  | 'agent_authority_exceeded'
  | 'agent_supervision_cycle'
  | 'agent_supervision_exists'
  | 'agent_supervision_not_found'
  | 'agent_peer_not_trusted'
  | 'agent_wake_budget_exceeded'
  | 'agent_target_unknown'
  | 'invalid_argument'

export class CollabError extends Error {
  public constructor(
    public readonly code: CollabErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CollabError'
  }
}
