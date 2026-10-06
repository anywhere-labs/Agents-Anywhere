import Foundation

/// Best-effort classification of a running → idle/error transition for session
/// notifications. A user interrupt surfaces `stopping` briefly before the idle
/// or error state, so a stopping observation inside the current turn implies an
/// interrupted outcome. iOS suspends the process shortly after backgrounding
/// and status frames can be missed, so an interruption can still be reported
/// as a completion.
enum SessionTurnOutcome {
    case completed
    case interrupted

    /// The notification title for the verdict the sequence produced.
    var title: String {
        switch self {
        case .completed: String(localized: "任务完成")
        case .interrupted: String(localized: "任务已中断")
        }
    }

    /// Folding successive statuses per session lets callers feed dashboard meta
    /// and socket frames through one entry point: a `running` turn defaults the
    /// verdict to completed, `stopping` overrides it, and idle/error resolves
    /// the turn once. `verdict` is non-nil exactly when this status resolves a
    /// turn in flight; `next` is the folded state to store afterwards.
    static func resolve(from previous: Self?, status: V2RuntimeStatus) -> (verdict: Self?, next: Self?) {
        switch status {
        case .running:
            return (verdict: nil, next: .completed)
        case .stopping:
            return (verdict: nil, next: .interrupted)
        case .idle, .error:
            return (verdict: previous, next: nil)
        default:
            return (verdict: nil, next: previous)
        }
    }
}
