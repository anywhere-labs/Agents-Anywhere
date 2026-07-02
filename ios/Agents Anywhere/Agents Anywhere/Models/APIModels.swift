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
    let runtimeCapabilities: DeviceAgentsState?
    let createdAt: String
    let updatedAt: String

    var attachedRuntimeNames: [String] {
        runtimeCapabilities?.attached.keys.sorted() ?? []
    }

    var canStartSession: Bool {
        status == "online" && !attachedRuntimeNames.isEmpty
    }
}

struct DeviceAgentsState: Decodable, Hashable {
    let version: Int?
    let lastDiscoveredAt: String?
    let attached: [String: AttachedAgentView]
    let disabled: [String]?

    enum CodingKeys: String, CodingKey {
        case version
        case lastDiscoveredAt
        case attached
        case disabled
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decodeIfPresent(Int.self, forKey: .version)
        lastDiscoveredAt = try container.decodeIfPresent(String.self, forKey: .lastDiscoveredAt)
        attached = try container.decodeOrDefault([String: AttachedAgentView].self, forKey: .attached, default: [:])
        disabled = try container.decodeIfPresent([String].self, forKey: .disabled)
    }
}

struct AttachedAgentView: Decodable, Hashable {
    let report: [String: JSONValue]?
    let attachedAt: String?
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

    init(
        id: String,
        sessionId: String,
        turnId: String?,
        type: String,
        status: String,
        role: String?,
        content: JSONValue,
        source: JSONValue,
        orderSeq: Int,
        revision: Int,
        contentHash: String,
        updatedSeq: Int,
        createdAt: String,
        updatedAt: String,
        completedAt: String?,
    ) {
        self.id = id
        self.sessionId = sessionId
        self.turnId = turnId
        self.type = type
        self.status = status
        self.role = role
        self.content = content
        self.source = source
        self.orderSeq = orderSeq
        self.revision = revision
        self.contentHash = contentHash
        self.updatedSeq = updatedSeq
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.completedAt = completedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        turnId = try container.decodeIfPresent(String.self, forKey: .turnId)
        type = try container.decode(String.self, forKey: .type)
        status = try container.decode(String.self, forKey: .status)
        role = try container.decodeIfPresent(String.self, forKey: .role)
        content = try container.decodeOrDefault(JSONValue.self, forKey: .content, default: .emptyObject)
        source = try container.decodeOrDefault(JSONValue.self, forKey: .source, default: .emptyObject)
        orderSeq = try container.decodeIfPresent(Int.self, forKey: .orderSeq)
            ?? container.decodeIfPresent(Int.self, forKey: .updatedSeq)
            ?? 0
        revision = try container.decodeOrDefault(Int.self, forKey: .revision, default: 1)
        contentHash = try container.decodeOrDefault(String.self, forKey: .contentHash, default: "")
        updatedSeq = try container.decodeOrDefault(Int.self, forKey: .updatedSeq, default: 0)
        createdAt = try container.decodeOrDefault(String.self, forKey: .createdAt, default: "")
        updatedAt = try container.decodeOrDefault(String.self, forKey: .updatedAt, default: createdAt)
        completedAt = try container.decodeIfPresent(String.self, forKey: .completedAt)
    }
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

    enum CodingKeys: String, CodingKey {
        case id
        case sessionId
        case turnId
        case status
        case kind
        case targetItemId
        case title
        case description
        case payload
        case choices
        case source
        case updatedSeq
        case createdAt
        case resolvedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        sessionId = try container.decode(String.self, forKey: .sessionId)
        turnId = try container.decodeIfPresent(String.self, forKey: .turnId)
        status = try container.decodeOrDefault(String.self, forKey: .status, default: "pending")
        kind = try container.decodeOrDefault(String.self, forKey: .kind, default: "unknown")
        targetItemId = try container.decodeIfPresent(String.self, forKey: .targetItemId)
        title = try container.decodeOrDefault(String.self, forKey: .title, default: "Approval")
        description = try container.decodeIfPresent(String.self, forKey: .description)
        payload = try container.decodeOrDefault(JSONValue.self, forKey: .payload, default: .emptyObject)
        choices = try container.decodeOrDefault([String].self, forKey: .choices, default: [])
        source = try container.decodeOrDefault(JSONValue.self, forKey: .source, default: .emptyObject)
        updatedSeq = try container.decodeOrDefault(Int.self, forKey: .updatedSeq, default: 0)
        createdAt = try container.decodeOrDefault(String.self, forKey: .createdAt, default: "")
        resolvedAt = try container.decodeIfPresent(String.self, forKey: .resolvedAt)
    }
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

struct SessionCreateRequest: Encodable {
    let connectorId: String
    let runtime: String
    let title: String?
    let cwd: String?
    let approvalPolicy: String?
    let sandbox: String?
}

struct SessionCreateResponse: Decodable {
    let session: SessionSummary
    let connectorResult: JSONValue?
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

