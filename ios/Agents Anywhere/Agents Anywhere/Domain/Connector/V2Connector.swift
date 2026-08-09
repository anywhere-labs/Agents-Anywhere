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
