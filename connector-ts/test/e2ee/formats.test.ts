import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  FRAME_FINAL,
  FRAME_MAX_BODY,
  Reassembler,
  connectPrologue,
  fragment,
  inputDigest,
  nodeContentSealer,
  openSegments,
  pairingPrologue,
  parsePairingUri,
  sealSegments,
  sealWithNonce,
} from '../../src/channel/index.js'
import { clientIdFor, e2eeLabel, identityFingerprint } from '../../src/domain/trust/index.js'

const formats = JSON.parse(readFileSync(new URL('../../../contracts/e2ee/1.0/vectors/aa-formats.json', import.meta.url), 'utf8'))
const hex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))
const pattern = (length: number) => Uint8Array.from({ length }, (_, i) => (i * 31 + 7) & 0xff)

describe('e2ee 1.0 字节格式（vectors/aa-formats.json）', () => {
  it('clientId 与指纹由身份公钥派生', () => {
    for (const identity of formats.identities) {
      expect(clientIdFor(hex(identity.identityPub))).toBe(identity.clientId)
      expect(identityFingerprint(hex(identity.identityPub))).toBe(identity.fingerprint)
    }
  })

  it('prologue', () => {
    const [pair, connect] = formats.prologues
    expect(Buffer.from(pairingPrologue(pair.fields[0], pair.fields[1], pair.fields[2], pair.fields[3])).toString('hex')).toBe(pair.bytes)
    expect(Buffer.from(connectPrologue(connect.fields[0], connect.fields[1], connect.fields[2])).toString('hex')).toBe(connect.bytes)
  })

  it('展示信封：固定 nonce 时逐字节一致，随机 nonce 时能解开', async () => {
    for (const envelope of formats.displayEnvelopes) {
      const ad = e2eeLabel('display', envelope.deviceId, envelope.sessionId, envelope.slot, envelope.keyId)
      expect(Buffer.from(ad).toString('hex')).toBe(envelope.ad)
      const sealed = sealWithNonce(hex(envelope.directoryKey), hex(envelope.nonce), ad, Buffer.from(envelope.plaintext))
      expect(sealed).toBe(envelope.payload)
      const opened = await nodeContentSealer.open(hex(envelope.directoryKey), ad, envelope.payload)
      expect(Buffer.from(opened).toString('utf8')).toBe(envelope.plaintext)
      const resealed = await nodeContentSealer.seal(hex(envelope.directoryKey), ad, Buffer.from(envelope.plaintext))
      expect(resealed).not.toBe(envelope.payload)
      // AD binds the row: opening it as another session fails.
      const otherAd = e2eeLabel('display', envelope.deviceId, 'sess_other', envelope.slot, envelope.keyId)
      await expect(nodeContentSealer.open(hex(envelope.directoryKey), otherAd, envelope.payload)).rejects.toThrow()
    }
  })

  it('附件与分享的分段密文', () => {
    for (const object of formats.sealedObjects) {
      const segments = sealSegments(object.purpose, object.objectId, hex(object.key), pattern(object.plaintextLength))
      expect(segments.length).toBe(object.segments.length)
      segments.forEach((segment, index) => {
        const expected = object.segments[index]
        expect(segment.length).toBe(expected.ciphertextLength)
        expect(createHash('sha256').update(segment).digest('hex')).toBe(expected.ciphertextSha256)
        if (expected.ciphertext) expect(Buffer.from(segment).toString('hex')).toBe(expected.ciphertext)
      })
      expect(openSegments(object.purpose, object.objectId, hex(object.key), segments)).toEqual(pattern(object.plaintextLength))
      if (segments.length > 1) {
        // Dropping the final segment is detected (the new last one was not sealed as final).
        expect(() => openSegments(object.purpose, object.objectId, hex(object.key), segments.slice(0, -1))).toThrow()
      }
    }
  })

  it('带密钥的输入摘要', () => {
    for (const digest of formats.inputDigests) {
      expect(inputDigest(hex(digest.directoryKey), Buffer.from(digest.body))).toBe(digest.inputDigest)
    }
  })

  it('分片与重组', () => {
    for (const { messageLength, frames } of formats.framing) {
      const message = pattern(messageLength)
      const out = fragment(message)
      expect(out.map((frame) => ({ flag: frame[0], bodyLength: frame.length - 1 }))).toEqual(frames)
      const reassembler = new Reassembler()
      let result = null
      for (const frame of out) result = reassembler.push(frame)
      expect(result).toEqual({ kind: 'message', bytes: message })
    }
    expect(FRAME_MAX_BODY).toBe(65518)
    expect(fragment(new Uint8Array(0))[0]![0]).toBe(FRAME_FINAL)
  })

  it('配对 URI', () => {
    expect(parsePairingUri(formats.pairingUri.uri)).toEqual(formats.pairingUri.payload)
  })
})
