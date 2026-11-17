// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/domain/preparations.py @98dd0e6e5 (Preparation.reserve)
// ported from Agents-Anywhere v2 connector/connector/runtimes/acp/application/sessions.py @98dd0e6e5 (prepare, _open_preparation, preparation_view, reserve, begin, creation_view, expire_preparations, restore)
//
// The workspace preparation aggregate of the session creation context. Once a client picked an Agent and a
// directory, and before the first message, the device starts the Agent in that directory and creates its native
// session, so the new-session page gets the real model, effort and permission options; the first message reserves
// the preparation and the creation consumes the same native session, so no cold start lands on the first message.
// The creation that consumed a preparation is kept on it (one aggregate, one row); the first message outcome is
// the session's delivery record. Pure: the native session, processes and persistence live outside.

import { createHash } from 'node:crypto'

/** A preparation nobody reserved within 5 minutes expires and its Agent session is closed. */
export const PREPARATION_TTL_MS = 5 * 60_000

export type PreparationPhase =
  | 'opening'
  | 'ready'
  | 'reserved'
  | 'consumed'
  | 'cancelled'
  | 'expired'
  /** Failed before the Agent got the request (invalid directory, launch check) or refused authentication. */
  | 'failed'
  /** Failed after the launch: whether the Agent created a session is unknown, so it is never treated as not happened. */
  | 'outcome_unknown'

const ACTIVE_PHASES: ReadonlySet<PreparationPhase> = new Set(['opening', 'ready'])
/** Phases that stand after a Connector restart; every other one expires (the held Agent sessions died with it). */
const RESTART_KEEPS: ReadonlySet<PreparationPhase> = new Set(['consumed', 'cancelled', 'expired'])

export interface WorkflowFailure {
  readonly code: string
  readonly message: string
}

export type Selections = Readonly<Record<string, string | null>>
export type Configuration = Readonly<Record<string, string | boolean>>

export interface PlanningIntentRef {
  readonly mode: string
  readonly operationId: string
}

/** A reservation binds a preparation to one creation and freezes its selections, configuration and planning intent (runtime-workflows 1.2). */
export interface Reservation {
  readonly createOperationId: string
  readonly platformSessionId: string
  readonly selections: Selections
  readonly configuration: Configuration
  readonly planningIntent: PlanningIntentRef | null
}

/** The creation that consumed the preparation. The delivery record decides the first message outcome; `settled` is an outcome the device decided itself. */
export interface CreationRecord {
  readonly createOperationId: string
  readonly sessionId: string
  readonly clientMessageId: string | null
  readonly inputDigest: string | null
  readonly settled: { readonly phase: 'rejected' | 'outcome_unknown'; readonly messageAccepted: false | null; readonly failure: WorkflowFailure | null } | null
  /** The Connector stopped after the reservation and before the creation: the first message was never submitted. */
  readonly recoveredBeforeSubmission: boolean
}

export interface Preparation {
  readonly preparationId: string
  readonly runtimeId: string
  readonly runtimeType: string
  /** The directory the client registered (the Server project's workspace path). */
  readonly cwd: string
  readonly projectId: string | null
  /** Digest of cwd and clientPreparationId: other input under the same preparationId is a conflict, not a retry. */
  readonly inputDigest: string
  readonly phase: PreparationPhase
  readonly revision: number
  /** Milliseconds since the epoch. */
  readonly expiresAt: number
  /** Owner generation of the requests made during the preparation (an answer carries it). */
  readonly generation: string
  readonly nativeSessionId: string | null
  /** Configuration (catalog) revision: bumped when the Agent reports other options; a reservation must match it. */
  readonly catalogRevision: number
  readonly failure: WorkflowFailure | null
  readonly reservation: Reservation | null
  readonly creation: CreationRecord | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** A business rejection; `code` is what the client sees. */
export class PreparationError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'PreparationError'
  }
}

