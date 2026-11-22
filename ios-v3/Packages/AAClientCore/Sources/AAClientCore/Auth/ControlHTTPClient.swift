// HTTP client for the parts of the control plane MeshCall cannot express: password login, token refresh and the
// client Router token (`server-v3/aa_control/api/auth.py`). Everything else goes through MeshCall.

import Foundation

public struct ControlAPIError: Error, Sendable, LocalizedError, Equatable {
    public let status: Int
    public let code: String
    public let message: String

    public init(status: Int, code: String, message: String) {
        self.status = status
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
    /// The account session itself was refused: sign in again.
    public var isAuthRejection: Bool { status == 401 || status == 403 }
}

public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    let session: URLSession
    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (data, http)
    }
}

public struct ControlHTTPClient: Sendable {
    public let baseURL: URL
    let transport: any HTTPTransport

    public init(baseURL: URL, transport: any HTTPTransport = URLSessionTransport()) {
        self.baseURL = baseURL
        self.transport = transport
    }

    /// Accept `127.0.0.1:8790`, `http://host:8790/`, … and return a base URL without a trailing slash.
    public static func normalize(_ raw: String) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "http://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              url.host != nil
        else { return nil }
        return url
    }

    public func authConfig() async throws -> AuthConfigResponse {
        try await request("GET", "/auth/config")
    }

    public func login(email: String, password: String, clientID: String?) async throws -> AuthTokenResponse {
        var body: [String: String] = ["email": email, "password": password, "client_platform": "ios"]
        if let clientID { body["client_id"] = clientID }
        return try await request("POST", "/auth/login", body: body)
    }

    public func refresh(refreshToken: String) async throws -> AuthTokenResponse {
        try await request("POST", "/auth/refresh", body: ["refresh_token": refreshToken])
    }

    public func logout(refreshToken: String) async throws {
        let _: JSONValue = try await request("POST", "/auth/logout", body: ["refresh_token": refreshToken])
    }

    public func me(accessToken: String) async throws -> UserView {
        try await request("GET", "/auth/me", token: accessToken)
    }

    public func routerToken(accessToken: String, clientID: String) async throws -> ClientRouterTokenResponse {
        try await request("POST", "/auth/router-token", token: accessToken, body: ["client_id": clientID, "platform": "ios"])
    }

    func request<Response: Decodable>(
        _ method: String, _ path: String, token: String? = nil, body: [String: String]? = nil
    ) async throws -> Response {
        var request = URLRequest(url: baseURL.appendingPathComponent(String(path.dropFirst())))
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, response) = try await transport.send(request)
        guard (200..<300).contains(response.statusCode) else {
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let code = object?["code"] as? String ?? "http_\(response.statusCode)"
            let message = (object?["detail"] as? String) ?? (object?["message"] as? String)
                ?? HTTPURLResponse.localizedString(forStatusCode: response.statusCode)
            throw ControlAPIError(status: response.statusCode, code: code, message: message)
        }
        if data.isEmpty, let empty = JSONValue.null as? Response { return empty }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}

/// The account session saved between launches (Keychain).
public struct StoredAccount: Codable, Sendable, Hashable {
    public var controlURL: String
    public var user: UserView
    public var clientID: String
    public var refreshToken: String
    public var accessToken: String
    public var accessExpiresAt: Date

    enum CodingKeys: String, CodingKey {
        case user
        case controlURL = "control_url"
        case clientID = "client_id"
        case refreshToken = "refresh_token"
        case accessToken = "access_token"
        case accessExpiresAt = "access_expires_at"
    }

    public init(controlURL: String, response: AuthTokenResponse, now: Date = Date()) {
        self.controlURL = controlURL
        user = response.user
        clientID = response.clientID
        refreshToken = response.refreshToken
        accessToken = response.accessToken
        accessExpiresAt = now.addingTimeInterval(TimeInterval(response.expiresIn))
    }
}

/// Holds the account session and hands out fresh access tokens, refreshing (and persisting the rotated refresh
/// token) when the access token is within a minute of expiry. A refused refresh is surfaced as
/// `ControlAPIError.isAuthRejection` so the app can sign out; a network failure is not.
public actor AuthSession {
    public static let storageKey = "account"

    public let http: ControlHTTPClient
    private let store: any SecretStore
    private var account: StoredAccount
    private var refreshing: Task<StoredAccount, Error>?

    public init(account: StoredAccount, store: any SecretStore, transport: any HTTPTransport = URLSessionTransport()) throws {
        guard let url = ControlHTTPClient.normalize(account.controlURL) else {
            throw ControlAPIError(status: 0, code: "invalid_url", message: "控制面地址无效")
        }
        http = ControlHTTPClient(baseURL: url, transport: transport)
        self.store = store
        self.account = account
    }

    public static func signIn(
        controlURL: String, email: String, password: String, store: any SecretStore,
        transport: any HTTPTransport = URLSessionTransport()
    ) async throws -> AuthSession {
        guard let url = ControlHTTPClient.normalize(controlURL) else {
            throw ControlAPIError(status: 0, code: "invalid_url", message: "控制面地址无效")
        }
        let http = ControlHTTPClient(baseURL: url, transport: transport)
        // Reuse this installation's client id so the server does not see a new client on every sign-in.
        let previous = (try? store.value(StoredAccount.self, for: storageKey)) ?? nil
        let response = try await http.login(email: email, password: password, clientID: previous?.clientID)
        let account = StoredAccount(controlURL: url.absoluteString, response: response)
        try store.setValue(account, for: storageKey)
        return try AuthSession(account: account, store: store, transport: transport)
    }

    public static func restore(store: any SecretStore, transport: any HTTPTransport = URLSessionTransport()) -> AuthSession? {
        guard let account = (try? store.value(StoredAccount.self, for: storageKey)) ?? nil else { return nil }
        return try? AuthSession(account: account, store: store, transport: transport)
    }

    public var current: StoredAccount { account }

    public func accessToken(now: Date = Date()) async throws -> String {
        if account.accessExpiresAt.timeIntervalSince(now) > 60 { return account.accessToken }
        return try await refresh().accessToken
    }

    @discardableResult
    public func refresh() async throws -> StoredAccount {
        if let refreshing { return try await refreshing.value }
        let task = Task { [http, account, store] () throws -> StoredAccount in
            let response = try await http.refresh(refreshToken: account.refreshToken)
            var next = StoredAccount(controlURL: account.controlURL, response: response)
            if next.clientID.isEmpty { next.clientID = account.clientID }
            try store.setValue(next, for: AuthSession.storageKey)
            return next
        }
        refreshing = task
        defer { refreshing = nil }
        account = try await task.value
        return account
    }

    public func routerToken() async throws -> ClientRouterTokenResponse {
        let token = try await accessToken()
        do {
            return try await http.routerToken(accessToken: token, clientID: account.clientID)
        } catch let error as ControlAPIError where error.status == 401 {
            try await refresh()
            return try await http.routerToken(accessToken: account.accessToken, clientID: account.clientID)
        }
    }

    /// Revoke the refresh token (best effort) and forget the account.
    public func signOut() async {
        try? await http.logout(refreshToken: account.refreshToken)
        try? store.remove(Self.storageKey)
    }
}
