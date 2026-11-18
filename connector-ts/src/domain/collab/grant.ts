import type { SessionAddress } from './address.js'
import { type Authority, DEFAULT_AUTHORITY } from './authority.js'
import { CollabError, type CollabErrorCode } from './errors.js'

/**
 * AgentGrant (docs/agent-collaboration.md §5.1): what one supervisor session's Agent may do through the collaboration
 * tools. Issued by the supervisor's device when the session opens with collaboration on; immutable value, every
 * change returns the next state.
 *
 * Invariants:
 * 1. The authority never exceeds the user's setting nor the supervisor's own permission level (the caller caps it
 *    before issuing, `capByPermission`).
 * 2. A revoked grant authorizes nothing; it is revoked when the supervisor session closes or is archived.
 * 3. A spawned session's depth is the grant's depth + 1 and never exceeds `maxDepth`.
 * 4. Targets stay inside the scope: this device unless cross-device is allowed, the listed runtimes, the cwd roots.
 * 5. Only the secret's digest is kept; the secret itself lives in the tool server's environment.
 */
export interface GrantScope {
  /** Other devices of the account the Agent may reach (`crossDevice` must also be on); `account`: any of them. */
  readonly devices: 'account' | readonly string[]
  readonly runtimes: 'any' | readonly string[]
  /** Directories a spawned session may run in; `any`: the device's own workspace policy decides. */
  readonly cwdRoots: 'any' | readonly string[]
}

export interface GrantLimits {
  readonly maxActiveChildren: number
  readonly maxDepth: number
  readonly wakesPerHour: number
}

export const DEFAULT_LIMITS: GrantLimits = Object.freeze({ maxActiveChildren: 4, maxDepth: 2, wakesPerHour: 20 })

export interface AgentGrant {
  readonly grantId: string
  readonly supervisor: SessionAddress
  /** The supervisor session's own depth: 0 for a session a person created. */
  readonly depth: number
  readonly scope: GrantScope
  readonly limits: GrantLimits
  readonly authority: Authority
  readonly crossDevice: boolean
  readonly state: 'active' | 'revoked'
  readonly issuedAt: string
  readonly revokedAt: string | null
  readonly secretDigest: string
}

export interface IssueGrantInput {
  readonly grantId: string
  readonly supervisor: SessionAddress
  readonly depth?: number
  readonly scope?: Partial<GrantScope>
  readonly limits?: Partial<GrantLimits>
  readonly authority?: Authority
  readonly crossDevice?: boolean
  readonly secretDigest: string
  readonly at: string
}

export function issueGrant(input: IssueGrantInput): AgentGrant {
  const depth = input.depth ?? 0
  if (!Number.isInteger(depth) || depth < 0) throw new CollabError('invalid_argument', 'depth must be a non-negative integer')
  const limits = { ...DEFAULT_LIMITS, ...(input.limits ?? {}) }
  if (limits.maxDepth < 0 || limits.maxActiveChildren < 0 || limits.wakesPerHour < 0) throw new CollabError('invalid_argument', 'limits must not be negative')
  return {
    grantId: input.grantId,
    supervisor: input.supervisor,
    depth,
    scope: { devices: input.scope?.devices ?? 'account', runtimes: input.scope?.runtimes ?? 'any', cwdRoots: input.scope?.cwdRoots ?? 'any' },
    limits,
    authority: input.authority ?? DEFAULT_AUTHORITY,
    crossDevice: input.crossDevice ?? false,
    state: 'active',
    issuedAt: input.at,
    revokedAt: null,
    secretDigest: input.secretDigest,
  }
}

export function revokeGrant(grant: AgentGrant, at: string): AgentGrant {
  if (grant.state === 'revoked') return grant
  return { ...grant, state: 'revoked', revokedAt: at }
}

/** Whether the supervisor may spawn more sessions: it is below its depth limit. */
export function canSpawn(grant: AgentGrant): boolean {
  return grant.state === 'active' && grant.depth + 1 <= grant.limits.maxDepth
}

/** Whether a session this grant spawns should get the collaboration tools itself (it may spawn in turn). */
export function childMayHostTools(grant: AgentGrant): boolean {
  return grant.depth + 2 <= grant.limits.maxDepth
}

export type AgentVerb = 'targets' | 'spawn' | 'send' | 'steer' | 'interrupt' | 'status' | 'read' | 'wait' | 'respond' | 'review_plan' | 'supervise' | 'unsupervise' | 'escalate' | 'close'

export interface TargetFacts {
  readonly address: SessionAddress
  /** The session a target was created by, when an Agent created it (`SessionOrigin.bySessionId`). */
  readonly createdBySessionId?: string | null
  readonly runtimeId?: string | null
  readonly runtimeType?: string | null
  readonly cwd?: string | null
}

