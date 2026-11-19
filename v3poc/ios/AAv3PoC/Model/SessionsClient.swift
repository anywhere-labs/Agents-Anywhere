import Foundation

/// The `aa.v3.Sessions` calls the phone makes (see v3poc/protocol/services.ts). The real implementation will be the
/// generated MeshCall client (a separate Swift SDK, not part of this PoC); `MockSessionsClient` replays fixtures.
/// Events and messages stay JSON: the app forwards them to the renderer unchanged and reads only a few fields.
@MainActor
protocol SessionsClient: AnyObject {
    /// Snapshot, then whole replacements (`message` / `session` / `control`). Ends when the stream drops; watch again.
    func watch(id: String) -> AsyncStream<JSON>
    /// Older items before `beforeSeq`.
    func listMessages(id: String, beforeSeq: Int?, limit: Int) async throws -> (messages: [JSON], hasMore: Bool)
    /// Idempotent on `clientMsgId`; returns the message id.
    @discardableResult
    func send(id: String, clientMsgId: String, content: String) async throws -> String
    /// First answer wins; every watcher sees `control.answered`.
    func answer(id: String, requestId: String, optionId: String) async throws
    func stop(id: String) async throws
    /// Returns the updated Session.
    @discardableResult
    func setConfig(id: String, configId: String, value: String) async throws -> JSON
}

nonisolated enum SessionsClientError: LocalizedError {
    case notFound(String)
    case failedPrecondition(String)
    var errorDescription: String? {
        switch self {
        case let .notFound(id): "会话不存在：\(id)"
        case let .failedPrecondition(message): message
        }
    }
}

/// The phone is a remote control with a cache: the latest snapshot plus replaced items per session, in memory only.
/// Reopening a session shows this immediately, then the new watch snapshot replaces it (or only what changed goes to
/// the renderer, see `RendererBridge.show`). Bounded: the most recently used `maxSessions` sessions, the last `maxItems`
/// items of each; a memory warning keeps only the session on screen, and fewer of its items.
@MainActor
final class SessionCache {
    private var states: [String: SessionState] = [:]
    /// Most recently used last.
    private var order: [String] = []
    private(set) var maxSessions = 8
    /// `AA_POC_CACHE_ITEMS=n` overrides it (stress runs that hand the renderer a whole long session).
    private(set) var maxItems = ProcessInfo.processInfo.environment["AA_POC_CACHE_ITEMS"].flatMap(Int.init) ?? 300

    func state(_ id: String) -> SessionState? { states[id] }

    /// Returns the updated state.
    @discardableResult
    func apply(_ event: JSON, to id: String) -> SessionState? {
        if event["type"]?.string == "snapshot" {
            states[id] = SessionState(snapshot: event)
        } else {
            states[id]?.apply(event)
        }
        touch(id)
        // Trim in steps, not on every push, so the rebuild is rare.
        if let state = states[id], state.messages.count > maxItems + maxItems / 3 { states[id] = state.keepingLast(maxItems) }
        return states[id]
    }

    func prepend(older messages: [JSON], hasMore: Bool, to id: String) {
        guard let state = states[id] else { return }
        states[id] = SessionState(session: state.session, messages: messages + state.messages, control: state.control, hasMore: hasMore)
    }

    /// `warning`: keep only `keep` (the session on screen) and its last 120 items, from now on at most 4 sessions.
    /// `critical`: the last 60 items, at most 2 sessions.
    func trim(_ level: String, keep: String?) {
        let critical = level == "critical"
        maxSessions = critical ? 2 : 4
        maxItems = critical ? 60 : 120
        for id in order where id != keep { states[id] = nil }
        order = keep.map { states[$0] == nil ? [] : [$0] } ?? []
        if let keep, let state = states[keep] { states[keep] = state.keepingLast(maxItems) }
    }

    var itemCount: Int { states.values.reduce(0) { $0 + $1.messages.count } }
    var sessionCount: Int { states.count }

    private func touch(_ id: String) {
        guard states[id] != nil else { return }
        if order.last != id {
            order.removeAll { $0 == id }
            order.append(id)
        }
        while order.count > maxSessions { states[order.removeFirst()] = nil }
    }
}
