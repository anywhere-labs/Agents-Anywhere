import Foundation
import Synchronization
import Testing
@testable import ClientCore

/// 客户端通道与测试内最小设备端的往返：配对、重连、rekey、钉住公钥不符、篡改、降级保护。
@MainActor struct E2EEChannelTests {
    let device = E2EETestDevice()
    let tunnel: E2EETestTunnel
    let storage = E2EEMemoryStorage()
    let trust: ClientTrustStore

    init() {
        tunnel = E2EETestTunnel(device: device)
        trust = ClientTrustStore(storage: storage, scope: "test")
    }

    private func pair(options: ClientSecureChannel.Options = .init()) async throws -> (ClientSecureChannel, E2EEPairingResult) {
        let payload = device.startPairing()
        return try await ClientSecureChannel.pair(payload, identity: try trust.identity(), tunnel: tunnel, trust: trust,
                                                  label: "iPhone", options: options)
    }

    private func connect(options: ClientSecureChannel.Options = .init()) async throws -> ClientSecureChannel {
        let record = try #require(try trust.device(device.deviceId))
        return try await ClientSecureChannel.connect(deviceId: device.deviceId, devicePub: record.devicePubBytes!,
                                                     identity: try trust.identity(), tunnel: tunnel, trust: trust, options: options)
    }

    private func code<T>(_ body: () async throws -> T) async -> E2EEError? {
        do { _ = try await body(); return nil } catch { return error as? E2EEError }
    }

    @Test func pairingSavesGrantAndDirectoryKey() async throws {
        let (channel, result) = try await pair()
        #expect(await channel.isOpen)
        #expect(result.clientId == (try trust.clientId()))
        #expect(result.directoryKey == device.directoryKey)
        #expect(device.grants[result.clientId] == (try trust.identity().publicKey))

        let record = try #require(try trust.device(device.deviceId))
        #expect(record.devicePubBytes == device.identity.publicKey)
        #expect(record.fingerprint == E2EEFormats.fingerprint(device.identity.publicKey))
        #expect(record.grantedAt == "2026-11-16T12:00:00Z")
        #expect(record.directoryKey.keyId == "dk_1")
        #expect(try trust.requiresEncryption(device.deviceId))

        let body = Data(#"{"content":"hello"}"#.utf8)
        let response = try await channel.request(.post, path: "/api/v2/sessions/s1/messages", body: body)
        #expect(response.status == 200)
        let echoed = try JSONSerialization.jsonObject(with: response.body) as! [String: Any]
        #expect(echoed["path"] as? String == "/api/v2/sessions/s1/messages")
        #expect((echoed["echo"] as? [String: String]) == ["content": "hello"])
        #expect(device.requests.first?.clientId == result.clientId)

        // 配对码只能用一次，过期的也不行。
        let used = try #require(device.issuedPayloads.first)
        let reused = await code {
            try await ClientSecureChannel.pair(used, identity: NoiseCrypto.generateKeyPair(),
                                               tunnel: tunnel, trust: nil, label: "other")
        }
        #expect(reused?.code == E2EEError.pairingExpired)
        let expiredPayload = device.startPairing()
        device.expire(expiredPayload.pairingId)
        let expired = await code {
            try await ClientSecureChannel.pair(expiredPayload, identity: NoiseCrypto.generateKeyPair(),
                                               tunnel: tunnel, trust: nil, label: "late")
        }
        #expect(expired?.code == E2EEError.pairingExpired)
    }

    @Test func reconnectWithPinnedKeyAndSubscribe() async throws {
        let (first, _) = try await pair()
        await first.close()
        #expect(await first.closeError?.code == E2EEError.closed)

        let channel = try await connect()
        #expect(await channel.ready?.directoryKeyId == "dk_1")
        #expect(channel.ch != first.ch)

        let transport = E2EEChannelHTTPTransport(channel: channel)
        struct Echo: Decodable { let path: String }
        let echo = try await transport.send(HTTPRequest<EmptyRequestBody, Echo>(method: .get, path: "/sessions/s1/snapshot"))
        #expect(echo.path == "/api/v2/sessions/s1/snapshot")
        await #expect(throws: HTTPError.self) {
            try await transport.send(HTTPRequest<EmptyRequestBody, Echo>(method: .get, path: "/sessions/missing"))
        }

        let events = try await channel.sessionEvents(sessionId: "s1", afterCursor: "seq:0")
        try await eventually { device.subscriptions["s1"] != nil }
        var object = try fixtureObject("event")
        object["type"] = "timeline.item_created"; object["sequence"] = 1; object["cursor"] = "seq:1"; object["sessionId"] = "s1"
        try device.emit(sessionId: "s1", event: ["type": "keepalive"])
        try device.emit(sessionId: "s1", event: object)
        var iterator = events.makeAsyncIterator()
        let received = try await iterator.next()
        #expect(received?.cursor == "seq:1")
        #expect(received?.sessionId == "s1")
    }

