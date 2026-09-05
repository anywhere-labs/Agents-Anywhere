import Foundation

/// Measure the unobscured viewport in content coordinates, including keyboard
/// and safe-area bars. Preserve fractional values instead of rounding both edges.
nonisolated struct TimelineViewport: Equatable {
    let contentHeight: CGFloat
    let visibleHeight: CGFloat
    let visibleBottom: CGFloat

    init(contentHeight: CGFloat = 0, containerHeight: CGFloat = 0,
         topInset: CGFloat = 0, bottomInset: CGFloat = 0, offsetY: CGFloat = 0) {
        self.contentHeight = max(0, contentHeight)
        visibleHeight = max(0, containerHeight - topInset - bottomInset)
        visibleBottom = offsetY + containerHeight - bottomInset
    }

    private static let bottomTolerance: CGFloat = 2
    var hasOverflow: Bool { visibleHeight > 0 && contentHeight > visibleHeight + Self.bottomTolerance }
    var distanceToBottom: CGFloat { max(0, contentHeight - visibleBottom) }
    var isAtBottom: Bool { !hasOverflow || distanceToBottom <= Self.bottomTolerance }
    // Button visibility is deliberately more forgiving than follow intent. A
    // short manual scroll must not opt the user back into streaming auto-follow.
    var isNearBottom: Bool { !hasOverflow || distanceToBottom <= 96 }

    func shouldFollowTail(isFollowing: Bool, userIsScrolling: Bool) -> Bool {
        isFollowing && !userIsScrolling && hasOverflow && !isAtBottom
    }
}
