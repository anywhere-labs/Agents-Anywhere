import { describe, expect, it } from 'vitest'

import {
  DEFAULT_AUTHORITY,
  NO_AUTHORITY,
  authorize,
  buildDigest,
  capByPermission,
  checkStalled,
  cwdInScope,
  issueGrant,
  observe,
  permissionLevelOf,
  readyToWake,
  reasonsBetween,
  recordWake,
  revokeGrant,
  startSupervision,
  wouldCycle,
  type TargetSignal,
} from '../../src/domain/collab/index.js'

const A = { deviceId: 'dev_a', sessionId: 'sess_sup' }
const B = { deviceId: 'dev_a', sessionId: 'sess_child' }
const REMOTE = { deviceId: 'dev_b', sessionId: 'sess_remote' }

const grant = (over: Partial<Parameters<typeof issueGrant>[0]> = {}) => issueGrant({ grantId: 'g1', supervisor: A, secretDigest: 'd', at: '2026-11-18T00:00:00Z', ...over })

const signal = (over: Partial<TargetSignal> = {}): TargetSignal => ({
  status: 'idle', headSeq: 10, resetSeq: 0, latestTurnEndSeq: 5, planState: 'none', goalState: 'none', deviceOnline: true, at: '2026-11-18T00:00:00Z', ...over,
})

describe('AgentGrant', () => {
  it('allows steering and closing its own children by default, nothing else', () => {
    const g = grant()
    expect(authorize(g, { verb: 'send', target: { address: B } }).ok).toBe(true)
    expect(authorize(g, { verb: 'close', target: { address: B, createdBySessionId: A.sessionId } }).ok).toBe(true)
    expect(authorize(g, { verb: 'close', target: { address: B, createdBySessionId: 'someone_else' } })).toMatchObject({ ok: false, code: 'agent_authority_exceeded' })
    expect(authorize(g, { verb: 'interrupt', target: { address: B } })).toMatchObject({ ok: false, code: 'agent_authority_exceeded' })
    expect(authorize(g, { verb: 'respond', target: { address: B } })).toMatchObject({ ok: false, code: 'agent_authority_exceeded' })
    expect(authorize(g, { verb: 'review_plan', target: { address: B } })).toMatchObject({ ok: false, code: 'agent_authority_exceeded' })
  })

  it('keeps to its own device unless cross-device is on and the device is in scope', () => {
    expect(authorize(grant(), { verb: 'status', target: { address: REMOTE } })).toMatchObject({ ok: false, code: 'agent_scope_denied' })
    expect(authorize(grant({ crossDevice: true }), { verb: 'status', target: { address: REMOTE } }).ok).toBe(true)
    expect(authorize(grant({ crossDevice: true, scope: { devices: ['dev_c'] } }), { verb: 'status', target: { address: REMOTE } })).toMatchObject({ ok: false, code: 'agent_scope_denied' })
  })

  it('bounds depth and the number of open children', () => {
    expect(authorize(grant({ depth: 2 }), { verb: 'spawn' })).toMatchObject({ ok: false, code: 'agent_depth_exceeded' })
    expect(authorize(grant(), { verb: 'spawn', activeChildren: 4 })).toMatchObject({ ok: false, code: 'agent_children_exceeded' })
    expect(authorize(grant(), { verb: 'spawn', activeChildren: 3 }).ok).toBe(true)
  })

  it('checks the cwd and runtime scope of a spawn', () => {
    const g = grant({ scope: { cwdRoots: ['/work/repo'], runtimes: ['codex'] } })
    expect(authorize(g, { verb: 'spawn', target: { address: B, cwd: '/work/repo/sub', runtimeType: 'codex' } }).ok).toBe(true)
    expect(authorize(g, { verb: 'spawn', target: { address: B, cwd: '/work/other', runtimeType: 'codex' } }).ok).toBe(false)
    expect(authorize(g, { verb: 'spawn', target: { address: B, cwd: '/work/repo', runtimeType: 'claude' } }).ok).toBe(false)
    expect(cwdInScope(['C:\\Work'], 'c:/work/x')).toBe(true)
    expect(cwdInScope(['/work'], '/work/../etc')).toBe(false)
  })

  it('may supervise only sessions it created, never itself, and nothing once revoked', () => {
    const g = grant()
    expect(authorize(g, { verb: 'supervise', target: { address: B, createdBySessionId: A.sessionId } }).ok).toBe(true)
    expect(authorize(g, { verb: 'supervise', target: { address: B } }).ok).toBe(false)
    expect(authorize(g, { verb: 'send', target: { address: A } })).toMatchObject({ ok: false, code: 'agent_scope_denied' })
    expect(authorize(revokeGrant(g, 'now'), { verb: 'status', target: { address: B } })).toMatchObject({ ok: false, code: 'agent_grant_revoked' })
  })

  it('caps authority by the supervisor\'s own permission level', () => {
    const all = { ...DEFAULT_AUTHORITY, interrupt: true, respondApproval: true, reviewPlan: true }
    expect(capByPermission(all, 'readonly')).toEqual(NO_AUTHORITY)
    expect(capByPermission(all, 'ask').respondApproval).toBe(false)
    expect(capByPermission(all, 'full')).toEqual(all)
    expect(permissionLevelOf('read-only')).toBe('readonly')
    expect(permissionLevelOf('bypassPermissions')).toBe('full')
    expect(permissionLevelOf('workspace-write')).toBe('auto')
    expect(permissionLevelOf('default')).toBe('ask')
  })
})