export interface AuthorizeRequest {
  readonly verb: AgentVerb
  readonly target?: TargetFacts
  /** Sessions this grant spawned that are not closed (for `spawn`). */
  readonly activeChildren?: number
}

export type Decision = { readonly ok: true } | { readonly ok: false; readonly code: CollabErrorCode; readonly message: string }

const ALLOW: Decision = { ok: true }
const deny = (code: CollabErrorCode, message: string): Decision => ({ ok: false, code, message })

/** The rules of §5.1 for one tool call; the caller turns a denial into the tool's error. */
export function authorize(grant: AgentGrant, request: AuthorizeRequest): Decision {
  if (grant.state === 'revoked') return deny('agent_grant_revoked', 'The collaboration grant of this session was revoked.')
  const target = request.target
  if (target !== undefined) {
    const scoped = deviceInScope(grant, target.address.deviceId)
    if (!scoped.ok) return scoped
    if (target.address.sessionId === grant.supervisor.sessionId && request.verb !== 'status' && request.verb !== 'read') {
      return deny('agent_scope_denied', 'A session cannot use the collaboration tools on itself.')
    }
  }
  const own = target !== undefined && target.createdBySessionId === grant.supervisor.sessionId
  switch (request.verb) {
    case 'targets':
    case 'status':
    case 'read':
    case 'wait':
    case 'escalate':
    case 'unsupervise':
      return ALLOW
    case 'spawn': {
      if (grant.depth + 1 > grant.limits.maxDepth) return deny('agent_depth_exceeded', `This session is at depth ${grant.depth}; it may not create sessions deeper than ${grant.limits.maxDepth}.`)
      if ((request.activeChildren ?? 0) >= grant.limits.maxActiveChildren) return deny('agent_children_exceeded', `At most ${grant.limits.maxActiveChildren} sessions created by this session may be open at once.`)
      if (target !== undefined) {
        if (grant.scope.runtimes !== 'any' && !grant.scope.runtimes.includes(target.runtimeId ?? '') && !grant.scope.runtimes.includes(target.runtimeType ?? '')) {
          return deny('agent_scope_denied', 'That runtime is outside this session\'s collaboration scope.')
        }
        if (target.cwd != null && !cwdInScope(grant.scope.cwdRoots, target.cwd)) return deny('agent_scope_denied', 'That directory is outside this session\'s collaboration scope.')
      }
      return ALLOW
    }
    case 'send':
    case 'steer':
      return grant.authority.steer ? ALLOW : deny('agent_authority_exceeded', 'This session may not send messages to other sessions.')
    case 'interrupt':
      return grant.authority.interrupt ? ALLOW : deny('agent_authority_exceeded', 'This session may not interrupt other sessions; a person can allow it in the supervision settings.')
    case 'respond':
      return grant.authority.respondApproval ? ALLOW : deny('agent_authority_exceeded', 'This session may not answer another session\'s approvals; use aa_escalate to ask a person.')
    case 'review_plan':
      return grant.authority.reviewPlan ? ALLOW : deny('agent_authority_exceeded', 'This session may not approve or reject plans; use aa_escalate to ask a person.')
    case 'close':
      if (!grant.authority.close) return deny('agent_authority_exceeded', 'This session may not close other sessions.')
      return own ? ALLOW : deny('agent_authority_exceeded', 'Only sessions this session created can be closed by it.')
    case 'supervise':
      return own ? ALLOW : deny('agent_authority_exceeded', 'An Agent may supervise only sessions it created; a person can set up other supervisions.')
  }
}

export function assertAuthorized(grant: AgentGrant, request: AuthorizeRequest): void {
  const decision = authorize(grant, request)
  if (!decision.ok) throw new CollabError(decision.code, decision.message)
}

function deviceInScope(grant: AgentGrant, deviceId: string): Decision {
  if (deviceId === grant.supervisor.deviceId) return ALLOW
  if (!grant.crossDevice) return deny('agent_scope_denied', 'This session may work only with sessions on its own device.')
  if (grant.scope.devices !== 'account' && !grant.scope.devices.includes(deviceId)) return deny('agent_scope_denied', 'That device is outside this session\'s collaboration scope.')
  return ALLOW
}

/** Whether `cwd` is one of `roots` or inside one (separators and a trailing separator do not matter). */
export function cwdInScope(roots: GrantScope['cwdRoots'], cwd: string): boolean {
  if (roots === 'any') return true
  const normal = (path: string): string => {
    const unified = path.replace(/\\/gu, '/').replace(/\/+$/u, '')
    return /^[a-zA-Z]:/u.test(unified) ? unified.toLowerCase() : unified
  }
  const target = normal(cwd)
  if (target.split('/').includes('..')) return false
  return roots.some(root => {
    const base = normal(root)
    return target === base || target.startsWith(`${base}/`)
  })
}
