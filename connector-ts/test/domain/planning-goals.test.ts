import { describe, expect, it } from 'vitest'

import {
  GoalConflict,
  checkRequest,
  goalStateSummary,
  goalWire,
  initialGoalState,
  observe,
  unobservedGoalState,
} from '../../src/domain/goals/index.js'
import {
  PlanningConflict,
  finalize,
  initialPlanning,
  observeMode,
  planContentHash,
  planStateSummary,
  planTitle,
  planningCapabilities,
  planningWire,
  requireReview,
  setReviewStatus,
  updateDraft,
} from '../../src/domain/planning/index.js'

describe('planning', () => {
  it('titles plans like v2 plan_title', () => {
    expect(planTitle('# Fix the *bug*:\n\nbody')).toBe('Fix the bug')
    expect(planTitle('1. step one\n2. two')).toBe('step one')
    expect(planTitle('   \n> quote __here__ ok')).toBe('quote here ok')
    expect(planTitle('x'.repeat(70))).toBe(`${'x'.repeat(59)}…`)
    expect(planTitle('')).toBe('计划')
  })

  it('hashes plans like v2 content_hash and refuses empty ones', () => {
    expect(planContentHash('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(() => planContentHash('  ')).toThrow()
  })

  it('creates immutable revisions and requires the current hash to approve', () => {
    let state = observeMode(initialPlanning('sess_1', 'claude', 'ep1'), 'plan')
    state = updateDraft(state, 'native-1', '# Plan', false)
    expect(planStateSummary(state)).toBe('planning')
    const first = finalize(state, { nativeId: 'native-1', text: '# Plan\n- a', turnId: 'turn1', at: 't1', nativeReview: null, reviewActions: null })
    expect(first.document?.revision).toBe(1)
    expect(first.state.draft).toBeNull()
    expect(planStateSummary(first.state)).toBe('awaiting_review')
    const review = first.state.review!
    const request = { reviewId: review.reviewId, planId: review.planId, planRevision: 1, contentHash: review.contentHash }
    expect(requireReview(first.state, request)).toBe(review)
    expect(() => requireReview(first.state, { ...request, contentHash: 'sha256:other' })).toThrow(PlanningConflict)

    // The same text again is not a new revision.
    const again = finalize(first.state, { nativeId: 'native-1', text: '# Plan\n- a', turnId: 'turn2', at: 't2', nativeReview: null, reviewActions: null })
    expect(again.document).toBeNull()

    // A requested revision keeps the planId and bumps the version.
    const revising = setReviewStatus(first.state, 'revision_requested')
    const second = finalize(revising, { nativeId: 'native-2', text: '# Plan\n- b', turnId: 'turn3', at: 't3', nativeReview: null, reviewActions: null })
    expect(second.document).toMatchObject({ planId: review.planId, revision: 2 })
    expect(second.state.proposals[0]?.markdown).toBe('')
    expect((planningWire(second.state).proposal as { revision: number }).revision).toBe(2)
  })

  it('refuses approval while the state is not fresh', () => {
    const done = finalize(observeMode(initialPlanning('s', 'claude', 'e'), 'plan'), { nativeId: 'n', text: 'x', turnId: null, at: 't', nativeReview: null, reviewActions: null })
    const stale = { ...done.state, freshness: 'stale' as const }
    const r = done.state.review!
    expect(() => requireReview(stale, { reviewId: r.reviewId, planId: r.planId, planRevision: r.planRevision, contentHash: r.contentHash })).toThrow(PlanningConflict)
  })
})

describe('goals', () => {
  const ids = { newId: () => 'goal_1', now: '2026-11-16T00:00:00Z' }
  const fresh = observe(initialGoalState({ sessionId: 's', runtime: 'codex', runtimeId: null, sourceEpoch: 'e' }), { goal: null, empty: true }, ids)

  it('checks revision and allowed actions', () => {
    expect(() => checkRequest(fresh, { action: 'set', expectedRevision: fresh.revision, objective: 'ship', operationId: 'op1' })).not.toThrow()
    expect(() => checkRequest(fresh, { action: 'set', expectedRevision: fresh.revision + 1, objective: 'ship', operationId: 'op1' })).toThrow(GoalConflict)
    expect(() => checkRequest(fresh, { action: 'pause', expectedRevision: fresh.revision, operationId: 'op1' })).toThrow(GoalConflict)
    expect(() => checkRequest(fresh, { action: 'set', expectedRevision: fresh.revision, objective: ' ', operationId: 'op1' })).toThrow()
  })

  it('continues the same target, replaces a different one, and records terminal outcomes', () => {
    const active = observe(fresh, { goal: { objective: 'ship', status: 'active', nativeIdentity: 'g1' }, empty: false }, ids)
    expect(active.goal).toMatchObject({ id: 'goal_1', objective: 'ship', status: 'active' })
    expect(goalStateSummary(active)).toBe('active')
    const paused = observe(active, { goal: { objective: 'ship', status: 'paused', nativeIdentity: 'g1' }, empty: false }, { ...ids, newId: () => 'x' })
    expect(paused.goal).toMatchObject({ id: 'goal_1', status: 'paused' })
    expect(goalStateSummary(paused)).toBe('paused')
    const replaced = observe(paused, { goal: { objective: 'other', status: 'active', nativeIdentity: 'g2' }, empty: false }, { ...ids, newId: () => 'goal_2' })
    expect(replaced.lastOutcome).toMatchObject({ id: 'goal_1', status: 'replaced' })
    expect(replaced.goal?.id).toBe('goal_2')
    const done = observe(replaced, { goal: { objective: 'other', status: 'complete', nativeIdentity: 'g2' }, empty: false }, ids)
    expect(done.goal).toBeNull()
    expect(goalStateSummary(done)).toBe('completed')
    expect(done.revision).toBeGreaterThan(replaced.revision)
  })

  it('does not bump the revision for an unchanged observation', () => {
    const active = observe(fresh, { goal: { objective: 'ship', status: 'active', nativeIdentity: 'g1' }, empty: false }, ids)
    expect(observe(active, { goal: { objective: 'ship', status: 'active', nativeIdentity: 'g1' }, empty: false }, ids).revision).toBe(active.revision)
  })

  it('hides controls from callers that may not write', () => {
    expect((goalWire(fresh, false).capabilities as { actions: unknown[] }).actions).toEqual([])
    expect((goalWire(fresh, true).capabilities as { actions: unknown[] }).actions.length).toBe(5)
  })
})

describe('states read before the Runtime reported anything', () => {
  it('lists the planning commands the capabilities allow', () => {
    expect(planningCapabilities({ modes: true, review: true }).actions).toEqual(['enter_plan', 'exit_plan', 'approve_and_execute', 'request_revision', 'dismiss_review'])
    expect(planningCapabilities({ modes: false, review: true })).toMatchObject({ supported: true, actions: ['approve_and_execute', 'request_revision', 'dismiss_review'] })
    expect(planningCapabilities({ modes: false, review: false })).toMatchObject({ supported: false, actions: [] })
  })

  it('offers the declared goal actions on a fresh empty goal, or nothing without support', () => {
    const input = { sessionId: 's', runtime: 'codex', runtimeId: 'codex', externalSessionId: 'thr' }
    expect(unobservedGoalState(input, ['set', 'clear', 'bogus'])).toMatchObject({ freshness: 'fresh', goal: null, externalSessionId: 'thr', capabilities: { supported: true, actions: ['set', 'clear'] } })
    expect(unobservedGoalState(input, null)).toMatchObject({ freshness: 'unknown', capabilities: { supported: false, actions: [] } })
  })
})
