import { CLIENT_ID_PATTERN, clientIdFor } from './client-id.js'
import { TrustError } from './errors.js'

/**
 * DeviceTrust (docs/v3/11-e2ee-noise.md §4.1–§4.3): who may open a secure channel to this device. Only rules live
 * here; keys, Noise and storage are outside. The aggregate is an immutable value; every change returns the next
 * state and the domain events it produced.
 *
 * Invariants:
 * 1. Only the device changes its trust list: a grant comes from a completed pairing, an approval by an active
 *    client confirmed on this machine, or a local grant (Desktop on the same machine). Nothing the Server says
 *    adds, revokes or restores a grant.
 * 2. Revocation takes effect at once and rotates the directory key (new epoch).
 * 3. Once `policy.required` is set, only a local user action clears it; the Server declaring `off` changes nothing.
 * 4. A grant's clientId is derived from its identity key, so a relay cannot pair one key under another id.
 */

export const PAIRING_TTL_MS = 10 * 60 * 1000
export const MAX_OPEN_PAIRINGS = 3

export type E2eeMode = 'off' | 'required'
export type GrantSource = 'qr' | 'approval' | 'local'
export type ClientPlatform = 'web' | 'desktop' | 'android' | 'ios' | 'cli'

export interface ClientGrant {
  readonly clientId: string
  /** X25519 identity public key, base64url without padding. */
  readonly identityPub: string
  readonly label: string
  readonly platform: ClientPlatform | null
  readonly grantedBy: GrantSource
  readonly grantedAt: string
  readonly revokedAt: string | null
}

export type PairingState = 'open' | 'consumed' | 'expired' | 'cancelled'

/** A pairing invitation. The psk itself never enters the domain; it stays with the key store, in memory. */
export interface PairingSession {
  readonly pairingId: string
  readonly expiresAtMs: number
  readonly state: PairingState
}

export interface DirectoryKeyRef {
  readonly keyId: string
  readonly epoch: number
  /** Older keys kept until every envelope sealed with them has been resealed. */
  readonly retiredKeyIds: readonly string[]
}

export interface LocalSecurityPolicy {
  readonly required: boolean
  readonly requiredSince: string | null
  /** Headless devices may let an authorised client approve another one without a local prompt (§7.2). */
  readonly approvalWithoutConfirmation: boolean
}

export interface DeviceTrustState {
  readonly deviceId: string
  readonly identityPub: string
  readonly grants: readonly ClientGrant[]
  readonly pairings: readonly PairingSession[]
  readonly directoryKey: DirectoryKeyRef
  readonly policy: LocalSecurityPolicy
}

export type TrustEvent =
  | { readonly type: 'PairingStarted'; readonly pairingId: string; readonly expiresAtMs: number }
  | { readonly type: 'PairingExpired'; readonly pairingId: string }
  | { readonly type: 'ClientPaired'; readonly grant: ClientGrant }
  | { readonly type: 'ClientRevoked'; readonly clientId: string }
  | { readonly type: 'DirectoryKeyRotated'; readonly keyId: string; readonly epoch: number; readonly previousKeyId: string }
  | { readonly type: 'SecurityPolicyRequired'; readonly since: string }
  | { readonly type: 'SecurityPolicyRelaxed'; readonly at: string }

export interface Change {
  readonly state: DeviceTrustState
  readonly events: readonly TrustEvent[]
}

export interface NewClient {
  readonly clientId: string
  readonly identityPub: string
  readonly label: string
  readonly platform: ClientPlatform | null
}

export function newDeviceTrust(deviceId: string, identityPub: string, directoryKeyId: string): DeviceTrustState {
  return {
    deviceId,
    identityPub,
    grants: [],
    pairings: [],
    directoryKey: { keyId: directoryKeyId, epoch: 0, retiredKeyIds: [] },
    policy: { required: false, requiredSince: null, approvalWithoutConfirmation: false },
  }
}

/** The mode this device enforces: the stricter of the Server's declaration and the local policy. */
export function effectiveMode(state: DeviceTrustState, serverMode: E2eeMode): E2eeMode {
  return state.policy.required || serverMode === 'required' ? 'required' : 'off'
}

export function activeGrants(state: DeviceTrustState): readonly ClientGrant[] {
  return state.grants.filter((grant) => grant.revokedAt === null)
}

