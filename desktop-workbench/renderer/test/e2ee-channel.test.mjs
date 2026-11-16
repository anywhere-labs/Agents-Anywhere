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
    this.subscriptions = []
    this.unsubscribed = []
    this.files = new Map()
    this.silentCreate = false
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
      if (message.kind === "request" && message.path.includes("/fs/read?")) {
        this.requests.push(message)
        await state.transport.sendMessage({ kind: "response", id: message.id, status: 200, body: this.readChunk(message.path) })
      } else if (message.kind === "request" && message.path.endsWith("/sessions/create-and-start")) {
        this.requests.push(message)
        // A device that never answers (offline after receiving, or slow): the client must not wait forever.
        if (this.silentCreate) continue
        await state.transport.sendMessage({ kind: "response", id: message.id, status: 200, body: { session: { id: "sess_new", connectorId: this.deviceId }, connectorResult: { accepted: true } } })
      } else if (message.kind === "request") {
        this.requests.push(message)
        const failing = message.path.endsWith("/fail")
        await state.transport.sendMessage({
          kind: "response", id: message.id, status: failing ? 409 : 200,
          body: failing ? { detail: { code: "session_busy", message: "busy" } } : { echo: message.path, body: message.body },
        })
      } else if (message.kind === "subscribe" && message.stream === "terminal") {
        this.subscriptions.push(message)
        // Every event is one message of the normal-mode terminal WebSocket.
        await state.transport.sendMessage({ kind: "event", sub: message.id, event: { type: "replay", data: btoa("$ "), seq: 1 } })
        await state.transport.sendMessage({ kind: "event", sub: message.id, event: { type: "output", data: btoa("ls\r\n"), seq: 2 } })
      } else if (message.kind === "subscribe") {
        this.subscriptions.push(message)
        await state.transport.sendMessage({ kind: "event", sub: message.id, event: { type: "session.subscribed", sessionId: message.sessionId } })
      } else if (message.kind === "unsubscribe") {
        this.unsubscribed.push(message.id)
      }
    }
  }
  /** `GET …/fs/read?root&path&offset&length` -> `TunnelFileChunk`. */
  readChunk(path) {
    const query = new URL(path, "https://device.test").searchParams
    const bytes = this.files.get(`${query.get("root")}/${query.get("path")}`)
    const offset = Number(query.get("offset"))
    const slice = bytes.subarray(offset, offset + Number(query.get("length")))
    return { encoding: "base64", data: Buffer.from(slice).toString("base64"), offset, size: bytes.length, eof: offset + slice.length >= bytes.length }
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

async function setup(options = {}) {
  const device = await new FakeDevice("dev_1").init()
  const socket = fakeSocket(device)
  const store = new ClientTrustStore(memoryTrustBackend())
  const registered = []
  let registration = (reg) => ({ commandId: reg.commandId, outcome: null, errorCode: null, duplicate: false })
  const uploads = []
  const uploadResponse = (form) => ({
    attachments: form.getAll("files").map((file, index) => ({ fileId: `f_${uploads.length}_${index}`, name: file.name, size: file.size, sha256: "c".repeat(64), mediaType: file.type })),
    serverTime: "now",
  })
  const pool = new SecureChannelPool({
    store, crypto: webNoiseCrypto, label: "test", platform: "web",
    mux: new TunnelMux(async () => socket),
    registerCommand: async (reg) => {
      registered.push(reg)
      return registration(reg)
    },
    deviceOfSession: async () => "dev_1",
    ...options,
    uploadSealed: async (path, form) => {
      const response = uploadResponse(form)
      uploads.push({ path, form })
      return response
    },
  })
  return { device, socket, store, pool, registered, uploads, setRegistration: (fn) => (registration = fn) }
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

const transportModule = await import("../src/lib/transport/content-transport.ts")
const { openSealedAttachment, SEALED_UPLOAD_NAME, SEALED_UPLOAD_TYPE } = await import("../src/lib/e2ee/sealed-attachments.ts")
const { readFileThroughChannel } = await import("../src/lib/transport/channel-files.ts")
const { openTerminalStream } = await import("../src/lib/transport/terminal-stream.ts")
const { ApiClient } = await import("../src/lib/api/client.ts")
const { dashboardApi, E2EE_TITLE_UNSUPPORTED } = await import("../src/features/dashboard/api.ts")
const { toHex } = await import("../src/lib/e2ee/bytes.ts")

/** Routes like the runtime: device content and session content go through the pool, metadata stays on HTTPS. */
function routeThrough(t, pool) {
  t.after(transportModule.setContentTransportResolver(({ sessionId, deviceId, path }) => {
    if (deviceId !== null) return pool.transportForDevice(deviceId)
    return /\/meta$/.test(path) ? null : pool.transportFor(sessionId)
  }))
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

test("attachments are sealed before upload; the device opens them with the keys sent through the channel", async () => {
  const { device, socket, pool, registered, uploads } = await setup()
  await pool.pair(device.pairing())
  // Three segments, the last one short.
  const plaintext = new Uint8Array(150_000).map((_, i) => (i * 7) % 251)
  const form = new FormData()
  form.append("files", new File([plaintext], "secret-report.pdf", { type: "application/pdf" }))

  const response = await pool.transportFor("s").request({ method: "POST", path: "/api/v2/sessions/s/attachments", body: form })
  assert.equal(uploads.length, 1)
  assert.equal(uploads[0].path, "/api/v2/sessions/s/attachments")
  const [part] = uploads[0].form.getAll("files")
  // The Server sees neither the name, the type nor the bytes.
  assert.equal(part.name, SEALED_UPLOAD_NAME)
  assert.equal(part.type, SEALED_UPLOAD_TYPE)
  const uploaded = new Uint8Array(await part.arrayBuffer())
  assert.equal(uploaded.length, 150_000 + 3 * 16)
  assert.ok(!Buffer.from(uploaded).includes(Buffer.from(plaintext.subarray(0, 64))), "plaintext reached the upload")
  // The UI keeps showing the real file.
  const view = response.attachments[0]
  assert.equal(view.fileId, "f_0_0")
  assert.equal(view.name, "secret-report.pdf")
  assert.equal(view.size, plaintext.length)
  assert.equal(view.mediaType, "application/pdf")
  // Nothing about the upload crossed the tunnel.
  assert.equal(device.requests.length, 0)

  const body = { content: "see attached", attachments: [{ fileId: view.fileId }], clientMessageId: "m_att" }
  await pool.transportFor("s").request({ method: "POST", path: "/api/v2/sessions/s/runtime/messages", body })
  const sent = device.requests.at(-1).body
  assert.deepEqual(sent.attachments, [{ fileId: "f_0_0" }])
  assert.equal(sent.sealedAttachmentKeys.length, 1)
  const key = sent.sealedAttachmentKeys[0]
  assert.equal(key.fileId, "f_0_0")
  assert.equal(key.name, "secret-report.pdf")
  assert.equal(key.mimeType, "application/pdf")
  assert.equal(key.size, plaintext.length)
  assert.equal(key.sha256, toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext))))
  const opened = await openSealedAttachment(key, uploaded)
  assert.deepEqual(opened, plaintext)
  // The digest covers the body as sent (keys included); the key never crosses the tunnel or the Server in the clear.
  assert.equal(registered.at(-1).inputDigest, await formats.inputDigest(device.directoryKey, utf8(JSON.stringify(sent))))
  assert.ok(!JSON.stringify(socket.sent).includes(key.key))
  assert.ok(!JSON.stringify(registered).includes(key.key))

  // A modified upload does not open.
  const tampered = uploaded.slice()
  tampered[10] ^= 1
  await assert.rejects(openSealedAttachment(key, tampered))
  // Requests that reference no sealed upload are unchanged.
  await pool.transportFor("s").request({ method: "POST", path: "/api/v2/sessions/s/runtime/messages", body: { content: "x", attachments: [{ fileId: "other" }] } })
  assert.equal(device.requests.at(-1).body.sealedAttachmentKeys, undefined)

  // Several files: one upload (one file part) each, every file with its own key.
  const two = new FormData()
  two.append("files", new File(["a"], "a.txt", { type: "text/plain" }))
  two.append("files", new File(["b"], "b.txt", { type: "text/plain" }))
  const both = await pool.transportFor("s").request({ method: "POST", path: "/api/v2/sessions/s/attachments", body: two })
  assert.equal(uploads.length, 3)
  for (const { form: sent } of uploads.slice(1)) assert.equal(sent.getAll("files").length, 1)
  assert.deepEqual(both.attachments.map((item) => [item.fileId, item.name]), [["f_1_0", "a.txt"], ["f_2_0", "b.txt"]])
  await pool.transportFor("s").request({ method: "POST", path: "/api/v2/sessions/s/runtime/messages", body: { content: "y", attachments: both.attachments.map(({ fileId }) => ({ fileId })) } })
  const keys = device.requests.at(-1).body.sealedAttachmentKeys
  assert.deepEqual(keys.map((item) => item.fileId), ["f_1_0", "f_2_0"])
  assert.notEqual(keys[0].key, keys[1].key)
})

