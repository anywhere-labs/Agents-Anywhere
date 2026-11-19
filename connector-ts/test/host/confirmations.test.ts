import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import type { DeviceSecrets, TrustRepository } from '../../src/application/ports/trust.js'
import { DeviceTrustService } from '../../src/application/trust/device-trust-service.js'
import { nodeContentSealer } from '../../src/channel/formats.js'
import { generateX25519 } from '../../src/channel/noise/node-crypto.js'
import { clientIdFor, type DeviceTrustState } from '../../src/domain/trust/index.js'
import { LocalConfirmations, type ConfirmationEvent } from '../../src/host/index.js'

const request = { approverLabel: 'Phone', label: 'Browser', fingerprint: 'abcd abcd abcd abcd abcd abcd abcd abcd' }

class MemoryRepository implements TrustRepository {
  state: DeviceTrustState | null = null
  async load() {
    return this.state
  }
  async save(state: DeviceTrustState) {
    this.state = structuredClone(state)
  }
}

class MemorySecrets implements DeviceSecrets {
  readonly identity = generateX25519()
  readonly keys = new Map<string, Uint8Array>()
  async identityKey() {
    return { publicKey: this.identity.publicKey, secretKey: this.identity.secretKey }
  }
  async directoryKey(keyId: string) {
    return this.keys.get(keyId) ?? null
  }
  async putDirectoryKey(keyId: string, key: Uint8Array) {
    this.keys.set(keyId, key)
  }
  async deleteDirectoryKey(keyId: string) {
    this.keys.delete(keyId)
  }
}

/** A device with one paired client (the approver), confirming through `confirmations`. */
async function device(confirmations: LocalConfirmations) {
  const trust = new DeviceTrustService({
    deviceId: 'dev_home',
    repository: new MemoryRepository(),
    secrets: new MemorySecrets(),
    clock: { nowMs: () => Date.now(), nowIso: () => new Date().toISOString() },
    random: { bytes: n => new Uint8Array(randomBytes(n)), id: prefix => `${prefix}${randomBytes(6).toString('hex')}` },
    sealer: nodeContentSealer,
    confirmation: confirmations,
  })
  await trust.init()
  const approver = generateX25519()
  const approverId = clientIdFor(approver.publicKey)
  await trust.grantLocally({ clientId: approverId, identityPub: Buffer.from(approver.publicKey).toString('base64url'), label: 'Phone', platform: 'ios' })
  const newcomer = generateX25519()
  const client = { clientId: clientIdFor(newcomer.publicKey), identityPub: Buffer.from(newcomer.publicKey).toString('base64url'), label: 'Browser', platform: 'web' as const }
  return { trust, approverId, client }
}

async function next(iterator: AsyncGenerator<ConfirmationEvent>): Promise<ConfirmationEvent> {
  const item = await iterator.next()
  if (item.done === true) throw new Error('stream ended')
  return item.value
}

describe('LocalConfirmations (the person at this computer confirms, §7.2)', () => {
  it('with nobody to ask, a request is refused at once', async () => {
    expect(await new LocalConfirmations().confirmClientApproval(request)).toBe(false)
  })

  it('the terminal answers: only an explicit yes approves; a throwing prompt refuses', async () => {
    const confirmations = new LocalConfirmations()
    const undo = confirmations.useTerminal(async () => false)
    expect(await confirmations.confirmClientApproval(request)).toBe(false)
    confirmations.useTerminal(async () => {
      throw new Error('stdin closed')
    })
    expect(await confirmations.confirmClientApproval(request)).toBe(false)
    confirmations.useTerminal(async () => 'y' as unknown as boolean)
    expect(await confirmations.confirmClientApproval(request)).toBe(false)
    confirmations.useTerminal(async () => true)
    expect(await confirmations.confirmClientApproval(request)).toBe(true)
    undo()
  })

  it('an unanswered terminal prompt times out as refused and is aborted', async () => {
    const confirmations = new LocalConfirmations({ timeoutMs: 50 })
    let aborted = false
    confirmations.useTerminal((_request, signal) => new Promise(resolve => signal.addEventListener('abort', () => {
      aborted = true
      resolve(true)
    })))
    expect(await confirmations.confirmClientApproval(request)).toBe(false)
    expect(aborted).toBe(true)
  })

  it('a host following the stream sees pending requests and answers; late answers are not accepted', async () => {
    const confirmations = new LocalConfirmations({ timeoutMs: 5_000 })
    const abort = new AbortController()
    const stream = confirmations.follow(abort.signal)
    // The subscription exists once the generator runs; the first request then reaches it.
    const first = next(stream)
    await new Promise(resolve => setTimeout(resolve, 0))
    const answer = confirmations.confirmClientApproval(request)
    const requested = await first
    expect(requested).toMatchObject({ kind: 'requested', confirmation: { kind: 'client_approval', label: 'Browser', approverLabel: 'Phone' } })
    const id = (requested as Extract<ConfirmationEvent, { kind: 'requested' }>).confirmation.confirmationId
    expect(confirmations.answer(id, true)).toBe(true)
    expect(await answer).toBe(true)
    expect(await next(stream)).toEqual({ kind: 'settled', confirmationId: id, approved: true })
    expect(confirmations.answer(id, false)).toBe(false)
    abort.abort()
    expect((await stream.next()).done).toBe(true)
    expect(confirmations.answerable).toBe(false)
  })

  it('a subscriber that never answers: the request times out as refused', async () => {
    const confirmations = new LocalConfirmations({ timeoutMs: 50 })
    const abort = new AbortController()
    const stream = confirmations.follow(abort.signal)
    const first = next(stream)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await confirmations.confirmClientApproval(request)).toBe(false)
    expect((await first).kind).toBe('requested')
    expect(await next(stream)).toMatchObject({ kind: 'settled', approved: false })
    abort.abort()
  })
})

describe('Device Trust with LocalConfirmations: no confirmation, no grant', () => {
  it('nobody to ask: the approval is refused and the new client is not trusted', async () => {
    const { trust, approverId, client } = await device(new LocalConfirmations())
    await expect(trust.approveClient(approverId, client)).rejects.toMatchObject({ code: 'local_confirmation_required' })
    expect(trust.activeClientIds()).toEqual([approverId])
  })

  it('a refusal or a timeout on the terminal: not trusted', async () => {
    const confirmations = new LocalConfirmations({ timeoutMs: 50 })
    const { trust, approverId, client } = await device(confirmations)
    confirmations.useTerminal(async () => false)
    await expect(trust.approveClient(approverId, client)).rejects.toMatchObject({ code: 'local_confirmation_required' })
    confirmations.useTerminal(() => new Promise(() => undefined))
    await expect(trust.approveClient(approverId, client)).rejects.toMatchObject({ code: 'local_confirmation_required' })
    expect(trust.activeClientIds()).toEqual([approverId])
  })

  it('confirmed on this computer: trusted, granted by approval', async () => {
    const confirmations = new LocalConfirmations()
    const { trust, approverId, client } = await device(confirmations)
    const seen: string[] = []
    confirmations.useTerminal(async pending => {
      seen.push(`${pending.approverLabel} -> ${pending.label} ${pending.fingerprint}`)
      return true
    })
    expect(await trust.approveClient(approverId, client)).toMatchObject({ clientId: client.clientId, grantedBy: 'approval' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^Phone -> Browser [0-9a-f]{4}( [0-9a-f]{4}){7}$/u)
  })
})
