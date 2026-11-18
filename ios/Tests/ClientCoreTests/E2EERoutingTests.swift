import Foundation
import Testing
@testable import ClientCore

@Test func e2eeContentRoutesMatchTheServerGate() {
    let cases: [(HTTPMethod, String, E2EEContentTarget)] = [
        (.get, "/sessions/s1/snapshot", .session("s1")),
        (.get, "/sessions/s1/timeline?limit=50", .session("s1")),
        (.get, "/sessions/s1/events", .session("s1")),
        (.post, "/sessions/s1/runtime/message", .session("s1")),
        (.post, "/sessions/s1/runtime/notices/n1/respond", .session("s1")),
        (.get, "/sessions/s1/planning", .session("s1")),
        (.post, "/sessions/s1/goal", .session("s1")),
        (.post, "/sessions/s1/attachments", .session("s1")),
        (.get, "/sessions/a%2Fb/snapshot", .session("a/b")),
        (.get, "/api/v2/sessions/s1/snapshot", .session("s1")),
        (.get, "/sessions/s1/meta", .metadata),
        (.patch, "/sessions/s1/meta", .metadata),
        (.get, "/sessions/s1/runtime/state", .metadata),
        (.get, "/sessions/s1/runtime/capabilities", .metadata),
        (.patch, "/sessions/s1", .metadata),
        (.get, "/sessions", .metadata),
        (.get, "/sessions/list", .metadata),
        (.post, "/sessions/read", .metadata),
        (.post, "/sessions/archive", .metadata),
        (.post, "/sessions", .createSession),
        (.post, "/sessions/create-and-start", .createSession),
        (.post, "/runtime-workflows/sessions/s1/recover", .session("s1")),
        (.get, "/api/v2/runtime-workflows/sessions/s1/configuration", .session("s1")),
        (.post, "/runtime-workflows/preparations", .metadata),
        (.post, "/connectors/c1/fs/list", .device("c1")),
        (.post, "/connectors/c1/fs/read?root=%2F", .device("c1")),
        (.get, "/connectors/c1/terminals", .device("c1")),
        (.post, "/connectors/c1/terminals-v2/t1/input", .device("c1")),
        (.post, "/connectors/c1/shell", .device("c1")),
        (.post, "/connectors/fs/read", .unknownDevice),
        (.get, "/connectors/c1/runtimes", .metadata),
        (.get, "/connectors/c1/device-settings", .metadata),
        (.get, "/connectors", .metadata),
        (.get, "/projects", .metadata),
        (.post, "/ws-ticket", .metadata),
        (.post, "/api/v3/e2ee/commands", .metadata),
    ]
    for (method, path, expected) in cases {
        #expect(E2EEContentTarget.classify(method: method, path: path) == expected, "\(method.rawValue) \(path)")
    }
    #expect(E2EEContentTarget.metaSession(path: "/sessions/s1/meta") == "s1")
    #expect(E2EEContentTarget.metaSession(path: "/sessions/s1/snapshot") == nil)
}

/// 路由：哪些走明文、哪些走通道、哪些直接拒绝；以及与测试设备的真实往返。
@MainActor struct E2EERoutingTests {
    let device = E2EETestDevice()
    let api = E2EETestAPI()
    let plain = TestHTTPTransport()
    let service: V2E2EEService
    let routing: E2EERoutingHTTPTransport
    let fixtures: [String: Data]

