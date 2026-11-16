// e2ee 1.0 shared vectors on WebCrypto: the official Noise vectors (cacophony, snow), the AA handshakes
// (independent Python implementation) and every byte rule in aa-formats.json.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"

registerSource()
const { HandshakeState } = await import("../src/lib/e2ee/noise/index.ts")
const { webNoiseCrypto, keyPairFromSecret } = await import("../src/lib/e2ee/webcrypto.ts")
const formats = await import("../src/lib/e2ee/formats.ts")
const { b64url, fromB64url, utf8 } = await import("../src/lib/e2ee/bytes.ts")
const { parsePairingUri } = await import("../src/lib/e2ee/client-channel.ts")

const VECTORS = new URL("../../../contracts/e2ee/1.0/vectors/", import.meta.url)
const load = (file) => JSON.parse(readFileSync(new URL(file, VECTORS), "utf8"))
const official = load("noise-official.json")
const aa = load("aa-noise.json")
const fmt = load("aa-formats.json")

const hex = (value) => Uint8Array.from(Buffer.from(value ?? "", "hex"))
const toHex = (bytes) => Buffer.from(bytes).toString("hex")

async function party(vector, prefix) {
  const s = vector[`${prefix}_static`]
  const e = vector[`${prefix}_ephemeral`]
  const rs = vector[`${prefix}_remote_static`]
  return HandshakeState.create({
    crypto: webNoiseCrypto,
    protocolName: vector.protocol_name,
    initiator: prefix === "init",
    prologue: hex(vector[`${prefix}_prologue`]),
    ...(s ? { s: await keyPairFromSecret(hex(s)) } : {}),
    ...(e ? { e: await keyPairFromSecret(hex(e)) } : {}),
    ...(rs ? { rs: hex(rs) } : {}),
    psks: (vector[`${prefix}_psks`] ?? []).map(hex),
  })
}

async function run(vector, messages = vector.messages) {
  const initiator = await party(vector, "init")
  const responder = await party(vector, "resp")
  const handshakeCount = initiator.pattern.messages.length
  const oneWay = initiator.pattern.oneWay
  let transport = null
  for (const [index, message] of messages.entries()) {
    const sender = message.sender ?? (oneWay || index % 2 === 0 ? "initiator" : "responder")
    if (index < handshakeCount) {
      const [tx, rx] = sender === "initiator" ? [initiator, responder] : [responder, initiator]
      const ciphertext = await tx.writeMessage(hex(message.payload))
      assert.equal(toHex(ciphertext), message.ciphertext, `${vector.protocol_name} message ${index}`)
      assert.equal(toHex(await rx.readMessage(ciphertext)), message.payload)
      if (index === handshakeCount - 1) {
        transport = { initiator: initiator.takeTransport(), responder: responder.takeTransport() }
        if (vector.handshake_hash) assert.equal(toHex(transport.initiator.handshakeHash), vector.handshake_hash)
      }
      continue
    }
    const tx = transport[sender]
    const rx = transport[sender === "initiator" ? "responder" : "initiator"]
    if (message.rekey_before) {
      await tx.send.rekey()
      await rx.receive.rekey()
    }
    const ciphertext = await tx.send.encryptWithAd(new Uint8Array(0), hex(message.payload))
    assert.equal(toHex(ciphertext), message.ciphertext, `${vector.protocol_name} transport ${index}`)
    assert.equal(toHex(await rx.receive.decryptWithAd(new Uint8Array(0), ciphertext)), message.payload)
  }
}

