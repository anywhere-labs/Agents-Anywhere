import Foundation

/// Account-scoped read progress. Navigation changes stop observing new turns,
/// but do not cancel a receipt for a session the user has already opened.
@MainActor
final class V2SessionReadCoordinator {
    var onChange: ((V2SessionID) -> Void)?
    private let send: (V2SessionID) async throws -> V2SessionMeta
    private let sleep: (Duration) async throws -> Void
    private var records: [V2SessionID: Record] = [:]
    private var visibleSessionID: V2SessionID?
    private var isActive = true
    private var isOnline = true
    private var isValid = true

    init(send: @escaping (V2SessionID) async throws -> V2SessionMeta,
         sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.send = send
        self.sleep = sleep
    }

    /// Only authoritative metadata enters here. A read receipt does not advance
    /// updatedSeq, so its watermark must survive even an equal-revision snapshot.
    func ingest(_ session: V2SessionMeta) -> V2SessionMeta {
        guard isValid else { return session }
        let record = records[session.id] ?? Record(id: session.id)
        records[session.id] = record
        record.confirmedThrough = max(record.confirmedThrough, session.lastReadSeq)
        record.latestTurnEndSeq = max(record.latestTurnEndSeq, session.latestTurnEndSeq)
        record.updatedSeq = max(record.updatedSeq, session.updatedSeq)
        if visibleSessionID == session.id { synchronizeVisible(notify: false) }
        return project(session)
    }

    /// Applies only read progress, preserving the latest running/approval state,
    /// title and other metadata regardless of receipt arrival order.
    func project(_ session: V2SessionMeta) -> V2SessionMeta {
        guard let record = records[session.id] else { return session }
        var result = session
        result.lastReadSeq = max(session.lastReadSeq, record.seenThrough, record.confirmedThrough)
        result.unread = max(session.latestTurnEndSeq, record.latestTurnEndSeq) > result.lastReadSeq
        return result
    }

    func setVisibleSession(_ id: V2SessionID?) {
        visibleSessionID = id
        if let id { records[id]?.requiresNewTrigger = false }
        synchronizeVisible()
    }

    func setActive(_ active: Bool) {
        guard isActive != active else { return }
        isActive = active
        if !active { records.values.forEach(stop) }
        else { resumeVisible() }
    }

    func updateConnectivity(_ network: V2NetworkStatus) {
        let online = network.availability != .offline
        guard isOnline != online else { return }
        isOnline = online
        if !online { records.values.forEach(stop) }
        else { resumeVisible() }
    }

    func invalidate() {
        isValid = false
        records.values.forEach(stop)
        records.removeAll()
        visibleSessionID = nil
        onChange = nil
    }

    private func resumeVisible() {
        if let id = visibleSessionID { records[id]?.requiresNewTrigger = false }
        synchronizeVisible()
    }

    private func synchronizeVisible(notify: Bool = true) {
        guard isValid, isActive, let id = visibleSessionID, let record = records[id] else { return }
        if record.latestTurnEndSeq > max(record.seenThrough, record.confirmedThrough) {
            record.seenThrough = max(record.updatedSeq, record.latestTurnEndSeq)
            if notify { onChange?(id) }
        }
        guard isOnline, record.seenThrough > record.confirmedThrough,
              record.task == nil, !record.requiresNewTrigger else { return }
        let generation = record.generation
        record.task = Task { [weak self] in
            await self?.synchronize(record, generation: generation)
        }
    }

    private func synchronize(_ record: Record, generation: UUID) async {
        defer { if record.generation == generation { record.task = nil } }
        var attempt = 0
        var firstRequest = true
        while isCurrent(record, generation: generation), isActive, isOnline,
              (firstRequest || visibleSessionID == record.id), record.seenThrough > record.confirmedThrough {
            firstRequest = false
            let requestedThrough = record.seenThrough
            do {
                let receipt = try await send(record.id)
                guard isCurrent(record, generation: generation) else { return }
                guard receipt.id == record.id else { throw HTTPError.invalidResponse }
                record.confirmedThrough = max(record.confirmedThrough, receipt.lastReadSeq)
                onChange?(record.id)
                guard record.confirmedThrough >= requestedThrough else { throw HTTPError.invalidResponse }
                attempt = 0
            } catch {
                guard isCurrent(record, generation: generation) else { return }
                guard V2ClientFailure(error).permitsAutomaticReconnect else {
                    record.requiresNewTrigger = true
                    return
                }
                guard isActive, isOnline, visibleSessionID == record.id else { return }
                // Read receipts are idempotent. Retry only while this session is
                // visible; never acknowledge a departed session's unseen new turn.
                do { try await sleep(.seconds(min(1 << min(attempt, 4), 15))) }
                catch { return }
                attempt += 1
            }
        }
    }

    private func isCurrent(_ record: Record, generation: UUID) -> Bool {
        isValid && !Task.isCancelled && records[record.id] === record && record.generation == generation
    }

    private func stop(_ record: Record) {
        record.generation = UUID()
        record.task?.cancel()
        record.task = nil
    }

    private final class Record {
        let id: V2SessionID
        var seenThrough = 0
        var confirmedThrough = 0
        var latestTurnEndSeq = 0
        var updatedSeq = 0
        var generation = UUID()
        var task: Task<Void, Never>?
        var requiresNewTrigger = false
        init(id: V2SessionID) { self.id = id }
    }
}
