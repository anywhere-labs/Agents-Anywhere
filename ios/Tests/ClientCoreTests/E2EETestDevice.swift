import Foundation
@testable import ClientCore

/// 测试内的最小设备端：用同一套 Noise 状态机做 responder，按 e2ee 1.0 回 `pair.committed` / `ready`，
/// 把 `request` 原样回显，记录订阅。只为客户端通道的往返测试，不是设备端实现。
nonisolated final class E2EETestDevice: @unchecked Sendable {
    let deviceId: String
    let label = "Home Mac"
    /// 设备真正持有的身份密钥。测试「设备身份变了」时换掉它。
    var identity: X25519KeyPair
    var directoryKey: E2EEDirectoryKeyGrant
    var rekeyFrames = E2EEFormats.rekeyIntervalFrames
    /// 设备上的客户端 API：返回 (status, body)；返回 nil 表示不回应（测试超时）。不设时回显请求。
    var responder: ((_ method: String, _ path: String, _ body: Any) -> (status: Int, body: Any)?)?
    private(set) var grants: [String: Data] = [:]
    private(set) var requests: [(clientId: String, method: String, path: String, body: Any)] = []
    private(set) var subscriptions: [String: (route: E2EETunnelRoute, sub: String)] = [:]
    private var pairings: [String: (psk: Data, used: Bool, expired: Bool)] = [:]
    private var sides: [E2EETunnelRoute: Side] = [:]
    private let lock = NSRecursiveLock()

    final class Side {
        enum Phase {
            case start
            case handshake(NoiseHandshake, pairingId: String)
            case open(E2EETransportSession)
            case closed
        }
        let link: E2EETestLink
        var phase: Phase = .start
        init(link: E2EETestLink) { self.link = link }
        var transport: E2EETransportSession? {
            if case let .open(transport) = phase { return transport }
            return nil
        }
    }

    init(deviceId: String = "dev_home") {
        self.deviceId = deviceId
        identity = NoiseCrypto.generateKeyPair()
        directoryKey = E2EEDirectoryKeyGrant(deviceId: deviceId, keyId: "dk_1", epoch: 1,
                                             key: E2EEFormats.base64url(Data((0..<32).map { UInt8($0) })))
    }

    /// 生成一个配对二维码的内容。`advertisedPub` 用来模拟二维码里的公钥与设备实际公钥不一致。
    func startPairing(advertisedPub: Data? = nil, mode: String = "required") -> E2EEPairingPayload {
        lock.withLock {
            let pairingId = "pair_\(pairings.count + 1)"
            let psk = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
            pairings[pairingId] = (psk, false, false)
            let payload = E2EEPairingPayload(
                v: 1, deviceId: deviceId,
                deviceIdentityPub: E2EEFormats.base64url(advertisedPub ?? identity.publicKey),
                pairingId: pairingId, psk: E2EEFormats.base64url(psk),
                serverUrl: "https://aa.example.com", e2eeMode: mode, expiresAt: "2099-01-01T00:00:00Z"
            )
            issuedPayloads.append(payload)
            return payload
        }
    }

    private(set) var issuedPayloads: [E2EEPairingPayload] = []

    func expire(_ pairingId: String) { lock.withLock { pairings[pairingId]?.expired = true } }
    func revoke(_ clientId: String) { lock.withLock { _ = grants.removeValue(forKey: clientId) } }
    func trust(_ clientId: String, pub: Data) { lock.withLock { grants[clientId] = pub } }

    func side(_ route: E2EETunnelRoute) -> Side? { lock.withLock { sides[route] } }

    // MARK: 设备主动发的

    /// 往某条路由推一条通道消息（`event`、`close` 等）。
    func push(_ route: E2EETunnelRoute, _ message: [String: Any]) throws {
        try lock.withLock {
            guard let side = sides[route], let transport = side.transport else { return }
            try send(side, transport, message)
        }
    }

    func emit(sessionId: String, event: [String: Any]) throws {
        try lock.withLock {
            guard let (route, sub) = subscriptions[sessionId], let side = sides[route], let transport = side.transport else { return }
            try send(side, transport, ["kind": "event", "sub": sub, "event": event])
        }
    }

    // MARK: 线上

    func attach(_ link: E2EETestLink) {
        lock.withLock { sides[link.route] = Side(link: link) }
    }

    func receive(_ route: E2EETunnelRoute, _ item: E2EEChannelItem) {
        lock.withLock {
            guard let side = sides[route] else { return }
            do {
                try handle(side, route, item)
            } catch let error as E2EEError {
                end(side, code: error.code == E2EEError.tooLarge ? E2EEError.tooLarge : E2EEError.protocolError)
            } catch {
                // Noise 认证失败（psk 不对、路由被改写、密钥不对）。
                end(side, code: E2EEError.handshakeFailed)
            }
        }
    }

    func clientEnded(_ route: E2EETunnelRoute) {
        lock.withLock {
            if let side = sides[route] { side.transport?.destroy(); side.phase = .closed }
        }
    }

    private func handle(_ side: Side, _ route: E2EETunnelRoute, _ item: E2EEChannelItem) throws {
        switch side.phase {
        case .closed:
            return
        case .start:
            let envelope = try E2EEHandshakeEnvelope.decode(item, expectedStep: 0)
            if envelope.pattern == .xxpsk0 {
                guard let pairingId = envelope.pairingId, let pairing = pairings[pairingId], !pairing.used, !pairing.expired else {
                    return end(side, code: E2EEError.pairingExpired)
                }
                let hs = try NoiseHandshake(
                    protocolName: E2EEFormats.pairingProtocol, initiator: false,
                    prologue: try E2EEFormats.pairingPrologue(deviceId: deviceId, pairingId: pairingId, clientId: route.clientId, ch: route.ch),
                    s: identity, psks: [pairing.psk]
                )
                _ = try hs.readMessage(try E2EEFormats.fromBase64url(envelope.message))
                let hello = try JSONSerialization.data(withJSONObject: ["deviceId": deviceId, "label": label])
                try sendHandshake(side, .xxpsk0, pairingId: pairingId, step: 1, message: try hs.writeMessage(hello))
                side.phase = .handshake(hs, pairingId: pairingId)
            } else {
                guard let pinned = grants[route.clientId] else { return end(side, code: E2EEError.notPaired) }
                let hs = try NoiseHandshake(
                    protocolName: E2EEFormats.reconnectProtocol, initiator: false,
                    prologue: try E2EEFormats.connectPrologue(deviceId: deviceId, clientId: route.clientId, ch: route.ch),
                    s: identity, rs: pinned
                )
                _ = try hs.readMessage(try E2EEFormats.fromBase64url(envelope.message))
                try sendHandshake(side, .kk, pairingId: nil, step: 1, message: try hs.writeMessage())
                let transport = E2EETransportSession(pair: try hs.takeTransport(), rekeyFrames: rekeyFrames)
                side.phase = .open(transport)
                try sendReady(side, transport, route)
            }
        case let .handshake(hs, pairingId):
            let envelope = try E2EEHandshakeEnvelope.decode(item, expectedStep: 2)
            _ = try hs.readMessage(try E2EEFormats.fromBase64url(envelope.message))
            let pair = try hs.takeTransport()
            guard let rs = pair.remoteStatic, E2EEFormats.clientId(for: rs) == route.clientId else {
                return end(side, code: E2EEError.notPaired)
            }
            grants[route.clientId] = rs
            pairings[pairingId]?.used = true
            let transport = E2EETransportSession(pair: pair, rekeyFrames: rekeyFrames)
            side.phase = .open(transport)
            let key: [String: Any] = ["deviceId": directoryKey.deviceId, "keyId": directoryKey.keyId,
                                      "epoch": directoryKey.epoch, "key": directoryKey.key]
            try send(side, transport, ["kind": "pair.committed", "deviceId": deviceId, "clientId": route.clientId,
                                       "grantedAt": "2026-11-16T12:00:00Z", "directoryKey": key])
            try sendReady(side, transport, route)
        case let .open(transport):
            guard let bytes = try transport.open(item) else { return }
            let message = try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
            guard grants[route.clientId] != nil else {
                return try send(side, transport, ["kind": "close", "reason": "revoked", "message": ""])
            }
            switch message["kind"] as? String {
            case "request":
                let path = message["path"] as! String
                requests.append((route.clientId, message["method"] as! String, path, message["body"] ?? NSNull()))
                if let responder, path != "/e2ee/v1/directory-key" {
                    guard let (status, body) = responder(message["method"] as! String, path, message["body"] ?? NSNull()) else { return }
                    return try send(side, transport, ["kind": "response", "id": message["id"]!, "status": status, "body": body])
                }
                let body: Any = path == "/e2ee/v1/directory-key"
                    ? ["deviceId": directoryKey.deviceId, "keyId": directoryKey.keyId, "epoch": directoryKey.epoch, "key": directoryKey.key]
                    : ["echo": message["body"] ?? NSNull(), "path": path]
                try send(side, transport, ["kind": "response", "id": message["id"]!, "status": path.hasSuffix("/missing") ? 404 : 200, "body": body])
            case "subscribe":
                subscriptions[message["sessionId"] as! String] = (route, message["id"] as! String)
            case "unsubscribe":
                subscriptions = subscriptions.filter { $0.value.sub != message["id"] as? String }
            case "close":
                side.phase = .closed
            default:
                throw E2EEError(code: E2EEError.protocolError)
            }
        }
    }

    private func sendReady(_ side: Side, _ transport: E2EETransportSession, _ route: E2EETunnelRoute) throws {
        try send(side, transport, ["kind": "ready", "deviceId": deviceId, "clientId": route.clientId,
                                   "directoryKeyId": directoryKey.keyId, "directoryKeyEpoch": directoryKey.epoch])
    }

    private func sendHandshake(_ side: Side, _ pattern: E2EEHandshakeEnvelope.Pattern, pairingId: String?, step: Int, message: Data) throws {
        side.link.deliver(try E2EEHandshakeEnvelope(pattern: pattern, pairingId: pairingId, step: step,
                                                    message: E2EEFormats.base64url(message)).encoded())
    }

    private func send(_ side: Side, _ transport: E2EETransportSession, _ message: [String: Any]) throws {
        for item in try transport.seal(try JSONSerialization.data(withJSONObject: message)) { side.link.deliver(item) }
    }

    private func end(_ side: Side, code: String) {
        side.transport?.destroy()
        side.phase = .closed
        side.link.remoteEnd(code: code)
    }
}