function expire(state: DeviceTrustState, nowMs: number): Change {
  const events: TrustEvent[] = []
  const pairings = state.pairings.flatMap((pairing): PairingSession[] => {
    if (pairing.state !== 'open') return []
    if (pairing.expiresAtMs <= nowMs) {
      events.push({ type: 'PairingExpired', pairingId: pairing.pairingId })
      return []
    }
    return [pairing]
  })
  return { state: events.length === 0 && pairings.length === state.pairings.length ? state : { ...state, pairings }, events }
}

/** Drop expired and finished pairings; call on a timer so the UI can hide stale QR codes. */
export function expirePairings(state: DeviceTrustState, nowMs: number): Change {
  return expire(state, nowMs)
}

export function startPairing(state: DeviceTrustState, pairingId: string, nowMs: number): Change {
  const swept = expire(state, nowMs)
  if (swept.state.pairings.length >= MAX_OPEN_PAIRINGS) {
    throw new TrustError('pairing_limit', `at most ${MAX_OPEN_PAIRINGS} pairings may be open at once`)
  }
  if (swept.state.pairings.some((pairing) => pairing.pairingId === pairingId)) {
    throw new TrustError('invalid_argument', 'duplicate pairing id')
  }
  const pairing: PairingSession = { pairingId, expiresAtMs: nowMs + PAIRING_TTL_MS, state: 'open' }
  return {
    state: { ...swept.state, pairings: [...swept.state.pairings, pairing] },
    events: [...swept.events, { type: 'PairingStarted', pairingId, expiresAtMs: pairing.expiresAtMs }],
  }
}

export function cancelPairing(state: DeviceTrustState, pairingId: string): Change {
  return { state: { ...state, pairings: state.pairings.filter((pairing) => pairing.pairingId !== pairingId) }, events: [] }
}

/** The pairing a handshake names must be open and unexpired (checked before the handshake and again at commit). */
export function requireOpenPairing(state: DeviceTrustState, pairingId: string, nowMs: number): PairingSession {
  const pairing = state.pairings.find((candidate) => candidate.pairingId === pairingId)
  if (!pairing || pairing.state !== 'open' || pairing.expiresAtMs <= nowMs) {
    throw new TrustError('pairing_expired', 'the pairing code has expired or was already used')
  }
  return pairing
}

function checkClient(client: NewClient): void {
  if (!CLIENT_ID_PATTERN.test(client.clientId)) throw new TrustError('invalid_argument', 'malformed client id')
  if (clientIdFor(Buffer.from(client.identityPub, 'base64url')) !== client.clientId) {
    throw new TrustError('client_id_mismatch', 'client id does not belong to this identity key')
  }
}

function addGrant(state: DeviceTrustState, client: NewClient, grantedBy: GrantSource, nowIso: string): Change {
  checkClient(client)
  const grant: ClientGrant = {
    clientId: client.clientId,
    identityPub: client.identityPub,
    label: client.label,
    platform: client.platform,
    grantedBy,
    grantedAt: nowIso,
    revokedAt: null,
  }
  // Re-pairing a revoked client (or a reinstalled one with the same key) replaces the old record.
  const grants = [...state.grants.filter((existing) => existing.clientId !== client.clientId), grant]
  return { state: { ...state, grants }, events: [{ type: 'ClientPaired', grant }] }
}

/** Consume the pairing and write the grant in one step: a pairing grants exactly one client. */
export function completePairing(
  state: DeviceTrustState,
  pairingId: string,
  client: NewClient,
  nowMs: number,
  nowIso: string,
): Change {
  requireOpenPairing(state, pairingId, nowMs)
  const consumed: DeviceTrustState = {
    ...state,
    pairings: state.pairings.filter((pairing) => pairing.pairingId !== pairingId),
  }
  return addGrant(consumed, client, 'qr', nowIso)
}

/** Desktop on the same machine writes the grant through the local control interface; no QR code needed. */
export function grantLocally(state: DeviceTrustState, client: NewClient, nowIso: string): Change {
  return addGrant(state, client, 'local', nowIso)
}