test("a sealed upload bypasses the channel resolver and goes to the Server over HTTPS", async (t) => {
  const fetched = []
  const client = new ApiClient({
    fetcher: async (url, init) => {
      fetched.push({ url: String(url), headers: init.headers })
      return new Response("{\"attachments\":[]}", { headers: { "content-type": "application/json" } })
    },
  })
  t.after(transportModule.setContentTransportResolver(() => ({ kind: "tunnel", request: async () => assert.fail("sealed upload went into the channel"), openSessionStream: () => assert.fail() })))
  await client.post("/sessions/s/attachments", new FormData(), { token: "t", headers: { [transportModule.SEALED_UPLOAD_HEADER]: transportModule.SEALED_UPLOAD_VALUE } })
  assert.equal(fetched.length, 1)
  assert.equal(fetched[0].url, "/api/v2/sessions/s/attachments")
  assert.equal(new Headers(fetched[0].headers).get("x-aa-sealed"), "segments-v1")
})

test("device files are read through the channel in chunks until eof", async (t) => {
  const { device, pool } = await setup()
  await pool.pair(device.pairing())
  const bytes = new Uint8Array(20).map((_, i) => i + 1)
  device.files.set("/work/out/a.bin", bytes)
  const read = await readFileThroughChannel(pool.transportForDevice("dev_1"), "/api/v2/connectors/dev_1/fs/read", { root: "/work", path: "out/a.bin" }, { chunkBytes: 7 })
  assert.equal(read.size, 20)
  assert.deepEqual(new Uint8Array(await new Blob(read.bytes).arrayBuffer()), bytes)
  const offsets = device.requests.map((request) => {
    const query = new URL(request.path, "https://x").searchParams
    assert.equal(request.method, "GET")
    assert.equal(query.get("root"), "/work")
    assert.equal(query.get("path"), "out/a.bin")
    assert.equal(query.get("length"), "7")
    return query.get("offset")
  })
  assert.deepEqual(offsets, ["0", "7", "14"])

  // The download/preview helper uses the same reads; no download URL is fetched.
  routeThrough(t, pool)
  t.mock.method(globalThis, "fetch", async () => assert.fail("a device file went over HTTPS"))
  assert.equal(dashboardApi.connectorFsReadsThroughChannel("dev_1"), true)
  const file = await dashboardApi.connectorFsReadBlob("t", "dev_1", "/work", "out/a.bin")
  assert.equal(file.name, "a.bin")
  assert.equal(file.size, 20)
  assert.deepEqual(new Uint8Array(await file.blob.arrayBuffer()), bytes)
  // Listing takes the same channel.
  await dashboardApi.connectorFsList("t", "dev_1", { root: "/work", path: "out" })
  assert.equal(device.requests.at(-1).path, "/api/v2/connectors/dev_1/fs/list")
})

