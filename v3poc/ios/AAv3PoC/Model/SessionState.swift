import Foundation

/// One waiting approval, read from `control.pending[i]`.
nonisolated struct PendingRequest: Equatable, Sendable, Identifiable {
    struct Option: Equatable, Sendable, Identifiable {
        let id: String
        let name: String
        /// ACP: allow_once | allow_always | reject_once | reject_always.
        let kind: String
        var isReject: Bool { kind.hasPrefix("reject") }
    }
    let requestID: String
    let messageID: String
    let title: String
    let options: [Option]
    var id: String { requestID }

    init?(_ json: JSON?) {
        guard let json, let id = json["request_id"]?.string else { return nil }
        requestID = id
        messageID = json["message_id"]?.string ?? ""
        title = json["title"]?.string ?? ""
        options = (json["options"]?.array ?? []).compactMap { option in
            guard let id = option["id"]?.string else { return nil }
            return Option(id: id, name: option["name"]?.string ?? id, kind: option["kind"]?.string ?? "allow_once")
        }
    }
}

/// A v3 `ConfigOption` (model, permission mode, reasoning effort…), rendered generically by the options sheet.
nonisolated struct ConfigOption: Identifiable, Equatable, Sendable {
    struct Value: Identifiable, Equatable, Sendable {
        let value: String
        let name: String
        let description: String?
        var id: String { value }
    }
    let id: String
    let name: String
    let category: String?
    let current: String
    let options: [Value]

    init?(_ json: JSON) {
        guard let id = json["id"]?.string else { return nil }
        self.id = id
        name = json["name"]?.string ?? id
        category = json["category"]?.string
        current = json["current"]?.string ?? ""
        options = (json["options"]?.array ?? []).compactMap { option in
            guard let value = option["value"]?.string else { return nil }
            return Value(value: value, name: option["name"]?.string ?? value, description: option["description"]?.string)
        }
    }

    var currentName: String { options.first { $0.value == current }?.name ?? current }
}

/// What a `watch` stream leaves behind: the latest Session, Control and items, each replaced whole by id.
/// Used by the mock "computer" (the source of truth, which also assigns `seq`) and by the phone's `SessionCache`.
nonisolated struct SessionState: Sendable {
    var session: JSON
    var control: JSON
    private(set) var messages: [JSON] = []
    var hasMore: Bool
    private var index: [String: Int] = [:]
    private var nextSeq = 0

    init(session: JSON, messages: [JSON], control: JSON, hasMore: Bool) {
        self.session = session
        self.control = control
        self.hasMore = hasMore
        for message in messages { apply(message: message, assignSeq: true) }
    }

    /// From a `snapshot` watch event.
    init?(snapshot event: JSON) {
        guard event["type"]?.string == "snapshot", let session = event["session"] else { return nil }
        self.init(session: session, messages: event["messages"]?.array ?? [], control: event["control"] ?? [:],
                  hasMore: event["has_more"]?.bool ?? false)
    }

    var snapshot: JSON {
        ["type": "snapshot", "session": session, "messages": .array(messages), "has_more": .bool(hasMore), "control": control]
    }

    /// Applies one watch event; returns it as watchers must see it (`assignSeq`: the source gives new items a `seq`;
    /// `stamp`: the replayer also sets `created_at` to now the first time an id appears and keeps it afterwards).
    @discardableResult
    mutating func apply(_ event: JSON, assignSeq: Bool = false, stamp: Bool = false) -> JSON {
        switch event["type"]?.string {
        case "snapshot":
            if let state = SessionState(snapshot: event) { self = state }
        case "message":
            guard let message = event["message"] else { return event }
            return ["type": "message", "message": apply(message: message, assignSeq: assignSeq, stamp: stamp)]
        case "session":
            if let session = event["session"] { self.session = session }
        case "control":
            if let control = event["control"] { self.control = control }
        default: break
        }
        return event
    }

    /// Seq (and with `stamp`, `created_at`): the first time an id appears it takes the next position / the current
    /// time; later pushes keep it.
    @discardableResult
    private mutating func apply(message: JSON, assignSeq: Bool, stamp: Bool = false) -> JSON {
        var message = message
        guard let id = message["id"]?.string else { return message }
        if let position = index[id] {
            if let seq = messages[position]["seq"] { message["seq"] = seq }
            if stamp, let created = messages[position]["created_at"] { message["created_at"] = created }
            messages[position] = message
        } else {
            let seq = message["seq"]?.int ?? nextSeq
            if assignSeq || message["seq"] == nil { message["seq"] = .number(Double(seq)) }
            if stamp { message["created_at"] = .string(Self.now()) }
            index[id] = messages.count
            messages.append(message)
            nextSeq = max(nextSeq, seq + 1)
        }
        return message
    }

    static func now() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    /// The last `count` items (has_more set when some were dropped); older ones come back through `listMessages`.
    func keepingLast(_ count: Int) -> SessionState {
        guard messages.count > count else { return self }
        return SessionState(session: session, messages: Array(messages.suffix(count)), control: control, hasMore: true)
    }

    func message(_ id: String) -> JSON? { index[id].map { messages[$0] } }
    var unfinishedMessages: [JSON] { messages.filter { $0["done"]?.bool == false } }

    // MARK: What native reads

    var activity: SessionActivity { .init(control: control) }
    var isRunning: Bool { control["state"]?.string == "running" }
    var pending: [PendingRequest] { (control["pending"]?.array ?? []).compactMap(PendingRequest.init) }
    var config: [ConfigOption] { (session["config"]?.array ?? []).compactMap(ConfigOption.init) }
    var usage: (used: Double, size: Double)? {
        guard let used = control["usage"]?["used"]?.double, let size = control["usage"]?["size"]?.double, size > 0 else { return nil }
        return (used, size)
    }
}
