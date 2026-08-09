import Foundation

protocol V2ConnectorAPIProtocol {
    func listConnectors() async throws -> V2ConnectorListResponse
    func createConnector(request: V2ConnectorCreateRequest) async throws -> V2ConnectorCreateResponse
    func connector(connectorId: V2ConnectorID) async throws -> V2ConnectorResponse
    func claimPairing(request: V2PairingClaimRequest) async throws -> V2PairingClaimResponse
    func discoverRuntimes(connectorId: V2ConnectorID) async throws -> V2DeviceRuntimeListResponse
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

    func claimPairing(request body: V2PairingClaimRequest) async throws -> V2PairingClaimResponse {
        let request = HTTPRequest<V2PairingClaimRequest, V2PairingClaimResponse>(
            method: .post,
            path: "/pairing/claim",
            body: body
        )
        return try await transport.send(request)
    }

    func discoverRuntimes(connectorId: V2ConnectorID) async throws -> V2DeviceRuntimeListResponse {
        let request = HTTPRequest<EmptyRequestBody, V2DeviceRuntimeListResponse>(
            method: .post,
            path: "/connectors/\(connectorId.v2URLPathComponentEncoded)/runtimes/discover"
        )
        return try await transport.send(request)
    }
}
