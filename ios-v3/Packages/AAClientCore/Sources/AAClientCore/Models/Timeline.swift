// The aa.v3 conversation model, mirrored from `connector-v3/src/core/timeline.ts` (itself `v3poc/protocol/timeline.ts`,
// modelled on Effi Cloud's `cloud.v1.Conversations`). Same snake_case wire names.
//
// A session is three kinds of state, each pushed whole:
//   Session  – the conversation itself: title, agent, device, cwd, config options.
//   Message  – one item: a user message, or ONE step of an agent's reply. Items of one reply share `turn_id`.
//   Control  – what is happening now: running or idle, waiting approvals, queued messages, usage.
//
// Decoding is open: an unknown part type or enum value is kept (`.unknown`) instead of failing the whole stream,
// so a newer Connector does not break an older app. The WebView receives the raw JSON anyway.

@_exported import MeshCall
import Foundation

// MARK: - Session

/// A runtime setting the agent reports (ACP session config): model, permission mode, reasoning effort…
public struct ConfigOption: Codable, Sendable, Hashable, Identifiable {
    public struct Choice: Codable, Sendable, Hashable, Identifiable {
        public var value: String
        public var name: String
        public var description: String?
        public var group: String?
        public var id: String { value }

        public init(value: String, name: String, description: String? = nil, group: String? = nil) {
            self.value = value
            self.name = name
            self.description = description
            self.group = group
        }
    }

    /// `set_config` id.
    public var id: String
    public var name: String
    public var description: String?
    /// `mode` | `model` | `thought_level` | `model_config` | other. For placement and icon only.
    public var category: String?
    public var current: String
    public var options: [Choice]

    public init(id: String, name: String, description: String? = nil, category: String? = nil, current: String, options: [Choice]) {
        self.id = id
        self.name = name
        self.description = description
        self.category = category
        self.current = current
        self.options = options
    }

    public var currentName: String { options.first { $0.value == current }?.name ?? current }
}

public struct ForkOrigin: Codable, Sendable, Hashable {
    public var sessionID: String
    public var messageID: String
    enum CodingKeys: String, CodingKey {
        case sessionID = "session_id"
        case messageID = "message_id"
    }
}

public struct DeviceRef: Codable, Sendable, Hashable {
    public var id: String
    public var name: String
    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct Session: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var agent: String
    /// The Connector (device) the agent runs on.
    public var device: DeviceRef
    public var cwd: String
    public var branch: String?
    public var createdAt: String
    public var updatedAt: String
    public var messageCount: Int
    /// Empty until the agent has reported its settings.
    public var config: [ConfigOption]
    public var forkedFrom: ForkOrigin?

    enum CodingKeys: String, CodingKey {
        case id, title, agent, device, cwd, branch, config
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case messageCount = "message_count"
        case forkedFrom = "forked_from"
    }

    public init(
        id: String, title: String, agent: String, device: DeviceRef, cwd: String, branch: String? = nil,
        createdAt: String, updatedAt: String, messageCount: Int = 0, config: [ConfigOption] = [], forkedFrom: ForkOrigin? = nil
    ) {
        self.id = id
        self.title = title
        self.agent = agent
        self.device = device
        self.cwd = cwd
        self.branch = branch
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.messageCount = messageCount
        self.config = config
        self.forkedFrom = forkedFrom
    }
}

// MARK: - Parts

public struct ToolPart: Codable, Sendable, Hashable {
    public struct Diff: Codable, Sendable, Hashable {
        public var path: String
        public var oldText: String?
        public var newText: String
        enum CodingKeys: String, CodingKey {
            case path
            case oldText = "old_text"
            case newText = "new_text"
        }
    }

    public struct Location: Codable, Sendable, Hashable {
        public var path: String
        public var line: Int?
    }

    /// ACP toolCallId; `control.pending[].tool_call_id` points here.
    public var id: String
    public var title: String
    /// `read` | `edit` | `delete` | `move` | `search` | `execute` | `think` | `fetch` | `switch_mode` | `other`.
    public var kind: String
    /// `pending` | `in_progress` | `completed` | `failed`.
    public var status: String
    public var input: JSONValue?
    public var output: JSONValue?
    public var diffs: [Diff]?
    public var locations: [Location]?
}

public struct PlanEntry: Codable, Sendable, Hashable {
    public var content: String
    /// `pending` | `in_progress` | `completed`.
    public var status: String
    public var priority: String?
}

