import Foundation

enum APIClientError: LocalizedError {
    case invalidServerURL
    case invalidResponse
    case server(status: Int, detail: String)

    var errorDescription: String? {
        switch self {
        case .invalidServerURL:
            return "Enter a valid server URL."
        case .invalidResponse:
            return "The server returned an invalid response."
        case let .server(_, detail):
            return detail
        }
    }
}

struct APIClient {
    let serverURL: URL
    var session: URLSession = .shared

    init(serverURL: URL) {
        self.serverURL = serverURL.normalizedServerURL()
    }

    func health() async throws -> HealthResponse {
        try await request("/health")
    }

    func authConfig() async throws -> AuthConfig {
        try await request("/auth/config")
    }

    func login(userId: String, password: String) async throws -> AuthResponse {
        try await request(
            "/auth/login",
            method: "POST",
            body: ["userId": userId, "password": password],
        )
    }

    func me(token: String) async throws -> AuthMe {
        try await request("/auth/me", token: token)
    }

    func requestMobileLogin(payload: MobileLoginPayload, deviceName: String) async throws -> MobileLoginStatusResponse {
        try await request(
            "/auth/mobile-login/request",
            method: "POST",
            body: MobileLoginRequest(
                userId: payload.userId,
                loginToken: payload.loginToken,
                deviceName: deviceName,
            ),
        )
    }

    func mobileLoginStatus(payload: MobileLoginPayload) async throws -> MobileLoginStatusResponse {
        try await request(
            "/auth/mobile-login/status",
            method: "POST",
            body: MobileLoginStatusRequest(loginToken: payload.loginToken),
        )
    }

    func exchangeMobileLogin(payload: MobileLoginPayload) async throws -> MobileLoginExchangeResponse {
        try await request(
            "/auth/mobile-login/exchange",
            method: "POST",
            body: MobileLoginExchangeRequest(
                userId: payload.userId,
                loginToken: payload.loginToken,
            ),
        )
    }

    func listConnectors(token: String) async throws -> ConnectorListResponse {
        try await request("/connectors", token: token)
    }

    func listSessions(token: String) async throws -> SessionListResponse {
        try await request("/sessions", token: token)
    }

    func markSessionRead(token: String, sessionId: String) async throws -> SessionResponse {
        let id = sessionId.urlPathComponentEncoded
        return try await request(
            "/sessions/\(id)/read",
            method: "POST",
            body: EmptyBody(),
            token: token,
        )
    }

    func enableTakeover(token: String, sessionId: String) async throws -> TakeoverResponse {
        let id = sessionId.urlPathComponentEncoded
        return try await request(
            "/sessions/\(id)/takeover",
            method: "POST",
            body: EmptyBody(),
            token: token,
        )
    }

    func disableTakeover(token: String, sessionId: String) async throws -> TakeoverResponse {
        let id = sessionId.urlPathComponentEncoded
        return try await request(
            "/sessions/\(id)/takeover",
            method: "DELETE",
            token: token,
        )
    }

    func getRuntimeConfigSchema(token: String, runtime: String) async throws -> RuntimeConfigSchemaResponse {
        let id = runtime.urlPathComponentEncoded
        return try await request(
            "/agents/\(id)/config-schema",
            token: token,
        )
    }

    func getSessionRuntimeSettings(token: String, sessionId: String) async throws -> RuntimeSettingsResponse {
        let id = sessionId.urlPathComponentEncoded
        return try await request(
            "/sessions/\(id)/runtime-settings",
            token: token,
        )
    }

    func patchSessionRuntimeSettings(
        token: String,
        sessionId: String,
        settings: [String: JSONValue],
    ) async throws -> RuntimeSettingsResponse {
        let id = sessionId.urlPathComponentEncoded
        return try await request(
            "/sessions/\(id)/runtime-settings",
            method: "PATCH",
            body: RuntimeSettingsPatchRequest(settings: settings),
            token: token,
        )
    }