/** SHA-256 of canonical JSON (sorted keys): content only, key order does not matter. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
}

export function requireSameInput(original: string, incoming: string): void {
  if (original !== incoming) throw new PreparationError('operation_input_conflict', '相同操作身份不能用于不同输入。')
}

export function prepareDigest(input: { readonly cwd: string; readonly clientPreparationId: string | null }): string {
  return fingerprint({ cwd: input.cwd, clientPreparationId: input.clientPreparationId })
}

export interface NewPreparation {
  readonly preparationId: string
  readonly runtimeId: string
  readonly runtimeType: string
  readonly cwd: string
  readonly projectId: string | null
  readonly clientPreparationId: string | null
  readonly generation: string
}

export function openPreparation(input: NewPreparation, nowMs: number, at: string): Preparation {
  return {
    preparationId: input.preparationId,
    runtimeId: input.runtimeId,
    runtimeType: input.runtimeType,
    cwd: input.cwd,
    projectId: input.projectId,
    inputDigest: prepareDigest(input),
    phase: 'opening',
    revision: 0,
    expiresAt: nowMs + PREPARATION_TTL_MS,
    generation: input.generation,
    nativeSessionId: null,
    catalogRevision: 0,
    failure: null,
    reservation: null,
    creation: null,
    createdAt: at,
    updatedAt: at,
  }
}

function step(p: Preparation, patch: Partial<Preparation>, at: string): Preparation {
  return { ...p, ...patch, revision: p.revision + 1, updatedAt: at }
}

/** The Agent created its session: `catalogRevision` starts at 1 when it reported options, else 0. */
export function opened(p: Preparation, facts: { readonly nativeSessionId: string; readonly hasOptions: boolean }, at: string): Preparation {
  if (p.phase !== 'opening') return p
  return step(p, { phase: 'ready', nativeSessionId: facts.nativeSessionId, catalogRevision: facts.hasOptions ? 1 : 0 }, at)
}

/**
 * Opening failed. `definite`: the Agent never got the session request (a launch check, an invalid directory) or
 * refused authentication, so the preparation failed; otherwise its outcome is unknown. A cancelled or expired
 * preparation stays as it is.
 */
export function openFailed(p: Preparation, failure: WorkflowFailure, definite: boolean, at: string): Preparation {
  if (p.phase === 'cancelled' || p.phase === 'expired') return p
  return step(p, { phase: definite ? 'failed' : 'outcome_unknown', failure }, at)
}

/** The Agent reported other options during the preparation: choices made on the old catalog can no longer reserve it. */
export function configurationChanged(p: Preparation, at: string): Preparation {
  return { ...p, catalogRevision: p.catalogRevision + 1, updatedAt: at }
}

export interface ReserveRequest {
  readonly createOperationId: string
  readonly platformSessionId: string
  readonly expectedRevision: number
  readonly catalogRevision: number
  readonly selections: Selections
  readonly configuration: Configuration
  readonly planningIntent: PlanningIntentRef | null
}

/** Facts only the open native session knows when a reservation is made. */
export interface ReserveFacts {
  /** The Agent session the preparation holds is still alive. */
  readonly agentAlive: boolean
  /** Plan mode can be entered before the first message. */
  readonly canPlan: boolean
  /** Why the selections and configuration do not map onto the session options; null when they do. */
  readonly configurationProblem: WorkflowFailure | null
}

function reservationOf(request: ReserveRequest): Reservation {
  return {
    createOperationId: request.createOperationId,
    platformSessionId: request.platformSessionId,
    selections: request.selections,
    configuration: request.configuration,
    planningIntent: request.planningIntent,
  }
}

/**
 * Reserves the preparation for one creation. Replaying the same reservation
 * returns it unchanged (`replayed`); another reservation is a conflict. Every other rejection is definite (the
 * Server then releases the preparation and records the creation as rejected).
 */