    init() throws {
        service = V2E2EEService(trust: ClientTrustStore(storage: E2EEMemoryStorage(), scope: "routing"),
                                tunnel: E2EETestTunnel(device: device), api: api, clientLabel: "iPhone")
        routing = E2EERoutingHTTPTransport(plain: plain, channelTimeout: .milliseconds(300))
        let deviceId = device.deviceId
        routing.attach(service: service) { sessionId in sessionId == "unknown" ? nil : deviceId }
        var fixtures: [String: Data] = [:]
        for name in ["snapshot", "rpc", "files", "createdSession", "recovery", "notices", "state", "capabilities"] {
            fixtures[name] = try fixtureData(name)
        }
        self.fixtures = fixtures
        // 设备上的客户端 API：按路径回放与 Server 相同的响应。
        let replies = fixtures
        device.responder = { _, path, _ in
            if path.hasSuffix("/slow") { return nil }
            let route = path.split(separator: "?").first.map(String.init) ?? path
            let name = route.hasSuffix("/snapshot") ? "snapshot" : route.hasSuffix("/fs/list") ? "files"
                : route == "/api/v2/sessions" ? "createdSession" : route.hasSuffix("/events") ? "recovery"
                : route.hasSuffix("/notices") ? "notices" : "rpc"
            return (200, try! JSONSerialization.jsonObject(with: replies[name]!))
        }
    }

    private func required() async { await service.updateServerConfig(E2EEServerConfig(mode: .required, web: nil, preview: nil)) }
    private func pair() async throws { _ = try await service.pair(device.startPairing()) }
    private func code<T>(_ body: () async throws -> T) async -> String? {
        do { _ = try await body(); return nil } catch { return (error as? E2EEError)?.code ?? (error as? HTTPError)?.serverCode }
    }
    private func message(_ id: String) -> V2RuntimeMessageSendRequest {
        V2RuntimeMessageSendRequest(content: "hello", attachments: [], clientMessageId: id, queue: nil)
    }

    @Test func plainUntilAttachedAndWhileModeIsOff() async throws {
        let detached = E2EERoutingHTTPTransport(plain: plain)
        _ = try await V2SessionAPI(transport: detached).snapshot(sessionId: "s1", limit: 10)
        _ = try await V2SessionAPI(transport: routing).snapshot(sessionId: "s1", limit: 10)
        #expect(plain.count("/sessions/s1/snapshot") == 2)
        #expect(device.requests.isEmpty)
    }