public struct SubagentPart: Codable, Sendable, Hashable {
    public var id: String
    public var title: String
    public var description: String?
    public var agentType: String?
    public var status: String
    public var startedAt: String
    public var endedAt: String?
    public var toolCount: Int
    public var result: String?
    public var background: Bool?
    public var error: String?

    enum CodingKeys: String, CodingKey {
        case id, title, description, status, result, background, error
        case agentType = "agent_type"
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case toolCount = "tool_count"
    }
}

public struct AttachmentPart: Codable, Sendable, Hashable {
    public var path: String
    public var name: String
    public var mime: String
    public var size: Int

    public init(path: String, name: String, mime: String, size: Int) {
        self.path = path
        self.name = name
        self.mime = mime
        self.size = size
    }

    public var isImage: Bool { mime.hasPrefix("image/") }
}

public struct CompactionPart: Codable, Sendable, Hashable {
    public var id: String
    public var status: String
    public var trigger: String?
    public var summary: String?
    public var tokensBefore: Int?
    public var tokensAfter: Int?
    public var at: String
    public var endedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, status, trigger, summary, at
        case tokensBefore = "tokens_before"
        case tokensAfter = "tokens_after"
        case endedAt = "ended_at"
    }
}

/// One part of a message. Assistant items carry exactly one; user messages carry text then attachments.
public enum Part: Codable, Sendable, Hashable {
    case text(String)
    case thinking(String)
    case tool(ToolPart)
    case plan([PlanEntry])
    case subagent(SubagentPart)
    case image(AttachmentPart)
    case file(AttachmentPart)
    case compaction(CompactionPart)
    case unknown(JSONValue)

    private enum TypeKey: String, CodingKey { case type, text, entries }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: TypeKey.self)
        let type = try container.decodeIfPresent(String.self, forKey: .type)
        switch type {
        case "text": self = .text(try container.decode(String.self, forKey: .text))
        case "thinking": self = .thinking(try container.decode(String.self, forKey: .text))
        case "tool": self = .tool(try ToolPart(from: decoder))
        case "plan": self = .plan(try container.decode([PlanEntry].self, forKey: .entries))
        case "subagent": self = .subagent(try SubagentPart(from: decoder))
        case "image": self = .image(try AttachmentPart(from: decoder))
        case "file": self = .file(try AttachmentPart(from: decoder))
        case "compaction": self = .compaction(try CompactionPart(from: decoder))
        default: self = .unknown(try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .text(let text):
            var container = encoder.container(keyedBy: TypeKey.self)
            try container.encode("text", forKey: .type)
            try container.encode(text, forKey: .text)
        case .thinking(let text):
            var container = encoder.container(keyedBy: TypeKey.self)
            try container.encode("thinking", forKey: .type)
            try container.encode(text, forKey: .text)
        case .plan(let entries):
            var container = encoder.container(keyedBy: TypeKey.self)
            try container.encode("plan", forKey: .type)
            try container.encode(entries, forKey: .entries)
        case .tool(let part): try Self.encodeTagged(part, "tool", to: encoder)
        case .subagent(let part): try Self.encodeTagged(part, "subagent", to: encoder)
        case .image(let part): try Self.encodeTagged(part, "image", to: encoder)
        case .file(let part): try Self.encodeTagged(part, "file", to: encoder)
        case .compaction(let part): try Self.encodeTagged(part, "compaction", to: encoder)
        case .unknown(let value): try value.encode(to: encoder)
        }
    }

    private static func encodeTagged<T: Encodable>(_ value: T, _ type: String, to encoder: Encoder) throws {
        guard case .object(var object) = try JSONValue(encoding: value) else { return }
        object["type"] = .string(type)
        try JSONValue.object(object).encode(to: encoder)
    }

    /// Plain text of a text-like part, for previews and the offline cache.
    public var plainText: String? {
        switch self {
        case .text(let text): return text
        case .thinking(let text): return text
        case .tool(let tool): return tool.title
        default: return nil
        }
    }
}

// MARK: - Messages

public enum Role: String, Codable, Sendable, Hashable {
    case user
    case assistant
}

