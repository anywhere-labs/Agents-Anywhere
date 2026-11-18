import {
  type Authority,
  CollabError,
  DEFAULT_AUTHORITY,
  type SessionAddress,
  type Supervision,
  type TargetSignal,
  type Trigger,
  buildDigest,
  checkStalled,
  end,
  observe,
  parseAuthority,
  parseTriggers,
  pause,
  readyToWake,
  recordWake,
  resume,
  startSupervision,
  update,
  wouldCycle,
  wouldExceedBudget,
} from '../../domain/collab/index.js'
import type { AgentActorRef, Clock, ConversationStore, EscalationSink, IdSource, SessionGateway, SupervisorFacts } from '../ports/index.js'

export interface SupervisionServiceDeps {
  readonly deviceId: string
  readonly store: Pick<ConversationStore, 'collab' | 'sessions'>
  readonly clock: Clock
  readonly ids: IdSource
  readonly gateway: SessionGateway
  readonly facts: SupervisorFacts
  readonly escalations: EscalationSink
  readonly onOutbox?: () => void
  readonly onError?: (supervisionId: string, error: unknown) => void
  /** How often local targets are polled and stalls checked; default 5 seconds. */
  readonly tickMs?: number
}

export interface StartRequest {
  readonly supervisor: SessionAddress
  readonly target: SessionAddress
  readonly createdBy: 'human' | 'agent'
  readonly triggers?: readonly Trigger[]
  readonly authority?: Authority
  readonly stalledMinutes?: number
}

export interface SignalInput {
  readonly supervisionId: string
  readonly signal: TargetSignal
}

/**
 * Supervision use cases (docs/agent-collaboration.md §5.2, §7.3): starting and changing supervisions, taking in target
 * signals (polled for targets on this device, `collab.signal` from the Server for the others), and waking the
 * supervisor with a digest once a trigger fired, the coalescing window passed and the supervisor is idle.
 */
export class SupervisionService {
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private readonly chains = new Map<string, Promise<unknown>>()

  public constructor(private readonly deps: SupervisionServiceDeps) {}

