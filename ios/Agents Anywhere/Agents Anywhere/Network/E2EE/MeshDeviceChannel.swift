import Foundation
import MeshCall

nonisolated protocol E2EEDeviceChannel: AnyObject, Sendable {
    var deviceId: String { get }
    var isOpen: Bool { get async }
    var ready: E2EEChannelReady? { get async }
    func request(_ method: HTTPMethod, path: String, body: Data?) async throws -> E2EETunnelResponse
    func subscribe(sessionId: String, afterCursor: String?) async throws -> (id: String, events: AsyncThrowingStream<Data, Error>)
    func close() async
}

nonisolated extension E2EEDeviceChannel {
    func request(_ method: HTTPMethod, path: String) async throws -> E2EETunnelResponse {
        try await request(method, path: path, body: nil)
    }
}

actor MeshDeviceChannel: E2EEDeviceChannel {
    private let mesh: Mesh
    private let client: ContentClient
    nonisolated let deviceId: String
    private let options: CallOptions
    private(set) var isOpen = true
    var ready: E2EEChannelReady? { nil }

    private init(mesh: Mesh, deviceID: String, clientID: String, secret: String) {
        self.mesh = mesh
        self.client = ContentClient(mesh)
        self.deviceId = deviceID
        self.options = CallOptions(metadata: ["aa-content-client": clientID, "aa-content-credential": secret])
    }

    static func open(bootstrap: EncryptedTunnelGrant, deviceID: String, pin: String, clientID: String, secret: String) async throws -> MeshDeviceChannel {
        let control = try encryptedMesh(bootstrap.tunnel, maxFrameBytes: bootstrap.maxFrameBytes)
        let grant: ContentTunnelGrant
        do {
            grant = try await MobileControlClient(control).issueContentTunnel(instance: bootstrap.tunnel.instanceID, deviceId: deviceID)
        } catch {
            await control.close()
            throw channelError(error)
        }
        await control.close()
        guard grant.instanceID == deviceID, grant.e2eKey == pin else {
            throw E2EEError(code: E2EEError.pinMismatch, message: "Connector public key does not match the pinned key")
        }
        let target = TunnelGrant(
            routerURL: grant.routerURL, credential: grant.credential, instanceID: grant.instanceID,
            tunnelID: grant.tunnelID, e2eKey: pin
        )
        return MeshDeviceChannel(mesh: try encryptedMesh(target, maxFrameBytes: grant.maxFrameBytes),
                                 deviceID: deviceID, clientID: clientID, secret: secret)
    }

    private static func encryptedMesh(_ grant: TunnelGrant, maxFrameBytes: Int) throws -> Mesh {
        guard grant.credential.hasPrefix("mtun_e2e."), let key = grant.e2eKey, !key.isEmpty, maxFrameBytes > 0 else {
            throw E2EEError(code: E2EEError.required, message: "An encrypted MeshCall tunnel is required")
        }
        return try Mesh(tunnel: grant, options: MeshOptions(maxFrameSize: maxFrameBytes))
    }

    func pair(_ request: ContentPairRequest) async throws -> ContentPairResult {
        do {
            return try await client.pair(
                instance: deviceId, clientIdentityPub: request.clientIdentityPub, clientSecret: request.clientSecret,
                label: request.label, pairingId: request.pairingId, pairingSecret: request.pairingSecret, platform: request.platform
            )
        } catch {
            throw Self.channelError(error)
        }
    }

    func request(_ method: HTTPMethod, path: String, body: Data?) async throws -> E2EETunnelResponse {
        let payload = try body.map { try JSONDecoder().decode(MeshCall.JSONValue.self, from: $0) }
        do {
            let result = try await client.request(instance: deviceId, body: payload, method: method.rawValue, path: path, options: options)
            return E2EETunnelResponse(status: result.status, body: try JSONEncoder().encode(result.body))
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            await close()
            throw Self.channelError(error)
        }
    }

    func watchTrust(_ trust: ClientTrustStore) {
        Task { [weak self] in
            guard let self else { return }
            do {
                let events = try await self.client.subscribe(instance: self.deviceId, sessionId: "", stream: "trust", options: self.options)
                for try await event in events {
                    let raw = try JSONEncoder().encode(event)
                    let grant = try JSONDecoder().decode(E2EEDirectoryKeyGrant.self, from: raw)
                    if grant.deviceId == self.deviceId { _ = try trust.updateDirectoryKey(grant) }
                }
            } catch {}
            await self.close()
        }
    }

    func subscribe(sessionId: String, afterCursor: String?) async throws -> (id: String, events: AsyncThrowingStream<Data, Error>) {
        let stream = try await client.subscribe(instance: deviceId, afterCursor: afterCursor, sessionId: sessionId,
                                                stream: "session", options: options)
        let events = AsyncThrowingStream<Data, Error>(bufferingPolicy: .bufferingOldest(2048)) { continuation in
            let task = Task {
                do {
                    for try await event in stream {
                        let encoded = try JSONEncoder().encode(event)
                        if case .dropped = continuation.yield(encoded) { throw HTTPError.streamOverflow }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: Self.channelError(error))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return (UUID().uuidString, events)
    }

    func close() async {
        guard isOpen else { return }
        isOpen = false
        await mesh.close()
    }

    private static func channelError(_ error: Error) -> Error {
        guard let failure = error as? MeshCallError else { return error }
        let reason = failure.details["reason"].flatMap { value -> String? in
            if case let .string(reason) = value { return reason }
            return nil
        }
        return E2EEError(code: reason ?? failure.code.rawValue, message: failure.message)
    }
}

nonisolated struct EncryptedTunnelGrant: Decodable, Sendable {
    let tunnel: TunnelGrant
    let maxFrameBytes: Int

    private enum CodingKeys: String, CodingKey { case maxFrameBytes }

    init(from decoder: any Decoder) throws {
        tunnel = try TunnelGrant(from: decoder)
        maxFrameBytes = try decoder.container(keyedBy: CodingKeys.self).decode(Int.self, forKey: .maxFrameBytes)
    }
}
