import Foundation

/// 让现有的 API 资源（`V2SessionAPI(transport:)` 等）不改代码就能走安全通道：
/// 请求变成通道内的 `request`，路径与普通模式相同，响应按普通 HTTP 的规则解码。
nonisolated struct E2EEChannelHTTPTransport: HTTPTransport {
    let channel: ClientSecureChannel
    var encoder = JSONEncoder()
    var decoder = JSONDecoder()
    var timeout: Duration = .seconds(60)

    func send<Body: Encodable, Response: Decodable>(_ request: HTTPRequest<Body, Response>) async throws -> Response {
        let body = try request.body.map { try encoder.encode($0) }
        let response = try await perform(request.method, path: Self.path(request.path, query: request.queryItems), body: body)
        return try decode(Response.self, from: response)
    }

    /// 附件需要分段加密后上传（`SealedAttachmentKey` 经通道交给设备），这里还没有接。
    func upload<Response: Decodable>(_ request: HTTPUploadRequest<Response>) async throws -> Response {
        throw E2EEError(code: E2EEError.unsupported, message: "encrypted uploads are not wired yet")
    }

    func download(_ url: URL) async throws -> URL {
        throw E2EEError(code: E2EEError.unsupported, message: "encrypted downloads are not wired yet")
    }

    /// 发一个已经编码好的请求体；命令的输入摘要要按这些字节计算。
    func perform(_ method: HTTPMethod, path: String, body: Data?) async throws -> E2EETunnelResponse {
        let channel = channel
        let response = try await withThrowingTaskGroup(of: E2EETunnelResponse?.self) { group in
            group.addTask { try await channel.request(method, path: path, body: body) }
            group.addTask { [timeout] in
                try await Task.sleep(for: timeout)
                return nil
            }
            defer { group.cancelAll() }
            guard let first = try await group.next(), let response = first else { throw URLError(.timedOut) }
            return response
        }
        guard 200..<300 ~= response.status else {
            let detail = (try? decoder.decode(HTTPServerErrorEnvelope.self, from: response.body))?.detail
                ?? (try? decoder.decode(JSONValue.self, from: response.body))
            throw HTTPError.server(
                statusCode: response.status,
                message: detail?["message"]?.stringValue ?? HTTPURLResponse.localizedString(forStatusCode: response.status),
                detail: detail
            )
        }
        return response
    }

    func decode<Response: Decodable>(_ type: Response.Type, from response: E2EETunnelResponse) throws -> Response {
        if type == EmptyResponse.self, let empty = EmptyResponse() as? Response { return empty }
        do {
            return try decoder.decode(Response.self, from: response.body)
        } catch let error as DecodingError {
            throw HTTPError.decoding(message: error.v2Description)
        }
    }

    /// 通道里的路径就是普通模式下的完整客户端 API 路径（含查询串）。
    static func path(_ path: String, query: [URLQueryItem]) -> String {
        var components = URLComponents()
        components.percentEncodedPath = v2APIPath(path)
        if !query.isEmpty { components.queryItems = query }
        return components.string ?? v2APIPath(path)
    }
}

nonisolated extension ClientSecureChannel {
    /// 会话事件流：与普通模式的会话 WS 相同的事件，经通道 `subscribe` 送达。
    func sessionEvents(sessionId: V2SessionID, afterCursor: String?) async throws -> AsyncThrowingStream<V2SessionEvent, Error> {
        let (_, raw) = try await subscribe(sessionId: sessionId, afterCursor: afterCursor)
        return AsyncThrowingStream(bufferingPolicy: .bufferingOldest(2048)) { continuation in
            let task = Task {
                do {
                    let decoder = JSONDecoder()
                    for try await data in raw {
                        if (try? decoder.decode(E2EEEventType.self, from: data))?.type == "keepalive" { continue }
                        let event = try decoder.decode(V2SessionEvent.self, from: data)
                        if case .dropped = continuation.yield(event) { throw HTTPError.streamOverflow }
                    }
                    continuation.finish()
                } catch let error as DecodingError {
                    continuation.finish(throwing: HTTPError.decoding(message: error.v2Description))
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

nonisolated private struct E2EEEventType: Decodable {
    let type: String?
}
