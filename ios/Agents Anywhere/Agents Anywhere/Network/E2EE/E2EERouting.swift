import Foundation
import Synchronization

/// 加密模式下哪些请求是「内容」，要按设备走安全通道。与 Server 的 `requires_secure_channel` 一致：
/// - `POST /api/v2/sessions`、`POST /api/v2/sessions/create-and-start`（带首条消息）；
/// - `/api/v2/sessions/{id}/` 下除 `meta`、`runtime/state`、`runtime/capabilities` 以外的全部路由；
/// - `/api/v2/runtime-workflows/sessions/{id}/…` (the Agent session behind a session: configuration, operations, close, recover);
/// - `/api/v2/connectors/{id}/fs|shell|terminals|terminals-v2/…` 与 `/api/v2/connectors/fs/…`。
/// 其余（账号、设备、项目、会话目录、归档/已读、模型配置……）是元数据，照常走明文 HTTP。
nonisolated enum E2EEContentTarget: Hashable, Sendable {
    case metadata
    /// 会话内容；设备由会话的 `connectorId` 决定。
    case session(V2SessionID)
    /// 设备上的文件、Shell、终端。
    case device(V2ConnectorID)
    /// 新建会话（请求体里的 `connectorId` 决定设备）。
    case createSession
    /// `/connectors/fs/…`：从路径看不出设备。
    case unknownDevice

    static func classify(method: HTTPMethod, path rawPath: String) -> E2EEContentTarget {
        let path = String(v2APIPath(rawPath).split(separator: "?", maxSplits: 1).first ?? "")
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        // ["api", "v2", resource, …]
        guard parts.count >= 3, parts[0] == "api", parts[1] == "v2" else { return .metadata }
        let rest = Array(parts.dropFirst(2))
        switch rest[0] {
        case "sessions":
            if rest.count == 1 || (rest.count == 2 && rest[1] == "create-and-start") {
                return method == .post ? .createSession : .metadata
            }
            guard rest.count >= 3, !rest[1].isEmpty else { return .metadata }
            let suffix = rest.dropFirst(2).joined(separator: "/")
            if suffix.isEmpty || ["meta", "runtime/state", "runtime/capabilities"].contains(suffix) { return .metadata }
            return .session(rest[1].removingPercentEncoding ?? rest[1])
        case "runtime-workflows":
            guard rest.count >= 4, rest[1] == "sessions", !rest[2].isEmpty else { return .metadata }
            return .session(rest[2].removingPercentEncoding ?? rest[2])
        case "connectors":
            guard rest.count >= 3, !rest[1].isEmpty else { return .metadata }
            if rest[1] == "fs" { return .unknownDevice }
            return ["fs", "shell", "terminals", "terminals-v2"].contains(rest[2])
                ? .device(rest[1].removingPercentEncoding ?? rest[1]) : .metadata
        default:
            return .metadata
        }
    }

    /// `PATCH /sessions/{id}/meta`：加密模式下 Server 拒绝明文标题。
    static func metaSession(path rawPath: String) -> V2SessionID? {
        let path = String(v2APIPath(rawPath).split(separator: "?", maxSplits: 1).first ?? "")
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count == 5, parts[0] == "api", parts[1] == "v2", parts[2] == "sessions", parts[4] == "meta" else { return nil }
        return parts[3].removingPercentEncoding ?? parts[3]
    }
}

