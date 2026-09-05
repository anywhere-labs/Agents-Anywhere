import Foundation
import Testing
@testable import ClientCore

nonisolated private final class InterceptedRequests: @unchecked Sendable {
    enum Reply { case response(Int, Data, [String: String] = [:]); case failure(URLError.Code) }
    private let lock = NSLock()
    private var pending: [Reply] = []
    private var captured: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { captured } }
    func reset(_ replies: [Reply]) { lock.withLock { pending = replies; captured = [] } }
    func next(_ request: URLRequest) -> Reply {
        lock.withLock {
            captured.append(request)
            return pending.isEmpty ? .failure(.badServerResponse) : pending.removeFirst()
        }
    }
}

nonisolated private final class InterceptingURLProtocol: URLProtocol, @unchecked Sendable {
    static let state = InterceptedRequests()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var captured = request
        if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
            captured.httpBody = data
        }
        switch Self.state.next(captured) {
        case let .failure(code): client?.urlProtocol(self, didFailWithError: URLError(code))
        case let .response(status, data, headers):
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
    }
    override func stopLoading() {}
}

@Suite(.serialized) @MainActor struct HTTPContractTests {
    private func session() -> URLSession {
        let config = V2MobileNetworking.configuration(); config.protocolClasses = [InterceptingURLProtocol.self]
        return URLSession(configuration: config)
    }

