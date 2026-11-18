import Foundation
import Testing
@testable import ClientCore

/// Port preview 1.0 (PV-5): session port facts from the socket and the
/// `/api/v3/previews` resources behind the card above the composer.
@Suite @MainActor struct PortPreviewTests {
    private func port(_ number: Int, session: String? = "session", url: String? = nil) -> [String: Any] {
        var object: [String: Any] = ["port": number, "pid": 4242, "processName": "node"]
        if let session { object["sessionId"] = session }
        if let url { object["url"] = url }
        return object
    }

    private func listening(_ ports: [[String: Any]], seq: Int = 99) throws -> V2SessionEvent {
        try event(V3SessionPorts.listening, seq: seq, payload: ["deviceId": "device", "ports": ports])
    }

    private func closed(_ number: Int, seq: Int = 99) throws -> V2SessionEvent {
        try event(V3SessionPorts.closed, seq: seq, payload: ["deviceId": "device", "port": number])
    }

    private func previewObject(id: String = "preview-1", port: Int = 5173, state: String = "open",
                               url: String? = "https://abc.preview.example", plaintext: Bool = false) -> [String: Any] {
        ["previewId": id, "slug": "abc", "deviceId": "device", "sessionId": "session", "port": port,
         "visibility": "private", "state": state, "closeReason": NSNull(), "url": url ?? NSNull(),
         "expiresAt": "2026-11-17T00:00:00Z", "plaintextNotice": plaintext]
    }

