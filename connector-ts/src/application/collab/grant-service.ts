import { createHash, randomBytes } from 'node:crypto'

import { type AgentGrant, capByPermission, intersect, issueGrant, revokeGrant } from '../../domain/collab/index.js'
import type { Clock, ConversationStore, IdSource, SessionToolProvider, SupervisorFacts, ToolServerLaunch, ToolServerSpec } from '../ports/index.js'
import { effectiveFor } from './settings.js'
import type { CollabSettings } from '../ports/collab.js'

/** The name of the injected tool server; Runtimes prefix its tools with it (`mcp__aa__aa_spawn`). */
export const TOOL_SERVER_NAME = 'aa'

export function secretDigest(secret: string): string {
  return `sha256:${createHash('sha256').update(secret, 'utf8').digest('hex')}`
}

export interface GrantServiceDeps {
  readonly encryptionRequired: () => boolean
  readonly deviceId: string
  readonly store: Pick<ConversationStore, 'collab' | 'sessions'>
  readonly clock: Clock
  readonly ids: IdSource
  readonly settings: () => CollabSettings
  readonly facts: SupervisorFacts
  /** How to start the tool server; null when this host cannot (the bundle has no `agent-tools` entry). */
  readonly launch: ToolServerLaunch | null
  readonly onOutbox?: () => void
}

/**
 * Issues collaboration grants (docs/agent-collaboration.md §5.1). Each time a session's Agent session opens with
 * collaboration on, the previous grant is revoked and a new one issued: the secret lives only in the tool server's
 * environment, so a Connector restart or a reopen never leaves a usable old secret behind.
 */
export class GrantService implements SessionToolProvider {
  public constructor(private readonly deps: GrantServiceDeps) {}

  public async toolServers(session: { readonly sessionId: string; readonly runtimeId: string; readonly runtimeType: string }): Promise<readonly ToolServerSpec[]> {
    const launch = this.deps.launch
    const effective = effectiveFor(this.deps.settings(), session.runtimeId)
    if (launch === null || this.deps.encryptionRequired() || !(await this.deps.facts.canHostTools(session.runtimeId))) {
      await this.revokeFor(session.sessionId)
      return []
    }
    // The server is installed for the session even when its account has disabled tool calls.
    if (!effective.enabled) {
      await this.revokeFor(session.sessionId)
      return [{ name: TOOL_SERVER_NAME, command: launch.command, args: launch.args, env: launch.env }]
    }
    const stored = await this.deps.store.sessions.get(session.sessionId)
    if (stored === null || stored.archived) return []
    const depth = stored.origin?.depth ?? 0
    const level = await this.deps.facts.permissionLevel(session.sessionId)
    const secret = randomBytes(32).toString('base64url')
    const at = this.deps.clock.nowIso()
    await this.revokeFor(session.sessionId)
    const grant = issueGrant({
      grantId: this.deps.ids.newId('agr_'),
      supervisor: { deviceId: this.deps.deviceId, sessionId: session.sessionId },
      depth,
      authority: capByPermission(effective.authority, level),
      crossDevice: effective.crossDevice,
      secretDigest: secretDigest(secret),
      at,
    })
    // A session at the deepest level may not spawn; it still gets the tools to report and to ask a person.
    await this.deps.store.collab.putGrant(grant, { grantId: grant.grantId, supervisorSessionId: session.sessionId, state: 'active', at }, at)
    this.deps.onOutbox?.()
    return [{
      name: TOOL_SERVER_NAME,
      command: launch.command,
      args: launch.args,
      env: { ...launch.env, AA_AGENT_TOOLS_ENDPOINT: launch.endpoint, AA_AGENT_TOOLS_TOKEN: secret },
    }]
  }

  /** Whether a session's Agent gets the tools when it opens: collaboration is on for its instance and it can host them. */
  public async available(sessionId: string): Promise<boolean> {
    const session = await this.deps.store.sessions.get(sessionId)
    if (session === null || session.archived || this.deps.launch === null) return false
    if (!effectiveFor(this.deps.settings(), session.runtimeId).enabled) return false
    return this.deps.facts.canHostTools(session.runtimeId)
  }

  /** Revokes the session's active grant (it closed, was archived, or collaboration was turned off). */
  public async revokeFor(sessionId: string): Promise<void> {
    const active = await this.deps.store.collab.activeGrantOf(sessionId)
    if (active === null) return
    const at = this.deps.clock.nowIso()
    const revoked = revokeGrant(active, at)
    await this.deps.store.collab.putGrant(revoked, { grantId: revoked.grantId, supervisorSessionId: sessionId, state: 'revoked', at }, at)
    this.deps.onOutbox?.()
  }

  /** Settings changed: grants of instances that are no longer on are revoked at once. */
  public async reconcile(): Promise<void> {
    const settings = this.deps.settings()
    for (const grant of await this.deps.store.collab.activeGrants()) {
      const session = await this.deps.store.sessions.get(grant.supervisor.sessionId)
      if (session === null || session.archived || !effectiveFor(settings, session.runtimeId).enabled) await this.revokeFor(grant.supervisor.sessionId)
    }
  }

  /** The active grant a tool server's secret belongs to, or null. */
  public async bySecret(secret: string): Promise<AgentGrant | null> {
    if (secret === '' || this.deps.encryptionRequired()) return null
    const grant = await this.deps.store.collab.grantBySecret(secretDigest(secret))
    if (grant === null || grant.state !== 'active') return null
    const supervisor = await this.deps.store.sessions.get(grant.supervisor.sessionId)
    if (!supervisor || supervisor.archived) return null
    const policy = effectiveFor(this.deps.settings(), supervisor.runtimeId)
    if (!policy.enabled) return null
    return { ...grant, crossDevice: grant.crossDevice && policy.crossDevice, authority: intersect(grant.authority, policy.authority) }
  }
}