    @Test func rekeyByFramesTimeAndOnDemand() async throws {
        let clock = Mutex(Date(timeIntervalSince1970: 1_800_000_000))
        var options = ClientSecureChannel.Options()
        options.now = { clock.withLock { $0 } }
        options.rekeyFrames = 2
        device.rekeyFrames = 3
        let (channel, _) = try await pair(options: options)
        let route = E2EETunnelRoute(deviceId: device.deviceId, clientId: channel.clientId, ch: channel.ch)

        let big = String(repeating: "x", count: 200_000)
        let body = try JSONSerialization.data(withJSONObject: ["big": big])
        let response = try await channel.request(.post, path: "/api/v2/big", body: body)
        #expect(((try JSONSerialization.jsonObject(with: response.body) as! [String: Any])["echo"] as? [String: String])?["big"] == big)
        for index in 0..<4 { #expect(try await channel.request(.get, path: "/api/v2/r\(index)").status == 200) }
        let deviceTransport = try #require(device.side(route)?.transport)
        let frameRekeys = deviceTransport.receivedRekeys
        #expect(frameRekeys >= 2)
        // 设备发送方向也按帧数 rekey，客户端照常收。
        #expect(deviceTransport.sentRekeys >= 1)

        try await channel.rekeyNow()
        #expect(try await channel.request(.get, path: "/api/v2/after-rekey").status == 200)
        #expect(deviceTransport.receivedRekeys == frameRekeys + 1)

        var slow = ClientSecureChannel.Options()
        slow.now = { clock.withLock { $0 } }
        let reconnected = try await connect(options: slow)
        let slowRoute = E2EETunnelRoute(deviceId: device.deviceId, clientId: reconnected.clientId, ch: reconnected.ch)
        #expect(try await reconnected.request(.get, path: "/api/v2/a").status == 200)
        #expect(device.side(slowRoute)?.transport?.receivedRekeys == 0)
        clock.withLock { $0 = $0.addingTimeInterval(61 * 60) }
        #expect(try await reconnected.request(.get, path: "/api/v2/b").status == 200)
        #expect(device.side(slowRoute)?.transport?.receivedRekeys == 1)
    }

    @Test func pairingRejectsDeviceKeyThatDiffersFromQRCode() async throws {
        let payload = device.startPairing(advertisedPub: NoiseCrypto.generateKeyPair().publicKey)
        let error = await code {
            try await ClientSecureChannel.pair(payload, identity: try trust.identity(), tunnel: tunnel, trust: trust, label: "iPhone")
        }
        #expect(error?.code == E2EEError.pinMismatch)
        #expect(try trust.device(device.deviceId) == nil)
        #expect(tunnel.links.last?.endCodes.isEmpty == false)
    }

    @Test func reconnectRejectsChangedDeviceIdentity() async throws {
        _ = try await pair()
        // 设备换了身份密钥（重装后恢复了授权列表）：读不了 KK 第一条消息。
        device.identity = NoiseCrypto.generateKeyPair()
        let changed = await code { try await connect() }
        #expect(changed?.code == E2EEError.pinMismatch)
        // 只报错，不改钉住的公钥。
        #expect(try trust.device(device.deviceId) != nil)
    }

    @Test func tamperedHandshakeReplyIsPinMismatch() async throws {
        _ = try await pair()
        tunnel.toClient = { item, index in
            guard index == 0, var envelope = try? E2EEHandshakeEnvelope.decode(item, expectedStep: 1),
                  var raw = try? E2EEFormats.fromBase64url(envelope.message) else { return item }
            raw[raw.startIndex + 40] ^= 0x01
            envelope = E2EEHandshakeEnvelope(pattern: envelope.pattern, pairingId: nil, step: 1, message: E2EEFormats.base64url(raw))
            return try? envelope.encoded()
        }
        let error = await code { try await connect() }
        #expect(error?.code == E2EEError.pinMismatch)
        #expect(try trust.device(device.deviceId) != nil)
    }

    @Test func tamperedCiphertextClosesTheChannel() async throws {
        let (channel, _) = try await pair()
        let route = E2EETunnelRoute(deviceId: device.deviceId, clientId: channel.clientId, ch: channel.ch)
        let start = device.side(route)!.transport!.sendNonce
        // 设备 → 客户端方向篡改一帧：客户端解密失败，关闭通道，挂起的请求失败。
        tunnel.toClient = { item, _ in
            guard item.n == start, var raw = try? E2EEFormats.fromBase64url(item.ct) else { return item }
            raw[raw.startIndex] ^= 0x01
            return E2EEChannelItem(n: item.n, ct: E2EEFormats.base64url(raw))
        }
        let error = await code { try await channel.request(.get, path: "/api/v2/x") }
        #expect(error?.code == E2EEError.protocolError)
        #expect(await channel.closeError?.code == E2EEError.protocolError)
        #expect(tunnel.links.last?.endCodes == [E2EEError.protocolError])

        // 客户端 → 设备方向篡改：设备结束调用，客户端收到 end。
        tunnel.toClient = nil
        let second = try await connect()
        tunnel.toDevice = { item, _ in
            guard item.n == 0, var raw = try? E2EEFormats.fromBase64url(item.ct), raw.count > 20 else { return item }
            raw[raw.startIndex] ^= 0x01
            return E2EEChannelItem(n: item.n, ct: E2EEFormats.base64url(raw))
        }
        let rejected = await code { try await second.request(.get, path: "/api/v2/y") }
        #expect(rejected?.code == E2EEError.protocolError)
        #expect(rejected?.fromDevice == false)
    }

    @Test func serverRelayedEndNeverChangesTrust() async throws {
        _ = try await pair()
        // Server 伪造 `ClientTunnelEnd {code: e2ee_not_paired}`：只报错，钉住的公钥和策略都不动。
        tunnel.forgeEnd = (afterFrame: 0, code: E2EEError.notPaired)
        let forged = await code { try await connect() }
        #expect(forged?.code == E2EEError.notPaired)
        #expect(forged?.fromDevice == false)
        #expect(try trust.device(device.deviceId) != nil)
        #expect(try trust.requiresEncryption(device.deviceId))
        tunnel.forgeEnd = nil

        // 设备在认证通道里说「已撤销」：这时才丢掉钉住的公钥，「要求加密」仍保留。
        let channel = try await connect()
        device.revoke(channel.clientId)
        let revoked = await code { try await channel.request(.get, path: "/api/v2/z") }
        #expect(revoked?.code == E2EEError.notPaired)
        #expect(revoked?.fromDevice == true)
        #expect(try trust.device(device.deviceId) == nil)
        #expect(try trust.requiresEncryption(device.deviceId))
    }

    @Test func unpairedClientGetsNotPaired() async throws {
        let stranger = ClientTrustStore(storage: E2EEMemoryStorage(), scope: "stranger")
        let error = await code {
            try await ClientSecureChannel.connect(deviceId: device.deviceId, devicePub: device.identity.publicKey,
                                                  identity: try stranger.identity(), tunnel: tunnel, trust: stranger)
        }
        #expect(error?.code == E2EEError.notPaired)
        #expect(error?.fromDevice == false)
    }
}

@MainActor struct E2EEServiceTests {
    let device = E2EETestDevice()
    let api = E2EETestAPI()
    let trust = ClientTrustStore(storage: E2EEMemoryStorage(), scope: "svc")
    let service: V2E2EEService

