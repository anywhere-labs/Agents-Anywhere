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

    func flush(_ next: V2TimelineItem, animate: Bool, now: TimeInterval) {
        if animate && hasFlushed && value == next { settle(now: now); return }
        hasFlushed = true
        let received = next.displayText
        let appending = received.hasPrefix(text)
        // Snapshots/corrections are authoritative replacements, not token deltas.
        if !appending { layoutGeneration += 1 }
        let safeText = animate && appending && next.isStreamingText && !received.isEmpty
            ? String(received.dropLast()) : received
        let displayed = safeText.hasPrefix(text) || !appending ? safeText : received
        if displayed != text {
            isRevealing = animate && appending
            if isRevealing { settlesAt = now + ReplyPresentation.revealSeconds + 2 / ReplyPresentation.flushesPerSecond }
            text = displayed
        }
        if value != next { value = next }
        let nextStructure = TimelineRowStructure(next)
        if structure != nextStructure { structure = nextStructure }
        if !animate || (!next.isStreamingText && now >= settlesAt) { isRevealing = false }
    }

    func settle(now: TimeInterval) {
        if !value.isStreamingText && now >= settlesAt { isRevealing = false }
    }
}

/// Receives full repository projections without exposing each transport frame to
/// SwiftUI. Only flush() publishes rows, on a fixed 30 Hz presentation deadline.
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
            let updated = pending.map { value in
                let animate = animatePending && (existing[value.id] != nil || value.orderSeq > previousTail)
                let row = existing[value.id] ?? ChatTimelineRowModel(value, animate: animate && value.isAssistantText)
                row.flush(value, animate: animate, now: now)
                return row
            }
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
                let clock = ContinuousClock()
                var schedule = ReplyFlushSchedule(start: clock.now)
                for await _ in signal.stream {
                    guard !Task.isCancelled, let self else { return }
                    if schedule.deadline < clock.now { schedule = ReplyFlushSchedule(start: clock.now) }
                    repeat {
                        do { try await clock.sleep(until: schedule.deadline) } catch { return }
                        self.flush()
                        self.synchronizePending(session.pendingMessages)
                        schedule.advance(after: clock.now)
                    } while !Task.isCancelled && (self.pending != nil || self.rows.contains { $0.isRevealing })
                }
            }
            await group.waitForAll()
        }
    }

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
