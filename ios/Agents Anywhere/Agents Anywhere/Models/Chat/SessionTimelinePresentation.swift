import Foundation
import Observation

@MainActor @Observable
final class ChatTimelineRowModel: Identifiable {
    let id: V2TimelineItemID
    private(set) var value: V2TimelineItem
    private(set) var structure: TimelineRowStructure
    private(set) var text: String
    private(set) var isRevealing = false
    private(set) var layoutGeneration = 0
    @ObservationIgnored private var settlesAt: TimeInterval = 0
    @ObservationIgnored private var hasFlushed = false

    init(_ value: V2TimelineItem, animate: Bool = false) {
        id = value.id; self.value = value
        structure = TimelineRowStructure(value)
        text = animate ? "" : value.displayText
    }

    /// Returns true when newly displayed text starts a reveal batch.
    @discardableResult
    func flush(_ next: V2TimelineItem, animate: Bool, now: TimeInterval) -> Bool {
        if animate && hasFlushed && value == next { settle(now: now); return false }
        hasFlushed = true
        let received = next.displayText
        let appending = received.hasPrefix(text)
        // Snapshots/corrections are authoritative replacements, not token deltas.
        if !appending { layoutGeneration += 1 }
        let safeText = animate && appending && next.isStreamingText && !received.isEmpty
            ? String(received.dropLast()) : received
        let displayed = safeText.hasPrefix(text) || !appending ? safeText : received
        var started = false
        if displayed != text {
            isRevealing = animate && appending
            started = isRevealing
            if isRevealing { settlesAt = now + ReplyPresentation.revealSeconds + ReplyPresentation.drawSlack }
            text = displayed
        }
        if value != next { value = next }
        let nextStructure = TimelineRowStructure(next)
        if structure != nextStructure { structure = nextStructure }
        if !animate || now >= settlesAt { isRevealing = false }
        return started
    }

    /// The drawing clock follows the last revealed batch, not the item's
    /// running status. A tool wait or thinking pause stops redrawing; the next
    /// appended text starts a new batch.
    func settle(now: TimeInterval) {
        if now >= settlesAt { isRevealing = false }
    }
}

/// Receives full repository projections without exposing each transport frame to
/// SwiftUI. Only flush() publishes rows. Received text waits in `pending` while
/// the previous batch reveals; the next batch goes on screen when it ends.
@MainActor @Observable
final class SessionTimelinePresentation {
    private(set) var rows: [ChatTimelineRowModel] = []
    private(set) var pendingMessages: [V2PendingMessage] = []
    private(set) var hasPresentedSnapshot = false
    @ObservationIgnored private var pending: [V2TimelineItem]?
    @ObservationIgnored private var animatePending = false
    @ObservationIgnored private var initialized = false
    @ObservationIgnored private var lastConnection: V2SessionConnectionState = .inactive
    @ObservationIgnored private var wake: AsyncStream<Void>.Continuation?
    /// When the newest reveal batch ends and the buffer may publish again.
    @ObservationIgnored private(set) var nextBatchAt: TimeInterval = 0

    func presentOpening(_ items: [V2TimelineItem], pendingMessages: [V2PendingMessage]) {
        stage(items, animate: false)
        flush()
        synchronizePending(pendingMessages)
    }

    func receive(_ observation: V2SessionObservation) {
        defer { lastConnection = observation.connection }
        guard let data = observation.data else { return }
        stage(data.items, animate: initialized && lastConnection == .connected && observation.connection == .connected)
        initialized = true
    }

    func stage(_ items: [V2TimelineItem], animate: Bool) {
        pending = items.filter(\.isVisibleInChat)
        // Once a recovery snapshot is staged, preserve its snap semantics until
        // that tick even if a live event arrives immediately afterwards.
        animatePending = pendingWasStaged ? animatePending && animate : animate
        pendingWasStaged = true
        wake?.yield(())
    }
    @ObservationIgnored private var pendingWasStaged = false

    func flush(now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        if let pending {
            let existing = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
            let previousTail = rows.last?.value.orderSeq ?? Int.min
            var started = false
            let updated = pending.map { value in
                let animate = animatePending && (existing[value.id] != nil || value.orderSeq > previousTail)
                let row = existing[value.id] ?? ChatTimelineRowModel(value, animate: animate && value.isAssistantText)
                if row.flush(value, animate: animate, now: now) { started = true }
                return row
            }
            if started { nextBatchAt = now + ReplyPresentation.batchInterval }
            if rows.map(\.id) != updated.map(\.id) { rows = updated }
            if !hasPresentedSnapshot { hasPresentedSnapshot = true }
            self.pending = nil; pendingWasStaged = false
        }
        for row in rows where row.isRevealing { row.settle(now: now) }
    }

    func run(sessionID: V2SessionID, repository: V2SessionRepository) async {
        let session = repository.session(id: sessionID)
        let signal = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        wake = signal.continuation
        defer { signal.continuation.finish(); wake = nil }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { @MainActor [weak self] in
                defer { signal.continuation.finish() }
                for await value in repository.observe(sessionId: sessionID) {
                    guard !Task.isCancelled, let self else { return }
                    self.receive(value)
                }
            }
            group.addTask { @MainActor [weak self] in
                for await _ in signal.stream {
                    guard !Task.isCancelled, let self else { return }
                    repeat {
                        // Text received during a reveal waits for it to end, then
                        // goes on screen as one batch. Text after a pause shows at
                        // once. Without new text, poll briefly to notice arrivals
                        // and settle rows whose reveal has ended.
                        let now = ProcessInfo.processInfo.systemUptime
                        let wait = self.pending != nil ? self.nextBatchAt - now : Self.idlePoll
                        if wait > 0 {
                            do { try await Task.sleep(for: .seconds(wait)) } catch { return }
                        }
                        let current = ProcessInfo.processInfo.systemUptime
                        guard self.pending == nil || current >= self.nextBatchAt else { continue }
                        self.flush(now: current)
                        self.synchronizePending(session.pendingMessages)
                    } while !Task.isCancelled && (self.pending != nil || self.rows.contains { $0.isRevealing })
                }
            }
            await group.waitForAll()
        }
    }

    private static let idlePoll: TimeInterval = 1.0 / 30

    func synchronizePending(_ messages: [V2PendingMessage]) {
        // Change optimistic membership in the same tick that publishes echoes,
        // avoiding a blank first user row between HTTP/realtime and UI clocks.
        let visible = messages.filter { message in
            !rows.contains { $0.value.role == .user && $0.value.source["clientMessageId"]?.stringValue == message.id }
        }
        if pendingMessages.map(\.id) != visible.map(\.id) { pendingMessages = visible }
    }
}

extension V2TimelineItem {
    var isAssistantText: Bool {
        isReasoning || type == .message && role == .assistant
    }
    var isStreamingText: Bool {
        (status == .pending || status == .running)
            && isAssistantText
    }
    var displayText: String {
        switch content {
        case let .message(value): TimelineText.message(value.text)
        case let .reasoning(value): TimelineText.reasoning(value.raw)
        case let .marker(value): isReasoning ? TimelineText.reasoning(value.raw) : ""
        default: ""
        }
    }
}
