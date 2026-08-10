import Foundation

protocol V2ConnectorAPIProtocol {
    func listConnectors() async throws -> V2ConnectorListResponse
    func createConnector(request: V2ConnectorCreateRequest) async throws -> V2ConnectorCreateResponse
    func connector(connectorId: V2ConnectorID) async throws -> V2ConnectorResponse
    func updateConnector(connectorId: V2ConnectorID, request: V2ConnectorUpdateRequest) async throws -> V2ConnectorResponse
    func deleteConnector(connectorId: V2ConnectorID) async throws
    func revokeConnector(connectorId: V2ConnectorID) async throws -> V2ConnectorRevokeResponse
    func claimPairing(request: V2PairingClaimRequest) async throws -> V2PairingClaimResponse
    func listRuntimes(connectorId: V2ConnectorID) async throws -> V2DeviceRuntimeListResponse
    func discoverRuntimes(connectorId: V2ConnectorID) async throws -> V2DeviceRuntimeListResponse
    func updateRuntimeConfig(
        connectorId: V2ConnectorID,
        runtimeId: V2RuntimeID,
        request: V2RuntimeConfigUpdateRequest
    ) async throws -> V2DeviceRuntime
    func updateRuntimeActive(
        connectorId: V2ConnectorID,
        runtimeId: V2RuntimeID,
        request: V2RuntimeActiveUpdateRequest
    ) async throws -> V2DeviceRuntime
    func deleteRuntimeConfig(connectorId: V2ConnectorID, runtimeId: V2RuntimeID) async throws -> V2DeviceRuntime
    func archiveSessions(
        connectorId: V2ConnectorID,
        request: V2ConnectorSessionArchiveRequest
    ) async throws -> V2ConnectorSessionArchiveResponse
}

struct V2ConnectorAPI: V2ConnectorAPIProtocol {
    let transport: any HTTPTransport

    func listConnectors() async throws -> V2ConnectorListResponse {
        let request = HTTPRequest<EmptyRequestBody, V2ConnectorListResponse>(
            method: .get,
            path: "/connectors"
        )
        return try await transport.send(request)
    }

    func createConnector(request body: V2ConnectorCreateRequest) async throws -> V2ConnectorCreateResponse {
        let request = HTTPRequest<V2ConnectorCreateRequest, V2ConnectorCreateResponse>(
            method: .post,
            path: "/connectors",
            body: body
        )
        return try await transport.send(request)
    }

    func connector(connectorId: V2ConnectorID) async throws -> V2ConnectorResponse {
        let request = HTTPRequest<EmptyRequestBody, V2ConnectorResponse>(
            method: .get,
            path: "/connectors/\(connectorId.v2URLPathComponentEncoded)"
        )
        return try await transport.send(request)
    }

    func updateConnector(
        connectorId: V2ConnectorID,
        request body: V2ConnectorUpdateRequest
    ) async throws -> V2ConnectorResponse {
        let request = HTTPRequest<V2ConnectorUpdateRequest, V2ConnectorResponse>(
            method: .patch,
            path: connectorPath(connectorId),
            body: body
        )
        return try await transport.send(request)
    }

    func deleteConnector(connectorId: V2ConnectorID) async throws {
        let request = HTTPRequest<EmptyRequestBody, EmptyResponse>(
            method: .delete,
            path: connectorPath(connectorId)
        )
        _ = try await transport.send(request)
    }

    func revokeConnector(connectorId: V2ConnectorID) async throws -> V2ConnectorRevokeResponse {
        let request = HTTPRequest<EmptyRequestBody, V2ConnectorRevokeResponse>(
            method: .post,
            path: "\(connectorPath(connectorId))/revoke"
        )
        return try await transport.send(request)
    }

    func claimPairing(request body: V2PairingClaimRequest) async throws -> V2PairingClaimResponse {
        let request = HTTPRequest<V2PairingClaimRequest, V2PairingClaimResponse>(
            method: .post,
            path: "/pairing/claim",
            body: body
        )
        return try await transport.send(request)
    }

    func listRuntimes(connectorId: V2ConnectorID) async throws -> V2DeviceRuntimeListResponse {
        let request = HTTPRequest<EmptyRequestBody, V2DeviceRuntimeListResponse>(
            method: .get,
            path: runtimeCollectionPath(connectorId)
        )
        return try await transport.send(request)
    }

    func discoverRuntimes(connectorId: V2ConnectorID) async throws -> V2DeviceRuntimeListResponse {
        let request = HTTPRequest<EmptyRequestBody, V2DeviceRuntimeListResponse>(
            method: .post,
            path: "\(runtimeCollectionPath(connectorId))/discover"
        )
        return try await transport.send(request)
    }

    func updateRuntimeConfig(
        connectorId: V2ConnectorID,
        runtimeId: V2RuntimeID,
        request body: V2RuntimeConfigUpdateRequest
    ) async throws -> V2DeviceRuntime {
        let request = HTTPRequest<V2RuntimeConfigUpdateRequest, V2DeviceRuntime>(
            method: .put,
            path: runtimePath(connectorId, runtimeId: runtimeId, suffix: "config"),
            body: body
        )
        return try await transport.send(request)
    }

    func updateRuntimeActive(
        connectorId: V2ConnectorID,
        runtimeId: V2RuntimeID,
        request body: V2RuntimeActiveUpdateRequest
    ) async throws -> V2DeviceRuntime {
        let request = HTTPRequest<V2RuntimeActiveUpdateRequest, V2DeviceRuntime>(
            method: .put,
            path: runtimePath(connectorId, runtimeId: runtimeId, suffix: "active"),
            body: body
        )
        return try await transport.send(request)
    }

    func deleteRuntimeConfig(
        connectorId: V2ConnectorID,
        runtimeId: V2RuntimeID
    ) async throws -> V2DeviceRuntime {
        let request = HTTPRequest<EmptyRequestBody, V2DeviceRuntime>(
            method: .delete,
            path: runtimePath(connectorId, runtimeId: runtimeId, suffix: "config")
        )
        return try await transport.send(request)
    }

    func archiveSessions(
        connectorId: V2ConnectorID,
        request body: V2ConnectorSessionArchiveRequest
    ) async throws -> V2ConnectorSessionArchiveResponse {
        let request = HTTPRequest<V2ConnectorSessionArchiveRequest, V2ConnectorSessionArchiveResponse>(
            method: .post,
            path: "\(connectorPath(connectorId))/sessions/archive-all",
            body: body
        )
        return try await transport.send(request)
    }

    private func connectorPath(_ connectorId: V2ConnectorID) -> String {
        "/connectors/\(connectorId.v2URLPathComponentEncoded)"
    }

    private func runtimeCollectionPath(_ connectorId: V2ConnectorID) -> String {
        "\(connectorPath(connectorId))/runtimes"
    }

    private func runtimePath(
        _ connectorId: V2ConnectorID,
        runtimeId: V2RuntimeID,
        suffix: String
    ) -> String {
        "\(runtimeCollectionPath(connectorId))/\(runtimeId.v2URLPathComponentEncoded)/\(suffix)"
    }
}