    func getSessionState(
        token: String,
        sessionId: String,
        afterSeq: Int = 0,
        limit: Int = 200,
    ) async throws -> SessionStateResponse {
        let id = sessionId.urlPathComponentEncoded
        return try await request(
            "/sessions/\(id)/state?afterSeq=\(afterSeq)&limit=\(limit)",
            token: token,
        )
    }

    func sendSessionMessage(
        token: String,
        sessionId: String,
        content: String,
        attachments: [AttachmentRef] = [],
        clientMessageId: String? = nil,
    ) async throws -> RpcResponsePayload {
        let id = sessionId.urlPathComponentEncoded
        return try await request(
            "/sessions/\(id)/messages",
            method: "POST",
            body: MessageCreateRequest(
                content: content,
                attachments: attachments.isEmpty ? nil : attachments,
                clientMessageId: clientMessageId,
            ),
            token: token,
        )
    }

    func uploadSessionAttachments(
        token: String,
        sessionId: String,
        uploads: [AttachmentUpload],
    ) async throws -> UserUploadResponse {
        let id = sessionId.urlPathComponentEncoded
        let boundary = "Boundary-\(UUID().uuidString)"
        guard let url = URL(string: "/sessions/\(id)/attachments", relativeTo: serverURL)?.absoluteURL else {
            throw APIClientError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = uploads.multipartBody(boundary: boundary)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }
        guard 200..<300 ~= http.statusCode else {
            let detail = (try? JSONDecoder().decode(APIErrorResponse.self, from: data).message)
                ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            throw APIClientError.server(status: http.statusCode, detail: detail)
        }
        return try JSONDecoder().decode(UserUploadResponse.self, from: data)
    }

    func sessionEventsURL(token: String, sessionId: String) throws -> URL {
        let id = sessionId.urlPathComponentEncoded
        guard var components = URLComponents(
            url: URL(string: "/sessions/\(id)/events", relativeTo: serverURL)?.absoluteURL ?? serverURL,
            resolvingAgainstBaseURL: false,
        ) else {
            throw APIClientError.invalidResponse
        }
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        guard let url = components.url else { throw APIClientError.invalidResponse }
        return url
    }

    private func request<Response: Decodable>(
        _ path: String,
        method: String = "GET",
        body: Encodable? = nil,
        token: String? = nil,
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: serverURL)?.absoluteURL else {
            throw APIClientError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }
        guard 200..<300 ~= http.statusCode else {
            let detail = (try? JSONDecoder().decode(APIErrorResponse.self, from: data).message)
                ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
            throw APIClientError.server(status: http.statusCode, detail: detail)
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}

private struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void

    init(_ value: Encodable) {
        self.encodeValue = value.encode
    }

    func encode(to encoder: Encoder) throws {
        try encodeValue(encoder)
    }
}

private struct EmptyBody: Encodable {}

private extension Array where Element == AttachmentUpload {
    func multipartBody(boundary: String) -> Data {
        var data = Data()
        for upload in self {
            data.append("--\(boundary)\r\n")
            data.append("Content-Disposition: form-data; name=\"files\"; filename=\"\(upload.name.escapedMultipartFilename)\"\r\n")
            data.append("Content-Type: \(upload.mediaType)\r\n\r\n")
            data.append(upload.data)
            data.append("\r\n")
        }
        data.append("--\(boundary)--\r\n")
        return data
    }
}

private extension Data {
    mutating func append(_ string: String) {
        append(Data(string.utf8))
    }
}

private extension String {
    var escapedMultipartFilename: String {
        replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }
}

extension URL {
    func normalizedServerURL() -> URL {
        let components = URLComponents(url: self, resolvingAgainstBaseURL: false)
        guard var normalized = components else { return self }
        normalized.path = normalized.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        normalized.query = nil
        normalized.fragment = nil
        return normalized.url ?? self
    }
}

private extension String {
    var urlPathComponentEncoded: String {
        addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? self
    }
}

extension URL {
    static func agentsServer(from value: String) throws -> URL {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw APIClientError.invalidServerURL }
        let withScheme = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard let url = URL(string: withScheme), url.scheme != nil, url.host != nil else {
            throw APIClientError.invalidServerURL
        }
        return url.normalizedServerURL()
    }
}
