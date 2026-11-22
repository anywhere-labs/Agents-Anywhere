// Offline cache. The Server stores no conversation data and devices go offline, so the app keeps what it last saw:
// the device list, each device's session list and recent conversation snapshots. Offline devices show the cache
// read-only (stale). Files live under Application Support, per account, excluded from backups.

import Foundation

/// A conversation as the WebView and the native controls see it, reduced from `watch` events (raw JSON kept so
/// cached content can be handed to the WebView unchanged).
public struct ConversationState: Sendable {
    public var session: Session?
    public var sessionRaw: JSONValue?
    public var control: Control = .idle
    public var controlRaw: JSONValue?
    /// Ordered by `seq`.
    public private(set) var messages: [JSONValue] = []
    public var hasMore = false
    private var indexByID: [String: Int] = [:]

    public init() {}

    /// Apply one `watch` event. Every event is the whole current value of what changed.
    public mutating func apply(_ update: WatchUpdate) {
        let raw = update.raw
        switch update.event {
        case .snapshot(let session, _, let hasMore, let control):
            self.session = session
            sessionRaw = raw["session"]
            self.control = control
            controlRaw = raw["control"]
            self.hasMore = hasMore
            replaceMessages(raw["messages"]?.arrayValue ?? [])
        case .message:
            if let message = raw["message"] { upsert(message) }
        case .session(let session):
            self.session = session
            sessionRaw = raw["session"]
        case .control(let control):
            self.control = control
            controlRaw = raw["control"]
        case .unknown:
            break
        }
    }

    public mutating func replaceMessages(_ messages: [JSONValue]) {
        self.messages = messages.sorted { Self.seq($0) < Self.seq($1) }
        reindex()
    }

    /// Older messages from `list_messages`, prepended.
    public mutating func prepend(_ older: [JSONValue], hasMore: Bool) {
        let known = Set(indexByID.keys)
        let fresh = older.filter { !known.contains($0["id"]?.stringValue ?? "") }
        messages = (fresh + messages).sorted { Self.seq($0) < Self.seq($1) }
        self.hasMore = hasMore
        reindex()
    }

    mutating func upsert(_ message: JSONValue) {
        guard let id = message["id"]?.stringValue else { return }
        if let index = indexByID[id] {
            messages[index] = message
        } else if let last = messages.last, Self.seq(last) > Self.seq(message) {
            messages.append(message)
            messages.sort { Self.seq($0) < Self.seq($1) }
            reindex()
        } else {
            indexByID[id] = messages.count
            messages.append(message)
        }
    }

    private mutating func reindex() {
        indexByID = [:]
        for (index, message) in messages.enumerated() {
            if let id = message["id"]?.stringValue { indexByID[id] = index }
        }
    }

    static func seq(_ message: JSONValue) -> Int64 { message["seq"]?.intValue ?? 0 }

    public var oldestSeq: Int? { messages.first.map { Int(Self.seq($0)) } }

    /// Typed messages (for previews and tests).
    public var typedMessages: [Message] { messages.compactMap { try? $0.decode(as: Message.self) } }
}

public struct CachedConversation: Codable, Sendable {
    public var session: JSONValue
    public var messages: [JSONValue]
    public var control: JSONValue
    public var savedAt: Date

    enum CodingKeys: String, CodingKey {
        case session, messages, control
        case savedAt = "saved_at"
    }

    public init(session: JSONValue, messages: [JSONValue], control: JSONValue, savedAt: Date = Date()) {
        self.session = session
        self.messages = messages
        self.control = control
        self.savedAt = savedAt
    }

    public init?(_ state: ConversationState, keepLast: Int = 200) {
        guard let session = state.sessionRaw else { return nil }
        self.init(session: session, messages: Array(state.messages.suffix(keepLast)), control: state.controlRaw ?? .object([:]))
    }

    public var typedSession: Session? { try? session.decode(as: Session.self) }
}

public actor LocalCache {
    public let directory: URL
    private let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    public init(directory: URL) {
        self.directory = directory
    }

    /// `Application Support/aa-v3/<account id>/`.
    public static func forAccount(_ accountID: String) -> LocalCache {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let safe = accountID.filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }
        return LocalCache(directory: base.appendingPathComponent("aa-v3", isDirectory: true).appendingPathComponent(safe, isDirectory: true))
    }

    private func url(_ name: String) -> URL {
        directory.appendingPathComponent(name)
    }

    private func write<T: Encodable>(_ value: T, to name: String) {
        do {
            let file = url(name)
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try encoder.encode(value)
            #if os(iOS)
            try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            #else
            try data.write(to: file, options: .atomic)
            #endif
            var root = directory
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? root.setResourceValues(values)
        } catch {
            // A cache write failing must never break the live view.
        }
    }

    private func read<T: Decodable>(_ type: T.Type, from name: String) -> T? {
        guard let data = try? Data(contentsOf: url(name)) else { return nil }
        return try? decoder.decode(T.self, from: data)
    }

    private static func fileName(_ id: String) -> String {
        Base64URL.encode(Data(id.utf8))
    }

    public func saveDevices(_ devices: [DeviceRecord]) { write(devices, to: "devices.json") }
    public func devices() -> [DeviceRecord] { read([DeviceRecord].self, from: "devices.json") ?? [] }

    public func saveSessionList(_ list: SessionList, deviceID: String) {
        write(list, to: "sessions/\(Self.fileName(deviceID)).json")
    }

    public func sessionList(deviceID: String) -> SessionList? {
        read(SessionList.self, from: "sessions/\(Self.fileName(deviceID)).json")
    }

    public func allSessionLists(deviceIDs: [String]) -> [String: SessionList] {
        var lists: [String: SessionList] = [:]
        for id in deviceIDs { if let list = sessionList(deviceID: id) { lists[id] = list } }
        return lists
    }

    public func saveConversation(_ conversation: CachedConversation, sessionID: String) {
        write(conversation, to: "conversations/\(Self.fileName(sessionID)).json")
    }

    public func conversation(sessionID: String) -> CachedConversation? {
        read(CachedConversation.self, from: "conversations/\(Self.fileName(sessionID)).json")
    }

    public func clear() {
        try? FileManager.default.removeItem(at: directory)
    }
}
