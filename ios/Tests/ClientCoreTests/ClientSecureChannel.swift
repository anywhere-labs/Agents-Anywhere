@testable import ClientCore
import Foundation

/// 客户端安全通道（e2ee 1.0）：一条 `(deviceId, clientId, ch)` 路由上的一次 Noise 握手及之后的传输。
///
/// 并发模型：actor。读任务按到达顺序把隧道上的帧逐个交给 actor；发送在 actor 内同步加密并交给
/// `E2EETunnelLink.send`（它保证顺序），所以帧的 nonce 顺序与发出顺序一致，不会被重入打乱。
/// 收到 `ready` 之前不发任何请求；握手消息里不带业务数据。
actor ClientSecureChannel {
    nonisolated let deviceId: String
    nonisolated let clientId: String
    nonisolated let ch: String

    private enum Phase {
        case handshake
        case open(E2EETransportSession)
        case closed(E2EEError)
    }

    private let link: any E2EETunnelLink
    private let trust: ClientTrustStore?
    private let now: @Sendable () -> Date
    private let rekeyFrames: Int
    private let rekeyInterval: TimeInterval
    private var phase: Phase = .handshake
    private var inbox: [E2EEChannelItem] = []
    private var handshakeWaiter: CheckedContinuation<E2EEChannelItem, Error>?
    private var readyWaiter: CheckedContinuation<Void, Error>?
    private var committed: E2EEPairingResult?
    private var pairing: (payload: E2EEPairingPayload, devicePub: Data)?
    private(set) var ready: E2EEChannelReady?
    private var nextId = 1
    private var pending: [String: CheckedContinuation<E2EETunnelResponse, Error>] = [:]
    private var subscriptions: [String: AsyncThrowingStream<Data, Error>.Continuation] = [:]
    private var channelEventListeners: [UUID: AsyncStream<Data>.Continuation] = [:]
    private var reader: Task<Void, Never>?

    struct Options: Sendable {
        var now: @Sendable () -> Date = { Date() }
        var rekeyFrames = E2EEFormats.rekeyIntervalFrames
        var rekeyInterval = E2EEFormats.rekeyInterval
        var handshakeTimeout: Duration = .seconds(30)
    }

    private init(deviceId: String, clientId: String, link: any E2EETunnelLink, trust: ClientTrustStore?, options: Options) {
        self.deviceId = deviceId
        self.clientId = clientId
        ch = link.route.ch
        self.link = link
        self.trust = trust
        now = options.now
        rekeyFrames = options.rekeyFrames
        rekeyInterval = options.rekeyInterval
    }

    // MARK: 建立

    /// 首次扫码配对（XXpsk0）。设备写入授权后发 `pair.committed`，再发 `ready`；收到后把授权与列表密钥存进 `trust`。
    static func pair(
        _ payload: E2EEPairingPayload,
        identity: X25519KeyPair,
        tunnel: any E2EETunnel,
        trust: ClientTrustStore?,
        label: String,
        platform: String = "ios",
        ch: String = E2EEFormats.newChannelId(),
        options: Options = Options()
    ) async throws -> (channel: ClientSecureChannel, result: E2EEPairingResult) {
        let clientId = E2EEFormats.clientId(for: identity.publicKey)
        let link = try await tunnel.open(E2EETunnelRoute(deviceId: payload.deviceId, clientId: clientId, ch: ch))
        let channel = ClientSecureChannel(deviceId: payload.deviceId, clientId: clientId, link: link, trust: trust, options: options)
        await channel.start()
        let result = try await channel.withHandshakeTimeout(options.handshakeTimeout) {
            try await channel.runPairing(payload, identity: identity, label: label, platform: platform)
        }
        return (channel, result)
    }

    /// 重连已配对的设备（KK）；`devicePub` 是钉住的公钥。
    static func connect(
        deviceId: String,
        devicePub: Data,
        identity: X25519KeyPair,
        tunnel: any E2EETunnel,
        trust: ClientTrustStore?,
        ch: String = E2EEFormats.newChannelId(),
        options: Options = Options()
    ) async throws -> ClientSecureChannel {
        let clientId = E2EEFormats.clientId(for: identity.publicKey)
        let link = try await tunnel.open(E2EETunnelRoute(deviceId: deviceId, clientId: clientId, ch: ch))
        let channel = ClientSecureChannel(deviceId: deviceId, clientId: clientId, link: link, trust: trust, options: options)
        await channel.start()
        try await channel.withHandshakeTimeout(options.handshakeTimeout) {
            try await channel.runConnect(devicePub: devicePub, identity: identity)
        }
        return channel
    }

    private func start() {
        guard E2EEFormats.isChannelId(ch) else {
            fail(E2EEError(code: E2EEError.protocolError, message: "invalid channel id"))
            return
        }
        let inbound = link.inbound
        reader = Task { [weak self] in
            for await item in inbound {
                guard let self else { return }
                await self.deliver(item)
            }
            await self?.deliver(.end(code: E2EEError.closed))
        }
    }

    private func runPairing(_ payload: E2EEPairingPayload, identity: X25519KeyPair, label: String, platform: String) async throws -> E2EEPairingResult {
        try ensureNotClosed()
        let expectedPub = try E2EEFormats.fromBase64url(payload.deviceIdentityPub)
        pairing = (payload, expectedPub)
        let handshake = try NoiseHandshake(
            protocolName: E2EEFormats.pairingProtocol,
            initiator: true,
            prologue: try E2EEFormats.pairingPrologue(deviceId: payload.deviceId, pairingId: payload.pairingId, clientId: clientId, ch: ch),
            s: identity,
            psks: [try E2EEFormats.fromBase64url(payload.psk)]
        )
        try sendHandshake(.xxpsk0, pairingId: payload.pairingId, step: 0, message: try handshake.writeMessage())
        let reply = try E2EEHandshakeEnvelope.decode(try await nextHandshakeItem(), expectedStep: 1)
        let hello: Data
        do {
            hello = try handshake.readMessage(try E2EEFormats.fromBase64url(reply.message))
        } catch {
            // psk 不对、路由被改写或设备身份变了：Noise 认证失败。
            throw fail(E2EEError(code: E2EEError.handshakeFailed, message: "pairing handshake failed"))
        }
        let helloDevice = (try? JSONSerialization.jsonObject(with: hello) as? [String: Any])?["deviceId"] as? String
        // 握手里的设备公钥必须是二维码里的，设备也必须是扫到的那台。
        guard handshake.remoteStatic == expectedPub, helloDevice == payload.deviceId else {
            throw fail(E2EEError(code: E2EEError.pinMismatch, message: "the device key does not match the QR code"))
        }
        let clientHello = try JSONSerialization.data(withJSONObject: ["label": label, "platform": platform], options: [.sortedKeys])
        let finish = try handshake.writeMessage(clientHello)
        let transport = makeTransport(try handshake.takeTransport())
        try sendHandshake(.xxpsk0, pairingId: payload.pairingId, step: 2, message: finish)
        try openTransport(transport)
        try await untilReady()
        guard let committed else {
            throw fail(E2EEError(code: E2EEError.protocolError, message: "ready before pair.committed"))
        }
        return committed
    }

    private func runConnect(devicePub: Data, identity: X25519KeyPair) async throws {
        try ensureNotClosed()
        let handshake = try NoiseHandshake(
            protocolName: E2EEFormats.reconnectProtocol,
            initiator: true,
            prologue: try E2EEFormats.connectPrologue(deviceId: deviceId, clientId: clientId, ch: ch),
            s: identity,
            rs: devicePub
        )
        try sendHandshake(.kk, pairingId: nil, step: 0, message: try handshake.writeMessage())
        let item: E2EEChannelItem
        do {
            item = try await nextHandshakeItem()
        } catch let error as E2EEError where error.code == E2EEError.handshakeFailed {
            // 设备读不了我们的 KK 第一条消息：设备身份变了，或者钉住的公钥不对。两种都要重新扫码配对。
            // 这只是报错：不改信任记录，也不放松加密要求。
            throw E2EEError(code: E2EEError.pinMismatch, message: "KK handshake failed: \(error.message)")
        }
        let reply = try E2EEHandshakeEnvelope.decode(item, expectedStep: 1)
        do {
            _ = try handshake.readMessage(try E2EEFormats.fromBase64url(reply.message))
        } catch {
            // 只有持有钉住私钥的设备能回答 KK：其他情况都是设备身份变了。
            throw fail(E2EEError(code: E2EEError.pinMismatch, message: "the device did not prove the pinned key"))
        }
        try openTransport(makeTransport(try handshake.takeTransport()))
        try await untilReady()
    }

    private func makeTransport(_ pair: NoiseTransportPair) -> E2EETransportSession {
        E2EETransportSession(pair: pair, now: now, rekeyFrames: rekeyFrames, rekeyInterval: rekeyInterval)
    }

    private func sendHandshake(_ pattern: E2EEHandshakeEnvelope.Pattern, pairingId: String?, step: Int, message: Data) throws {
        try ensureNotClosed()
        let envelope = E2EEHandshakeEnvelope(pattern: pattern, pairingId: pairingId, step: step, message: E2EEFormats.base64url(message))
        link.send(try envelope.encoded())
    }

    private func nextHandshakeItem() async throws -> E2EEChannelItem {
        try ensureNotClosed()
        if !inbox.isEmpty { return inbox.removeFirst() }
        return try await withCheckedThrowingContinuation { handshakeWaiter = $0 }
    }

    /// 握手阶段收到、但还没被读走的帧（例如紧跟在握手后到达的传输帧）在这里接着处理。
    private func openTransport(_ transport: E2EETransportSession) throws {
        try ensureNotClosed()
        phase = .open(transport)
        let queued = inbox
        inbox = []
        for item in queued { process(item) }
        try ensureNotClosed()
    }

    private func untilReady() async throws {
        try ensureNotClosed()
        if ready != nil { return }
        try await withCheckedThrowingContinuation { readyWaiter = $0 }
    }

    private func withHandshakeTimeout<T: Sendable>(_ timeout: Duration, _ body: @Sendable @escaping () async throws -> T) async throws -> T {
        let timer = Task { [weak self] in
            try await Task.sleep(for: timeout)
            await self?.fail(E2EEError(code: E2EEError.protocolError, message: "handshake timed out"))
        }
        defer { timer.cancel() }
        do {
            return try await body()
        } catch {
            // 握手任何一步失败，这次握手就作废：关掉通道并结束路由（已经关闭时什么也不做）。
            fail(error as? E2EEError ?? E2EEError(code: E2EEError.protocolError, message: String(describing: error)))
            throw error
        }
    }

    // MARK: 使用

    /// 通道内的客户端 API 调用；`path` 与普通模式相同（例如 `/api/v2/sessions/{id}/snapshot`）。
    /// `body` 是请求体的原始 JSON 字节，原样放进通道消息（命令的输入摘要也按这些字节计算）。
    func request(_ method: HTTPMethod, path: String, body: Data? = nil) async throws -> E2EETunnelResponse {
        let transport = try requireOpen()
        if let body, (try? JSONSerialization.jsonObject(with: body, options: .fragmentsAllowed)) == nil {
            throw E2EEError(code: E2EEError.protocolError, message: "request body is not JSON")
        }
        let id = "r\(nextId)"
        nextId += 1
        var message = try Self.json(["kind": "request", "id": id, "method": method.rawValue, "path": path])
        // `{"id":…,"kind":…}` + `,"body":<原始字节>}`
        message.removeLast()
        message += Data(#","body":"#.utf8) + (body ?? Data("null".utf8)) + Data("}".utf8)
        let items = try transport.seal(message)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pending[id] = continuation
                items.forEach(link.send)
            }
        } onCancel: {
            Task { await self.cancelRequest(id) }
        }
    }

    /// 订阅一个会话的实时事件（相当于普通模式打开会话 WS）。每个元素是一条事件的 JSON 字节。
    /// 通道关闭时流以错误结束；取消迭代会发 `unsubscribe`。
    func subscribe(sessionId: String, afterCursor: String?) throws -> (id: String, events: AsyncThrowingStream<Data, Error>) {
        let transport = try requireOpen()
        let id = "s\(nextId)"
        nextId += 1
        var fields: [String: Any] = ["kind": "subscribe", "id": id, "stream": "session", "sessionId": sessionId]
        fields["afterCursor"] = afterCursor ?? NSNull()
        let items = try transport.seal(try Self.json(fields))
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream(bufferingPolicy: .bufferingOldest(2048))
        subscriptions[id] = continuation
        continuation.onTermination = { [weak self] termination in
            guard case .cancelled = termination else { return }
            Task { try? await self?.unsubscribe(id) }
        }
        items.forEach(link.send)
        return (id, stream)
    }

    func unsubscribe(_ id: String) throws {
        guard let continuation = subscriptions.removeValue(forKey: id) else { return }
        continuation.finish()
        guard case let .open(transport) = phase else { return }
        try transport.seal(try Self.json(["kind": "unsubscribe", "id": id])).forEach(link.send)
    }

    /// 通道级事件（`e2ee.directory_key`、`e2ee.trust_changed`），每个元素是事件的 JSON 字节。
    func channelEvents() -> AsyncStream<Data> {
        let (stream, continuation) = AsyncStream<Data>.makeStream(bufferingPolicy: .bufferingNewest(64))
        let key = UUID()
        channelEventListeners[key] = continuation
        continuation.onTermination = { [weak self] _ in Task { await self?.removeListener(key) } }
        if case .closed = phase { continuation.finish() }
        return stream
    }

    /// 立即对发送方向 rekey（测试，或怀疑密钥泄露后）。
    func rekeyNow() throws {
        link.send(try requireOpen().sealRekey())
    }

    var isOpen: Bool {
        if case .open = phase, ready != nil { return true }
        return false
    }

    var closeError: E2EEError? {
        if case let .closed(error) = phase { return error }
        return nil
    }

    /// 主动关闭：在通道内发 `close`，再结束这条路由。
    func close() {
        if case let .open(transport) = phase,
           let items = try? transport.seal((try? Self.json(["kind": "close", "reason": "shutdown", "message": ""])) ?? Data()) {
            items.forEach(link.send)
        }
        fail(E2EEError(code: E2EEError.closed), endCode: E2EEError.closed)
    }

    // MARK: 接收

    private func deliver(_ inbound: E2EETunnelInbound) {
        switch inbound {
        case let .end(code):
            // Server 能伪造的最多是一次断线：只结束通道，不改变任何加密要求。
            fail(E2EEError(code: code, message: "tunnel ended: \(code)"), endCode: nil)
        case let .frame(item):
            switch phase {
            case .closed:
                return
            case .handshake:
                if let waiter = handshakeWaiter {
                    handshakeWaiter = nil
                    waiter.resume(returning: item)
                } else {
                    inbox.append(item)
                }
            case .open:
                process(item)
            }
        }
    }

    private func process(_ item: E2EEChannelItem) {
        guard case let .open(transport) = phase else { return }
        do {
            guard let bytes = try transport.open(item) else { return }
            try handle(bytes)
        } catch let error as E2EEError {
            fail(error, endCode: error.code == E2EEError.tooLarge ? E2EEError.tooLarge : E2EEError.protocolError)
        } catch {
            fail(E2EEError(code: E2EEError.protocolError, message: error.localizedDescription), endCode: E2EEError.protocolError)
        }
    }

    private func handle(_ bytes: Data) throws {
        guard let message = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
            throw E2EEError(code: E2EEError.protocolError, message: "channel message is not JSON")
        }
        switch message["kind"] as? String {
        case "pair.committed":
            try handleCommitted(message)
        case "ready":
            guard message["clientId"] as? String == clientId, message["deviceId"] as? String == deviceId,
                  let keyId = message["directoryKeyId"] as? String, let epoch = message["directoryKeyEpoch"] as? Int
            else { throw E2EEError(code: E2EEError.protocolError, message: "ready names another client or device") }
            if pairing != nil, committed == nil {
                throw E2EEError(code: E2EEError.protocolError, message: "ready before pair.committed")
            }
            ready = E2EEChannelReady(deviceId: deviceId, clientId: clientId, directoryKeyId: keyId, directoryKeyEpoch: epoch)
            readyWaiter?.resume()
            readyWaiter = nil
        case "response":
            guard ready != nil, let id = message["id"] as? String, let status = message["status"] as? Int else {
                throw E2EEError(code: E2EEError.protocolError, message: "malformed response")
            }
            let body = try JSONSerialization.data(withJSONObject: message["body"] ?? NSNull(), options: [.fragmentsAllowed])
            pending.removeValue(forKey: id)?.resume(returning: E2EETunnelResponse(status: status, body: body))
        case "event":
            guard ready != nil, let event = message["event"] as? [String: Any] else {
                throw E2EEError(code: E2EEError.protocolError, message: "malformed event")
            }
            let data = try JSONSerialization.data(withJSONObject: event)
            if let sub = message["sub"] as? String {
                subscriptions[sub]?.yield(data)
            } else {
                handleChannelEvent(event)
                channelEventListeners.values.forEach { $0.yield(data) }
            }
        case "close":
            // 这条 close 经过了 Noise 认证，确实来自设备；错误码只由 reason 决定（不把 message 当错误码）。
            let reason = message["reason"] as? String ?? ""
            let detail = message["message"] as? String ?? ""
            if reason == "revoked" || reason == "not_paired" {
                // 只有设备在认证通道内说「已撤销 / 未授权」时才丢掉钉住的公钥；「要求加密」保留。
                try? trust?.forget(deviceId)
            }
            fail(E2EEError(code: Self.code(forCloseReason: reason),
                           message: detail.isEmpty ? "device closed the channel: \(reason)" : detail,
                           fromDevice: true),
                 endCode: E2EEError.closed)
        default:
            throw E2EEError(code: E2EEError.protocolError, message: "unexpected message \(message["kind"] ?? "nil")")
        }
    }

    private func handleCommitted(_ message: [String: Any]) throws {
        guard let pairing, committed == nil, ready == nil,
              message["deviceId"] as? String == deviceId, message["clientId"] as? String == clientId,
              let grantedAt = message["grantedAt"] as? String,
              let keyObject = message["directoryKey"],
              let grant = try? JSONDecoder().decode(E2EEDirectoryKeyGrant.self, from: JSONSerialization.data(withJSONObject: keyObject)),
              grant.deviceId == deviceId, (try? E2EEFormats.fromBase64url(grant.key).count) == 32
        else { throw E2EEError(code: E2EEError.protocolError, message: "malformed pair.committed") }
        let result = E2EEPairingResult(deviceId: deviceId, clientId: clientId, devicePub: pairing.devicePub,
                                       grantedAt: grantedAt, directoryKey: grant)
        committed = result
        do {
            try trust?.savePairing(result)
            if pairing.payload.requiresEncryption { try trust?.markRequired(deviceId) }
        } catch {
            throw E2EEError(code: E2EEError.protocolError, message: "could not save the pairing: \(error.localizedDescription)")
        }
    }

    private func handleChannelEvent(_ event: [String: Any]) {
        guard event["type"] as? String == "e2ee.directory_key", let payload = event["payload"],
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let grant = try? JSONDecoder().decode(E2EEDirectoryKeyGrant.self, from: data),
              grant.deviceId == deviceId
        else { return }
        _ = try? trust?.updateDirectoryKey(grant)
    }

    // MARK: 结束

    private func requireOpen() throws -> E2EETransportSession {
        try ensureNotClosed()
        guard case let .open(transport) = phase, ready != nil else {
            throw E2EEError(code: E2EEError.protocolError, message: "channel not ready")
        }
        return transport
    }

    private func ensureNotClosed() throws {
        if case let .closed(error) = phase { throw error }
    }

    @discardableResult
    private func fail(_ error: E2EEError, endCode: String? = E2EEError.protocolError) -> E2EEError {
        if case let .closed(existing) = phase { return existing }
        if case let .open(transport) = phase { transport.destroy() }
        phase = .closed(error)
        if let endCode { link.end(code: endCode) }
        reader?.cancel()
        inbox = []
        handshakeWaiter?.resume(throwing: error)
        handshakeWaiter = nil
        readyWaiter?.resume(throwing: error)
        readyWaiter = nil
        pending.values.forEach { $0.resume(throwing: error) }
        pending = [:]
        subscriptions.values.forEach { $0.finish(throwing: error) }
        subscriptions = [:]
        channelEventListeners.values.forEach { $0.finish() }
        channelEventListeners = [:]
        return error
    }

    private func cancelRequest(_ id: String) {
        pending.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }

    private func removeListener(_ key: UUID) {
        channelEventListeners[key] = nil
    }

    private static func code(forCloseReason reason: String) -> String {
        switch reason {
        case "revoked", "not_paired": E2EEError.notPaired
        case "protocol_error": E2EEError.protocolError
        case "too_large": E2EEError.tooLarge
        case "policy": E2EEError.required
        default: E2EEError.closed
        }
    }

    private static func json(_ object: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
    }
}

extension ClientSecureChannel: E2EEDeviceChannel {}
