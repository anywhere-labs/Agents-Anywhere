// One MeshCall tunnel per device for `aa.v3.Sessions`, `aa.v3.Device` and `aa.v3.Terminals`.
//
// Security invariants (docs/v3/e2ee-admission-proposal.md, contracts/aa-v3/1.0/pairing.schema.json):
//   1. Single-device operations always go over a tunnel (normal or end to end), never through the control plane.
//   2. A device pinned locally (`require_e2ee`) or hinted `encrypted` is only reached end to end, with the key from
//      its QR code: a plain `mtun_` credential for it is refused (`e2e_required_locally`), an unpaired one is
//      `e2e_not_paired`, and a failed handshake is `e2e_handshake_failed` — never a fallback to plaintext.
//   3. First pairing writes the trust record before the IKpsk2 tunnel opens and rolls it back if pairing fails;
//      later connections use IK with this installation's Keychain key.

import Foundation

let sessionsService = "aa.v3.Sessions"
let deviceService = "aa.v3.Device"
let terminalsService = "aa.v3.Terminals"

/// Issues tunnels; `ControlPlaneClient` in the app, a fake in tests.
public protocol TunnelIssuer: Sendable {
    func openTunnel(deviceID: String, e2eKey: String?) async throws -> OpenTunnelResponse
}

extension ControlPlaneClient: TunnelIssuer {}

public struct DeviceTunnelInfo: Sendable, Hashable {
    public var deviceID: String
    public var encrypted: Bool
    public var tunnelID: String
}