    init() {
        service = V2E2EEService(trust: trust, provider: LegacyE2EEChannelProvider(tunnel: E2EETestTunnel(device: device)), api: api, clientLabel: "iPhone")
    }

    private func isPlain(_ route: V2E2EEService.ContentRoute) -> Bool {
        if case .plain = route { return true }
        return false
    }

    @Test func routeFollowsModeAndNeverDowngrades() async throws {
        await service.updateServerConfig(nil)
        #expect(isPlain(try await service.route(for: device.deviceId)))

        await service.updateServerConfig(E2EEServerConfig(mode: .required, web: nil, preview: nil))
        await #expect(throws: E2EEError(code: E2EEError.notPaired)) { try await service.route(for: device.deviceId) }

        // Server 改口说 off：本机已经记下这台设备要求加密，仍然拒绝明文。
        await service.updateServerConfig(.off)
        await #expect(throws: E2EEError(code: E2EEError.notPaired)) { try await service.route(for: device.deviceId) }
        #expect(isPlain(try await service.route(for: "dev_other")))

        let record = try await service.pair(device.startPairing(mode: "off"))
        #expect(record.fingerprint == E2EEFormats.fingerprint(device.identity.publicKey))
        guard case let .encrypted(channel) = try await service.route(for: device.deviceId) else {
            Issue.record("expected an encrypted route"); return
        }
        #expect(await channel.isOpen)

        // 关闭后的下一次访问应打开新通道。
        await channel.close()
        guard case let .encrypted(again) = try await service.route(for: device.deviceId) else {
            Issue.record("expected an encrypted route"); return
        }
        #expect(ObjectIdentifier(again) != ObjectIdentifier(channel))
        #expect(await again.isOpen)
    }