/// 所有 API 资源共用的传输：元数据照常走明文；内容请求先问 `V2E2EEService` 这台设备该怎么走——
/// 明文、安全通道，或者「必须先配对」（直接报错，绝不退回明文）。
///
/// 没接上 `V2E2EEService` 之前（例如登录前）全部走明文。
nonisolated final class E2EERoutingHTTPTransport: HTTPTransport, @unchecked Sendable {
    typealias SessionDeviceResolver = @Sendable (V2SessionID) async throws -> V2ConnectorID?

    let plain: any HTTPTransport
    /// 经通道的请求统一超时，超时报 `e2ee_timeout`。
    let channelTimeout: Duration
    private let router = Mutex<Router?>(nil)
    private let sessionDevices = Mutex<[V2SessionID: V2ConnectorID]>([:])
    /// 本机加密上传过的附件密钥（fileId → 密钥），发消息时随请求体经通道交给设备；不落盘。
    private let sealedKeys = Mutex<[String: E2EESealedAttachmentKey]>([:])

    private struct Router {
        let service: V2E2EEService
        let resolve: SessionDeviceResolver
    }

    init(plain: any HTTPTransport, channelTimeout: Duration = .seconds(30)) {
        self.plain = plain
        self.channelTimeout = channelTimeout
    }

    func attach(service: V2E2EEService, resolveSessionDevice: @escaping SessionDeviceResolver) {
        router.withLock { $0 = Router(service: service, resolve: resolveSessionDevice) }
    }

    func detach() {
        router.withLock { $0 = nil }
        sessionDevices.withLock { $0 = [:] }
        sealedKeys.withLock { $0 = [:] }
    }

    /// 已知会话所在的设备（列表、快照里都有），省掉一次 `meta` 读取。
    func remember(sessionId: V2SessionID, deviceId: V2ConnectorID) {
        sessionDevices.withLock { $0[sessionId] = deviceId }
    }

    // MARK: HTTPTransport

    func send<Body: Encodable, Response: Decodable>(_ request: HTTPRequest<Body, Response>) async throws -> Response {
        let target = E2EEContentTarget.classify(method: request.method, path: request.path)
        guard let router = router.withLock({ $0 }) else { return try await plain.send(request) }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let body = try request.body.map { try encoder.encode($0) }
        if target == .metadata {
            try await refuseEncryptedRename(request.method, path: request.path, body: body, router: router)
            return try await plain.send(request)
        }
        guard case let .encrypted(channel) = try await route(target, body: body, router: router) else {
            return try await plain.send(request)
        }
        let channelTransport = E2EEChannelHTTPTransport(channel: channel, timeout: channelTimeout)
        let path = E2EEChannelHTTPTransport.path(request.path, query: request.queryItems)
        let response: E2EETunnelResponse
        if request.method != .get, case .session = target {
            let body = withSealedAttachmentKeys(body)
            response = try await command(request, path: path, body: body, channel: channel, router: router)
        } else if request.method != .get, target == .createSession {
            let body = withSealedAttachmentKeys(body)
            response = try await command(request, path: path, body: body, channel: channel, router: router)
        } else {
            response = try await channelTransport.perform(request.method, path: path, body: body)
        }
        return try channelTransport.decode(Response.self, from: response)
    }

    /// 加密路由下的附件：每个文件一把随机密钥，按 e2ee 1.0 分段加密（AD 的 objectId 是明文 SHA-256），
    /// 带 `x-aa-sealed: segments-v1` 上传密文；密钥留在本机，发消息时经通道随请求体交给设备。
    func upload<Response: Decodable>(_ request: HTTPUploadRequest<Response>) async throws -> Response {
        guard let router = router.withLock({ $0 }),
              case .encrypted = try await route(E2EEContentTarget.classify(method: .post, path: request.path), body: nil, router: router)
        else { return try await plain.upload(request) }
        var sealedFiles: [HTTPUploadFile] = []
        var keys: [E2EESealedAttachmentKey] = []
        for file in request.files {
            let sealed = try E2EEFormats.sealAttachment(file.data)
            // Server 只看到通用的文件名和类型；真实的经通道随密钥交给设备。
            sealedFiles.append(HTTPUploadFile(fieldName: file.fieldName, fileName: E2EEFormats.sealedUploadFileName,
                                              mediaType: E2EEFormats.sealedUploadMediaType, data: sealed.ciphertext))
            var key = sealed.key
            key.name = file.fileName
            key.mimeType = file.mediaType
            keys.append(key)
        }
        var headers = request.headers
        headers[E2EEFormats.sealedUploadHeader] = E2EEFormats.sealedUploadValue
        let raw: JSONValue = try await plain.upload(HTTPUploadRequest<JSONValue>(
            path: request.path, files: sealedFiles, requiresAuth: request.requiresAuth, headers: headers))
        // Server 按上传顺序返回附件。
        guard case let .array(attachments)? = raw["attachments"], attachments.count == keys.count else {
            throw HTTPError.invalidResponse
        }
        var uploaded: [String: E2EESealedAttachmentKey] = [:]
        for (attachment, key) in zip(attachments, keys) {
            guard let fileId = attachment["fileId"]?.stringValue else { throw HTTPError.invalidResponse }
            uploaded[fileId] = key.with(fileId: fileId)
        }
        sealedKeys.withLock { $0.merge(uploaded) { $1 } }
        do {
            return try JSONDecoder().decode(Response.self, from: JSONEncoder().encode(raw))
        } catch let error as DecodingError {
            throw HTTPError.decoding(message: error.v2Description)
        }
    }

    /// 二进制下载（附件内容、文件传输地址）在加密路由下不经 Server 转发明文，现在还不支持；
    /// 设备文件请用 `readDeviceFile`。
    func download(_ url: URL) async throws -> URL {
        if let router = router.withLock({ $0 }),
           case .encrypted = try await route(E2EEContentTarget.classify(method: .get, path: url.path), body: nil, router: router) {
            throw E2EEError(code: E2EEError.unsupported, message: "encrypted downloads are not available yet")
        }
        return try await plain.download(url)
    }

    /// 加密路由下经通道分块读取设备文件（`GET …/fs/read?path&offset&length`，每块 `TunnelFileChunk`，最多 8 MiB），
    /// 写进临时文件。明文路由返回 nil，由调用方照常下载。
    func readDeviceFile(connectorId: V2ConnectorID, root: String, path: String) async throws -> URL? {
        guard let router = router.withLock({ $0 }),
              case let .encrypted(channel) = try await route(.device(connectorId), body: nil, router: router)
        else { return nil }
        let transport = E2EEChannelHTTPTransport(channel: channel, timeout: channelTimeout)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("aa-e2ee-\(UUID().uuidString)")
        FileManager.default.createFile(atPath: file.path, contents: nil)
        do {
            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            var offset = 0
            while true {
                try Task.checkCancellation()
                let query = [URLQueryItem(name: "root", value: root), URLQueryItem(name: "path", value: path),
                             URLQueryItem(name: "offset", value: String(offset)),
                             URLQueryItem(name: "length", value: String(E2EEFormats.fileChunkMaxBytes))]
                let chunk = try transport.decode(E2EETunnelFileChunk.self, from: try await transport.perform(
                    .get, path: E2EEChannelHTTPTransport.path("/connectors/\(connectorId.v2URLPathComponentEncoded)/fs/read", query: query),
                    body: nil))
                guard chunk.encoding == "base64", chunk.offset == offset, let data = Data(base64Encoded: chunk.data),
                      data.count <= E2EEFormats.fileChunkMaxBytes, offset + data.count <= chunk.size,
                      !data.isEmpty || chunk.eof
                else { throw E2EEError(code: E2EEError.protocolError, message: "malformed file chunk") }
                try handle.write(contentsOf: data)
                offset += data.count
                if chunk.eof {
                    guard offset == chunk.size else {
                        throw HTTPError.decoding(message: String(localized: "文件下载不完整，请重新下载。"))
                    }
                    return file
                }
            }
        } catch {
            try? FileManager.default.removeItem(at: file)
            throw error
        }
    }

    /// 发消息的请求体照常在 `attachments` 里引用 `fileId`，再加上这些附件的 `sealedAttachmentKeys`。
    private func withSealedAttachmentKeys(_ body: Data?) -> Data? {
        guard let body, var fields = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
              let attachments = fields["attachments"] as? [[String: Any]] else { return body }
        let known = sealedKeys.withLock { $0 }
        let keys = attachments.compactMap { ($0["fileId"] as? String).flatMap { known[$0] } }
        guard !keys.isEmpty else { return body }
        fields["sealedAttachmentKeys"] = keys.map(\.json)
        return (try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes])) ?? body
    }

    // MARK: 路由

    /// 会话事件流用：这个会话现在走明文还是通道。
    func sessionRoute(_ sessionId: V2SessionID) async throws -> V2E2EEService.ContentRoute {
        guard let router = router.withLock({ $0 }) else { return .plain }
        return try await route(.session(sessionId), body: nil, router: router)
    }

    private func route(_ target: E2EEContentTarget, body: Data?, router: Router) async throws -> V2E2EEService.ContentRoute {
        let deviceId: V2ConnectorID?
        switch target {
        case .metadata:
            return .plain
        case let .session(sessionId):
            deviceId = try await device(forSession: sessionId, router: router)
        case let .device(id):
            deviceId = id
        case .createSession:
            deviceId = body.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["connectorId"] as? String
        case .unknownDevice:
            deviceId = nil
        }
        guard let deviceId else {
            // 看不出属于哪台设备：Server 要求加密时不能发明文。
            if await router.service.mode == .required {
                throw E2EEError(code: E2EEError.required, message: "the device of this request is unknown")
            }
            return .plain
        }
        return try await router.service.route(for: deviceId)
    }

    private func device(forSession sessionId: V2SessionID, router: Router) async throws -> V2ConnectorID? {
        if let known = sessionDevices.withLock({ $0[sessionId] }) { return known }
        guard let deviceId = try await router.resolve(sessionId) else { return nil }
        remember(sessionId: sessionId, deviceId: deviceId)
        return deviceId
    }

    /// 加密模式下改名要写 `displayUser`（用列表密钥密封），Server 还没有这个字段：先明确拒绝，不发明文标题。
    private func refuseEncryptedRename(_ method: HTTPMethod, path: String, body: Data?, router: Router) async throws {
        guard method == .patch, let sessionId = E2EEContentTarget.metaSession(path: path),
              let fields = body.flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
              fields["title"] != nil,
              let deviceId = try await device(forSession: sessionId, router: router),
              try await router.service.requiresEncryption(deviceId)
        else { return }
        throw E2EEError(code: E2EEError.renameUnavailable, message: "renaming is not available in encrypted mode yet")
    }

    /// 写操作：先登记命令（输入摘要按请求体原始字节），再经通道发出；登记和设备收件箱共用同一个命令 ID。
    private func command<Body: Encodable, Response: Decodable>(
        _ request: HTTPRequest<Body, Response>, path: String, body: Data?, channel: any E2EEDeviceChannel, router: Router
    ) async throws -> E2EETunnelResponse {
        let fields = try body.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        let identity = ["clientMessageId", "operationId", "responseId", "commandId"]
            .compactMap { fields?[$0] as? String }.first { !$0.isEmpty }
        let commandId = identity ?? request.headers.first { $0.key.lowercased() == "idempotency-key" }?.value
            ?? "cmd_\(UUID().uuidString.lowercased())"
        var commandBody = body
        if identity == nil {
            var envelope = fields ?? [:]
            envelope["commandId"] = commandId
            commandBody = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys, .withoutEscapingSlashes])
        }
        return try await router.service.sendCommand(
            deviceId: channel.deviceId, commandId: commandId, method: request.method, path: path, body: commandBody, timeout: channelTimeout
        )
    }
}

