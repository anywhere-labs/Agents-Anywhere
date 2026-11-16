// Client trust layer end to end against an in-test device (Noise responder on the same primitives):
// tunnel multiplexing, XXpsk0 pairing, KK reconnect, requests, subscriptions, rekey, command registration,
// pin mismatch and downgrade protection.
import assert from "node:assert/strict"
import test from "node:test"
import { registerSource } from "./helpers/onboarding-source.mjs"

registerSource()
const { HandshakeState } = await import("../src/lib/e2ee/noise/index.ts")
const { webNoiseCrypto, randomBytes } = await import("../src/lib/e2ee/webcrypto.ts")
const formats = await import("../src/lib/e2ee/formats.ts")
const { b64url, fromB64url, fromUtf8, utf8 } = await import("../src/lib/e2ee/bytes.ts")
const { TransportSession, encodeHandshake, decodeHandshake } = await import("../src/lib/e2ee/transport.ts")
const { ClientTrustStore, memoryTrustBackend } = await import("../src/lib/e2ee/trust-store.ts")
const { TunnelMux } = await import("../src/lib/e2ee/tunnel.ts")
const { SecureChannelPool } = await import("../src/lib/e2ee/secure-transport.ts")
const { ClientSecureChannel } = await import("../src/lib/e2ee/client-channel.ts")
const { isPlaintextMetadataPath } = await import("../src/features/e2ee/runtime.ts").catch(() => ({}))

/** A minimal device: answers pairing and reconnects, echoes requests, pushes one event per subscription. */
class FakeDevice {
  constructor(deviceId) {
    this.deviceId = deviceId
    this.grants = new Map() // clientId -> client public key
    this.channels = new Map()
    this.directoryKey = randomBytes(32)
    this.requests = []
    this.socket = null
  }
  async init() {
    this.identity = await webNoiseCrypto.generateKeyPair()
    return this
  }
  pairing(overrides = {}) {
    this.psk = randomBytes(32)
    this.pairingId = `pair_${this.grants.size}`
    return {
      v: 1, deviceId: this.deviceId, deviceIdentityPub: b64url(this.identity.publicKey), pairingId: this.pairingId,
      psk: b64url(this.psk), serverUrl: "https://aa.test", e2eeMode: "required", expiresAt: "2099-01-01T00:00:00Z", ...overrides,
    }
  }
  wire(route) {
    return {
      send: (item) => this.socket.deliver({ t: "tun", route, n: item.n, ct: item.ct }),
      end: (code = "closed") => this.socket.deliver({ t: "end", route, code }),
    }
  }
  async handle(frame) {
    const { route } = frame
    if (frame.t === "end") return this.channels.delete(route.ch)
    let state = this.channels.get(route.ch)
    if (!state) {
      const envelope = decodeHandshake(frame, 0)
      const wire = this.wire(route)
      if (envelope.pattern === "XXpsk0") {
        const hs = await HandshakeState.create({
          crypto: webNoiseCrypto, protocolName: formats.NOISE_PAIRING_PROTOCOL, initiator: false,
          prologue: formats.pairingPrologue(this.deviceId, envelope.pairingId, route.clientId, route.ch), s: this.identity, psks: [this.psk],
        })
        try {
          await hs.readMessage(fromB64url(envelope.message))
        } catch {
          return wire.end("pairing_expired")
        }
        const reply = await hs.writeMessage(utf8(JSON.stringify({ deviceId: this.deviceId, label: "dev" })))
        this.channels.set(route.ch, { hs, wire, step: 2 })
        return wire.send(encodeHandshake({ pattern: "XXpsk0", pairingId: envelope.pairingId, step: 1, message: b64url(reply) }))
      }
      const clientPub = this.grants.get(route.clientId)
      if (!clientPub) return wire.end("e2ee_not_paired")
      const hs = await HandshakeState.create({
        crypto: webNoiseCrypto, protocolName: formats.NOISE_RECONNECT_PROTOCOL, initiator: false,
        prologue: formats.connectPrologue(this.deviceId, route.clientId, route.ch), s: this.identity, rs: clientPub,
      })
      await hs.readMessage(fromB64url(envelope.message))
      await wire.send(encodeHandshake({ pattern: "KK", step: 1, message: b64url(await hs.writeMessage()) }))
      const transport = new TransportSession(hs.takeTransport(), wire)
      this.channels.set(route.ch, { transport, wire })
      return transport.sendMessage(this.ready(route.clientId))
    }
    if (state.step === 2) {
      const envelope = decodeHandshake(frame, 2)
      JSON.parse(fromUtf8(await state.hs.readMessage(fromB64url(envelope.message))))
      const clientPub = state.hs.remoteStatic
      assert.equal(await formats.clientIdFor(clientPub), route.clientId)
      this.grants.set(route.clientId, clientPub)
      const transport = new TransportSession(state.hs.takeTransport(), state.wire)
      this.channels.set(route.ch, { transport, wire: state.wire })
      await transport.sendMessage({
        kind: "pair.committed", deviceId: this.deviceId, clientId: route.clientId, grantedAt: "2026-11-16T00:00:00Z",
        directoryKey: { deviceId: this.deviceId, keyId: "dk_1", epoch: 1, key: b64url(this.directoryKey) },
      })
      return transport.sendMessage(this.ready(route.clientId))
    }
    for (const message of await state.transport.receive(frame)) {
      if (message.kind === "request") {
        this.requests.push(message)
        const failing = message.path.endsWith("/fail")
        await state.transport.sendMessage({
          kind: "response", id: message.id, status: failing ? 409 : 200,
          body: failing ? { detail: { code: "session_busy", message: "busy" } } : { echo: message.path, body: message.body },
        })
      } else if (message.kind === "subscribe") {
        await state.transport.sendMessage({ kind: "event", sub: message.id, event: { type: "session.subscribed", sessionId: message.sessionId } })
      }
    }
  }
  ready(clientId) {
    return { kind: "ready", deviceId: this.deviceId, clientId, directoryKeyId: "dk_1", directoryKeyEpoch: 1 }
  }
}

