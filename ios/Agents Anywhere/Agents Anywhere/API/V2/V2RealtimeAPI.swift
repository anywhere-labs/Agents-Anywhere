import Foundation

protocol V2RealtimeAPIProtocol {
    func ticket(clientId: String, scope: V2RealtimeScope) async throws -> V2WebSocketTicket
    func recover(sessionId: V2SessionID, after cursor: String) async throws -> V2EventRecoveryResponse
    func sessionEvents(sessionId: V2SessionID, ticket: String) throws -> AsyncThrowingStream<V2SessionEvent, Error>
    func dashboardSnapshots(ticket: String) throws -> AsyncThrowingStream<V2DashboardSnapshot, Error>
}

struct V2RealtimeAPI: V2RealtimeAPIProtocol {
    let serverURL: URL
    let transport: any HTTPTransport
    let webSocketTransport: any WebSocketTransport
    let decoder: JSONDecoder
    let heartbeatTimeout: Duration
    let heartbeatCheckInterval: Duration

    init(
        serverURL: URL,
        transport: any HTTPTransport,
        webSocketTransport: any WebSocketTransport,
        decoder: JSONDecoder = JSONDecoder(),
        heartbeatTimeout: Duration = .seconds(45),
        heartbeatCheckInterval: Duration = .seconds(15)
    ) {
        self.serverURL = serverURL.normalizedV2ServerURL()
        self.transport = transport
        self.webSocketTransport = webSocketTransport
        self.decoder = decoder
        self.heartbeatTimeout = heartbeatTimeout
        self.heartbeatCheckInterval = heartbeatCheckInterval
    }

    func ticket(clientId: String, scope: V2RealtimeScope) async throws -> V2WebSocketTicket {
        let body = V2WebSocketTicketRequest(
            clientId: clientId,
            scope: V2WebSocketTicketScope(scope: scope)
        )
        let request = HTTPRequest<V2WebSocketTicketRequest, V2WebSocketTicket>(
            method: .post,
            path: "/ws-ticket",
            body: body
        )
        return try await transport.send(request)
    }

    func recover(sessionId: V2SessionID, after cursor: String) async throws -> V2EventRecoveryResponse {
        let request = HTTPRequest<EmptyRequestBody, V2EventRecoveryResponse>(
            method: .get,
            path: "/sessions/\(sessionId.v2URLPathComponentEncoded)/events",
            queryItems: [URLQueryItem(name: "after", value: cursor)]
        )
        return try await transport.send(request)
    }

    func sessionEvents(
        sessionId: V2SessionID,
        ticket: String
    ) throws -> AsyncThrowingStream<V2SessionEvent, Error> {
        let path = "/api/v2/sessions/\(sessionId.v2URLPathComponentEncoded)/ws"
        return try decodedMessages(path: path, ticket: ticket, as: V2SessionEvent.self)
    }

    func dashboardSnapshots(ticket: String) throws -> AsyncThrowingStream<V2DashboardSnapshot, Error> {
        try decodedMessages(path: "/api/v2/dashboard/ws", ticket: ticket, as: V2DashboardSnapshot.self)
    }

    private func decodedMessages<Value: Decodable>(
        path: String,
        ticket: String,
        as valueType: Value.Type
    ) throws -> AsyncThrowingStream<Value, Error> {
        let connection = webSocketTransport.connect(url: try webSocketURL(path: path, ticket: ticket))
        return AsyncThrowingStream(bufferingPolicy: .bufferingOldest(2048)) { continuation in
            var lastFrame = ContinuousClock.now
            // Both session and dashboard endpoints send a frame/keepalive every 15s.
            // Path monitoring alone cannot detect a silent server or broken VPN route.
            let watchdog = Task {
                do {
                    while !Task.isCancelled {
                        try await Task.sleep(for: heartbeatCheckInterval)
                        if lastFrame.duration(to: .now) >= heartbeatTimeout {
                            continuation.finish(throwing: URLError(.timedOut))
                            connection.close()
                            return
                        }
                    }
                } catch { /* Consumer cancellation stops the watchdog. */ }
            }
            let task = Task {
                do {
                    for try await data in connection.messages() {
                        lastFrame = .now
                        if isKeepalive(data) {
                            continue
                        }
                        if case .dropped = continuation.yield(try decoder.decode(valueType, from: data)) {
                            throw HTTPError.streamOverflow
                        }
                    }
                    continuation.finish()
                } catch let error as DecodingError {
                    continuation.finish(throwing: HTTPError.decoding(message: "实时更新：\(error.v2Description)"))
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                watchdog.cancel()
                task.cancel()
                connection.close()
            }
        }
    }

    private func isKeepalive(_ data: Data) -> Bool {
        (try? decoder.decode(V2SocketMessageKind.self, from: data).type) == "keepalive"
    }

    private func webSocketURL(path: String, ticket: String) throws -> URL {
        guard var components = URLComponents(
            url: URL(string: path, relativeTo: serverURL)?.absoluteURL ?? serverURL,
            resolvingAgainstBaseURL: false
        ) else {
            throw HTTPError.invalidRequestURL(path: path)
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.queryItems = [URLQueryItem(name: "ticket", value: ticket)]
        guard let url = components.url else {
            throw HTTPError.invalidRequestURL(path: path)
        }
        return url
    }
}

private struct V2SocketMessageKind: Decodable {
    let type: String
}
