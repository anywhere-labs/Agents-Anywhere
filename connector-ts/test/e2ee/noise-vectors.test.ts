import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HandshakeState, type TransportPair } from '../../src/channel/noise/index.js'
import { nodeNoiseCrypto, x25519FromSecret } from '../../src/channel/noise/node-crypto.js'

type Hex = string
interface Message {
  readonly payload: Hex
  readonly ciphertext: Hex
  readonly sender?: 'initiator' | 'responder'
  readonly rekey_before?: boolean
}
interface Vector {
  readonly name?: string
  readonly protocol_name: string
  readonly handshake_messages?: number
  readonly handshake_hash?: Hex
  readonly messages: readonly Message[]
  readonly [field: string]: unknown
}
interface Negative {
  readonly name: string
  readonly base: string
  readonly override?: Record<string, unknown>
  readonly tamper?: { message: number; byte: number }
  readonly replay?: { message: number }
  readonly fail_at: number
}

const VECTORS = new URL('../../../contracts/e2ee/1.0/vectors/', import.meta.url)
const load = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, VECTORS), 'utf8')) as T
const official = load<{ vectors: Vector[] }>('noise-official.json')
const aa = load<{ vectors: Vector[]; negative: Negative[] }>('aa-noise.json')

const hex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'hex'))
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

function field(vector: Vector, name: string): string | undefined {
  const value = vector[name]
  return typeof value === 'string' ? value : undefined
}

async function party(vector: Vector, prefix: 'init' | 'resp'): Promise<HandshakeState> {
  const s = field(vector, `${prefix}_static`)
  const e = field(vector, `${prefix}_ephemeral`)
  const rs = field(vector, `${prefix}_remote_static`)
  const psks = (vector[`${prefix}_psks`] as string[] | undefined) ?? []
  return HandshakeState.create({
    crypto: nodeNoiseCrypto,
    protocolName: vector.protocol_name,
    initiator: prefix === 'init',
    prologue: hex(field(vector, `${prefix}_prologue`) ?? ''),
    ...(s ? { s: x25519FromSecret(hex(s)) } : {}),
    ...(e ? { e: x25519FromSecret(hex(e)) } : {}),
    ...(rs ? { rs: hex(rs) } : {}),
    psks: psks.map(hex),
  })
}

/** Runs a vector through the handshake and transport, comparing byte for byte. */
async function run(vector: Vector): Promise<void> {
  const initiator = await party(vector, 'init')
  const responder = await party(vector, 'resp')
  const handshakeCount = initiator.pattern.messages.length
  const oneWay = initiator.pattern.oneWay
  let transport: { initiator: TransportPair; responder: TransportPair } | null = null

  for (const [index, message] of vector.messages.entries()) {
    const sender = message.sender ?? (oneWay || index % 2 === 0 ? 'initiator' : 'responder')
    const payload = hex(message.payload)
    if (index < handshakeCount) {
      const [tx, rx] = sender === 'initiator' ? [initiator, responder] : [responder, initiator]
      const ciphertext = await tx.writeMessage(payload)
      expect(toHex(ciphertext), `${vector.protocol_name} message ${index}`).toBe(message.ciphertext)
      expect(toHex(await rx.readMessage(ciphertext))).toBe(message.payload)
      if (index === handshakeCount - 1) {
        transport = { initiator: initiator.takeTransport(), responder: responder.takeTransport() }
        expect(toHex(transport.initiator.handshakeHash)).toBe(toHex(transport.responder.handshakeHash))
        if (vector.handshake_hash) expect(toHex(transport.initiator.handshakeHash)).toBe(vector.handshake_hash)
      }
      continue
    }
    if (!transport) throw new Error('transport before handshake end')
    const tx = transport[sender]
    const rx = transport[sender === 'initiator' ? 'responder' : 'initiator']
    if (message.rekey_before) {
      await tx.send.rekey()
      await rx.receive.rekey()
    }
    const ciphertext = await tx.send.encryptWithAd(new Uint8Array(0), payload)
    expect(toHex(ciphertext), `${vector.protocol_name} transport ${index}`).toBe(message.ciphertext)
    expect(toHex(await rx.receive.decryptWithAd(new Uint8Array(0), ciphertext))).toBe(message.payload)
  }
}

/** Runs a negative case and returns the index of the message whose read fails. */
async function runNegative(negative: Negative): Promise<number | null> {
  const base = aa.vectors.find((vector) => vector.name === negative.base)!
  const vector: Vector = { ...base, ...negative.override }
  const messages = vector.messages.map((message) => ({ ...message }))
  if (negative.tamper) {
    const target = messages[negative.tamper.message]!
    const raw = hex(target.ciphertext)
    raw[negative.tamper.byte]! ^= 0x01
    messages[negative.tamper.message] = { ...target, ciphertext: toHex(raw) }
  }
  const initiator = await party(vector, 'init')
  const responder = await party(vector, 'resp')
  const handshakeCount = vector.handshake_messages!
  let transport: { initiator: TransportPair; responder: TransportPair } | null = null
  for (const [index, message] of messages.entries()) {
    const sender = message.sender!
    const ciphertext = hex(message.ciphertext)
    try {
      if (index < handshakeCount) {
        const [tx, rx] = sender === 'initiator' ? [initiator, responder] : [responder, initiator]
        await tx.writeMessage(hex(message.payload))
        await rx.readMessage(ciphertext)
        if (index === handshakeCount - 1) transport = { initiator: initiator.takeTransport(), responder: responder.takeTransport() }
      } else {
        const rx = transport![sender === 'initiator' ? 'responder' : 'initiator']
        if (message.rekey_before) {
          await transport![sender].send.rekey()
          await rx.receive.rekey()
        }
        await rx.receive.decryptWithAd(new Uint8Array(0), ciphertext)
        if (negative.replay?.message === index) await rx.receive.decryptWithAd(new Uint8Array(0), ciphertext)
      }
    } catch {
      return index
    }
  }
  return null
}

describe('official Noise test vectors (cacophony, snow, 25519_AESGCM_SHA256)', () => {
  it('covers the KK and XX psk0 variants AA uses', () => {
    const names = new Set(official.vectors.map((vector) => vector.protocol_name))
    expect(names).toContain('Noise_KK_25519_AESGCM_SHA256')
    expect(names).toContain('Noise_XXpsk0+psk1_25519_AESGCM_SHA256')
    expect(official.vectors.length).toBeGreaterThan(50)
  })
  for (const [index, vector] of official.vectors.entries()) {
    it(`${index}: ${vector.protocol_name}`, () => run(vector))
  }
})

describe('AA test vectors (contracts/e2ee/1.0/vectors/aa-noise.json)', () => {
  for (const vector of aa.vectors) {
    it(vector.name!, () => run(vector))
  }
  for (const negative of aa.negative) {
    it(`negative case ${negative.name}`, async () => {
      expect(await runNegative(negative)).toBe(negative.fail_at)
    })
  }
})
