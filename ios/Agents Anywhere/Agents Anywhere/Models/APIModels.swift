import Foundation

enum UserRole: String, Codable, Hashable {
    case admin
    case member
}

struct AuthConfig: Decodable {
    let needsBootstrap: Bool
    let registrationOpen: Bool
    let oauthRegistrationOpen: Bool
    let oauthEnabled: Bool
    let oauthProviderLabel: String?
    let setupTokenExpiresAt: String?
    let serverTime: String
}

struct AuthResponse: Codable, Hashable {
    let userId: String
    let role: UserRole
    let accessToken: String
    let tokenType: String?
    let serverTime: String
}

struct AuthMe: Codable {
    let userId: String
    let role: UserRole
    let disabled: Bool
    let avatar: String?
    let serverTime: String
}

struct HealthResponse: Decodable {
    let status: String
    let serverTime: String
}

struct MobileLoginPayload: Decodable, Hashable {
    let type: String
    let version: Int
    let webUrl: String
    let userId: String
    let loginToken: String
    let expiresAt: String
}

struct MobileLoginRequest: Encodable {
    let userId: String
    let loginToken: String
    let deviceName: String?
}

struct MobileLoginExchangeRequest: Encodable {
    let userId: String
    let loginToken: String
}

struct MobileLoginStatusRequest: Encodable {
    let loginToken: String
}

struct MobileLoginExchangeResponse: Decodable {
    let auth: AuthResponse
    let refreshToken: String
    let expiresAt: String
    let serverTime: String
}

struct MobileLoginStatusResponse: Decodable {
    let status: String
    let userId: String?
    let deviceName: String?
    let expiresAt: String?
    let requestedAt: String?
    let approvedAt: String?
    let serverTime: String
}

struct ConnectorListResponse: Decodable {
    let connectors: [ConnectorSummary]
    let serverTime: String
}

struct ConnectorSummary: Decodable, Identifiable, Hashable {
    let id: String
    let userId: String
    let name: String
    let status: String
    let lastSeenAt: String?
    let createdAt: String
    let updatedAt: String
}

struct SessionListResponse: Decodable {
    let sessions: [SessionSummary]
    let serverTime: String
}

struct SessionSummary: Decodable, Identifiable, Hashable {
    let id: String
    let connectorId: String
    let runtime: String
    let externalSessionId: String?
    let title: String?
    let cwd: String?
    let status: String
    let connectorStatus: String
    let takeover: Bool
    let archived: Bool
    let pinned: Bool
    let unread: Bool
    let lastReadSeq: Int
    let lastSyncedAt: String?
    let sourceObservedAt: String?
    let lastActivityAt: String?
    let lastItemAt: String?
    let lastItemOrderSeq: Int?
    let sortAt: String?
    let updatedSeq: Int
    let effectiveRunMode: String?
    let runtimeSettings: JSONValue?
    let runtimeSettingsOverride: JSONValue?
}

enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case let .string(value):
            try container.encode(value)
        case let .number(value):
            try container.encode(value)
        case let .bool(value):
            try container.encode(value)
        case let .object(value):
            try container.encode(value)
        case let .array(value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }

    var stringValue: String? {
        switch self {
        case let .string(value):
            return value
        case let .number(value):
            return String(value)
        case let .bool(value):
            return String(value)
        default:
            return nil
        }
    }

    var displayString: String {
        switch self {
        case let .string(value):
            return value
        case let .number(value):
            return String(value)
        case let .bool(value):
            return String(value)
        case let .array(value):
            return value.map(\.displayString).joined(separator: ", ")
        case let .object(value):
            if let detail = value["detail"]?.displayString {
                return detail
            }
            if let message = value["message"]?.displayString {
                return message
            }
            return "Request failed"
        case .null:
            return "Request failed"
        }
    }

    subscript(key: String) -> JSONValue? {
        if case let .object(object) = self {
            return object[key]
        }
        return nil
    }
}

struct TimelineItem: Decodable, Identifiable, Hashable {
    let id: String
    let sessionId: String
    let turnId: String?
    let type: String
    let status: String
    let role: String?
    let content: JSONValue
    let source: JSONValue
    let orderSeq: Int
    let revision: Int
    let contentHash: String
    let updatedSeq: Int
    let createdAt: String
    let updatedAt: String
    let completedAt: String?
}

struct Approval: Decodable, Identifiable, Hashable {
    let id: String
    let sessionId: String
    let turnId: String?
    let status: String
    let kind: String
    let targetItemId: String?
    let title: String
    let description: String?
    let payload: JSONValue
    let choices: [String]
    let source: JSONValue
    let updatedSeq: Int
    let createdAt: String
    let resolvedAt: String?
}

