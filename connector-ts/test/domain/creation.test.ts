import { describe, expect, it } from 'vitest'

import {
  PREPARATION_TTL_MS,
  PreparationError,
  begin,
  cancel,
  cancelCreation,
  configurationChanged,
  creationWire,
  expire,
  interrupted,
  openFailed,
  openPreparation,
  opened,
  preparationWire,
  reserve,
  type Preparation,
  type ReserveRequest,
} from '../../src/domain/creation/index.js'

const at = '2026-11-17T00:00:00.000Z'
const alive = { agentAlive: true, canPlan: false, configurationProblem: null }

function ready(): Preparation {
  const p = openPreparation({ preparationId: 'prep_1', runtimeId: 'rti', runtimeType: 'opencode', cwd: '/w', projectId: 'prj', clientPreparationId: 'c1', generation: 'gen_1' }, 0, at)
  return opened(p, { nativeSessionId: 'native-1', hasOptions: true }, at)
}

function request(overrides: Partial<ReserveRequest> = {}): ReserveRequest {
  return { createOperationId: 'op_1', platformSessionId: 'sess_1', expectedRevision: 1, catalogRevision: 1, selections: { model: 'm2' }, configuration: {}, planningIntent: null, ...overrides }
}

function rejection(work: () => unknown): string {
  try {
    work()
  } catch (error) {
    expect(error).toBeInstanceOf(PreparationError)
    return (error as PreparationError).code
  }
  throw new Error('expected a rejection')
}

