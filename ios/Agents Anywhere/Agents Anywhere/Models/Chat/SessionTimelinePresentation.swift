import Foundation
import Observation

@MainActor @Observable
final class ChatTimelineRowModel: Identifiable {
    let id: V2TimelineItemID
    private(set) var value: V2TimelineItem
    private(set) var text: String
    private(set) var isRevealing = false
    private(set) var layoutGeneration = 0
    @ObservationIgnored private var settlesAt: TimeInterval = 0

    init(_ value: V2TimelineItem, animate: Bool = false) {
        id = value.id; self.value = value
        text = animate ? "" : value.displayText
    }

    func flush(_ next: V2TimelineItem, animate: Bool, now: TimeInterval) {
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
    @ObservationIgnored private var pending: [V2TimelineItem]?
    @ObservationIgnored private var animatePending = false
    @ObservationIgnored private var initialized = false
    @ObservationIgnored private var lastConnection: V2SessionConnectionState = .inactive

    func receive(_ observation: V2SessionObservation) {
        defer { lastConnection = observation.connection }
        guard let data = observation.data else { return }
        stage(data.items, animate: initialized && lastConnection == .connected && observation.connection == .connected)
        initialized = true
    }

    func stage(_ items: [V2TimelineItem], animate: Bool) {
        pending = items.filter { $0.status != .hidden && $0.type != .turnStart && $0.type != .turnEnd }
        // Once a recovery snapshot is staged, preserve its snap semantics until
        // that tick even if a live event arrives immediately afterwards.
        animatePending = pendingWasStaged ? animatePending && animate : animate
        pendingWasStaged = true
    }
    @ObservationIgnored private var pendingWasStaged = false

    func flush(now: TimeInterval = ProcessInfo.processInfo.systemUptime) {
        if let pending {
            let existing = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
            let previousTail = rows.last?.value.orderSeq ?? Int.min
            let updated = pending.map { value in
                let animate = animatePending && (existing[value.id] != nil || value.orderSeq > previousTail)
                let row = existing[value.id] ?? ChatTimelineRowModel(value, animate: animate && value.isStreamingText)
                row.flush(value, animate: animate, now: now)
                return row
            }
            if rows.map(\.id) != updated.map(\.id) { rows = updated }
            self.pending = nil; pendingWasStaged = false
        }
        for row in rows where row.isRevealing { row.settle(now: now) }
    }

    func run(sessionID: V2SessionID, repository: V2SessionRepository) async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask { @MainActor [weak self] in
                for await value in repository.observe(sessionId: sessionID) {
                    guard !Task.isCancelled, let self else { return }
                    self.receive(value)
                }
            }
            group.addTask { @MainActor [weak self] in
                let clock = ContinuousClock()
                var schedule = ReplyFlushSchedule(start: clock.now)
                while !Task.isCancelled {
                    do { try await clock.sleep(until: schedule.deadline) } catch { return }
                    guard let self else { return }
                    self.flush()
                    schedule.advance(after: clock.now)
                }
            }
            await group.waitForAll()
        }
    }
}

extension V2TimelineItem {
    var isStreamingText: Bool {
        (status == .pending || status == .running)
            && (type == .reasoning || (type == .message && role == .assistant))
    }
    var displayText: String {
        switch content {
        case let .message(value): value.text
        case let .reasoning(value): value.text.isEmpty ? value.summary ?? "" : value.text
        default: ""
        }
    }
}
