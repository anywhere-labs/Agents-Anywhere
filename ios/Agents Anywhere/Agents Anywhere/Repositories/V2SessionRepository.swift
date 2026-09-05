import Foundation

nonisolated struct V2SessionCachePolicy {
    var maximumSessions = 8
    var maximumTimelineItems = 1000
    var catalogLifetime: TimeInterval = 30
}

/// One repository per authenticated server/account. Views observe values and invoke
/// operations; this layer owns request coalescing, bounded caches and live recovery.
@MainActor
final class V2SessionRepository {
    let scope: V2ClientScope
    private let detail: V2SessionDetailService
    private let interactions: V2RuntimeInteractionService
    private let policy: V2SessionCachePolicy
    private let now: () -> Date
    private let sleep: (Duration) async throws -> Void
    private var entries: [V2SessionID: Entry] = [:]
    private var accessCounter = 0
    private var suspended = false
    private(set) var network = V2NetworkStatus()

    init(
        scope: V2ClientScope,
        detail: V2SessionDetailService,
        interactions: V2RuntimeInteractionService,
        policy: V2SessionCachePolicy = V2SessionCachePolicy(),
        now: @escaping () -> Date = Date.init,
        sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.scope = scope
        self.detail = detail
        self.interactions = interactions
        self.policy = policy
        self.now = now
        self.sleep = sleep
    }

    var cachedSessionIDs: Set<V2SessionID> { Set(entries.keys) }

    func session(id: V2SessionID) -> V2SessionModel {
        let entry = entry(for: id)
        evict(protecting: entry)
        return entry.model
    }

    func cached(sessionId: V2SessionID) -> V2SessionData? {
        guard let entry = entries[sessionId] else { return nil }
        touch(entry)
        return entry.projection?.data
    }

    /// Returns cached durable content immediately. Observe to keep live facts fresh.
    func load(sessionId: V2SessionID) async throws -> V2SessionData {
        let entry = entry(for: sessionId)
        if let data = entry.projection?.data { return data }
        try requireNetwork()
        return try await hydrate(entry)
    }

