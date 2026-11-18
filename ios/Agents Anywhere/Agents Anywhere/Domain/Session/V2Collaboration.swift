import Foundation

/// Protocol 1.2 `SessionView.origin`: the Agent session that created this one.
/// Decoding never fails; a malformed or unknown origin keeps only what it can read.
nonisolated struct V2SessionOrigin: Codable, Hashable {
    let kind: String?
    let bySessionId: V2SessionID?
    let byDeviceId: V2ConnectorID?
    let depth: Int?

    init(kind: String?, bySessionId: V2SessionID?, byDeviceId: V2ConnectorID? = nil, depth: Int? = nil) {
        self.kind = kind; self.bySessionId = bySessionId; self.byDeviceId = byDeviceId; self.depth = depth
    }

    enum CodingKeys: String, CodingKey { case kind, bySessionId, byDeviceId, depth }

    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: CodingKeys.self)
        kind = (try? container?.decodeIfPresent(String.self, forKey: .kind)) ?? nil
        bySessionId = (try? container?.decodeIfPresent(String.self, forKey: .bySessionId)) ?? nil
        byDeviceId = (try? container?.decodeIfPresent(String.self, forKey: .byDeviceId)) ?? nil
        depth = (try? container?.decodeIfPresent(Int.self, forKey: .depth)) ?? nil
    }

    /// The creating session when the origin is a known Agent origin.
    var agentSessionId: V2SessionID? {
        guard kind == "agent", let bySessionId, !bySessionId.isEmpty else { return nil }
        return bySessionId
    }
}

nonisolated enum V2SupervisionState: String, Codable, Hashable {
    case active
    case paused
    case ended
    case unknown

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

nonisolated enum V2SupervisionCreator: String, Codable, Hashable {
    case human
    case agent
    case unknown

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

/// Protocol 1.2 `SupervisionEdge`. Decoding never fails, so one malformed edge
/// cannot reject the session; `isValid` tells presentation which edges to use.
nonisolated struct V2SupervisionEdge: Codable, Hashable {
    let supervisionId: String
    let supervisorSessionId: V2SessionID
    let targetSessionId: V2SessionID
    let state: V2SupervisionState
    let createdBy: V2SupervisionCreator

    init(supervisionId: String, supervisorSessionId: V2SessionID, targetSessionId: V2SessionID,
         state: V2SupervisionState, createdBy: V2SupervisionCreator) {
        self.supervisionId = supervisionId; self.supervisorSessionId = supervisorSessionId
        self.targetSessionId = targetSessionId; self.state = state; self.createdBy = createdBy
    }

    enum CodingKeys: String, CodingKey { case supervisionId, supervisorSessionId, targetSessionId, state, createdBy }

    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: CodingKeys.self)
        func text(_ key: CodingKeys) -> String { ((try? container?.decodeIfPresent(String.self, forKey: key)) ?? nil) ?? "" }
        supervisionId = text(.supervisionId)
        supervisorSessionId = text(.supervisorSessionId)
        targetSessionId = text(.targetSessionId)
        state = V2SupervisionState(rawValue: text(.state)) ?? .unknown
        createdBy = V2SupervisionCreator(rawValue: text(.createdBy)) ?? .unknown
    }

    var isValid: Bool { !supervisionId.isEmpty && !supervisorSessionId.isEmpty && !targetSessionId.isEmpty && state != .unknown }
}

/// `content.author` of a user message that a person did not type (protocol 1.2 `MessageAuthor`).
nonisolated struct V2MessageAuthor: Hashable {
    enum Kind: String, Hashable { case agent, supervision }
    let kind: Kind
    let sessionId: V2SessionID?
    let deviceId: V2ConnectorID?
    let supervisionId: String?

    /// Nil when the value is absent or its kind is unknown.
    init?(_ raw: JSONValue?) {
        guard let raw, let kind = raw["kind"]?.stringValue.flatMap(Kind.init(rawValue:)) else { return nil }
        self.kind = kind
        sessionId = raw["sessionId"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        deviceId = raw["deviceId"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        supervisionId = raw["supervisionId"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// `content.collabTool` of a tool item: which collaboration tool ran and the session it acted on.
nonisolated struct V2CollabToolRef: Hashable {
    let tool: String
    let sessionId: V2SessionID?

    init?(_ raw: JSONValue?) {
        guard let raw, let tool = raw["tool"]?.stringValue, !tool.isEmpty else { return nil }
        self.tool = tool
        sessionId = raw["sessionId"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// A `system` item with `content.kind == "collab_escalation"`: an Agent asks the person to decide.
nonisolated struct V2CollabEscalation: Hashable {
    static let kind = "collab_escalation"
    let question: String
    let context: String?
    let fromSessionId: V2SessionID?
    let targetSessionId: V2SessionID?

    init?(_ raw: JSONValue?) {
        guard let raw, raw["kind"]?.stringValue == Self.kind else { return nil }
        question = raw["question"]?.stringValue ?? ""
        context = raw["context"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        fromSessionId = raw["fromSessionId"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        targetSessionId = raw["targetSessionId"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
    }
}

extension V2TimelineItem {
    /// Set on user messages an Agent or a supervision wake sent.
    nonisolated var messageAuthor: V2MessageAuthor? {
        guard type == .message, case let .message(content) = content else { return nil }
        return content.author
    }
    nonisolated var collabTool: V2CollabToolRef? {
        guard type == .tool, case let .tool(content) = content else { return nil }
        return content.collabTool
    }
    nonisolated var collabEscalation: V2CollabEscalation? {
        guard type == .system, case let .marker(content) = content else { return nil }
        return content.escalation
    }
}

nonisolated extension KeyedDecodingContainer {
    /// Synthesized `Decodable` conformances pick this overload for supervision edge
    /// lists: a value that is not an array reads as absent instead of failing the session.
    func decodeIfPresent(_ type: [V2SupervisionEdge].Type, forKey key: Key) throws -> [V2SupervisionEdge]? {
        guard contains(key) else { return nil }
        return try? decode([V2SupervisionEdge].self, forKey: key)
    }
}