public actor DeviceTunnelPool {
    struct Pooled {
        var mesh: Mesh
        var info: DeviceTunnelInfo
    }

    private let issuer: any TunnelIssuer
    private let trust: TrustStore
    private let identity: ClientIdentityStore
    private var pool: [String: Pooled] = [:]
    private var opening: [String: Task<Pooled, Error>] = [:]
    private var modeHints: [String: String] = [:]

    public init(issuer: any TunnelIssuer, trust: TrustStore, identity: ClientIdentityStore) {
        self.issuer = issuer
        self.trust = trust
        self.identity = identity
    }

    /// Keep the server's mode hints (they can only make the client stricter, never looser).
    public func updateDevices(_ devices: [DeviceRecord]) {
        for device in devices { modeHints[device.id] = device.modeHint }
    }

    public func requiresE2EE(_ deviceID: String) -> Bool {
        trust.record(for: deviceID)?.requireE2EE == true || modeHints[deviceID] == "encrypted"
    }

    public func tunnelInfo(_ deviceID: String) -> DeviceTunnelInfo? { pool[deviceID]?.info }

    // MARK: Tunnels

    func tunnel(_ deviceID: String, refresh: Bool = false) async throws -> Pooled {
        if !refresh, let pooled = pool[deviceID] { return pooled }
        if let task = opening[deviceID] { return try await task.value }
        let stale = refresh ? pool.removeValue(forKey: deviceID) : nil
        let task = Task { () throws -> Pooled in
            if let stale { await stale.mesh.close() }
            return try await self.open(deviceID)
        }
        opening[deviceID] = task
        defer { opening[deviceID] = nil }
        let pooled = try await task.value
        pool[deviceID] = pooled
        return pooled
    }

    private func open(_ deviceID: String) async throws -> Pooled {
        let record = trust.record(for: deviceID)
        let requireE2EE = record?.requireE2EE == true || modeHints[deviceID] == "encrypted"
        if requireE2EE, record == nil || record?.confirmed == false {
            throw PairingError(.e2eNotPaired, "这台加密设备还没有与本机配对，请扫描设备上的配对二维码")
        }
        let opened = try await issuer.openTunnel(deviceID: deviceID, e2eKey: record?.devicePub)
        if requireE2EE, let record {
            guard opened.isEndToEnd else {
                throw PairingError(.e2eRequiredLocally, "服务端为加密设备返回了明文隧道，已拒绝连接")
            }
            let grant = TunnelGrant(
                routerURL: webSocketURL(opened.routerURL), credential: opened.credential, instanceID: deviceID,
                tunnelID: opened.tunnelID, e2eKey: record.devicePub)
            let mesh = try Mesh(tunnel: grant, identity: E2EIdentity(privateKey: try identity.privateKey(), instanceID: deviceID))
            do {
                try await mesh.connect()
            } catch {
                await mesh.close()
                throw PairingError(.e2eHandshakeFailed, "端到端握手失败：\(error.localizedDescription)")
            }
            return Pooled(mesh: mesh, info: DeviceTunnelInfo(deviceID: deviceID, encrypted: true, tunnelID: opened.tunnelID))
        }
        if opened.isEndToEnd {
            // The server says end to end but this client holds no pinned key: it must not trust the server's.
            throw PairingError(.e2eNotPaired, "这台设备要求端到端加密，请先扫描设备上的配对二维码")
        }
        let grant = TunnelGrant(routerURL: webSocketURL(opened.routerURL), credential: opened.credential, instanceID: deviceID, tunnelID: opened.tunnelID)
        let mesh = try Mesh(tunnel: grant)
        return Pooled(mesh: mesh, info: DeviceTunnelInfo(deviceID: deviceID, encrypted: false, tunnelID: opened.tunnelID))
    }

    /// First pairing with an encrypted device from its `aa-pair://v1/…` QR code (`Noise_IKpsk2`, then IK).
    /// Waits up to two minutes: the device may ask its owner to confirm.
    public func pair(uri: String, deviceNameHint: String? = nil) async throws -> DeviceStatus {
        let payload = try PairingPayload.parse(uri)
        let deviceID = payload.instanceID
        let previous = trust.record(for: deviceID)
        if let previous, previous.devicePub != payload.devicePub {
            throw PairingError(
                .devicePubMismatch, "二维码里的设备公钥与本机记住的不一致。若设备确实重装过，请先在设置里移除这台设备的信任记录，再重新配对")
        }
        // Lock trust before contacting anyone, so nothing in between talks plaintext to this device.
        var record = DeviceTrustRecord(payload: payload, deviceNameHint: deviceNameHint)
        try trust.save(record)
        var mesh: Mesh?
        do {
            let opened = try await issuer.openTunnel(deviceID: deviceID, e2eKey: payload.devicePub)
            guard opened.isEndToEnd else {
                throw PairingError(.e2eRequiredLocally, "服务端没有返回端到端隧道，已拒绝配对")
            }
            if let old = pool.removeValue(forKey: deviceID) { await old.mesh.close() }
            let grant = TunnelGrant(
                routerURL: webSocketURL(opened.routerURL), credential: opened.credential, instanceID: deviceID,
                tunnelID: opened.tunnelID, e2eKey: payload.devicePub)
            let identity = E2EIdentity(
                privateKey: try identity.privateKey(), instanceID: deviceID, pairing: E2EPairing(id: payload.pairingID, psk: payload.psk))
            let paired = try Mesh(tunnel: grant, identity: identity)
            mesh = paired
            let status = try await paired.unary(deviceService, "status", Empty(), as: DeviceStatus.self, options: CallOptions(timeout: .seconds(130)))
            record.confirmed = true
            record.deviceNameHint = deviceNameHint ?? status.deviceName
            try trust.save(record)
            pool[deviceID] = Pooled(mesh: paired, info: DeviceTunnelInfo(deviceID: deviceID, encrypted: true, tunnelID: opened.tunnelID))
            return status
        } catch {
            await mesh?.close()
            if let previous { try? trust.save(previous) } else { try? trust.remove(deviceID) }
            if let error = error as? PairingError { throw error }
            let text = (error as? MeshCallError)?.message ?? error.localizedDescription
            if text.localizedCaseInsensitiveContains("expired") { throw PairingError(.pairingExpired, text) }
            if text.localizedCaseInsensitiveContains("used") || text.localizedCaseInsensitiveContains("consumed") {
                throw PairingError(.pairingUsed, text)
            }
            throw PairingError(.e2eHandshakeFailed, "配对握手失败：\(text)")
        }
    }

    /// Forget a device's pin (the user asked to re-pair after a reinstall).
    public func forget(_ deviceID: String) async throws {
        try trust.remove(deviceID)
        await close(deviceID)
    }

    public func close(_ deviceID: String) async {
        if let pooled = pool.removeValue(forKey: deviceID) { await pooled.mesh.close() }
    }

    public func closeAll() async {
        let all = pool.values
        pool = [:]
        for pooled in all { await pooled.mesh.close() }
    }

    /// Foreground check: drop sockets the system cut while suspended so watchers re-subscribe at once.
    public func checkConnections() async {
        for pooled in pool.values { await pooled.mesh.checkConnection() }
    }

    // MARK: Calls

    func unary<Request: Encodable & Sendable, Response: Decodable & Sendable>(
        _ deviceID: String, _ service: String, _ method: String, _ request: Request, as: Response.Type = Response.self,
        options: CallOptions = CallOptions(timeout: .seconds(30))
    ) async throws -> Response {
        do {
            return try await tunnel(deviceID).mesh.unary(service, method, request, as: Response.self, options: options)
        } catch where isUnauthenticated(error) {
            return try await tunnel(deviceID, refresh: true).mesh.unary(service, method, request, as: Response.self, options: options)
        }
    }

    nonisolated func stream<Request: Encodable & Sendable, Item: Decodable & Sendable>(
        _ deviceID: String, _ service: String, _ method: String, _ request: Request, of: Item.Type
    ) -> AsyncThrowingStream<Item, Error> {
        relay { refresh in
            try await self.tunnel(deviceID, refresh: refresh).mesh.serverStream(service, method, request, of: Item.self)
        }
    }

    // MARK: aa.v3.Sessions

    public func listSessions(_ deviceID: String, limit: Int? = nil) async throws -> SessionList {
        try await unary(deviceID, sessionsService, "list", ["limit": limit.map { JSONValue.int(Int64($0)) } ?? .null])
    }

    public nonisolated func watchList(_ deviceID: String) -> AsyncThrowingStream<SessionListEvent, Error> {
        stream(deviceID, sessionsService, "watch_list", Empty(), of: SessionListEvent.self)
    }

    public func createSession(_ deviceID: String, agent: String, cwd: String?, title: String? = nil, config: [String: String]? = nil) async throws -> Session {
        var request: [String: JSONValue] = ["agent": .string(agent)]
        if let cwd, !cwd.isEmpty { request["cwd"] = .string(cwd) }
        if let title, !title.isEmpty { request["title"] = .string(title) }
        if let config, !config.isEmpty { request["config"] = .object(config.mapValues { .string($0) }) }
        // Starting the agent process can take a while.
        return try await unary(deviceID, sessionsService, "create", JSONValue.object(request), options: CallOptions(timeout: .seconds(120)))
    }

    public func renameSession(_ deviceID: String, sessionID: String, title: String) async throws -> Session {
        try await unary(deviceID, sessionsService, "rename", ["id": sessionID, "title": title])
    }

    public func deleteSession(_ deviceID: String, sessionID: String) async throws {
        let _: OkResponse = try await unary(deviceID, sessionsService, "delete", ["id": sessionID])
    }

    /// The raw events (for the WebView) with their typed form (for native controls).
    public nonisolated func watch(_ deviceID: String, sessionID: String) -> AsyncThrowingStream<WatchUpdate, Error> {
        let raw = stream(deviceID, sessionsService, "watch", ["id": sessionID], of: JSONValue.self)
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await value in raw {
                        continuation.yield(WatchUpdate(raw: value, event: (try? WatchEvent(json: value)) ?? .unknown("invalid")))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    public func listMessages(_ deviceID: String, sessionID: String, beforeSeq: Int?, limit: Int = 50) async throws -> ListMessagesResponse {
        var request: [String: JSONValue] = ["id": .string(sessionID), "limit": .int(Int64(limit))]
        if let beforeSeq { request["before_seq"] = .int(Int64(beforeSeq)) }
        return try await unary(deviceID, sessionsService, "list_messages", JSONValue.object(request))
    }

    public func send(
        _ deviceID: String, sessionID: String, clientMsgID: String, content: String, delivery: Delivery = .auto,
        attachments: [AttachmentPart] = []
    ) async throws -> SendResponse {
        var request: [String: JSONValue] = [
            "id": .string(sessionID), "client_msg_id": .string(clientMsgID), "content": .string(content),
            "delivery": .string(delivery.rawValue),
        ]
        if !attachments.isEmpty {
            request["attachments"] = .array(attachments.map {
                ["path": .string($0.path), "name": .string($0.name), "mime": .string($0.mime), "size": .int(Int64($0.size))]
            })
        }
        // client_msg_id makes the send idempotent on the device, so the retry policy may resend it.
        return try await unary(
            deviceID, sessionsService, "send", JSONValue.object(request),
            options: CallOptions(timeout: .seconds(30), idempotencyKey: clientMsgID))
    }

    public func answer(_ deviceID: String, sessionID: String, requestID: String, optionID: String) async throws {
        let _: OkResponse = try await unary(deviceID, sessionsService, "answer", ["id": sessionID, "request_id": requestID, "option_id": optionID])
    }

    public func stop(_ deviceID: String, sessionID: String) async throws {
        let _: OkResponse = try await unary(deviceID, sessionsService, "stop", ["id": sessionID])
    }

    public func setConfig(_ deviceID: String, sessionID: String, configID: String, value: String) async throws -> Session {
        try await unary(deviceID, sessionsService, "set_config", ["id": sessionID, "config_id": configID, "value": value])
    }

    public func steerQueued(_ deviceID: String, sessionID: String, clientMsgID: String) async throws {
        let _: JSONValue = try await unary(deviceID, sessionsService, "steer_queued", ["id": sessionID, "client_msg_id": clientMsgID])
    }

    public func unqueue(_ deviceID: String, sessionID: String, clientMsgID: String) async throws {
        let _: OkResponse = try await unary(deviceID, sessionsService, "unqueue", ["id": sessionID, "client_msg_id": clientMsgID])
    }

    // MARK: aa.v3.Device

    public func status(_ deviceID: String) async throws -> DeviceStatus {
        try await unary(deviceID, deviceService, "status", Empty())
    }

    public func listDirs(_ deviceID: String, path: String?) async throws -> ListDirsResult {
        try await unary(deviceID, deviceService, "list_dirs", path.map { ["path": $0] } ?? [:])
    }

    public func readFile(_ deviceID: String, path: String, maxBytes: Int? = nil) async throws -> ReadFileResult {
        var request: [String: JSONValue] = ["path": .string(path)]
        if let maxBytes { request["max_bytes"] = .int(Int64(maxBytes)) }
        return try await unary(deviceID, deviceService, "read_file", JSONValue.object(request))
    }

    /// Up to `AA_CONTROL_DRIVE_RPC_MAX_BYTES` (8 MiB by default): bytes travel in the RPC.
    public static let maxRPCAttachmentBytes = 8 * 1024 * 1024

    public func saveAttachment(_ deviceID: String, name: String, data: Data, mime: String?) async throws -> SavedAttachment {
        var request: [String: JSONValue] = ["name": .string(name), "base64": .string(data.base64EncodedString())]
        if let mime { request["mime"] = .string(mime) }
        return try await unary(deviceID, deviceService, "save_attachment", JSONValue.object(request), options: CallOptions(timeout: .seconds(120)))
    }

    public func listPairedClients(_ deviceID: String) async throws -> [PairedClientEntry] {
        struct Response: Decodable, Sendable { var clients: [PairedClientEntry] }
        return try await unary(deviceID, deviceService, "list_paired_clients", Empty(), as: Response.self).clients
    }

    // MARK: aa.v3.Terminals

    public func listTerminals(_ deviceID: String) async throws -> [TerminalInfo] {
        try await unary(deviceID, terminalsService, "list", Empty(), as: TerminalList.self).terminals
    }

    public func createTerminal(_ deviceID: String, cwd: String? = nil, cols: Int = 80, rows: Int = 24) async throws -> TerminalInfo {
        var request: [String: JSONValue] = ["cols": .int(Int64(cols)), "rows": .int(Int64(rows))]
        if let cwd { request["cwd"] = .string(cwd) }
        return try await unary(deviceID, terminalsService, "create", JSONValue.object(request))
    }

    public func closeTerminal(_ deviceID: String, terminalID: String) async throws {
        let _: OkResponse = try await unary(deviceID, terminalsService, "close", ["id": terminalID])
    }

    /// Attach to a terminal: input frames (`{type: input, data}`, `{type: resize, cols, rows}`, …) go in, output
    /// frames (`output`, `exit`, and `snapshot` / `control` / … on Connectors that send them) come out unchanged.
    public func attachTerminal(_ deviceID: String, terminalID: String, mode: String? = nil) async throws -> DuplexCall<JSONValue, JSONValue> {
        var request: [String: JSONValue] = ["id": .string(terminalID)]
        if let mode { request["mode"] = .string(mode) }
        do {
            return try await tunnel(deviceID).mesh.duplex(terminalsService, "attach", JSONValue.object(request), input: JSONValue.self, output: JSONValue.self)
        } catch where isUnauthenticated(error) {
            return try await tunnel(deviceID, refresh: true).mesh.duplex(
                terminalsService, "attach", JSONValue.object(request), input: JSONValue.self, output: JSONValue.self)
        }
    }
}