    /// Multiple observers share one socket; removing the last observer closes it.
    func observe(sessionId: V2SessionID) -> AsyncStream<V2SessionObservation> {
        let entry = entry(for: sessionId)
        let observerID = UUID()
        return AsyncStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            entry.observers[observerID] = continuation
            continuation.yield(observation(entry))
            continuation.onTermination = { [weak self, weak entry] _ in
                Task { @MainActor in
                    guard let self, let entry else { return }
                    entry.observers.removeValue(forKey: observerID)
                    if entry.observers.isEmpty {
                        self.stop(entry)
                        self.evict()
                    }
                }
            }
            start(entry)
        }
    }

    /// Explicit refresh replaces the aggregate and then re-establishes live recovery.
    func refresh(sessionId: V2SessionID) async throws -> V2SessionData {
        try requireNetwork()
        let entry = entry(for: sessionId)
        stop(entry)
        entry.loadTask?.cancel()
        entry.loadTask = nil
        entry.readVersion += 1
        entry.historyTask?.cancel()
        entry.historyTask = nil
        defer { if isCurrent(entry) { start(entry) } }
        return try await hydrate(entry)
    }

    func loadOlder(sessionId: V2SessionID, limit: Int = 100) async throws -> V2SessionData {
        try requireNetwork()
        _ = try await load(sessionId: sessionId)
        let entry = entry(for: sessionId)
        if let task = entry.historyTask { return try await task.value }
        guard let data = entry.projection?.data,
              data.hasOlderItems, let before = data.items.first?.orderSeq else {
            return entry.projection!.data
        }
        let version = entry.readVersion
        let task = Task { [self] in
            defer { if entry.readVersion == version { entry.historyTask = nil } }
            let page = try await detail.loadOlderItems(sessionId: sessionId, beforeOrderSeq: before, limit: limit)
            try requireCurrent(entry, version: version)
            entry.projection?.applyHistory(page)
            emit(entry)
            return entry.projection!.data
        }
        entry.historyTask = task
        return try await task.value
    }

    func loadLatest(sessionId: V2SessionID, limit: Int = 100) async throws -> V2SessionData {
        try requireNetwork()
        _ = try await load(sessionId: sessionId)
        let entry = entry(for: sessionId)
        entry.readVersion += 1
        entry.historyTask?.cancel()
        entry.historyTask = nil
        let version = entry.readVersion
        let page = try await detail.latestItems(sessionId: sessionId, limit: limit)
        try requireCurrent(entry, version: version)
        entry.projection?.applyLatest(page)
        emit(entry)
        return entry.projection!.data
    }

    func catalogs(sessionId: V2SessionID, force: Bool = false) async throws -> V2SessionCatalogs {
        let entry = entry(for: sessionId)
        if !force, let cached = entry.catalogs, let readAt = entry.catalogReadAt,
           now().timeIntervalSince(readAt) < policy.catalogLifetime { return cached }
        try requireNetwork()
        if let task = entry.catalogTask { return try await task.value }
        let version = entry.catalogVersion
        let task = Task { [self] in
            defer {
                if entry.catalogVersion == version { entry.catalogTask = nil }
                evict()
            }
            let catalogs = try await detail.catalogs(sessionId: sessionId)
            try requireCurrent(entry)
            guard version == entry.catalogVersion else { throw CacheError.invalidated }
            entry.catalogs = catalogs
            entry.catalogReadAt = now()
            evict()
            return catalogs
        }
        entry.catalogTask = task
        return try await task.value
    }

    func send(sessionId: V2SessionID, content: String, attachmentIDs: [V2AttachmentID] = [], clientMessageID: String) async throws -> V2RuntimeActionResponse {
        try requireNetwork()
        let entry = entry(for: sessionId)
        let response = try await detail.sendMessage(sessionId: sessionId, content: content, attachmentIds: attachmentIDs, clientMessageId: clientMessageID)
        try requireCurrent(entry)
        // Timeline echoes reconcile by clientMessageId; sending never refetches the snapshot.
        return response
    }

    func steer(sessionId: V2SessionID, content: String, attachmentIDs: [V2AttachmentID] = [], clientMessageID: String) async throws -> V2RuntimeActionResponse {
        try requireNetwork()
        let entry = entry(for: sessionId)
        let response = try await detail.steer(sessionId: sessionId, content: content, attachmentIds: attachmentIDs, clientMessageId: clientMessageID)
        try requireCurrent(entry)
        return response
    }

    func interrupt(sessionId: V2SessionID) async throws {
        try requireNetwork()
        let entry = entry(for: sessionId)
        _ = try await detail.interrupt(sessionId: sessionId)
        try requireCurrent(entry)
    }

    func setTakeover(sessionId: V2SessionID, enabled: Bool) async throws {
        try requireNetwork()
        let entry = entry(for: sessionId)
        let session = try await detail.setTakeover(sessionId: sessionId, enabled: enabled)
        try requireCurrent(entry)
        entry.projection?.applyMeta(session)
        entry.projection?.markStale()
        emit(entry)
        try await reconcile(entry)
    }

    func setSelection(sessionId: V2SessionID, scope: V2RuntimeSelectionScope, selectionId: V2SelectionID?) async throws {
        try requireNetwork()
        let entry = entry(for: sessionId)
        let state = try await detail.updateSelection(sessionId: sessionId, scope: scope, selectionId: selectionId)
        try requireCurrent(entry)
        if let state { entry.projection?.applyState(state) }
        invalidateCatalogs(entry)
        emit(entry)
    }

    func respond(sessionId: V2SessionID, noticeId: V2NoticeID, actionId: String, input: JSONValue? = nil) async throws {
        try requireNetwork()
        let entry = entry(for: sessionId)
        _ = try await interactions.respond(sessionId: sessionId, noticeId: noticeId, actionId: actionId, input: input)
        try requireCurrent(entry)
        // Response acceptance is not notice resolution; wait for authoritative live facts.
        entry.projection?.markStale()
        emit(entry)
        try await reconcile(entry)
    }

    func sync(sessionId: V2SessionID) async throws {
        try requireNetwork()
        let entry = entry(for: sessionId)
        _ = try await detail.sync(sessionId: sessionId)
        try requireCurrent(entry)
        try await reconcile(entry)
    }

    func applyMetadata(_ sessions: [V2SessionMeta]) {
        for session in sessions {
            guard let entry = entries[session.id] else { continue }
            let previous = entry.projection?.data.session
            entry.projection?.applyMeta(session)
            if session.connectorStatus != .online || previous?.effectiveRuntimeId != session.effectiveRuntimeId {
                invalidateCatalogs(entry)
            }
            emit(entry)
        }
    }

    func suspend() {
        suspended = true
        for entry in entries.values { stop(entry); emit(entry) }
    }

    func resume() {
        suspended = false
        for entry in entries.values { start(entry) }
    }

    func updateConnectivity(_ status: V2NetworkStatus) {
        let wasOffline = network.availability == .offline
        network = status
        for entry in entries.values {
            if status.availability == .offline {
                stop(entry)
                entry.readVersion += 1
                entry.loadTask?.cancel()
                entry.loadTask = nil
                entry.historyTask?.cancel()
                entry.historyTask = nil
                entry.connection = .offline
            } else if wasOffline {
                start(entry)
            }
            emit(entry)
        }
    }

    private func requireNetwork() throws {
        if network.availability == .offline {
            throw V2ClientFailure(kind: .offline, message: "You are offline. Cached content is still available.")
        }
    }

    func remove(sessionIds: [V2SessionID]) {
        for id in sessionIds {
            guard let entry = entries.removeValue(forKey: id) else { continue }
            dispose(entry)
        }
    }

    /// Cancellation plus identity checks prevent late responses from repopulating a signed-out cache.
    func reset() {
        let old = Array(entries.values)
        entries.removeAll()
        for entry in old { dispose(entry) }
    }

    private func hydrate(_ entry: Entry) async throws -> V2SessionData {
        if let task = entry.loadTask { return try await task.value }
        entry.readVersion += 1
        entry.historyTask?.cancel()
        entry.historyTask = nil
        let version = entry.readVersion
        let task = Task { [self] in
            defer {
                if entry.readVersion == version { entry.loadTask = nil }
                evict()
            }
            let snapshot = try await detail.load(sessionId: entry.id)
            try requireCurrent(entry, version: version)
            guard snapshot.session.id == entry.id else { throw CacheError.invalidated }
            entry.projection = V2SessionProjection(snapshot: snapshot, maximumItems: policy.maximumTimelineItems)
            invalidateCatalogs(entry)
            entry.error = nil
            emit(entry)
            evict()
            return entry.projection!.data
        }
        entry.loadTask = task
        return try await task.value
    }

    private func start(_ entry: Entry) {
        guard isCurrent(entry), !suspended, network.availability != .offline,
              !entry.observers.isEmpty, entry.connectionTask == nil else { return }
        let connectionID = UUID()
        entry.connectionID = connectionID
        entry.connectionTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if entry.connectionID == connectionID { entry.connectionTask = nil }
            }
            var attempt = 0
            while self.isCurrent(entry), entry.connectionID == connectionID, !Task.isCancelled {
                do {
                    entry.connection = attempt == 0 ? .connecting : .reconnecting
                    self.emit(entry)
                    _ = try await self.load(sessionId: entry.id)
                    let events = try await self.detail.updates(sessionId: entry.id, clientId: "ios-session-\(connectionID)")
                    for try await event in events {
                        try self.requireCurrent(entry)
                        guard entry.connectionID == connectionID else { return }
                        if event.type == "session.subscribed" {
                            // The socket is registered before recovery, closing the snapshot/subscribe race.
                            try await self.reconcile(entry)
                            try self.requireCurrent(entry)
                            guard entry.connectionID == connectionID else { return }
                            entry.connection = .connected
                            attempt = 0
                            self.emit(entry)
                        } else {
                            try await self.receive(event, entry: entry)
                        }
                    }
                    throw CacheError.connectionClosed
                } catch {
                    guard self.isCurrent(entry), entry.connectionID == connectionID, !Task.isCancelled else { return }
                    entry.projection?.markStale()
                    self.invalidateCatalogs(entry)
                    let failure = V2ClientFailure(error)
                    entry.error = failure
                    guard failure.permitsAutomaticReconnect else {
                        entry.connection = .failed(failure.message)
                        self.emit(entry)
                        return
                    }
                    entry.connection = .reconnecting
                    self.emit(entry)
                    attempt += 1
                    do { try await self.sleep(.seconds(min(1 << min(attempt - 1, 4), 15))) }
                    catch { return }
                }
            }
        }
    }

    private func receive(_ event: V2SessionEvent, entry: Entry) async throws {
        guard event.sessionId == entry.id else { return }
        if let pending = entry.loadTask { _ = try await pending.value }
        if let pending = entry.recoveryTask { try await pending.value }
        if event.type == "session.refetch_required" || event.sequence > (entry.projection?.sequence ?? 0) + 1 {
            try await reconcile(entry)
        }
        try requireCurrent(entry)
        let readTypes = ["runtime.state.updated", "runtime.capability.updated", "runtime.notice.snapshot", "runtime.notice.updated"]
        if readTypes.contains(event.type), event.receivedAt < entry.projectionBarrier { return }
        let wasOnline = entry.projection?.data.session.connectorStatus == .online
        if event.type == "timeline.snapshot", event.sequence >= (entry.projection?.sequence ?? 0) {
            entry.readVersion += 1
            entry.historyTask?.cancel()
            entry.historyTask = nil
        }
        try entry.projection?.apply(event)
        confirmEchoes(event, entry: entry)
        if event.type == "runtime.catalog.updated" || entry.projection?.data.session.connectorStatus != .online {
            invalidateCatalogs(entry)
        }
        emit(entry)
        if !wasOnline, entry.projection?.data.session.connectorStatus == .online { try await reconcile(entry) }
    }

    private func reconcile(_ entry: Entry) async throws {
        if let task = entry.recoveryTask { return try await task.value }
        let version = entry.connectionID
        let task = Task { [self] in
            defer { if entry.connectionID == version { entry.recoveryTask = nil } }
            if entry.projection == nil { _ = try await hydrate(entry) }
            let cursor = entry.projection!.data.cursor
            let recovery = try await detail.recover(sessionId: entry.id, after: cursor)
            try requireCurrent(entry)
            guard entry.connectionID == version else { throw CacheError.invalidated }
            if recovery.snapshotRequired {
                _ = try await hydrate(entry)
            } else {
                for event in recovery.events.sorted(by: { $0.sequence < $1.sequence }) {
                    try entry.projection?.apply(event)
                    confirmEchoes(event, entry: entry)
                }
                entry.projection?.advanceCursor(recovery.nextCursor)
            }
            entry.projection?.markStale()
            invalidateCatalogs(entry)
            if entry.projection?.data.session.connectorStatus == .online {
                // Frames received before this read must not overwrite its newer live projection.
                let barrier = now()
                do {
                    let live = try await detail.liveState(sessionId: entry.id)
                    try requireCurrent(entry)
                    guard entry.connectionID == version else { throw CacheError.invalidated }
                    entry.projection?.applyLive(live)
                    entry.projectionBarrier = barrier
                    entry.error = nil
                } catch {
                    try requireCurrent(entry)
                    guard entry.connectionID == version else { throw CacheError.invalidated }
                    entry.error = V2ClientFailure(error)
                    throw error
                }
            }
            emit(entry)
        }
        entry.recoveryTask = task
        return try await task.value
    }

    private func entry(for id: V2SessionID) -> Entry {
        let entry = entries[id] ?? Entry(id: id, model: V2SessionModel(id: id, scope: scope, repository: self))
        entries[id] = entry
        touch(entry)
        if network.availability == .offline { entry.connection = .offline }
        entry.model.update(observation(entry), network: network)
        return entry
    }

    private func touch(_ entry: Entry) { accessCounter += 1; entry.lastAccess = accessCounter }
    private func isCurrent(_ entry: Entry) -> Bool { entries[entry.id] === entry }

    private func requireCurrent(_ entry: Entry, version: Int? = nil) throws {
        try Task.checkCancellation()
        guard isCurrent(entry), version == nil || version == entry.readVersion else { throw CacheError.invalidated }
    }

    private func observation(_ entry: Entry) -> V2SessionObservation {
        V2SessionObservation(sessionId: entry.id, data: entry.projection?.data, connection: entry.connection, error: entry.error)
    }

    private func emit(_ entry: Entry) {
        guard isCurrent(entry) else { return }
        entry.model.update(observation(entry), network: network)
        for observer in entry.observers.values { observer.yield(observation(entry)) }
    }

    private func confirmEchoes(_ event: V2SessionEvent, entry: Entry) {
        if let raw = event.payload["item"],
           let data = try? JSONEncoder().encode(raw),
           let item = try? JSONDecoder().decode(V2TimelineItem.self, from: data) {
            entry.model.confirmEcho(item)
        }
    }

    private func invalidateCatalogs(_ entry: Entry) {
        entry.catalogVersion += 1
        entry.catalogs = nil
        entry.catalogReadAt = nil
        entry.catalogTask?.cancel()
        entry.catalogTask = nil
    }

    private func stop(_ entry: Entry) {
        entry.connectionID = UUID()
        entry.connectionTask?.cancel()
        entry.connectionTask = nil
        entry.recoveryTask?.cancel()
        entry.recoveryTask = nil
        entry.connection = .inactive
        entry.projection?.markStale()
        invalidateCatalogs(entry)
        emit(entry)
    }

    private func dispose(_ entry: Entry) {
        stop(entry)
        entry.loadTask?.cancel()
        entry.historyTask?.cancel()
        for observer in entry.observers.values { observer.finish() }
        entry.observers.removeAll()
        entry.model.invalidate()
    }

    private func evict(protecting protected: Entry? = nil) {
        let candidates = entries.values.filter {
            $0 !== protected && $0.observers.isEmpty && $0.loadTask == nil && $0.catalogTask == nil
                && $0.historyTask == nil && !$0.model.hasLocalWork
        }
            .sorted { $0.lastAccess < $1.lastAccess }
        for entry in candidates where entries.count > max(1, policy.maximumSessions) {
            entries.removeValue(forKey: entry.id)
            dispose(entry)
        }
    }
}

@MainActor
private final class Entry {
    let id: V2SessionID
    let model: V2SessionModel
    var projection: V2SessionProjection?
    var connection = V2SessionConnectionState.inactive
    var error: V2ClientFailure?
    var lastAccess = 0
    var readVersion = 0
    var catalogVersion = 0
    var projectionBarrier = Date.distantPast
    var connectionID = UUID()
    var observers: [UUID: AsyncStream<V2SessionObservation>.Continuation] = [:]
    var loadTask: Task<V2SessionData, Error>?
    var historyTask: Task<V2SessionData, Error>?
    var catalogTask: Task<V2SessionCatalogs, Error>?
    var recoveryTask: Task<Void, Error>?
    var connectionTask: Task<Void, Never>?
    var catalogs: V2SessionCatalogs?
    var catalogReadAt: Date?

    init(id: V2SessionID, model: V2SessionModel) { self.id = id; self.model = model }
}

private enum CacheError: LocalizedError {
    case invalidated
    case connectionClosed

    var errorDescription: String? {
        switch self {
        case .invalidated: "The session request no longer belongs to the active cache."
        case .connectionClosed: "The session connection closed."
        }
    }
}