test("a terminal is a channel subscription; input and resize are requests to the normal paths", async (t) => {
  const { device, pool } = await setup()
  await pool.pair(device.pairing())
  routeThrough(t, pool)
  const base = "/api/v2/connectors/dev_1/terminals-v2/term_1"
  const stream = openTerminalStream({ connectorId: "dev_1", terminalId: "term_1", basePath: base, webSocketUrl: () => assert.fail("opened a plaintext WebSocket") })
  const messages = []
  const opened = new Promise((resolve) => (stream.onopen = resolve))
  const received = new Promise((resolve) => {
    stream.onmessage = (message) => {
      messages.push(JSON.parse(message.data))
      if (messages.length === 2) resolve()
    }
  })
  await opened
  assert.equal(stream.isOpen, true)
  await received
  const subscription = device.subscriptions.at(-1)
  assert.deepEqual(subscription, { kind: "subscribe", id: subscription.id, stream: "terminal", terminalId: "term_1" })
  assert.deepEqual(messages, [{ type: "replay", data: btoa("$ "), seq: 1 }, { type: "output", data: btoa("ls\r\n"), seq: 2 }])

  stream.send({ type: "input", data: btoa("a") })
  stream.send({ type: "input", data: btoa("b") })
  stream.send({ type: "resize", cols: 100, rows: 30 })
  await settle()
  assert.deepEqual(device.requests.map((request) => [request.method, request.path, request.body]), [
    ["POST", `${base}/write`, { dataBase64: btoa("a") }],
    ["POST", `${base}/write`, { dataBase64: btoa("b") }],
    ["POST", `${base}/resize`, { cols: 100, rows: 30 }],
  ])
  let closed = false
  stream.onclose = () => (closed = true)
  stream.close()
  await settle()
  assert.equal(closed, true)
  assert.equal(stream.isOpen, false)
  assert.deepEqual(device.unsubscribed, [subscription.id])
})

