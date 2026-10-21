import Foundation

nonisolated struct V2Connector: Codable, Identifiable, Hashable {
    let id: V2ConnectorID
    let userId: String
    let name: String
    let connectorKind: String
    let deviceOs: String?
    let status: V2ConnectorPresence
    let lastSeenAt: String?
    let createdAt: String
    let updatedAt: String
}

nonisolated struct V2ConnectorListResponse: Decodable, Hashable {
    let connectors: [V2Connector]
    let serverTime: String
}

nonisolated struct V2ConnectorResponse: Decodable, Hashable {
    let connector: V2Connector
    let serverTime: String
}

nonisolated struct V2ConnectorCreateRequest: Encodable, Hashable {
    let name: String
}

nonisolated struct V2ConnectorCreateResponse: Decodable, Hashable {
    let connector: V2Connector
    let connectorToken: String
    let tokenPrefix: String
}

nonisolated struct V2ConnectorUpdateRequest: Encodable, Hashable {
    let name: String
}

nonisolated struct V2ConnectorRevokeResponse: Decodable, Hashable, Identifiable {
    let connector: V2Connector
    let connectorToken: String
    let tokenPrefix: String
    let serverTime: String

    var id: V2ConnectorID { connector.id }
}

nonisolated enum V2ConnectorSessionArchiveScope: String, Encodable, Hashable {
    case active
    case archived
    case all
}

nonisolated struct V2ConnectorSessionArchiveRequest: Encodable, Hashable {
    let archived: Bool
    let scope: V2ConnectorSessionArchiveScope
}

nonisolated struct V2ConnectorSessionArchiveResponse: Decodable, Hashable {
    let sessions: [V2SessionMeta]
    let affected: Int
    let serverTime: String
}
