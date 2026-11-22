// `aa.v3.Control` over MeshCall: devices, aggregated session lists and tunnel issuance.
//
// The control plane registers as a MeshCall service; this client connects to the Router with a short-lived `mt_`
// token from `POST /auth/router-token`. Router tokens live only in the Router's memory, so a Router restart makes
// every call fail with `unauthenticated`: that is a normal path here — fetch a new token once and retry.

import Foundation

let controlService = "aa.v3.Control"

/// Convert an `http(s)://` Router URL to the WebSocket form MeshCall's Swift runtime needs.
func webSocketURL(_ url: String) -> String {
    if url.hasPrefix("https://") { return "wss://" + url.dropFirst("https://".count) }
    if url.hasPrefix("http://") { return "ws://" + url.dropFirst("http://".count) }
    return url
}

func isUnauthenticated(_ error: Error) -> Bool {
    (error as? MeshCallError)?.code == .unauthenticated
}

/// Relay a MeshCall server stream as an `AsyncThrowingStream`. If the stream is refused as unauthenticated before
/// its first item, `open(true)` is tried once more (fresh credentials). Cancelling the consumer cancels the call.
func relay<Item: Sendable>(
    _ open: @escaping @Sendable (_ refresh: Bool) async throws -> ServerStream<Item>
) -> AsyncThrowingStream<Item, Error> {
    AsyncThrowingStream { continuation in
        let task = Task {
            var refreshed = false
            var yielded = false
            while true {
                do {
                    let stream = try await open(refreshed)
                    for try await item in stream {
                        yielded = true
                        continuation.yield(item)
                    }
                    continuation.finish()
                    return
                } catch where isUnauthenticated(error) && !yielded && !refreshed {
                    refreshed = true
                } catch {
                    continuation.finish(throwing: error)
                    return
                }
            }
        }
        continuation.onTermination = { _ in task.cancel() }
    }
}

public actor ControlPlaneClient {
    public let auth: AuthSession
    private var mesh: Mesh?
    private var tokenExpiresAt: Date?
    private var connecting: Task<Mesh, Error>?

    public init(auth: AuthSession) {
        self.auth = auth
    }

    /// The current connection; a new token (and connection) when the token is about to expire or `refresh` is set.
    /// A proactive renewal leaves the old connection to its running streams; a refused one is closed.
    func connection(refresh: Bool) async throws -> Mesh {
        if !refresh, let mesh, let tokenExpiresAt, tokenExpiresAt.timeIntervalSinceNow > 60 { return mesh }
        if let connecting { return try await connecting.value }
        let stale = refresh ? mesh : nil
        let task = Task { [auth] () throws -> Mesh in
            if let stale { await stale.close() }
            let issued = try await auth.routerToken()
            guard let entry = issued.tokens.first else {
                throw MeshCallError(.unavailable, "控制面没有配置 MeshCall Router")
            }
            let mesh = try Mesh(Router(webSocketURL(entry.routerURL)), options: MeshOptions(credentials: .bearer(entry.token)))
            self.adopt(mesh, expiresAt: ISO8601.parse(entry.expiresAt) ?? Date().addingTimeInterval(3600))
            return mesh
        }
        connecting = task
        defer { connecting = nil }
        return try await task.value
    }

    private func adopt(_ mesh: Mesh, expiresAt: Date) {
        self.mesh = mesh
        tokenExpiresAt = expiresAt
    }

    func unary<Request: Encodable & Sendable, Response: Decodable & Sendable>(
        _ method: String, _ request: Request, as: Response.Type = Response.self, timeout: Duration = .seconds(20)
    ) async throws -> Response {
        let options = CallOptions(timeout: timeout)
        do {
            return try await connection(refresh: false).unary(controlService, method, request, as: Response.self, options: options)
        } catch where isUnauthenticated(error) {
            return try await connection(refresh: true).unary(controlService, method, request, as: Response.self, options: options)
        }
    }

    public func listDevices() async throws -> [DeviceRecord] {
        try await unary("list_devices", Empty(), as: ListDevicesResponse.self).devices
    }

    public func renameDevice(_ deviceID: String, name: String) async throws -> DeviceRecord {
        try await unary("rename_device", ["device_id": deviceID, "name": name])
    }

    public func openTunnel(deviceID: String, e2eKey: String?) async throws -> OpenTunnelResponse {
        var request = ["device_id": deviceID, "client_id": await auth.current.clientID]
        if let e2eKey { request["e2e_key"] = e2eKey }
        return try await unary("open_tunnel", request, as: OpenTunnelResponse.self, timeout: .seconds(30))
    }

    public func listSessionsOnce(deviceIDs: [String]? = nil, limitPerDevice: Int? = nil) async throws -> [DeviceSessionResult] {
        try await unary("list_sessions_once", ListSessionsRequest(deviceIDs: deviceIDs, limitPerDevice: limitPerDevice),
            as: ListSessionsOnceResponse.self).results
    }

    /// A snapshot, then whole-record upserts and removals. Ends on a loss: watch again.
    public nonisolated func watchDevices() -> AsyncThrowingStream<WatchDevicesEvent, Error> {
        relay { refresh in
            try await self.connection(refresh: refresh).serverStream(controlService, "watch_devices", Empty(), of: WatchDevicesEvent.self)
        }
    }

    /// Fan-out over normal devices; encrypted devices answer `status: encrypted` (ask them through their tunnel).
    public nonisolated func listSessions(deviceIDs: [String]? = nil, limitPerDevice: Int? = nil) -> AsyncThrowingStream<DeviceSessionResult, Error> {
        let request = ListSessionsRequest(deviceIDs: deviceIDs, limitPerDevice: limitPerDevice)
        return relay { refresh in
            try await self.connection(refresh: refresh).serverStream(
                controlService, "list_sessions", request, of: DeviceSessionResult.self, options: CallOptions(timeout: .seconds(30)))
        }
    }

    /// Call when the app returns to the foreground: a socket the system cut is dropped at once.
    public func checkConnection() async {
        if let mesh { await mesh.checkConnection() }
    }

    public func close() async {
        let mesh = self.mesh
        self.mesh = nil
        tokenExpiresAt = nil
        await mesh?.close()
    }
}

struct ListSessionsRequest: Encodable, Sendable {
    var deviceIDs: [String]?
    var limitPerDevice: Int?
    enum CodingKeys: String, CodingKey {
        case deviceIDs = "device_ids"
        case limitPerDevice = "limit_per_device"
    }
}