/// 内存里的「Server」：把客户端的帧原样转给设备，可以在两个方向上篡改，也可以伪造 `end`。
nonisolated final class E2EETestTunnel: E2EETunnel, @unchecked Sendable {
    let device: E2EETestDevice
    var toDevice: ((E2EEChannelItem, Int) -> E2EEChannelItem?)?
    var toClient: ((E2EEChannelItem, Int) -> E2EEChannelItem?)?
    /// 在客户端发出第 N 帧（从 0 数）后伪造一个 `ClientTunnelEnd`，不经过设备。
    var forgeEnd: (afterFrame: Int, code: String)?
    private(set) var links: [E2EETestLink] = []
    private let lock = NSRecursiveLock()

    init(device: E2EETestDevice) { self.device = device }

    func open(_ route: E2EETunnelRoute) async throws -> any E2EETunnelLink {
        let link = E2EETestLink(route: route, tunnel: self)
        lock.withLock { links.append(link) }
        device.attach(link)
        return link
    }

    func shutdown() async {
        for link in lock.withLock({ links }) { link.remoteEnd(code: E2EEError.closed) }
    }
}

nonisolated final class E2EETestLink: E2EETunnelLink, @unchecked Sendable {
    let route: E2EETunnelRoute
    let inbound: AsyncStream<E2EETunnelInbound>
    private let continuation: AsyncStream<E2EETunnelInbound>.Continuation
    private let tunnel: E2EETestTunnel
    private let lock = NSRecursiveLock()
    private var sent = 0
    private var delivered = 0
    private var finished = false
    private(set) var endCodes: [String] = []

    init(route: E2EETunnelRoute, tunnel: E2EETestTunnel) {
        self.route = route
        self.tunnel = tunnel
        (inbound, continuation) = AsyncStream<E2EETunnelInbound>.makeStream()
    }

    func send(_ item: E2EEChannelItem) {
        let (index, ended) = lock.withLock { () -> (Int, Bool) in defer { sent += 1 }; return (sent, finished) }
        guard !ended else { return }
        if let forged = tunnel.forgeEnd, forged.afterFrame == index {
            remoteEnd(code: forged.code)
            return
        }
        guard let out = tunnel.toDevice.map({ $0(item, index) }) ?? item else { return }
        tunnel.device.receive(route, out)
    }

    func end(code: String) {
        lock.withLock {
            endCodes.append(code)
            finished = true
        }
        continuation.finish()
        tunnel.device.clientEnded(route)
    }

    func deliver(_ item: E2EEChannelItem) {
        let index = lock.withLock { () -> Int in defer { delivered += 1 }; return delivered }
        guard let out = tunnel.toClient.map({ $0(item, index) }) ?? item else { return }
        continuation.yield(.frame(out))
    }

    func remoteEnd(code: String) {
        lock.withLock { finished = true }
        continuation.yield(.end(code: code))
        continuation.finish()
    }
}

