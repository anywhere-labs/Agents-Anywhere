import Foundation
import CoreGraphics

/// The two-point probe at the start of the message, measured in the scroll
/// view's coordinate space. A folded group supplies its own native target ID.
nonisolated struct TimelineOpeningLayout: Equatable {
    let id: String
    let scrollID: String
    let frame: CGRect
}

/// Native identity-based scrolling owns insets and clamping. Completion uses
/// the actual marker's visibility and settled geometry, never a guessed offset.
nonisolated struct TimelineOpeningPosition {
    enum Action: Equatable { case wait, scrollTo(String), reveal, retry }
    let targetID: String?
    private let startedAt: TimeInterval
    private var requestedID: String?
    private var requestedAt: TimeInterval?
    private var candidate: Measurement?
    private var candidateAt: TimeInterval?

    private struct Measurement: Equatable {
        let layout: TimelineOpeningLayout
        let viewportHeight: CGFloat
    }

    init(targetID: String?, now: TimeInterval) {
        self.targetID = targetID; startedAt = now
    }

    mutating func advance(presented: Bool, layout: TimelineOpeningLayout?, visibleID: String?,
                          viewportHeight: CGFloat, isIdle: Bool, now: TimeInterval) -> Action {
        let expired = now - startedAt >= 6
        guard presented, viewportHeight > 0 else { return expired ? .retry : .wait }
        guard let targetID else { return .reveal }
        guard let layout, layout.id == targetID, layout.frame.width > 0, layout.frame.height > 0 else {
            return expired ? .retry : .wait
        }
        if requestedID == layout.scrollID, let requestedAt {
            if visibleID == targetID, isIdle {
                let measurement = Measurement(layout: layout, viewportHeight: viewportHeight)
                if candidate == measurement, let candidateAt, now - candidateAt >= 0.064 { return .reveal }
                if candidate != measurement { candidate = measurement; candidateAt = now }
            } else {
                candidate = nil; candidateAt = nil
            }
            if expired { return .retry }
            // A native request can arrive before its target is registered. Retry
            // even when no geometry callback fires; an unchanged offset is not
            // a reason to leave the loading mask up forever.
            if visibleID == targetID || now - requestedAt < 0.25 { return .wait }
        }
        if expired { return .retry }
        candidate = nil; candidateAt = nil
        requestedID = layout.scrollID; requestedAt = now
        return .scrollTo(layout.scrollID)
    }
}