export function reserve(p: Preparation, request: ReserveRequest, nowMs: number, facts: ReserveFacts, at: string): { preparation: Preparation; replayed: boolean } {
  const wanted = reservationOf(request)
  if (p.reservation !== null) {
    requireSameInput(fingerprint(p.reservation), fingerprint(wanted))
    return { preparation: p, replayed: true }
  }
  if (p.catalogRevision !== request.catalogRevision) throw new PreparationError('preparation_stale', '工作区配置已变化，请重新确认。')
  if (facts.configurationProblem !== null) throw new PreparationError(facts.configurationProblem.code, facts.configurationProblem.message)
  if (p.phase !== 'ready' || nowMs >= p.expiresAt || request.expectedRevision !== p.revision) {
    throw new PreparationError('preparation_stale', '工作区准备已失效，请重新准备。')
  }
  if (!facts.agentAlive) throw new PreparationError('preparation_stale', '准备所持有的 Agent 已退出。')
  if (request.planningIntent !== null && !facts.canPlan) throw new PreparationError('planning_unavailable', '该 Agent 会话当前无法进入规划模式。')
  return { preparation: step(p, { phase: 'reserved', reservation: wanted }, at), replayed: false }
}

export interface BeginRequest {
  readonly createOperationId: string
  readonly sessionId: string
  readonly clientMessageId: string
  readonly selections: Selections
  readonly configuration: Configuration
  readonly planningIntent: PlanningIntentRef | null
  /** Digest of the whole first message input (other input under the same creation is a conflict). */
  readonly inputDigest: string
}

/**
 * The creation consumes its reserved preparation. The same creation again is `replayed`; a reservation
 * made for another creation, or frozen selections, configuration or planning intent that differ, are refused.
 */
export function begin(p: Preparation, request: BeginRequest, at: string): { preparation: Preparation; replayed: boolean } {
  const creation = p.creation
  if (creation !== null && creation.createOperationId === request.createOperationId) {
    if (creation.recoveredBeforeSubmission) {
      if (creation.sessionId !== request.sessionId) throw new PreparationError('operation_input_conflict', '创建操作已绑定其他平台会话。')
      return { preparation: p, replayed: true }
    }
    requireSameInput(creation.inputDigest ?? '', request.inputDigest)
    return { preparation: p, replayed: true }
  }
  const reservation = p.reservation
  if (reservation === null || reservation.createOperationId !== request.createOperationId || reservation.platformSessionId !== request.sessionId || creation !== null) {
    throw new PreparationError('preparation_not_reserved', '准备尚未为当前创建操作预留。')
  }
  requireSameInput(fingerprint(reservation.selections), fingerprint(request.selections))
  requireSameInput(fingerprint(reservation.configuration), fingerprint(request.configuration))
  requireSameInput(fingerprint(reservation.planningIntent ?? {}), fingerprint(request.planningIntent ?? {}))
  return {
    preparation: step(p, {
      phase: 'consumed',
      creation: {
        createOperationId: request.createOperationId,
        sessionId: request.sessionId,
        clientMessageId: request.clientMessageId,
        inputDigest: request.inputDigest,
        settled: null,
        recoveredBeforeSubmission: false,
      },
    }, at),
    replayed: false,
  }
}

/** A preparation bound to a creation can only be cancelled through that creation. */
export function cancel(p: Preparation, at: string): Preparation {
  if (p.reservation !== null) throw new PreparationError('preparation_consumed', '准备已绑定创建操作，请取消该操作。')
  return step(p, { phase: 'cancelled' }, at)
}

/** Expires a preparation nobody reserved in time; null when nothing changes. */
export function expire(p: Preparation, nowMs: number, at: string): Preparation | null {
  if (!ACTIVE_PHASES.has(p.phase) || nowMs < p.expiresAt || p.reservation !== null) return null
  return step(p, { phase: 'expired' }, at)
}

/**
 * After a Connector restart the Agent sessions died with the process: every preparation not consumed
 * expires, and a reserved one whose creation never started records a creation whose first message was not
 * submitted, so a client querying that creation gets a definite rejection. Null when nothing changes.
 */
export function interrupted(p: Preparation, at: string): Preparation | null {
  let next = p
  if (!RESTART_KEEPS.has(p.phase)) next = step(p, { phase: 'expired' }, at)
  if (next.reservation !== null && next.creation === null) {
    next = {
      ...next,
      updatedAt: at,
      creation: {
        createOperationId: next.reservation.createOperationId,
        sessionId: next.reservation.platformSessionId,
        clientMessageId: null,
        inputDigest: null,
        settled: { phase: 'rejected', messageAccepted: false, failure: { code: 'initialization_interrupted', message: '准备执行者已退出，首条消息未提交，请重新准备。' } },
        recoveredBeforeSubmission: true,
      },
    }
  }
  return next === p ? null : next
}