describe('workspace preparation state machine', () => {
  it('opens, becomes ready with its first catalog revision, reserves once and is consumed by its creation', () => {
    const p = ready()
    expect(p).toMatchObject({ phase: 'ready', revision: 1, catalogRevision: 1, nativeSessionId: 'native-1', expiresAt: PREPARATION_TTL_MS })
    const reserved = reserve(p, request(), 10, alive, at)
    expect(reserved.replayed).toBe(false)
    expect(reserved.preparation).toMatchObject({ phase: 'reserved', revision: 2, reservation: { createOperationId: 'op_1', platformSessionId: 'sess_1' } })
    // The same reservation again is a replay; another one is a conflict.
    expect(reserve(reserved.preparation, request(), 10, alive, at).replayed).toBe(true)
    expect(rejection(() => reserve(reserved.preparation, request({ createOperationId: 'op_2' }), 10, alive, at))).toBe('operation_input_conflict')
    const consumed = begin(reserved.preparation, { createOperationId: 'op_1', sessionId: 'sess_1', clientMessageId: 'm1', selections: { model: 'm2' }, configuration: {}, planningIntent: null, inputDigest: 'd1' }, at)
    expect(consumed.preparation).toMatchObject({ phase: 'consumed', revision: 3, creation: { createOperationId: 'op_1', sessionId: 'sess_1', clientMessageId: 'm1', settled: null } })
    // Replays answer the same creation; other input under the same id is a conflict.
    expect(begin(consumed.preparation, { createOperationId: 'op_1', sessionId: 'sess_1', clientMessageId: 'm1', selections: { model: 'm2' }, configuration: {}, planningIntent: null, inputDigest: 'd1' }, at).replayed).toBe(true)
    expect(rejection(() => begin(consumed.preparation, { createOperationId: 'op_1', sessionId: 'sess_1', clientMessageId: 'm1', selections: {}, configuration: {}, planningIntent: null, inputDigest: 'd2' }, at))).toBe('operation_input_conflict')
  })

  it('refuses stale, expired, consumed and unplannable reservations definitely', () => {
    const p = ready()
    expect(rejection(() => reserve(p, request({ catalogRevision: 0 }), 10, alive, at))).toBe('preparation_stale')
    expect(rejection(() => reserve(p, request({ expectedRevision: 0 }), 10, alive, at))).toBe('preparation_stale')
    expect(rejection(() => reserve(p, request(), PREPARATION_TTL_MS, alive, at))).toBe('preparation_stale')
    expect(rejection(() => reserve(p, request(), 10, { ...alive, agentAlive: false }, at))).toBe('preparation_stale')
    expect(rejection(() => reserve(p, request({ planningIntent: { mode: 'plan', operationId: 'pl' } }), 10, alive, at))).toBe('planning_unavailable')
    expect(rejection(() => reserve(p, request(), 10, { ...alive, configurationProblem: { code: 'invalid_configuration_value', message: 'x' } }, at))).toBe('invalid_configuration_value')
    // An Agent that reported other options moves the catalog revision: choices made on the old one are stale.
    const changed = configurationChanged(p, at)
    expect(changed.catalogRevision).toBe(2)
    expect(changed.revision).toBe(p.revision)
    expect(rejection(() => reserve(changed, request(), 10, alive, at))).toBe('preparation_stale')
    // The creation must use the frozen choices and the reserved session.
    const reserved = reserve(p, request(), 10, alive, at).preparation
    expect(rejection(() => begin(reserved, { createOperationId: 'op_1', sessionId: 'sess_other', clientMessageId: 'm1', selections: { model: 'm2' }, configuration: {}, planningIntent: null, inputDigest: 'd' }, at))).toBe('preparation_not_reserved')
    expect(rejection(() => begin(reserved, { createOperationId: 'op_1', sessionId: 'sess_1', clientMessageId: 'm1', selections: { model: 'm1' }, configuration: {}, planningIntent: null, inputDigest: 'd' }, at))).toBe('operation_input_conflict')
    expect(rejection(() => begin(p, { createOperationId: 'op_1', sessionId: 'sess_1', clientMessageId: 'm1', selections: {}, configuration: {}, planningIntent: null, inputDigest: 'd' }, at))).toBe('preparation_not_reserved')
  })

  it('fails definitely before the launch, with an unknown outcome after it, and never overwrites a cancellation', () => {
    const opening = openPreparation({ preparationId: 'p', runtimeId: 'r', runtimeType: 't', cwd: '/w', projectId: null, clientPreparationId: null, generation: 'g' }, 0, at)
    expect(openFailed(opening, { code: 'agent_cli_missing', message: 'x' }, true, at)).toMatchObject({ phase: 'failed', failure: { code: 'agent_cli_missing' } })
    expect(openFailed(opening, { code: 'runtime_timeout', message: 'x' }, false, at).phase).toBe('outcome_unknown')
    const cancelled = cancel(opening, at)
    expect(cancelled.phase).toBe('cancelled')
    expect(openFailed(cancelled, { code: 'x', message: 'x' }, false, at)).toBe(cancelled)
    expect(opened(cancelled, { nativeSessionId: 'n', hasOptions: true }, at)).toBe(cancelled)
  })

  it('expires unreserved preparations and refuses to cancel a reserved one', () => {
    const p = ready()
    expect(expire(p, PREPARATION_TTL_MS - 1, at)).toBeNull()
    expect(expire(p, PREPARATION_TTL_MS, at)).toMatchObject({ phase: 'expired', revision: 2 })
    const reserved = reserve(p, request(), 10, alive, at).preparation
    expect(expire(reserved, PREPARATION_TTL_MS * 2, at)).toBeNull()
    expect(rejection(() => cancel(reserved, at))).toBe('preparation_consumed')
  })

  it('after a restart expires what was held and rejects a reserved creation that never started', () => {
    const p = ready()
    expect(interrupted(p, at)).toMatchObject({ phase: 'expired', revision: 2 })
    const reserved = reserve(p, request(), 10, alive, at).preparation
    const recovered = interrupted(reserved, at)!
    expect(recovered.phase).toBe('expired')
    expect(creationWire(recovered, null, { agentSessionCreated: null })).toMatchObject({
      createOperationId: 'op_1', platformSessionId: 'sess_1', phase: 'rejected', messageAccepted: false,
      platformSessionCreated: null, failure: { code: 'initialization_interrupted' },
    })
    // A consumed preparation, a cancelled or an expired one stays as it is.
    expect(interrupted(cancel(p, at), at)).toBeNull()
    // The recovered creation answers its replays, for the session it was reserved for only.
    expect(begin(recovered, { createOperationId: 'op_1', sessionId: 'sess_1', clientMessageId: 'm1', selections: {}, configuration: {}, planningIntent: null, inputDigest: 'x' }, at).replayed).toBe(true)
    expect(rejection(() => begin(recovered, { createOperationId: 'op_1', sessionId: 'sess_2', clientMessageId: 'm1', selections: {}, configuration: {}, planningIntent: null, inputDigest: 'x' }, at))).toBe('operation_input_conflict')
  })

  it('takes the creation outcome from the first message delivery; a cancel without an outcome is unknown', () => {
    const consumed = begin(reserve(ready(), request(), 10, alive, at).preparation, { createOperationId: 'op_1', sessionId: 'sess_1', clientMessageId: 'm1', selections: { model: 'm2' }, configuration: {}, planningIntent: null, inputDigest: 'd' }, at).preparation
    const live = { agentSessionCreated: true }
    expect(creationWire(consumed, { state: 'accepted', errorCode: null }, live)).toMatchObject({ phase: 'submitting', messageAccepted: null, canCancelInitialization: true, platformSessionCreated: true, created: true })
    expect(creationWire(consumed, { state: 'started', errorCode: null }, live)).toMatchObject({ phase: 'accepted', messageAccepted: true, canCancelInitialization: false })
    expect(creationWire(consumed, { state: 'rejected', errorCode: 'session_busy' }, live)).toMatchObject({ phase: 'rejected', messageAccepted: false, failure: { code: 'session_busy' } })
    expect(creationWire(consumed, { state: 'unknown', errorCode: null }, live)).toMatchObject({ phase: 'outcome_unknown', messageAccepted: null })
    const cancelled = cancelCreation(consumed, null, at)
    expect(creationWire(cancelled, { state: 'sending', errorCode: null }, live)).toMatchObject({ phase: 'outcome_unknown', messageAccepted: null })
    expect(cancelCreation(consumed, true, at)).toBe(consumed)
  })

  it('shows the preparation view', () => {
    const view = preparationWire(ready(), { catalog: { runtime: 'opencode', revision: 1, models: [] }, options: [{ id: 'mode' }], interactions: [], canRespond: true })
    expect(view).toEqual({
      preparationId: 'prep_1', phase: 'ready', revision: 1, catalogRevision: 1,
      catalog: { runtime: 'opencode', revision: 1, models: [] },
      configuration: { revision: 1, options: [{ id: 'mode' }] },
      interactions: [], canRespond: true, canCancel: true, failure: null, expiresAt: PREPARATION_TTL_MS / 1000, cwd: '/w',
    })
  })
})