/// One timeline item. User and assistant items share this shape; role-specific fields are optional.
public struct Message: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var createdAt: String
    /// Position in the session from 0.
    public var seq: Int
    /// Finished; the item will not change again.
    public var done: Bool
    public var role: Role
    public var parts: [Part]
    // user
    public var clientMsgID: String?
    public var author: String?
    public var steered: Bool?
    public var rewindable: Bool?
    // assistant
    public var turnID: String?
    public var subagentID: String?
    public var interrupted: Bool?
    public var autonomous: Bool?

    enum CodingKeys: String, CodingKey {
        case id, seq, done, role, parts, author, steered, rewindable, interrupted, autonomous
        case createdAt = "created_at"
        case clientMsgID = "client_msg_id"
        case turnID = "turn_id"
        case subagentID = "subagent_id"
    }

    public init(
        id: String, createdAt: String, seq: Int, done: Bool, role: Role, parts: [Part], clientMsgID: String? = nil,
        author: String? = nil, turnID: String? = nil
    ) {
        self.id = id
        self.createdAt = createdAt
        self.seq = seq
        self.done = done
        self.role = role
        self.parts = parts
        self.clientMsgID = clientMsgID
        self.author = author
        self.turnID = turnID
    }

    /// The message's readable text (text parts joined).
    public var text: String {
        parts.compactMap { if case .text(let text) = $0 { text } else { nil } }.joined(separator: "\n")
    }
}

// MARK: - Control

public struct PendingRequest: Codable, Sendable, Hashable, Identifiable {
    public struct Option: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var name: String
        /// `allow_once` | `allow_always` | `reject_once` | `reject_always`.
        public var kind: String
        public init(id: String, name: String, kind: String) {
            self.id = id
            self.name = name
            self.kind = kind
        }

        public var isAllow: Bool { kind.hasPrefix("allow") }
    }

    public var requestID: String
    /// The tool item waiting on it.
    public var messageID: String
    public var toolCallID: String
    public var title: String
    public var options: [Option]
    public var id: String { requestID }

    enum CodingKeys: String, CodingKey {
        case title, options
        case requestID = "request_id"
        case messageID = "message_id"
        case toolCallID = "tool_call_id"
    }

    public init(requestID: String, messageID: String, toolCallID: String, title: String, options: [Option]) {
        self.requestID = requestID
        self.messageID = messageID
        self.toolCallID = toolCallID
        self.title = title
        self.options = options
    }
}

public struct QueuedMessage: Codable, Sendable, Hashable, Identifiable {
    public var clientMsgID: String
    public var author: String
    public var content: String
    public var attachments: [Part]?
    public var id: String { clientMsgID }

    enum CodingKeys: String, CodingKey {
        case author, content, attachments
        case clientMsgID = "client_msg_id"
    }
}

public struct AnsweredRequest: Codable, Sendable, Hashable {
    public var requestID: String
    public var by: String
    public var device: String?
    public var optionID: String
    public var at: String
    enum CodingKeys: String, CodingKey {
        case by, device, at
        case requestID = "request_id"
        case optionID = "option_id"
    }
}

public struct BackgroundTask: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var kind: String
    public var title: String
    public var status: String
    public var startedAt: String
    public var endedAt: String?
    public var exitCode: Int?
    public var outputTail: String?
    enum CodingKeys: String, CodingKey {
        case id, kind, title, status
        case startedAt = "started_at"
        case endedAt = "ended_at"
        case exitCode = "exit_code"
        case outputTail = "output_tail"
    }
}

public struct Usage: Codable, Sendable, Hashable {
    public var used: Double?
    public var size: Double?
    public var model: String?
    public var updatedAt: String
    enum CodingKeys: String, CodingKey {
        case used, size, model
        case updatedAt = "updated_at"
    }
}

public struct ControlCapabilities: Codable, Sendable, Hashable {
    public var compact: Bool
    public var compactInstructions: Bool?
    enum CodingKeys: String, CodingKey {
        case compact
        case compactInstructions = "compact_instructions"
    }
}

public struct Control: Codable, Sendable, Hashable {
    /// `idle` | `running` | `error` | `disconnected`.
    public var state: String
    /// How a message sent while running is delivered: `native` | `interrupt` | `none`.
    public var steer: String
    public var error: String?
    public var pending: [PendingRequest]
    public var queued: [QueuedMessage]
    public var answered: [AnsweredRequest]?
    public var background: [BackgroundTask]?
    public var usage: Usage?
    public var capabilities: ControlCapabilities?

