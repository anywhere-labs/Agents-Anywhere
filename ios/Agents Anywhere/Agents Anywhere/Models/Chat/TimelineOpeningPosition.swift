import Foundation
import CoreGraphics

/// Opening always uses the native bottom edge. Keep the mask until the actual
/// tail is visible and its viewport/content layout has stopped changing.
nonisolated struct TimelineOpeningPosition {
    enum Action: Equatable { case wait, scrollToBottom, reveal, retry }
    private let startedAt: TimeInterval
    private var requestedAt: TimeInterval?
    private var candidate: TimelineViewport?
    private var candidateAt: TimeInterval?

    init(now: TimeInterval) { startedAt = now }

    mutating func advance(viewport: TimelineViewport, isAtBottom: Bool, isIdle: Bool, now: TimeInterval) -> Action {
        let expired = now - startedAt >= 6
        guard viewport.visibleHeight > 0 else { return expired ? .retry : .wait }
        if let requestedAt {
            if isAtBottom, isIdle {
                let isStable = candidate.map { Self.sameLayout($0, viewport) } ?? false
                if isStable, let candidateAt, now - candidateAt >= 0.16 { return .reveal }
                if !isStable { candidate = viewport; candidateAt = now }
            } else {
                candidate = nil; candidateAt = nil
            }
            if expired { return .retry }
            // Retry even without a new geometry callback. Native scrolling owns
            // insets and clamping; no exact content-offset equality is required.
            if isAtBottom || now - requestedAt < 0.25 { return .wait }
        }
        if expired { return .retry }
        candidate = nil; candidateAt = nil
        requestedAt = now
        return .scrollToBottom
    }

    private static func sameLayout(_ lhs: TimelineViewport, _ rhs: TimelineViewport) -> Bool {
        // Ignore subpixel native rounding without accepting cumulative movement.
        abs(lhs.contentHeight - rhs.contentHeight) <= 0.5
            && abs(lhs.containerWidth - rhs.containerWidth) <= 0.5
            && abs(lhs.visibleHeight - rhs.visibleHeight) <= 0.5
            && abs(lhs.visibleBottom - rhs.visibleBottom) <= 0.5
            && abs(lhs.offsetY - rhs.offsetY) <= 0.5
            && abs(lhs.topInset - rhs.topInset) <= 0.5
    }
}