/** §7.2: an authorised client vouches for another key; the device user confirms unless the policy waives it. */
export function approveClient(
  state: DeviceTrustState,
  approverClientId: string,
  client: NewClient,
  nowIso: string,
  confirmedLocally: boolean,
): Change {
  if (!activeGrants(state).some((grant) => grant.clientId === approverClientId)) {
    throw new TrustError('approver_not_authorized', 'only an authorised client may approve another client')
  }
  if (!confirmedLocally && !state.policy.approvalWithoutConfirmation) {
    throw new TrustError('local_confirmation_required', 'the approval was not confirmed on this device')
  }
  return addGrant(state, client, 'approval', nowIso)
}

/** Revoke at once and rotate the directory key; the caller closes the client's channels on `ClientRevoked`. */
export function revokeClient(state: DeviceTrustState, clientId: string, nowIso: string, nextKeyId: string): Change {
  const target = activeGrants(state).find((grant) => grant.clientId === clientId)
  if (!target) throw new TrustError('e2ee_not_paired', 'this client has no active grant')
  const grants = state.grants.map((grant) => (grant.clientId === clientId ? { ...grant, revokedAt: nowIso } : grant))
  const rotated = rotateDirectoryKey({ ...state, grants }, nextKeyId)
  return { state: rotated.state, events: [{ type: 'ClientRevoked', clientId }, ...rotated.events] }
}

export function rotateDirectoryKey(state: DeviceTrustState, nextKeyId: string): Change {
  const previous = state.directoryKey
  if (nextKeyId === previous.keyId || previous.retiredKeyIds.includes(nextKeyId)) {
    throw new TrustError('invalid_argument', 'directory key ids must not repeat')
  }
  const directoryKey: DirectoryKeyRef = {
    keyId: nextKeyId,
    epoch: previous.epoch + 1,
    retiredKeyIds: [...previous.retiredKeyIds, previous.keyId],
  }
  return {
    state: { ...state, directoryKey },
    events: [{ type: 'DirectoryKeyRotated', keyId: nextKeyId, epoch: directoryKey.epoch, previousKeyId: previous.keyId }],
  }
}

/** Every envelope sealed with `keyId` was resealed: the old key may be destroyed. */
export function retireDirectoryKey(state: DeviceTrustState, keyId: string): Change {
  if (!state.directoryKey.retiredKeyIds.includes(keyId)) return { state, events: [] }
  const retiredKeyIds = state.directoryKey.retiredKeyIds.filter((id) => id !== keyId)
  return { state: { ...state, directoryKey: { ...state.directoryKey, retiredKeyIds } }, events: [] }
}

/**
 * The client's grant, checked against the key it proved in the handshake (or, for KK, the key we must pin as the
 * remote static before the handshake starts).
 */
export function authorizeClient(state: DeviceTrustState, clientId: string, identityPub?: string): ClientGrant {
  const grant = activeGrants(state).find((candidate) => candidate.clientId === clientId)
  if (!grant) throw new TrustError('e2ee_not_paired', 'this client is not authorised on this device')
  if (identityPub !== undefined && identityPub !== grant.identityPub) {
    throw new TrustError('e2ee_not_paired', 'the client key does not match its grant')
  }
  return grant
}

/** The Server's declaration is only ever a reason to tighten (§6 "声明，不是命令"). */
export function declareServerMode(state: DeviceTrustState, serverMode: E2eeMode, nowIso: string): Change {
  if (serverMode !== 'required' || state.policy.required) return { state, events: [] }
  return {
    state: { ...state, policy: { ...state.policy, required: true, requiredSince: nowIso } },
    events: [{ type: 'SecurityPolicyRequired', since: nowIso }],
  }
}

/** Only a person at this device (Desktop settings, an interactive CLI confirmation) may relax the policy. */
export function relaxPolicyLocally(state: DeviceTrustState, nowIso: string, confirmedByLocalUser: boolean): Change {
  if (!confirmedByLocalUser) throw new TrustError('local_confirmation_required', 'downgrading needs a local confirmation')
  if (!state.policy.required) return { state, events: [] }
  return {
    state: { ...state, policy: { ...state.policy, required: false, requiredSince: null } },
    events: [{ type: 'SecurityPolicyRelaxed', at: nowIso }],
  }
}

export function setApprovalWithoutConfirmation(state: DeviceTrustState, enabled: boolean): DeviceTrustState {
  return { ...state, policy: { ...state.policy, approvalWithoutConfirmation: enabled } }
}
