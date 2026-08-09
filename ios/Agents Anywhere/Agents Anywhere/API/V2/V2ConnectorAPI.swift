import Foundation

protocol V2ConnectorAPIProtocol {
    func listConnectors() async throws -> V2ConnectorListResponse
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
}