async function runNegative(negative) {
  const base = aa.vectors.find((vector) => vector.name === negative.base)
  const vector = { ...base, ...negative.override }
  const messages = vector.messages.map((message) => ({ ...message }))
  if (negative.tamper) {
    const raw = hex(messages[negative.tamper.message].ciphertext)
    raw[negative.tamper.byte] ^= 0x01
    messages[negative.tamper.message].ciphertext = toHex(raw)
  }
  const initiator = await party(vector, "init")
  const responder = await party(vector, "resp")
  let transport = null
  for (const [index, message] of messages.entries()) {
    const sender = message.sender
    const ciphertext = hex(message.ciphertext)
    try {
      if (index < vector.handshake_messages) {
        const [tx, rx] = sender === "initiator" ? [initiator, responder] : [responder, initiator]
        await tx.writeMessage(hex(message.payload))
        await rx.readMessage(ciphertext)
        if (index === vector.handshake_messages - 1) transport = { initiator: initiator.takeTransport(), responder: responder.takeTransport() }
      } else {
        const rx = transport[sender === "initiator" ? "responder" : "initiator"]
        if (message.rekey_before) {
          await transport[sender].send.rekey()
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

test("official Noise vectors (25519_AESGCM_SHA256) pass on WebCrypto", async () => {
  assert.ok(official.vectors.length > 50)
  for (const vector of official.vectors) await run(vector)
})

test("AA handshakes match the independent implementation", async () => {
  for (const vector of aa.vectors) await run(vector)
})

test("AA negative cases fail where the vectors say", async () => {
  for (const negative of aa.negative) assert.equal(await runNegative(negative), negative.fail_at, negative.name)
})

test("client ids, fingerprints and prologues", async () => {
  for (const identity of fmt.identities) {
    assert.equal(await formats.clientIdFor(hex(identity.identityPub)), identity.clientId)
    assert.equal(await formats.identityFingerprint(hex(identity.identityPub)), identity.fingerprint)
    assert.equal(b64url(hex(identity.identityPub)), identity.identityPubB64)
    assert.match(identity.clientId, formats.CLIENT_ID_PATTERN)
  }
  for (const prologue of fmt.prologues) {
    const [a, b, c, d] = prologue.fields
    const bytes = prologue.kind === "pair" ? formats.pairingPrologue(a, b, c, d) : formats.connectPrologue(a, b, c)
    assert.equal(toHex(bytes), prologue.bytes)
  }
})

test("display envelopes seal and open", async () => {
  for (const vector of fmt.displayEnvelopes) {
    const key = hex(vector.directoryKey)
    const ad = formats.displayEnvelopeAd(vector.deviceId, vector.sessionId, vector.slot, vector.keyId)
    if (vector.ad) assert.equal(toHex(ad), vector.ad)
    const sealed = await formats.sealDisplay(key, ad, utf8(vector.plaintext), hex(vector.nonce))
    assert.equal(sealed, vector.payload)
    const opened = await formats.openDisplayEnvelope(key, vector, vector.payload)
    assert.deepEqual(opened, JSON.parse(vector.plaintext))
    // Moved to another session, the same ciphertext no longer opens.
    await assert.rejects(formats.openDisplayEnvelope(key, { ...vector, sessionId: "other" }, vector.payload))
  }
})

test("sealed segments and input digests", async () => {
  for (const object of fmt.sealedObjects) {
    const key = hex(object.key)
    const plaintext = new Uint8Array(object.plaintextLength)
    for (let i = 0; i < plaintext.length; i++) plaintext[i] = (i * 31 + 7) & 0xff
    const segments = await formats.sealSegments(object.purpose, object.objectId, key, plaintext)
    assert.equal(segments.length, object.segments.length)
    for (const [index, segment] of object.segments.entries()) {
      assert.equal(toHex(formats.sealedSegmentAd(object.purpose, object.objectId, segment.index, segment.final)), segment.ad)
      if (segment.ciphertextSha256) assert.equal(toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", segments[index]))), segment.ciphertextSha256)
      if (segment.ciphertext) assert.equal(toHex(segments[index]), segment.ciphertext)
    }
    assert.deepEqual(await formats.openSegments(object.purpose, object.objectId, key, segments), plaintext)
    if (segments.length > 1) await assert.rejects(formats.openSegments(object.purpose, object.objectId, key, segments.slice(0, -1)))
  }
  for (const vector of fmt.inputDigests) {
    assert.equal(toHex(await formats.inputDigestKey(hex(vector.directoryKey))), vector.digestKey)
    assert.equal(await formats.inputDigest(hex(vector.directoryKey), utf8(vector.body)), vector.inputDigest)
  }
})

test("framing and the pairing URI", () => {
  for (const vector of fmt.framing) {
    const frames = formats.fragment(new Uint8Array(vector.messageLength))
    assert.deepEqual(frames.map((frame) => ({ flag: frame[0], bodyLength: frame.length - 1 })), vector.frames)
  }
  const payload = parsePairingUri(fmt.pairingUri.uri)
  assert.deepEqual(payload, fmt.pairingUri.payload)
  assert.throws(() => parsePairingUri("https://example.com"))
  assert.equal(fromB64url(payload.psk).length, 32)
})