  public start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? 5_000)
    this.timer.unref?.()
  }

  public close(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** Starts a supervision; one active per (supervisor, target), never a cycle. */
  public async startSupervision(request: StartRequest): Promise<Supervision> {
    const existing = (await this.deps.store.collab.supervisionsOf(request.supervisor.sessionId)).find(item => item.target.sessionId === request.target.sessionId)
    if (existing !== undefined) throw new CollabError('agent_supervision_exists', `Session ${request.target.sessionId} is already supervised by this session (${existing.supervisionId}).`)
    const edges = (await this.deps.store.collab.liveSupervisions()).map(item => ({ supervisor: item.supervisor.sessionId, target: item.target.sessionId }))
    if (wouldCycle(edges, { supervisor: request.supervisor.sessionId, target: request.target.sessionId })) {
      throw new CollabError('agent_supervision_cycle', 'That supervision would close a cycle of sessions supervising each other.')
    }
    const view = await this.deps.gateway.facts(request.target, await this.actorOf(request.supervisor.sessionId))
    if (view === null) throw new CollabError('agent_target_unknown', `Session ${request.target.sessionId} was not found.`)
    const at = this.deps.clock.nowIso()
    let supervision = startSupervision({
      supervisionId: this.deps.ids.newId('sup_'),
      supervisor: request.supervisor,
      target: request.target,
      ...(request.triggers !== undefined ? { triggers: request.triggers } : {}),
      ...(request.stalledMinutes !== undefined ? { stalledMinutes: request.stalledMinutes } : {}),
      authority: request.authority ?? DEFAULT_AUTHORITY,
      cursor: { seq: view.signal.headSeq, resetSeq: view.signal.resetSeq },
      createdBy: request.createdBy,
      at,
    })
    supervision = observe(supervision, view.signal, this.deps.clock.nowMs())
    await this.save(supervision, true)
    return supervision
  }

  /** A person (or the supervisor itself, for `end`) changes a supervision. */
  public async change(supervisionId: string, change: { state?: 'active' | 'paused' | 'ended'; triggers?: readonly Trigger[]; authority?: Authority; stalledMinutes?: number }): Promise<Supervision> {
    return this.serial(supervisionId, async () => {
      const current = await this.deps.store.collab.supervision(supervisionId)
      if (current === null) throw new CollabError('agent_supervision_not_found', `Supervision ${supervisionId} was not found.`)
      const at = this.deps.clock.nowIso()
      let next = update(current, change, at)
      if (change.state === 'paused') next = pause(next, 'person', at)
      else if (change.state === 'active') next = resume(next, at)
      else if (change.state === 'ended') next = end(next, at)
      await this.save(next, next.state !== current.state)
      return next
    })
  }

  /** Ends the supervisor's supervision of a target, if there is one. */
  public async endFor(supervisorSessionId: string, targetSessionId: string): Promise<Supervision | null> {
    const found = (await this.deps.store.collab.supervisionsOf(supervisorSessionId)).find(item => item.target.sessionId === targetSessionId)
    return found === undefined ? null : this.change(found.supervisionId, { state: 'ended' })
  }

  /** Ends every supervision a session takes part in (it was archived or deleted). */
  public async endAllOf(sessionId: string): Promise<void> {
    const involved = [...await this.deps.store.collab.supervisionsOf(sessionId), ...await this.deps.store.collab.supervisionsOfTarget(sessionId)]
    for (const item of involved) if (item.state !== 'ended') await this.change(item.supervisionId, { state: 'ended' })
  }

  /** `collab.signal`: target signals the Server forwarded; unknown or ended supervisions are skipped. */
  public async onSignals(signals: readonly SignalInput[]): Promise<number> {
    let accepted = 0
    for (const { supervisionId, signal } of signals) {
      const done = await this.serial(supervisionId, async () => {
        const current = await this.deps.store.collab.supervision(supervisionId)
        if (current === null || current.state === 'ended' || current.supervisor.deviceId !== this.deps.deviceId) return false
        const next = observe(current, signal, this.deps.clock.nowMs())
        if (next !== current) await this.save(next, false)
        await this.maybeWake(next)
        return true
      })
      if (done) accepted++
    }
    return accepted
  }

  /** One pass: polls targets on this device, checks stalls, delivers due wakes. */
  public async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      for (const live of await this.deps.store.collab.liveSupervisions()) {
        if (live.supervisor.deviceId !== this.deps.deviceId) continue
        await this.serial(live.supervisionId, async () => {
          const current = await this.deps.store.collab.supervision(live.supervisionId)
          if (current === null || current.state === 'ended') return
          let next = current
          if (current.target.deviceId === this.deps.deviceId) {
            const view = await this.deps.gateway.facts(current.target, await this.actorOf(current.supervisor.sessionId, current.supervisionId)).catch(() => null)
            if (view !== null) next = observe(next, view.signal, this.deps.clock.nowMs())
          }
          next = checkStalled(next, this.deps.clock.nowMs(), this.deps.clock.nowIso())
          if (next !== current) await this.save(next, false)
          await this.maybeWake(next)
        }).catch(error => this.deps.onError?.(live.supervisionId, error))
      }
    } finally {
      this.ticking = false
    }
  }

  /** People's view of a supervisor session (`GET /sessions/{id}/collab`); `available`: its Agent has the tools. */
  public async view(sessionId: string, available: boolean): Promise<Record<string, unknown>> {
    const collab = this.deps.store.collab
    const grant = await collab.activeGrantOf(sessionId)
    return {
      sessionId,
      available,
      grant: grant === null ? null : { grantId: grant.grantId, state: grant.state, depth: grant.depth, authority: grant.authority, crossDevice: grant.crossDevice, limits: grant.limits, issuedAt: grant.issuedAt },
      supervisions: (await collab.supervisionsOf(sessionId)).map(supervisionView),
      supervisedBy: (await collab.supervisionsOfTarget(sessionId)).filter(item => item.state !== 'ended').map(supervisionView),
      children: (await collab.childrenOf(sessionId)).map(child => ({ sessionId: child.childSessionId, deviceId: child.childDeviceId, depth: child.depth, closed: child.closed, createdAt: child.createdAt })),
      actions: (await collab.recentActions(sessionId, 50)).map(action => ({
        actionId: action.actionId,
        verb: action.verb,
        targetSessionId: action.target?.sessionId ?? null,
        targetDeviceId: action.target?.deviceId ?? null,
        outcome: action.outcome,
        errorCode: action.errorCode,
        at: action.at,
      })),
    }
  }

  /** A person sets up a supervision (any session may supervise any other of the account, AC9). */
  public async superviseByPerson(supervisorSessionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const targetSessionId = typeof body.targetSessionId === 'string' ? body.targetSessionId : ''
    if (targetSessionId === '') throw new CollabError('invalid_argument', 'targetSessionId is required')
    const supervisor = await this.deps.store.sessions.get(supervisorSessionId)
    if (supervisor === null) throw new CollabError('agent_target_unknown', `Session ${supervisorSessionId} was not found.`)
    const actor = await this.actorOf(supervisorSessionId)
    const targetDeviceId = typeof body.targetDeviceId === 'string' && body.targetDeviceId !== ''
      ? body.targetDeviceId
      : (await this.deps.store.sessions.get(targetSessionId)) !== null ? this.deps.deviceId : await this.deps.gateway.locate(targetSessionId, actor)
    if (targetDeviceId === null) throw new CollabError('agent_target_unknown', `Session ${targetSessionId} was not found.`)
    const supervision = await this.startSupervision({
      supervisor: { deviceId: this.deps.deviceId, sessionId: supervisorSessionId },
      target: { deviceId: targetDeviceId, sessionId: targetSessionId },
      createdBy: 'human',
      ...(body.triggers !== undefined ? { triggers: parseTriggers(body.triggers) } : {}),
      authority: parseAuthority(body.authority, DEFAULT_AUTHORITY),
      ...(typeof body.stalledMinutes === 'number' ? { stalledMinutes: body.stalledMinutes } : {}),
    })
    return { supervision: supervisionView(supervision) }
  }

  public async updateByPerson(supervisorSessionId: string, supervisionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const current = await this.deps.store.collab.supervision(supervisionId)
    if (current === null || current.supervisor.sessionId !== supervisorSessionId) throw new CollabError('agent_supervision_not_found', `Supervision ${supervisionId} was not found.`)
    const state = body.state === 'active' || body.state === 'paused' || body.state === 'ended' ? body.state : undefined
    const next = await this.change(supervisionId, {
      ...(state !== undefined ? { state } : {}),
      ...(body.triggers !== undefined ? { triggers: parseTriggers(body.triggers) } : {}),
      ...(body.authority !== undefined ? { authority: parseAuthority(body.authority, current.authority) } : {}),
      ...(typeof body.stalledMinutes === 'number' ? { stalledMinutes: body.stalledMinutes } : {}),
    })
    return { supervision: supervisionView(next) }
  }

  private async maybeWake(supervision: Supervision): Promise<void> {
    const nowMs = this.deps.clock.nowMs()
    if (supervision.state !== 'active' || supervision.pendingWake === null) return
    const busy = await this.deps.facts.busy(supervision.supervisor.sessionId).catch(() => true)
    if (!readyToWake(supervision, nowMs, busy)) return
    const at = this.deps.clock.nowIso()
    if (wouldExceedBudget(supervision, nowMs)) {
      const paused = pause(supervision, 'wake_budget', at)
      await this.save(paused, true)
      await this.deps.escalations.escalate(supervision.supervisor.sessionId, `collab_budget_${supervision.supervisionId}_${nowMs}`, {
        kind: 'collab_escalation',
        reason: 'agent_wake_budget_exceeded',
        question: `The supervision of session ${supervision.target.sessionId} woke this session more than ${supervision.budget.wakesPerHour} times in an hour and was paused. Resume it from the supervision panel when you want it to continue.`,
        fromSessionId: supervision.supervisor.sessionId,
        targetSessionId: supervision.target.sessionId,
        supervisionId: supervision.supervisionId,
      })
      return
    }
    const actor = await this.actorOf(supervision.supervisor.sessionId, supervision.supervisionId)
    const page = await this.deps.gateway.observe(supervision.target, actor, supervision.cursor.seq, 100)
    const notices = await this.deps.gateway.notices(supervision.target, actor).catch(() => [])
    const view = await this.deps.gateway.facts(supervision.target, actor).catch(() => null)
    const signal = supervision.lastSignal
    const digest = buildDigest({
      targetLabel: view?.title ?? `Session ${supervision.target.sessionId}`,
      targetSessionId: supervision.target.sessionId,
      reasons: supervision.pendingWake.reasons,
      status: signal?.status ?? 'unknown',
      items: page.items,
      openNotices: notices.map(notice => ({ id: notice.id, title: notice.title })),
      planState: signal?.planState ?? 'none',
      goalState: signal?.goalState ?? 'none',
      historyReset: page.resetSeq > supervision.cursor.resetSeq && supervision.cursor.seq > 0,
      deviceOnline: signal?.deviceOnline ?? true,
    })
    const response = await this.deps.gateway.request(this.deps.deviceId, actor, {
      method: 'POST',
      path: `sessions/${encodeURIComponent(supervision.supervisor.sessionId)}/runtime/messages`,
      body: { content: digest, clientMessageId: `wake_${supervision.supervisionId}_${nowMs}`, queue: 'auto' },
    })
    if (response.status >= 300) {
      // The supervisor cannot take messages now (archived, source gone); try again on the next pass.
      this.deps.onError?.(supervision.supervisionId, new Error(`wake delivery answered ${response.status}`))
      return
    }
    const { supervision: next, overBudget } = recordWake(supervision, { seq: page.headSeq, resetSeq: page.resetSeq }, nowMs, at)
    await this.save(next, overBudget)
  }

  private async save(supervision: Supervision, crossing: boolean): Promise<void> {
    const at = this.deps.clock.nowIso()
    await this.deps.store.collab.putSupervision(supervision, crossing ? {
      supervisionId: supervision.supervisionId,
      supervisorSessionId: supervision.supervisor.sessionId,
      targetSessionId: supervision.target.sessionId,
      targetDeviceId: supervision.target.deviceId,
      state: supervision.state,
      createdBy: supervision.createdBy,
      at,
    } : null, at)
    if (crossing) this.deps.onOutbox?.()
  }

  private async actorOf(supervisorSessionId: string, supervisionId?: string): Promise<AgentActorRef> {
    const grant = await this.deps.store.collab.activeGrantOf(supervisorSessionId)
    return { deviceId: this.deps.deviceId, sessionId: supervisorSessionId, grantId: grant?.grantId ?? '', ...(supervisionId !== undefined ? { supervisionId } : {}) }
  }

  private serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(run, run)
    const tail = next.catch(() => undefined)
    this.chains.set(key, tail)
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key)
    })
    return next
  }
}

export function supervisionView(supervision: Supervision): Record<string, unknown> {
  return {
    supervisionId: supervision.supervisionId,
    supervisorSessionId: supervision.supervisor.sessionId,
    supervisorDeviceId: supervision.supervisor.deviceId,
    targetSessionId: supervision.target.sessionId,
    targetDeviceId: supervision.target.deviceId,
    state: supervision.state,
    pausedReason: supervision.pausedReason,
    triggers: supervision.triggers,
    authority: supervision.authority,
    stalledMinutes: supervision.stalledMinutes,
    createdBy: supervision.createdBy,
    lastStatus: supervision.lastSignal?.status ?? null,
    wakesLastHour: supervision.wakes.length,
    lastWakeAt: supervision.wakes.length > 0 ? new Date(supervision.wakes[supervision.wakes.length - 1] as number).toISOString() : null,
    createdAt: supervision.createdAt,
    updatedAt: supervision.updatedAt,
  }
}
