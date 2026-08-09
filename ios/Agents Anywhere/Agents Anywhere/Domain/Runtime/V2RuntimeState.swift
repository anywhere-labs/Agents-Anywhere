import Foundation

enum V2RuntimeStatus: String, Codable, Hashable {
    case idle
    case waiting
    case pending
    case running
    case stopping
    case blocked
    case error
    case disconnected
    case unknown
}

struct V2RuntimeSelectionScope: RawRepresentable, Codable, Hashable, ExpressibleByStringLiteral {
    let rawValue: String

    init(rawValue: String) {
        self.rawValue = rawValue
    }

    init(stringLiteral value: String) {
        rawValue = value
    }

    static let model = V2RuntimeSelectionScope(rawValue: "model")
    static let permission = V2RuntimeSelectionScope(rawValue: "permission")
    static let effort = V2RuntimeSelectionScope(rawValue: "effort")
}

struct V2RuntimeState: Codable, Hashable {
    let sessionId: V2SessionID
    let runtime: V2RuntimeID
    let externalSessionId: String?
    let status: V2RuntimeStatus
    let selections: [V2RuntimeSelectionScope: V2SelectionID]
    let statusReason: String?
    let error: V2RuntimeError?
    let metadata: JSONValue
    let updatedSeq: Int
    let createdAt: String
    let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case sessionId
        case runtime
        case externalSessionId
        case status
        case selections
        case statusReason
        case error
        case metadata
        case updatedSeq
        case createdAt
        case updatedAt
    }

    init(
        sessionId: V2SessionID,
        runtime: V2RuntimeID,
        externalSessionId: String?,
        status: V2RuntimeStatus,
        selections: [V2RuntimeSelectionScope: V2SelectionID],
        statusReason: String?,
        error: V2RuntimeError?,
        metadata: JSONValue,
        updatedSeq: Int,
        createdAt: String,
        updatedAt: String
    ) {
        self.sessionId = sessionId
        self.runtime = runtime
        self.externalSessionId = externalSessionId
        self.status = status
        self.selections = selections
        self.statusReason = statusReason
        self.error = error
        self.metadata = metadata
        self.updatedSeq = updatedSeq
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try container.decode(V2SessionID.self, forKey: .sessionId)
        runtime = try container.decode(V2RuntimeID.self, forKey: .runtime)
        externalSessionId = try container.decodeIfPresent(String.self, forKey: .externalSessionId)
        let rawStatus = try container.decodeIfPresent(String.self, forKey: .status) ?? V2RuntimeStatus.unknown.rawValue
        status = V2RuntimeStatus(rawValue: rawStatus) ?? .unknown
        let rawSelections = try container.decodeIfPresent([String: JSONValue].self, forKey: .selections) ?? [:]
        selections = rawSelections.reduce(into: [:]) { result, entry in
            if let selectionId = entry.value.stringValue {
                result[V2RuntimeSelectionScope(rawValue: entry.key)] = selectionId
            }
        }
        statusReason = try container.decodeIfPresent(String.self, forKey: .statusReason)
        error = try container.decodeIfPresent(V2RuntimeError.self, forKey: .error)
        metadata = try container.decodeIfPresent(JSONValue.self, forKey: .metadata) ?? .object([:])
        updatedSeq = try container.decode(Int.self, forKey: .updatedSeq)
        createdAt = try container.decode(String.self, forKey: .createdAt)
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(runtime, forKey: .runtime)
        try container.encodeIfPresent(externalSessionId, forKey: .externalSessionId)
        try container.encode(status.rawValue, forKey: .status)
        let rawSelections = Dictionary(uniqueKeysWithValues: selections.map { scope, value in
            (scope.rawValue, value)
        })
        try container.encode(rawSelections, forKey: .selections)
        try container.encodeIfPresent(statusReason, forKey: .statusReason)
        try container.encodeIfPresent(error, forKey: .error)
        try container.encode(metadata, forKey: .metadata)
        try container.encode(updatedSeq, forKey: .updatedSeq)
        try container.encode(createdAt, forKey: .createdAt)
        try container.encode(updatedAt, forKey: .updatedAt)
    }
}

struct V2RuntimeStateResponse: Decodable, Hashable {
    let state: V2RuntimeState
    let serverTime: String?
}

struct V2RuntimeSelectionUpdateResponse: Decodable, Hashable {
    let ok: Bool
    let state: V2RuntimeState?
    let connectorResult: JSONValue?
    let serverTime: String
}

struct V2RuntimeError: Codable, Hashable {
    let code: String?
    let message: String
}

struct V2RuntimeSelectionUpdateRequest: Encodable, Hashable {
    let selections: [V2RuntimeSelectionScope: V2SelectionID]

    enum CodingKeys: String, CodingKey {
        case selections
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        let rawSelections = Dictionary(uniqueKeysWithValues: selections.map { scope, value in
            (scope.rawValue, value)
        })
        try container.encode(rawSelections, forKey: .selections)
    }
}