    @Test func requestsUseBackendMethodsPathsBodiesAndQueries() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let api = V2APIClient(serverURL: URL(string: "https://example.test/api/v2/?old=true#stale")!, tokenProvider: StaticAuthTokenProvider(token: "test-token"), urlSession: session)
        let responseNames = ["runtimeTypes", "runtime", "runtime", "modelCatalog", "session", "session", "selectionResponse", "rpc", "takeover", "takeover", "rpc", "timeline", "bulk", "text", "ticket", "recovery"]
        InterceptingURLProtocol.state.reset(try responseNames.map { .response(200, try fixtureData($0)) })
        _ = try await api.connectors.runtimeTypes(connectorId: "device")
        _ = try await api.connectors.createRuntime(connectorId: "device", request: V2RuntimeInstanceCreateRequest(runtimeType: "claude", name: "Work", config: [:], active: true))
        _ = try await api.connectors.renameRuntime(connectorId: "device", runtimeId: "rti_work", request: V2RuntimeInstanceRenameRequest(name: "Work"))
        _ = try await api.connectors.modelCatalog(connectorId: "device", runtimeId: "rti_work")
        _ = try await api.sessions.createAndStartSession(request: V2SessionCreateAndStartRequest(connectorId: "device", runtime: "claude", runtimeId: "rti_work", title: nil, cwd: nil, content: "Hello", selections: [.model: "sel_model"], attachments: [], clientMessageId: nil))
        _ = try await api.sessions.createSession(request: V2SessionCreateRequest(connectorId: "device", runtime: "claude", runtimeId: "rti_work", externalSessionId: "external", title: nil, cwd: nil, selections: [:]))
        _ = try await api.runtime.updateSelections(sessionId: "session", request: V2RuntimeSelectionUpdateRequest(selections: [.effort: nil]))
        _ = try await api.runtime.sendMessage(sessionId: "session", request: V2RuntimeMessageSendRequest(content: "Hello", attachments: [], clientMessageId: "client"))
        _ = try await api.sessions.setTakeover(sessionId: "session", enabled: true)
        _ = try await api.sessions.setTakeover(sessionId: "session", enabled: false)
        _ = try await api.sessions.sync(sessionId: "session")
        _ = try await api.sessions.timelineHistory(sessionId: "session", beforeOrderSeq: 80, limit: 25)
        _ = try await api.sessions.markRead(sessionIds: ["session"])
        _ = try await api.connectors.readWorkspaceText(connectorId: "device", root: "/workspace with spaces", request: V2WorkspaceTextRequest(path: "test.txt"))
        _ = try await api.realtime.ticket(clientId: "client", scope: .session("session"))
        _ = try await api.realtime.recover(sessionId: "session", after: "seq:40")
        let requests = InterceptingURLProtocol.state.requests
        #expect(requests.count == responseNames.count)
        let expected = [
            ("GET", "/connectors/device/runtime-types"), ("POST", "/connectors/device/runtimes"),
            ("PATCH", "/connectors/device/runtimes/rti_work"), ("GET", "/connectors/device/runtimes/rti_work/catalogs/model"),
            ("POST", "/sessions/create-and-start"), ("POST", "/sessions"), ("PATCH", "/sessions/session/runtime/selections"),
            ("POST", "/sessions/session/runtime/messages"), ("POST", "/sessions/session/takeover"),
            ("DELETE", "/sessions/session/takeover"), ("POST", "/sessions/session/sync"), ("GET", "/sessions/session/timeline"),
            ("POST", "/sessions/read"), ("POST", "/connectors/device/fs/readText"), ("POST", "/ws-ticket"), ("GET", "/sessions/session/events"),
        ]
        let routes: [[String: String]] = try JSONDecoder().decode([[String: String]].self, from: fixtureData("routes"))
        for (request, expected) in zip(requests, expected) {
            #expect(request.httpMethod == expected.0)
            #expect(request.url?.path == "/api/v2" + expected.1)
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token")
            #expect(request.url?.fragment == nil)
            #expect(routes.contains { route in
                guard route["method"] == request.httpMethod else { return false }
                let pattern = "^" + route["path"]!.replacingOccurrences(of: #"\{[^}]+\}"#, with: "[^/]+", options: .regularExpression) + "$"
                return request.url!.path.range(of: pattern, options: .regularExpression) != nil
            })
        }
        let bodies = try fixtureObject("requests")
        for (index, key) in [(1, "createRuntime"), (2, "renameRuntime"), (4, "createSession"), (5, "bindSession"), (6, "selection"), (7, "message"), (13, "readText"), (14, "ticket")] {
            let body = try JSONDecoder().decode(JSONValue.self, from: #require(requests[index].httpBody))
            let backend = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: bodies[key]!))
            #expect(body == backend, "Request \(key) differs from the backend model")
        }
        #expect(try JSONDecoder().decode([String].self, from: #require(requests[12].httpBody)) == ["session"])
        #expect(query(requests[11]) == ["mode": "history", "limit": "25", "beforeOrderSeq": "80"])
        #expect(query(requests[13]) == ["root": "/workspace with spaces"])
        #expect(query(requests[15]) == ["after": "seq:40"])
    }

    @Test func onlyReadRequestsRetryTransientFailures() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        var sleeps: [Duration] = []
        let transport = URLSessionHTTPTransport(serverURL: URL(string: "https://example.test")!, urlSession: session,
                                               tokenProvider: StaticAuthTokenProvider(token: "token"), sleep: { sleeps.append($0) })
        InterceptingURLProtocol.state.reset([.failure(.networkConnectionLost), .response(503, Data(), ["Retry-After": "2"]), .response(200, try fixtureData("state"))])
        _ = try await V2RuntimeAPI(transport: transport).state(sessionId: "session")
        #expect(InterceptingURLProtocol.state.requests.count == 3)
        #expect(sleeps == [.milliseconds(500), .seconds(2)])
        InterceptingURLProtocol.state.reset([.failure(.timedOut), .response(200, try fixtureData("rpc"))])
        do {
            _ = try await V2RuntimeAPI(transport: transport).sendMessage(sessionId: "session", request: V2RuntimeMessageSendRequest(content: "Hello", attachments: [], clientMessageId: "client"))
            Issue.record("Write should surface timeout")
        } catch { #expect((error as? URLError)?.code == .timedOut) }
        #expect(InterceptingURLProtocol.state.requests.count == 1)
    }

    @Test func authAndStructuredServerErrorsNeverRetry() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let transport = URLSessionHTTPTransport(serverURL: URL(string: "https://example.test")!, urlSession: session, tokenProvider: StaticAuthTokenProvider(token: "token"))
        let data = Data(#"{"detail":{"code":"session_forbidden","message":"No access"}}"#.utf8)
        InterceptingURLProtocol.state.reset([.response(403, data)])
        do { _ = try await V2RuntimeAPI(transport: transport).state(sessionId: "session"); Issue.record("Expected auth failure") }
        catch {
            #expect((error as? HTTPError)?.serverCode == "session_forbidden")
            #expect(V2ClientFailure(error).kind == .authentication)
        }
        #expect(InterceptingURLProtocol.state.requests.count == 1)
    }

    @Test func cancellationStopsRetryBeforeAnotherRequest() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let transport = URLSessionHTTPTransport(serverURL: URL(string: "https://example.test")!, urlSession: session,
                                               tokenProvider: StaticAuthTokenProvider(token: "token"), sleep: { _ in throw CancellationError() })
        InterceptingURLProtocol.state.reset([.failure(.timedOut), .response(200, try fixtureData("state"))])
        await #expect(throws: CancellationError.self) { _ = try await V2RuntimeAPI(transport: transport).state(sessionId: "session") }
        #expect(InterceptingURLProtocol.state.requests.count == 1)
    }

    @Test func mobileConfigurationAndNamespaceAreExplicit() {
        let config = V2MobileNetworking.configuration()
        #expect(config.waitsForConnectivity)
        #expect(config.timeoutIntervalForRequest == 30)
        #expect(config.timeoutIntervalForResource == 90)
        #expect(config.urlCache == nil)
        #expect(v2APIPath("api/v2/sessions") == "/api/v2/sessions")
        #expect(v2APIPath("/sessions") == "/api/v2/sessions")
        #expect(HTTPReadRetryPolicy().delay(from: "Thu, 01 Jan 1970 00:01:00 GMT", now: Date(timeIntervalSince1970: 0)) == 60)
    }

    @Test func longRetryAfterIsSurfacedWithoutEarlyRetry() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let transport = URLSessionHTTPTransport(serverURL: URL(string: "https://example.test")!, urlSession: session,
                                               tokenProvider: StaticAuthTokenProvider(token: "token"), sleep: { _ in Issue.record("Should not wait or retry") })
        InterceptingURLProtocol.state.reset([.response(429, Data(), ["Retry-After": "120"])])
        do { _ = try await V2RuntimeAPI(transport: transport).state(sessionId: "session"); Issue.record("Expected rate limit") }
        catch { #expect((error as? HTTPError)?.statusCode == 429) }
        #expect(InterceptingURLProtocol.state.requests.count == 1)
    }

    private func query(_ request: URLRequest) -> [String: String] {
        Dictionary(uniqueKeysWithValues: URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value ?? "") })
    }
}
