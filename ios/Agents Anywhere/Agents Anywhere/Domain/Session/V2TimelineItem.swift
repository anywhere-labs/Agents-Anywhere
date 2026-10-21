import Foundation

nonisolated enum V2TimelineItemType: String, Codable, Hashable {
    case turnStart = "turn.start"
    case turnEnd = "turn.end"
    case message
    case reasoning
    case tool
    case fileChange = "file_change"
    case marker
    case artifact
    case attachment
    case system
    case unknown
}

nonisolated enum V2TimelineItemStatus: String, Codable, Hashable {
    case pending
    case running
    case waitingApproval = "waiting_approval"
    case done
    case failed
    case cancelled
    case interrupted
    case hidden
    case unknown
}

nonisolated enum V2MessageRole: String, Codable, Hashable {
    case user
    case assistant
    case system
    case tool
    case unknown
}

nonisolated struct V2TimelineItem: Decodable, Identifiable, Hashable {
    /// Preserve extension fields and unknown wire kinds for diagnostic exports.
    let raw: JSONValue
    let id: V2TimelineItemID
    let sessionId: V2SessionID
    let turnId: V2TurnID?
    let type: V2TimelineItemType
    let status: V2TimelineItemStatus
    let role: V2MessageRole?
    let content: V2TimelineItemContent
    let source: JSONValue
    let orderSeq: Int
    let revision: Int
    let contentHash: String
    let updatedSeq: Int
    let createdAt: String
    let updatedAt: String
    let completedAt: String?
    /// Chat text for this item version: the message body without attachment
    /// markers, or the joined reasoning summaries. Derived once per decode so
    /// presentation ticks never rescan every reply.
    let displayText: String

    enum CodingKeys: String, CodingKey {
        case id
        case sessionId
        case turnId
        case type
        case status
        case role
        case content
        case source
        case orderSeq
        case revision
        case contentHash
        case updatedSeq
        case createdAt
        case updatedAt
        case completedAt
    }

    init(from decoder: Decoder) throws {
        try self.init(json: JSONValue(from: decoder))
    }

    /// Builds an item from an already parsed wire tree. `content` and `source`
    /// share that tree's storage; nothing is re-encoded or parsed twice.
    init(json raw: JSONValue) throws {
        guard case .object = raw else {
            throw DecodingError.typeMismatch(Self.self, .init(codingPath: [], debugDescription: "Timeline item must be an object."))
        }
        func required(_ key: CodingKeys) throws -> String {
            guard let value = raw[key.rawValue]?.stringValue else {
                throw DecodingError.keyNotFound(key, .init(codingPath: [], debugDescription: "Missing '\(key.rawValue)' in timeline item."))
            }
            return value
        }
        self.raw = raw
        id = try required(.id)
        sessionId = try required(.sessionId)
        turnId = raw["turnId"]?.stringValue
        type = raw["type"]?.stringValue.flatMap(V2TimelineItemType.init(rawValue:)) ?? .unknown
        status = raw["status"]?.stringValue.flatMap(V2TimelineItemStatus.init(rawValue:)) ?? .unknown
        role = raw["role"]?.stringValue.map { V2MessageRole(rawValue: $0) ?? .unknown }
        let rawContent = raw["content"].flatMap { $0 == .null ? nil : $0 } ?? .object([:])
        content = V2TimelineItemContent(type: type, rawContent: rawContent)
        source = raw["source"].flatMap { $0 == .null ? nil : $0 } ?? .object([:])
        orderSeq = raw["orderSeq"]?.intValue ?? raw["updatedSeq"]?.intValue ?? 0
        revision = raw["revision"]?.intValue ?? 1
        contentHash = raw["contentHash"]?.stringValue ?? ""
        updatedSeq = raw["updatedSeq"]?.intValue ?? 0
        createdAt = raw["createdAt"]?.stringValue ?? ""
        updatedAt = raw["updatedAt"]?.stringValue ?? createdAt
        completedAt = raw["completedAt"]?.stringValue
        let reasoning = type == .reasoning || type == .system && rawContent["kind"] == .string("reasoning")
        switch content {
        case let .message(value): displayText = TimelineText.message(value.text)
        case let .reasoning(value): displayText = TimelineText.reasoning(value.raw)
        case let .marker(value): displayText = reasoning ? TimelineText.reasoning(value.raw) : ""
        default: displayText = ""
        }
    }

    /// Identity fields reject a changed item before any tree walk. Unchanged
    /// items carried between projections share their wire tree's storage, so
    /// the final `raw` comparison is an identity check rather than a deep walk.
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.revision == rhs.revision && lhs.updatedSeq == rhs.updatedSeq
            && lhs.contentHash == rhs.contentHash && lhs.status == rhs.status && lhs.orderSeq == rhs.orderSeq
            && lhs.raw == rhs.raw
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
        hasher.combine(revision)
        hasher.combine(updatedSeq)
        hasher.combine(contentHash)
    }
}