/// 只记录调用的命令登记 API。
nonisolated final class E2EETestAPI: V2E2EEAPIProtocol, @unchecked Sendable {
    var duplicate = false
    private(set) var registrations: [E2EECommandRegistration] = []

    func tunnelTicket(clientId: String) async throws -> V2WebSocketTicket {
        V2WebSocketTicket(ticket: "ticket", expiresAt: "", serverTime: "")
    }

    func registerCommand(_ registration: E2EECommandRegistration) async throws -> E2EECommandRegistrationResponse {
        registrations.append(registration)
        return E2EECommandRegistrationResponse(duplicate: duplicate)
    }
}

/// 隧道 WebSocket 的内存替身：记录发出的文本，按测试的安排返回收到的文本或错误。
nonisolated final class E2EEFakeTunnelSocket: E2EETunnelSocket, @unchecked Sendable {
    private let lock = NSLock()
    private var buffer: [Result<String, Error>] = []
    private var waiter: CheckedContinuation<String, Error>?
    private var sentTexts: [String] = []
    private var isClosed = false

    var sent: [String] { lock.withLock { sentTexts } }
    var closed: Bool { lock.withLock { isClosed } }

    func send(_ text: String) async throws {
        lock.withLock { sentTexts.append(text) }
    }

    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            if buffer.isEmpty {
                waiter = continuation
                lock.unlock()
            } else {
                let next = buffer.removeFirst()
                lock.unlock()
                continuation.resume(with: next)
            }
        }
    }

    func push(_ result: Result<String, Error>) {
        lock.lock()
        if let waiter {
            self.waiter = nil
            lock.unlock()
            waiter.resume(with: result)
        } else {
            buffer.append(result)
            lock.unlock()
        }
    }

    func close() {
        lock.withLock { isClosed = true }
        push(.failure(URLError(.cancelled)))
    }
}