    @Test func rejectionSwitchesToRequired() async throws {
        let rejection = HTTPError.server(statusCode: 409, message: "", detail: .object(["code": .string("e2ee_required")]))
        #expect(await service.noteRejection(rejection, deviceId: "dev_x"))
        #expect(await service.mode == .required)
        #expect(try trust.requiresEncryption("dev_x"))
        #expect(!(await service.noteRejection(HTTPError.server(statusCode: 409, message: "", detail: nil), deviceId: nil)))
    }

    @Test func commandsRegisterDigestAndSkipDuplicates() async throws {
        _ = try await service.pair(device.startPairing())
        let body = Data(#"{"content":"hello","clientMessageId":"m_1"}"#.utf8)
        let response = try await service.sendCommand(deviceId: device.deviceId, commandId: "cmd_1", method: .post,
                                                     path: "/sessions/s1/messages", body: body)
        #expect(response?.status == 200)
        let key = try #require(try trust.device(device.deviceId)?.directoryKeyBytes)
        #expect(api.registrations == [E2EECommandRegistration(commandId: "cmd_1", deviceId: device.deviceId,
                                                             inputDigest: try E2EEFormats.inputDigest(directoryKey: key, body: body))])
        #expect(device.requests.last?.path == "/api/v2/sessions/s1/messages")

        api.duplicate = true
        let count = device.requests.count
        let duplicate = try await service.sendCommand(deviceId: device.deviceId, commandId: "cmd_1", method: .post,
                                                      path: "/sessions/s1/messages", body: body)
        #expect(duplicate == nil)
        #expect(device.requests.count == count)
    }

    @Test func directoryKeyRefreshesWhenDeviceRotated() async throws {
        _ = try await service.pair(device.startPairing())
        await service.shutdown()
        let rotated = E2EEDirectoryKeyGrant(deviceId: device.deviceId, keyId: "dk_2", epoch: 2,
                                            key: E2EEFormats.base64url(Data(repeating: 9, count: 32)))
        device.directoryKey = rotated
        _ = try await service.channel(for: device.deviceId)
        #expect(try trust.device(device.deviceId)?.directoryKey == rotated)
    }
}