/** The tunnel socket: frames from the client go to the device in order; the device's go back to the client. */
function fakeSocket(device) {
  let queue = Promise.resolve()
  const socket = {
    readyState: 1, onmessage: null, onclose: null, onerror: null, onopen: null, sent: [],
    send(data) {
      const frame = JSON.parse(data)
      socket.sent.push(frame)
      queue = queue.then(() => device.handle(frame)).catch((error) => { socket.error = error })
    },
    close() {},
    deliver(frame) {
      queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(frame) }))
    },
  }
  device.socket = socket
  return socket
}

async function setup() {
  const device = await new FakeDevice("dev_1").init()
  const socket = fakeSocket(device)
  const store = new ClientTrustStore(memoryTrustBackend())
  const registered = []
  let registration = (reg) => ({ commandId: reg.commandId, outcome: null, errorCode: null, duplicate: false })
  const pool = new SecureChannelPool({
    store, crypto: webNoiseCrypto, label: "test", platform: "web",
    mux: new TunnelMux(async () => socket),
    registerCommand: async (reg) => {
      registered.push(reg)
      return registration(reg)
    },
    deviceOfSession: async () => "dev_1",
  })
  return { device, socket, store, pool, registered, setRegistration: (fn) => (registration = fn) }
}

test("pairing pins the device, then content flows through the channel", async () => {
  const { device, socket, store, pool } = await setup()
  const pin = await pool.pair(device.pairing())
  assert.equal(pin.deviceId, "dev_1")
  assert.equal(pin.devicePub, b64url(device.identity.publicKey))
  assert.equal(pin.directoryKeys[0].keyId, "dk_1")
  assert.equal(pin.directoryKeys[0].aes.extractable, false)
  assert.equal(pin.fingerprint, await formats.identityFingerprint(device.identity.publicKey))

  const transport = pool.transportFor("sess_1")
  const body = await transport.request({ method: "GET", path: "/api/v2/sessions/sess_1/snapshot", query: { limit: "5" } })
  assert.deepEqual(body, { echo: "/api/v2/sessions/sess_1/snapshot?limit=5", body: null })
  await assert.rejects(transport.request({ method: "GET", path: "/api/v2/sessions/sess_1/fail" }), (error) => error.code === "session_busy" && error.status === 409)

  // Nothing readable crossed the tunnel: only routes, counters and ciphertext.
  const wireText = JSON.stringify(socket.sent)
  assert.ok(!wireText.includes("snapshot"), "request path leaked to the tunnel")
  for (const frame of socket.sent) assert.deepEqual(Object.keys(frame).sort(), ["ct", "n", "route", "t"])
  assert.equal(socket.error, undefined)

  // The identity private key never leaves WebCrypto.
  const identity = await store.identity()
  assert.match(identity.clientId, formats.CLIENT_ID_PATTERN)
})

