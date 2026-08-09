import Foundation

struct V2Connector: Decodable, Identifiable, Hashable {
    let id: V2ConnectorID
    let userId: String
    let name: String
    let status: V2ConnectorPresence
    let lastSeenAt: String?
    let createdAt: String
    let updatedAt: String
}

struct V2ConnectorListResponse: Decodable, Hashable {
    let connectors: [V2Connector]
    let serverTime: String
}

struct V2ConnectorResponse: Decodable, Hashable {
    let connector: V2Connector
    let serverTime: String
}

struct V2ConnectorCreateRequest: Encodable, Hashable {
    let name: String
}

struct V2ConnectorCreateResponse: Decodable, Hashable {
    let connector: V2Connector
    let connectorToken: String
    let tokenPrefix: String
}