test("creating a session sends the first message only through the chosen device's channel", async (t) => {
  const { device, socket, pool, registered } = await setup()
  await pool.pair(device.pairing())
  routeThrough(t, pool)
  const fetched = []
  const client = new ApiClient({ fetcher: async (url) => { fetched.push(String(url)); return new Response("{}") } })
  const body = { connectorId: "dev_1", projectId: "p", runtime: "codex", content: "the secret first message", clientMessageId: "m_first" }
  const created = await client.post("/sessions/create-and-start", body, { token: "t" })
  assert.equal(created.session.id, "sess_new")
  assert.deepEqual(fetched, [])
  assert.equal(device.requests.at(-1).path, "/api/v2/sessions/create-and-start")
  assert.equal(device.requests.at(-1).body.content, "the secret first message")
  assert.equal(registered.at(-1).commandId, "m_first")
  assert.ok(!JSON.stringify(socket.sent).includes("secret"))
  assert.ok(!JSON.stringify(registered).includes("secret"))
  assert.equal(await pool.deviceOf("sess_new"), "dev_1")

  // A device this client has not paired with is refused; still nothing in the clear.
  await assert.rejects(client.post("/sessions", { ...body, connectorId: "dev_other" }, { token: "t" }), (error) => error.code === "e2ee_not_paired")
  assert.deepEqual(fetched, [])
})

/** The Server's session list (plaintext metadata) as `GET /sessions/list` returns it, one answer per call. */
function serverSessionLists(t, ...lists) {
  const calls = []
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url: String(url), body: init?.body })
    const ids = lists[Math.min(calls.length - 1, lists.length - 1)]
    const sessions = ids.map((id) => ({ id, connectorId: "dev_1", projectId: "p" }))
    return new Response(JSON.stringify({ sessions, serverTime: "now" }), { headers: { "content-type": "application/json" } })
  })
  return calls
}

