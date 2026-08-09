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

    init(
        serverURL: URL,
        transport: any HTTPTransport,
        webSocketTransport: any WebSocketTransport,
        decoder: JSONDecoder = JSONDecoder()
    ) {
        self.serverURL = serverURL.normalizedV2ServerURL()
        self.transport = transport
        self.webSocketTransport = webSocketTransport
        self.decoder = decoder
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
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await data in connection.messages() {
                        if isKeepalive(data) {
                            continue
                        }
                        continuation.yield(try decoder.decode(valueType, from: data))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
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
