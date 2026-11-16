import { describe, expect, it } from 'vitest'
import {
  MAX_OPEN_PAIRINGS,
  PAIRING_TTL_MS,
  approveClient,
  authorizeClient,
  clientIdFor,
  completePairing,
  declareServerMode,
  effectiveMode,
  newDeviceTrust,
  relaxPolicyLocally,
  revokeClient,
  startPairing,
  type NewClient,
} from '../../src/domain/trust/index.js'

const T0 = 1_000_000
const iso = (ms: number) => new Date(ms).toISOString()
const pub = (seed: number) => Buffer.alloc(32, seed).toString('base64url')
const client = (seed: number, label = `c${seed}`): NewClient => ({
  clientId: clientIdFor(Buffer.alloc(32, seed)),
  identityPub: pub(seed),
  label,
  platform: 'ios',
})

describe('DeviceTrust 不变量', () => {
  it('配对只能完成一次，过期后不能用', () => {
    let state = startPairing(newDeviceTrust('dev', pub(9), 'dk_0'), 'pair_1', T0).state
    state = completePairing(state, 'pair_1', client(1), T0 + 1, iso(T0)).state
    expect(() => completePairing(state, 'pair_1', client(2), T0 + 2, iso(T0))).toThrow(expect.objectContaining({ code: 'pairing_expired' }))
    state = startPairing(state, 'pair_2', T0).state
    expect(() => completePairing(state, 'pair_2', client(3), T0 + PAIRING_TTL_MS, iso(T0))).toThrow(
      expect.objectContaining({ code: 'pairing_expired' }),
    )
  })

  it(`最多 ${MAX_OPEN_PAIRINGS} 个打开的配对，过期的不占名额`, () => {
    let state = newDeviceTrust('dev', pub(9), 'dk_0')
    for (let i = 0; i < MAX_OPEN_PAIRINGS; i++) state = startPairing(state, `p${i}`, T0).state
    expect(() => startPairing(state, 'p9', T0)).toThrow(expect.objectContaining({ code: 'pairing_limit' }))
    const later = startPairing(state, 'p9', T0 + PAIRING_TTL_MS)
    expect(later.events.filter((event) => event.type === 'PairingExpired')).toHaveLength(MAX_OPEN_PAIRINGS)
  })

  it('clientId 必须由公钥派生', () => {
    const state = startPairing(newDeviceTrust('dev', pub(9), 'dk_0'), 'pair_1', T0).state
    expect(() => completePairing(state, 'pair_1', { ...client(1), clientId: client(2).clientId }, T0, iso(T0))).toThrow(
      expect.objectContaining({ code: 'client_id_mismatch' }),
    )
  })

  it('撤销立即生效并轮换列表密钥', () => {
    let state = startPairing(newDeviceTrust('dev', pub(9), 'dk_0'), 'pair_1', T0).state
    state = completePairing(state, 'pair_1', client(1), T0, iso(T0)).state
    const { state: revoked, events } = revokeClient(state, client(1).clientId, iso(T0), 'dk_1')
    expect(events.map((event) => event.type)).toEqual(['ClientRevoked', 'DirectoryKeyRotated'])
    expect(revoked.directoryKey).toEqual({ keyId: 'dk_1', epoch: 1, retiredKeyIds: ['dk_0'] })
    expect(() => authorizeClient(revoked, client(1).clientId)).toThrow(expect.objectContaining({ code: 'e2ee_not_paired' }))
  })

  it('批准需要授权客户端发起并经本机确认', () => {
    let state = startPairing(newDeviceTrust('dev', pub(9), 'dk_0'), 'pair_1', T0).state
    state = completePairing(state, 'pair_1', client(1), T0, iso(T0)).state
    expect(() => approveClient(state, client(5).clientId, client(2), iso(T0), true)).toThrow(
      expect.objectContaining({ code: 'approver_not_authorized' }),
    )
    expect(() => approveClient(state, client(1).clientId, client(2), iso(T0), false)).toThrow(
      expect.objectContaining({ code: 'local_confirmation_required' }),
    )
    expect(authorizeClient(approveClient(state, client(1).clientId, client(2), iso(T0), true).state, client(2).clientId).grantedBy).toBe(
      'approval',
    )
  })

  it('Server 的声明只能收紧，本机确认才能放松', () => {
    let state = newDeviceTrust('dev', pub(9), 'dk_0')
    expect(effectiveMode(state, 'off')).toBe('off')
    state = declareServerMode(state, 'required', iso(T0)).state
    state = declareServerMode(state, 'off', iso(T0)).state
    expect(effectiveMode(state, 'off')).toBe('required')
    expect(() => relaxPolicyLocally(state, iso(T0), false)).toThrow(expect.objectContaining({ code: 'local_confirmation_required' }))
    expect(effectiveMode(relaxPolicyLocally(state, iso(T0), true).state, 'off')).toBe('off')
  })
})
