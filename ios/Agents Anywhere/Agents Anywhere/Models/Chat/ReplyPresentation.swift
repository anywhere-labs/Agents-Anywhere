import Foundation

nonisolated enum ReplyPresentation {
    static let revealSeconds: TimeInterval = 0.24
    /// Streamed text waits in a buffer while the previous batch reveals. The
    /// next batch is published once that reveal ends, plus one 60 Hz frame, so
    /// at most one batch animates and layout lands between animations.
    static let batchInterval: TimeInterval = revealSeconds + 1.0 / 60
    /// A published batch starts drawing after its Markdown parse and the next
    /// frame. Drawing clocks stay alive this much longer than the reveal.
    static let drawSlack: TimeInterval = 0.1
    static let settleDelay: Duration = .seconds(revealSeconds + drawSlack)
}

/// Advance deadlines independently of the work done at each one, so processing
/// time doesn't accumulate into a slower cadence. Late deadlines skip ahead.
nonisolated struct ReplyFlushSchedule {
    let interval: Duration
    private(set) var deadline: ContinuousClock.Instant

    init(start: ContinuousClock.Instant, interval: Duration) {
        precondition(interval > .zero)
        self.interval = interval
        deadline = start.advanced(by: interval)
    }

    mutating func advance(after now: ContinuousClock.Instant) {
        deadline = deadline.advanced(by: interval)
        if deadline <= now { deadline = now.advanced(by: interval) }
    }
}
