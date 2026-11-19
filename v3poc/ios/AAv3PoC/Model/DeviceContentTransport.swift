import Foundation
import MeshCall

/// The app supplies an authenticated grant request and a public key verified on the device.
/// Only the native client and Connector ever receive the content credential.
@MainActor
final class DeviceContentTransport {
    private let instanceID: String
    private let pinnedKey: String
    private let issue: () async throws -> DeviceTunnelGrant
    private var current: (mesh: Mesh, client: ContentClient)?
    private var opening: Task<(Mesh, ContentClient), Error>?

    init(instanceID: String, pinnedKey: String, issue: @escaping () async throws -> DeviceTunnelGrant) {
        self.instanceID = instanceID
        self.pinnedKey = pinnedKey
        self.issue = issue
    }

    convenience init(server: URL, instanceID: String, pinnedKey: String, accessToken: @escaping () async throws -> String) {
        self.init(instanceID: instanceID, pinnedKey: pinnedKey) {
            let grant = try await withMobileControl(server: server, accessToken: accessToken) { client, instance in
                try await client.issueContentTunnel(instance: instance, deviceId: instanceID)
            }
            return DeviceTunnelGrant(
                tunnel: TunnelGrant(
                    routerURL: grant.routerURL, credential: grant.credential, instanceID: grant.instanceID,
                    tunnelID: grant.tunnelID, e2eKey: grant.e2eKey
                ),
                maxFrameBytes: grant.maxFrameBytes
            )
        }
    }

    func pair(_ request: ContentPairRequest) async throws -> ContentPairResult {
        let client = try await connect()
        return try await client.pair(
            instance: instanceID, clientIdentityPub: request.clientIdentityPub,
            clientSecret: request.clientSecret, label: request.label,
            pairingId: request.pairingId, pairingSecret: request.pairingSecret, platform: request.platform
        )
    }

    func request(_ request: ContentRequest, authorization: ContentAuthorization) async throws -> ContentResult {
        let client = try await connect()
        return try await client.request(
            instance: instanceID, body: request.body, method: request.method, path: request.path,
            options: CallOptions(metadata: authorization.metadata)
        )
    }

    func subscribe(_ request: ContentSubscribeRequest, authorization: ContentAuthorization) async throws -> ServerStream<ContentEvent> {
        let client = try await connect()
        return try await client.subscribe(
            instance: instanceID, afterCursor: request.afterCursor, fromSeq: request.fromSeq,
            sessionId: request.sessionId ?? "", stream: request.stream ?? "session", terminalId: request.terminalId,
            options: CallOptions(metadata: authorization.metadata)
        )
    }

    /// Credentials are per Router process. The subscriber calls this before obtaining a new grant.
    func invalidate() async {
        let pending = opening
        let old = current?.mesh
        opening = nil
        current = nil
        pending?.cancel()
        await old?.close()
    }

    private func connect() async throws -> ContentClient {
        if let current { return current.client }
        if let opening { return try await opening.value.1 }
        let pending = Task {
            let grant = try await issue()
            try Task.checkCancellation()
            guard grant.tunnel.instanceID == instanceID, grant.tunnel.e2eKey == pinnedKey,
                  grant.tunnel.credential.hasPrefix("mtun_e2e."), !pinnedKey.isEmpty, safeRouter(grant.tunnel.routerURL) else {
                throw DeviceContentError.identityMismatch
            }
            let mesh = try Mesh(tunnel: grant.tunnel, options: MeshOptions(maxFrameSize: grant.maxFrameBytes, retry: .disabled))
            return (mesh, ContentClient(mesh))
        }
        opening = pending
        do {
            let connected = try await pending.value
            if pending.isCancelled {
                await connected.0.close()
                throw CancellationError()
            }
            current = connected
            opening = nil
            return connected.1
        } catch {
            if !pending.isCancelled { opening = nil }
            throw error
        }
    }
}

struct DeviceTunnelGrant: Decodable {
    let tunnel: TunnelGrant
    let maxFrameBytes: Int

    private enum CodingKeys: String, CodingKey { case maxFrameBytes }

    init(tunnel: TunnelGrant, maxFrameBytes: Int) {
        self.tunnel = tunnel
        self.maxFrameBytes = maxFrameBytes
    }

    init(from decoder: any Decoder) throws {
        self.tunnel = try TunnelGrant(from: decoder)
        self.maxFrameBytes = try decoder.container(keyedBy: CodingKeys.self).decode(Int.self, forKey: .maxFrameBytes)
    }
}

struct ContentAuthorization {
    let clientID: String
    let credential: String

    var metadata: [String: String] {
        ["aa-content-client": clientID, "aa-content-credential": credential]
    }
}

enum DeviceContentError: Error {
    case identityMismatch
    case grantUnavailable
}


private func safeRouter(_ raw: String) -> Bool {
    guard let url = URLComponents(string: raw), let host = url.host, url.user == nil, url.password == nil else { return false }
    if url.scheme == "wss" { return true }
    #if DEBUG
    return url.scheme == "ws" && ["127.0.0.1", "localhost", "[::1]"].contains(host)
    #else
    return false
    #endif
}


@MainActor
private let mobileBootstrapSession = URLSession(configuration: .ephemeral, delegate: AccountRedirects(), delegateQueue: nil)

@MainActor
func withMobileControl<T>(
    server: URL, accessToken: () async throws -> String, call: (MobileControlClient, String) async throws -> T
) async throws -> T {
    let endpoint = server.appending(path: "api/v3/mobile/control-tunnel")
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("Bearer \(try await accessToken())", forHTTPHeaderField: "Authorization")
    let (data, response) = try await mobileBootstrapSession.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw DeviceContentError.grantUnavailable }
    guard http.statusCode == 200 else { throw NativeAccountError.http(http.statusCode) }
    let bootstrap = try JSONDecoder().decode(DeviceTunnelGrant.self, from: data)
    guard bootstrap.tunnel.credential.hasPrefix("mtun_e2e."),
          let key = bootstrap.tunnel.e2eKey, !key.isEmpty, safeRouter(bootstrap.tunnel.routerURL) else {
        throw DeviceContentError.grantUnavailable
    }
    let control = try Mesh(tunnel: bootstrap.tunnel, options: MeshOptions(maxFrameSize: bootstrap.maxFrameBytes, retry: .disabled))
    do {
        let result = try await call(MobileControlClient(control), bootstrap.tunnel.instanceID)
        await control.close()
        return result
    } catch {
        await control.close()
        throw error
    }
}