/**
 * Cancels a creation's initialization: a first message without an outcome yet ends as
 * outcome_unknown (the Agent may have received it), never as not sent.
 */
export function cancelCreation(p: Preparation, messageAccepted: boolean | null, at: string): Preparation {
  const creation = p.creation
  if (creation === null || creation.settled !== null || messageAccepted !== null) return p
  return { ...p, updatedAt: at, creation: { ...creation, settled: { phase: 'outcome_unknown', messageAccepted: null, failure: null } } }
}

export function isTerminal(p: Preparation): boolean {
  return !ACTIVE_PHASES.has(p.phase) && p.phase !== 'reserved'
}

// ---------------------------------------------------------------------------------------------
// Wire views: `WorkflowView.state` of runtime-workflows 1.2
// ---------------------------------------------------------------------------------------------

/** The parts of the view only the open native session knows. */
export interface PreparationLive {
  /** `ProtocolModelCatalog` (models and their reasoning efforts). */
  readonly catalog: Record<string, unknown>
  /** The Agent's options, without the plan mode switch. */
  readonly options: readonly Record<string, unknown>[]
  readonly interactions: readonly Record<string, unknown>[]
  /** The held Agent session is alive, so requests made during the preparation can be answered. */
  readonly canRespond: boolean
}

export function preparationWire(p: Preparation, live: PreparationLive): Record<string, unknown> {
  return {
    preparationId: p.preparationId,
    phase: p.phase,
    revision: p.revision,
    catalogRevision: p.catalogRevision,
    catalog: live.catalog,
    configuration: { revision: p.catalogRevision, options: live.options },
    interactions: live.interactions,
    canRespond: live.canRespond,
    canCancel: ACTIVE_PHASES.has(p.phase),
    failure: p.failure,
    // Seconds, as a float, on the wire.
    expiresAt: p.expiresAt / 1000,
    cwd: p.cwd,
  }
}

/** The first message's delivery record (the Conversation's Delivery), which decides the creation's outcome. */
export interface CreationDelivery {
  readonly state: 'accepted' | 'queued' | 'sending' | 'started' | 'rejected' | 'unknown'
  readonly errorCode: string | null
}

export function creationWire(p: Preparation, delivery: CreationDelivery | null, live: { readonly agentSessionCreated: boolean | null }): Record<string, unknown> {
  const creation = p.creation
  if (creation === null) throw new PreparationError('creation_not_found', '创建操作不存在。')
  let phase: string
  let messageAccepted: boolean | null
  let failure: WorkflowFailure | null = null
  if (creation.settled !== null) {
    phase = creation.settled.phase
    messageAccepted = creation.settled.messageAccepted
    failure = creation.settled.failure
  } else if (delivery === null) {
    phase = 'submitting'
    messageAccepted = null
  } else {
    switch (delivery.state) {
      case 'started':
        phase = 'accepted'
        messageAccepted = true
        break
      case 'rejected':
        phase = 'rejected'
        messageAccepted = false
        failure = { code: delivery.errorCode ?? 'message_rejected', message: '首条消息未被 Agent 接受。' }
        break
      case 'unknown':
        phase = 'outcome_unknown'
        messageAccepted = null
        failure = { code: delivery.errorCode ?? 'delivery_outcome_unknown', message: '首条消息的结果未知，请在会话里确认。' }
        break
      default:
        phase = 'submitting'
        messageAccepted = null
    }
  }
  return {
    createOperationId: creation.createOperationId,
    revision: phase === 'submitting' ? 1 : 2,
    platformSessionId: creation.sessionId,
    phase,
    platformSessionCreated: creation.recoveredBeforeSubmission ? null : true,
    created: creation.recoveredBeforeSubmission ? (p.nativeSessionId !== null ? true : null) : live.agentSessionCreated,
    messageAccepted,
    interactions: [],
    canRespond: false,
    canCancelInitialization: phase === 'submitting',
    failure,
  }
}