    public init(state: String = "idle", steer: String = "none", error: String? = nil, pending: [PendingRequest] = [], queued: [QueuedMessage] = []) {
        self.state = state
        self.steer = steer
        self.error = error
        self.pending = pending
        self.queued = queued
    }

    public static let idle = Control()
    public var isRunning: Bool { state == "running" }
}

// MARK: - watch

/// One `aa.v3.Sessions/watch` event. Every event is the whole current value of what changed; replace by id.
public enum WatchEvent: Sendable, Hashable {
    case snapshot(session: Session, messages: [Message], hasMore: Bool, control: Control)
    case message(Message)
    case session(Session)
    case control(Control)
    case unknown(String)

    public init(json: JSONValue) throws {
        let type = json["type"]?.stringValue
        switch type {
        case "snapshot":
            self = .snapshot(
                session: try (json["session"] ?? .null).decode(as: Session.self),
                messages: try (json["messages"] ?? .array([])).decode(as: [Message].self),
                hasMore: json["has_more"]?.boolValue ?? false,
                control: try (json["control"] ?? .null).decode(as: Control.self))
        case "message": self = .message(try (json["message"] ?? .null).decode(as: Message.self))
        case "session": self = .session(try (json["session"] ?? .null).decode(as: Session.self))
        case "control": self = .control(try (json["control"] ?? .null).decode(as: Control.self))
        default: self = .unknown(type ?? "")
        }
    }
}

/// A watch event as received: the raw JSON (forwarded unchanged to the WebView) and its typed form.
public struct WatchUpdate: Sendable {
    public let raw: JSONValue
    public let event: WatchEvent
}

// MARK: - Sidebar (list / watch_list)

public struct SessionSummary: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var agent: String
    public var deviceID: String
    /// The project is the working folder.
    public var cwd: String
    /// `idle` | `running` | `error` | `disconnected` | `waiting`.
    public var state: String
    public var unread: Bool
    public var pinned: Bool
    public var updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, title, agent, cwd, state, unread, pinned
        case deviceID = "device_id"
        case updatedAt = "updated_at"
    }

    public init(
        id: String, title: String, agent: String, deviceID: String, cwd: String, state: String = "idle", unread: Bool = false,
        pinned: Bool = false, updatedAt: String
    ) {
        self.id = id
        self.title = title
        self.agent = agent
        self.deviceID = deviceID
        self.cwd = cwd
        self.state = state
        self.unread = unread
        self.pinned = pinned
        self.updatedAt = updatedAt
    }

    /// Project name: the last path component of the working folder.
    public var projectName: String { ProjectPath.name(of: cwd) }
}

/// `aa.v3.Sessions/list`; also `SessionListPayload` in `contracts/aa-v3/1.0/control.schema.json`.
public struct SessionList: Codable, Sendable, Hashable {
    public var sessions: [SessionSummary]
    public var projects: [String]
    public init(sessions: [SessionSummary] = [], projects: [String] = []) {
        self.sessions = sessions
        self.projects = projects
    }
}

/// `aa.v3.Sessions/watch_list` item.
public struct SessionListEvent: Codable, Sendable, Hashable {
    /// `snapshot` | `update`.
    public var type: String
    public var sessions: [SessionSummary]
    public var projects: [String]
    public var list: SessionList { SessionList(sessions: sessions, projects: projects) }
}

public struct ListMessagesResponse: Codable, Sendable {
    public var messages: [JSONValue]
    public var hasMore: Bool
    public var nextCursor: String?
    enum CodingKeys: String, CodingKey {
        case messages
        case hasMore = "has_more"
        case nextCursor = "next_cursor"
    }
}

public struct SendResponse: Codable, Sendable, Hashable {
    public var messageID: String
    public var sessionID: String
    /// `started` | `steered` | `queued`.
    public var delivered: String
    public var replyText: String?
    enum CodingKeys: String, CodingKey {
        case delivered
        case messageID = "message_id"
        case sessionID = "session_id"
        case replyText = "reply_text"
    }
}

public enum Delivery: String, Codable, Sendable {
    case auto
    case steer
    case queue
}

public enum ProjectPath {
    public static func name(of cwd: String) -> String {
        let trimmed = cwd.hasSuffix("/") && cwd.count > 1 ? String(cwd.dropLast()) : cwd
        let last = trimmed.split(separator: "/").last.map(String.init) ?? trimmed
        return last.isEmpty ? cwd : last
    }
}
