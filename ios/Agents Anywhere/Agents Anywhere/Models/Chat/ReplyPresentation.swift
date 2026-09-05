import Foundation

nonisolated enum ReplyPresentation {
    static let flushesPerSecond = 30.0
    static let flushInterval: Duration = .seconds(1 / flushesPerSecond)
    static let revealSeconds: TimeInterval = 0.24
    // Allow two layout/drawing frames after the final flush before removing the
    // renderer or stopping a completed block's drawing clock.
    static let settleDelay: Duration = .seconds(revealSeconds + 2 / flushesPerSecond)
}

/// Advance deadlines independently of flush work, so processing time doesn't
/// accumulate into a slower cadence. A busy main actor skips missed frames.
nonisolated struct ReplyFlushSchedule {
    let interval: Duration
    private(set) var deadline: ContinuousClock.Instant

    init(start: ContinuousClock.Instant, interval: Duration = ReplyPresentation.flushInterval) {
        precondition(interval > .zero)
        self.interval = interval
        deadline = start.advanced(by: interval)
    }

    mutating func advance(after now: ContinuousClock.Instant) {
        deadline = deadline.advanced(by: interval)
        if deadline <= now { deadline = now.advanced(by: interval) }
    }
}