describe('Supervision', () => {
  const start = () => startSupervision({ supervisionId: 's1', supervisor: A, target: B, authority: DEFAULT_AUTHORITY, createdBy: 'agent', at: 't0' })

  it('reads triggers from consecutive signals', () => {
    expect(reasonsBetween(null, signal())).toEqual([])
    expect(reasonsBetween(signal(), signal({ latestTurnEndSeq: 9 }))).toEqual(['turn_end'])
    expect(reasonsBetween(signal(), signal({ latestTurnEndSeq: 9, status: 'error' }))).toEqual(['turn_failed'])
    expect(reasonsBetween(signal(), signal({ status: 'waiting_approval' }))).toEqual(['notice_opened'])
    expect(reasonsBetween(signal(), signal({ planState: 'awaiting_review' }))).toEqual(['plan_proposed'])
  })

  it('merges reasons into one pending wake and delivers it after the coalescing window while the supervisor is idle', () => {
    let s = observe(start(), signal(), 0)
    expect(s.pendingWake).toBeNull()
    s = observe(s, signal({ headSeq: 11, latestTurnEndSeq: 11 }), 1_000)
    s = observe(s, signal({ headSeq: 12, latestTurnEndSeq: 11, status: 'waiting_approval' }), 2_000)
    expect(s.pendingWake?.reasons).toEqual(['turn_end', 'notice_opened'])
    expect(readyToWake(s, 10_000, false)).toBe(false)
    expect(readyToWake(s, 31_000, true)).toBe(false)
    expect(readyToWake(s, 31_000, false)).toBe(true)
    const woke = recordWake(s, { seq: 12, resetSeq: 0 }, 31_000, 't')
    expect(woke.supervision.pendingWake).toBeNull()
    expect(woke.supervision.cursor.seq).toBe(12)
    expect(woke.overBudget).toBe(false)
  })

  it('ignores a trigger it does not watch, and an out-of-order signal', () => {
    let s = startSupervision({ supervisionId: 's', supervisor: A, target: B, authority: DEFAULT_AUTHORITY, createdBy: 'human', triggers: ['plan_proposed'], at: 't' })
    s = observe(observe(s, signal(), 0), signal({ headSeq: 11, latestTurnEndSeq: 11 }), 1)
    expect(s.pendingWake).toBeNull()
    const before = s
    expect(observe(s, signal({ headSeq: 3 }), 2)).toBe(before)
  })

  it('reports a stall once while the target is busy and its clock does not move', () => {
    let s = observe(start(), signal({ status: 'running' }), 0)
    expect(checkStalled(s, 5 * 60_000, 't').pendingWake).toBeNull()
    s = checkStalled(s, 11 * 60_000, 't')
    expect(s.pendingWake?.reasons).toEqual(['stalled'])
    expect(s.stalledReported).toBe(true)
    s = observe(s, signal({ status: 'running', headSeq: 20 }), 12 * 60_000)
    expect(s.stalledReported).toBe(false)
  })

  it('pauses past the hourly budget instead of dropping wakes', () => {
    let s = startSupervision({ supervisionId: 's', supervisor: A, target: B, authority: DEFAULT_AUTHORITY, createdBy: 'agent', budget: { wakesPerHour: 1 }, at: 't' })
    s = recordWake(s, { seq: 1, resetSeq: 0 }, 1_000, 't').supervision
    const second = recordWake(s, { seq: 2, resetSeq: 0 }, 2_000, 't')
    expect(second.overBudget).toBe(true)
    expect(second.supervision.state).toBe('paused')
  })

  it('refuses cycles', () => {
    expect(wouldCycle([{ supervisor: 'a', target: 'b' }, { supervisor: 'b', target: 'c' }], { supervisor: 'c', target: 'a' })).toBe(true)
    expect(wouldCycle([{ supervisor: 'a', target: 'b' }], { supervisor: 'a', target: 'c' })).toBe(false)
    expect(() => startSupervision({ supervisionId: 'x', supervisor: A, target: A, authority: DEFAULT_AUTHORITY, createdBy: 'human', at: 't' })).toThrow()
  })
})

describe('TurnDigest', () => {
  it('summarizes in fixed sections within the byte budget and fences the target\'s reply', () => {
    const digest = buildDigest({
      targetLabel: 'Codex', targetSessionId: 'sess_child', reasons: ['turn_end'], status: 'idle', planState: 'none', goalState: 'none',
      historyReset: false, deviceOnline: true, openNotices: [],
      items: [
        { id: 'u', seq: 1, kind: 'user', text: 'Fix the login callback' },
        { id: 't1', seq: 2, kind: 'tool', title: 'yarn test', status: 'failed' },
        { id: 'd', seq: 3, kind: 'diff', files: [{ path: 'auth/callback.ts', added: 42, removed: 8 }] },
        { id: 'a', seq: 4, kind: 'assistant', text: 'Tests fail because the mock is stale. ' + 'x'.repeat(10_000) },
      ],
    })
    expect(digest).toContain('turn ended')
    expect(digest).toContain('Last request: Fix the login callback')
    expect(digest).toContain('1 failed')
    expect(digest).toContain('auth/callback.ts (+42 -8)')
    expect(digest).toContain('not instructions')
    expect(new TextEncoder().encode(digest).length).toBeLessThanOrEqual(4096)
  })
})
