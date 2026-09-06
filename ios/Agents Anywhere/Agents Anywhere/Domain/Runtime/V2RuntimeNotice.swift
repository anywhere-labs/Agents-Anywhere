import Foundation

enum V2RuntimeNoticeStatus: String, Codable, Hashable {
    case open
    case responding
    case responseAccepted = "response_accepted"
    case resolving
    case resolved
    case closed
    case expired
    case cancelled
    case failed
    case unknown
}

struct V2RuntimeNotice: Decodable, Identifiable, Hashable {
    let raw: JSONValue
    let noticeId: V2NoticeID
    let type: String
    let sessionId: V2SessionID
    let source: JSONValue
    let title: String
    let message: String?
    let severity: String
    let status: V2RuntimeNoticeStatus
    let interactionType: String?
    let blocking: V2RuntimeNoticeBlocking?
    let responseRequired: Bool
    let actions: [V2RuntimeNoticeAction]
    let context: JSONValue
    let metadata: JSONValue
    let expiresAt: String?
    let revision: Int
    let createdAt: String?
    let resolvedAt: String?

    var id: V2NoticeID { noticeId }

    enum CodingKeys: String, CodingKey {
        case noticeId
        case type
        case sessionId
        case source
        case title
        case message
        case severity
        case status
        case interactionType
        case blocking
        case responseRequired
        case actions
        case context
        case metadata
        case expiresAt
        case revision
        case createdAt
        case resolvedAt
    }

    init(from decoder: Decoder) throws {
        raw = try JSONValue(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        noticeId = try container.decode(V2NoticeID.self, forKey: .noticeId)
        type = try container.decode(String.self, forKey: .type)
        sessionId = try container.decode(V2SessionID.self, forKey: .sessionId)
        source = try container.decodeIfPresent(JSONValue.self, forKey: .source) ?? .object([:])
        title = try container.decode(String.self, forKey: .title)
        message = try container.decodeIfPresent(String.self, forKey: .message)
        severity = try container.decodeIfPresent(String.self, forKey: .severity) ?? "info"
        let rawStatus = try container.decodeIfPresent(String.self, forKey: .status) ?? V2RuntimeNoticeStatus.unknown.rawValue
        status = V2RuntimeNoticeStatus(rawValue: rawStatus) ?? .unknown
        interactionType = try container.decodeIfPresent(String.self, forKey: .interactionType)
        blocking = try container.decodeIfPresent(V2RuntimeNoticeBlocking.self, forKey: .blocking)
        responseRequired = try container.decodeIfPresent(Bool.self, forKey: .responseRequired) ?? false
        actions = try container.decodeIfPresent([V2RuntimeNoticeAction].self, forKey: .actions) ?? []
        context = try container.decodeIfPresent(JSONValue.self, forKey: .context) ?? .object([:])
        metadata = try container.decodeIfPresent(JSONValue.self, forKey: .metadata) ?? .object([:])
        expiresAt = try container.decodeIfPresent(String.self, forKey: .expiresAt)
        revision = try container.decodeIfPresent(Int.self, forKey: .revision) ?? 1
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
        resolvedAt = try container.decodeIfPresent(String.self, forKey: .resolvedAt)
    }
}

struct V2RuntimeNoticeBlocking: Decodable, Hashable {
    let scope: String
    let targetId: String
}

struct V2RuntimeNoticeAction: Decodable, Identifiable, Hashable {
    let actionId: String
    let label: String
    let style: String?
    let input: V2RuntimeNoticeActionInput

    var id: String { actionId }
}

struct V2RuntimeNoticeActionInput: Decodable, Hashable {
    let required: Bool
    let schema: JSONValue?
    let uiSchema: JSONValue?
}

struct V2RuntimeNoticeSnapshot: Decodable, Hashable {
    let notices: [V2RuntimeNotice]
    let serverTime: String?
}

struct V2RuntimeNoticeRespondRequest: Encodable, Hashable {
    let actionId: String
    let input: JSONValue?
}