struct SessionStateResponse: Decodable {
    let session: SessionSummary
    let items: [TimelineItem]
    let approvals: [Approval]
    let nextSeq: Int
    let hasMore: Bool
    let serverTime: String
}

struct SessionResponse: Decodable {
    let session: SessionSummary
    let serverTime: String
}

struct TakeoverResponse: Decodable {
    let session: SessionSummary
}

struct RuntimeSettingsResponse: Decodable {
    let connectorId: String?
    let sessionId: String?
    let runtime: String
    let settings: JSONValue
    let runtimeSettings: JSONValue?
    let runtimeSettingsOverride: JSONValue?
    let effectiveRunMode: String?
    let defaultRunModeConfigured: Bool
    let schemaVersion: Int
    let serverTime: String
}

struct RuntimeSettingsPatchRequest: Encodable {
    let settings: [String: JSONValue]
}

struct RuntimeConfigSchemaResponse: Decodable {
    let runtime: String
    let schema: RuntimeConfigSchema
    let serverTime: String
}

struct RuntimeConfigSchema: Decodable {
    let runtime: String
    let schemaVersion: Int
    let fields: [RuntimeConfigField]
}

struct RuntimeConfigField: Decodable, Identifiable {
    let key: String
    let label: String
    let type: String
    let description: String?
    let options: [RuntimeConfigOption]?
    let runtimeOptionsSource: String?
    let visibleWhen: JSONValue?
    let allowSessionOverride: Bool
    let hidden: Bool?
    let fields: [RuntimeConfigField]?

    var id: String { key }
}

struct RuntimeConfigOption: Decodable, Identifiable {
    let value: JSONValue
    let label: String
    let description: String?

    var id: String { value.stringValue ?? label }
}

struct RpcResponsePayload: Decodable {
    let ok: Bool?
    let result: JSONValue?
    let error: String?
}

enum ApprovalResolveStatus: String, Encodable {
    case approved
    case approvedForSession = "approved_for_session"
    case rejected
    case cancelled
}

struct ApprovalResolveRequest: Encodable {
    let status: ApprovalResolveStatus
}

struct AttachmentRef: Encodable, Hashable {
    let fileId: String
}

struct UploadedAttachment: Codable, Identifiable, Hashable {
    let fileId: String
    let sessionId: String
    let name: String
    let mediaType: String
    let size: Int
    let createdAt: String
    let downloadUrl: String?
    let openUrl: String?
    let platformOpenUrl: String?

    var id: String { fileId }

    var resolvedOpenUrl: String? {
        openUrl ?? platformOpenUrl
    }

    enum CodingKeys: String, CodingKey {
        case fileId
        case sessionId
        case name
        case mediaType
        case size
        case createdAt
        case downloadUrl
        case openUrl
        case platformOpenUrl
    }

    init(
        fileId: String,
        sessionId: String,
        name: String,
        mediaType: String,
        size: Int,
        createdAt: String,
        downloadUrl: String?,
        openUrl: String? = nil,
        platformOpenUrl: String? = nil,
    ) {
        self.fileId = fileId
        self.sessionId = sessionId
        self.name = name
        self.mediaType = mediaType
        self.size = size
        self.createdAt = createdAt
        self.downloadUrl = downloadUrl
        self.openUrl = openUrl
        self.platformOpenUrl = platformOpenUrl
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        fileId = try container.decode(String.self, forKey: .fileId)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        name = try container.decode(String.self, forKey: .name)
        mediaType = try container.decode(String.self, forKey: .mediaType)
        size = try container.decode(Int.self, forKey: .size)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        downloadUrl = try container.decodeIfPresent(String.self, forKey: .downloadUrl)
        openUrl = try container.decodeIfPresent(String.self, forKey: .openUrl)
        platformOpenUrl = try container.decodeIfPresent(String.self, forKey: .platformOpenUrl)
    }
}

struct UserUploadResponse: Decodable {
    let attachments: [UploadedAttachment]
    let serverTime: String
}

struct AttachmentUpload: Hashable {
    let id = UUID()
    let name: String
    let mediaType: String
    let data: Data
}

struct MessageCreateRequest: Encodable {
    let content: String
    let attachments: [AttachmentRef]?
    let clientMessageId: String?

    init(content: String, attachments: [AttachmentRef]? = nil, clientMessageId: String? = nil) {
        self.content = content
        self.attachments = attachments
        self.clientMessageId = clientMessageId
    }
}

struct APIErrorResponse: Decodable {
    let detail: JSONValue

    var message: String {
        return detail.displayString
    }
}
