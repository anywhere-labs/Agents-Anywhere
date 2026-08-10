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

struct V2ConnectorUpdateRequest: Encodable, Hashable {
    let name: String
}

struct V2ConnectorRevokeResponse: Decodable, Hashable {
    let connector: V2Connector
    let connectorToken: String
    let tokenPrefix: String
    let serverTime: String
}

enum V2ConnectorSessionArchiveScope: String, Encodable, Hashable {
    case active
    case archived
    case all
}

struct V2ConnectorSessionArchiveRequest: Encodable, Hashable {
    let archived: Bool
    let scope: V2ConnectorSessionArchiveScope
}

struct V2ConnectorSessionArchiveResponse: Decodable, Hashable {
    let sessions: [V2SessionMeta]
    let affected: Int
    let serverTime: String
}
