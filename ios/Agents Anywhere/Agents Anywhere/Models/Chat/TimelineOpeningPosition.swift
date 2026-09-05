import Foundation

nonisolated struct TimelineOpeningLayout: Equatable {
    let id: String
    let y: CGFloat
}

nonisolated enum TimelineOpeningPosition {
    /// Align the latest user message with the unobscured top. Near the end of a
    /// short conversation the native scroll range can clamp that position.
    static func offset(for layout: TimelineOpeningLayout, viewport: TimelineViewport) -> CGFloat {
        let minimum = -viewport.topInset
        let maximum = max(minimum, viewport.contentHeight - viewport.visibleHeight - viewport.topInset)
        return min(maximum, max(minimum, layout.y - viewport.topInset))
    }

    static func hasArrived(at offset: CGFloat, viewport: TimelineViewport) -> Bool {
        viewport.visibleHeight > 0 && abs(viewport.offsetY - offset) <= 1.5
    }
}
