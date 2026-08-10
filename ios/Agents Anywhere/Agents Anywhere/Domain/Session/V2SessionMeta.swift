import Foundation

enum V2ConnectorPresence: String, Codable, Hashable {
    case online
    case offline
    case unknown
}

struct V2SessionMeta: Codable, Identifiable, Hashable {
    let id: V2SessionID
    let connectorId: V2ConnectorID
    let runtime: V2RuntimeID
    let externalSessionId: String?
    let title: String?
    let cwd: String?
    let status: V2RuntimeStatus
    let takeover: Bool
    let connectorStatus: V2ConnectorPresence
    let pinned: Bool
    let pinnedAt: String?
    let archived: Bool
    let archivedAt: String?
    let unread: Bool
    let lastReadSeq: Int
    let lastSyncedAt: String?
    let sourceObservedAt: String?
    let lastActivityAt: String?
    let lastItemAt: String?
    let lastItemOrderSeq: Int?
    let sortAt: String?
    let updatedSeq: Int
}

struct V2SessionListResponse: Decodable, Hashable {
    let sessions: [V2SessionMeta]
    let serverTime: String
}

struct V2SessionMetaResponse: Decodable, Hashable {
    let session: V2SessionMeta
    let serverTime: String
}

struct V2SessionMetaPatchRequest: Encodable, Hashable {
    let title: String?
    let pinned: Bool?
    let archived: Bool?
}

struct V2SessionCreateRequest: Encodable, Hashable {
    let connectorId: V2ConnectorID
    let runtime: V2RuntimeID
    let externalSessionId: String?
    let title: String?
    let cwd: String?
    let selections: [V2RuntimeSelectionScope: V2SelectionID]?

    enum CodingKeys: String, CodingKey {
        case connectorId
        case runtime
        case externalSessionId
        case title
        case cwd
        case selections
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(connectorId, forKey: .connectorId)
        try container.encode(runtime, forKey: .runtime)
        try container.encodeIfPresent(externalSessionId, forKey: .externalSessionId)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(cwd, forKey: .cwd)
        let rawSelections = selections?.reduce(into: [String: V2SelectionID]()) { result, entry in
            result[entry.key.rawValue] = entry.value
        }
        try container.encodeIfPresent(rawSelections, forKey: .selections)
    }
}

struct V2InlineAttachment: Encodable, Hashable {
    let fileId: V2AttachmentID
    let name: String
    let mediaType: String
    let size: Int?
    let sha256: String?
    let contentBase64: String
}

struct V2SessionCreateAndStartRequest: Encodable, Hashable {
    let connectorId: V2ConnectorID
    let runtime: V2RuntimeID
    let title: String?
    let cwd: String?
    let content: String
    let selections: [V2RuntimeSelectionScope: V2SelectionID]
    let attachments: [V2InlineAttachment]
    let clientMessageId: String?

    enum CodingKeys: String, CodingKey {
        case connectorId
        case runtime
        case title
        case cwd
        case content
        case selections
        case attachments
        case clientMessageId
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(connectorId, forKey: .connectorId)
        try container.encode(runtime, forKey: .runtime)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(cwd, forKey: .cwd)
        try container.encode(content, forKey: .content)
        let rawSelections = selections.reduce(into: [String: V2SelectionID]()) { result, entry in
            result[entry.key.rawValue] = entry.value
        }
        try container.encode(rawSelections, forKey: .selections)
        try container.encode(attachments, forKey: .attachments)
        try container.encodeIfPresent(clientMessageId, forKey: .clientMessageId)
    }
}

struct V2SessionCreateResponse: Decodable, Hashable {
    let session: V2SessionMeta
    let connectorResult: JSONValue?
    let serverTime: String?
}

struct V2SessionBulkActionResponse: Decodable, Hashable {
    let sessions: [V2SessionMeta]
    let notFound: [V2SessionID]
    let serverTime: String
}