    enum CodingKeys: String, CodingKey {
        case connectorId
        case sessionId
        case runtime
        case settings
        case runtimeSettings
        case runtimeSettingsOverride
        case effectiveRunMode
        case defaultRunModeConfigured
        case schemaVersion
        case serverTime
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        connectorId = try container.decodeIfPresent(String.self, forKey: .connectorId)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        runtime = try container.decodeOrDefault(String.self, forKey: .runtime, default: "")
        settings = try container.decodeOrDefault(JSONValue.self, forKey: .settings, default: .emptyObject)
        runtimeSettings = try container.decodeIfPresent(JSONValue.self, forKey: .runtimeSettings)
        runtimeSettingsOverride = try container.decodeIfPresent(JSONValue.self, forKey: .runtimeSettingsOverride)
        effectiveRunMode = try container.decodeIfPresent(String.self, forKey: .effectiveRunMode)
        defaultRunModeConfigured = try container.decodeOrDefault(Bool.self, forKey: .defaultRunModeConfigured, default: false)
        schemaVersion = try container.decodeOrDefault(Int.self, forKey: .schemaVersion, default: 0)
        serverTime = try container.decodeOrDefault(String.self, forKey: .serverTime, default: "")
    }
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

    enum CodingKeys: String, CodingKey {
        case key
        case label
        case type
        case description
        case options
        case runtimeOptionsSource
        case visibleWhen
        case allowSessionOverride
        case hidden
        case fields
    }

    init(
        key: String,
        label: String,
        type: String,
        description: String?,
        options: [RuntimeConfigOption]?,
        runtimeOptionsSource: String?,
        visibleWhen: JSONValue?,
        allowSessionOverride: Bool,
        hidden: Bool?,
        fields: [RuntimeConfigField]?,
    ) {
        self.key = key
        self.label = label
        self.type = type
        self.description = description
        self.options = options
        self.runtimeOptionsSource = runtimeOptionsSource
        self.visibleWhen = visibleWhen
        self.allowSessionOverride = allowSessionOverride
        self.hidden = hidden
        self.fields = fields
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        key = try container.decodeOrDefault(String.self, forKey: .key, default: "")
        label = try container.decodeOrDefault(String.self, forKey: .label, default: key)
        type = try container.decodeOrDefault(String.self, forKey: .type, default: "string")
        description = try container.decodeIfPresent(String.self, forKey: .description)
        options = try container.decodeIfPresent([RuntimeConfigOption].self, forKey: .options)
        runtimeOptionsSource = try container.decodeIfPresent(String.self, forKey: .runtimeOptionsSource)
        visibleWhen = try container.decodeIfPresent(JSONValue.self, forKey: .visibleWhen)
        allowSessionOverride = try container.decodeOrDefault(Bool.self, forKey: .allowSessionOverride, default: true)
        hidden = try container.decodeIfPresent(Bool.self, forKey: .hidden)
        fields = try container.decodeIfPresent([RuntimeConfigField].self, forKey: .fields)
    }

    func withOptions(_ nextOptions: [RuntimeConfigOption]) -> RuntimeConfigField {
        RuntimeConfigField(
            key: key,
            label: label,
            type: type,
            description: description,
            options: nextOptions,
            runtimeOptionsSource: runtimeOptionsSource,
            visibleWhen: visibleWhen,
            allowSessionOverride: allowSessionOverride,
            hidden: hidden,
            fields: fields,
        )
    }
}

struct RuntimeConfigOption: Decodable, Identifiable {
    let value: JSONValue
    let label: String
    let description: String?

    var id: String { value.stringValue ?? label }
}

struct RpcResponse<Result: Decodable>: Decodable {
    let ok: Bool?
    let result: Result
    let error: String?
}

struct RpcResponsePayload: Decodable {
    let ok: Bool?
    let result: JSONValue?
    let error: String?
}

struct FsListRequest: Encodable {
    let root: String
    let path: String
}

struct FsListResult: Decodable, Hashable {
    let path: String
    let entries: [FsEntry]
    let truncated: Bool?
}

struct FsEntry: Decodable, Identifiable, Hashable {
    let name: String
    let path: String
    let type: String
    let size: Int?

    var id: String { path }
    var isDirectory: Bool { type == "directory" }
    var isFile: Bool { type == "file" }
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

struct AttachmentUpload: Identifiable, Hashable {
    let id: UUID
    let name: String
    let mediaType: String
    let fileURL: URL
    let size: Int

    init(id: UUID = UUID(), name: String, mediaType: String, fileURL: URL, size: Int) {
        self.id = id
        self.name = name
        self.mediaType = mediaType
        self.fileURL = fileURL
        self.size = size
    }

    static func temporary(name: String, mediaType: String, data: Data) throws -> AttachmentUpload {
        let id = UUID()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("AgentsAnywhereUploads", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let fileURL = directory.appendingPathComponent("\(id.uuidString)-\(name.temporaryUploadFilename)")
        try data.write(to: fileURL, options: [.atomic])
        return AttachmentUpload(id: id, name: name, mediaType: mediaType, fileURL: fileURL, size: data.count)
    }
}

private extension String {
    var temporaryUploadFilename: String {
        let disallowed = CharacterSet(charactersIn: "/\\:")
        return components(separatedBy: disallowed)
            .filter { !$0.isEmpty }
            .joined(separator: "-")
    }
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

private extension JSONValue {
    static var emptyObject: JSONValue { .object([:]) }
}

private extension KeyedDecodingContainer {
    func decodeOrDefault<Value: Decodable>(
        _ type: Value.Type,
        forKey key: Key,
        default defaultValue: @autoclosure () -> Value,
    ) throws -> Value {
        try decodeIfPresent(type, forKey: key) ?? defaultValue()
    }
}