test("an unanswered session creation times out as unknown and is looked up in the Server session list", async (t) => {
  const { device, pool, registered } = await setup({ createTimeoutMs: 30 })
  await pool.pair(device.pairing())
  routeThrough(t, pool)
  device.silentCreate = true
  const calls = serverSessionLists(t, ["s_old"], ["s_old", "s_made"])
  const body = { connectorId: "dev_1", projectId: "p", runtime: "codex", title: "plan", content: "/plan secret", clientMessageId: "m_slow" }
  await assert.rejects(dashboardApi.createAndStartSession("t", body), (error) => {
    assert.equal(error.code, "command_outcome_unknown")
    assert.deepEqual(error.payload.detail, { resultUnknown: true, retryable: false, sessionId: "s_made" })
    return true
  })
  // Sent once through the channel, registered once; the Server only saw two list reads.
  assert.equal(device.requests.filter((request) => request.path.endsWith("/create-and-start")).length, 1)
  assert.equal(registered.filter((reg) => reg.commandId === "m_slow").length, 1)
  assert.deepEqual(calls.map((call) => new URL(call.url, "https://x").pathname), ["/api/v2/sessions/list", "/api/v2/sessions/list"])
  assert.ok(!JSON.stringify(calls).includes("secret"))

  // Without exactly one new session the result stays unknown and no session is guessed.
  serverSessionLists(t, ["s_old"], ["s_old"])
  await assert.rejects(dashboardApi.createAndStartSession("t", { ...body, clientMessageId: "m_slow2" }), (error) =>
    error.code === "command_outcome_unknown" && error.payload.detail.sessionId === undefined)
})

test("a repeated session creation is not resent; its result is unknown", async (t) => {
  const { device, pool, setRegistration } = await setup()
  await pool.pair(device.pairing())
  routeThrough(t, pool)
  serverSessionLists(t, ["s_old"])
  const body = { connectorId: "dev_1", projectId: "p", runtime: "codex", content: "again", clientMessageId: "m_dup" }
  for (const outcome of ["accepted", null]) {
    setRegistration((reg) => ({ commandId: reg.commandId, outcome, errorCode: null, duplicate: true }))
    await assert.rejects(dashboardApi.createAndStartSession("t", body), (error) => error.code === "command_outcome_unknown" && error.payload.detail.resultUnknown === true)
  }
  assert.equal(device.requests.length, 0)
})

test("the first message of an encrypted session creation carries no attachments", async (t) => {
  const { device, pool, registered } = await setup()
  await pool.pair(device.pairing())
  routeThrough(t, pool)
  serverSessionLists(t, [])
  const body = {
    connectorId: "dev_1", projectId: "p", runtime: "codex", content: "see file", clientMessageId: "m_att_first",
    attachments: [{ fileId: "a", name: "a.txt", contentBase64: "YQ==" }],
  }
  await assert.rejects(dashboardApi.createAndStartSession("t", body), (error) => {
    assert.equal(error.code, "e2ee_attachments_unsupported")
    // Certainly not created: the UI keeps the draft for editing.
    assert.equal(error.payload.detail.resultUnknown, false)
    return true
  })
  assert.equal(registered.length, 0)
  assert.equal(device.requests.length, 0)
})

test("renaming an encrypted session is refused without sending the title", async (t) => {
  const { device, pool } = await setup()
  await pool.pair(device.pairing())
  routeThrough(t, pool)
  const fetched = []
  t.mock.method(globalThis, "fetch", async (url, init) => {
    fetched.push({ url: String(url), body: init?.body })
    return new Response(JSON.stringify({ session: { id: "s" } }), { headers: { "content-type": "application/json" } })
  })
  await assert.rejects(dashboardApi.patchSession("t", "s", { title: "my secret plan" }), (error) => error.code === E2EE_TITLE_UNSUPPORTED)
  assert.deepEqual(fetched, [])
  // Other directory flags are metadata and still go to the Server.
  await dashboardApi.patchSession("t", "s", { pinned: true })
  assert.equal(fetched.length, 1)
  assert.ok(fetched[0].url.endsWith("/api/v2/sessions/s/meta"))
  assert.ok(!String(fetched[0].body).includes("secret"))
})
