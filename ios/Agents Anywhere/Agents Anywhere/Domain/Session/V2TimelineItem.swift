import Foundation

enum V2TimelineItemType: String, Codable, Hashable {
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

enum V2TimelineItemStatus: String, Codable, Hashable {
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

enum V2MessageRole: String, Codable, Hashable {
    case user
    case assistant
    case system
    case tool
    case unknown
}

struct V2TimelineItem: Decodable, Identifiable, Hashable {
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
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(V2TimelineItemID.self, forKey: .id)
        sessionId = try container.decode(V2SessionID.self, forKey: .sessionId)
        turnId = try container.decodeIfPresent(V2TurnID.self, forKey: .turnId)
        let rawType = try container.decodeIfPresent(String.self, forKey: .type) ?? V2TimelineItemType.unknown.rawValue
        type = V2TimelineItemType(rawValue: rawType) ?? .unknown
        let rawStatus = try container.decodeIfPresent(String.self, forKey: .status) ?? V2TimelineItemStatus.unknown.rawValue
        status = V2TimelineItemStatus(rawValue: rawStatus) ?? .unknown
        if let rawRole = try container.decodeIfPresent(String.self, forKey: .role) {
            role = V2MessageRole(rawValue: rawRole) ?? .unknown
        } else {
            role = nil
        }
        let rawContent = try container.decodeIfPresent(JSONValue.self, forKey: .content) ?? .object([:])
        content = V2TimelineItemContent(type: type, rawContent: rawContent)
        source = try container.decodeIfPresent(JSONValue.self, forKey: .source) ?? .object([:])
        orderSeq = try container.decodeIfPresent(Int.self, forKey: .orderSeq)
            ?? container.decodeIfPresent(Int.self, forKey: .updatedSeq)
            ?? 0
        revision = try container.decodeIfPresent(Int.self, forKey: .revision) ?? 1
        contentHash = try container.decodeIfPresent(String.self, forKey: .contentHash) ?? ""
        updatedSeq = try container.decodeIfPresent(Int.self, forKey: .updatedSeq) ?? 0
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt) ?? createdAt
        completedAt = try container.decodeIfPresent(String.self, forKey: .completedAt)
    }
}

enum V2TimelineItemContent: Hashable {
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

struct V2MessageContent: Hashable {
    let text: String
    let format: String?
    let attachments: [V2AttachmentContent]
    let raw: JSONValue

    init(rawContent: JSONValue) {
        text = rawContent["text"]?.stringValue ?? rawContent["content"]?.stringValue ?? ""
        format = rawContent["format"]?.stringValue
        attachments = rawContent["attachments"]?.arrayValue?.map(V2AttachmentContent.init(rawContent:)) ?? []
        raw = rawContent
    }
}

struct V2ReasoningContent: Hashable {
    let text: String
    let summary: String?
    let raw: JSONValue

    init(rawContent: JSONValue) {
        text = rawContent["text"]?.stringValue ?? ""
        summary = rawContent["summary"]?.stringValue
        raw = rawContent
    }
}

struct V2ToolContent: Hashable {
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

struct V2FileChangeContent: Hashable {
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

struct V2MarkerContent: Hashable {
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

struct V2ArtifactContent: Hashable {
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

extension JSONValue {
    var arrayValue: [JSONValue]? {
        if case let .array(value) = self {
            return value
        }
        return nil
    }
}