nonisolated enum V2TimelineItemContent: Hashable {
    case message(V2MessageContent)
    case reasoning(V2ReasoningContent)
    case tool(V2ToolContent)
    case fileChange(V2FileChangeContent)
    case marker(V2MarkerContent)
    case artifact(V2ArtifactContent)
    case attachment(V2AttachmentContent)
    case unknown(JSONValue)

    init(type: V2TimelineItemType, rawContent: JSONValue) {
        switch type {
        case .turnStart, .turnEnd, .system:
            self = .marker(V2MarkerContent(rawContent: rawContent))
        case .message:
            self = .message(V2MessageContent(rawContent: rawContent))
        case .reasoning:
            self = .reasoning(V2ReasoningContent(rawContent: rawContent))
        case .tool:
            self = .tool(V2ToolContent(rawContent: rawContent))
        case .fileChange:
            self = .fileChange(V2FileChangeContent(rawContent: rawContent))
        case .marker:
            self = .marker(V2MarkerContent(rawContent: rawContent))
        case .artifact:
            self = .artifact(V2ArtifactContent(rawContent: rawContent))
        case .attachment:
            self = .attachment(V2AttachmentContent(rawContent: rawContent))
        case .unknown:
            self = .unknown(rawContent)
        }
    }
}

nonisolated struct V2MessageContent: Hashable {
    let text: String
    let format: String?
    let attachments: [V2AttachmentContent]
    let raw: JSONValue

    init(rawContent: JSONValue) {
        text = ["text", "content", "message", "rawText"].compactMap { rawContent[$0]?.stringValue }.first { !$0.isEmpty } ?? ""
        format = rawContent["format"]?.stringValue
        attachments = rawContent["attachments"]?.arrayValue?.map(V2AttachmentContent.init(rawContent:)) ?? []
        raw = rawContent
    }
}

nonisolated struct V2ReasoningContent: Hashable {
    let text: String
    let summary: String?
    let raw: JSONValue

    init(rawContent: JSONValue) {
        text = rawContent["text"]?.stringValue ?? ""
        summary = rawContent["summary"]?.stringValue
        raw = rawContent
    }
}

nonisolated struct V2ToolContent: Hashable {
    let name: String?
    let input: JSONValue?
    let output: JSONValue?
    let raw: JSONValue

    init(rawContent: JSONValue) {
        name = rawContent["name"]?.stringValue ?? rawContent["toolName"]?.stringValue
        input = rawContent["input"]
        output = rawContent["output"]
        raw = rawContent
    }
}

nonisolated struct V2FileChangeContent: Hashable {
    let path: String?
    let action: String?
    let patch: String?
    let changes: [JSONValue]
    let raw: JSONValue

    init(rawContent: JSONValue) {
        path = rawContent["path"]?.stringValue
        action = rawContent["action"]?.stringValue
        patch = rawContent["patch"]?.stringValue
        changes = rawContent["changes"]?.arrayValue ?? []
        raw = rawContent
    }
}

nonisolated struct V2MarkerContent: Hashable {
    let title: String
    let subtitle: String?
    let variant: String?
    let raw: JSONValue

    init(rawContent: JSONValue) {
        title = rawContent["title"]?.stringValue ?? rawContent["text"]?.stringValue ?? "Event"
        subtitle = rawContent["subtitle"]?.stringValue ?? rawContent["description"]?.stringValue
        variant = rawContent["variant"]?.stringValue
        raw = rawContent
    }
}

nonisolated struct V2ArtifactContent: Hashable {
    let title: String?
    let mediaType: String?
    let url: String?
    let raw: JSONValue

    init(rawContent: JSONValue) {
        title = rawContent["title"]?.stringValue ?? rawContent["name"]?.stringValue
        mediaType = rawContent["mediaType"]?.stringValue ?? rawContent["mimeType"]?.stringValue
        url = rawContent["url"]?.stringValue ?? rawContent["openUrl"]?.stringValue
        raw = rawContent
    }
}

nonisolated extension JSONValue {
    nonisolated var arrayValue: [JSONValue]? {
        if case let .array(value) = self {
            return value
        }
        return nil
    }
}
