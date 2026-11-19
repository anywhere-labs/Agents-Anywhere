import Foundation

nonisolated protocol E2EEChannelProvider: Sendable {
    func pair(_ payload: E2EEPairingPayload, trust: ClientTrustStore, label: String) async throws -> any E2EEDeviceChannel
    func connect(_ record: E2EEDeviceTrust, trust: ClientTrustStore) async throws -> any E2EEDeviceChannel
}

/// 加密模式（e2ee 1.0）的接入点：Server 的模式、本机信任记录、每台设备的安全通道，
/// 以及「这台设备的内容请求走明文还是走通道」的选择。
///
/// 所有内容请求经 `E2EERoutingHTTPTransport` 在这里选路，会话事件经 `E2EERoutingRealtimeAPI`
/// （见 ios/ARCHITECTURE.md 的 E2EE 一节）。
actor V2E2EEService {
    enum ContentRoute {
        /// Server 没开加密、本机也没记过「要求加密」：照常走明文 HTTP。
        case plain
        case encrypted(any E2EEDeviceChannel)
    }

    nonisolated let trust: ClientTrustStore
    private let provider: (any E2EEChannelProvider)?
    private let api: any V2E2EEAPIProtocol
    private let clientLabel: String
    private var serverMode: E2EEMode = .off
    private var configLoad: Task<Void, Never>?
    private var channels: [String: any E2EEDeviceChannel] = [:]
    private var connecting: [String: Task<any E2EEDeviceChannel, Error>] = [:]

    init(
        trust: ClientTrustStore,
        provider: (any E2EEChannelProvider)? = nil,
        api: any V2E2EEAPIProtocol,
        clientLabel: String
    ) {
        self.trust = trust
        self.provider = provider
        self.api = api
        self.clientLabel = clientLabel
    }

    // MARK: 模式

    /// `GET /api/v2/auth/config` 的 `e2ee`；旧 Server 没有这个字段，按 off。
    func updateServerConfig(_ config: E2EEServerConfig?) {
        serverMode = config?.mode ?? .off
    }

    /// 后台读一次 Server 的模式；选择传输前会等它读完。读失败时保持原来的模式（本机的「要求加密」照样生效）。
    func loadServerConfig(_ load: @escaping @Sendable () async throws -> E2EEServerConfig?) {
        configLoad = Task { [weak self] in
            let config: E2EEServerConfig?
            do { config = try await load() } catch { return }
            await self?.updateServerConfig(config)
        }
    }

    private func settledServerMode() async -> E2EEMode {
        await configLoad?.value
        return serverMode
    }

    var mode: E2EEMode { get async { await settledServerMode() } }

    /// 设备详情页显示用：不改任何记录。
    func encryptionStatus(for deviceId: String) async throws -> E2EEDeviceEncryptionStatus {
        E2EEDeviceEncryptionStatus(serverMode: await settledServerMode(),
                                   locallyRequired: try trust.requiresEncryption(deviceId),
                                   record: try trust.device(deviceId))
    }

    /// 明文请求被 Server 以 409 `e2ee_required` 拒绝：说明 Server 已经切到加密模式。
    @discardableResult
    func noteRejection(_ error: Error, deviceId: String?) -> Bool {
        guard let error = error as? HTTPError, error.statusCode == 409, error.serverCode == E2EEError.required else { return false }
        serverMode = .required
        if let deviceId { try? trust.markRequired(deviceId) }
        return true
    }

    /// 本机记过「要求加密」，或 Server 现在要求加密。前者不会因为 Server 改口而解除。
    func requiresEncryption(_ deviceId: String) async throws -> Bool {
        if await settledServerMode() == .required {
            try trust.markRequired(deviceId)
            return true
        }
        return try trust.requiresEncryption(deviceId)
    }

    // MARK: 按设备选择传输

    /// 一台设备的内容请求该怎么走。要求加密但还没配对时报 `e2ee_not_paired`，绝不退回明文。
    func route(for deviceId: String) async throws -> ContentRoute {
        guard try await requiresEncryption(deviceId) else { return .plain }
        guard try trust.device(deviceId) != nil else {
            throw E2EEError(code: E2EEError.notPaired, message: "device \(deviceId) requires encryption and is not paired")
        }
        return .encrypted(try await channel(for: deviceId))
    }

    /// 现有 API 资源可以直接用的传输：明文时返回 `plain`，加密时返回走通道的实现。
    func transport(for deviceId: String, plain: any HTTPTransport) async throws -> any HTTPTransport {
        switch try await route(for: deviceId) {
        case .plain: plain
        case let .encrypted(channel): E2EEChannelHTTPTransport(channel: channel)
        }
    }

    /// 会话事件：加密时走通道的 `subscribe`，否则返回 nil，由调用方照常打开会话 WS。
    func sessionEvents(deviceId: String, sessionId: V2SessionID, afterCursor: String?) async throws
        -> AsyncThrowingStream<V2SessionEvent, Error>? {
        guard case let .encrypted(channel) = try await route(for: deviceId) else { return nil }
        return try await channel.sessionEvents(sessionId: sessionId, afterCursor: afterCursor)
    }

    /// 加密命令：先 `POST /api/v3/e2ee/commands` 登记（输入摘要按请求体原始字节计算），
    /// 再经通道发出。Server 回 `duplicate: true` 时说明这条命令已经发过，不再重发，返回 nil。
    /// 没有请求体时，摘要按空字节计算，通道里的 `body` 为 null。
    func sendCommand(deviceId: String, commandId: String, method: HTTPMethod, path: String, body: Data?,
                     timeout: Duration = E2EEChannelHTTPTransport.defaultTimeout) async throws -> E2EETunnelResponse? {
        let channel = try await channel(for: deviceId)
        guard let key = try trust.device(deviceId)?.directoryKeyBytes else {
            throw E2EEError(code: E2EEError.notPaired, message: "no directory key for \(deviceId)")
        }
        let digest = try E2EEFormats.inputDigest(directoryKey: key, body: body ?? Data())
        let registration = try await api.registerCommand(.init(commandId: commandId, deviceId: deviceId, inputDigest: digest))
        guard !registration.duplicate else { return nil }
        return try await E2EEChannelHTTPTransport(channel: channel, timeout: timeout).perform(method, path: v2APIPath(path), body: body)
    }

    // MARK: 配对与通道

    /// 扫码配对。成功后授权与列表密钥已经存进 Keychain，通道留着继续用。
    func pair(_ payload: E2EEPairingPayload) async throws -> E2EEDeviceTrust {
        await dropChannel(payload.deviceId)
        guard let provider else { return try await pairMesh(payload) }
        let channel = try await provider.pair(payload, trust: trust, label: clientLabel)
        channels[payload.deviceId] = channel
        if payload.requiresEncryption || serverMode == .required { try trust.markRequired(payload.deviceId) }
        guard let record = try trust.device(payload.deviceId) else {
            throw E2EEError(code: E2EEError.protocolError, message: "pairing was not saved")
        }
        return record
    }

    private func pairMesh(_ payload: E2EEPairingPayload) async throws -> E2EEDeviceTrust {
        let pin = payload.deviceIdentityPub
        if let record = try trust.device(payload.deviceId), record.devicePub != pin {
            throw E2EEError(code: E2EEError.pinMismatch, message: "Connector public key changed")
        }
        let identity = try trust.identity()
        let clientId = try trust.clientId()
        guard let secret = try trust.meshCredential(deviceId: payload.deviceId, pin: pin, create: true) else {
            throw E2EEError(code: E2EEError.notPaired, message: "Content credential unavailable")
        }
        let channel = try await MeshDeviceChannel.open(bootstrap: api.bootstrapContent(), deviceID: payload.deviceId,
                                                       pin: pin, clientID: clientId, secret: secret)
        do {
            let result = try await channel.pair(ContentPairRequest(
                clientIdentityPub: E2EEFormats.base64url(identity.publicKey), clientSecret: secret,
                label: clientLabel, pairingId: payload.pairingId, pairingSecret: payload.psk, platform: "ios"
            ))
            let key = result.directoryKey
            guard result.clientId == clientId, key.deviceId == payload.deviceId else {
                throw E2EEError(code: E2EEError.pinMismatch, message: "Content grant belongs to another identity")
            }
            try trust.savePairing(E2EEPairingResult(
                deviceId: payload.deviceId, clientId: clientId, devicePub: try E2EEFormats.fromBase64url(pin),
                grantedAt: result.grantedAt,
                directoryKey: E2EEDirectoryKeyGrant(deviceId: key.deviceId, keyId: key.keyId, epoch: key.epoch, key: key.key)
            ))
            try trust.markRequired(payload.deviceId)
            guard let record = try trust.device(payload.deviceId) else {
                throw E2EEError(code: E2EEError.protocolError, message: "pairing was not saved")
            }
            channels[payload.deviceId] = channel
            await channel.watchTrust(trust)
            return record
        } catch {
            await channel.close()
            throw error
        }
    }

    /// 已配对设备的通道：有打开的就复用，否则重新申请连接到已验证公钥的隧道。
    func channel(for deviceId: String) async throws -> any E2EEDeviceChannel {
        if let channel = channels[deviceId], await channel.isOpen { return channel }
        if let task = connecting[deviceId] { return try await task.value }
        guard let record = try trust.device(deviceId), record.devicePubBytes != nil else {
            throw E2EEError(code: E2EEError.notPaired, message: "device \(deviceId) is not paired")
        }
        let task = Task<any E2EEDeviceChannel, Error> { [provider, trust, api] in
            if let provider { return try await provider.connect(record, trust: trust) }
            guard let secret = try trust.meshCredential(deviceId: deviceId, pin: record.devicePub) else {
                throw E2EEError(code: E2EEError.notPaired, message: "Pair this device through MeshCall")
            }
            let channel = try await MeshDeviceChannel.open(bootstrap: api.bootstrapContent(), deviceID: deviceId,
                                                           pin: record.devicePub, clientID: trust.clientId(), secret: secret)
            do {
                let response = try await channel.request(.get, path: "/e2ee/v1/directory-key")
                let grant = try JSONDecoder().decode(E2EEDirectoryKeyGrant.self, from: response.body)
                if grant.deviceId == deviceId { _ = try trust.updateDirectoryKey(grant) }
                await channel.watchTrust(trust)
                return channel
            } catch {
                await channel.close()
                throw error
            }
        }
        connecting[deviceId] = task
        defer { connecting[deviceId] = nil }
        let channel = try await task.value
        channels[deviceId] = channel
        await refreshDirectoryKeyIfNeeded(channel, record: record)
        return channel
    }

    /// 忘记本机对这台设备的授权；「要求加密」的记录保留。
    func forget(_ deviceId: String) async throws {
        await dropChannel(deviceId)
        try trust.forget(deviceId)
    }

    func shutdown() async {
        for task in connecting.values { task.cancel() }
        connecting = [:]
        for channel in channels.values { await channel.close() }
        channels = [:]
    }

    private func dropChannel(_ deviceId: String) async {
        if let channel = channels.removeValue(forKey: deviceId) { await channel.close() }
    }

    /// `ready` 里的列表密钥纪元比本机新时（期间有撤销或轮换），经通道取一次新的列表密钥。
    private func refreshDirectoryKeyIfNeeded(_ channel: any E2EEDeviceChannel, record: E2EEDeviceTrust) async {
        guard let ready = await channel.ready, ready.directoryKeyId != record.directoryKey.keyId,
              ready.directoryKeyEpoch >= record.directoryKey.epoch,
              let response = try? await channel.request(.get, path: "/e2ee/v1/directory-key"),
              response.status == 200,
              let grant = try? JSONDecoder().decode(E2EEDirectoryKeyGrant.self, from: response.body)
        else { return }
        _ = try? trust.updateDirectoryKey(grant)
    }
}

nonisolated struct E2EEDeviceEncryptionStatus: Hashable, Sendable {
    let serverMode: E2EEMode
    /// 本机记过「该设备要求加密」。
    let locallyRequired: Bool
    let record: E2EEDeviceTrust?

    var requiresEncryption: Bool { serverMode == .required || locallyRequired }
}