@MainActor @Test func pairingModelChecksTheCodeBeforePairing() async throws {
    let device = E2EETestDevice()
    let service = V2E2EEService(trust: ClientTrustStore(storage: E2EEMemoryStorage(), scope: "model"),
                                provider: LegacyE2EEChannelProvider(tunnel: E2EETestTunnel(device: device)), api: E2EETestAPI(), clientLabel: "iPad")
    let server = URL(string: "https://AA.example.com/")!
    let early = { Date(timeIntervalSince1970: 0) }
    let uri = E2EEFormats.pairingURIPrefix + E2EEFormats.base64url(try JSONEncoder().encode(device.startPairing()))

    let model = E2EEPairingModel(expectedDeviceId: device.deviceId, serverURL: server, now: early)
    model.read("https://example.com")
    #expect(model.payload == nil)
    #expect(model.parseError != nil)
    model.read(uri)
    #expect(model.fingerprint == E2EEFormats.fingerprint(device.identity.publicKey))
    #expect(!model.isForAnotherServer && !model.isForAnotherDevice && !model.isExpired)
    #expect(model.canPair)
    await model.pair(service: service)
    #expect(model.paired?.fingerprint == model.fingerprint)
    #expect(model.error == nil)
    #expect(!model.canPair)

    let other = E2EEPairingModel(expectedDeviceId: "dev_other", serverURL: URL(string: "https://other.example.com")!, now: early)
    other.read(uri)
    #expect(other.isForAnotherDevice && other.isForAnotherServer && !other.canPair)
    let late = E2EEPairingModel(expectedDeviceId: nil, serverURL: nil, now: { .distantFuture })
    late.read(uri)
    #expect(late.isExpired && !late.canPair)
}

@Test func clientTrustStorePersistsAndKeepsPolicy() throws {
    let storage = E2EEMemoryStorage()
    let first = ClientTrustStore(storage: storage, scope: "a")
    let identity = try first.identity()
    let pub = NoiseCrypto.generateKeyPair().publicKey
    let grant = E2EEDirectoryKeyGrant(deviceId: "dev_1", keyId: "dk_1", epoch: 1, key: E2EEFormats.base64url(Data(count: 32)))
    try first.savePairing(E2EEPairingResult(deviceId: "dev_1", clientId: try first.clientId(), devicePub: pub,
                                            grantedAt: "2026-11-16T00:00:00Z", directoryKey: grant))
    try first.markRequired("dev_1")

    // 新实例从同一个存储读回来：身份密钥不变，记录在。
    let second = ClientTrustStore(storage: storage, scope: "a")
    #expect(try second.identity().publicKey == identity.publicKey)
    #expect(try second.device("dev_1")?.devicePubBytes == pub)
    #expect(try second.requiresEncryption("dev_1"))
    // 不同账号互不可见。
    let other = ClientTrustStore(storage: storage, scope: "b")
    #expect(try other.device("dev_1") == nil)
    #expect(try other.identity().publicKey != identity.publicKey)

    // 旧纪元不会覆盖新纪元。
    let newer = E2EEDirectoryKeyGrant(deviceId: "dev_1", keyId: "dk_3", epoch: 3, key: E2EEFormats.base64url(Data(repeating: 1, count: 32)))
    #expect(try second.updateDirectoryKey(newer))
    #expect(!(try second.updateDirectoryKey(grant)))
    #expect(try second.device("dev_1")?.directoryKey == newer)

    // 忘记设备不会撤销「要求加密」。
    try second.forget("dev_1")
    #expect(try second.device("dev_1") == nil)
    #expect(try ClientTrustStore(storage: storage, scope: "a").requiresEncryption("dev_1"))
    #expect(storage.accounts.allSatisfy { $0.hasPrefix("a.") || $0.hasPrefix("b.") })
}