/// 会话事件流：加密路由下改用通道的 `subscribe`，其余照旧走会话 WebSocket。
nonisolated struct E2EERoutingRealtimeAPI: V2RealtimeAPIProtocol {
    /// 加密路由下不向 Server 要 WS 票据；用这个占位值告诉 `sessionEvents` 走通道。
    static let channelTicket = "e2ee-channel"

    let inner: any V2RealtimeAPIProtocol
    let routing: E2EERoutingHTTPTransport

    func ticket(clientId: String, scope: V2RealtimeScope) async throws -> V2WebSocketTicket {
        if case let .session(sessionId) = scope, case .encrypted = try await routing.sessionRoute(sessionId) {
            return V2WebSocketTicket(ticket: Self.channelTicket, expiresAt: "", serverTime: "")
        }
        return try await inner.ticket(clientId: clientId, scope: scope)
    }

    func recover(sessionId: V2SessionID, after cursor: String) async throws -> V2EventRecoveryResponse {
        try await inner.recover(sessionId: sessionId, after: cursor)
    }

    func sessionEvents(sessionId: V2SessionID, ticket: String) throws -> AsyncThrowingStream<V2SessionEvent, Error> {
        guard ticket == Self.channelTicket else { return try inner.sessionEvents(sessionId: sessionId, ticket: ticket) }
        let routing = routing
        return AsyncThrowingStream(bufferingPolicy: .bufferingOldest(2048)) { continuation in
            let task = Task {
                do {
                    guard case let .encrypted(channel) = try await routing.sessionRoute(sessionId) else {
                        // 路由在拿票和订阅之间变了：结束这条流，让会话按正常流程重连。
                        throw E2EEError(code: E2EEError.closed, message: "route changed")
                    }
                    let events = try await channel.sessionEvents(sessionId: sessionId, afterCursor: nil)
                    // 会话 WS 在注册后先发 `session.subscribed`，会话仓库据此补齐快照之后的事件。
                    // 订阅消息已经发出，这里给出同样的信号；之后的事件经 `/events` 补齐。
                    continuation.yield(Self.subscribed(sessionId))
                    for try await event in events {
                        if event.type == "session.subscribed" { continue }
                        if case .dropped = continuation.yield(event) { throw HTTPError.streamOverflow }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func dashboardSnapshots(ticket: String) throws -> AsyncThrowingStream<V2DashboardSnapshot, Error> {
        try inner.dashboardSnapshots(ticket: ticket)
    }

    static func subscribed(_ sessionId: V2SessionID) -> V2SessionEvent {
        V2SessionEvent(protocolVersion: "1.2", eventId: "e2ee-subscribed-\(UUID().uuidString)", sequence: 0, cursor: "",
                       type: "session.subscribed", sessionId: sessionId,
                       emittedAt: ISO8601DateFormatter().string(from: Date()), payload: .object([:]))
    }
}