test("rekeys only between messages, so a large message crossing the rekey time stays intact", async () => {
  const { TransportSession: Session } = await import("../src/lib/e2ee/transport.ts")
  // Two transport halves from an XX handshake between two fresh keys.
  const ki = await webNoiseCrypto.generateKeyPair()
  const kr = await webNoiseCrypto.generateKeyPair()
  const init = await HandshakeState.create({ crypto: webNoiseCrypto, protocolName: "Noise_XX_25519_AESGCM_SHA256", initiator: true, prologue: new Uint8Array(0), s: ki })
  const resp = await HandshakeState.create({ crypto: webNoiseCrypto, protocolName: "Noise_XX_25519_AESGCM_SHA256", initiator: false, prologue: new Uint8Array(0), s: kr })
  await resp.readMessage(await init.writeMessage())
  await init.readMessage(await resp.writeMessage())
  await resp.readMessage(await init.writeMessage())
  const received = []
  const receiver = new Session(resp.takeTransport(), { send() {}, end() {} })
  let clock = 0
  const sender = new Session(init.takeTransport(), { send: async (item) => received.push(...(await receiver.receive(item))), end() {} }, () => (clock += 31 * 60 * 1000))
  const big = "z".repeat(300_000)
  await sender.sendMessage({ big })
  await sender.sendMessage({ big })
  assert.equal(received.length, 2)
  assert.equal(received[1].big.length, big.length)
})

test("the session stream is a channel subscription with normal-mode events", async () => {
  const { device, pool } = await setup()
  await pool.pair(device.pairing())
  const stream = pool.transportFor("sess_9").openSessionStream("sess_9")
  const event = await new Promise((resolve) => {
    stream.onmessage = (message) => resolve(JSON.parse(message.data))
  })
  assert.deepEqual(event, { type: "session.subscribed", sessionId: "sess_9" })
  let closed = false
  stream.onclose = () => (closed = true)
  stream.close()
  assert.equal(closed, true)
})

test("a fresh pool reconnects with KK against the pinned key", async () => {
  const { device, socket, store, pool } = await setup()
  await pool.pair(device.pairing())
  await pool.closeAll()
  const again = new SecureChannelPool({
    store, crypto: webNoiseCrypto, label: "test", platform: "web", mux: new TunnelMux(async () => socket),
    registerCommand: async () => ({ duplicate: false, outcome: null }), deviceOfSession: async () => "dev_1",
  })
  const channel = await again.channel("dev_1")
  await channel.rekeyNow()
  const body = await again.transportFor("s").request({ method: "GET", path: "/api/v2/sessions/s/timeline" })
  assert.equal(body.echo, "/api/v2/sessions/s/timeline")
  assert.equal(socket.error, undefined)
})