    @Test func requiredModeWithoutPairingNeverSendsPlaintext() async throws {
        await required()
        let sessions = V2SessionAPI(transport: routing)
        #expect(await code { try await sessions.snapshot(sessionId: "s1", limit: 10) } == E2EEError.notPaired)
        #expect(await code { try await V2RuntimeAPI(transport: routing).sendMessage(sessionId: "s1", request: message("m0")) } == E2EEError.notPaired)
        #expect(await code { try await V2AttachmentAPI(transport: routing).upload(sessionId: "s1", files: []) } == E2EEError.notPaired)
        #expect(await code {
            try await routing.send(HTTPRequest<EmptyRequestBody, JSONValue>(method: .post, path: "/connectors/\(device.deviceId)/fs/list"))
        } == E2EEError.notPaired)
        // 看不出设备的内容请求：Server 要求加密时也不发明文。
        #expect(await code { try await sessions.snapshot(sessionId: "unknown", limit: 10) } == E2EEError.required)
        // 元数据照常。
        _ = try await sessions.listSessions(archived: false, cursor: nil)
        #expect(plain.calls.map(\.path) == ["/sessions"])
        let failure = V2ClientFailure(E2EEError(code: E2EEError.notPaired))
        #expect(failure.kind == .rejected && failure.code == E2EEError.notPaired && !failure.permitsAutomaticReconnect)
        #expect(V2ClientFailure.isDefiniteWriteRejection(E2EEError(code: E2EEError.notPaired)))
        #expect(!V2ClientFailure.isDefiniteWriteRejection(E2EEError(code: E2EEError.timeout)))
    }

    @Test func pairedDeviceContentGoesThroughTheChannel() async throws {
        try await pair()
        await required()
        let snapshot = try await V2SessionAPI(transport: routing).snapshot(sessionId: "s1", limit: 10)
        #expect(snapshot.session.runtimeId == "rti_work")
        #expect(device.requests.last?.path == "/api/v2/sessions/s1/snapshot?limit=10")
        #expect(device.requests.last?.method == "GET")
        #expect(api.registrations.isEmpty)

        // 写操作先登记命令，再经通道发出。
        _ = try await V2RuntimeAPI(transport: routing).sendMessage(sessionId: "s1", request: message("m1"))
        #expect(device.requests.last?.path == "/api/v2/sessions/s1/runtime/messages")
        #expect((device.requests.last?.body as? [String: Any])?["clientMessageId"] as? String == "m1")
        #expect(api.registrations.last?.commandId == "msg_m1")
        #expect(api.registrations.last?.deviceId == device.deviceId)
        #expect(api.registrations.last?.inputDigest.hasPrefix("hmac-sha256:") == true)

        // Server 说这条命令登记过：不再发给设备。
        api.duplicate = true
        let sent = device.requests.count
        #expect(await code { try await V2RuntimeAPI(transport: routing).sendMessage(sessionId: "s1", request: message("m1")) }
                == E2EEError.commandDuplicate)
        #expect(device.requests.count == sent)
        api.duplicate = false

        // 文件请求与新建会话按设备走通道。
        _ = try await routing.send(HTTPRequest<EmptyRequestBody, JSONValue>(method: .post, path: "/connectors/\(device.deviceId)/fs/list"))
        #expect(device.requests.last?.path == "/api/v2/connectors/\(device.deviceId)/fs/list")
        struct Create: Encodable { let connectorId: String; let title: String }
        _ = try await routing.send(HTTPRequest<Create, JSONValue>(method: .post, path: "/sessions",
                                                                  body: Create(connectorId: device.deviceId, title: "t")))
        #expect(device.requests.last?.path == "/api/v2/sessions")

        // 二进制下载（附件内容、传输地址）还不支持加密，直接拒绝。
        #expect(await code { try await routing.download(URL(string: "https://aa.example.com/api/v2/sessions/s1/attachments/f1/content")!) }
                == E2EEError.unsupported)

        // 改名：加密模式下 Server 拒绝明文标题，Server 还不接受 displayUser，先明确提示。
        let sessions = V2SessionAPI(transport: routing)
        #expect(await code {
            try await sessions.patchSessionMeta(sessionId: "s1", request: V2SessionMetaPatchRequest(title: "x", pinned: nil, archived: nil))
        } == E2EEError.renameUnavailable)
        _ = try? await sessions.patchSessionMeta(sessionId: "s1", request: V2SessionMetaPatchRequest(title: nil, pinned: true, archived: nil))
        #expect(plain.calls.map(\.path) == ["/sessions/s1/meta"])
        #expect(!device.requests.contains { $0.path.contains("/meta") })
    }

    @Test func channelRequestsTimeOut() async throws {
        try await pair()
        let started = ContinuousClock.now
        let error = await code {
            try await routing.send(HTTPRequest<EmptyRequestBody, JSONValue>(method: .get, path: "/sessions/s1/slow"))
        }
        #expect(error == E2EEError.timeout)
        #expect(started.duration(to: .now) < .seconds(5))
        #expect(V2ClientFailure(E2EEError(code: E2EEError.timeout)).permitsAutomaticReconnect)
        // 通道还能继续用。
        #expect(try await V2SessionAPI(transport: routing).snapshot(sessionId: "s1", limit: 10).session.runtimeId == "rti_work")
    }

    @Test func sessionEventsFollowTheRoute() async throws {
        let inner = TestRealtimeAPI()
        let realtime = E2EERoutingRealtimeAPI(inner: inner, routing: routing)
        _ = try await realtime.ticket(clientId: "c", scope: .session("s1"))
        #expect(inner.tickets == 1)

        try await pair()
        await required()
        let ticket = try await realtime.ticket(clientId: "c", scope: .session("s1"))
        #expect(ticket.ticket == E2EERoutingRealtimeAPI.channelTicket)
        #expect(inner.tickets == 1)
        var events = try realtime.sessionEvents(sessionId: "s1", ticket: ticket.ticket).makeAsyncIterator()
        #expect(try await events.next()?.type == "session.subscribed")
        try await eventually { device.subscriptions["s1"] != nil }
        var object = try fixtureObject("event")
        object["type"] = "timeline.item_created"; object["sequence"] = 11; object["cursor"] = "seq:11"; object["sessionId"] = "s1"
        try device.emit(sessionId: "s1", event: object)
        #expect(try await events.next()?.cursor == "seq:11")
        // 恢复（`/events`）同样走通道。
        _ = try await realtime.recover(sessionId: "s1", after: "seq:11")
        #expect(inner.recoveries == ["seq:11"])
    }

    @Test func encryptedAttachmentUploadAndKeysTravelWithTheMessage() async throws {
        try await pair()
        await required()
        let recorder = SealedUploadRecorder()
        let routing = E2EERoutingHTTPTransport(plain: recorder)
        let deviceId = device.deviceId
        routing.attach(service: service) { _ in deviceId }

        let small = Data("hello".utf8)
        let large = Data((0..<(E2EEFormats.sealedSegmentBytes + 100)).map { UInt8($0 % 251) })
        let uploaded = try await V2AttachmentAPI(transport: routing).upload(sessionId: "s1", files: [
            HTTPUploadFile(fieldName: "files", fileName: "a.txt", mediaType: "text/plain", data: small),
            HTTPUploadFile(fieldName: "files", fileName: "b.bin", mediaType: "application/octet-stream", data: large),
        ])
        #expect(uploaded.attachments.map(\.fileId) == ["file_0", "file_1"])
        let request = try #require(recorder.uploads.first)
        #expect(request.headers["x-aa-sealed"] == "segments-v1")
        // Server 看不到真实的文件名和类型。
        #expect(request.files.allSatisfy { $0.fileName == "attachment.bin" && $0.mediaType == "application/octet-stream" })
        // Server 只看到密文：两段（64 KiB + 16）+（100 + 16）。
        #expect(request.files[0].data != small && request.files[0].data.count == small.count + 16)
        #expect(request.files[1].data.count == large.count + 32)

        _ = try await V2RuntimeAPI(transport: routing).sendMessage(sessionId: "s1", request: V2RuntimeMessageSendRequest(
            content: "see files", attachments: [.init(fileId: "file_0"), .init(fileId: "file_1")], clientMessageId: "m9", queue: nil))
        let body = try #require(device.requests.last?.body as? [String: Any])
        #expect((body["attachments"] as? [[String: Any]])?.compactMap { $0["fileId"] as? String } == ["file_0", "file_1"])
        let keys = try JSONDecoder().decode([E2EESealedAttachmentKey].self,
                                            from: JSONSerialization.data(withJSONObject: body["sealedAttachmentKeys"] as Any))
        #expect(keys.map(\.fileId) == ["file_0", "file_1"])
        #expect(keys[1].size == large.count)
        #expect(keys.map(\.name) == ["a.txt", "b.bin"])
        #expect(keys.map(\.mimeType) == ["text/plain", "application/octet-stream"])
        // 设备拿到密钥后能还原明文；Server 上的密文换了密钥或被篡改都解不开。
        #expect(try E2EEFormats.openAttachment(request.files[0].data, key: keys[0]) == small)
        #expect(try E2EEFormats.openAttachment(request.files[1].data, key: keys[1]) == large)
        #expect(throws: E2EEError.self) { try E2EEFormats.openAttachment(request.files[1].data, key: keys[0]) }
        #expect(throws: E2EEError.self) { try E2EEFormats.openAttachment(request.files[1].data.dropLast(16), key: keys[1]) }
        // 摘要按带上密钥后实际发出的请求体计算。
        #expect(api.registrations.last?.commandId == "msg_m9")
    }

    @Test func deviceFilesDownloadInChunksThroughTheChannel() async throws {
        let content = Data((0..<2500).map { UInt8($0 % 256) })
        device.responder = { _, path, _ in
            guard path.contains("/fs/read?") else { return (200, ["ok": true]) }
            let query = URLComponents(string: path)!.queryItems!
            let offset = Int(query.first { $0.name == "offset" }!.value!)!
            #expect(query.first { $0.name == "path" }?.value == "src/main.swift")
            #expect(Int(query.first { $0.name == "length" }!.value!)! == E2EEFormats.fileChunkMaxBytes)
            let end = min(offset + 1000, content.count)
            return (200, ["encoding": "base64", "data": content[offset..<end].base64EncodedString(), "offset": offset,
                          "size": content.count, "eof": end == content.count])
        }
        // 明文路由照常走 Server 的传输地址。
        #expect(try await routing.readDeviceFile(connectorId: device.deviceId, root: "/w", path: "src/main.swift") == nil)

        try await pair()
        await required()
        let file = try await V2ConnectorAPI(transport: routing).downloadWorkspaceFile(connectorId: device.deviceId, root: "/w", path: "src/main.swift")
        defer { try? FileManager.default.removeItem(at: file.url.deletingLastPathComponent()) }
        #expect(try Data(contentsOf: file.url) == content)
        #expect(file.url.lastPathComponent == "main.swift")
        #expect(device.requests.filter { $0.path.contains("/fs/read?") }.count == 3)
        #expect(!plain.calls.contains { $0.path.contains("/fs/") })
    }

    @Test func repositoryLoadsAndSendsThroughTheChannel() async throws {
        try await pair()
        await required()
        let runtime = V2RuntimeAPI(transport: routing)
        let repository = V2SessionRepository(
            scope: V2ClientScope(serverURL: URL(string: "https://aa.example.com")!, accountID: "account"),
            detail: V2SessionDetailService(sessionAPI: V2SessionAPI(transport: routing), runtimeAPI: runtime,
                                           realtimeAPI: E2EERoutingRealtimeAPI(inner: TestRealtimeAPI(), routing: routing)),
            interactions: V2RuntimeInteractionService(runtimeAPI: runtime),
            sleep: { _ in try await Task.sleep(for: .milliseconds(1)) }
        )
        let data = try await repository.load(sessionId: "session")
        #expect(data.session.runtimeId == "rti_work")
        #expect(device.requests.contains { $0.path.hasPrefix("/api/v2/sessions/session/snapshot") })
        // 内容一个字节都没有经明文 HTTP。
        #expect(!plain.calls.contains { E2EEContentTarget.classify(method: $0.method, path: $0.path) != .metadata })
        repository.reset()
    }
}

/// 记录上传请求的明文传输：按上传顺序分配 fileId，其余请求交给 `TestHTTPTransport`。
@MainActor final class SealedUploadRecorder: HTTPTransport {
    let base = TestHTTPTransport()
    private(set) var uploads: [(headers: [String: String], files: [HTTPUploadFile])] = []

    func send<Body: Encodable, Response: Decodable>(_ request: HTTPRequest<Body, Response>) async throws -> Response {
        try await base.send(request)
    }

    func download(_ url: URL) async throws -> URL { try await base.download(url) }

    func upload<Response: Decodable>(_ request: HTTPUploadRequest<Response>) async throws -> Response {
        uploads.append((request.headers, request.files))
        var object = try JSONSerialization.jsonObject(with: fixtureData("upload")) as! [String: Any]
        let template = (object["attachments"] as! [[String: Any]])[0]
        object["attachments"] = request.files.enumerated().map { index, file in
            var attachment = template
            attachment["fileId"] = "file_\(index)"; attachment["name"] = file.fileName; attachment["size"] = file.data.count
            return attachment
        }
        return try JSONDecoder().decode(Response.self, from: JSONSerialization.data(withJSONObject: object))
    }
}