    private func json(_ object: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: object) }

    private func serverError(_ status: Int, code: String? = nil) -> HTTPError {
        .server(statusCode: status, message: "failed", detail: code.map { .object(["code": .string($0), "message": .string("failed")]) })
    }

    // MARK: Capability

    @Test func theCardNeedsTheDevicesAvailablePortPreviewCapability() throws {
        func snapshot(_ extra: [String: Any]?) throws -> V2RuntimeCapabilitySnapshot {
            var capabilities: [[String: Any]] = [[
                "capabilityId": "session.interrupt", "version": "1", "scope": "session", "runtime": "claude", "sessionId": "session",
                "supported": true, "available": true, "allowed": true, "unavailableReason": NSNull(), "parameters": [:],
            ]]
            if let extra {
                capabilities.append([
                    "capabilityId": "session.port_preview", "version": "1", "scope": "session", "runtime": "claude", "sessionId": "session",
                    "supported": true, "available": true, "allowed": false, "unavailableReason": NSNull(), "parameters": [:],
                ].merging(extra) { _, new in new })
            }
            return try JSONDecoder().decode(V2RuntimeCapabilitySnapshot.self, from: json(["revision": 1, "capabilities": capabilities]))
        }
        #expect(try snapshot([:]).portPreviewAvailable)
        #expect(try !snapshot(["available": false, "unavailableReason": "preview_unavailable"]).portPreviewAvailable)
        #expect(try !snapshot(nil).portPreviewAvailable)
    }

    // MARK: Event reduction

    @Test func listeningReplacesTheSessionsPortsAndSkipsOtherSessions() throws {
        let first = try listening([port(5173), port(3000, session: "other"), port(8080, session: nil), ["port": "bad"], port(0)])
        var ports = V3SessionPorts.apply([:], type: first.type, payload: first.payload, sessionId: "session")
        #expect(Array(ports.keys) == [5173])
        #expect(ports[5173]?.processName == "node" && ports[5173]?.pid == 4242)
        #expect(ports[5173]?.localURL == "http://localhost:5173")

        // The device sends its whole current list: a missing port is gone.
        let second = try listening([port(4000, url: "http://127.0.0.1:4000/app"), port(5174)])
        ports = V3SessionPorts.apply(ports, type: second.type, payload: second.payload, sessionId: "session")
        #expect(Set(ports.keys) == [4000, 5174])
        #expect(ports[4000]?.localURL == "http://127.0.0.1:4000/app")

        let empty = try listening([])
        #expect(V3SessionPorts.apply(ports, type: empty.type, payload: empty.payload, sessionId: "session").isEmpty)
    }

    @Test func closedRemovesOnePortAndUnrelatedEventsChangeNothing() throws {
        let all = try listening([port(3000), port(4000), port(5000), port(6000)])
        var ports = V3SessionPorts.apply([:], type: all.type, payload: all.payload, sessionId: "session")
        #expect(V3SessionPorts.visible(ports).map(\.port) == [3000, 4000, 5000], "The card shows at most three, lowest first")
        let close = try closed(4000)
        ports = V3SessionPorts.apply(ports, type: close.type, payload: close.payload, sessionId: "session")
        #expect(Set(ports.keys) == [3000, 5000, 6000])
        let unknown = try closed(9999)
        #expect(V3SessionPorts.apply(ports, type: unknown.type, payload: unknown.payload, sessionId: "session") == ports)
        #expect(V3SessionPorts.apply(ports, type: "timeline.item_created", payload: .object([:]), sessionId: "session") == ports)
        #expect(V3SessionPorts.isPortEvent("port.listening") && V3SessionPorts.isPortEvent("port.closed"))
        #expect(!V3SessionPorts.isPortEvent("runtime.state.updated"))
    }

    @Test func portEventsNeverAdvanceTheCursorOrTriggerRecovery() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI()
        let repo = repository(transport: http, realtime: realtime); defer { repo.reset() }
        let model = repo.session(id: "session"); let connection = Task { await model.connect() }
        defer { connection.cancel() }
        try await eventually { model.connection == .connected }
        let recoveries = realtime.recoveries
        let snapshots = http.count("snapshot")
        // A far-ahead sequence would be a gap for timeline data; port facts are not.
        realtime.yield(try listening([port(5173), port(3000, session: "other")], seq: 99))
        try await eventually { model.listeningPorts.keys.sorted() == [5173] }
        realtime.yield(try closed(5173, seq: 120))
        try await eventually { model.listeningPorts.isEmpty }
        realtime.yield(try listening([port(8080)], seq: 130))
        try await eventually { model.listeningPorts.keys.sorted() == [8080] }
        #expect(realtime.recoveries == recoveries && http.count("snapshot") == snapshots)
        #expect(repo.cached(sessionId: "session")?.cursor == "seq:10")

        // Even inside a recovery page they never acknowledge a cursor.
        var projection = V2SessionProjection(snapshot: try snapshot(), maximumItems: 100)
        let before = projection.data.cursor
        try projection.apply(try listening([port(5173)], seq: 50))
        try projection.apply(try closed(5173, seq: 51))
        #expect(projection.data.cursor == before && projection.data.lastExtensionEvent == nil)
    }

    @Test func deviceGoingOfflineClearsThePorts() async throws {
        let http = TestHTTPTransport(); let realtime = TestRealtimeAPI()
        let repo = repository(transport: http, realtime: realtime); defer { repo.reset() }
        let model = repo.session(id: "session"); let connection = Task { await model.connect() }
        defer { connection.cancel() }
        try await eventually { model.connection == .connected }
        #expect(model.metadata?.connectorStatus == .online)
        realtime.yield(try listening([port(5173)]))
        try await eventually { !model.listeningPorts.isEmpty }

        var meta = try fixtureObject("snapshot")["session"] as! [String: Any]
        meta["connectorStatus"] = "offline"; meta["updatedSeq"] = 99
        repo.applyMetadata([try decode(meta)])
        try await eventually { model.metadata?.connectorStatus == .offline }
        #expect(model.listeningPorts.isEmpty)
    }

    // MARK: API

    @Test func previewRoutesUseTheV3NamespaceAndTheContractBodies() async throws {
        #expect(v2APIPath("/api/v3/previews") == "/api/v3/previews")
        #expect(v2APIPath("/api/v3/previews/p%2F1/ticket") == "/api/v3/previews/p%2F1/ticket")
        #expect(v2APIPath("/previews") == "/api/v2/previews")
        #expect(v2APIPath("/api/v30") == "/api/v2/api/v30")

        let http = TestHTTPTransport()
        http.respond = { call in
            switch (call.method, call.path) {
            case (.get, "/api/v3/previews"): return try self.json(["previews": [self.previewObject()]])
            case (.post, "/api/v3/previews"): return try self.json(self.previewObject(state: "opening", url: nil))
            case (.post, "/api/v3/previews/preview%201/ticket"):
                return try self.json(["ticketUrl": "https://abc.preview.example/_aa/ticket?t=1", "expiresAt": "2026-11-16T00:01:00Z"])
            case (.delete, "/api/v3/previews/preview%201"): return Data("{}".utf8)
            default: throw HTTPError.invalidResponse
            }
        }
        let api = V3PreviewAPI(transport: http)
        let list = try await api.list()
        #expect(list.previews.first?.url == "https://abc.preview.example" && list.previews.first?.isClosed == false)
        let created = try await api.create(.init(deviceId: "device", port: 5173, sessionId: "session"))
        #expect(created.state == "opening" && created.url == nil && !created.plaintextNotice)
        #expect(http.calls[1].body == .object(["deviceId": .string("device"), "port": .number(5173),
                                               "sessionId": .string("session"), "visibility": .string("private")]))
        let ticket = try await api.ticket(previewId: "preview 1")
        #expect(ticket.ticketUrl.hasPrefix("https://abc.preview.example/"))
        #expect(http.calls[2].body == nil)
        try await api.close(previewId: "preview 1")
        #expect(http.calls.map(\.method) == [.get, .post, .post, .delete])
    }

    @Test func previewViewToleratesNewerValues() throws {
        var object = previewObject(state: "draining")
        object["closeReason"] = "future_reason"
        object.removeValue(forKey: "plaintextNotice")
        let view: V3PreviewView = try decode(object)
        #expect(view.state == "draining" && view.closeReason == "future_reason" && !view.plaintextNotice)
    }

    // MARK: Errors

    @Test func errorCodesMapToPreviewTextAnd404HidesTheFeature() {
        let cases: [(String, String)] = [
            ("port_not_listening", "这个端口已经没有在监听了。"),
            ("port_not_local", "只能预览本机地址上的端口。"),
            ("preview_port_not_allowed", "只能预览本机地址上的端口。"),
            ("preview_limit", "同时打开的预览已达上限，请先停止其他预览。"),
            ("preview_limit_reached", "同时打开的预览已达上限，请先停止其他预览。"),
            ("preview_unavailable", "设备上的预览通道暂时不可用，请稍后重试。"),
            ("preview_disabled", "这个服务器没有开启端口预览。"),
            ("connector_offline", "设备离线，上线后才能预览。"),
            ("something_new", "无法建立预览，请稍后重试。"),
        ]
        for (code, text) in cases {
            #expect(PortPreviewErrorText.message(serverError(409, code: code)) == String(localized: String.LocalizationValue(text)))
        }
        #expect(PortPreviewErrorText.message(URLError(.timedOut)) == String(localized: "无法建立预览，请稍后重试。"))
        #expect(PortPreviewErrorText.disablesPreview(serverError(404)))
        #expect(PortPreviewErrorText.disablesPreview(serverError(409, code: "preview_disabled")))
        #expect(PortPreviewErrorText.disablesPreview(serverError(503, code: "preview_domain_not_configured")))
        #expect(!PortPreviewErrorText.disablesPreview(serverError(409, code: "preview_limit")))
        #expect(!PortPreviewErrorText.disablesPreview(URLError(.notConnectedToInternet)))
    }

    // MARK: Card actions

    @Test func previewCreatesOnceAndExchangesAFreshTicketForEveryOpen() async throws {
        let http = TestHTTPTransport(); var tickets = 0
        http.respond = { call in
            if call.path.hasSuffix("/ticket") {
                tickets += 1
                return try self.json(["ticketUrl": "https://abc.preview.example/_aa/ticket?t=\(tickets)", "expiresAt": ""])
            }
            if call.method == .delete { return Data("{}".utf8) }
            return try self.json(self.previewObject())
        }
        let store = PortPreviewStore(api: V3PreviewAPI(transport: http))
        let key = PortPreviewStore.Key(sessionId: "session", port: 5173)
        #expect(await store.preview(key, deviceId: "device") == .present(URL(string: "https://abc.preview.example/_aa/ticket?t=1")!))
        #expect(store.phase(key).view?.previewId == "preview-1")
        #expect(await store.preview(key, deviceId: "device") == .present(URL(string: "https://abc.preview.example/_aa/ticket?t=2")!))
        #expect(http.calls.filter { $0.method == .post && $0.path == V3PreviewAPI.path }.count == 1)

        await store.stop(key)
        #expect(store.phase(key) == .idle && http.calls.last?.method == .delete)
        #expect(http.calls.last?.path == "/api/v3/previews/preview-1")
    }

    @Test func plaintextNoticeIsConfirmedOncePerPreview() async throws {
        let http = TestHTTPTransport()
        http.respond = { call in
            call.path.hasSuffix("/ticket") ? try self.json(["ticketUrl": "https://abc.preview.example/t", "expiresAt": ""])
                : try self.json(self.previewObject(plaintext: true))
        }
        let store = PortPreviewStore(api: V3PreviewAPI(transport: http))
        let key = PortPreviewStore.Key(sessionId: "session", port: 5173)
        guard case let .confirm(view) = await store.preview(key, deviceId: "device") else {
            Issue.record("A plaintext preview asks first"); return
        }
        #expect(http.count("ticket") == 0)
        #expect(await store.confirmNotice(key, view: view) == .present(URL(string: "https://abc.preview.example/t")!))
        #expect(await store.preview(key, deviceId: "device") == .present(URL(string: "https://abc.preview.example/t")!))
    }

    @Test func failuresShowTextAndADisabledInstanceHidesTheCard() async throws {
        let http = TestHTTPTransport(); var failure: HTTPError = serverError(409, code: "port_not_listening")
        http.respond = { _ in throw failure }
        let store = PortPreviewStore(api: V3PreviewAPI(transport: http))
        let key = PortPreviewStore.Key(sessionId: "session", port: 5173)
        #expect(await store.preview(key, deviceId: "device") == .none)
        #expect(store.messages[key] == String(localized: "这个端口已经没有在监听了。") && !store.isDisabled)
        #expect(store.phase(key) == .idle)

        failure = serverError(404)
        #expect(await store.preview(key, deviceId: "device") == .none)
        #expect(store.isDisabled && store.messages[key] == nil)
        let calls = http.calls.count
        #expect(await store.preview(key, deviceId: "device") == .none)
        #expect(http.calls.count == calls, "A disabled instance is not asked again in this app run")
    }

    @Test func aPortThatStopsListeningForgetsItsPreview() async throws {
        let http = TestHTTPTransport()
        http.respond = { call in
            call.path.hasSuffix("/ticket") ? try self.json(["ticketUrl": "https://abc.preview.example/t", "expiresAt": ""])
                : try self.json(self.previewObject())
        }
        let store = PortPreviewStore(api: V3PreviewAPI(transport: http))
        let key = PortPreviewStore.Key(sessionId: "session", port: 5173)
        _ = await store.preview(key, deviceId: "device")
        store.retain(sessionId: "other", ports: [])
        #expect(store.phase(key).view != nil)
        store.retain(sessionId: "session", ports: [3000])
        #expect(store.phase(key) == .idle)
    }
}