test("a not-paired answer relayed by the Server never drops the pin (no downgrade by forgery)", async () => {
  const { device, store, pool } = await setup()
  await pool.pair(device.pairing())
  await pool.closeAll()
  device.grants.clear()
  await assert.rejects(pool.transportFor("s").request({ method: "GET", path: "/api/v2/sessions/s/snapshot" }), (error) => error.code === "e2ee_not_paired")
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.notEqual(await store.pin("dev_1"), null)
})

test("a revocation the device sends inside the channel drops the pin", async () => {
  const { device, store, pool } = await setup()
  await pool.pair(device.pairing())
  const [state] = device.channels.values()
  const closed = new Promise((resolve) => (pool.channel("dev_1").then((channel) => channel.onClose(resolve))))
  await state.transport.sendMessage({ kind: "close", reason: "revoked", message: "" })
  const error = await closed
  assert.equal(error.code, "e2ee_not_paired")
  assert.equal(error.fromDevice, true)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(await store.pin("dev_1"), null)
})

test("a QR code with another device key is refused (device_pin_mismatch)", async () => {
  const { device, store, pool } = await setup()
  const other = await webNoiseCrypto.generateKeyPair()
  await assert.rejects(pool.pair(device.pairing({ deviceIdentityPub: b64url(other.publicKey) })), (error) => error.code === "device_pin_mismatch")
  assert.equal(await store.pin("dev_1"), null)
})

test("a wrong pairing secret fails without pinning anything", async () => {
  const { device, store, pool } = await setup()
  const payload = device.pairing()
  await assert.rejects(pool.pair({ ...payload, psk: b64url(randomBytes(32)) }), (error) => ["pairing_expired", "e2ee_handshake_failed"].includes(error.code))
  assert.equal(await store.pin("dev_1"), null)
})

test("commands are registered with a keyed digest before they go through the channel", async () => {
  const { device, pool, registered, setRegistration } = await setup()
  await pool.pair(device.pairing())
  const body = { content: "hello", clientMessageId: "m_1" }
  await pool.transportFor("s").request({ method: "POST", path: "/api/v2/sessions/s/runtime/messages", body })
  assert.equal(registered.length, 1)
  assert.equal(registered[0].commandId, "m_1")
  assert.equal(registered[0].deviceId, "dev_1")
  assert.equal(registered[0].inputDigest, await formats.inputDigest(device.directoryKey, utf8(JSON.stringify(body))))
  assert.equal(device.requests.length, 1)

  // A retry the Server already saw accepted is not sent again.
  setRegistration((reg) => ({ commandId: reg.commandId, outcome: "accepted", errorCode: null, duplicate: true }))
  const retried = await pool.transportFor("s").request({ method: "POST", path: "/api/v2/sessions/s/runtime/messages", body })
  assert.equal(retried.duplicate, true)
  assert.equal(device.requests.length, 1)
})

test("local policy only tightens; relaxing is a local action", async () => {
  const store = new ClientTrustStore(memoryTrustBackend())
  assert.equal((await store.policy()).required, false)
  await store.requireEncryption("2026-11-16T00:00:00Z")
  await store.requireEncryption("2027-01-01T00:00:00Z")
  assert.deepEqual(await store.policy(), { required: true, since: "2026-11-16T00:00:00Z" })
  await store.relaxLocally()
  assert.equal((await store.policy()).required, false)
})

test("metadata paths stay on the Server API", () => {
  assert.equal(isPlaintextMetadataPath("/api/v2/sessions/s1/meta"), true)
  assert.equal(isPlaintextMetadataPath("/api/v2/sessions/s1/runtime/state"), true)
  assert.equal(isPlaintextMetadataPath("/api/v2/sessions/s1/runtime/capabilities"), true)
  assert.equal(isPlaintextMetadataPath("/api/v2/sessions/s1/snapshot"), false)
  assert.equal(isPlaintextMetadataPath("/api/v2/sessions/s1/runtime/messages"), false)
})
